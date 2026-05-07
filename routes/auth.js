"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const connection_1 = require("../db/connection");
const utils_1 = require("../utils");
const validation_1 = require("../middleware/validation");
const auth_1 = require("../middleware/auth");
const rateLimit_1 = require("../middleware/rateLimit");
const email_1 = require("../services/email");
const router = (0, express_1.Router)();
router.post('/register', rateLimit_1.authLimiter, validation_1.registerValidation, async (req, res) => {
    try {
        const { nombre, email, password, idioma_pref } = req.body;
        const existingUser = await connection_1.db.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ success: false, error: 'El email ya está registrado' });
        }
        const hash_pass = await (0, utils_1.hashPassword)(password);
        const result = await connection_1.db.query(`INSERT INTO users (nombre, email, hash_pass, idioma_pref, rol) 
       VALUES ($1, $2, $3, $4, 'usuario') 
       RETURNING id, nombre, email, rol, idioma_pref, foto_url, created_at`, [nombre, email, hash_pass, idioma_pref || 'es']);
        const user = result.rows[0];
        const token = (0, utils_1.generateToken)({ userId: user.id, email: user.email, rol: user.rol });
        const refreshToken = (0, utils_1.generateRefreshToken)({ userId: user.id, email: user.email, rol: user.rol });
        await connection_1.db.query('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'7 days\')', [user.id, refreshToken]);
        await connection_1.db.query(`INSERT INTO audit_log (user_id, action, entity_type, new_value, ip_address, user_agent) 
       VALUES ($1, 'user_register', 'users', $2, $3, $4)`, [user.id, JSON.stringify({ email }), req.ip, req.headers['user-agent']]);
        res.status(201).json({
            success: true,
            data: {
                user: {
                    id: user.id,
                    nombre: user.nombre,
                    email: user.email,
                    rol: user.rol,
                    idioma_pref: user.idioma_pref,
                    foto_url: user.foto_url,
                },
                token,
                refreshToken,
            },
        });
    }
    catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.post('/login', rateLimit_1.loginLimiter, validation_1.loginValidation, async (req, res) => {
    try {
        const { email, password } = req.body;
        const result = await connection_1.db.query('SELECT id, nombre, email, hash_pass, rol, idioma_pref, tema_equipo, email_verified, foto_url, whatsapp_number, whatsapp_consent FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, error: 'Credenciales inválidas' });
        }
        const user = result.rows[0];
        const validPassword = await (0, utils_1.comparePassword)(password, user.hash_pass);
        if (!validPassword) {
            return res.status(401).json({ success: false, error: 'Credenciales inválidas' });
        }
        const token = (0, utils_1.generateToken)({ userId: user.id, email: user.email, rol: user.rol });
        const refreshToken = (0, utils_1.generateRefreshToken)({ userId: user.id, email: user.email, rol: user.rol });
        await connection_1.db.query('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'7 days\')', [user.id, refreshToken]);
        await connection_1.db.query(`INSERT INTO audit_log (user_id, action, entity_type, ip_address, user_agent) 
       VALUES ($1, 'user_login', 'users', $2, $3)`, [user.id, req.ip, req.headers['user-agent']]);
        res.json({
            success: true,
            data: {
                user: {
                    id: user.id,
                    nombre: user.nombre,
                    email: user.email,
                    rol: user.rol,
                    idioma_pref: user.idioma_pref,
                    tema_equipo: user.tema_equipo || 'neutral',
                    email_verified: user.email_verified,
                    foto_url: user.foto_url,
                },
                token,
                refreshToken,
            },
        });
    }
    catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.post('/refresh', async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) {
            return res.status(400).json({ success: false, error: 'Refresh token requerido' });
        }
        const tokenResult = await connection_1.db.query(`SELECT rt.*, u.email, u.rol 
       FROM refresh_tokens rt 
       JOIN users u ON rt.user_id = u.id 
       WHERE rt.token = $1 AND rt.revoked_at IS NULL AND rt.expires_at > NOW()`, [refreshToken]);
        if (tokenResult.rows.length === 0) {
            return res.status(401).json({ success: false, error: 'Refresh token inválido' });
        }
        const tokenData = tokenResult.rows[0];
        await connection_1.db.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE token = $1', [refreshToken]);
        const newToken = (0, utils_1.generateToken)({ userId: tokenData.user_id, email: tokenData.email, rol: tokenData.rol });
        const newRefreshToken = (0, utils_1.generateRefreshToken)({ userId: tokenData.user_id, email: tokenData.email, rol: tokenData.rol });
        await connection_1.db.query('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'7 days\')', [tokenData.user_id, newRefreshToken]);
        res.json({
            success: true,
            data: {
                token: newToken,
                refreshToken: newRefreshToken,
            },
        });
    }
    catch (error) {
        console.error('Refresh error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.post('/logout', auth_1.authMiddleware, async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (refreshToken) {
            await connection_1.db.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE token = $1', [refreshToken]);
        }
        res.json({ success: true, message: 'Sesión cerrada' });
    }
    catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.get('/verify-email/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const payload = (0, utils_1.verifyToken)(token);
        if (payload.rol !== 'verification') {
            return res.status(400).json({ success: false, error: 'Token inválido' });
        }
        await connection_1.db.query('UPDATE users SET email_verified = true WHERE id = $1', [payload.userId]);
        res.json({ success: true, message: 'Email verificado correctamente' });
    }
    catch (error) {
        res.status(400).json({ success: false, error: 'Token inválido o expirado' });
    }
});
router.post('/register-pending', rateLimit_1.authLimiter, async (req, res) => {
    try {
        const { nombre, email, password } = req.body;
        if (!nombre || !email || !password) {
            return res.status(400).json({ success: false, error: 'Todos los campos son requeridos' });
        }
        if (password.length < 6) {
            return res.status(400).json({ success: false, error: 'La contraseña debe tener al menos 6 caracteres' });
        }
        const existingUser = await connection_1.db.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ success: false, error: 'El email ya está registrado' });
        }
        const existingPending = await connection_1.db.query('SELECT id FROM pending_registrations WHERE email = $1', [email]);
        if (existingPending.rows.length > 0) {
            await connection_1.db.query('DELETE FROM pending_registrations WHERE email = $1', [email]);
        }
        const hash_pass = await (0, utils_1.hashPassword)(password);
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        const codeExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
        const result = await connection_1.db.query(`INSERT INTO pending_registrations (nombre, email, hash_pass, verification_code, code_expires_at) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING id, nombre, email`, [nombre, email, hash_pass, verificationCode, codeExpiresAt]);
        const pendingReg = result.rows[0];
        console.log(`📧 Enviando código de verificación a ${email}: ${verificationCode}`);
        try {
            await (0, email_1.sendVerificationCode)(email, nombre, verificationCode);
            console.log(`✅ Email enviado exitosamente a ${email}`);
        }
        catch (emailError) {
            console.error('❌ Error sending verification email:', emailError);
        }
        res.status(201).json({
            success: true,
            message: 'Revisa tu email para el código de verificación.',
            data: {
                pendingId: pendingReg.id,
            },
        });
    }
    catch (error) {
        console.error('Register pending error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.post('/verify-email', rateLimit_1.authLimiter, async (req, res) => {
    try {
        const { pendingId, code } = req.body;
        console.log('🔍 Verificación recibida:', { pendingId, code, codeLength: code?.length });
        if (!pendingId || !code) {
            return res.status(400).json({ success: false, error: 'pendingId y code son requeridos' });
        }
        const result = await connection_1.db.query(`SELECT id, nombre, email, hash_pass, verification_code, code_expires_at 
       FROM pending_registrations 
       WHERE id = $1`, [pendingId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Registro no encontrado o ya completado' });
        }
        const pending = result.rows[0];
        console.log('📋 Registro encontrado:', {
            email: pending.email,
            codeInDB: pending.verification_code,
            codeReceived: code,
            expired: new Date() > new Date(pending.code_expires_at)
        });
        if (new Date() > new Date(pending.code_expires_at)) {
            console.log('❌ Código expirado');
            return res.status(400).json({ success: false, error: 'Código expirado. Solicita uno nuevo.' });
        }
        const isValidCode = pending.verification_code === code;
        console.log('🔐 Validación:', { isValidCode, env: process.env.NODE_ENV });
        if (!isValidCode) {
            console.log('❌ Código inválido - esperado:', pending.verification_code, 'recibido:', code);
            return res.status(400).json({ success: false, error: 'Código inválido' });
        }
        const userResult = await connection_1.db.query(`INSERT INTO users (nombre, email, hash_pass, email_verified, rol) 
       VALUES ($1, $2, $3, true, 'usuario') 
       RETURNING id, nombre, email, rol`, [pending.nombre, pending.email, pending.hash_pass]);
        const user = userResult.rows[0];
        await connection_1.db.query(`DELETE FROM pending_registrations WHERE id = $1`, [pendingId]);
        res.json({
            success: true,
            message: 'Email verificado correctamente',
            data: {
                userId: user.id,
            },
        });
    }
    catch (error) {
        console.error('Verify email error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.post('/resend-code', rateLimit_1.authLimiter, async (req, res) => {
    try {
        const { pendingId } = req.body;
        if (!pendingId) {
            return res.status(400).json({ success: false, error: 'pendingId es requerido' });
        }
        const result = await connection_1.db.query('SELECT id, nombre, email FROM pending_registrations WHERE id = $1', [pendingId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Registro no encontrado o ya completado' });
        }
        const pending = result.rows[0];
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        const codeExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
        await connection_1.db.query(`UPDATE pending_registrations 
       SET verification_code = $1, code_expires_at = $2 
       WHERE id = $3`, [verificationCode, codeExpiresAt, pendingId]);
        console.log(`📧 Reenviando código a ${pending.email}: ${verificationCode}`);
        try {
            await (0, email_1.sendVerificationCode)(pending.email, pending.nombre, verificationCode);
            console.log(`✅ Email reenviado exitosamente`);
        }
        catch (emailError) {
            console.error('❌ Error sending resend email:', emailError);
        }
        res.json({
            success: true,
            message: 'Código reenviado. Revisa tu email.',
        });
    }
    catch (error) {
        console.error('Resend code error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.post('/forgot-password', rateLimit_1.authLimiter, async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, error: 'Email es requerido' });
        }
        const result = await connection_1.db.query('SELECT id, nombre FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) {
            // Por seguridad, devolvemos success aunque el email no exista
            return res.json({ success: true, message: 'Si el email existe, recibirás instrucciones de recuperación' });
        }
        const user = result.rows[0];
        const resetToken = (0, utils_1.generateToken)({ userId: user.id, email, rol: 'password-reset' }, '60m');
        const resetLink = `${process.env.FRONTEND_URL || 'https://prodecaballito.com'}/recuperar-contrasena?token=${resetToken}`;
        console.log(`📧 Enviando email de recuperación a ${email}`);
        try {
            await (0, email_1.sendEmail)({
                to: email,
                subject: '🔐 Recupera tu contraseña — PRODE Caballito',
                html: `
                    <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;background:#f8fafc">
                        <div style="background:#001A4B;padding:28px 24px;border-radius:12px 12px 0 0;text-align:center">
                            <h1 style="color:#fff;margin:0;font-size:1.4rem">⚽ Recuperar Contraseña</h1>
                        </div>
                        <div style="background:#fff;padding:24px;border-radius:0 0 12px 12px">
                            <p style="color:#374151">Hola <strong>${user.nombre}</strong>,</p>
                            <p style="color:#374151">Recibimos una solicitud para recuperar tu contraseña. Si no fuiste vos, podés ignorar este email.</p>
                            <p style="text-align:center;margin:24px 0">
                                <a href="${resetLink}" style="display:inline-block;background:#0042A5;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold">
                                    Recuperar Contraseña
                                </a>
                            </p>
                            <p style="color:#6b7280;font-size:0.82rem">Este link expira en 1 hora.</p>
                            <p style="color:#6b7280;font-size:0.82rem">Si el botón no funciona, copia este link en tu navegador:<br/><code style="background:#f3f4f6;padding:2px 6px;border-radius:4px">${resetLink}</code></p>
                        </div>
                        <p style="text-align:center;color:#9ca3af;font-size:0.75rem;padding:16px">
                            PRODE Caballito · <a href="https://prodecaballito.com" style="color:#0042A5">prodecaballito.com</a>
                        </p>
                    </div>
                `,
            });
            console.log(`✅ Email de recuperación enviado a ${email}`);
        } catch (emailError) {
            console.error('❌ Error enviando email de recuperación:', emailError);
        }
        res.json({ success: true, message: 'Si el email existe, recibirás instrucciones de recuperación' });
    }
    catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.post('/reset-password', rateLimit_1.authLimiter, async (req, res) => {
    try {
        const { token, password } = req.body;
        if (!token || !password) {
            return res.status(400).json({ success: false, error: 'Token y contraseña son requeridos' });
        }
        if (password.length < 6) {
            return res.status(400).json({ success: false, error: 'La contraseña debe tener al menos 6 caracteres' });
        }
        let payload;
        try {
            payload = (0, utils_1.verifyToken)(token);
        } catch (e) {
            return res.status(400).json({ success: false, error: 'Token inválido o expirado' });
        }
        if (payload.rol !== 'password-reset') {
            return res.status(400).json({ success: false, error: 'Token inválido' });
        }
        const hash_pass = await (0, utils_1.hashPassword)(password);
        await connection_1.db.query('UPDATE users SET hash_pass = $1 WHERE id = $2', [hash_pass, payload.userId]);
        res.json({ success: true, message: 'Contraseña actualizada correctamente' });
    }
    catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
router.post('/complete-registration', rateLimit_1.authLimiter, async (req, res) => {
    try {
        const { userId, tema_equipo, telefono, whatsapp_number } = req.body;
        if (!userId) {
            return res.status(400).json({ success: false, error: 'userId es requerido' });
        }
        const result = await connection_1.db.query('SELECT id, email, email_verified, nombre, rol, idioma_pref, foto_url, whatsapp_number, whatsapp_consent FROM users WHERE id = $1', [userId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Usuario no encontrado. Por favor verifica tu email primero.' });
        }
        const user = result.rows[0];
        if (!user.email_verified) {
            return res.status(400).json({ success: false, error: 'Debes verificar tu email primero' });
        }
        const updates = [];
        const params = [];
        let idx = 1;
        if (tema_equipo) { updates.push(`tema_equipo = $${idx++}`); params.push(tema_equipo); }
        const phone = whatsapp_number || telefono;
        if (phone) { updates.push(`whatsapp_number = $${idx++}`); params.push(phone); }
        if (updates.length > 0) {
            params.push(userId);
            await connection_1.db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`, params);
        }
        const token = (0, utils_1.generateToken)({ userId: user.id, email: user.email, rol: user.rol });
        const refreshToken = (0, utils_1.generateRefreshToken)({ userId: user.id, email: user.email, rol: user.rol });
        await connection_1.db.query('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'7 days\')', [user.id, refreshToken]);
        await connection_1.db.query(`INSERT INTO audit_log (user_id, action, entity_type, new_value) 
       VALUES ($1, 'complete_registration', 'users', $2)`, [user.id, JSON.stringify({ tema_equipo })]);
        
        // Enviar email de bienvenida
        try {
            await (0, email_1.sendWelcomeEmail)(user.email, user.nombre);
            console.log(`✅ Email de bienvenida enviado a ${user.email}`);
        } catch (emailError) {
            console.error('❌ Error enviando email de bienvenida:', emailError);
        }
        
        res.json({
            success: true,
            message: 'Registro completado exitosamente',
            data: {
                user: {
                    id: user.id,
                    nombre: user.nombre,
                    email: user.email,
                    rol: user.rol,
                    idioma_pref: user.idioma_pref || 'es',
                    tema_equipo: tema_equipo || 'neutral',
                    foto_url: user.foto_url,
                    whatsapp_number: phone || user.whatsapp_number || null,
                    whatsapp_consent: false,
                    email_verified: true,
                },
                token,
                refreshToken,
            },
        });
    }
    catch (error) {
        console.error('Complete registration error:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
exports.default = router;
//# sourceMappingURL=auth.js.map
