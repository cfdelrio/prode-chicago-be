"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const connection_1 = require("../db/connection");
const auth_1 = require("../middleware/auth");
const validation_1 = require("../middleware/validation");
const { sendPlanillaDeletedEmail } = require('../services/email');
const router = (0, express_1.Router)();

// ── Ensure locked column exists (auto-migrate) ──────────────────────────────
let _lockedColEnsured = false;
async function ensureLockedColumn() {
    if (_lockedColEnsured) return;
    await connection_1.db.query('ALTER TABLE planillas ADD COLUMN IF NOT EXISTS locked BOOLEAN DEFAULT false');
    _lockedColEnsured = true;
}

// ── planilla_tournaments: tabla N:N planilla ↔ torneo ─────────────────────────
let _ptTableEnsured = false;
async function ensurePlanillaTournamentsTable() {
    if (_ptTableEnsured) return;
    await connection_1.db.query(`
        CREATE TABLE IF NOT EXISTS planilla_tournaments (
            planilla_id   UUID NOT NULL REFERENCES planillas(id) ON DELETE CASCADE,
            tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
            created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
            PRIMARY KEY (planilla_id, tournament_id)
        )
    `);
    // Backfill: poblar desde apuestas existentes (idempotente)
    await connection_1.db.query(`
        INSERT INTO planilla_tournaments (planilla_id, tournament_id)
        SELECT DISTINCT b.planilla_id, m.tournament_id
        FROM bets b
        JOIN matches m ON b.match_id = m.id
        WHERE m.tournament_id IS NOT NULL
        ON CONFLICT DO NOTHING
    `);
    _ptTableEnsured = true;
}

router.get('/public/all', async (req, res) => {
    try {
        const result = await connection_1.db.query(`
      SELECT 
        p.id,
        p.nombre_planilla,
        u.nombre as user_name
      FROM planillas p
      JOIN users u ON p.user_id = u.id
      ORDER BY u.nombre, p.nombre_planilla
    `);
        res.json({ success: true, data: result.rows });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.get('/', auth_1.authMiddleware, async (req, res) => {
    try {
        await ensurePlanillaTournamentsTable();
        await ensureLockedColumn();
        const result = await connection_1.db.query(`
            SELECT p.*,
                COALESCE(SUM(s.puntos_obtenidos), 0) as puntos_totales,
                COUNT(s.id) FILTER (WHERE s.puntos_obtenidos >= 3) as exactos_count,
                COUNT(b.id) as total_bets,
                COALESCE(
                    ARRAY_AGG(pt.tournament_id) FILTER (WHERE pt.tournament_id IS NOT NULL),
                    '{}'
                ) as tournament_ids
            FROM planillas p
            LEFT JOIN scores s ON p.id = s.planilla_id
            LEFT JOIN bets b ON p.id = b.planilla_id
            LEFT JOIN planilla_tournaments pt ON p.id = pt.planilla_id
            WHERE p.user_id = $1
            GROUP BY p.id
            ORDER BY p.created_at DESC
        `, [req.user.userId]);
        res.json({ success: true, data: result.rows });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.post('/', auth_1.authMiddleware, async (req, res) => {
    try {
        await ensurePlanillaTournamentsTable();
        const { tournament_id } = req.body;
        const countResult = await connection_1.db.query('SELECT COUNT(*) FROM planillas WHERE user_id = $1', [req.user.userId]);
        const nombre_planilla = `Planilla ${parseInt(countResult.rows[0].count) + 1}`;
        const result = await connection_1.db.query(`INSERT INTO planillas (user_id, nombre_planilla)
       VALUES ($1, $2)
       RETURNING *`, [req.user.userId, nombre_planilla]);
        const planilla = result.rows[0];
        await connection_1.db.query(`INSERT INTO ranking (planilla_id, puntos_totales, exactos_count)
       VALUES ($1, 0, 0)`, [planilla.id]);
        // Asociar al torneo si se provee
        if (tournament_id) {
            await connection_1.db.query(`INSERT INTO planilla_tournaments (planilla_id, tournament_id)
               VALUES ($1, $2) ON CONFLICT DO NOTHING`, [planilla.id, tournament_id]);
        }
        // Devolver con tournament_ids para que el frontend actualice inmediatamente
        planilla.tournament_ids = tournament_id ? [tournament_id] : [];
        res.status(201).json({ success: true, data: planilla });
    }
    catch (error) {
        console.error('Create planilla error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.get('/:id', auth_1.authMiddleware, validation_1.uuidParam, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await connection_1.db.query(`SELECT p.*, 
        COALESCE(SUM(s.puntos_obtenidos), 0) as puntos_totales,
        COUNT(s.id) FILTER (WHERE s.puntos_obtenidos >= 3) as exactos_count
       FROM planillas p
       LEFT JOIN scores s ON p.id = s.planilla_id
       WHERE p.id = $1
       GROUP BY p.id`, [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Planilla no encontrada' });
        }
        if (result.rows[0].user_id !== req.user.userId && req.user.rol === 'usuario') {
            return res.status(403).json({ success: false, error: 'No tienes permisos' });
        }
        res.json({ success: true, data: result.rows[0] });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.put('/:id/lock', auth_1.authMiddleware, validation_1.uuidParam, async (req, res) => {
    try {
        await ensureLockedColumn();
        const { id } = req.params;
        const existing = await connection_1.db.query('SELECT user_id, locked FROM planillas WHERE id = $1', [id]);
        if (!existing.rows.length) return res.status(404).json({ success: false, error: 'Planilla no encontrada' });
        if (existing.rows[0].user_id !== req.user.userId)
            return res.status(403).json({ success: false, error: 'No tienes permisos' });
        if (existing.rows[0].locked)
            return res.status(400).json({ success: false, error: 'La planilla ya está cerrada' });
        // Verificar que todos los partidos pendientes tienen apuesta en esta planilla
        const pendingWithoutBet = await connection_1.db.query(`
            SELECT m.id
            FROM matches m
            WHERE m.estado != 'finished'
              AND NOT EXISTS (
                SELECT 1 FROM bets b
                WHERE b.match_id = m.id
                  AND b.planilla_id = $1
              )
        `, [id]);
        if (pendingWithoutBet.rows.length > 0) {
            return res.status(400).json({
                success: false,
                error: `Faltan ${pendingWithoutBet.rows.length} pronóstico${pendingWithoutBet.rows.length !== 1 ? 's' : ''} para cerrar la planilla`,
                missing: pendingWithoutBet.rows.length,
            });
        }
        const result = await connection_1.db.query('UPDATE planillas SET locked = true WHERE id = $1 RETURNING *', [id]);
        res.json({ success: true, data: result.rows[0] });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.put('/:id', auth_1.authMiddleware, validation_1.uuidParam, validation_1.planillaValidation, async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre_planilla } = req.body;
        const existingResult = await connection_1.db.query('SELECT user_id FROM planillas WHERE id = $1', [id]);
        if (existingResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Planilla no encontrada' });
        }
        if (existingResult.rows[0].user_id !== req.user.userId && req.user.rol === 'usuario') {
            return res.status(403).json({ success: false, error: 'No tienes permisos' });
        }
        const result = await connection_1.db.query(`UPDATE planillas SET nombre_planilla = $1 WHERE id = $2 RETURNING *`, [nombre_planilla, id]);
        res.json({ success: true, data: result.rows[0] });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.delete('/:id', auth_1.authMiddleware, validation_1.uuidParam, async (req, res) => {
    try {
        const { id } = req.params;
        const existingResult = await connection_1.db.query('SELECT user_id FROM planillas WHERE id = $1', [id]);
        if (existingResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Planilla no encontrada' });
        }
        if (existingResult.rows[0].user_id !== req.user.userId && req.user.rol === 'usuario') {
            return res.status(403).json({ success: false, error: 'No tienes permisos' });
        }
        const rankingRes = await connection_1.db.query('SELECT id FROM ranking WHERE planilla_id = $1', [id]);
        if (rankingRes.rows.length > 0) {
            const rankingIds = rankingRes.rows.map(r => r.id);
            await connection_1.db.query("DELETE FROM comments WHERE target_type = 'ranking' AND target_id = ANY($1::uuid[])", [rankingIds]);
        }
        await connection_1.db.query("DELETE FROM comments WHERE target_type = 'planilla' AND target_id = $1", [id]);
        await connection_1.db.query('DELETE FROM planillas WHERE id = $1', [id]);
        res.json({ success: true, message: 'Planilla eliminada' });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.get('/admin/all', auth_1.authMiddleware, auth_1.requireAdmin, async (req, res) => {
    try {
        await ensureLockedColumn();
        const result = await connection_1.db.query(`
      SELECT
        p.id,
        p.nombre_planilla,
        p.precio_pagado,
        p.locked,
        p.created_at,
        p.user_id,
        u.nombre as user_name,
        u.email as user_email,
        COALESCE(SUM(s.puntos_obtenidos), 0) as puntos_totales
      FROM planillas p
      JOIN users u ON p.user_id = u.id
      LEFT JOIN scores s ON p.id = s.planilla_id
      GROUP BY p.id, p.nombre_planilla, p.precio_pagado, p.locked, p.created_at, p.user_id, u.nombre, u.email
      ORDER BY p.created_at DESC
    `);
        res.json({ success: true, data: result.rows });
    }
    catch (error) {
        console.error('Error getting all planillas:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.put('/admin/:id', auth_1.authMiddleware, auth_1.requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre_planilla, precio_pagado, locked } = req.body;
        const result = await connection_1.db.query(`UPDATE planillas SET
        nombre_planilla = COALESCE($1, nombre_planilla),
        precio_pagado = COALESCE($2, precio_pagado),
        locked = COALESCE($3, locked)
       WHERE id = $4
       RETURNING *`, [nombre_planilla, precio_pagado, locked, id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Planilla no encontrada' });
        }
        res.json({ success: true, data: result.rows[0] });
    }
    catch (error) {
        console.error('Update planilla error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.delete('/admin/:id', auth_1.authMiddleware, auth_1.requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        // Fetch user data before deletion for email notification
        const planillaRes = await connection_1.db.query(
            `SELECT p.nombre_planilla, u.email AS user_email, u.nombre AS user_name
             FROM planillas p JOIN users u ON u.id = p.user_id
             WHERE p.id = $1`, [id]
        );
        const planillaData = planillaRes.rows[0] ?? null;
        const rankingRes = await connection_1.db.query('SELECT id FROM ranking WHERE planilla_id = $1', [id]);
        if (rankingRes.rows.length > 0) {
            const rankingIds = rankingRes.rows.map(r => r.id);
            await connection_1.db.query("DELETE FROM comments WHERE target_type = 'ranking' AND target_id = ANY($1::uuid[])", [rankingIds]);
        }
        await connection_1.db.query("DELETE FROM comments WHERE target_type = 'planilla' AND target_id = $1", [id]);
        await connection_1.db.query('DELETE FROM planillas WHERE id = $1', [id]);
        res.json({ success: true, message: 'Planilla eliminada' });
        // Fire-and-forget: email failure must not affect the response
        if (planillaData) {
            sendPlanillaDeletedEmail({
                userEmail: planillaData.user_email,
                userName: planillaData.user_name,
                planillaNombre: planillaData.nombre_planilla,
            }).catch(err => console.error('[planillas] email notification failed:', err));
        }
    }
    catch (error) {
        console.error('Delete planilla error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
exports.default = router;
//# sourceMappingURL=planillas.js.map