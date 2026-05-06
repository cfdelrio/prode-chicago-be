"use strict";
const { Router } = require("express");
const { authMiddleware, requireAdmin } = require("../middleware/auth");
const { adminTestWhatsappValidation, adminWeeklyEmailValidation, adminWinnerImageValidation, adminRecalcMatchdayValidation, adminSendWelcomeValidation, adminTriggerWinnerValidation } = require("../middleware/validation");
const { sendWhatsApp } = require("../services/whatsapp");
const { db } = require("../db/connection");
const { sendWeeklyEmail } = require("../services/email");
const { runValidation } = require("../services/scoreValidator");
const { runConcurrent } = require("../services/concurrency");

const router = Router();

router.post('/test-whatsapp', authMiddleware, requireAdmin, adminTestWhatsappValidation, async (req, res) => {
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
            WHERE m.estado = 'finalizado' AND m.start_time >= NOW() - INTERVAL '7 days'
            GROUP BY m.id, m.home_team, m.away_team, m.resultado_local, m.resultado_visitante
            HAVING COUNT(s.planilla_id) > 0
            ORDER BY COUNT(*) FILTER (WHERE s.puntos_obtenidos >= 3) ASC, COUNT(s.planilla_id) DESC
            LIMIT 1
        `),
        db.query(`
            SELECT home_team, away_team, start_time FROM matches
            WHERE estado = 'pendiente' AND time_cutoff > NOW()
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
            u.id as user_id, u.nombre, u.email,
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
                SELECT id FROM matches WHERE estado = 'pendiente' AND time_cutoff > NOW()
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

    const appUrl = 'https://prodecaballito.com/apuestas';
    const unsubscribeUrl = 'https://prodecaballito.com';
    let sent = 0, failed = 0;

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
router.post('/weekly-email', authMiddleware, requireAdmin, adminWeeklyEmailValidation, async (req, res) => {
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

// POST /api/admin/winner-image
// Body: { image_url: "...", matchday_label: "Fecha 3" }
router.post('/winner-image', authMiddleware, requireAdmin, adminWinnerImageValidation, async (req, res) => {
    try {
        const { image_url, matchday_label } = req.body;
        if (!image_url) return res.status(400).json({ success: false, error: 'image_url requerida' });
        const entry = { image_url, matchday_label, updated_at: new Date().toISOString() };

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

router.post('/jobs/send-welcome', authMiddleware, requireAdmin, adminSendWelcomeValidation, async (req, res) => {
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

router.post('/jobs/trigger-winner', authMiddleware, requireAdmin, adminTriggerWinnerValidation, async (req, res) => {
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

// ── Tournament reset (admin only) ─────────────────────────────────────────────
// POST /api/admin/reset-tournament
// Borra todas las apuestas, planillas, ranking y resultados de partidos.
// Conserva users y la estructura de matches/tournaments.
router.post('/reset-tournament', authMiddleware, requireAdmin, async (req, res) => {
    try {
        console.log('[reset-tournament] Iniciando reset completo por:', req.user.userId);

        // Tablas con FK hacia planillas/matchdays — borrar en orden correcto
        const steps = [
            { table: 'scores_by_matchday', sql: 'DELETE FROM scores_by_matchday' },
            { table: 'matchday_reactions',  sql: 'DELETE FROM matchday_reactions' },
            { table: 'matchdays',           sql: 'DELETE FROM matchdays' },
            { table: 'scores',              sql: 'DELETE FROM scores' },
            { table: 'bets',                sql: 'DELETE FROM bets' },
            { table: 'ranking',             sql: 'DELETE FROM ranking' },
            { table: 'planillas',           sql: 'DELETE FROM planillas' },
            { table: 'notifications',       sql: `DELETE FROM notifications` },
        ];

        const counts = {};
        for (const step of steps) {
            try {
                const r = await db.query(step.sql);
                counts[step.table] = r.rowCount;
                console.log(`[reset-tournament] ${step.table}: ${r.rowCount} filas eliminadas`);
            } catch (e) {
                // La tabla puede no existir en algunos entornos — ignorar
                console.warn(`[reset-tournament] ${step.table} skip:`, e.message);
                counts[step.table] = 0;
            }
        }

        // Resetear resultados de partidos
        const matchReset = await db.query(`
            UPDATE matches
            SET resultado_local = NULL,
                resultado_visitante = NULL,
                estado = 'scheduled',
                finished = false
            WHERE estado != 'cancelled'
        `);
        counts['matches_reset'] = matchReset.rowCount;
        console.log(`[reset-tournament] matches reset: ${matchReset.rowCount}`);

        // Limpiar config de ganadores
        const configReset = await db.query(`
            DELETE FROM config WHERE key IN ('ganador_fecha', 'ganadores_fechas')
        `);
        counts['config_ganadores'] = configReset.rowCount;
        console.log(`[reset-tournament] config ganadores: ${configReset.rowCount}`);

        console.log('[reset-tournament] Reset completado:', counts);
        res.json({ success: true, data: counts });
    } catch (error) {
        console.error('[reset-tournament] Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
module.exports.sendWeeklyEmailBatch = sendWeeklyEmailBatch;
