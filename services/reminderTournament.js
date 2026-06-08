'use strict'

const { db } = require('../db/connection')
const { pushToUser } = require('./push')
const { sendSMSWithRetry } = require('./sms')
const { sendEvent } = require('./engageClient')

const REMINDER_TYPE = 'tournament_tomorrow'

async function runTournamentReminders() {
    // Find tournaments whose first match starts in the 23-25 hour window
    const tournamentsRes = await db.query(`
        SELECT t.id AS tournament_id, t.name AS tournament_name,
               MIN(m.start_time) AS first_match_start,
               (ARRAY_AGG(m.id ORDER BY m.start_time ASC))[1] AS first_match_id
        FROM matches m
        JOIN tournaments t ON t.id = m.tournament_id
        WHERE m.estado = 'scheduled' AND m.tournament_id IS NOT NULL
        GROUP BY t.id, t.name
        HAVING MIN(m.start_time) BETWEEN NOW() + INTERVAL '23 hours' AND NOW() + INTERVAL '25 hours'
    `)

    if (tournamentsRes.rows.length === 0) {
        return { tournaments_in_window: 0, users_notified: 0, skipped: 0 }
    }

    let notified = 0
    let skipped = 0

    for (const t of tournamentsRes.rows) {
        // Users with a planilla in this tournament that have at least one pending bet
        const usersRes = await db.query(`
            SELECT u.id AS user_id, u.whatsapp_number, u.whatsapp_consent,
                   COUNT(m2.id) FILTER (WHERE b.id IS NULL) AS pending_count
            FROM planillas p
            JOIN users u ON u.id = p.user_id
            JOIN matches m2 ON m2.tournament_id = $1 AND m2.estado = 'scheduled'
            LEFT JOIN bets b ON b.planilla_id = p.id AND b.match_id = m2.id
            WHERE p.tournament_id = $1
            GROUP BY u.id, u.whatsapp_number, u.whatsapp_consent
            HAVING COUNT(m2.id) FILTER (WHERE b.id IS NULL) > 0
        `, [t.tournament_id])

        for (const u of usersRes.rows) {
            const insertRes = await db.query(
                `INSERT INTO reminder_sent (user_id, match_id, reminder_type)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (user_id, match_id, reminder_type) DO NOTHING
                 RETURNING user_id`,
                [u.user_id, t.first_match_id, REMINDER_TYPE]
            ).catch(() => ({ rows: [] }))

            if (insertRes.rows.length === 0) { skipped++; continue }

            const pending = parseInt(u.pending_count)
            const payload = {
                title: `🏁 Mañana arranca ${t.tournament_name}`,
                body: pending === 1
                    ? `Tenés 1 partido sin apostar. Tu ranking empieza ahora.`
                    : `Tenés ${pending} partidos sin apostar. Tu ranking empieza ahora.`,
                icon: 'soccer',
            }

            pushToUser(u.user_id, { title: payload.title, body: payload.body }).catch(err =>
                console.error(`[tournament-reminder] push failed user=${u.user_id}:`, err.message)
            )

            await db.query(
                `INSERT INTO notifications (user_id, match_id, type, payload, status, sent_at)
                 VALUES ($1, $2, 'tournament_tomorrow', $3, 'sent', NOW())`,
                [u.user_id, t.first_match_id, JSON.stringify(payload)]
            ).catch(err => console.error(`[tournament-reminder] insert failed user=${u.user_id}:`, err.message))

            if (process.env.ENGAGE_ENABLED === 'true') {
                sendEvent({
                    type: 'prode.tournament_tomorrow',
                    userId: String(u.user_id),
                    idempotencyKey: `tournament_tomorrow:${u.user_id}:${t.first_match_id}`,
                    payload: {
                        business_context: {
                            tournament_name: t.tournament_name,
                            pending_bets: pending,
                        },
                    },
                    metadata: {
                        user_contact: {
                            phone: u.whatsapp_number,
                            whatsapp_consent: u.whatsapp_consent,
                            idioma_pref: 'es-AR',
                        },
                    },
                }).catch(err => console.error(`[tournament-reminder] engage failed user=${u.user_id}:`, err.message))
            } else if (u.whatsapp_number && u.whatsapp_consent) {
                sendSMSWithRetry({
                    to: u.whatsapp_number,
                    body: `🏁 Mañana arranca ${t.tournament_name}. ${payload.body} 👉 prodecaballito.com/apuestas`,
                }).catch(err => console.error(`[tournament-reminder] SMS failed user=${u.user_id}:`, err.message))
            }

            notified++
        }
    }

    console.log(`[tournament-reminder] tournaments_in_window=${tournamentsRes.rows.length} notified=${notified} skipped=${skipped}`)
    return { tournaments_in_window: tournamentsRes.rows.length, users_notified: notified, skipped }
}

module.exports = { runTournamentReminders }
