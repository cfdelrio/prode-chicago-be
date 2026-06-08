"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const connection_1 = require("../db/connection");
const auth_1 = require("../middleware/auth");
const validation_1 = require("../middleware/validation");
const rateLimit_1 = require("../middleware/rateLimit");
const config_1 = require("../config");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const router = (0, express_1.Router)();
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
router.get('/by-email', auth_1.authMiddleware, auth_1.requireAdmin, async (req, res) => {
    try {
        const { email } = req.query;
        if (!email) {
            return res.status(400).json({ success: false, error: 'Email requerido' });
        }
        const result = await connection_1.db.query('SELECT id, nombre, email, rol FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
        }
        res.json({ success: true, data: result.rows[0] });
    }
    catch (error) {
        console.error('Error getting user by email:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.get('/', auth_1.authMiddleware, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        let query = `
      SELECT id, nombre, email, rol, idioma_pref, tema_equipo, estado_pago_visible, email_verified, foto_url, created_at
      FROM users
    `;
        const params = [];
        if (req.user.rol === 'usuario') {
            query += ' WHERE id = $1';
            params.push(req.user.userId);
        }
        query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);
        const result = await connection_1.db.query(query, params);
        const countResult = await connection_1.db.query('SELECT COUNT(*) FROM users');
        res.json({
            success: true,
            data: {
                users: result.rows,
                pagination: {
                    page,
                    limit,
                    total: parseInt(countResult.rows[0].count),
                    pages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
                },
            },
        });
    }
    catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.get('/stats', async (req, res) => {
    try {
        const result = await connection_1.db.query('SELECT COUNT(*)::int AS total FROM users');
        res.json({ success: true, data: { total_users: result.rows[0].total } });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno' });
    }
});
router.get('/:id', auth_1.authMiddleware, validation_1.uuidParam, async (req, res) => {
    try {
        const { id } = req.params;
        if (req.user.rol === 'usuario' && req.user.userId !== id) {
            return res.status(403).json({ success: false, error: 'No tienes permisos' });
        }
        const result = await connection_1.db.query(`SELECT id, nombre, email, rol, idioma_pref, tema_equipo, estado_pago_visible, email_verified, foto_url, whatsapp_number, whatsapp_consent, created_at
       FROM users WHERE id = $1`, [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
        }
        res.json({ success: true, data: result.rows[0] });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.put('/:id', auth_1.authMiddleware, validation_1.uuidParam, validation_1.userUpdateValidation, async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, idioma_pref, tema_equipo, whatsapp_number, whatsapp_consent } = req.body;
        if (req.user.rol === 'usuario' && req.user.userId !== id) {
            return res.status(403).json({ success: false, error: 'No tienes permisos' });
        }
        // Validar tema_equipo si se proporciona
        const validThemes = ['neutral', 'boca', 'river', 'independiente', 'racing', 'sanlorenzo', 'estudiantes', 'huracan'];
        if (tema_equipo && !validThemes.includes(tema_equipo)) {
            return res.status(400).json({ success: false, error: 'Tema inválido. Opciones: ' + validThemes.join(', ') });
        }
        // Validate and normalize whatsapp_number to E.164 (+[country_code][number])
        let normalizedPhone = undefined;
        if (whatsapp_number !== undefined && whatsapp_number !== null) {
            if (whatsapp_number === '') {
                normalizedPhone = null;
            } else {
                // Strip everything except digits and leading +
                const withPlus = whatsapp_number.trim().startsWith('+')
                    ? '+' + whatsapp_number.replace(/\D/g, '')
                    : whatsapp_number.replace(/\D/g, '');
                const digits = withPlus.replace(/^\+/, '');
                // E.164: must start with +, total 7-15 digits, country code means >= 10 digits
                if (!withPlus.startsWith('+') || digits.length < 10 || digits.length > 15) {
                    return res.status(400).json({
                        success: false,
                        error: 'Número inválido. Ingresalo en formato internacional: +549XXXXXXXXXX',
                    });
                }
                normalizedPhone = withPlus; // store as +XXXXXXXXXXX
            }
        }
        const result = await connection_1.db.query(`UPDATE users SET
        nombre = COALESCE($1, nombre),
        idioma_pref = COALESCE($2, idioma_pref),
        tema_equipo = COALESCE($3, tema_equipo),
        whatsapp_number = CASE WHEN $4::boolean IS NOT NULL THEN $5 ELSE whatsapp_number END,
        whatsapp_consent = COALESCE($4, whatsapp_consent)
       WHERE id = $6
       RETURNING id, nombre, email, rol, idioma_pref, tema_equipo, foto_url, whatsapp_number, whatsapp_consent`,
            [nombre, idioma_pref, tema_equipo,
             whatsapp_consent !== undefined ? whatsapp_consent : null,
             normalizedPhone !== undefined ? normalizedPhone : null,
             id]);
        res.json({ success: true, data: result.rows[0] });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.post('/:id/photo', auth_1.authMiddleware, rateLimit_1.uploadLimiter, async (req, res) => {
    try {
        const { id } = req.params;
        if (req.user.userId !== id && req.user.rol !== 'admin') {
            return res.status(403).json({ success: false, error: 'No tienes permisos' });
        }
        const files = req.files;
        const file = files?.photo;
        if (!file) {
            return res.status(400).json({ success: false, error: 'Archivo requerido' });
        }
        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
        if (!allowedTypes.includes(file.mimetype)) {
            return res.status(400).json({ success: false, error: 'Tipo de archivo no permitido' });
        }
        if (file.size > 5 * 1024 * 1024) {
            return res.status(400).json({ success: false, error: 'El archivo debe ser menor a 5MB' });
        }
        const key = `avatars/${id}/${Date.now()}-${file.name}`;
        await s3.send(new PutObjectCommand({
            Bucket: process.env.S3_BUCKET_UPLOADS,
            Key: key,
            Body: file.data,
            ContentType: file.mimetype,
        }));
        const fotoUrl = `${config_1.config.aws.cdnUrl}/${key}`;
        await connection_1.db.query('UPDATE users SET foto_url = $1 WHERE id = $2', [fotoUrl, id]);
        res.json({ success: true, data: { foto_url: fotoUrl } });
    }
    catch (error) {
        console.error('Upload photo error:', error);
        res.status(500).json({ success: false, error: 'Error al subir la foto' });
    }
});
router.post('/:id/mark-paid', auth_1.authMiddleware, auth_1.requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { planilla_id, pagado } = req.body;
        if (!planilla_id) {
            return res.status(400).json({ success: false, error: 'Se requiere ID de planilla' });
        }
        const result = await connection_1.db.query('UPDATE planillas SET precio_pagado = $1 WHERE id = $2 AND user_id = $3 RETURNING id', [pagado, planilla_id, id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Planilla no encontrada' });
        }
        await connection_1.db.query(`INSERT INTO audit_log (user_id, action, entity_type, entity_id, new_value, ip_address, user_agent) 
       VALUES ($1, 'mark_paid', 'planillas', $2, $3, $4, $5)`, [req.user.userId, planilla_id, JSON.stringify({ pagado }), req.ip, req.headers['user-agent']]);
        res.json({ success: true, message: `Planilla marcada como ${pagado ? 'pagada' : 'impaga'}` });
    }
    catch (error) {
        console.error('Mark paid error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.post('/:id/create-planilla', auth_1.authMiddleware, auth_1.requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre_planilla, precio_pagado } = req.body;
        const result = await connection_1.db.query(`INSERT INTO planillas (user_id, nombre_planilla, precio_pagado)
       VALUES ($1, $2, $3)
       RETURNING *`, [id, nombre_planilla || 'Qatar 2022', precio_pagado || false]);
        res.json({ success: true, data: result.rows[0] });
    }
    catch (error) {
        console.error('Create planilla error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.get('/:id/planillas', auth_1.authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        if (req.user.rol === 'usuario' && req.user.userId !== id) {
            return res.status(403).json({ success: false, error: 'No tienes permisos' });
        }
        const result = await connection_1.db.query(`SELECT p.*, 
        COALESCE(SUM(s.puntos_obtenidos), 0) as puntos_totales,
        COUNT(s.id) FILTER (WHERE s.bonus_aplicado = false AND s.puntos_obtenidos = 3) +
        COUNT(s.id) FILTER (WHERE s.bonus_aplicado = true AND s.puntos_obtenidos = 4) as exactos_count
       FROM planillas p
       LEFT JOIN scores s ON p.id = s.planilla_id
       WHERE p.user_id = $1
       GROUP BY p.id
       ORDER BY puntos_totales DESC, exactos_count DESC`, [id]);
        res.json({ success: true, data: result.rows });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.post('/upload-avatar', auth_1.authMiddleware, rateLimit_1.uploadLimiter, async (req, res) => {
    try {
        const { image, fileName, contentType } = req.body;
        const userId = req.user.userId;
        if (!image) {
            return res.status(400).json({ success: false, error: 'No se recibió ninguna imagen' });
        }
        const buffer = Buffer.from(image, 'base64');
        const ext = fileName?.split('.').pop() || 'jpg';
        const key = `avatars/${userId}-${Date.now()}.${ext}`;
        const bucket = process.env.S3_BUCKET_UPLOADS || 'prode-uploads-cdelrio';
        await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: buffer,
            ContentType: contentType || 'image/jpeg',
        }));
        const avatarUrl = `${config_1.config.aws.cdnUrl}/${key}`;
        await connection_1.db.query('UPDATE users SET foto_url = $1 WHERE id = $2', [avatarUrl, userId]);
        res.json({
            success: true,
            data: { url: avatarUrl },
        });
    }
    catch (error) {
        console.error('Upload avatar error:', error.message || error);
        res.status(500).json({ success: false, error: 'Error al subir la imagen: ' + (error.message || 'Unknown error') });
    }
});
router.put('/profile', auth_1.authMiddleware, async (req, res) => {
    try {
        const { nombre } = req.body;
        const userId = req.user.userId;
        await connection_1.db.query('UPDATE users SET nombre = COALESCE($1, nombre) WHERE id = $2', [nombre, userId]);
        res.json({ success: true, message: 'Perfil actualizado correctamente' });
    }
    catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({ success: false, error: 'Error al actualizar el perfil' });
    }
});
router.get('/admin/info', async (req, res) => {
    try {
        const result = await connection_1.db.query('SELECT id, nombre, foto_url FROM users WHERE rol = $1 LIMIT 1', ['admin']);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Admin no encontrado' });
        }
        res.json({ success: true, data: result.rows[0] });
    }
    catch (error) {
        console.error('Get admin error:', error);
        res.status(500).json({ success: false, error: 'Error interno' });
    }
});
router.get('/all', async (req, res) => {
    try {
        const result = await connection_1.db.query('SELECT id, nombre, foto_url, rol FROM users ORDER BY nombre');
        res.json({ success: true, data: result.rows });
    }
    catch (error) {
        console.error('Get all users error:', error);
        res.status(500).json({ success: false, error: 'Error interno' });
    }
});
router.post('/fix-avatars', async (req, res) => {
    try {
        const OLD_CDN = 'prode-uploads-cdelrio.s3.amazonaws.com';
        const NEW_CDN = 'd2qq3cs1mdfszr.cloudfront.net';
        const result = await connection_1.db.query("SELECT id, foto_url FROM users WHERE foto_url LIKE '%" + OLD_CDN + "%'");
        let updated = 0;
        for (const user of result.rows) {
            const newUrl = user.foto_url.replace(OLD_CDN, NEW_CDN);
            await connection_1.db.query('UPDATE users SET foto_url = $1 WHERE id = $2', [newUrl, user.id]);
            updated++;
        }
        res.json({ success: true, message: `Se actualizaron ${updated} avatars` });
    }
    catch (error) {
        console.error('Fix avatars error:', error);
        res.status(500).json({ success: false, error: 'Error interno' });
    }
});
router.get('/admin/users-with-planillas', auth_1.authMiddleware, auth_1.requireAdmin, async (req, res) => {
    try {
        const result = await connection_1.db.query(`
      SELECT 
        u.id,
        u.nombre,
        u.email,
        u.rol,
        u.created_at,
        COALESCE(json_agg(
          json_build_object(
            'id', p.id,
            'nombre_planilla', p.nombre_planilla,
            'precio_pagado', p.precio_pagado,
            'created_at', p.created_at
          )
        ) FILTER (WHERE p.id IS NOT NULL), '[]') as planillas
      FROM users u
      LEFT JOIN planillas p ON u.id = p.user_id
      GROUP BY u.id, u.nombre, u.email, u.rol, u.created_at
      ORDER BY u.nombre
    `);
        res.json({ success: true, data: result.rows });
    }
    catch (error) {
        console.error('Error getting users with planillas:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
// Gamification: badges + streaks + summary
router.get('/:id/gamification', auth_1.authMiddleware, validation_1.uuidParam, async (req, res) => {
    try {
        const { id } = req.params;
        if (req.user.userId !== id && req.user.rol !== 'admin') {
            return res.status(403).json({ success: false, error: 'No autorizado' });
        }
        const { getGamificationSummary } = require('../services/gamification');
        const summary = await getGamificationSummary(id);
        res.json({ success: true, data: summary });
    }
    catch (error) {
        console.error('[users/gamification] error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

router.delete('/:id', auth_1.authMiddleware, auth_1.requireAdmin, validation_1.uuidParam, async (req, res) => {
    try {
        const { id } = req.params;
        const target = await connection_1.db.query('SELECT id, rol FROM users WHERE id = $1', [id]);
        if (target.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
        }
        if (target.rows[0].rol === 'admin') {
            return res.status(403).json({ success: false, error: 'No se puede eliminar un usuario admin' });
        }
        await connection_1.db.query('BEGIN');
        await connection_1.db.query(`DELETE FROM scores WHERE planilla_id IN (SELECT id FROM planillas WHERE user_id = $1)`, [id]);
        await connection_1.db.query(`DELETE FROM scores_by_matchday WHERE planilla_id IN (SELECT id FROM planillas WHERE user_id = $1)`, [id]);
        await connection_1.db.query(`DELETE FROM tournament_rankings WHERE planilla_id IN (SELECT id FROM planillas WHERE user_id = $1)`, [id]);
        await connection_1.db.query(`DELETE FROM ranking WHERE planilla_id IN (SELECT id FROM planillas WHERE user_id = $1)`, [id]);
        await connection_1.db.query(`DELETE FROM bets WHERE planilla_id IN (SELECT id FROM planillas WHERE user_id = $1)`, [id]);
        await connection_1.db.query(`DELETE FROM reminder_sent WHERE user_id = $1`, [id]);
        await connection_1.db.query(`DELETE FROM planillas WHERE user_id = $1`, [id]);
        await connection_1.db.query(`DELETE FROM comments WHERE author_id = $1`, [id]);
        await connection_1.db.query(`DELETE FROM users WHERE id = $1`, [id]);
        await connection_1.db.query('COMMIT');
        res.json({ success: true, message: 'Usuario eliminado correctamente' });
    }
    catch (error) {
        await connection_1.db.query('ROLLBACK').catch(() => {});
        console.error('[users/delete]', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

exports.default = router;