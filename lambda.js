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
const { sendWhatsApp } = require('./services/whatsapp');
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
app.use('/api/voice', routes_1.voiceRoutes);
app.use('/api/public/polls', routes_1.pollsRoutes);
app.post('/api/internal/broadcast-whatsapp', authMiddleware, requireAdmin, async (req, res) => {
    try {
        const { message } = req.body;
        if (!message || !message.trim()) {
            return res.status(400).json({ success: false, error: 'Mensaje requerido' });
        }
        if (process.env.ENGAGE_ENABLED === 'true') {
            const { sendEventBatch } = require('./services/engageClient');
            const { buildEngageMetadata } = require('./utils/engageHelpers');
            const usersRes = await db.query(
                `SELECT id, nombre, email, whatsapp_number, whatsapp_consent,
                        tema_equipo, foto_url, created_at, rol, idioma_pref
                 FROM users
                 WHERE whatsapp_number IS NOT NULL AND whatsapp_consent = true`
            );
            const events = usersRes.rows.map(u => ({
                type: 'prode.broadcast_manual',
                userId: String(u.id),
                payload: {
                    business_context: { message },
                },
                metadata: buildEngageMetadata(u),
            }));
            if (events.length > 0) {
                await sendEventBatch(events);
            }
            console.log(`[broadcast-whatsapp] engage batch queued: ${events.length} users`);
            return res.json({ success: true, data: { total: events.length, sent: events.length, failed: 0 } });
        }
        const result = await db.query(
            `SELECT whatsapp_number FROM users WHERE whatsapp_number IS NOT NULL AND whatsapp_consent = true`
        );
        const numbers = result.rows.map(r => r.whatsapp_number);
        let sent = 0, failed = 0;
        const results = await runConcurrent(numbers, (number) =>
            sendWhatsApp({ to: number, body: message }), 10);
        for (const r of results) {
            if (r.status === 'fulfilled') sent++;
            else { failed++; console.error(`[broadcast-whatsapp] error:`, r.reason?.message); }
        }
        console.log(`[broadcast-whatsapp] total=${numbers.length} sent=${sent} failed=${failed}`);
        res.json({ success: true, data: { total: numbers.length, sent, failed } });
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
        await db.query(
            `INSERT INTO config (key, value, updated_at) VALUES ('ganador_fecha', $1, NOW())
             ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
            [JSON.stringify(entry)]
        );
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

    // Test: simulate full winner flow for a given user
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

    // EventBridge weekly summary trigger
    if (event.source === 'prode.weekly' || event.source === 'weekly-digest' || event['detail-type'] === 'weekly-digest') {
        const { sendWeeklyEmailBatch } = require('./routes/admin');
        const testEmail = event.testEmail || null;
        const result = await sendWeeklyEmailBatch(testEmail);
        console.log('[prode.weekly] Weekly email batch result:', result);
        return { statusCode: 200, body: JSON.stringify(result) };
    }

    // EventBridge pre-cutoff reminder (every 10 min)
    if (event.source === 'prode.reminder-cutoff' || event['detail-type'] === 'reminder-cutoff') {
        const { runCutoffReminders } = require('./services/reminderCutoff');
        const { runTournamentReminders } = require('./services/reminderTournament');
        const [cutoffResult, tournamentResult] = await Promise.all([
            runCutoffReminders(),
            runTournamentReminders(),
        ]);
        console.log('[prode.reminder-cutoff] Result:', cutoffResult);
        console.log('[prode.tournament-reminder] Result:', tournamentResult);
        return { statusCode: 200, body: JSON.stringify({ cutoff: cutoffResult, tournament: tournamentResult }) };
    }

    // EventBridge scheduled jobs processor (kickoff/second_half + opt-in bet_reminders)
    if (event.source === 'prode.process-jobs') {
        const { schedulerService } = require('./workers/schedulerService');
        const { processBetReminders } = require('./services/betReminders');
        await schedulerService.processPendingJobs();
        const brResult = await processBetReminders();
        console.log('[prode.process-jobs] Pending jobs processed. bet_reminders:', brResult);
        return { statusCode: 200, body: JSON.stringify({ success: true, bet_reminders: brResult }) };
    }

    // EventBridge daily: payment reminder for unpaid planillas
    if (event.source === 'prode.payment-reminder' || event['detail-type'] === 'payment-reminder') {
        const { runPaymentReminders } = require('./services/reminderPayment');
        const result = await runPaymentReminders();
        console.log('[prode.payment-reminder] Result:', result);
        return { statusCode: 200, body: JSON.stringify(result) };
    }

    // EventBridge daily: T-5d voice survey for users with pending bets (via Engage / voice.orkestai)
    if (event.source === 'prode.voice-5day-reminder' || event['detail-type'] === 'voice-5day-reminder') {
        const { runVoice5dayReminders } = require('./services/voice5dayReminder');
        const result = await runVoice5dayReminders();
        console.log('[prode.voice-5day-reminder] Result:', result);
        return { statusCode: 200, body: JSON.stringify(result) };
    }

    if (event.source === 'prode.voice-match-reminder' || event['detail-type'] === 'voice-match-reminder') {
        const { runVoiceMatchReminders } = require('./services/voiceMatchReminder');
        const result = await runVoiceMatchReminders();
        console.log('[prode.voice-match-reminder] Result:', result);
        return { statusCode: 200, body: JSON.stringify(result) };
    }

    // Ad-hoc query: matches with cutoff in the next N minutes
    if (event.source === 'prode.upcoming-cutoffs') {
        const minutes = Math.min(event.minutes || 60, 1440);
        const result = await db.query(`
            SELECT id, home_team, away_team, estado, time_cutoff, start_time,
                   ROUND(EXTRACT(EPOCH FROM (time_cutoff - NOW())) / 60) AS min_until_cutoff
            FROM matches
            WHERE estado = 'scheduled'
              AND time_cutoff IS NOT NULL
              AND time_cutoff BETWEEN NOW() AND NOW() + ($1 || ' minutes')::INTERVAL
            ORDER BY time_cutoff ASC
        `, [minutes]);
        console.log(`[prode.upcoming-cutoffs] ${result.rows.length} matches in next ${minutes} min`);
        result.rows.forEach(m => console.log(`  ${m.home_team} vs ${m.away_team} — cierra en ${m.min_until_cutoff} min`));
        return { statusCode: 200, body: JSON.stringify({ count: result.rows.length, window_minutes: minutes, matches: result.rows }) };
    }

    // EventBridge voice survey trigger
    if (event.source === 'prode.voice-survey') {
        const { runVoiceSurvey } = require('./services/voiceSurvey');
        const result = await runVoiceSurvey({
            surveyId: event.surveyId,
            question:  event.question,
            options:   event.options || [],
            userIds:   event.userIds || null,
        });
        console.log('[prode.voice-survey] Result:', result);
        return { statusCode: 200, body: JSON.stringify(result) };
    }

    const response = await serverlessHandler(event, context);
    if (!response.headers) {
        response.headers = {};
    }
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
