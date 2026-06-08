"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recalculateTournamentRanking = exports.recalculateAllTournamentRankings = void 0;
const connection_1 = require("../db/connection");
const recalculateAllTournamentRankings = async () => {
    try {
        const tournaments = await connection_1.db.query('SELECT id FROM tournaments WHERE is_active = true');
        for (const tournament of tournaments.rows) {
            await (0, exports.recalculateTournamentRanking)(tournament.id);
        }
        console.log(`✅ Recalculated rankings for ${tournaments.rows.length} tournaments`);
    }
    catch (error) {
        console.error('Error recalculating tournament rankings:', error);
        throw error;
    }
};
exports.recalculateAllTournamentRankings = recalculateAllTournamentRankings;
const recalculateTournamentRanking = async (tournamentId) => {
    try {
        // REGLA DE NEGOCIO: el ranking de torneo es por planilla individual.
        // Si un usuario tiene N planillas, aparece N veces en el ranking.
        // El unique key es (tournament_id, planilla_id), NO (tournament_id, user_id).
        // Sumar puntos por usuario daría ventaja a quien compra más planillas.
        const betStats = await connection_1.db.query(`
      SELECT
        p.user_id,
        p.id as planilla_id,
        COUNT(DISTINCT s.match_id) as total_bets,
        COALESCE(SUM(s.puntos_obtenidos), 0) as total_points,
        COUNT(CASE WHEN s.puntos_obtenidos = 4 THEN 1 END) as exactos,
        COUNT(CASE WHEN s.puntos_obtenidos > 0 THEN 1 END) as aciertos
      FROM planillas p
      LEFT JOIN scores s ON s.planilla_id = p.id
      LEFT JOIN matches m ON s.match_id = m.id
      WHERE m.tournament_id = $1 AND m.estado = 'finished' AND p.precio_pagado = true
      GROUP BY p.user_id, p.id
    `, [tournamentId]);
        // Delete existing rankings for this tournament
        await connection_1.db.query('DELETE FROM tournament_rankings WHERE tournament_id = $1', [tournamentId]);
        // Insert new rankings — una fila por planilla
        for (const row of betStats.rows) {
            await connection_1.db.query(`
        INSERT INTO tournament_rankings (tournament_id, user_id, planilla_id, puntos, total_aciertos, total_exactos)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (tournament_id, planilla_id)
        DO UPDATE SET
          puntos = EXCLUDED.puntos,
          total_aciertos = EXCLUDED.total_aciertos,
          total_exactos = EXCLUDED.total_exactos,
          updated_at = NOW()
      `, [tournamentId, row.user_id, row.planilla_id, row.total_points, row.aciertos, row.exactos]);
        }
        // Update positions
        await connection_1.db.query(`
      WITH ranked AS (
        SELECT 
          id,
          ROW_NUMBER() OVER (ORDER BY puntos DESC, total_exactos DESC, total_aciertos DESC) as new_position
        FROM tournament_rankings
        WHERE tournament_id = $1
      )
      UPDATE tournament_rankings tr
      SET posicion = ranked.new_position
      FROM ranked
      WHERE tr.id = ranked.id AND tr.tournament_id = $1
    `, [tournamentId]);
        console.log(`✅ Tournament ranking recalculated for ${tournamentId}`);
        return true;
    }
    catch (error) {
        console.error('Error recalculating tournament ranking:', error);
        throw error;
    }
};
exports.recalculateTournamentRanking = recalculateTournamentRanking;
//# sourceMappingURL=tournamentRanking.js.map
