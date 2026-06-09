"use strict";

const { db } = require('../db/connection');
const { pushToUser } = require('./push');
const { sendSMSWithRetry } = require('./sms');
const { sendEvent } = require('./engageClient');

/**
 * Process opt-in pre-kickoff reminders saved when the user placed the bet
 * (bet_reminders table). Each row has a scheduled_for = match.start_time - remind_minutes.
 *
 * For every due row (scheduled_for <= NOW(), email_sent = false):
 *   - Push notification
 *   - SMS if user has whatsapp_number + whatsapp_consent
 *   - Mark email_sent = true (used as "sent" flag for all channels)
 */
async function processBetReminders() {
    const res = await db.query(`
        SELECT br.id, br.user_id, br.match_id, br.remind_minutes,
               m.home_team, m.away_team, m.start_time,
               b.goles_local, b.goles_visitante,
               u.whatsapp_number, u.whatsapp_consent
        FROM bet_reminders br
        JOIN matches m ON m.id = br.match_id
        JOIN users   u ON u.id = br.user_id
        LEFT JOIN bets b ON b.planilla_id = br.planilla_id AND b.match_id = br.match_id
        WHERE br.email_sent = false
          AND br.scheduled_for <= NOW()
          AND m.estado = 'scheduled'
        ORDER BY br.scheduled_for ASC
        LIMIT 200
    `);

    let sent = 0;
    let failed = 0;

    for (const r of res.rows) {
        try {
            const hasBet = r.goles_local != null && r.goles_visitante != null;
            const score = hasBet ? `${r.goles_local}-${r.goles_visitante}` : null;

            const payload = {
                title: hasBet
                    ? `⚽ En ${r.remind_minutes} min — ${r.home_team} vs ${r.away_team}`
                    : `⚽ Ojo que empieza en ${r.remind_minutes} min`,
                body: hasBet
                    ? `Tu pronóstico: ${score} 🤞 ¡Que entre!`
                    : `${r.home_team} vs ${r.away_team} — todavía podés apostar.`,
                url: '/apuestas',
                icon: '/favicon.svg',
            };

            await pushToUser(r.user_id, payload).catch(err =>
                console.error(`[bet-reminders] push failed user=${r.user_id} match=${r.match_id}:`, err.message)
            );

            if (process.env.ENGAGE_ENABLED === 'true') {
                await sendEvent({
                    type: 'prode.bet_reminder',
                    userId: String(r.user_id),
                    idempotencyKey: `bet_reminder:${r.user_id}:${r.match_id}`,
                    payload: {
                        business_context: {
                            match: { local: r.home_team, away: r.away_team },
                            remind_minutes: r.remind_minutes,
                            bet: hasBet ? { goles_local: r.goles_local, goles_visitante: r.goles_visitante } : null,
                        },
                    },
                    metadata: {
                        user_contact: {
                            phone: r.whatsapp_number,
                            whatsapp_consent: r.whatsapp_consent,
                            idioma_pref: 'es-AR',
                        },
                    },
                }).catch(err =>
                    console.error(`[bet-reminders] engage failed user=${r.user_id} match=${r.match_id}:`, err.message)
                );
            } else if (r.whatsapp_number && r.whatsapp_consent) {
                const body = hasBet
                    ? `⚽ En ${r.remind_minutes} min — ${r.home_team} vs ${r.away_team} | Tu pronóstico: ${score} 🤞 hr.prodecaballito.com`
                    : `⚽ ${r.home_team} vs ${r.away_team} empieza en ${r.remind_minutes} min — todavía podés apostar 👉 hr.prodecaballito.com/apuestas`;
                await sendSMSWithRetry({ to: r.whatsapp_number, body }).catch(err =>
                    console.error(`[bet-reminders] sms failed (after retries) user=${r.user_id} match=${r.match_id}:`, err.message)
                );
            }

            // In-app history: same title/body as push, with icon for the SW.
            await db.query(
                `INSERT INTO notifications (user_id, match_id, type, payload, status, sent_at)
                 VALUES ($1, $2, 'bet_reminder', $3, 'sent', NOW())`,
                [r.user_id, r.match_id, JSON.stringify({
                    title: payload.title, body: payload.body, icon: 'soccer',
                })]
            ).catch(err =>
                console.error(`[bet-reminders] notif insert failed user=${r.user_id} match=${r.match_id}:`, err.message)
            );

            await db.query(
                `UPDATE bet_reminders SET email_sent = true, sent_at = NOW() WHERE id = $1`,
                [r.id]
            );
            sent++;
        } catch (err) {
            failed++;
            console.error(`[bet-reminders] error on row ${r.id}:`, err.message);
        }
    }

    console.log(`[bet-reminders] processed=${res.rows.length} sent=${sent} failed=${failed}`);
    return { processed: res.rows.length, sent, failed };
}

module.exports = { processBetReminders };
