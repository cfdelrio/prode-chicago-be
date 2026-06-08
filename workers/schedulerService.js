"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.schedulerService = void 0;
const connection_1 = require("../db/connection");
const notificationService_1 = require("./notificationService");
const { pushToUser } = require('../services/push');
const { sendSMSWithRetry } = require('../services/sms');
const { sendEvent } = require('../services/engageClient');
exports.schedulerService = {
    async scheduleMatchJobs(match) {
        console.log(`Scheduling jobs for match ${match.id}: ${match.home_team} vs ${match.away_team}`);
        const kickoffTime = new Date(match.start_time);
        const secondHalfTime = new Date(kickoffTime.getTime() + 45 * 60 * 1000 + match.halftime_minutes * 60 * 1000);
        await connection_1.db.query(`
      INSERT INTO scheduled_jobs (match_id, job_type, scheduled_for, status)
      VALUES ($1, 'kickoff', $2, 'pending'),
             ($1, 'second_half', $3, 'pending')
      ON CONFLICT (match_id, job_type) DO UPDATE SET
        scheduled_for = CASE 
          WHEN EXCLUDED.scheduled_for != scheduled_jobs.scheduled_for THEN EXCLUDED.scheduled_for
          ELSE scheduled_jobs.scheduled_for
        END,
        status = 'pending'
    `, [match.id, kickoffTime, secondHalfTime]);
        console.log(`Jobs scheduled for match ${match.id}`);
        console.log(`  Kickoff: ${kickoffTime.toISOString()}`);
        console.log(`  Second half: ${secondHalfTime.toISOString()}`);
    },
    async getPendingJobs() {
        const result = await connection_1.db.query(`
      SELECT sj.*, m.home_team, m.away_team, m.start_time, m.halftime_minutes, m.tournament_id
      FROM scheduled_jobs sj
      JOIN matches m ON sj.match_id = m.id
      WHERE sj.status = 'pending' AND sj.scheduled_for <= NOW()
      ORDER BY sj.scheduled_for ASC
      LIMIT 100
    `);
        return result.rows.map((row) => ({
            matchId: row.match_id,
            homeTeam: row.home_team,
            awayTeam: row.away_team,
            startTime: row.start_time,
            halftimeMinutes: row.halftime_minutes,
            tournamentId: row.tournament_id || null,
            type: row.job_type === 'kickoff' ? 'kickoff' : 'second_half',
        }));
    },
    async _sendPlanillaCierreEmails(tournamentId, firstMatchId) {
        const { sendEmail: _sendEmail, sendPlanillaCierreEmail } = require('../services/email');
        const tournamentRes = await connection_1.db.query(
            `SELECT name FROM tournaments WHERE id = $1`, [tournamentId]
        );
        if (tournamentRes.rows.length === 0) return;
        const torneoName = tournamentRes.rows[0].name;

        // Only fire for the earliest kickoff of this tournament (idempotency)
        const firstRes = await connection_1.db.query(
            `SELECT MIN(sj.scheduled_for) AS earliest
             FROM scheduled_jobs sj
             JOIN matches m ON m.id = sj.match_id
             WHERE m.tournament_id = $1 AND sj.job_type = 'kickoff'`,
            [tournamentId]
        );
        const earliestKickoffRes = await connection_1.db.query(
            `SELECT id FROM scheduled_jobs WHERE match_id = $1 AND job_type = 'kickoff'`, [firstMatchId]
        );
        // Check if this match is the first kickoff of the tournament
        const isFirstKickoff = await connection_1.db.query(
            `SELECT 1 FROM scheduled_jobs sj
             JOIN matches m ON m.id = sj.match_id
             WHERE m.tournament_id = $1 AND sj.job_type = 'kickoff'
               AND sj.scheduled_for < (SELECT scheduled_for FROM scheduled_jobs WHERE match_id = $2 AND job_type = 'kickoff')
             LIMIT 1`,
            [tournamentId, firstMatchId]
        );
        if (isFirstKickoff.rows.length > 0) return; // not the first kickoff

        // Get all planillas for this tournament
        const planillasRes = await connection_1.db.query(
            `SELECT p.id AS planilla_id, p.nombre_planilla, u.id AS user_id, u.nombre, u.email
             FROM planillas p
             JOIN users u ON u.id = p.user_id
             WHERE p.tournament_id = $1 AND u.email IS NOT NULL AND u.email != ''`,
            [tournamentId]
        );
        if (planillasRes.rows.length === 0) return;

        const matchesRes = await connection_1.db.query(
            `SELECT id, home_team, away_team, start_time FROM matches
             WHERE tournament_id = $1 ORDER BY start_time ASC`,
            [tournamentId]
        );
        const allMatches = matchesRes.rows;

        for (const pl of planillasRes.rows) {
            // Idempotency: skip if already sent
            const idempRes = await connection_1.db.query(
                `INSERT INTO reminder_sent (user_id, match_id, reminder_type)
                 VALUES ($1, $2, 'planilla_cierre')
                 ON CONFLICT (user_id, match_id, reminder_type) DO NOTHING
                 RETURNING user_id`,
                [pl.user_id, firstMatchId]
            ).catch(() => ({ rows: [] }));
            if (idempRes.rows.length === 0) continue;

            const betsRes = await connection_1.db.query(
                `SELECT b.match_id, b.goles_local, b.goles_visitante
                 FROM bets b
                 WHERE b.planilla_id = $1`,
                [pl.planilla_id]
            );
            const betMap = {};
            for (const b of betsRes.rows) betMap[b.match_id] = b;

            const matches = allMatches.map(m => ({
                home_team: m.home_team,
                away_team: m.away_team,
                goles_local: betMap[m.id]?.goles_local ?? null,
                goles_visitante: betMap[m.id]?.goles_visitante ?? null,
            }));

            if (process.env.ENGAGE_ENABLED === 'true') {
                await sendEvent({
                    type: 'prode.planilla_cierre',
                    userId: String(pl.user_id),
                    idempotencyKey: `planilla_cierre:${pl.user_id}:${firstMatchId}`,
                    payload: {
                        business_context: {
                            planilla_nombre: pl.nombre_planilla,
                            torneo_name: torneoName,
                            matches,
                        },
                    },
                    metadata: {
                        user_contact: {
                            nombre: pl.nombre,
                            email: pl.email,
                            idioma_pref: 'es-AR',
                        },
                    },
                }).catch(e => console.error(`[scheduler] engage planilla-cierre error user=${pl.user_id}:`, e.message));
            } else {
                await sendPlanillaCierreEmail({
                    userEmail: pl.email,
                    userName: pl.nombre,
                    planillaNombre: pl.nombre_planilla,
                    torneoName,
                    matches,
                }).catch(e => console.error(`[scheduler] planilla-cierre email error user=${pl.user_id}:`, e.message));
            }
        }
        console.log(`[scheduler] planilla-cierre emails sent for tournament=${tournamentId}`);

        // Enviar planilla general: todos los pronósticos de todos los participantes
        try {
            const { sendPlanillaGeneralEmail } = require('../services/email');
            const allBetsRes = await connection_1.db.query(
                `SELECT p.user_id, u.nombre, u.email, b.match_id, b.goles_local, b.goles_visitante
                 FROM planilla_tournaments pt
                 JOIN planillas p ON p.id = pt.planilla_id
                 JOIN users u ON u.id = p.user_id
                 LEFT JOIN bets b ON b.planilla_id = p.id AND b.match_id = ANY($2::uuid[])
                 WHERE pt.tournament_id = $1 AND u.email IS NOT NULL AND u.email != ''`,
                [tournamentId, allMatches.map(m => m.id)]
            );

            // Agrupa por usuario
            const userMap = {};
            for (const row of allBetsRes.rows) {
                if (!userMap[row.user_id]) {
                    userMap[row.user_id] = { userId: row.user_id, nombre: row.nombre, email: row.email, bets: {} };
                }
                if (row.match_id) {
                    userMap[row.user_id].bets[row.match_id] = { local: row.goles_local, visitante: row.goles_visitante };
                }
            }
            const betsByUser = Object.values(userMap);
            if (betsByUser.length === 0) return;

            for (const recipient of betsByUser) {
                const idempRes = await connection_1.db.query(
                    `INSERT INTO reminder_sent (user_id, match_id, reminder_type)
                     VALUES ($1, $2, 'planilla_general')
                     ON CONFLICT (user_id, match_id, reminder_type) DO NOTHING
                     RETURNING user_id`,
                    [recipient.userId, firstMatchId]
                ).catch(() => ({ rows: [] }));
                if (!idempRes.rows.length) continue;

                await sendPlanillaGeneralEmail({
                    userEmail: recipient.email,
                    userName: recipient.nombre,
                    torneoName,
                    matches: allMatches,
                    betsByUser,
                }).catch(e => console.error(`[scheduler] planilla-general email error user=${recipient.email}:`, e.message));
            }
            console.log(`[scheduler] planilla-general emails sent for tournament=${tournamentId} (${betsByUser.length} recipients)`);
        } catch (err) {
            console.error(`[scheduler] planilla-general error tournament=${tournamentId}:`, err.message);
        }
    },
    async markJobCompleted(matchId, jobType) {
        await connection_1.db.query(`
      UPDATE scheduled_jobs SET status = 'completed' 
      WHERE match_id = $1 AND job_type = $2
    `, [matchId, jobType]);
    },
    async processPendingJobs() {
        const jobs = await this.getPendingJobs();
        for (const job of jobs) {
            try {
                console.log(`Processing ${job.type} job for match ${job.matchId}`);
                // Notify all users who placed a bet on this match — include their prediction
                const betters = await connection_1.db.query(`
          SELECT u.id AS user_id, u.nombre, u.whatsapp_number, u.whatsapp_consent,
                 MIN(b.goles_local)     AS goles_local,
                 MIN(b.goles_visitante) AS goles_visitante
          FROM users u
          JOIN planillas p ON p.user_id = u.id
          JOIN bets b ON b.planilla_id = p.id AND b.match_id = $1
          GROUP BY u.id, u.nombre, u.whatsapp_number, u.whatsapp_consent
        `, [job.matchId]);
                const isKickoff = job.type === 'kickoff';
                for (const user of betters.rows) {
                    const hasBet = user.goles_local != null && user.goles_visitante != null;
                    const score = hasBet ? `${user.goles_local}-${user.goles_visitante}` : null;
                    const smsBody = hasBet
                        ? `${isKickoff ? '🟢 ¡Arrancó!' : '⏱️ ¡Segundo tiempo!'} ${job.homeTeam} vs ${job.awayTeam} — pronóstico: ${score} 👉 prodecaballito.com`
                        : `${isKickoff ? '🟢 ¡Arrancó!' : '⏱️ ¡Segundo tiempo!'} ${job.homeTeam} vs ${job.awayTeam} 👉 prodecaballito.com`;
                    const pushPayload = {
                        title: isKickoff
                            ? `🟢 ¡Arrancó! ${job.homeTeam} vs ${job.awayTeam}`
                            : `⏱️ ¡Segundo tiempo! ${job.homeTeam} vs ${job.awayTeam}`,
                        body: hasBet
                            ? (isKickoff ? `Tu pronóstico: ${score}. Que sea exacto 🎯` : `Tu pronóstico: ${score} — 45 min más.`)
                            : (isKickoff ? 'Seguí el partido en vivo.' : 'El segundo tiempo arrancó.'),
                        url: '/apuestas',
                        icon: '/favicon.svg',
                    };
                    // In-app notification
                    await (0, notificationService_1.generarNotificacionKickoff)(user.user_id, job.matchId, job.homeTeam, job.awayTeam, job.type, job.startTime)
                        .catch(err => console.error(`[scheduler] in-app failed user=${user.user_id}:`, err.message));
                    // Push notification
                    await pushToUser(user.user_id, pushPayload)
                        .catch(err => console.error(`[scheduler] push failed user=${user.user_id}:`, err.message));
                    // SMS if user consented (or via Engage)
                    if (process.env.ENGAGE_ENABLED === 'true') {
                        await sendEvent({
                            type: isKickoff ? 'prode.kickoff' : 'prode.second_half',
                            userId: String(user.user_id),
                            idempotencyKey: `${isKickoff ? 'kickoff' : 'second_half'}:${user.user_id}:${job.matchId}`,
                            payload: {
                                business_context: {
                                    match: { local: job.homeTeam, away: job.awayTeam },
                                    bet: hasBet ? { goles_local: user.goles_local, goles_visitante: user.goles_visitante } : null,
                                },
                            },
                            metadata: {
                                user_contact: {
                                    nombre: user.nombre,
                                    phone: user.whatsapp_number,
                                    whatsapp_consent: user.whatsapp_consent,
                                    idioma_pref: 'es-AR',
                                },
                            },
                        }).catch(err => console.error(`[scheduler] engage failed user=${user.user_id}:`, err.message));
                    } else if (user.whatsapp_number && user.whatsapp_consent) {
                        await sendSMSWithRetry({ to: user.whatsapp_number, body: smsBody })
                            .catch(err => console.error(`[scheduler] sms failed (after retries) user=${user.user_id}:`, err.message));
                    }
                }
                await this.markJobCompleted(job.matchId, job.type);
                console.log(`[scheduler] Completed ${job.type} job for match ${job.matchId}: ${betters.rows.length} users notified`);

                // On the first kickoff of a tournament, send planilla cierre email as receipt
                if (job.type === 'kickoff' && job.tournamentId) {
                    setImmediate(() => this._sendPlanillaCierreEmails(job.tournamentId, job.matchId).catch(e =>
                        console.error('[scheduler] planilla-cierre emails error:', e.message)
                    ));
                }
            }
            catch (error) {
                console.error(`Error processing job for match ${job.matchId}:`, error);
            }
        }
    },
};
//# sourceMappingURL=schedulerService.js.map