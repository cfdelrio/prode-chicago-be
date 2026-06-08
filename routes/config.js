"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const connection_1 = require("../db/connection");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();

// Claves de config accesibles sin autenticación
const PUBLIC_CONFIG_KEYS = new Set(['ganadores_fechas', 'ganador_fecha']);

router.get('/', auth_1.authMiddleware, auth_1.requireAdmin, async (req, res) => {
    try {
        const result = await connection_1.db.query('SELECT * FROM config ORDER BY key');
        res.json({ success: true, data: result.rows });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

// Primero: rutas públicas (ganadores_fechas, ganador_fecha)
router.get('/:key', (req, res, next) => {
    if (!PUBLIC_CONFIG_KEYS.has(req.params.key)) return next();
    const { key } = req.params;
    connection_1.db.query('SELECT * FROM config WHERE key = $1', [key])
        .then(result => {
            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Configuración no encontrada' });
            }
            res.json({ success: true, data: result.rows[0] });
        })
        .catch(() => res.status(500).json({ success: false, error: 'Error interno del servidor' }));
});

// Resto: requieren autenticación
router.get('/:key', auth_1.authMiddleware, async (req, res) => {
    try {
        const { key } = req.params;
        const result = await connection_1.db.query('SELECT * FROM config WHERE key = $1', [key]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Configuración no encontrada' });
        }
        res.json({ success: true, data: result.rows[0] });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

router.put('/:key', auth_1.authMiddleware, auth_1.requireAdmin, async (req, res) => {
    try {
        const { key } = req.params;
        const { value } = req.body;
        const result = await connection_1.db.query(`
      INSERT INTO config (key, value, updated_at, updated_by)
      VALUES ($1, $2, NOW(), $3)
      ON CONFLICT (key) DO UPDATE SET
        value = $2,
        updated_at = NOW(),
        updated_by = $3
      RETURNING *
    `, [key, JSON.stringify(value), req.user.userId]);
        await connection_1.db.query(`INSERT INTO audit_log (user_id, action, entity_type, entity_id, old_value, new_value, ip_address, user_agent) 
       VALUES ($1, 'config_update', 'config', $2, (SELECT value FROM config WHERE key = $2), $3, $4, $5)`, [req.user.userId, key, JSON.stringify(value), req.ip, req.headers['user-agent']]);
        res.json({ success: true, data: result.rows[0] });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

exports.default = router;
//# sourceMappingURL=config.js.map
