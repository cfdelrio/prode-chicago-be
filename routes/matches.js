"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const connection_1 = require("../db/connection");
const auth_1 = require("../middleware/auth");
const validation_1 = require("../middleware/validation");
const scoring_1 = require("../services/scoring");
const { notifyResult } = require("../services/resultNotifications");
const { sendRankingUpdateEmail } = require("../services/email");
const { sendEvent } = require("../services/engageClient");
const tournamentRanking_1 = require("../services/tournamentRanking");
const cache = require("../services/cache");
const router = (0, express_1.Router)();

const MATCHES_TTL = 30_000; // 30s

router.get('/', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;
        const estado = req.query.estado || '';
        const planilla_id = req.query.planilla_id || '';
        const tournament_id = req.query.tournament_id || '';

        const cacheKey = `matches:${page}:${limit}:${estado}:${planilla_id}:${tournament_id}`;
        const cached = cache.get(cacheKey);
        if (cached) return res.json(cached);

        const params = [];
        const conditions = [];
        let query = `SELECT m.*,
      p.nombre_planilla,
      u.nombre as planilla_owner_name,
      t.name as tournament_name,
      t.fase as tournament_fase
    FROM matches m
    LEFT JOIN planillas p ON m.planilla_id = p.id
    LEFT JOIN users u ON p.user_id = u.id
    LEFT JOIN tournaments t ON m.tournament_id = t.id`;
        if (estado) {
            conditions.push('m.estado = $' + (params.length + 1));
            params.push(estado);
        }
        if (planilla_id) {
            conditions.push('(m.planilla_id = $' + (params.length + 1) + ' OR m.planilla_id IS NULL)');
            params.push(planilla_id);
        }
        if (tournament_id) {
            conditions.push('m.tournament_id = $' + (params.length + 1));
            params.push(tournament_id);
        }
        if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
        query += ` ORDER BY
      CASE WHEN m.finished = false THEN 0 ELSE 1 END,
      m.start_time ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);

        const result = await connection_1.db.query(query, params);
        const response = {
            success: true,
            data: { matches: result.rows, pagination: { page, limit } },
        };
        cache.set(cacheKey, response, MATCHES_TTL);
        res.json(response);
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.get('/:id', validation_1.uuidParam, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await connection_1.db.query('SELECT * FROM matches WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Partido no encontrado' });
        }
        res.json({ success: true, data: result.rows[0] });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.post('/', auth_1.authMiddleware, auth_1.requireAdmin, validation_1.matchValidation, async (req, res) => {
    try {
        const { home_team, away_team, home_team_pt, away_team_pt, start_time, halftime_minutes, time_cutoff, planilla_id, tournament_id, sede, grupo, jornada } = req.body;
        const cutoffTime = time_cutoff || new Date(new Date(start_time).getTime() - 30 * 60 * 1000);
        const result = await connection_1.db.query(`INSERT INTO matches (home_team, away_team, home_team_pt, away_team_pt, start_time, halftime_minutes, time_cutoff, planilla_id, tournament_id, sede, grupo, jornada)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`, [home_team, away_team, home_team_pt || null, away_team_pt || null, start_time, halftime_minutes || 15, cutoffTime, planilla_id || null, tournament_id || null, sede || null, grupo || null, jornada || null]);
        await connection_1.db.query(`INSERT INTO audit_log (user_id, action, entity_type, entity_id, new_value, ip_address, user_agent)
       VALUES ($1, 'match_create', 'matches', $2, $3, $4, $5)`, [req.user.userId, result.rows[0].id, JSON.stringify(req.body), req.ip, req.headers['user-agent']]);
        const { schedulerService } = require('../workers/schedulerService');
        schedulerService.scheduleMatchJobs(result.rows[0]).catch(err =>
            console.error(`[matches] scheduleMatchJobs failed for ${result.rows[0].id}:`, err.message)
        );
        res.status(201).json({ success: true, data: result.rows[0] });
    }
    catch (error) {
        console.error('Create match error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.put('/:id', auth_1.authMiddleware, auth_1.requireAdmin, validation_1.matchUpdateValidation, async (req, res) => {
    try {
        const { id } = req.params;
        const { home_team, away_team, home_team_pt, away_team_pt, start_time, halftime_minutes, time_cutoff, estado, finished, tournament_id, sede, grupo, jornada } = req.body;
        const oldResult = await connection_1.db.query('SELECT * FROM matches WHERE id = $1', [id]);
        if (oldResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Partido no encontrado' });
        }
        const newStartTime = start_time || oldResult.rows[0].start_time;
        const calcCutoff = time_cutoff || new Date(new Date(newStartTime).getTime() - 30 * 60 * 1000);
        const result = await connection_1.db.query(`UPDATE matches SET
        home_team = COALESCE($1, home_team),
        away_team = COALESCE($2, away_team),
        home_team_pt = COALESCE($3, home_team_pt),
        away_team_pt = COALESCE($4, away_team_pt),
        start_time = COALESCE($5, start_time),
        halftime_minutes = COALESCE($6, halftime_minutes),
        time_cutoff = $7,
        estado = COALESCE($8, estado),
        finished = COALESCE($9, finished),
        tournament_id = COALESCE($10, tournament_id),
        sede = COALESCE($11, sede),
        grupo = COALESCE($12, grupo),
        jornada = COALESCE($13, jornada)
       WHERE id = $14
       RETURNING *`, [home_team, away_team, home_team_pt, away_team_pt, start_time, halftime_minutes, calcCutoff, estado, finished, tournament_id, sede, grupo, jornada, id]);
        await connection_1.db.query(`INSERT INTO audit_log (user_id, action, entity_type, entity_id, old_value, new_value, ip_address, user_agent)
       VALUES ($1, 'match_update', 'matches', $2, $3, $4, $5, $6)`, [req.user.userId, id, JSON.stringify(oldResult.rows[0]), JSON.stringify(result.rows[0]), req.ip, req.headers['user-agent']]);
        const { schedulerService } = require('../workers/schedulerService');
        schedulerService.scheduleMatchJobs(result.rows[0]).catch(err =>
            console.error(`[matches] scheduleMatchJobs failed for ${id}:`, err.message)
        );
        if (start_time && new Date(start_time).getTime() !== new Date(oldResult.rows[0].start_time).getTime()) {
            connection_1.db.query(`
                UPDATE bet_reminders
                SET scheduled_for = $1::timestamptz - (remind_minutes * INTERVAL '1 minute'),
                    email_sent = false,
                    sent_at = NULL
                WHERE match_id = $2
            `, [result.rows[0].start_time, id]).catch(err =>
                console.error(`[matches] bet_reminders reschedule failed for ${id}:`, err.message)
            );
            // Notify users who bet on this match about the rescheduled time
            _notifyMatchRescheduled(id, result.rows[0]).catch(err =>
                console.error(`[matches] reschedule notify failed for ${id}:`, err.message)
            );
        }
        res.json({ success: true, data: result.rows[0] });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.post('/:matchId/result', auth_1.authMiddleware, auth_1.requireAdmin, validation_1.matchResultValidation, async (req, res) => {
    try {
        const { matchId } = req.params;
        const { resultado_local, resultado_visitante } = req.body;
        const matchResult = await connection_1.db.query('SELECT * FROM matches WHERE id = $1', [matchId]);
        if (matchResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Partido no encontrado' });
        }
        const match = matchResult.rows[0];

        // Guardar líder anterior antes de recalcular
        const prevLeaderResult = await connection_1.db.query(
            `SELECT p.user_id, u.nombre, u.whatsapp_number, u.whatsapp_consent
             FROM ranking r
             JOIN planillas p ON r.planilla_id = p.id
             JOIN users u ON p.user_id = u.id
             WHERE r.position = 1 LIMIT 1`
        );
        const prevLeader = prevLeaderResult.rows[0] || null;

        await connection_1.db.query(`UPDATE matches SET
        resultado_local = $1,
        resultado_visitante = $2,
        estado = 'finished',
        finished = true
       WHERE id = $3`, [resultado_local, resultado_visitante, matchId]);
        const betsResult = await connection_1.db.query('SELECT * FROM bets WHERE match_id = $1', [matchId]);
        if (betsResult.rows.length > 0) {
            const planillaIds = [];
            const puntosArr = [];
            const bonusArr = [];
            const detalleArr = [];
            for (const bet of betsResult.rows) {
                const score = (0, scoring_1.calcularPuntaje)(
                    { goles_local: bet.goles_local, goles_visitante: bet.goles_visitante },
                    { resultado_local, resultado_visitante }
                );
                planillaIds.push(bet.planilla_id);
                puntosArr.push(score.puntos);
                bonusArr.push(score.bonus);
                detalleArr.push(JSON.stringify(score.detalle));
            }
            await connection_1.db.query(`
                INSERT INTO scores (planilla_id, match_id, puntos_obtenidos, bonus_aplicado, detalle_json)
                SELECT unnest($1::uuid[]), $2, unnest($3::int[]), unnest($4::bool[]), unnest($5::jsonb[])
                ON CONFLICT (planilla_id, match_id) DO UPDATE SET
                    puntos_obtenidos = EXCLUDED.puntos_obtenidos,
                    bonus_aplicado   = EXCLUDED.bonus_aplicado,
                    detalle_json     = EXCLUDED.detalle_json
            `, [planillaIds, matchId, puntosArr, bonusArr, detalleArr]);
        }
        await connection_1.db.query(`INSERT INTO audit_log (user_id, action, entity_type, entity_id, new_value, ip_address, user_agent)
       VALUES ($1, 'result_published', 'matches', $2, $3, $4, $5)`, [req.user.userId, matchId, JSON.stringify({ resultado_local, resultado_visitante }), req.ip, req.headers['user-agent']]);
        await actualizarRanking(matchId);
        cache.invalidatePrefix('ranking:');
        cache.invalidatePrefix('matches:');

        // Recalculate tournament ranking if match belongs to tournament
        if (match.tournament_id) {
            await (0, tournamentRanking_1.recalculateTournamentRanking)(match.tournament_id);
            // Recalculate matchday ranking (auto-creates matchday if needed)
            try {
                const matchdaysRoute = require('./matchdays');
                const { recalcMatchdayForMatch } = matchdaysRoute;
                if (typeof recalcMatchdayForMatch === 'function') {
                    await recalcMatchdayForMatch(match.id, match.tournament_id, new Date(match.start_time));
                }
            } catch (mdErr) {
                console.warn('Matchday recalc warning:', mdErr.message);
            }
        }

        // Notificaciones ANTES de res.json(): serverless-http congela Lambda en
        // cuanto se llama res.json(), así que cualquier código posterior nunca ejecuta.
        await notifyResult({
            match,
            resultLocal: resultado_local,
            resultVisitante: resultado_visitante,
            bets: betsResult.rows,
            prevLeader,
        }).catch(e => console.error('[result-notif] unhandled:', e.message));

        res.json({
            success: true,
            message: `Resultados publicados. ${betsResult.rows.length} pronósticos calculados.`
        });
    }
    catch (error) {
        console.error('Publish result error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.delete('/:id', auth_1.authMiddleware, auth_1.requireAdmin, validation_1.uuidParam, async (req, res) => {
    try {
        const { id } = req.params;
        await connection_1.db.query('DELETE FROM scores WHERE match_id = $1', [id]);
        await connection_1.db.query('DELETE FROM bets WHERE match_id = $1', [id]);
        await connection_1.db.query("DELETE FROM comments WHERE target_type = 'match' AND target_id = $1", [id]);
        const result = await connection_1.db.query('DELETE FROM matches WHERE id = $1 RETURNING id', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, error: 'Partido no encontrado' });
        }
        await connection_1.db.query(`INSERT INTO audit_log (user_id, action, entity_type, entity_id, ip_address, user_agent)
       VALUES ($1, 'match_delete', 'matches', $2, $3, $4)`, [req.user.userId, id, req.ip, req.headers['user-agent']]);
        res.json({ success: true, message: 'Partido eliminado' });
    }
    catch (error) {
        console.error('Delete match error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
async function _notifyMatchRescheduled(matchId, match) {
    const { pushToUser } = require('../services/push');
    const { sendSMSWithRetry } = require('../services/sms');

    const bettersRes = await connection_1.db.query(
        `SELECT DISTINCT u.id AS user_id, u.nombre, u.whatsapp_number, u.whatsapp_consent
         FROM bets b
         JOIN planillas p ON p.id = b.planilla_id
         JOIN users u ON u.id = p.user_id
         WHERE b.match_id = $1`,
        [matchId]
    );
    if (bettersRes.rows.length === 0) return;

    const newDate = new Date(match.start_time);
    const formatted = newDate.toLocaleString('es-AR', {
        timeZone: 'America/Argentina/Buenos_Aires',
        weekday: 'short', day: 'numeric', month: 'short',
        hour: '2-digit', minute: '2-digit',
    });
    const homeTeam = match.home_team;
    const awayTeam = match.away_team;

    const payload = {
        title: '📅 Cambio de horario',
        body: `${homeTeam} vs ${awayTeam} ahora juega el ${formatted}. Revisá tu pronóstico.`,
        icon: 'calendar',
    };

    for (const u of bettersRes.rows) {
        pushToUser(u.user_id, { title: payload.title, body: payload.body }).catch(err =>
            console.error(`[reschedule] push failed user=${u.user_id}:`, err.message)
        );
        await connection_1.db.query(
            `INSERT INTO notifications (user_id, match_id, type, payload, status, sent_at)
             VALUES ($1, $2, 'match_rescheduled', $3, 'sent', NOW())`,
            [u.user_id, matchId, JSON.stringify(payload)]
        ).catch(err => console.error(`[reschedule] insert failed user=${u.user_id}:`, err.message));
        if (process.env.ENGAGE_ENABLED === 'true') {
            sendEvent({
                type: 'prode.match_rescheduled',
                userId: String(u.user_id),
                idempotencyKey: `match_rescheduled:${u.user_id}:${matchId}`,
                payload: {
                    business_context: {
                        match: { local: homeTeam, away: awayTeam, new_datetime: formatted },
                    },
                },
                metadata: {
                    user_contact: {
                        nombre: u.nombre,
                        phone: u.whatsapp_number,
                        whatsapp_consent: u.whatsapp_consent,
                        idioma_pref: 'es-AR',
                    },
                },
            }).catch(err => console.error(`[reschedule] engage failed user=${u.user_id}:`, err.message));
        } else if (u.whatsapp_number && u.whatsapp_consent) {
            sendSMSWithRetry({
                to: u.whatsapp_number,
                body: `📅 ${homeTeam} vs ${awayTeam} reprogramado: ${formatted} — prodecaballito.com/apuestas`,
            }).catch(err => console.error(`[reschedule] SMS failed user=${u.user_id}:`, err.message));
        }
    }
}

async function actualizarRanking(matchId = null) {
    const prevResult = await connection_1.db.query(`
    SELECT r.id, r.planilla_id, r.position, r.puntos_totales, p.user_id, u.nombre, u.email
    FROM ranking r
    JOIN planillas p ON r.planilla_id = p.id
    JOIN users u ON p.user_id = u.id
  `);
    const prevRanking = new Map();
    for (const row of prevResult.rows) {
        prevRanking.set(row.planilla_id, {
            position: row.position,
            puntos_totales: row.puntos_totales,
            user_id: row.user_id,
            nombre: row.nombre,
            email: row.email,
        });
    }
    // FIX: solo contar scores cuyo match está 'finished'.
    // Razón: si un match se finaliza y luego se revierte (admin), los scores
    // huérfanos NO deben sumarse al ranking. El LEFT JOIN previo no filtraba.
    await connection_1.db.query(`
    INSERT INTO ranking (
      planilla_id,
      puntos_totales,
      exactos_count,
      aciertos_celeste,
      aciertos_rojo,
      aciertos_verde,
      aciertos_amarillo,
      updated_at
    )
    SELECT
      p.id as planilla_id,
      COALESCE(SUM(s.puntos_obtenidos) FILTER (WHERE m.estado = 'finished'), 0) as puntos_totales,
      COUNT(s.id) FILTER (WHERE s.puntos_obtenidos >= 3 AND m.estado = 'finished') as exactos_count,
      COUNT(s.id) FILTER (WHERE s.puntos_obtenidos = 4 AND m.estado = 'finished') as aciertos_celeste,
      COUNT(s.id) FILTER (WHERE s.puntos_obtenidos = 3 AND m.estado = 'finished') as aciertos_rojo,
      COUNT(s.id) FILTER (WHERE s.puntos_obtenidos = 2 AND m.estado = 'finished') as aciertos_verde,
      COUNT(s.id) FILTER (WHERE s.puntos_obtenidos = 1 AND m.estado = 'finished') as aciertos_amarillo,
      NOW() as updated_at
    FROM planillas p
    LEFT JOIN scores s ON p.id = s.planilla_id
    LEFT JOIN matches m ON s.match_id = m.id
    GROUP BY p.id
    ON CONFLICT (planilla_id) DO UPDATE SET
      puntos_totales = EXCLUDED.puntos_totales,
      exactos_count = EXCLUDED.exactos_count,
      aciertos_celeste = EXCLUDED.aciertos_celeste,
      aciertos_rojo = EXCLUDED.aciertos_rojo,
      aciertos_verde = EXCLUDED.aciertos_verde,
      aciertos_amarillo = EXCLUDED.aciertos_amarillo,
      updated_at = NOW()
  `);
    // Limpiar posiciones de planillas no pagadas
    await connection_1.db.query(`
    UPDATE ranking r 
    SET position = NULL 
    FROM planillas p 
    WHERE r.planilla_id = p.id AND p.precio_pagado = false
  `);
    // Calcular posiciones solo para planillas pagadas con criterios de desempate oficiales
    await connection_1.db.query(`
    WITH ranked AS (
      SELECT r.id, ROW_NUMBER() OVER (
        ORDER BY 
          r.puntos_totales DESC,
          r.aciertos_celeste DESC,
          r.aciertos_rojo DESC,
          r.aciertos_verde DESC,
          r.aciertos_amarillo DESC
      ) as position
      FROM ranking r
      JOIN planillas p ON r.planilla_id = p.id
      WHERE p.precio_pagado = true
    )
    UPDATE ranking r SET position = ranked.position FROM ranked WHERE r.id = ranked.id
  `);
    const newResult = await connection_1.db.query(`
    SELECT r.id, r.planilla_id, r.position, r.puntos_totales, p.user_id, p.nombre_planilla,
           u.nombre, u.email, u.whatsapp_number, u.whatsapp_consent
    FROM ranking r
    JOIN planillas p ON r.planilla_id = p.id
    JOIN users u ON p.user_id = u.id
  `);
    // Build position→row map for "te pasaron" and "cerca del podio" lookups
    const newByPos = new Map();
    for (const row of newResult.rows) {
        if (row.position != null) newByPos.set(row.position, row);
    }
    const podio3 = newByPos.get(3);
    const { pushToUser } = require('../services/push');

    for (const row of newResult.rows) {
        const prev = prevRanking.get(row.planilla_id);
        const prevPos = prev?.position || null;
        // Engage recibe siempre el estado del ranking — Engage decide si notificar.
        // El email fallback solo se manda cuando la posición realmente cambió.
        try {
            if (process.env.ENGAGE_ENABLED === 'true') {
                await sendEvent({
                    type: prevPos == null ? 'prode.ranking_change.entered'
                        : row.position < prevPos ? 'prode.ranking_change.up'
                        : 'prode.ranking_change.down',
                    userId: String(row.user_id),
                    idempotencyKey: `ranking_change:${row.user_id}:${matchId || 'recalc'}`,
                    payload: {
                        business_context: {
                            old_rank: prevPos,
                            new_rank: row.position,
                            delta: prevPos != null ? Math.abs(prevPos - row.position) : null,
                            puntos_totales: row.puntos_totales,
                            planilla_nombre: row.nombre_planilla,
                            // Normalized aliases for template variables
                            puntos: row.puntos_totales,
                            posicion: row.position,
                        },
                    },
                    metadata: {
                        user_contact: {
                            nombre: row.nombre,
                            email: row.email,
                            phone: row.whatsapp_number,
                            whatsapp_consent: row.whatsapp_consent,
                            idioma_pref: 'es-AR',
                        },
                    },
                });
                console.log(`[engage] ranking_change queued for ${row.email} (position: ${row.position})`);
            } else if (prevPos !== row.position) {
                await sendRankingUpdateEmail(row.email, row.nombre, row.position, prevPos, row.puntos_totales);
                console.log(`📧 Email sent to ${row.email} (position: ${row.position})`);
            }
        }
        catch (err) {
            console.error(`Failed to send ranking update for ${row.email}:`, err);
        }
        // In-app notification solo cuando la posición cambió y el usuario está en el ranking
        if (prevPos !== row.position && row.position != null) {
            const payload = buildRankingChangePayload({
                prevPos,
                newPos: row.position,
                planillaNombre: row.nombre_planilla,
            });
            await connection_1.db.query(
                `INSERT INTO notifications (user_id, type, payload, status, sent_at)
                 VALUES ($1, 'ranking_change', $2, 'sent', NOW())`,
                [row.user_id, JSON.stringify(payload)]
            ).catch(err => console.error(`[ranking-notif] insert failed user=${row.user_id}:`, err.message));
        }

        // "Te pasaron en el ranking" — position worsened and we can identify who took the spot
        if (prevPos != null && row.position != null && row.position > prevPos) {
            const overtaker = newByPos.get(prevPos);
            if (overtaker && overtaker.planilla_id !== row.planilla_id) {
                const payload = {
                    title: `👊 ${overtaker.nombre} te bajó del #${prevPos}`,
                    body: `Ahora estás #${row.position}. Próximo partido, tu revancha.`,
                    icon: 'trophy',
                };
                pushToUser(row.user_id, { title: payload.title, body: payload.body }).catch(err =>
                    console.error(`[ranking-passed] push failed user=${row.user_id}:`, err.message)
                );
                await connection_1.db.query(
                    `INSERT INTO notifications (user_id, type, payload, status, sent_at)
                     VALUES ($1, 'ranking_passed', $2, 'sent', NOW())`,
                    [row.user_id, JSON.stringify(payload)]
                ).catch(err => console.error(`[ranking-passed] insert failed user=${row.user_id}:`, err.message));

                if (process.env.ENGAGE_ENABLED === 'true' && row.whatsapp_number) {
                    sendEvent({
                        type: 'prode.voice_trash_talk',
                        userId: String(row.user_id),
                        idempotencyKey: `voice_trash_talk:${row.user_id}:${matchId || 'recalc'}:${overtaker.user_id}`,
                        payload: {
                            business_context: {
                                template: 'Trash Talk Prode',
                                rival_nombre: overtaker.nombre,
                                rival_pos: prevPos,
                                mi_pos: row.position,
                                rival_puntos: overtaker.puntos_totales,
                                mis_puntos: row.puntos_totales,
                            },
                        },
                        metadata: {
                            user_contact: {
                                nombre: row.nombre,
                                phone: row.whatsapp_number,
                                idioma_pref: 'es-AR',
                            },
                        },
                    }).catch(err => console.error(`[engage] voice_trash_talk error user=${row.user_id}:`, err.message));
                }
            }
        }

        // "Cerca del podio" — Engage recibe siempre con el gap; Engage aplica sus propias reglas.
        // El fallback local solo notifica cuando gap <= 5 (no hay Engage que filtre).
        if (matchId && row.position != null && podio3) {
            const gap = podio3.puntos_totales - row.puntos_totales;
            if (process.env.ENGAGE_ENABLED === 'true') {
                sendEvent({
                    type: 'prode.near_podio',
                    userId: String(row.user_id),
                    idempotencyKey: `near_podio:${row.user_id}:${matchId}`,
                    payload: {
                        business_context: {
                            gap,
                            podio3_nombre: podio3.nombre,
                            planilla_nombre: row.nombre_planilla,
                            position: row.position,
                        },
                    },
                    metadata: {
                        user_contact: {
                            nombre: row.nombre,
                            phone: row.whatsapp_number,
                            whatsapp_consent: row.whatsapp_consent,
                            idioma_pref: 'es-AR',
                        },
                    },
                }).catch(err => console.error(`[near-podio] engage failed user=${row.user_id}:`, err.message));
            } else if (row.position > 3 && gap >= 0 && gap <= 5) {
                const inserted = await connection_1.db.query(
                    `INSERT INTO reminder_sent (user_id, match_id, reminder_type)
                     VALUES ($1, $2, 'near_podio')
                     ON CONFLICT (user_id, match_id, reminder_type) DO NOTHING
                     RETURNING user_id`,
                    [row.user_id, matchId]
                ).catch(() => ({ rows: [] }));
                if (inserted.rows.length > 0) {
                    const nearPodioTitle = gap === 1 ? '🔥 A 1 punto del podio'
                        : gap <= 3 ? `🎯 A ${gap} pts del podio`
                        : '📊 Zona de podio';
                    const nearPodioBody = gap === 1
                        ? `Un exacto te puede meter en el top 3 de "${row.nombre_planilla}".`
                        : gap <= 3
                        ? `Estás muy cerca del #3. Próxima fecha.`
                        : `A ${gap} pts del #3 en "${row.nombre_planilla}". Tu momento llega.`;
                    const payload = { title: nearPodioTitle, body: nearPodioBody, icon: 'trophy' };
                    pushToUser(row.user_id, { title: payload.title, body: payload.body }).catch(err =>
                        console.error(`[near-podio] push failed user=${row.user_id}:`, err.message)
                    );
                    await connection_1.db.query(
                        `INSERT INTO notifications (user_id, type, payload, status, sent_at)
                         VALUES ($1, 'near_podio', $2, 'sent', NOW())`,
                        [row.user_id, JSON.stringify(payload)]
                    ).catch(err => console.error(`[near-podio] insert failed user=${row.user_id}:`, err.message));
                }
            }
        }
    }
}

function buildRankingChangePayload({ prevPos, newPos, planillaNombre }) {
    const board = planillaNombre ? `en "${planillaNombre}"` : '';
    if (prevPos == null) {
        return {
            title: '⭐ ¡Estás en el ranking!',
            body: `Arrancás #${newPos} ${board}. El podio te espera.`.trim(),
            icon: 'trophy',
        };
    }
    if (prevPos > newPos) {
        const delta = prevPos - newPos;
        if (newPos <= 3) {
            const medal = newPos === 1 ? '🥇' : newPos === 2 ? '🥈' : '🥉';
            return {
                title: `${medal} Estás en el podio`,
                body: `Pasaste ${delta} ${delta === 1 ? 'persona' : 'personas'}. Seguís así.`,
                icon: 'trophy',
            };
        }
        if (delta >= 5) {
            return {
                title: '📈 ¡Qué remontada!',
                body: `+${delta} puestos de un saque. Ahora sos #${newPos} ${board}`.trim(),
                icon: 'trophy',
            };
        }
        return {
            title: '📈 Subiste',
            body: `+${delta} ${delta === 1 ? 'posición' : 'posiciones'} — sos #${newPos} ${board}`.trim(),
            icon: 'trophy',
        };
    }
    const cambio = newPos - prevPos;
    const noun = cambio > 1 ? 'posiciones' : 'posición';
    return {
        title: '📉 Bajaste en el ranking',
        body: `Bajaste ${cambio} ${noun}. Ahora estás #${newPos} ${board}`.trim(),
        icon: 'trophy',
    };
}
router.post('/recalculate-ranking', async (req, res) => {
    try {
        await actualizarRanking();
        res.json({ success: true, message: 'Ranking actualizado correctamente' });
    }
    catch (error) {
        console.error('Error recalculating ranking:', error);
        res.status(500).json({ success: false, error: 'Error al actualizar ranking' });
    }
});
exports.default = router;
exports.actualizarRanking = actualizarRanking;
exports.buildRankingChangePayload = buildRankingChangePayload;
//# sourceMappingURL=matches.js.map