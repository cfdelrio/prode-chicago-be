"use strict";

const { db } = require('../db/connection');
const { pushToUser } = require('./push');
const { sendSMSWithRetry } = require('./sms');
const { sendEvent } = require('./engageClient');
const { buildEngageMetadata } = require('../utils/engageHelpers');

const REMINDER_TYPE = 'cutoff_30min';
const DEFAULT_CUTOFF_MINUTES = 5; // minutes before first match that bets lock

/**
 * Returns the cutoff_minutes for a tournament (from config or default).
 */
async function getTournamentCutoffMinutes(tournamentId) {
    const c = await db.query(
        `SELECT value FROM config WHERE key = $1`,
        [`tournament_cutoff_minutes_${tournamentId}`]
    );
    if (c.rows.length === 0) return DEFAULT_CUTOFF_MINUTES;
    const v = c.rows[0].value;
    let parsed = v;
    if (typeof v === 'string') {
        try { parsed = JSON.parse(v); } catch { parsed = v; }
    }
    const n = Number(parsed);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_CUTOFF_MINUTES;
}

function buildPayload({ pending, tournamentName, firstMatch, minutesLeft }) {
    const title = minutesLeft != null
        ? `⏰ Cerrás en ${minutesLeft} min`
        : '⏰ El torneo cierra pronto';
    if (pending === 1 && firstMatch) {
        return {
            title,
            body: `${firstMatch.home_team} vs ${firstMatch.away_team} — si no apostás, regalás puntos.`,
            url: '/apuestas',
            icon: '/favicon.svg',
        };
    }
    return {
        title,
        body: tournamentName
            ? `Tenés ${pending} sin cargar en ${tournamentName}. Ahora o nunca.`
            : `Tenés ${pending} pronóstico${pending === 1 ? '' : 's'} sin cargar. Ahora o nunca.`,
        url: '/apuestas',
        icon: '/favicon.svg',
    };
}

/**
 * Notify users with pending bets before the tournament-level cutoff fires.
 *
 * Logic:
 *   - For each active tournament, cutoff = MIN(start_time of scheduled matches) - cutoff_minutes.
 *   - If that cutoff falls in (NOW+20min, NOW+40min), notify each user with at least
 *     one planilla in the tournament that has missing bets.
 *   - For standalone matches (no tournament_id), use per-match time_cutoff.
 *
 * Idempotent: uses reminder_sent (user_id, match_id, reminder_type). For tournament
 * reminders the key match_id is the first scheduled match of the tournament.
 */
async function runCutoffReminders({ dryRun = false, skipWindow = false } = {}) {
    // ── Tournament-level reminders ───────────────────────────────────────────
    const tournamentsRes = await db.query(`
        SELECT t.id AS tournament_id, t.name AS tournament_name,
               MIN(m.start_time) AS first_match_start,
               (ARRAY_AGG(m.id ORDER BY m.start_time ASC))[1] AS first_match_id,
               (ARRAY_AGG(m.home_team ORDER BY m.start_time ASC))[1] AS first_home,
               (ARRAY_AGG(m.away_team ORDER BY m.start_time ASC))[1] AS first_away
        FROM matches m
        JOIN tournaments t ON t.id = m.tournament_id
        WHERE m.estado = 'scheduled' AND m.tournament_id IS NOT NULL
        GROUP BY t.id, t.name
    `);

    let notified = 0;
    let skipped = 0;
    let tournamentsInWindow = 0;
    const skipDetails = [];
    const preview = [];

    for (const t of tournamentsRes.rows) {
        if (!skipWindow) {
            const minutes = await getTournamentCutoffMinutes(t.tournament_id);
            const cutoffMs = new Date(t.first_match_start).getTime() - minutes * 60 * 1000;
            const now = Date.now();
            if (cutoffMs < now + 20 * 60 * 1000 || cutoffMs > now + 40 * 60 * 1000) continue;
        }
        tournamentsInWindow++;

        // Users with a planilla in this tournament who have at least one missing bet.
        // Joins users so we get whatsapp info in one round-trip (avoids N+1).
        const missingRes = await db.query(`
            SELECT p.user_id, p.id AS planilla_id, p.nombre_planilla,
                   u.nombre, u.email, u.whatsapp_number, u.whatsapp_consent,
                   u.tema_equipo, u.foto_url, u.created_at, u.rol, u.idioma_pref,
                   COUNT(*) FILTER (WHERE b.id IS NULL) AS missing_count
            FROM planilla_tournaments pt
            JOIN planillas p ON p.id = pt.planilla_id
            JOIN users u ON u.id = p.user_id
            JOIN matches m ON m.tournament_id = pt.tournament_id AND m.estado = 'scheduled'
            LEFT JOIN bets b ON b.planilla_id = p.id AND b.match_id = m.id
            WHERE pt.tournament_id = $1
            GROUP BY p.user_id, p.id, p.nombre_planilla,
                     u.nombre, u.email, u.whatsapp_number, u.whatsapp_consent,
                     u.tema_equipo, u.foto_url, u.created_at, u.rol, u.idioma_pref
            HAVING COUNT(*) FILTER (WHERE b.id IS NULL) > 0
        `, [t.tournament_id]);

        for (const row of missingRes.rows) {
            if (!dryRun) {
                const insertRes = await db.query(
                    `INSERT INTO reminder_sent (user_id, match_id, reminder_type)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (user_id, match_id, reminder_type) DO NOTHING
                     RETURNING match_id`,
                    [row.user_id, t.first_match_id, REMINDER_TYPE]
                );
                if (insertRes.rows.length === 0) {
                    skipped++;
                    skipDetails.push({ user_id: row.user_id, nombre: row.nombre, reason: 'already_sent' });
                    continue;
                }
            }

            const pending = Number(row.missing_count);
            const cutoffMinutes = await getTournamentCutoffMinutes(t.tournament_id);
            const cutoffMs = new Date(t.first_match_start).getTime() - cutoffMinutes * 60 * 1000;
            const minutesLeft = Math.round((cutoffMs - Date.now()) / 60000);

            if (dryRun) {
                preview.push({ tournament: t.tournament_name, user: row.nombre, pending, minutes_left: minutesLeft, match: `${t.first_home} vs ${t.first_away}` });
                notified++;
                continue;
            }
            const firstMatch = { home_team: t.first_home, away_team: t.first_away };
            const payload = buildPayload({ pending, tournamentName: t.tournament_name, firstMatch, minutesLeft });

            await pushToUser(row.user_id, payload).catch(err =>
                console.error(`[cutoff-reminder] push failed user=${row.user_id}:`, err.message)
            );

            if (process.env.ENGAGE_ENABLED === 'true') {
                await sendEvent({
                    type: 'prode.cutoff_reminder',
                    userId: String(row.user_id),
                    idempotencyKey: `cutoff_reminder:${row.user_id}:${t.first_match_id}`,
                    payload: {
                        business_context: {
                            tournament_name: t.tournament_name,
                            minutes_left: minutesLeft,
                            pending_bets: pending,
                            first_match: { local: t.first_home, away: t.first_away },
                        },
                    },
                    metadata: buildEngageMetadata(row, {
                        planilla_nombre: row.nombre_planilla,
                        planilla_id: row.planilla_id,
                        tournament_name: t.tournament_name,
                    }),
                }).catch(err => console.error(`[cutoff-reminder] engage failed user=${row.user_id}:`, err.message));
            } else if (row.whatsapp_number && row.whatsapp_consent) {
                const smsBody = pending === 1
                    ? `⏰ En ${minutesLeft} min cierra ${t.tournament_name}. 1 pronóstico sin cargar 👉 prodecaballito.com/apuestas`
                    : `⏰ En ${minutesLeft} min cierra ${t.tournament_name}. Te faltan ${pending} pronósticos 👉 prodecaballito.com/apuestas`;
                await sendSMSWithRetry({ to: row.whatsapp_number, body: smsBody })
                    .catch(err => console.error(`[cutoff-reminder] sms failed (after retries) user=${row.user_id}:`, err.message));
            }

            // In-app history: link to the first match of the tournament so the entry has context.
            await db.query(
                `INSERT INTO notifications (user_id, match_id, type, payload, status, sent_at)
                 VALUES ($1, $2, 'cutoff_reminder', $3, 'sent', NOW())`,
                [row.user_id, t.first_match_id, JSON.stringify({
                    title: payload.title, body: payload.body, icon: 'clock',
                })]
            ).catch(err =>
                console.error(`[cutoff-reminder] notif insert failed user=${row.user_id}:`, err.message)
            );
            notified++;
        }
    }

    // ── Standalone matches (no tournament_id) ─────────────────────────────────
    // Standalone matches belong to a specific planilla (matches.planilla_id).
    // Without that link we have no way to know which user(s) to notify, so we
    // skip matches with planilla_id IS NULL.
    const standaloneRes = await db.query(
        skipWindow
            ? `SELECT id, home_team, away_team, time_cutoff, planilla_id
               FROM matches WHERE estado = 'scheduled' AND tournament_id IS NULL AND planilla_id IS NOT NULL
               ORDER BY start_time ASC LIMIT 5`
            : `SELECT id, home_team, away_team, time_cutoff, planilla_id
               FROM matches WHERE estado = 'scheduled' AND tournament_id IS NULL AND planilla_id IS NOT NULL
               AND time_cutoff IS NOT NULL
               AND time_cutoff BETWEEN NOW() + INTERVAL '20 minutes' AND NOW() + INTERVAL '40 minutes'`
    );

    for (const match of standaloneRes.rows) {
        const missingRes = await db.query(`
            SELECT p.user_id, p.id AS planilla_id, p.nombre_planilla,
                   u.nombre, u.email, u.whatsapp_number, u.whatsapp_consent,
                   u.tema_equipo, u.foto_url, u.created_at, u.rol, u.idioma_pref
            FROM planillas p
            JOIN users u ON u.id = p.user_id
            LEFT JOIN bets b ON b.planilla_id = p.id AND b.match_id = $1
            WHERE p.id = $2
              AND b.id IS NULL
        `, [match.id, match.planilla_id]);

        for (const row of missingRes.rows) {
            const insertRes = await db.query(
                `INSERT INTO reminder_sent (user_id, match_id, reminder_type)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (user_id, match_id, reminder_type) DO NOTHING
                 RETURNING match_id`,
                [row.user_id, match.id, REMINDER_TYPE]
            );
            if (insertRes.rows.length === 0) { skipped++; continue; }

            const cutoffMs = new Date(match.time_cutoff).getTime();
            const minutesLeft = Math.round((cutoffMs - Date.now()) / 60000);
            const payload = buildPayload({ pending: 1, tournamentName: null, firstMatch: match, minutesLeft });
            await pushToUser(row.user_id, payload).catch(err =>
                console.error(`[cutoff-reminder] push failed user=${row.user_id}:`, err.message)
            );

            if (process.env.ENGAGE_ENABLED === 'true') {
                await sendEvent({
                    type: 'prode.cutoff_reminder',
                    userId: String(row.user_id),
                    idempotencyKey: `cutoff_reminder:${row.user_id}:${match.id}`,
                    payload: {
                        business_context: {
                            minutes_left: minutesLeft,
                            pending_bets: 1,
                            first_match: { local: match.home_team, away: match.away_team },
                        },
                    },
                    metadata: buildEngageMetadata(row, {
                        planilla_nombre: row.nombre_planilla,
                        planilla_id: row.planilla_id,
                    }),
                }).catch(err => console.error(`[cutoff-reminder] engage failed user=${row.user_id}:`, err.message));
            } else if (row.whatsapp_number && row.whatsapp_consent) {
                const smsBody = `⏰ ${match.home_team} vs ${match.away_team} cierra en ${minutesLeft} min — aún no pronosticaste 👉 prodecaballito.com/apuestas`;
                await sendSMSWithRetry({ to: row.whatsapp_number, body: smsBody })
                    .catch(err => console.error(`[cutoff-reminder] sms failed (after retries) user=${row.user_id}:`, err.message));
            }

            await db.query(
                `INSERT INTO notifications (user_id, match_id, type, payload, status, sent_at)
                 VALUES ($1, $2, 'cutoff_reminder', $3, 'sent', NOW())`,
                [row.user_id, match.id, JSON.stringify({
                    title: payload.title, body: payload.body, icon: 'clock',
                })]
            ).catch(err =>
                console.error(`[cutoff-reminder] notif insert failed user=${row.user_id}:`, err.message)
            );
            notified++;
        }
    }

    console.log(`[cutoff-reminder] tournaments=${tournamentsInWindow} standalone=${standaloneRes.rows.length} notified=${notified} skipped=${skipped} dryRun=${dryRun} skipWindow=${skipWindow}`);
    return {
        tournaments_in_window: tournamentsInWindow,
        standalone_matches: standaloneRes.rows.length,
        users_notified: notified,
        skipped,
        skip_details: skipDetails,
        dry_run: dryRun,
        skip_window: skipWindow,
        ...(dryRun ? { preview } : {}),
    };
}

module.exports = { runCutoffReminders, getTournamentCutoffMinutes, buildPayload, REMINDER_TYPE, DEFAULT_CUTOFF_MINUTES };
