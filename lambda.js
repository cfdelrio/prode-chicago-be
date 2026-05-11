"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const serverless_http_1 = __importDefault(require("serverless-http"));
const express_1 = __importDefault(require("express"));
const middleware_1 = require("./middleware");
const rateLimit_1 = require("./middleware/rateLimit");
const routes_1 = require("./routes");
const { sendWhatsApp, sendWhatsAppTemplate } = require('./services/whatsapp');
const { db } = require('./db/connection');
const { authMiddleware, requireAdmin } = require('./middleware/auth');
const { runConcurrent } = require('./services/concurrency');
const app = (0, express_1.default)();
app.set('trust proxy', 1);
app.use(middleware_1.securityMiddleware);
app.use(middleware_1.corsMiddleware);
app.use(middleware_1.compressionMiddleware);
app.use(express_1.default.json({ limit: '10mb' }));
app.use(express_1.default.urlencoded({ extended: true }));
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.use('/api/auth', rateLimit_1.authLimiter, routes_1.authRoutes);
app.use('/api/users', rateLimit_1.authLimiter, routes_1.usersRoutes);
app.use('/api/matches', routes_1.matchesRoutes);
app.use('/api/bets', routes_1.betsRoutes);
app.use('/api/ranking', routes_1.rankingRoutes);
app.use('/api/comments', routes_1.commentsRoutes);
app.use('/api/notifications', routes_1.notificationsRoutes);
app.use('/api/planillas', routes_1.planillasRoutes);
app.use('/api/messages', routes_1.messagesRoutes);
app.use('/api/subscriptions', routes_1.subscriptionsRoutes);
app.use('/api/config', routes_1.configRoutes);
app.use('/api/theme', routes_1.themeRoutes);
app.use('/api/tournaments', routes_1.tournamentsRoutes);
app.use('/api/matchdays', routes_1.matchdaysRoutes);
app.use('/api/imagemail', routes_1.imagemailRoutes);
app.use('/api/push', routes_1.pushRoutes);
app.use('/api/admin', routes_1.adminRoutes);
app.use('/api/admin/backups', routes_1.backupsRoutes);
app.post('/api/internal/broadcast-whatsapp', authMiddleware, requireAdmin, async (req, res) => {
    try {
        const { message } = req.body;
        if (!message || !message.trim()) {
            return res.status(400).json({ success: false, error: 'Mensaje requerido' });
        }
        const result = await db.query(
            `SELECT nombre, whatsapp_number FROM users WHERE whatsapp_number IS NOT NULL AND whatsapp_consent = true`
        );
        const recipients = result.rows;
        const useTemplate = Boolean(process.env.BROADCAST_TEMPLATE_SID);
        console.log(`[broadcast-whatsapp] mode=${useTemplate ? 'template' : 'freeform'} recipients=${recipients.length}`);

        let sent = 0, failed = 0;
        const results = await runConcurrent(recipients, (r) =>
            useTemplate
                ? sendWhatsAppTemplate({
                    to: r.whatsapp_number,
                    templateName: 'prode_broadcast_aviso',
                    variables: { 1: r.nombre || 'jugador', 2: message },
                })
                : sendWhatsApp({ to: r.whatsapp_number, body: message }),
            10);
        for (const r of results) {
            if (r.status === 'fulfilled') sent++;
            else { failed++; console.error(`[broadcast-whatsapp] error:`, r.reason?.message); }
        }
        console.log(`[broadcast-whatsapp] total=${recipients.length} sent=${sent} failed=${failed}`);
        res.json({ success: true, data: { total: recipients.length, sent, failed } });
    } catch (error) {
        console.error('[broadcast-whatsapp] error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(err.status || 500).json({
        success: false,
        error: err.message || 'Error interno del servidor',
    });
});
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Ruta no encontrada' });
});
const serverlessHandler = (0, serverless_http_1.default)(app, {
    basePath: process.env.API_BASE_PATH || '/prod',
});
const handler = async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;
    // Internal async winner notification event
    if (event.source === 'winner-notification') {
        const { recalcMatchdayForMatch } = require('./routes/matchdays');
        const matchdays = require('./routes/matchdays');
        await matchdays.processWinnerNotification(event.winner, event.matchday, event.winnerEmail, event.allEmails || []);
        return { statusCode: 200 };
    }

    // Direct config upsert for winner image (called by n8n or manually)
    if (event.source === 'prode.set-winner') {
        const entry = {
            image_url: event.imageUrl,
            matchday_label: event.matchdayLabel || 'Ganador de la Fecha',
            updated_at: new Date().toISOString(),
        };
        // Upsert single latest winner
        await db.query(
            `INSERT INTO config (key, value, updated_at) VALUES ('ganador_fecha', $1, NOW())
             ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
            [JSON.stringify(entry)]
        );
        // Append to winners array
        const existingRes = await db.query(`SELECT value FROM config WHERE key = 'ganadores_fechas'`);
        let winners = [];
        if (existingRes.rows.length > 0) {
            try { winners = JSON.parse(existingRes.rows[0].value) } catch {}
        }
        winners.push(entry);
        await db.query(
            `INSERT INTO config (key, value, updated_at) VALUES ('ganadores_fechas', $1, NOW())
             ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
            [JSON.stringify(winners)]
        );
        console.log('[prode.set-winner] Winner image set:', event.matchdayLabel, '| total:', winners.length);
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    // Test: simulate full winner flow for a given user (generates FIFA card + saves to carousel)
    if (event.source === 'prode.test-winner-flow') {
        const { processWinnerNotification } = require('./routes/matchdays');
        const email = event.email || 'cfdelrio@gmail.com';
        const userRes = await db.query(
            `SELECT id, nombre, email, foto_url FROM users WHERE email = $1`, [email]
        );
        if (userRes.rows.length === 0) {
            console.error('[test-winner-flow] User not found:', email);
            return { statusCode: 404, body: JSON.stringify({ error: 'User not found' }) };
        }
        const user = userRes.rows[0];
        const winner = { user_id: user.id, user_name: user.nombre, user_avatar: user.foto_url || null, points: event.points || 42 };
        const matchday = { id: '00000000-0000-0000-0000-000000000001', name: event.matchdayName || 'Fecha de Prueba', tournament_id: null };
        await processWinnerNotification(winner, matchday, user.email, [user.email]);
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    // EventBridge daily backup trigger
    // Rule cron: 0 7 * * ? * (07:00 UTC = 04:00 Argentina)
    if (event.source === 'prode.backup-daily') {
        const backupService = require('./services/backupService');
        const [dump, snapshot] = await Promise.allSettled([
            backupService.exportDatabase({ trigger: 'scheduled' }),
            backupService.createSnapshot({ trigger: 'scheduled' }),
        ]);
        const result = {
            dump: dump.status === 'fulfilled' ? dump.value : { error: dump.reason?.message },
            snapshot: snapshot.status === 'fulfilled' ? snapshot.value : { error: snapshot.reason?.message },
        };
        console.log('[prode.backup-daily] result:', JSON.stringify(result));
        return { statusCode: 200, body: JSON.stringify(result) };
    }

    // EventBridge weekly summary trigger (nuevo diseño aprobado)
    // Rule cron: 0 12 ? * MON * (every Monday 12:00 UTC = 09:00 Argentina)
    if (event.source === 'prode.weekly' || event.source === 'weekly-digest' || event['detail-type'] === 'weekly-digest') {
        const { sendWeeklyEmailBatch } = require('./routes/admin');
        const testEmail = event.testEmail || null;
        const result = await sendWeeklyEmailBatch(testEmail);
        console.log('[prode.weekly] Weekly email batch result:', result);
        return { statusCode: 200, body: JSON.stringify(result) };
    }

    const response = await serverlessHandler(event, context);
    // Asegurarse de que los headers CORS estén presentes
    if (!response.headers) {
        response.headers = {};
    }
    // Solo agregar headers CORS si no están ya presentes
    // El middleware CORS ya los configura correctamente
    if (!response.headers['Access-Control-Allow-Origin'] && !response.headers['access-control-allow-origin']) {
        response.headers['Access-Control-Allow-Origin'] = event.headers?.origin || event.headers?.Origin || '*';
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, PATCH, OPTIONS';
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
        response.headers['Access-Control-Max-Age'] = '86400';
    }
    return response;
};
exports.handler = handler;
//# sourceMappingURL=lambda.js.map