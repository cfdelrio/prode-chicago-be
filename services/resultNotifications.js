"use strict";

const { db } = require('../db/connection');
const { calcularPuntaje } = require('./scoring');
const { sendNewLeaderEmail, sendResultEmail } = require('./email');
const { sendSMS } = require('./sms');
const { pushToUser, pushToAll } = require('./push');
const { sendEvent } = require('./engageClient');
const { updateStreaks, checkAndAwardBadges } = require('./gamification');
const { buildEngageMetadata } = require('../utils/engageHelpers');

/**
 * Fires all post-result notifications (email, WhatsApp, push) for a published
 * match result. Must be awaited before res.json() in Lambda — the runtime
 * freezes the process as soon as the HTTP response is sent.
 *
 * @param {object} params
 * @param {object} params.match        - Full match row
 * @param {number} params.resultLocal  - Published home goals
 * @param {number} params.resultVisitante - Published away goals
 * @param {Array}  params.bets         - All bet rows for this match
 * @param {object|null} params.prevLeader - Ranking row of the previous #1 (may be null)
 */
async function notifyResult({ match, resultLocal, resultVisitante, bets, prevLeader }) {
    try {
        const rankingRows = await db.query(`
            SELECT p.user_id, p.id as planilla_id, p.nombre_planilla, p.precio_pagado,
                   r.position, r.puntos_totales,
                   u.email, u.nombre, u.whatsapp_number, u.whatsapp_consent,
                   u.tema_equipo, u.foto_url, u.created_at, u.rol, u.idioma_pref
            FROM ranking r
            JOIN planillas p ON r.planilla_id = p.id
            JOIN users u ON p.user_id = u.id
            ORDER BY r.position ASC
        `);
        const rankingMap = {};
        for (const row of rankingRows.rows) rankingMap[row.user_id] = row;

        await _notifyNewLeader({ rankingRows: rankingRows.rows, prevLeader, match, resultLocal, resultVisitante });
        await _notifyBetResults({ bets, rankingMap, match, resultLocal, resultVisitante });
        await _pushBroadcast({ match, resultLocal, resultVisitante });
        await _notifyAdmins({ match, resultLocal, resultVisitante });

        console.log(`[result-notif] match=${match.id} bets=${bets.length}`);
    } catch (err) {
        console.error('[result-notif] error:', err.message);
    }
}

async function _notifyNewLeader({ rankingRows, prevLeader, match, resultLocal, resultVisitante }) {
    const newLeader = rankingRows[0] || null;
    if (!newLeader) return;

    // leaderChanged = true only when the specific person holding #1 changed
    const leaderChanged = prevLeader !== null && newLeader.user_id !== prevLeader.user_id;
    const prevName = prevLeader?.nombre || null;
    const pushBody = leaderChanged && prevName
        ? `Le sacaste el #1 a ${prevName}. Con ${newLeader.puntos_totales} pts.`
        : `Con ${newLeader.puntos_totales} pts estás en el puesto #1 — ¡no lo sueltes!`;

    // Engage siempre recibe el estado del liderazgo; Engage decide cuándo notificar.
    if (process.env.ENGAGE_ENABLED === 'true') {
        await sendEvent({
            type: 'prode.new_leader',
            userId: String(newLeader.user_id),
            idempotencyKey: `new_leader:${newLeader.user_id}:${match.id}`,
            payload: {
                business_context: {
                    puntos: newLeader.puntos_totales,
                    prev_leader_nombre: prevName,
                    match: { local: match.home_team, away: match.away_team, goles_local: resultLocal, goles_visitante: resultVisitante },
                },
            },
            metadata: buildEngageMetadata(newLeader, {
                planilla_nombre: newLeader.nombre_planilla,
                planilla_id: newLeader.planilla_id,
                estado_pago: newLeader.precio_pagado,
                ranking_position: newLeader.position,
                puntos_totales: newLeader.puntos_totales,
            }),
        }).catch(e => console.error('[engage] new leader error:', e.message));

        if (newLeader.whatsapp_number) {
            await sendEvent({
                type: 'prode.voice_nuevo_lider',
                userId: String(newLeader.user_id),
                idempotencyKey: `voice_nuevo_lider:${newLeader.user_id}:${match.id}`,
                payload: {
                    business_context: {
                        template: 'Nuevo Lider Prode',
                        nuevo_lider: newLeader.nombre,
                        puntos: newLeader.puntos_totales,
                        prev_leader: prevName,
                        match_name: `${match.home_team} vs ${match.away_team}`,
                    },
                },
                metadata: buildEngageMetadata(newLeader, {
                    planilla_nombre: newLeader.nombre_planilla,
                    ranking_position: newLeader.position,
                    puntos_totales: newLeader.puntos_totales,
                }),
            }).catch(e => console.error('[engage] voice_nuevo_lider error:', e.message));
        }
    }

    // In-app notification, push, and fallback channels only when leader actually changed
    if (!leaderChanged) return;

    await db.query(
        `INSERT INTO notifications (user_id, type, payload, status, sent_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [newLeader.user_id, 'ranking', JSON.stringify({
            title: '🔥 ¡Sos el nuevo líder!',
            body: pushBody,
        }), 'sent']
    ).catch(e => console.error('Notification new leader error:', e.message));

    await pushToUser(newLeader.user_id, {
        title: '🔥 ¡Sos el nuevo líder!',
        body: pushBody,
        url: '/ranking',
        icon: '/favicon.svg',
    }).catch(e => console.error('[push] new leader error:', e.message));

    if (process.env.ENGAGE_ENABLED !== 'true') {
        await sendNewLeaderEmail({
            userEmail: newLeader.email,
            userName: newLeader.nombre,
            puntos: newLeader.puntos_totales,
            homeTeam: match.home_team,
            awayTeam: match.away_team,
            resultLocal,
            resultVisitante,
        }).catch(e => console.error('Email new leader error:', e.message));

        if (newLeader.whatsapp_number && newLeader.whatsapp_consent) {
            const smsBody = prevName
                ? `👑 ¡Sos el nuevo líder! Le sacaste el #1 a ${prevName}. Tenés ${newLeader.puntos_totales} pts. 👉 hr.prodecaballito.com/ranking`
                : `🔥 ¡Sos el nuevo líder del PRODE High Rolling! Con ${newLeader.puntos_totales} pts estás en el puesto #1. ¡No lo sueltes! 👉 hr.prodecaballito.com/ranking`;
            await sendSMS({ to: newLeader.whatsapp_number, body: smsBody })
                .catch(e => console.error('[sms] new leader error:', e.message));
        }
    }
}

async function _notifyBetResults({ bets, rankingMap, match, resultLocal, resultVisitante }) {
    if (bets.length === 0) return;

    const planillaIds = bets.map(b => b.planilla_id);
    const planillaUsersRes = await db.query(
        'SELECT id, user_id FROM planillas WHERE id = ANY($1::uuid[])', [planillaIds]
    );
    const planillaToUser = {};
    for (const row of planillaUsersRes.rows) planillaToUser[row.id] = row.user_id;

    for (const bet of bets) {
        try {
            const userId = planillaToUser[bet.planilla_id];
            if (!userId) continue;
            const userRanking = rankingMap[userId];
            if (!userRanking) continue;

            const score = calcularPuntaje(
                { goles_local: bet.goles_local, goles_visitante: bet.goles_visitante },
                { resultado_local: resultLocal, resultado_visitante: resultVisitante }
            );

            const isExacto = bet.goles_local === resultLocal && bet.goles_visitante === resultVisitante;
            let title, body;
            if (isExacto) {
                title = `🎯 ¡Exacto! +${score.puntos} pts`;
                body = `${match.home_team} ${resultLocal}–${resultVisitante} ${match.away_team}`;
            } else if (score.puntos > 0) {
                title = `✅ Acertaste el ganador. +${score.puntos} pts`;
                body = `${match.home_team} ${resultLocal}–${resultVisitante} ${match.away_team}`;
            } else {
                title = '😬 Esta no fue';
                body = `${match.home_team} ${resultLocal}–${resultVisitante} ${match.away_team} — pronóstico: ${bet.goles_local}-${bet.goles_visitante}`;
            }

            await db.query(
                `INSERT INTO notifications (user_id, match_id, type, payload, status, sent_at)
                 VALUES ($1, $2, $3, $4, $5, NOW())`,
                [userId, match.id, 'result', JSON.stringify({ title, body }), 'sent']
            ).catch(e => console.error(`Notification insert error for ${userId}:`, e.message));

            const streakResult = await updateStreaks(bet.planilla_id, match.id, isExacto)
                .catch(e => { console.error(`[gamification] updateStreaks error for ${userId}:`, e.message); return null; });
            checkAndAwardBadges({
                userId,
                planillaId: bet.planilla_id,
                matchId: match.id,
                isExacto,
                position: userRanking.position,
                streakResult,
            }).catch(e => console.error(`[gamification] checkAndAwardBadges error for ${userId}:`, e.message));

            if (process.env.ENGAGE_ENABLED === 'true') {
                const engageExtras = {
                    planilla_nombre: userRanking.nombre_planilla,
                    planilla_id: userRanking.planilla_id,
                    estado_pago: userRanking.precio_pagado,
                    ranking_position: userRanking.position,
                    puntos_totales: userRanking.puntos_totales,
                    current_streak: streakResult?.current || 0,
                    best_streak: streakResult?.best || 0,
                };

                await sendEvent({
                    type: 'prode.result_published.individual',
                    userId: String(userId),
                    idempotencyKey: `result_published:${userId}:${match.id}`,
                    payload: {
                        business_context: {
                            match: { local: match.home_team, away: match.away_team, goles_local: resultLocal, goles_visitante: resultVisitante },
                            bet: { goles_local: bet.goles_local, goles_visitante: bet.goles_visitante, puntos_obtenidos: score.puntos },
                            ranking_after: { position: userRanking.position },
                            outcome: isExacto ? 'exacto' : score.puntos > 0 ? 'resultado' : null,
                            // Normalized aliases for template variables
                            puntos: score.puntos,
                            posicion: userRanking.position,
                        },
                    },
                    metadata: buildEngageMetadata(userRanking, engageExtras),
                }).catch(e => console.error(`[engage] result error for ${userId}:`, e.message));

                if (isExacto && userRanking.whatsapp_number) {
                    await sendEvent({
                        type: 'prode.voice_perfect_score',
                        userId: String(userId),
                        idempotencyKey: `voice_exacto:${userId}:${match.id}`,
                        payload: {
                            business_context: {
                                template: 'Exacto Prode',
                                home_team: match.home_team,
                                away_team: match.away_team,
                                goles_local: resultLocal,
                                goles_visitante: resultVisitante,
                                puntos: score.puntos,
                                ranking_pos: userRanking.position,
                            },
                        },
                        metadata: buildEngageMetadata(userRanking, engageExtras),
                    }).catch(e => console.error(`[engage] voice_perfect_score error for ${userId}:`, e.message));
                }
            } else {
                await sendResultEmail({
                    userEmail: userRanking.email,
                    userName: userRanking.nombre,
                    homeTeam: match.home_team,
                    awayTeam: match.away_team,
                    resultLocal,
                    resultVisitante,
                    betLocal: bet.goles_local,
                    betVisitante: bet.goles_visitante,
                    puntos: score.puntos,
                    rankingPos: userRanking.position,
                }).catch(e => console.error(`Result email error for ${userId}:`, e.message));

                if (userRanking.whatsapp_number && userRanking.whatsapp_consent) {
                    const smsBody = score.puntos > 0
                        ? `⚽ ${match.home_team} ${resultLocal}–${resultVisitante} ${match.away_team} | Tu pronóstico: ${bet.goles_local}-${bet.goles_visitante} → +${score.puntos}pts\nEstás #${userRanking.position} en el ranking 👉 hr.prodecaballito.com/ranking`
                        : `⚽ ${match.home_team} ${resultLocal}–${resultVisitante} ${match.away_team} | Tu pronóstico: ${bet.goles_local}-${bet.goles_visitante} → 0 pts\nSeguís #${userRanking.position} 👉 hr.prodecaballito.com/ranking`;
                    await sendSMS({ to: userRanking.whatsapp_number, body: smsBody })
                        .catch(e => console.error(`[sms] result error for ${userId}:`, e.message));
                }
            }
        } catch (betErr) {
            console.error('Result notification error for bet:', betErr.message);
        }
    }
}

async function _pushBroadcast({ match, resultLocal, resultVisitante }) {
    let exactosCount = 0;
    try {
        const exactosRes = await db.query(
            `SELECT COUNT(*) AS cnt FROM bets
             WHERE match_id = $1 AND goles_local = $2 AND goles_visitante = $3`,
            [match.id, resultLocal, resultVisitante]
        );
        exactosCount = parseInt(exactosRes.rows[0]?.cnt || '0');
    } catch (e) {
        console.error('[push-broadcast] exactos query error:', e.message);
    }

    let broadcastBody;
    if (exactosCount === 0) {
        broadcastBody = 'Nadie lo acertó exacto 🤯';
    } else if (exactosCount === 1) {
        broadcastBody = '¡Solo 1 lo acertó exacto! ¿Fuiste vos?';
    } else {
        broadcastBody = `¡${exactosCount} exactos! ¿Sos uno?`;
    }

    await pushToAll({
        title: `⚽ ${match.home_team} ${resultLocal}–${resultVisitante} ${match.away_team}`,
        body: broadcastBody,
        url: '/ranking',
        icon: '/favicon.svg',
    }).catch(e => console.error('[push] broadcast error:', e.message));

    if (process.env.ENGAGE_ENABLED === 'true') {
        sendEvent({
            type: 'prode.result_published.broadcast',
            userId: 'broadcast',
            idempotencyKey: `result_broadcast:${match.id}`,
            payload: {
                business_context: {
                    match: { local: match.home_team, away: match.away_team, goles_local: resultLocal, goles_visitante: resultVisitante },
                    exactos_count: exactosCount,
                },
            },
        }).catch(e => console.error('[engage] broadcast error:', e.message));
    }
}

async function _notifyAdmins({ match, resultLocal, resultVisitante }) {
    const adminsRes = await db.query(
        `SELECT whatsapp_number FROM users WHERE rol = 'admin' AND whatsapp_number IS NOT NULL`
    );
    if (adminsRes.rows.length === 0) return;

    const msg = `⚽ Resultado cargado\n${match.home_team} ${resultLocal} - ${resultVisitante} ${match.away_team}\n\nLos puntos ya fueron calculados.`;

    for (const admin of adminsRes.rows) {
        await sendSMS({ to: admin.whatsapp_number, body: msg })
            .catch(e => console.error('[sms] admin notif error:', e.message));
    }
}

module.exports = { notifyResult };
