"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notificationService = void 0;
exports.generarNotificacionKickoff = generarNotificacionKickoff;
const connection_1 = require("../db/connection");
exports.notificationService = {
    async crearNotificacion(userId, matchId, type, payload) {
        await connection_1.db.query(`
      INSERT INTO notifications (user_id, match_id, type, payload, status)
      VALUES ($1, $2, $3, $4, 'pending')
    `, [userId, matchId, type, JSON.stringify(payload)]);
    },
    async marcarEnviada(notificationId) {
        await connection_1.db.query(`
      UPDATE notifications SET status = 'sent', sent_at = NOW()
      WHERE id = $1
    `, [notificationId]);
    },
    async marcarFallida(notificationId, error) {
        await connection_1.db.query(`
      UPDATE notifications SET status = 'failed'
      WHERE id = $1
    `, [notificationId]);
        console.error(`Notification ${notificationId} failed:`, error);
    },
};
async function generarNotificacionKickoff(userId, matchId, homeTeam, awayTeam, type, startTime) {
    const title = type === 'kickoff' ? '¡Comienza el partido!' : '¡Segundo tiempo!';
    const body = type === 'kickoff'
        ? `${homeTeam} vs ${awayTeam} está por comenzar. ¡Mucha suerte!`
        : `${homeTeam} vs ${awayTeam} inicia el segundo tiempo. ¡Seguimos!`;
    await exports.notificationService.crearNotificacion(userId, matchId, type, {
        title,
        body,
        homeTeam,
        awayTeam,
        startTime: startTime.toISOString(),
        icon: 'soccer',
    });
}
//# sourceMappingURL=notificationService.js.map
