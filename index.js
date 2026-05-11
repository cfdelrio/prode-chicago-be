"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const config_1 = require("./config");
const middleware_1 = require("./middleware");
const rateLimit_1 = require("./middleware/rateLimit");
const routes_1 = require("./routes");
const connection_1 = require("./db/connection");
const app = (0, express_1.default)();
app.use(middleware_1.securityMiddleware);
app.use(middleware_1.corsMiddleware);
app.use(middleware_1.compressionMiddleware);
app.use(middleware_1.loggingMiddleware);
app.use(express_1.default.json({ limit: '10mb' }));
app.use(express_1.default.urlencoded({ extended: true }));
app.get('/health', (req, res) => {
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
app.use('/api/teams', routes_1.teamsRoutes);
app.use('/api/matchdays', routes_1.matchdaysRoutes);
app.use('/api/push', routes_1.pushRoutes);
app.use('/api/admin', routes_1.adminRoutes);
app.use('/api/admin/backups', routes_1.backupsRoutes);
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
const startServer = async () => {
    try {
        await connection_1.db.query('SELECT 1');
        console.log('Database connected');
        app.listen(config_1.config.port, () => {
            console.log(`Server running on port ${config_1.config.port}`);
            console.log(`Environment: ${config_1.config.nodeEnv}`);
        });
    }
    catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
};
startServer();
exports.default = app;
//# sourceMappingURL=index.js.map