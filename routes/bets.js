"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const connection_1 = require("../db/connection");
const auth_1 = require("../middleware/auth");
const validation_1 = require("../middleware/validation");
const scoring_1 = require("../services/scoring");
const email_1 = require("../services/email");
const cache = require("../services/cache");
const router = (0, express_1.Router)();

let _lockedColEnsured = false;
async function ensureLockedColumn() {
    if (_lockedColEnsured) return;
    await connection_1.db.query('ALTER TABLE planillas ADD COLUMN IF NOT EXISTS locked BOOLEAN DEFAULT false');
    _lockedColEnsured = true;
}

async function getTournamentCutoff(tid) {
    return cache.getOrFetch(`tournament_cutoff:${tid}`, async () => {
        const r = await connection_1.db.query('SELECT MIN(start_time) as t FROM matches WHERE tournament_id = $1', [tid]);
        const t = r.rows[0] && r.rows[0].t;
        if (!t) return null;
        const c = await connection_1.db.query('SELECT value FROM config WHERE key = $1', ['tournament_cutoff_minutes_' + tid]);
        let m = 5;
        if (c.rows.length > 0) { const v = c.rows[0].value; m = Number(typeof v === 'string' ? JSON.parse(v) : v) || 5; }
        return new Date(new Date(t).getTime() - m * 60 * 1000);
    });
}
async function checkBetAllowed(match) {
    if (match.tournament_id) {
        const cutoff = await getTournamentCutoff(match.tournament_id);
        if (!cutoff) return {allowed:false,error:'No se pudo determinar el cierre del torneo'};
        if (new Date()>cutoff) return {allowed:false,error:'El tiempo para editar pronosticos del torneo ha finalizado'};
        return {allowed:true,error:null};
    }
    if (new Date()>new Date(match.time_cutoff)) return {allowed:false,error:'El tiempo para editar pronosticos ha finalizado'};
    return {allowed:true,error:null};
}

router.get('/planillas/:planillaId/bets', async (req, res) => {
    try {
        const { planillaId } = req.params;
        const result = await connection_1.db.query(`SELECT b.*, m.home_team, m.away_team, m.start_time, m.estado, m.resultado_local, m.resultado_visitante,
              s.puntos_obtenidos, s.bonus_aplicado,
              br.remind_minutes, br.scheduled_for
       FROM bets b
       JOIN matches m ON b.match_id = m.id
       LEFT JOIN scores s ON b.planilla_id = s.planilla_id AND b.match_id = s.match_id
       LEFT JOIN LATERAL (
         SELECT remind_minutes, scheduled_for
         FROM bet_reminders
         WHERE match_id = b.match_id AND planilla_id = b.planilla_id AND email_sent = false
         ORDER BY scheduled_for DESC LIMIT 1
       ) br ON true
       WHERE b.planilla_id = $1
       ORDER BY m.start_time ASC`, [planillaId]);
        res.json({ success: true, data: result.rows });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.get('/user/:userId/bets', async (req, res) => {
    try {
        const { userId } = req.params;
        const planillaResult = await connection_1.db.query('SELECT id FROM planillas WHERE user_id = $1', [userId]);
        if (planillaResult.rows.length === 0) {
            return res.json({ success: true, data: [] });
        }
        const planillaIds = planillaResult.rows.map(p => p.id);
        const result = await connection_1.db.query(`SELECT b.*, m.home_team, m.away_team, m.start_time, m.estado, m.resultado_local, m.resultado_visitante,
              s.puntos_obtenidos, s.bonus_aplicado
       FROM bets b
       JOIN matches m ON b.match_id = m.id
       LEFT JOIN scores s ON b.planilla_id = s.planilla_id AND b.match_id = s.match_id
       WHERE b.planilla_id = ANY($1)
       ORDER BY m.start_time ASC`, [planillaIds]);
        res.json({ success: true, data: result.rows });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.get('/match/:matchId/scores', async (req, res) => {
    try {
        const { matchId } = req.params;
        const result = await connection_1.db.query(`SELECT s.puntos_obtenidos, u.nombre as user_name, p.id as planilla_id
       FROM scores s
       JOIN planillas p ON s.planilla_id = p.id
       JOIN users u ON p.user_id = u.id
       WHERE s.match_id = $1 AND p.precio_pagado = true
       ORDER BY s.puntos_obtenidos DESC`, [matchId]);
        const maxPoints = result.rows.length > 0 ? result.rows[0].puntos_obtenidos : 0;
        res.json({
            success: true,
            data: {
                scores: result.rows,
                maxPoints
            }
        });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.get('/planillas/:planillaId/bets-old', auth_1.authMiddleware, validation_1.uuidParam, async (req, res) => {
    try {
        const { planillaId } = req.params;
        const planillaResult = await connection_1.db.query('SELECT user_id FROM planillas WHERE id = $1', [planillaId]);
        if (planillaResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Planilla no encontrada' });
        }
        if (planillaResult.rows[0].user_id !== req.user.userId && req.user.rol === 'usuario') {
            return res.status(403).json({ success: false, error: 'No tienes permisos' });
        }
        const result = await connection_1.db.query(`SELECT b.*, m.home_team, m.away_team, m.start_time, m.estado, m.resultado_local, m.resultado_visitante
       FROM bets b
       JOIN matches m ON b.match_id = m.id
       WHERE b.planilla_id = $1
       ORDER BY m.start_time ASC`, [planillaId]);
        res.json({ success: true, data: result.rows });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.post('/', auth_1.authMiddleware, validation_1.betValidation, async (req, res) => {
    try {
        await ensureLockedColumn();
        const { planilla_id, match_id, goles_local, goles_visitante } = req.body;
        const planillaResult = await connection_1.db.query('SELECT user_id, locked FROM planillas WHERE id = $1', [planilla_id]);
        if (planillaResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Planilla no encontrada' });
        }
        if (planillaResult.rows[0].user_id !== req.user.userId && req.user.rol === 'usuario') {
            return res.status(403).json({ success: false, error: 'No tienes permisos para esta planilla' });
        }
        if (planillaResult.rows[0].locked && req.user.rol !== 'admin') {
            return res.status(400).json({ success: false, error: 'La planilla ya fue cerrada y no se puede modificar' });
        }
        const matchResult = await connection_1.db.query('SELECT * FROM matches WHERE id = $1', [match_id]);
        if (matchResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Partido no encontrado' });
        }
        const match = matchResult.rows[0];
        if (req.user.rol !== 'admin') {
            const check = await checkBetAllowed(match);
            if (!check.allowed) {
                return res.status(400).json({ success: false, error: check.error });
            }
        }
        const existingBet = await connection_1.db.query('SELECT id FROM bets WHERE planilla_id = $1 AND match_id = $2', [planilla_id, match_id]);
        if (existingBet.rows.length > 0) {
            return res.status(400).json({ success: false, error: 'Ya existe un pronóstico para este partido' });
        }
        const result = await connection_1.db.query(`INSERT INTO bets (planilla_id, match_id, goles_local, goles_visitante)
       VALUES ($1, $2, $3, $4)
       RETURNING *`, [planilla_id, match_id, goles_local, goles_visitante]);
        await connection_1.db.query(`INSERT INTO audit_log (user_id, action, entity_type, entity_id, new_value, ip_address, user_agent) 
       VALUES ($1, 'bet_create', 'bets', $2, $3, $4, $5)`, [req.user.userId, result.rows[0].id, JSON.stringify(req.body), req.ip, req.headers['user-agent']]);
        res.status(201).json({ success: true, data: result.rows[0] });
    }
    catch (error) {
        console.error('Create bet error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.post('/score', auth_1.authMiddleware, validation_1.betScoreValidation, async (req, res) => {
    try {
        await ensureLockedColumn();
        const { planilla_id, match_id, score, remind_before_minutes } = req.body;
        const planillaResult = await connection_1.db.query('SELECT user_id, locked FROM planillas WHERE id = $1', [planilla_id]);
        if (planillaResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Planilla no encontrada' });
        }
        const planilla = planillaResult.rows[0];
        if (planilla.user_id !== req.user.userId && req.user.rol !== 'admin') {
            return res.status(403).json({ success: false, error: 'No tienes permisos' });
        }
        if (planilla.locked && req.user.rol !== 'admin') {
            return res.status(400).json({ success: false, error: 'La planilla ya fue cerrada y no se puede modificar' });
        }
        const matchResult = await connection_1.db.query('SELECT * FROM matches WHERE id = $1', [match_id]);
        if (matchResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Partido no encontrado' });
        }
        const match = matchResult.rows[0];
        if (req.user.rol !== 'admin') {
            const check = await checkBetAllowed(match);
            if (!check.allowed) {
                return res.status(400).json({ success: false, error: check.error });
            }
        }
        const [local, visitante] = score.split(/[-:]/).map(Number);
        const existingBet = await connection_1.db.query('SELECT id FROM bets WHERE planilla_id = $1 AND match_id = $2', [planilla_id, match_id]);
        let result;
        if (existingBet.rows.length > 0) {
            result = await connection_1.db.query(`UPDATE bets SET goles_local = $1, goles_visitante = $2, updated_at = NOW()
         WHERE id = $3 RETURNING *`, [local, visitante, existingBet.rows[0].id]);
        }
        else {
            result = await connection_1.db.query(`INSERT INTO bets (planilla_id, match_id, goles_local, goles_visitante)
         VALUES ($1, $2, $3, $4) RETURNING *`, [planilla_id, match_id, local, visitante]);
        }
        if (match.estado === 'finished') {
            const scoreResult = (0, scoring_1.calcularPuntaje)({ goles_local: local, goles_visitante: visitante }, { resultado_local: match.resultado_local, resultado_visitante: match.resultado_visitante });
            await connection_1.db.query(`INSERT INTO scores (planilla_id, match_id, puntos_obtenidos)
         VALUES ($1, $2, $3)
         ON CONFLICT (planilla_id, match_id) DO UPDATE SET puntos_obtenidos = $3`, [planilla_id, match_id, scoreResult.puntos]);
        }
        // Auto-asociar planilla ↔ torneo (relación N:N)
        if (match.tournament_id) {
            try {
                await connection_1.db.query(`
                    INSERT INTO planilla_tournaments (planilla_id, tournament_id)
                    VALUES ($1, $2) ON CONFLICT DO NOTHING
                `, [planilla_id, match.tournament_id]);
            } catch { /* silent: tabla puede no existir aún */ }
        }
        // Guardar recordatorio por email si el usuario lo solicitó
        if (remind_before_minutes != null && [5, 10, 15, 30, 60].includes(Number(remind_before_minutes))) {
            try {
                const scheduledFor = new Date(new Date(match.start_time).getTime() - Number(remind_before_minutes) * 60 * 1000);
                if (scheduledFor > new Date()) {
                    await connection_1.db.query(`
                        INSERT INTO bet_reminders (user_id, match_id, planilla_id, remind_minutes, scheduled_for)
                        VALUES ($1, $2, $3, $4, $5)
                        ON CONFLICT (user_id, match_id, planilla_id) DO UPDATE SET
                            remind_minutes = EXCLUDED.remind_minutes,
                            scheduled_for  = EXCLUDED.scheduled_for,
                            email_sent     = false,
                            sent_at        = NULL
                    `, [req.user.userId, match_id, planilla_id, remind_before_minutes, scheduledFor]);
                }
            } catch (reminderErr) {
                console.error('Error saving bet reminder:', reminderErr);
            }
        }
        res.json({ success: true, data: result.rows[0] });

        // Fire-and-forget: si completó todos los pronósticos del torneo, enviar confirmación
        if (match.tournament_id) {
            setImmediate(async () => {
                try {
                    const missingRes = await connection_1.db.query(
                        `SELECT COUNT(*) AS missing FROM matches m
                         LEFT JOIN bets b ON b.match_id = m.id AND b.planilla_id = $1
                         WHERE m.tournament_id = $2 AND m.estado = 'scheduled' AND b.id IS NULL`,
                        [planilla_id, match.tournament_id]
                    );
                    if (Number(missingRes.rows[0].missing) > 0) return;

                    const firstMatchRes = await connection_1.db.query(
                        `SELECT id FROM matches WHERE tournament_id = $1 ORDER BY start_time ASC LIMIT 1`,
                        [match.tournament_id]
                    );
                    if (!firstMatchRes.rows.length) return;
                    const firstMatchId = firstMatchRes.rows[0].id;

                    const idempRes = await connection_1.db.query(
                        `INSERT INTO reminder_sent (user_id, match_id, reminder_type)
                         VALUES ($1, $2, 'bet_confirmation')
                         ON CONFLICT (user_id, match_id, reminder_type) DO NOTHING
                         RETURNING user_id`,
                        [req.user.userId, firstMatchId]
                    );
                    if (!idempRes.rows.length) return;

                    const infoRes = await connection_1.db.query(
                        `SELECT u.email, u.nombre, p.nombre_planilla, t.name AS torneo_name
                         FROM planillas p
                         JOIN users u ON u.id = p.user_id
                         JOIN tournaments t ON t.id = $2
                         WHERE p.id = $1`,
                        [planilla_id, match.tournament_id]
                    );
                    if (!infoRes.rows.length) return;
                    const { email, nombre, nombre_planilla, torneo_name } = infoRes.rows[0];

                    const matchesRes = await connection_1.db.query(
                        `SELECT m.id, m.home_team, m.away_team, b.goles_local, b.goles_visitante
                         FROM matches m
                         LEFT JOIN bets b ON b.match_id = m.id AND b.planilla_id = $1
                         WHERE m.tournament_id = $2
                         ORDER BY m.start_time ASC`,
                        [planilla_id, match.tournament_id]
                    );

                    const { sendBetConfirmationEmail } = require('../services/email');
                    await sendBetConfirmationEmail({
                        userEmail: email,
                        userName: nombre,
                        planillaNombre: nombre_planilla,
                        torneoName: torneo_name,
                        matches: matchesRes.rows,
                    });
                } catch (err) {
                    console.error('[bets] bet-confirmation email error:', err.message);
                }
            });
        }
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.put('/:id', auth_1.authMiddleware, validation_1.uuidParam, async (req, res) => {
    try {
        await ensureLockedColumn();
        const { id } = req.params;
        const { goles_local, goles_visitante } = req.body;
        const betResult = await connection_1.db.query(`SELECT b.*, p.user_id, p.locked, m.time_cutoff, m.tournament_id
       FROM bets b
       JOIN planillas p ON b.planilla_id = p.id
       JOIN matches m ON b.match_id = m.id
       WHERE b.id = $1`, [id]);
        if (betResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Pronóstico no encontrado' });
        }
        const bet = betResult.rows[0];
        if (bet.user_id !== req.user.userId && req.user.rol === 'usuario') {
            return res.status(403).json({ success: false, error: 'No tienes permisos' });
        }
        if (bet.locked && req.user.rol !== 'admin') {
            return res.status(400).json({ success: false, error: 'La planilla ya fue cerrada y no se puede modificar' });
        }
        if (req.user.rol !== 'admin') {
            const check = await checkBetAllowed(bet);
            if (!check.allowed) {
                return res.status(400).json({ success: false, error: check.error });
            }
        }
        const result = await connection_1.db.query(`UPDATE bets SET goles_local = $1, goles_visitante = $2, updated_at = NOW()
       WHERE id = $3 RETURNING *`, [goles_local, goles_visitante, id]);
        await connection_1.db.query(`INSERT INTO audit_log (user_id, action, entity_type, entity_id, old_value, new_value, ip_address, user_agent) 
       VALUES ($1, 'bet_update', 'bets', $2, $3, $4, $5, $6)`, [req.user.userId, id, JSON.stringify({ goles_local: bet.goles_local, goles_visitante: bet.goles_visitante }), JSON.stringify(req.body), req.ip, req.headers['user-agent']]);
        res.json({ success: true, data: result.rows[0] });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.delete('/:id', auth_1.authMiddleware, validation_1.uuidParam, async (req, res) => {
    try {
        await ensureLockedColumn();
        const { id } = req.params;
        const betResult = await connection_1.db.query(`SELECT b.*, p.user_id, p.locked, m.time_cutoff, m.tournament_id
       FROM bets b
       JOIN planillas p ON b.planilla_id = p.id
       JOIN matches m ON b.match_id = m.id
       WHERE b.id = $1`, [id]);
        if (betResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Pronóstico no encontrado' });
        }
        const bet = betResult.rows[0];
        if (bet.user_id !== req.user.userId && req.user.rol === 'usuario') {
            return res.status(403).json({ success: false, error: 'No tienes permisos' });
        }
        if (bet.locked && req.user.rol !== 'admin') {
            return res.status(400).json({ success: false, error: 'La planilla ya fue cerrada y no se puede modificar' });
        }
        if (req.user.rol !== 'admin') {
            const check = await checkBetAllowed(bet);
            if (!check.allowed) {
                return res.status(400).json({ success: false, error: check.error });
            }
        }
        await connection_1.db.query('DELETE FROM bets WHERE id = $1', [id]);
        await connection_1.db.query(`INSERT INTO audit_log (user_id, action, entity_type, entity_id, ip_address, user_agent) 
       VALUES ($1, 'bet_delete', 'bets', $2, $3, $4)`, [req.user.userId, id, req.ip, req.headers['user-agent']]);
        res.json({ success: true, message: 'Pronóstico eliminado' });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
// Endpoint optimizado para la matriz - carga todas las apuestas de todas las planillas en 1 query
router.get('/all-for-matrix', async (req, res) => {
    try {
        const result = await connection_1.db.query(`
      SELECT
        b.planilla_id,
        b.match_id,
        b.goles_local,
        b.goles_visitante
      FROM bets b
      JOIN planillas p ON b.planilla_id = p.id
      ORDER BY b.planilla_id, b.match_id
    `);
        // Agrupar por planilla_id
        const betsByPlanilla = {};
        result.rows.forEach((bet) => {
            if (!betsByPlanilla[bet.planilla_id]) {
                betsByPlanilla[bet.planilla_id] = {};
            }
            betsByPlanilla[bet.planilla_id][bet.match_id] = {
                home: bet.goles_local,
                away: bet.goles_visitante
            };
        });
        res.json({
            success: true,
            data: betsByPlanilla,
            total_planillas: Object.keys(betsByPlanilla).length,
            total_bets: result.rows.length
        });
    }
    catch (error) {
        console.error('Get all bets for matrix error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
// Eliminar apuesta por planilla y match
router.delete('/planillas/:planillaId/matches/:matchId', auth_1.authMiddleware, async (req, res) => {
    try {
        await ensureLockedColumn();
        const { planillaId, matchId } = req.params;
        // Verificar que la planilla existe y pertenece al usuario
        const planillaResult = await connection_1.db.query('SELECT user_id, locked FROM planillas WHERE id = $1', [planillaId]);
        if (planillaResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Planilla no encontrada' });
        }
        const planilla = planillaResult.rows[0];
        // Solo el dueño o admin puede eliminar
        if (planilla.user_id !== req.user.userId && req.user.rol === 'usuario') {
            return res.status(403).json({ success: false, error: 'No tienes permisos para eliminar este pronóstico' });
        }
        if (planilla.locked && req.user.rol !== 'admin') {
            return res.status(400).json({ success: false, error: 'La planilla ya fue cerrada y no se puede modificar' });
        }
        // Verificar que el cierre del torneo (5min antes del primer partido) no haya pasado
        const matchResult = await connection_1.db.query('SELECT time_cutoff, tournament_id FROM matches WHERE id = $1', [matchId]);
        if (matchResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Partido no encontrado' });
        }
        const match = matchResult.rows[0];
        if (req.user.rol !== 'admin') {
            const check = await checkBetAllowed(match);
            if (!check.allowed) {
                return res.status(400).json({
                    success: false,
                    error: 'No puedes eliminar pronósticos después del cierre'
                });
            }
        }
        // Eliminar la apuesta
        const deleteResult = await connection_1.db.query('DELETE FROM bets WHERE planilla_id = $1 AND match_id = $2 RETURNING id', [planillaId, matchId]);
        if (deleteResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Pronóstico no encontrado' });
        }
        // Audit log
        await connection_1.db.query(`INSERT INTO audit_log (user_id, action, entity_type, entity_id, ip_address, user_agent) 
       VALUES ($1, 'bet_delete', 'bets', $2, $3, $4)`, [req.user.userId, deleteResult.rows[0].id, req.ip, req.headers['user-agent']]);
        res.json({ success: true, message: 'Pronóstico eliminado correctamente' });
    }
    catch (error) {
        console.error('Delete bet error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
// ── Solicitudes de desbloqueo de apuestas ajenas ──────────────────────────

async function ensureUnlockRequestsTable() {
    await connection_1.db.query(`
        CREATE TABLE IF NOT EXISTS unlock_requests (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            requester_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            target_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
            status VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected')),
            admin_id UUID REFERENCES users(id),
            created_at TIMESTAMP DEFAULT NOW(),
            resolved_at TIMESTAMP,
            UNIQUE(requester_user_id, target_user_id, match_id)
        )
    `);
    // Migración: columnas de pago (seguras si ya existen)
    await connection_1.db.query(`
        ALTER TABLE unlock_requests ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(200);
        ALTER TABLE unlock_requests ADD COLUMN IF NOT EXISTS payment_amount DECIMAL(10,2);
    `).catch(() => {});
}

// GET /bets/unlock-price — devuelve el precio configurado para desbloquear apuestas
router.get('/unlock-price', async (req, res) => {
    const price = Number(process.env.UNLOCK_PRICE_ARS || 0);
    const paymentLink = process.env.MP_PAYMENT_LINK || '';
    res.json({
        success: true,
        data: { price, currency: 'ARS', payment_link: paymentLink, free: price === 0 },
    });
});

// GET /bets/my-unlocks — devuelve solicitudes pending y approved del usuario
router.get('/my-unlocks', auth_1.authMiddleware, async (req, res) => {
    try {
        await ensureUnlockRequestsTable();
        const result = await connection_1.db.query(`
            SELECT target_user_id, match_id, status
            FROM unlock_requests
            WHERE requester_user_id = $1 AND status IN ('pending', 'approved')
        `, [req.user.userId]);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('Get unlocks error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

// POST /bets/request-unlock — solicita ver la apuesta de otro jugador (requiere aprobación admin)
router.post('/request-unlock', auth_1.authMiddleware, async (req, res) => {
    try {
        const { target_user_id, match_id, payment_reference } = req.body;
        if (!target_user_id || !match_id) {
            return res.status(400).json({ success: false, error: 'target_user_id y match_id son requeridos' });
        }
        if (target_user_id === req.user.userId) {
            return res.status(400).json({ success: false, error: 'No podés solicitarte a vos mismo' });
        }

        await ensureUnlockRequestsTable();

        const configuredPrice = Number(process.env.UNLOCK_PRICE_ARS || 0);
        const paymentRef = payment_reference ? String(payment_reference).trim().substring(0, 200) : null;

        // Verificar si ya existe una solicitud
        const existing = await connection_1.db.query(`
            SELECT id, status FROM unlock_requests
            WHERE requester_user_id = $1 AND target_user_id = $2 AND match_id = $3
        `, [req.user.userId, target_user_id, match_id]);

        if (existing.rows.length > 0) {
            const st = existing.rows[0].status;
            if (st === 'approved') return res.json({ success: true, status: 'approved', message: 'Ya fue aprobada' });
            if (st === 'pending')  return res.json({ success: true, status: 'pending', message: 'Solicitud ya enviada, pendiente de aprobación' });
            // rejected → permite re-solicitar
            await connection_1.db.query(`
                UPDATE unlock_requests
                SET status = 'pending', admin_id = NULL, resolved_at = NULL, created_at = NOW(),
                    payment_reference = $2, payment_amount = $3
                WHERE id = $1
            `, [existing.rows[0].id, paymentRef, configuredPrice > 0 ? configuredPrice : null]);
        } else {
            await connection_1.db.query(`
                INSERT INTO unlock_requests (requester_user_id, target_user_id, match_id, payment_reference, payment_amount)
                VALUES ($1, $2, $3, $4, $5)
            `, [req.user.userId, target_user_id, match_id, paymentRef, configuredPrice > 0 ? configuredPrice : null]);
        }

        // Obtener datos para el email (incluyendo la apuesta del target)
        const [requesterRes, targetRes, matchRes, adminsRes, betRes] = await Promise.all([
            connection_1.db.query('SELECT nombre, email FROM users WHERE id = $1', [req.user.userId]),
            connection_1.db.query('SELECT nombre FROM users WHERE id = $1', [target_user_id]),
            connection_1.db.query('SELECT home_team, away_team, start_time FROM matches WHERE id = $1', [match_id]),
            connection_1.db.query("SELECT email, nombre FROM users WHERE rol = 'admin'"),
            connection_1.db.query(`
                SELECT b.goles_local, b.goles_visitante
                FROM bets b
                JOIN planillas p ON b.planilla_id = p.id
                WHERE p.user_id = $1 AND b.match_id = $2
                LIMIT 1
            `, [target_user_id, match_id]),
        ]);

        const requesterName = requesterRes.rows[0]?.nombre || 'Un usuario';
        const targetName    = targetRes.rows[0]?.nombre    || 'otro jugador';
        const matchRow      = matchRes.rows[0];
        const matchLabel    = matchRow ? `${matchRow.home_team} vs ${matchRow.away_team}` : 'un partido';
        const adminPanelUrl = 'https://prodecaballito.com/admin';
        const betRow        = betRes.rows[0];
        const betDisplay    = betRow
            ? `<strong style="font-size:28px;color:#0042A5">${betRow.goles_local} - ${betRow.goles_visitante}</strong>`
            : '<em style="color:#9CA3AF">Sin apuesta cargada</em>';
        const homeTeam      = matchRow?.home_team || 'Local';
        const awayTeam      = matchRow?.away_team || 'Visitante';

        const paymentSection = configuredPrice > 0
            ? `<div style="background:${paymentRef ? '#F0FDF4' : '#FEF9C3'};border:2px solid ${paymentRef ? '#16A34A' : '#CA8A04'};padding:16px;margin:20px 0;border-radius:10px">
                <p style="margin:0 0 6px 0;color:#374151;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px">
                  💳 Info de pago (precio: $${configuredPrice} ARS)
                </p>
                ${paymentRef
                    ? `<p style="margin:0;font-size:15px;color:#166534"><strong>Comprobante:</strong> ${paymentRef}</p>
                       <p style="margin:6px 0 0;font-size:12px;color:#16A34A;font-weight:600">✅ El usuario declaró haber pagado — verificá el comprobante antes de aprobar</p>`
                    : `<p style="margin:0;font-size:13px;color:#92400E">⚠️ El usuario NO ingresó referencia de pago</p>`
                }
              </div>`
            : '';

        const emailHtml = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#f3f4f6">
  <div style="max-width:600px;margin:0 auto;padding:20px">
    <div style="background:linear-gradient(135deg,#0042A5,#001A4B);padding:30px;text-align:center;border-radius:12px 12px 0 0">
      <h1 style="color:white;margin:0;font-size:24px">⚽ PRODE Caballito</h1>
    </div>
    <div style="background:white;padding:30px;border-radius:0 0 12px 12px;box-shadow:0 4px 6px rgba(0,0,0,.1)">
      <h2 style="color:#1F2937;margin-top:0">🔓 Nueva solicitud de desbloqueo</h2>
      <p style="color:#4B5563;font-size:15px;line-height:1.7">
        <strong>${requesterName}</strong> quiere ver la apuesta de <strong>${targetName}</strong>
        en el partido <strong>${matchLabel}</strong>.
      </p>

      ${paymentSection}

      <!-- Apuesta del jugador -->
      <div style="background:#F0F4FF;border:2px solid #0042A5;padding:20px;margin:20px 0;border-radius:10px;text-align:center">
        <p style="margin:0 0 8px 0;color:#6B7280;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">
          Apuesta de ${targetName}
        </p>
        <p style="margin:0 0 4px 0;color:#374151;font-size:13px">${homeTeam} vs ${awayTeam}</p>
        <div style="margin-top:12px">${betDisplay}</div>
      </div>

      <div style="background:#F9FAFB;border-left:4px solid #0042A5;padding:16px;margin:20px 0;border-radius:6px">
        <p style="margin:0;color:#374151;font-size:14px">
          <strong>Solicitante:</strong> ${requesterName}<br>
          <strong>Apuesta de:</strong> ${targetName}<br>
          <strong>Partido:</strong> ${matchLabel}
        </p>
      </div>
      <p style="color:#4B5563;font-size:14px">Ingresá al panel de administración para aprobar o rechazar la solicitud:</p>
      <div style="text-align:center;margin:25px 0">
        <a href="${adminPanelUrl}"
           style="display:inline-block;background:linear-gradient(135deg,#0042A5,#001A4B);color:white;text-decoration:none;
                  padding:14px 32px;border-radius:50px;font-size:16px;font-weight:700">
          Ver solicitudes pendientes →
        </a>
      </div>
      <p style="color:#9CA3AF;font-size:12px;text-align:center;margin-top:20px">
        © 2026 PRODE Caballito — Este es un email automático
      </p>
    </div>
  </div>
</body>
</html>`;

        // Enviar email a todos los admins
        for (const admin of adminsRes.rows) {
            await email_1.sendEmail({
                to: admin.email,
                subject: `🔓 Solicitud de desbloqueo — ${requesterName} quiere ver apuesta de ${targetName}`,
                html: emailHtml,
            }).catch(err => console.error('Email send error:', err));
        }

        res.json({ success: true, status: 'pending', message: 'Solicitud enviada. Los administradores la revisarán pronto.' });
    } catch (error) {
        console.error('Request unlock error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

// GET /bets/unlock-requests — lista solicitudes pendientes (solo admin)
router.get('/unlock-requests', auth_1.authMiddleware, async (req, res) => {
    try {
        if (req.user.rol !== 'admin') {
            return res.status(403).json({ success: false, error: 'Solo administradores' });
        }
        await ensureUnlockRequestsTable();
        const result = await connection_1.db.query(`
            SELECT
                ur.id, ur.status, ur.created_at, ur.resolved_at,
                ur.requester_user_id, ur.target_user_id, ur.match_id,
                ur.payment_reference, ur.payment_amount,
                ru.nombre  AS requester_name,
                ru.email   AS requester_email,
                tu.nombre  AS target_name,
                m.home_team, m.away_team, m.start_time
            FROM unlock_requests ur
            JOIN users ru ON ur.requester_user_id = ru.id
            JOIN users tu ON ur.target_user_id    = tu.id
            JOIN matches m ON ur.match_id = m.id
            ORDER BY
                CASE ur.status WHEN 'pending' THEN 0 ELSE 1 END,
                ur.created_at DESC
            LIMIT 100
        `);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('Get unlock requests error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

// PUT /bets/unlock-requests/:id/approve — aprueba solicitud (solo admin)
router.put('/unlock-requests/:id/approve', auth_1.authMiddleware, async (req, res) => {
    try {
        if (req.user.rol !== 'admin') {
            return res.status(403).json({ success: false, error: 'Solo administradores' });
        }
        const { id } = req.params;
        const result = await connection_1.db.query(`
            UPDATE unlock_requests
            SET status = 'approved', admin_id = $1, resolved_at = NOW()
            WHERE id = $2 AND status = 'pending'
            RETURNING *, (SELECT nombre FROM users WHERE id = requester_user_id) AS requester_name,
                         (SELECT email  FROM users WHERE id = requester_user_id) AS requester_email,
                         (SELECT nombre FROM users WHERE id = target_user_id)    AS target_name,
                         (SELECT home_team || ' vs ' || away_team FROM matches WHERE id = match_id) AS match_label
        `, [req.user.userId, id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Solicitud no encontrada o ya resuelta' });
        }

        const r = result.rows[0];

        // Notificar al solicitante por email (best effort)
        const notifyHtml = `
<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#f3f4f6">
  <div style="max-width:600px;margin:0 auto;padding:20px">
    <div style="background:linear-gradient(135deg,#0042A5,#001A4B);padding:30px;text-align:center;border-radius:12px 12px 0 0">
      <h1 style="color:white;margin:0">⚽ PRODE Caballito</h1>
    </div>
    <div style="background:white;padding:30px;border-radius:0 0 12px 12px">
      <h2 style="color:#166534">✅ Tu solicitud fue aprobada</h2>
      <p style="color:#4B5563;font-size:15px;line-height:1.7">
        ¡Hola <strong>${r.requester_name}</strong>!
        Un administrador aprobó tu solicitud para ver la apuesta de <strong>${r.target_name}</strong>
        en el partido <strong>${r.match_label}</strong>.
      </p>
      <div style="text-align:center;margin:25px 0">
        <a href="https://prodecaballito.com/matriz"
           style="display:inline-block;background:linear-gradient(135deg,#0042A5,#001A4B);color:white;
                  text-decoration:none;padding:14px 32px;border-radius:50px;font-size:16px;font-weight:700">
          Ver la Matriz →
        </a>
      </div>
    </div>
  </div>
</body></html>`;

        await email_1.sendEmail({
            to: r.requester_email,
            subject: `✅ Solicitud aprobada — podés ver la apuesta de ${r.target_name}`,
            html: notifyHtml,
        }).catch(err => console.error('Notify email error:', err));

        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Approve unlock error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

// PUT /bets/unlock-requests/:id/reject — rechaza solicitud (solo admin)
router.put('/unlock-requests/:id/reject', auth_1.authMiddleware, async (req, res) => {
    try {
        if (req.user.rol !== 'admin') {
            return res.status(403).json({ success: false, error: 'Solo administradores' });
        }
        const { id } = req.params;
        const result = await connection_1.db.query(`
            UPDATE unlock_requests
            SET status = 'rejected', admin_id = $1, resolved_at = NOW()
            WHERE id = $2 AND status = 'pending'
            RETURNING id
        `, [req.user.userId, id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Solicitud no encontrada o ya resuelta' });
        }
        res.json({ success: true, message: 'Solicitud rechazada' });
    } catch (error) {
        console.error('Reject unlock error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

exports.default = router;
//# sourceMappingURL=bets.js.map