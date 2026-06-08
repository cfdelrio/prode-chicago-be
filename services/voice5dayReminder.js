'use strict';

const { db } = require('../db/connection');
const { sendEventBatch } = require('./engageClient');
const { buildEngageMetadata } = require('../utils/engageHelpers');

const REMINDER_TYPE = 'voice_5days';
const TEMPLATE_NAME = 'Onboarding Workcup 2026';

const SKIP_REASONS = {
    NO_PHONE: 'no_phone',
    ALREADY_SENT: 'already_sent',
};

/**
 * Daily job: find tournaments whose first match starts in ~5 days,
 * and for each user with a planilla in that tournament + pending bets,
 * publish a `prode.voice_survey` event to Engage.
 *
 * Engage uses the "Onboarding Workcup 2026" template wired to voice.orkestai
 * to render the TTS prompt and place the outbound call.
 *
 * Idempotent via reminder_sent(user_id, match_id, reminder_type='voice_5days')
 * keyed on the first match of the tournament. Skips silently if
 * ENGAGE_ENABLED !== 'true' — there is no Twilio fallback for this trigger.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.userIds]  Restrict to specific user UUIDs (admin testing).
 * @param {boolean}  [opts.dryRun]   Skip reminder_sent insert + Engage publish; just
 *                                   return what would have been sent. Useful for preview.
 */
async function runVoice5dayReminders({ userIds = null, dryRun = false } = {}) {
    if (process.env.ENGAGE_ENABLED !== 'true' && !dryRun) {
        console.log('[voice-5day] ENGAGE_ENABLED=false — skipping (no Twilio fallback for this trigger)');
        return { tournaments_in_window: 0, users_notified: 0, skipped: 0, engage_disabled: true };
    }

    const tournamentsRes = await db.query(`
        SELECT t.id AS tournament_id, t.name AS tournament_name,
               MIN(m.start_time) AS first_match_start,
               (ARRAY_AGG(m.id ORDER BY m.start_time ASC))[1] AS first_match_id
        FROM matches m
        JOIN tournaments t ON t.id = m.tournament_id
        WHERE m.estado = 'scheduled' AND m.tournament_id IS NOT NULL
        GROUP BY t.id, t.name
        HAVING MIN(m.start_time) BETWEEN NOW() + INTERVAL '4 days 23 hours'
                                     AND NOW() + INTERVAL '5 days 1 hour'
    `);

    if (tournamentsRes.rows.length === 0) {
        console.log('[voice-5day] no tournaments in T-5d window');
        return { tournaments_in_window: 0, users_notified: 0, skipped: 0 };
    }

    let notified = 0;
    let skipped = 0;
    const skipDetails = [];
    const preview = [];

    for (const t of tournamentsRes.rows) {
        const params = [t.tournament_id];
        let userFilter = '';
        if (userIds && userIds.length > 0) {
            params.push(userIds);
            userFilter = ` AND u.id = ANY($2::uuid[])`;
        }
        const usersRes = await db.query(`
            SELECT u.id AS user_id, u.nombre, u.email,
                   u.whatsapp_number, u.whatsapp_consent,
                   u.tema_equipo, u.foto_url, u.created_at, u.rol, u.idioma_pref,
                   p.id AS planilla_id, p.nombre_planilla,
                   COUNT(m2.id) FILTER (WHERE b.id IS NULL) AS pending_count
            FROM planillas p
            JOIN users u ON u.id = p.user_id
            JOIN matches m2 ON m2.tournament_id = $1 AND m2.estado = 'scheduled'
            LEFT JOIN bets b ON b.planilla_id = p.id AND b.match_id = m2.id
            WHERE p.tournament_id = $1
              ${userFilter}
            GROUP BY u.id, u.nombre, u.email, u.whatsapp_number, u.whatsapp_consent,
                     u.tema_equipo, u.foto_url, u.created_at, u.rol, u.idioma_pref,
                     p.id, p.nombre_planilla
            HAVING COUNT(m2.id) FILTER (WHERE b.id IS NULL) > 0
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
                    [u.user_id, t.first_match_id, REMINDER_TYPE]
                ).catch(() => ({ rows: [] }));

                if (insertRes.rows.length === 0) {
                    skipped++;
                    skipDetails.push({ user_id: u.user_id, nombre: u.nombre, reason: SKIP_REASONS.ALREADY_SENT });
                    continue;
                }
            }

            events.push({
                type: 'prode.voice_survey',
                userId: String(u.user_id),
                idempotencyKey: `voice_5days:${u.user_id}:${t.first_match_id}`,
                payload: {
                    business_context: {
                        template: TEMPLATE_NAME,
                        tournament_name: t.tournament_name,
                        pending_bets: parseInt(u.pending_count),
                        days_left: 5,
                    },
                },
                metadata: buildEngageMetadata(u, {
                    planilla_nombre: u.nombre_planilla,
                    planilla_id: u.planilla_id,
                    tournament_name: t.tournament_name,
                }),
            });
            if (dryRun) preview.push({ tournament: t.tournament_name, user: u.nombre, phone: u.whatsapp_number, pending: parseInt(u.pending_count) });
            notified++;
        }

        if (events.length > 0 && !dryRun) {
            await sendEventBatch(events).catch(err =>
                console.error(`[voice-5day] engage batch failed tournament=${t.tournament_id}:`, err.message)
            );
        }
    }

    console.log(`[voice-5day] tournaments_in_window=${tournamentsRes.rows.length} notified=${notified} skipped=${skipped} dryRun=${dryRun}`);
    return {
        tournaments_in_window: tournamentsRes.rows.length,
        users_notified: notified,
        skipped,
        skip_details: skipDetails,
        dry_run: dryRun,
        ...(dryRun ? { preview } : {}),
    };
}

module.exports = { runVoice5dayReminders, REMINDER_TYPE, TEMPLATE_NAME };
