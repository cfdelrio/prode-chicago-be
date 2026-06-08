"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const connection_1 = require("../db/connection");
const auth_1 = require("../middleware/auth");
const cache = require("../services/cache");
const router = (0, express_1.Router)();
router.get('/', async (req, res) => {
    try {
        const rows = await cache.getOrFetch('tournaments:active', async () => {
            const result = await connection_1.db.query(`
                SELECT t.*,
                       (SELECT COUNT(*)::int FROM matches WHERE tournament_id = t.id AND estado = 'finished') AS finished_count,
                       (SELECT MIN(start_time) FROM matches WHERE tournament_id = t.id) AS first_match_time
                FROM tournaments t
                WHERE t.is_active = true
                ORDER BY t.start_date ASC
            `);
            return result.rows;
        });
        res.json({ success: true, data: rows });
    }
    catch (error) {
        console.error('Get tournaments error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
// GET /tournaments/admin/all — todos los torneos (admin)
router.get('/admin/all', auth_1.authMiddleware, async (req, res) => {
    try {
        const result = await connection_1.db.query(`
            SELECT t.*,
                   (SELECT COUNT(*) FROM matches WHERE tournament_id = t.id)::int AS match_count,
                   (SELECT COUNT(*) FROM matches WHERE tournament_id = t.id AND estado = 'finished')::int AS finished_count,
                   (SELECT MIN(start_time) FROM matches WHERE tournament_id = t.id) AS first_match_time,
                   (SELECT MAX(start_time) FROM matches WHERE tournament_id = t.id) AS last_match_time
            FROM tournaments t
            ORDER BY t.start_date DESC
        `);
        res.json({ success: true, data: result.rows });
    }
    catch (error) {
        console.error('Get all tournaments error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await connection_1.db.query('SELECT * FROM tournaments WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Torneo no encontrado' });
        }
        res.json({
            success: true,
            data: result.rows[0],
        });
    }
    catch (error) {
        console.error('Get tournament error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.get('/:id/ranking', async (req, res) => {
    try {
        const { id } = req.params;
        // Ranking por planilla individual (no por usuario).
        // Si un usuario tiene 2 planillas, aparecen 2 filas separadas.
        const result = await connection_1.db.query(`SELECT tr.*, u.nombre AS user_name, u.foto_url AS user_avatar,
              p.nombre_planilla, p.precio_pagado
       FROM tournament_rankings tr
       JOIN users u ON tr.user_id = u.id
       JOIN planillas p ON tr.planilla_id = p.id
       WHERE tr.tournament_id = $1
       ORDER BY tr.puntos DESC, tr.total_exactos DESC, tr.total_aciertos DESC`, [id]);
        res.json({
            success: true,
            data: result.rows,
        });
    }
    catch (error) {
        console.error('Get tournament ranking error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.post('/', auth_1.authMiddleware, async (req, res) => {
    try {
        const { name, description, fase, start_date, end_date } = req.body;
        if (!name || !fase) {
            return res.status(400).json({ success: false, error: 'Nombre y fase son requeridos' });
        }
        const result = await connection_1.db.query(`INSERT INTO tournaments (name, description, fase, start_date, end_date) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING *`, [name, description, fase, start_date, end_date]);
        cache.invalidate('tournaments:active');
        res.status(201).json({ success: true, data: result.rows[0] });
    }
    catch (error) {
        console.error('Create tournament error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.put('/:id', auth_1.authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, fase, start_date, end_date, status, is_active } = req.body;
        const result = await connection_1.db.query(`UPDATE tournaments 
       SET name = COALESCE($1, name), 
           description = COALESCE($2, description), 
           fase = COALESCE($3, fase),
           start_date = COALESCE($4, start_date),
           end_date = COALESCE($5, end_date),
           status = COALESCE($6, status),
           is_active = COALESCE($7, is_active),
           updated_at = NOW()
       WHERE id = $8 
       RETURNING *`, [name, description, fase, start_date, end_date, status, is_active, id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Torneo no encontrado' });
        }
        cache.invalidate('tournaments:active');
        res.json({ success: true, data: result.rows[0] });
    }
    catch (error) {
        console.error('Update tournament error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.delete('/:id', auth_1.authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        await connection_1.db.query('UPDATE tournaments SET is_active = false WHERE id = $1', [id]);
        cache.invalidate('tournaments:active');
        res.json({ success: true, message: 'Torneo eliminado' });
    }
    catch (error) {
        console.error('Delete tournament error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
exports.default = router;
//# sourceMappingURL=tournaments.js.map
