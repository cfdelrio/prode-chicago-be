"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const connection_1 = require("../db/connection");
const crypto = require("crypto");

const router = (0, express_1.Router)();

function hashIP(ip) {
    const salt = process.env.IP_SALT || 'prode-poll-salt-2026';
    return crypto.createHash('sha256').update(ip + salt).digest('hex');
}

function getUserIdFromToken(req) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
        return decoded.userId || null;
    } catch {
        return null;
    }
}

// GET /api/public/polls/:slug
router.get('/:slug', async (req, res) => {
    try {
        const { slug } = req.params;
        const pollRes = await connection_1.db.query(
            `SELECT id, slug, title, subtitle, active, ended, created_at FROM public_polls WHERE slug = $1`,
            [slug]
        );
        if (pollRes.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Poll no encontrado' });
        }
        const poll = pollRes.rows[0];
        const optionsRes = await connection_1.db.query(
            `SELECT id, label, flag_emoji, flag_code, display_order,
                    (SELECT COUNT(*)::int FROM poll_votes pv WHERE pv.option_id = po.id AND pv.poll_id = $1) AS vote_count
             FROM poll_options po WHERE po.poll_id = $1 ORDER BY po.display_order`,
            [poll.id]
        );
        const totalRes = await connection_1.db.query(
            `SELECT COUNT(*)::int AS total FROM poll_votes WHERE poll_id = $1`,
            [poll.id]
        );
        res.json({
            success: true,
            data: {
                ...poll,
                options: optionsRes.rows,
                total_votes: totalRes.rows[0].total,
            }
        });
    } catch (error) {
        console.error('[polls] GET error:', error.message);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

// POST /api/public/polls/:slug/vote
router.post('/:slug/vote', async (req, res) => {
    try {
        const { slug } = req.params;
        const { option_id, session_token } = req.body;
        if (!option_id) {
            return res.status(400).json({ success: false, error: 'option_id requerido' });
        }
        const pollRes = await connection_1.db.query(
            `SELECT id, active, ended FROM public_polls WHERE slug = $1`,
            [slug]
        );
        if (pollRes.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Poll no encontrado' });
        }
        const poll = pollRes.rows[0];
        if (!poll.active || poll.ended) {
            return res.status(400).json({ success: false, error: 'Esta votación ha terminado' });
        }
        const optionRes = await connection_1.db.query(
            `SELECT id FROM poll_options WHERE id = $1 AND poll_id = $2`,
            [option_id, poll.id]
        );
        if (optionRes.rows.length === 0) {
            return res.status(400).json({ success: false, error: 'Opción inválida' });
        }
        const ip = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.ip || 'unknown';
        const ipHash = hashIP(ip);
        const userId = getUserIdFromToken(req);
        let alreadyRes;
        if (userId) {
            alreadyRes = await connection_1.db.query(
                `SELECT id FROM poll_votes WHERE poll_id = $1 AND (ip_hash = $2 OR user_id = $3)`,
                [poll.id, ipHash, userId]
            );
        } else {
            alreadyRes = await connection_1.db.query(
                `SELECT id FROM poll_votes WHERE poll_id = $1 AND ip_hash = $2`,
                [poll.id, ipHash]
            );
        }
        if (alreadyRes.rows.length > 0) {
            return res.status(409).json({ success: false, error: 'Ya votaste en esta encuesta', already_voted: true });
        }
        await connection_1.db.query(
            `INSERT INTO poll_votes (poll_id, option_id, user_id, ip_hash, session_token)
             VALUES ($1, $2, $3, $4, $5)`,
            [poll.id, option_id, userId, ipHash, session_token || null]
        );
        const optionsRes = await connection_1.db.query(
            `SELECT id, label, flag_emoji, flag_code, display_order,
                    (SELECT COUNT(*)::int FROM poll_votes pv WHERE pv.option_id = po.id AND pv.poll_id = $1) AS vote_count
             FROM poll_options po WHERE po.poll_id = $1 ORDER BY po.display_order`,
            [poll.id]
        );
        const totalRes = await connection_1.db.query(
            `SELECT COUNT(*)::int AS total FROM poll_votes WHERE poll_id = $1`,
            [poll.id]
        );
        res.json({
            success: true,
            data: {
                options: optionsRes.rows,
                total_votes: totalRes.rows[0].total,
            }
        });
    } catch (error) {
        console.error('[polls] POST vote error:', error.message);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

// GET /api/public/polls/:slug/results
router.get('/:slug/results', async (req, res) => {
    try {
        const { slug } = req.params;
        const pollRes = await connection_1.db.query(
            `SELECT id, slug, title, subtitle, active, ended FROM public_polls WHERE slug = $1`,
            [slug]
        );
        if (pollRes.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Poll no encontrado' });
        }
        const poll = pollRes.rows[0];
        const optionsRes = await connection_1.db.query(
            `SELECT id, label, flag_emoji, flag_code, display_order,
                    (SELECT COUNT(*)::int FROM poll_votes pv WHERE pv.option_id = po.id AND pv.poll_id = $1) AS vote_count
             FROM poll_options po WHERE po.poll_id = $1 ORDER BY po.display_order`,
            [poll.id]
        );
        const totalRes = await connection_1.db.query(
            `SELECT COUNT(*)::int AS total FROM poll_votes WHERE poll_id = $1`,
            [poll.id]
        );
        const feedRes = await connection_1.db.query(
            `SELECT pv.created_at, po.label AS option_label, po.flag_emoji,
                    COALESCE(u.nombre, 'Un hincha') AS voter_name
             FROM poll_votes pv
             JOIN poll_options po ON po.id = pv.option_id
             LEFT JOIN users u ON u.id = pv.user_id
             WHERE pv.poll_id = $1
             ORDER BY pv.created_at DESC
             LIMIT 15`,
            [poll.id]
        );
        res.json({
            success: true,
            data: {
                ...poll,
                options: optionsRes.rows,
                total_votes: totalRes.rows[0].total,
                feed: feedRes.rows,
            }
        });
    } catch (error) {
        console.error('[polls] GET results error:', error.message);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

// PATCH /api/public/polls/:slug — admin: set winner, toggle active/ended
router.patch('/:slug', async (req, res) => {
    try {
        const userId = getUserIdFromToken(req);
        if (!userId) return res.status(401).json({ success: false, error: 'Auth required' });

        const userRes = await connection_1.db.query('SELECT rol FROM users WHERE id = $1', [userId]);
        const rol = userRes.rows[0]?.rol;
        if (!rol || !['admin', 'superadmin'].includes(rol)) {
            return res.status(403).json({ success: false, error: 'Solo admins' });
        }

        const { slug } = req.params;
        const { winner_option_id, active, ended } = req.body;

        const updates = [];
        const params = [];
        let idx = 1;

        if (winner_option_id !== undefined) { updates.push(`winner_option_id = $${idx++}`); params.push(winner_option_id); }
        if (active !== undefined)           { updates.push(`active = $${idx++}`);           params.push(active); }
        if (ended !== undefined)            { updates.push(`ended = $${idx++}`);             params.push(ended); }

        if (updates.length === 0) {
            return res.status(400).json({ success: false, error: 'Nada para actualizar' });
        }

        params.push(slug);
        const result = await connection_1.db.query(
            `UPDATE public_polls SET ${updates.join(', ')}, updated_at = NOW()
             WHERE slug = $${idx} RETURNING *`,
            params
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Poll no encontrado' });
        }

        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('[polls] PATCH error:', error.message);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

exports.default = router;
