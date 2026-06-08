"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const connection_1 = require("../db/connection");
const auth_1 = require("../middleware/auth");
const validation_1 = require("../middleware/validation");
const config_1 = require("../config");
const router = (0, express_1.Router)();
router.get('/users', auth_1.authMiddleware, async (req, res) => {
    try {
        const currentUserId = req.user.userId;
        console.log('Get users for messaging, currentUserId:', currentUserId);
        const result = await connection_1.db.query(`
      SELECT id, nombre, foto_url 
      FROM users 
      WHERE id != $1 
      ORDER BY nombre
    `, [currentUserId]);
        console.log('Users found:', result.rows.length);
        res.json({ success: true, data: result.rows });
    }
    catch (error) {
        const msg = error.message || String(error);
        console.error('Get users error:', msg);
        res.status(500).json({ success: false, error: msg });
    }
});
router.get('/:otherUserId', auth_1.authMiddleware, async (req, res) => {
    try {
        const { otherUserId } = req.params;
        const currentUserId = req.user.userId;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;
        const result = await connection_1.db.query(`
      SELECT * FROM messages
      WHERE (sender_id = $1 AND receiver_id = $2)
         OR (sender_id = $2 AND receiver_id = $1)
      ORDER BY created_at ASC
      LIMIT $3 OFFSET $4
    `, [currentUserId, otherUserId, limit, offset]);
        await connection_1.db.query(`
      UPDATE messages SET read_at = NOW()
      WHERE sender_id = $1 AND receiver_id = $2 AND read_at IS NULL
    `, [otherUserId, currentUserId]);
        const counterResult = await connection_1.db.query(`
      SELECT counter_a_to_b, counter_b_to_a, blocked
      FROM message_counters
      WHERE (user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)
    `, [currentUserId, otherUserId]);
        const counterData = counterResult.rows[0] || { counter_a_to_b: 0, counter_b_to_a: 0, blocked: false };
        res.json({
            success: true,
            data: {
                messages: result.rows,
                counter: {
                    sent: counterData.user_a === currentUserId ? counterData.counter_a_to_b : counterData.counter_b_to_a,
                    received: counterData.user_a === currentUserId ? counterData.counter_b_to_a : counterData.counter_a_to_b,
                },
                blocked: counterData.blocked,
                limit: config_1.config.limits.maxMessagesBetweenUsers,
            },
        });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.post('/:otherUserId', auth_1.authMiddleware, validation_1.messageValidation, async (req, res) => {
    try {
        const { otherUserId } = req.params;
        const { content } = req.body;
        const currentUserId = req.user.userId;
        const counterResult = await connection_1.db.query(`
      SELECT * FROM message_counters
      WHERE (user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)
    `, [currentUserId, otherUserId]);
        let counterData = counterResult.rows[0];
        if (!counterData) {
            const createResult = await connection_1.db.query(`
        INSERT INTO message_counters (user_a, user_b)
        VALUES ($1, $2)
        RETURNING *
      `, [
                currentUserId < otherUserId ? currentUserId : otherUserId,
                currentUserId < otherUserId ? otherUserId : currentUserId,
            ]);
            counterData = createResult.rows[0];
        }
        if (counterData.blocked) {
            return res.status(403).json({
                success: false,
                error: 'Has alcanzado el límite de mensajes. Intenta en 24 horas.'
            });
        }
        const isCurrentUserA = counterData.user_a === currentUserId;
        const currentCounter = isCurrentUserA ? counterData.counter_a_to_b : counterData.counter_b_to_a;
        if (currentCounter >= config_1.config.limits.maxMessagesBetweenUsers) {
            await connection_1.db.query(`
        UPDATE message_counters SET blocked = true WHERE id = $1
      `, [counterData.id]);
            return res.status(403).json({
                success: false,
                error: 'Has alcanzado el límite de mensajes. Intenta en 24 horas.'
            });
        }
        const result = await connection_1.db.query(`
      INSERT INTO messages (sender_id, receiver_id, content)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [currentUserId, otherUserId, content]);
        await connection_1.db.query(`
      UPDATE message_counters 
      SET counter_a_to_b = counter_a_to_b + 1, updated_at = NOW()
      WHERE id = $1
    `, [counterData.id]);
        const senderResult = await connection_1.db.query('SELECT nombre FROM users WHERE id = $1', [currentUserId]);
        const senderName = senderResult.rows[0]?.nombre || 'Alguien';
        await connection_1.db.query(`
      INSERT INTO notifications (user_id, type, payload, status, sent_at)
      VALUES ($1, 'message', $2, 'sent', NOW())
    `, [otherUserId, JSON.stringify({
                title: `💬 ${senderName}`,
                body: content.substring(0, 50),
                sender_id: currentUserId,
                sender_name: senderName
            })]);
        res.status(201).json({ success: true, data: result.rows[0] });
    }
    catch (error) {
        console.error('Send message error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.get('/conversations', auth_1.authMiddleware, async (req, res) => {
    try {
        const currentUserId = req.user.userId;
        console.log('Getting conversations for user:', currentUserId);
        const result = await connection_1.db.query(`
      SELECT DISTINCT ON (other_user_id)
        other_user_id,
        other_user_name,
        last_message,
        last_time,
        unread_count
      FROM (
        SELECT 
          CASE WHEN sender_id = $1 THEN receiver_id ELSE sender_id END as other_user_id,
          u.nombre as other_user_name,
          m.content as last_message,
          m.created_at as last_time,
          (SELECT COUNT(*) FROM messages m2 WHERE m2.sender_id = CASE WHEN m.sender_id = $1 THEN m.receiver_id ELSE m.sender_id END AND m2.receiver_id = $1 AND m2.read_at IS NULL) as unread_count
        FROM messages m
        JOIN users u ON u.id = CASE WHEN m.sender_id = $1 THEN m.receiver_id ELSE m.sender_id END
        WHERE m.sender_id = $1 OR m.receiver_id = $1
        ORDER BY m.created_at DESC
      ) sub
      ORDER BY other_user_id, last_time DESC
    `, [currentUserId]);
        console.log('Conversations found:', result.rows.length);
        res.json({ success: true, data: result.rows });
    }
    catch (error) {
        console.error('Get conversations error:', error.message || error);
        res.status(500).json({ success: false, error: 'Error interno del servidor: ' + (error.message || error) });
    }
});
router.post('/broadcast', auth_1.authMiddleware, async (req, res) => {
    try {
        const { content } = req.body;
        const senderId = req.user.userId;
        const user = req.user;
        console.log('Broadcast request from:', user.email, 'role:', user.rol);
        if (user.rol !== 'admin' && user.rol !== 'moderator') {
            console.log('User not authorized:', user.rol);
            return res.status(403).json({ success: false, error: 'No tienes permisos para enviar mensajes broadcast' });
        }
        if (!content || content.trim().length === 0) {
            return res.status(400).json({ success: false, error: 'El mensaje no puede estar vacío' });
        }
        const usersResult = await connection_1.db.query('SELECT id, nombre FROM users WHERE id != $1', [senderId]);
        console.log('Broadcast to', usersResult.rows.length, 'users');
        let sentCount = 0;
        for (const targetUser of usersResult.rows) {
            await connection_1.db.query(`
        INSERT INTO messages (sender_id, receiver_id, content)
        VALUES ($1, $2, $3)
      `, [senderId, targetUser.id, content]);
            await connection_1.db.query(`
        INSERT INTO notifications (user_id, type, payload, status, sent_at)
        VALUES ($1, 'message', $2, 'sent', NOW())
      `, [targetUser.id, JSON.stringify({
                    title: '💬 Admin PRODE',
                    body: content.substring(0, 50),
                    sender_id: senderId,
                    sender_name: 'Admin PRODE',
                    is_broadcast: true
                })]);
            sentCount++;
        }
        res.json({ success: true, message: `Mensaje enviado a ${sentCount} usuarios` });
    }
    catch (error) {
        console.error('Broadcast error:', error.message || error);
        res.status(500).json({ success: false, error: 'Error al enviar mensaje broadcast' });
    }
});
exports.default = router;
//# sourceMappingURL=messages.js.map