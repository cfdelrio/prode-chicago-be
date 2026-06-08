"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const connection_1 = require("../db/connection");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
router.get('/', auth_1.authMiddleware, async (req, res) => {
    try {
        const userId = req.user.userId;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const result = await connection_1.db.query(`SELECT * FROM notifications 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT $2 OFFSET $3`, [userId, limit, offset]);
        await connection_1.db.query(`UPDATE notifications SET status = 'read' 
       WHERE user_id = $1 AND status = 'sent'`, [userId]);
        res.json({
            success: true,
            data: {
                notifications: result.rows,
                pagination: { page, limit },
            },
        });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.post('/', auth_1.authMiddleware, async (req, res) => {
    try {
        const { match_id, type, payload } = req.body;
        const result = await connection_1.db.query(`INSERT INTO notifications (user_id, match_id, type, payload)
       VALUES ($1, $2, $3, $4)
       RETURNING *`, [req.user.userId, match_id, type, JSON.stringify(payload || {})]);
        res.status(201).json({ success: true, data: result.rows[0] });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.post('/send', auth_1.authMiddleware, auth_1.requireAdmin, async (req, res) => {
    try {
        const { user_id, match_id, type, payload } = req.body;
        const result = await connection_1.db.query(`INSERT INTO notifications (user_id, match_id, type, payload, status, sent_at)
       VALUES ($1, $2, $3, $4, 'sent', NOW())
       RETURNING *`, [user_id, match_id, type, JSON.stringify(payload || {})]);
        console.log(`Notification sent: ${type} to user ${user_id}`);
        res.json({ success: true, data: result.rows[0] });
    }
    catch (error) {
        console.error('Send notification error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.get('/unread-count', async (req, res) => {
    try {
        const userId = req.query.userId;
        if (!userId) {
            return res.status(400).json({ success: false, error: 'userId requerido' });
        }
        const result = await connection_1.db.query(`SELECT COUNT(*) as count FROM notifications 
       WHERE user_id = $1 AND status = 'sent'`, [userId]);
        res.json({ success: true, data: { count: parseInt(result.rows[0].count) } });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.get('/unread-count-auth', auth_1.authMiddleware, async (req, res) => {
    try {
        const result = await connection_1.db.query(`SELECT COUNT(*) as count FROM notifications
       WHERE user_id = $1 AND status = 'sent'`, [req.user.userId]);
        res.json({ success: true, data: { count: parseInt(result.rows[0].count) } });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.put('/:id', auth_1.authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        const userId = req.user.userId;

        const validStatuses = ['sent', 'read', 'deleted'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ success: false, error: 'Status inválido' });
        }

        const result = await connection_1.db.query(
            `UPDATE notifications SET status = $1 WHERE id = $2 AND user_id = $3 RETURNING *`,
            [status, id, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Notificación no encontrada' });
        }

        res.json({ success: true, data: result.rows[0] });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.delete('/:id', auth_1.authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.userId;

        const result = await connection_1.db.query(
            `DELETE FROM notifications WHERE id = $1 AND user_id = $2 RETURNING id`,
            [id, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Notificación no encontrada' });
        }

        res.json({ success: true, message: 'Notificación eliminada' });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
exports.default = router;
//# sourceMappingURL=notifications.js.map