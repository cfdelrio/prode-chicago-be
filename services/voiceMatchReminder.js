'use strict';

const { db } = require('../db/connection');
const { sendEventBatch } = require('./engageClient');
const { buildEngageMetadata } = require('../utils/engageHelpers');

const REMINDER_TYPE = 'voice_match_reminder';
const WINDOW_MIN = 25;
const WINDOW_MAX = 35;

const SKIP_REASONS = {
    NO_PHONE: 'no_phone',
    ALREADY_SENT: 'already_sent',
    NO_CONSENT: 'no_whatsapp_consent',
};

/**
 * Cron job (cada 5 min): encuentra matches que arrancan en 25–35 min
 * y para cada usuario con bet pending + teléfono, dispara prode.voice_match_reminder.
 *
 * Idempotente via reminder_sent(user_id, match_id, 'voice_match_reminder').
 * Skip silencioso si ENGAGE_ENABLED !== 'true' (salvo dryRun).
 *
 * @param {object} [opts]
 * @param {string[]} [opts.userIds]    Restringir a UUIDs específicos (test admin).
 * @param {boolean}  [opts.dryRun]     Solo devolver preview, sin insertar ni publicar.
 * @param {boolean}  [opts.skipWindow] Ignorar ventana 25-35 min (solo para testing manual).
 * @returns {Promise<{matches_in_window, users_notified, skipped, skip_details, dry_run, preview?}>}
 */
async function runVoiceMatchReminders({ userIds = null, dryRun = false, skipWindow = false } = {}) {
    if (process.env.ENGAGE_ENABLED !== 'true' && !dryRun) {
        console.log('[voice-match-reminder] ENGAGE_ENABLED=false — skipping');
        return { matches_in_window: 0, users_notified: 0, skipped: 0, skip_details: [], engage_disabled: true };
    }

    const matchesRes = await db.query(
        skipWindow
            ? `SELECT id, home_team, away_team, start_time, tournament_id
               FROM matches
               WHERE estado = 'scheduled'
               ORDER BY start_time ASC
               LIMIT 5`
            : `SELECT id, home_team, away_team, start_time, tournament_id
               FROM matches
               WHERE estado = 'scheduled'
                 AND start_time BETWEEN NOW() + INTERVAL '${WINDOW_MIN} minutes'
                                     AND NOW() + INTERVAL '${WINDOW_MAX} minutes'`
    );

    if (matchesRes.rows.length === 0) {
        console.log(`[voice-match-reminder] matches_in_window=0 skipWindow=${skipWindow}`);
        return { matches_in_window: 0, users_notified: 0, skipped: 0, skip_details: [], dry_run: dryRun };
    }

    let notified = 0;
    let skipped = 0;
    const skipDetails = [];
    const preview = [];

    for (const match of matchesRes.rows) {
        const params = [match.id];
        let userFilter = '';
        if (userIds && userIds.length > 0) {
            params.push(userIds);
            userFilter = ` AND u.id = ANY($2::uuid[])`;
        }

        const usersRes = await db.query(`
            SELECT u.id AS user_id, u.nombre, u.email, u.whatsapp_number,
                   u.whatsapp_consent, u.tema_equipo, u.foto_url, u.created_at,
                   u.rol, u.idioma_pref,
                   b.goles_local, b.goles_visitante,
                   p.id AS planilla_id, p.nombre_planilla
            FROM bets b
            JOIN planillas p ON p.id = b.planilla_id
            JOIN users u ON u.id = p.user_id
            WHERE b.match_id = $1
              ${userFilter}
        `, params);

        const events = [];
        for (const u of usersRes.rows) {
            if (!u.whatsapp_number) {
                skipped++;
                skipDetails.push({ user_id: u.user_id, nombre: u.nombre, reason: SKIP_REASONS.NO_PHONE });
                continue;
            }

            if (!dryRun) {
                const insertRes = await db.query(
                    `INSERT INTO reminder_sent (user_id, match_id, reminder_type)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (user_id, match_id, reminder_type) DO NOTHING
                     RETURNING user_id`,
                    [u.user_id, match.id, REMINDER_TYPE]
                ).catch(() => ({ rows: [] }));

                if (insertRes.rows.length === 0) {
                    skipped++;
                    skipDetails.push({ user_id: u.user_id, nombre: u.nombre, reason: SKIP_REASONS.ALREADY_SENT });
                    continue;
                }
            }

            events.push({
                type: 'prode.voice_match_reminder',
                userId: String(u.user_id),
                idempotencyKey: `voice_match_reminder:${u.user_id}:${match.id}`,
                payload: {
                    business_context: {
                        template: 'Match Reminder Prode',
                        home_team: match.home_team,
                        away_team: match.away_team,
                        minutes_to_kickoff: WINDOW_MIN,
                        bet_local: u.goles_local,
                        bet_visitante: u.goles_visitante,
                    },
                },
                metadata: buildEngageMetadata(u, {
                    planilla_nombre: u.nombre_planilla,
                    planilla_id: u.planilla_id,
                }),
            });

            if (dryRun) preview.push({
                match: `${match.home_team} vs ${match.away_team}`,
                user: u.nombre,
                phone: u.whatsapp_number,
                bet: `${u.goles_local}-${u.goles_visitante}`,
            });
            notified++;
        }

        if (events.length > 0 && !dryRun) {
            await sendEventBatch(events).catch(err =>
                console.error(`[voice-match-reminder] batch failed match=${match.id}:`, err.message)
            );
        }
    }

    console.log(`[voice-match-reminder] matches_in_window=${matchesRes.rows.length} notified=${notified} skipped=${skipped} dryRun=${dryRun} skipWindow=${skipWindow}`);
    return {
        matches_in_window: matchesRes.rows.length,
        users_notified: notified,
        skipped,
        skip_details: skipDetails,
        dry_run: dryRun,
        skip_window: skipWindow,
        ...(dryRun ? { preview } : {}),
    };
}

module.exports = { runVoiceMatchReminders, REMINDER_TYPE, SKIP_REASONS };
