"use strict";
const { Router } = require("express");
const rateLimit = require("express-rate-limit");
const { authMiddleware, requireAdmin } = require("../middleware/auth");
const { adminTestWhatsappValidation, adminWeeklyEmailValidation, adminWinnerImageValidation, adminRecalcMatchdayValidation, adminSendWelcomeValidation, adminTriggerWinnerValidation } = require("../middleware/validation");
const { sendWhatsApp } = require("../services/whatsapp");
const { sendSMS } = require("../services/sms");
const { db } = require("../db/connection");
const { sendWeeklyEmail } = require("../services/email");
const { runValidation } = require("../services/scoreValidator");
const { runConcurrent } = require("../services/concurrency");
const { runCutoffReminders } = require("../services/reminderCutoff");
const { sendEventBatch } = require("../services/engageClient");
const { buildEngageMetadata } = require("../utils/engageHelpers");
const { invalidatePrefix } = require("../services/cache");

const router = Router();

// Rate limiter para endpoints que disparan campañas de voz y emails masivos.
// Máximo 5 disparos por minuto por IP de admin — previene abuso con token comprometido.
const adminCampaignLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many admin campaign triggers, please slow down' },
});

// Rate limiter más estricto para operaciones que envían a toda la base de usuarios.
const adminBroadcastLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many broadcast operations, please wait before retrying' },
});

router.post('/test-sms', authMiddleware, requireAdmin, adminCampaignLimiter, async (req, res) => {
    try {
        const { to, message } = req.body;
        if (!to || !message) {
            return res.status(400).json({ success: false, error: 'to y message requeridos' });
        }
        const result = await sendSMS({ to, body: message });
        res.json({ success: true, message: `SMS enviado a ${to}`, data: result });
    } catch (error) {
        console.error('[admin] test-sms error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/test-whatsapp', authMiddleware, requireAdmin, adminCampaignLimiter, adminTestWhatsappValidation, async (req, res) => {
    try {
        const { to, message } = req.body;
        if (!to || !message) {
            return res.status(400).json({ success: false, error: 'to y message requeridos' });
        }
        await sendWhatsApp({ to, body: message });
        res.json({ success: true, message: `WhatsApp enviado a ${to}` });
    } catch (error) {
        console.error('[admin] test-whatsapp error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ── Weekly email batch ────────────────────────────────────────────────────────

async function sendWeeklyEmailBatch(testEmail = null) {
    const now = new Date();
    const weekDate = now.toLocaleDateString('es-AR', {
        timeZone: 'America/Argentina/Buenos_Aires',
        weekday: 'long', day: 'numeric', month: 'long',
    });
    const weekDateFormatted = weekDate.charAt(0).toUpperCase() + weekDate.slice(1);

    // Global queries en paralelo
    const [totalPlayersRes, top5Res, tightMatchRes, upcomingRes] = await Promise.all([
        db.query(`SELECT COUNT(*) as total FROM planillas WHERE precio_pagado = true`),
        db.query(`
            SELECT COALESCE(MIN(r.puntos_totales), 0) as threshold
            FROM (
                SELECT r.puntos_totales FROM ranking r
                JOIN planillas p ON p.id = r.planilla_id
                WHERE p.precio_pagado = true
                ORDER BY r.puntos_totales DESC LIMIT 5
            ) r
        `),
        db.query(`
            SELECT m.home_team, m.away_team, m.resultado_local, m.resultado_visitante,
                COUNT(*) FILTER (WHERE s.puntos_obtenidos >= 3) as exact_hits,
                COUNT(s.planilla_id) as total_bets
            FROM matches m
            JOIN scores s ON s.match_id = m.id
            WHERE m.estado = 'finished' AND m.start_time >= NOW() - INTERVAL '7 days'
            GROUP BY m.id, m.home_team, m.away_team, m.resultado_local, m.resultado_visitante
            HAVING COUNT(s.planilla_id) > 0
            ORDER BY COUNT(*) FILTER (WHERE s.puntos_obtenidos >= 3) ASC, COUNT(s.planilla_id) DESC
            LIMIT 1
        `),
        db.query(`
            SELECT home_team, away_team, start_time FROM matches
            WHERE estado = 'scheduled' AND time_cutoff > NOW()
            ORDER BY start_time ASC LIMIT 3
        `),
    ]);

    const totalPlayers = parseInt(totalPlayersRes.rows[0].total) || 0;
    const top5Threshold = parseInt(top5Res.rows[0]?.threshold) || 0;
    const tightMatch = tightMatchRes.rows[0] || null;
    const upcomingMatches = upcomingRes.rows;

    // Usuarios con su mejor planilla — incluye position ya calculada en ranking
    const usersParams = testEmail ? [testEmail] : [];
    const usersFilter = testEmail ? 'AND u.email = $1' : '';
    const usersRes = await db.query(`
        SELECT
            u.id as user_id, u.nombre, u.email, u.whatsapp_number,
            p.id as planilla_id,
            p.precio_pagado,
            COALESCE(r.puntos_totales, 0) as puntos_totales,
            COALESCE(r.position, 1) as ranking_position
        FROM users u
        JOIN planillas p ON p.user_id = u.id
        LEFT JOIN ranking r ON r.planilla_id = p.id
        WHERE u.email_verified = true ${usersFilter}
        ORDER BY u.id, COALESCE(r.puntos_totales, 0) DESC
    `, usersParams);

    const userMap = new Map();
    for (const row of usersRes.rows) {
        if (!userMap.has(row.user_id)) userMap.set(row.user_id, row);
    }
    if (userMap.size === 0) return { sent: 0, failed: 0, total: 0 };

    const planillaIds = [...userMap.values()].map(u => u.planilla_id);

    // Datos por planilla en 2 queries batch (reemplaza N×3 queries individuales)
    const [bestRoundsRes, pendingCountsRes] = await Promise.all([
        db.query(`
            SELECT DISTINCT ON (b.planilla_id)
                b.planilla_id, m.jornada, SUM(s.puntos_obtenidos) as pts
            FROM bets b
            JOIN matches m ON b.match_id = m.id
            JOIN scores s ON s.planilla_id = b.planilla_id AND s.match_id = b.match_id
            WHERE b.planilla_id = ANY($1)
                AND s.puntos_obtenidos IS NOT NULL AND m.jornada IS NOT NULL
            GROUP BY b.planilla_id, m.jornada
            ORDER BY b.planilla_id, pts DESC
        `, [planillaIds]),
        db.query(`
            WITH pending_matches AS (
                SELECT id FROM matches WHERE estado = 'scheduled' AND time_cutoff > NOW()
            )
            SELECT p.planilla_id, COUNT(pm.id) as pending
            FROM (SELECT UNNEST($1::uuid[]) as planilla_id) p
            CROSS JOIN pending_matches pm
            WHERE NOT EXISTS (
                SELECT 1 FROM bets b WHERE b.match_id = pm.id AND b.planilla_id = p.planilla_id
            )
            GROUP BY p.planilla_id
        `, [planillaIds]),
    ]);

    const bestRoundByPlanilla = {};
    for (const r of bestRoundsRes.rows) bestRoundByPlanilla[r.planilla_id] = r;
    const pendingByPlanilla = {};
    for (const r of pendingCountsRes.rows) pendingByPlanilla[r.planilla_id] = parseInt(r.pending) || 0;

    const appUrl = 'https://chicago.prodecaballito.com/apuestas';
    const unsubscribeUrl = process.env.FRONTEND_URL || 'https://chicago.prodecaballito.com';
    let sent = 0, failed = 0;

    if (process.env.ENGAGE_ENABLED === 'true') {
        const events = [...userMap.values()].map(userData => {
            const bestRound = bestRoundByPlanilla[userData.planilla_id];
            const pendingBets = pendingByPlanilla[userData.planilla_id] || 0;
            const diferenciaPuntos = Math.max(0, top5Threshold - userData.puntos_totales);
            return {
                type: 'prode.weekly_digest',
                userId: String(userData.user_id),
                idempotencyKey: `weekly_digest:${userData.user_id}:${weekDateFormatted.replace(/[\s,]/g, '_')}`,
                payload: {
                    business_context: {
                        week_date: weekDateFormatted,
                        ranking_position: userData.ranking_position,
                        total_players: totalPlayers,
                        points: userData.puntos_totales,
                        best_round: bestRound ? `Fecha ${bestRound.jornada}` : null,
                        best_round_points: bestRound ? parseInt(bestRound.pts) : 0,
                        diferencia_puntos: diferenciaPuntos,
                        pending_bets: pendingBets,
                        tight_match: tightMatch,
                        upcoming_matches: upcomingMatches,
                    },
                },
                metadata: buildEngageMetadata(userData, {
                    planilla_nombre: userData.nombre_planilla,
                    planilla_id: userData.planilla_id,
                    estado_pago: userData.precio_pagado,
                    ranking_position: userData.ranking_position,
                    puntos_totales: userData.puntos_totales,
                }),
            };
        });
        if (events.length > 0) {
            await sendEventBatch(events);
        }

        // Bonus: voice weekly summary (solo usuarios con teléfono)
        const leader = [...userMap.values()].reduce((best, u) => !best || u.puntos_totales > best.puntos_totales ? u : best, null);
        const voiceEvents = [...userMap.values()]
            .filter(u => u.whatsapp_number)
            .map(u => ({
                type: 'prode.voice_weekly_summary',
                userId: String(u.user_id),
                idempotencyKey: `voice_weekly:${u.user_id}:${weekDateFormatted.replace(/[\s,]/g, '_')}`,
                payload: {
                    business_context: {
                        template: 'Weekly Summary Prode',
                        week_date: weekDateFormatted,
                        leader_nombre: leader?.nombre,
                        leader_puntos: leader?.puntos_totales,
                        ranking_position: u.ranking_position,
                        total_players: totalPlayers,
                        pending_bets: pendingByPlanilla[u.planilla_id] || 0,
                    },
                },
                metadata: buildEngageMetadata(u, {
                    planilla_nombre: u.nombre_planilla,
                    planilla_id: u.planilla_id,
                    estado_pago: u.precio_pagado,
                    ranking_position: u.ranking_position,
                    puntos_totales: u.puntos_totales,
                }),
            }));
        if (voiceEvents.length > 0) {
            await sendEventBatch(voiceEvents).catch(e => console.error('[engage] voice_weekly_summary batch error:', e.message));
        }
        console.log(`[weekly] voice_weekly_summary queued for ${voiceEvents.length} users`);
        return { sent: events.length, failed: 0, total: userMap.size };
    }

    // Envío en paralelo (10 emails simultáneos)
    const results = await runConcurrent([...userMap.values()], async (userData) => {
        const bestRound = bestRoundByPlanilla[userData.planilla_id];
        const pendingBets = pendingByPlanilla[userData.planilla_id] || 0;
        const diferenciaPuntos = Math.max(0, top5Threshold - userData.puntos_totales);
        await sendWeeklyEmail(userData.email, {
            userName: userData.nombre,
            weekDate: weekDateFormatted,
            userPosition: userData.ranking_position,
            totalPlayers,
            userPoints: userData.puntos_totales,
            bestRound: bestRound ? `Fecha ${bestRound.jornada}` : '—',
            bestRoundPoints: bestRound ? parseInt(bestRound.pts) : 0,
            diferenciaPuntos,
            pendingBets,
            tightMatch,
            upcomingMatches,
            appUrl,
            unsubscribeUrl,
        });
    }, 10);

    for (const r of results) {
        if (r.status === 'fulfilled') sent++;
        else { failed++; console.error(`[weekly-email] Error:`, r.reason?.message); }
    }

    return { sent, failed, total: userMap.size };
}

// POST /api/admin/weekly-email
// Body opcional: { test_email: "..." } → envía solo a ese email (preview)
router.post('/weekly-email', authMiddleware, requireAdmin, adminCampaignLimiter, adminWeeklyEmailValidation, async (req, res) => {
    try {
        const testEmail = req.body.test_email || null;
        console.log(`[weekly-email] Starting batch${testEmail ? ` (test: ${testEmail})` : ''}`);
        const result = await sendWeeklyEmailBatch(testEmail);
        console.log(`[weekly-email] Done: sent=${result.sent} failed=${result.failed} total=${result.total}`);
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('[weekly-email] Batch error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/admin/voice-5day-trigger
// Body opcional:
//   - user_ids: string[]  → restringe a esos UUIDs (testing)
//   - dry_run: boolean    → no inserta reminder_sent ni publica a Engage; devuelve preview
router.post('/voice-5day-trigger', authMiddleware, requireAdmin, adminCampaignLimiter, async (req, res) => {
    try {
        const { user_ids: userIds, dry_run: dryRun } = req.body || {};
        if (userIds && !Array.isArray(userIds)) {
            return res.status(400).json({ success: false, error: 'user_ids debe ser array' });
        }
        const { runVoice5dayReminders } = require('../services/voice5dayReminder');
        const result = await runVoice5dayReminders({ userIds: userIds || null, dryRun: dryRun === true });
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('[admin] voice-5day-trigger error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/admin/winner-image
// Body: { image_url: "...", matchday_label: "Fecha 3", user_name: "...", points: 42 }
router.post('/winner-image', authMiddleware, requireAdmin, adminWinnerImageValidation, async (req, res) => {
    try {
        const { image_url, matchday_label, user_name, points } = req.body;
        if (!image_url) return res.status(400).json({ success: false, error: 'image_url requerida' });
        const entry = {
            image_url,
            ...(matchday_label && { matchday_label }),
            ...(user_name && { user_name }),
            ...(points != null && { points: Number(points) }),
            updated_at: new Date().toISOString(),
        };

        // Upsert single latest winner
        await db.query(`
            INSERT INTO config (key, value, updated_at, updated_by)
            VALUES ($1, $2, NOW(), $3)
            ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW(), updated_by = $3
        `, ['ganador_fecha', JSON.stringify(entry), req.user.userId]);

        // Append to winners array
        const existingRes = await db.query(`SELECT value FROM config WHERE key = 'ganadores_fechas'`);
        let winners = [];
        if (existingRes.rows.length > 0) {
            try { winners = JSON.parse(existingRes.rows[0].value) } catch {}
        }
        winners.push(entry);
        await db.query(`
            INSERT INTO config (key, value, updated_at, updated_by)
            VALUES ('ganadores_fechas', $1, NOW(), $2)
            ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW(), updated_by = $2
        `, [JSON.stringify(winners), req.user.userId]);

        res.json({ success: true });
    } catch (error) {
        console.error('[winner-image] Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ── JOBS — panel de procesos manuales ───────────────────────────────────────

router.post('/jobs/recalculate-ranking', authMiddleware, requireAdmin, async (req, res) => {
    try {
        const { actualizarRanking } = require('./matches');
        await actualizarRanking();
        res.json({ success: true, message: 'Ranking recalculado correctamente' });
    } catch (error) {
        console.error('[jobs/recalculate-ranking]', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/jobs/recalc-matchday', authMiddleware, requireAdmin, adminRecalcMatchdayValidation, async (req, res) => {
    try {
        const { matchday_id } = req.body;
        if (!matchday_id) return res.status(400).json({ success: false, error: 'matchday_id requerido' });
        const { recalcMatchday } = require('./matchdays');
        const result = await recalcMatchday(matchday_id);
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('[jobs/recalc-matchday]', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/jobs/send-welcome', authMiddleware, requireAdmin, adminCampaignLimiter, adminSendWelcomeValidation, async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ success: false, error: 'email requerido' });
        const { sendWelcomeEmail } = require('../services/email');
        const userRes = await db.query(`SELECT nombre FROM users WHERE email = $1`, [email]);
        if (userRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
        await sendWelcomeEmail(email, userRes.rows[0].nombre);
        res.json({ success: true });
    } catch (error) {
        console.error('[jobs/send-welcome]', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/jobs/trigger-winner', authMiddleware, requireAdmin, adminBroadcastLimiter, adminTriggerWinnerValidation, async (req, res) => {
    try {
        const { email, matchday_id, matchday_name, points } = req.body;
        if (!email) return res.status(400).json({ success: false, error: 'email requerido' });
        const userRes = await db.query(
            `SELECT id, nombre, foto_url, email FROM users WHERE email = $1`, [email]
        );
        if (userRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
        const user = userRes.rows[0];
        const allEmailsRes = await db.query(`SELECT email FROM users WHERE email IS NOT NULL`);
        const allEmails = allEmailsRes.rows.map(r => r.email);
        const winner = { user_id: user.id, user_name: user.nombre, user_avatar: user.foto_url || null, points: points || 42 };
        const matchday = { id: matchday_id || '00000000-0000-0000-0000-000000000001', name: matchday_name || 'Fecha de Prueba', tournament_id: null };
        const { processWinnerNotification } = require('./matchdays');
        await processWinnerNotification(winner, matchday, user.email, allEmails);
        res.json({ success: true, message: `Ganador procesado: ${user.nombre}` });
    } catch (error) {
        console.error('[jobs/trigger-winner]', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ── Score integrity validation ────────────────────────────────────────────────

router.get('/validate-scores', authMiddleware, requireAdmin, async (req, res) => {
    try {
        const { tournament_id } = req.query;

        const matchFilter = tournament_id
            ? `WHERE m.estado = 'finished' AND m.tournament_id = $1`
            : `WHERE m.estado = 'finished'`;
        const matchParams = tournament_id ? [tournament_id] : [];

        const matchesRes = await db.query(
            `SELECT id, resultado_local, resultado_visitante FROM matches ${matchFilter}`,
            matchParams
        );
        const finishedMatches = matchesRes.rows;

        if (finishedMatches.length === 0) {
            return res.json({
                success: true,
                data: {
                    scoreErrors: [], missingScores: [], rankingErrors: [],
                    summary: {
                        checked_matches: 0, checked_bets: 0, checked_rankings: 0,
                        score_errors: 0, missing_scores: 0, ranking_errors: 0, valid: true,
                    },
                },
            });
        }

        const matchIds = finishedMatches.map(m => m.id);
        const placeholders = matchIds.map((_, i) => `$${i + 1}`).join(',');

        const [betsRes, scoresRes, rankingsRes] = await Promise.all([
            db.query(
                `SELECT planilla_id, match_id, goles_local, goles_visitante FROM bets WHERE match_id IN (${placeholders})`,
                matchIds
            ),
            db.query(
                `SELECT planilla_id, match_id, puntos_obtenidos, bonus_aplicado FROM scores WHERE match_id IN (${placeholders})`,
                matchIds
            ),
            db.query(
                `SELECT r.planilla_id, r.puntos_totales, r.position,
                        r.aciertos_celeste, r.aciertos_rojo, r.aciertos_verde, r.aciertos_amarillo
                 FROM ranking r
                 JOIN planillas p ON p.id = r.planilla_id
                 WHERE p.precio_pagado = true`
            ),
        ]);

        const result = runValidation(finishedMatches, betsRes.rows, scoresRes.rows, rankingsRes.rows);
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('[admin/validate-scores]', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/jobs/cutoff-reminders', authMiddleware, requireAdmin, adminCampaignLimiter, async (req, res) => {
    try {
        const { dry_run = false, skip_window = false } = req.body || {};
        const result = await runCutoffReminders({ dryRun: dry_run, skipWindow: skip_window });
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('[admin/cutoff-reminders]', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/upcoming-cutoffs', authMiddleware, requireAdmin, async (req, res) => {
    try {
        const minutes = Math.min(parseInt(req.query.minutes) || 60, 1440);
        const result = await db.query(`
            SELECT id, home_team, away_team, estado, time_cutoff, start_time,
                   ROUND(EXTRACT(EPOCH FROM (time_cutoff - NOW())) / 60) AS min_until_cutoff
            FROM matches
            WHERE estado = 'scheduled'
              AND time_cutoff IS NOT NULL
              AND time_cutoff BETWEEN NOW() AND NOW() + ($1 || ' minutes')::INTERVAL
            ORDER BY time_cutoff ASC
        `, [minutes]);
        res.json({ success: true, data: result.rows, count: result.rows.length, window_minutes: minutes });
    } catch (error) {
        console.error('[admin/upcoming-cutoffs]', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/jobs/backfill-scheduled-jobs', authMiddleware, requireAdmin, async (req, res) => {
    try {
        const result = await db.query(`
            INSERT INTO scheduled_jobs (match_id, job_type, scheduled_for, status)
            SELECT id, 'kickoff', start_time, 'pending'
            FROM matches
            WHERE estado = 'scheduled' AND start_time > NOW()
            UNION ALL
            SELECT id, 'second_half',
                   start_time + INTERVAL '45 minutes' + (halftime_minutes || ' minutes')::INTERVAL,
                   'pending'
            FROM matches
            WHERE estado = 'scheduled' AND start_time > NOW()
            ON CONFLICT (match_id, job_type) DO NOTHING
            RETURNING match_id, job_type, scheduled_for
        `);
        console.log(`[admin/backfill] Inserted ${result.rows.length} scheduled_jobs rows`);
        res.json({ success: true, inserted: result.rows.length, jobs: result.rows });
    } catch (error) {
        console.error('[admin/backfill]', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Voice match reminder — disparo manual.
// Body: { user_ids?: uuid[], dry_run?: boolean (default true), skip_window?: boolean (testing only) }
router.post('/voice-match-reminder-trigger', authMiddleware, requireAdmin, adminCampaignLimiter, async (req, res) => {
    try {
        const { user_ids, dry_run = true, skip_window = false } = req.body;
        const userIds = Array.isArray(user_ids)
            ? user_ids.filter(id => /^[0-9a-f-]{36}$/i.test(id))
            : null;
        const { runVoiceMatchReminders } = require('../services/voiceMatchReminder');
        const result = await runVoiceMatchReminders({ userIds, dryRun: dry_run, skipWindow: skip_window });
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('[admin/voice-match-reminder]', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Voice survey campeón del mundial
router.post('/voice-campeon-survey', authMiddleware, requireAdmin, adminCampaignLimiter, async (req, res) => {
    try {
        const { user_ids, dry_run = true, options } = req.body;
        if (!dry_run && process.env.ENGAGE_ENABLED !== 'true') {
            return res.status(400).json({ success: false, error: 'ENGAGE_ENABLED=false — activar antes de disparar' });
        }

        const userIds = Array.isArray(user_ids)
            ? user_ids.filter(id => /^[0-9a-f-]{36}$/i.test(id))
            : null;

        const usersRes = await db.query(`
            SELECT u.id, u.nombre, u.email, u.whatsapp_number
            FROM users u
            WHERE u.whatsapp_number IS NOT NULL
              AND u.whatsapp_consent = true
              ${userIds ? 'AND u.id = ANY($1::uuid[])' : ''}
        `, userIds ? [userIds] : []);

        const preview = usersRes.rows.map(u => ({
            user: u.nombre, phone: u.whatsapp_number,
        }));

        if (dry_run) {
            return res.json({ success: true, data: { dry_run: true, users_to_call: usersRes.rows.length, preview } });
        }

        const surveyOptions = options || [
            { digit: '1', label: 'Argentina' },
            { digit: '2', label: 'Brasil' },
            { digit: '3', label: 'Francia' },
            { digit: '4', label: 'Otro' },
        ];

        const events = usersRes.rows.map(u => ({
            type: 'prode.voice_survey_campeon',
            userId: String(u.id),
            idempotencyKey: `voice_campeon:${u.id}:mundial2026`,
            payload: {
                business_context: {
                    template: 'Survey Campeon Mundial',
                    options: surveyOptions,
                },
            },
            metadata: {
                user_contact: {
                    nombre: u.nombre,
                    email: u.email,
                    phone: u.whatsapp_number,
                    idioma_pref: 'es-AR',
                },
            },
        }));

        const { sendEventBatch: sendBatch } = require('../services/engageClient');
        await sendBatch(events);
        res.json({ success: true, data: { users_notified: events.length } });
    } catch (error) {
        console.error('[admin/voice-campeon-survey]', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Live activity: llamadas activas y eventos recientes via Engage
router.get('/voice-campaigns/live', authMiddleware, requireAdmin, async (req, res) => {
    try {
        const baseUrl = process.env.ENGAGE_API_URL;
        const apiKey = process.env.ENGAGE_API_KEY;

        if (!baseUrl || !apiKey || process.env.ENGAGE_ENABLED !== 'true') {
            return res.json({ success: true, data: { active_calls: [], recent_events: [], engage_disabled: true } });
        }

        const axios = require('axios');
        const engageRes = await axios.get(`${baseUrl}/v1/campaigns/active`, {
            headers: { 'x-api-key': apiKey },
            timeout: 5000,
        }).catch(() => ({ data: { calls: [], events: [] } }));

        const data = engageRes.data || {};
        res.json({
            success: true,
            data: {
                active_calls: data.calls || [],
                recent_events: data.events || [],
                counters: data.counters || { initiated: 0, answered: 0, completed: 0, failed: 0 },
            },
        });
    } catch (error) {
        console.error('[admin/voice-campaigns/live]', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Engage verification: check event status + deliveries from Engage API
// GET  /api/admin/engage-verify/event/:eventId
// GET  /api/admin/engage-verify/user/:externalId
// GET  /api/admin/engage-verify/status
router.get('/engage-verify/status', authMiddleware, requireAdmin, async (req, res) => {
    try {
        const { getUsers } = require('../services/engageClient');
        const enabled = process.env.ENGAGE_ENABLED === 'true';
        const hasUrl = !!process.env.ENGAGE_API_URL;
        const hasKey = !!process.env.ENGAGE_API_KEY;

        if (!enabled || !hasUrl) {
            return res.json({ success: true, data: { engage_enabled: enabled, api_url_configured: hasUrl, api_key_configured: hasKey, users: null } });
        }

        const usersData = await getUsers({ limit: 5 }).catch(err => ({ error: err.message }));
        res.json({
            success: true,
            data: {
                engage_enabled: enabled,
                api_url_configured: hasUrl,
                api_key_configured: hasKey,
                api_url: process.env.ENGAGE_API_URL,
                users: usersData,
            },
        });
    } catch (error) {
        console.error('[admin/engage-verify/status]', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/engage-verify/event/:eventId', authMiddleware, requireAdmin, async (req, res) => {
    try {
        const { getEvent } = require('../services/engageClient');
        const event = await getEvent(req.params.eventId);
        res.json({ success: true, data: event });
    } catch (error) {
        const status = error.response?.status ?? 500;
        console.error(`[admin/engage-verify/event] ${req.params.eventId}:`, error.message);
        res.status(status).json({ success: false, error: error.message });
    }
});

router.get('/engage-verify/user/:externalId', authMiddleware, requireAdmin, async (req, res) => {
    try {
        const { getUserDeliveries } = require('../services/engageClient');
        const deliveries = await getUserDeliveries(req.params.externalId);
        res.json({ success: true, data: deliveries });
    } catch (error) {
        const status = error.response?.status ?? 500;
        console.error(`[admin/engage-verify/user] ${req.params.externalId}:`, error.message);
        res.status(status).json({ success: false, error: error.message });
    }
});

// GET /api/admin/engage-verify/recent — last N notifications sent by PC (local DB, no Engage call)
router.get('/engage-verify/recent', authMiddleware, requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 30, 100);
        const result = await db.query(`
            SELECT n.id, n.user_id, u.nombre, u.email, n.type, n.sent_at, n.status
            FROM notifications n
            JOIN users u ON u.id = n.user_id
            ORDER BY n.sent_at DESC
            LIMIT $1
        `, [limit]);
        res.json({ success: true, data: result.rows, count: result.rows.length });
    } catch (error) {
        console.error('[admin/engage-verify/recent]', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/admin/reset-reminder-sent — reset idempotency counters for testing
router.delete('/reset-reminder-sent', authMiddleware, requireAdmin, async (req, res) => {
    try {
        const { reminder_type } = req.query;
        const validTypes = ['voice_match_reminder', 'voice_5day_reminder', 'cutoff_30min', 'voice_campeon_survey'];

        if (reminder_type && !validTypes.includes(reminder_type)) {
            return res.status(400).json({
                success: false,
                error: `Tipo inválido. Válidos: ${validTypes.join(', ')}`,
            });
        }

        const result = reminder_type
            ? await db.query('DELETE FROM reminder_sent WHERE reminder_type = $1 RETURNING *', [reminder_type])
            : await db.query('DELETE FROM reminder_sent RETURNING *');

        console.log(`[admin/reset-reminder-sent] Deleted ${result.rowCount} rows (type=${reminder_type || 'ALL'})`);
        res.json({
            success: true,
            data: {
                deleted: result.rowCount,
                reminder_type: reminder_type || 'ALL',
            },
        });
    } catch (error) {
        console.error('[admin/reset-reminder-sent]', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/admin/jobs/reset-game — resetea resultados, scores, ganadas y ranking para re-testing
router.post('/jobs/reset-game', authMiddleware, requireAdmin, async (req, res) => {
    try {
        await db.query('BEGIN');
        await db.query('DELETE FROM scores');
        await db.query('DELETE FROM scores_by_matchday');
        await db.query(`
            UPDATE ranking
            SET puntos_totales = 0, exactos_count = 0, goles_favor = 0, goles_contra = 0,
                position = NULL, aciertos_celeste = 0, aciertos_rojo = 0,
                aciertos_verde = 0, aciertos_amarillo = 0
        `);
        await db.query(`
            UPDATE tournament_rankings
            SET puntos = 0, total_exactos = 0, total_aciertos = 0, posicion = NULL
        `);
        await db.query(`
            UPDATE matches
            SET resultado_local = NULL, resultado_visitante = NULL,
                estado = 'scheduled', finished = false
            WHERE estado IN ('finished', 'live', 'halftime', 'cancelled')
        `);
        await db.query(`UPDATE matchdays SET winner_announced_at = NULL`);
        await db.query(`DELETE FROM config WHERE key IN ('ganadores_fechas', 'ganador_fecha')`);
        await db.query('DELETE FROM reminder_sent');
        await db.query('COMMIT');

        invalidatePrefix('ranking:');
        invalidatePrefix('matches:');

        console.log('[jobs/reset-game] Game state reset');
        res.json({ success: true, message: 'Juego reseteado correctamente' });
    } catch (error) {
        await db.query('ROLLBACK').catch(() => {});
        console.error('[jobs/reset-game]', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
module.exports.sendWeeklyEmailBatch = sendWeeklyEmailBatch;
