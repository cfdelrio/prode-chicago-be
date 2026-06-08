"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const connection_1 = require("../db/connection");
const scoring_1 = require("../services/scoring");
const tournamentRanking_1 = require("../services/tournamentRanking");

function calculateScore(betHome, betAway, resHome, resAway) {
    const bet = { goles_local: betHome, goles_visitante: betAway };
    const result = { resultado_local: resHome, resultado_visitante: resAway };
    const scoreResult = scoring_1.calcularPuntaje(bet, result);
    return {
        points: scoreResult.puntos,
        bonus: scoreResult.bonus,
        detail: JSON.stringify(scoreResult.detalle)
    };
}

async function applyMigration005() {
    const colCheck = await connection_1.db.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'tournament_rankings' AND column_name = 'planilla_id'
    `);
    if (colCheck.rows.length > 0) {
        console.log('✅ Migration 005: already applied');
        return;
    }
    console.log('🔧 Applying migration 005: tournament_rankings per planilla...');
    await connection_1.db.query(`ALTER TABLE tournament_rankings ADD COLUMN planilla_id UUID REFERENCES planillas(id) ON DELETE CASCADE`);
    await connection_1.db.query(`
        DO $$
        DECLARE constraint_name TEXT;
        BEGIN
            SELECT conname INTO constraint_name FROM pg_constraint
            WHERE conrelid = 'tournament_rankings'::regclass AND contype = 'u'
                AND pg_get_constraintdef(oid) LIKE '%user_id%'
                AND pg_get_constraintdef(oid) NOT LIKE '%planilla_id%'
            LIMIT 1;
            IF constraint_name IS NOT NULL THEN
                EXECUTE format('ALTER TABLE tournament_rankings DROP CONSTRAINT %I', constraint_name);
            END IF;
        END $$;
    `);
    await connection_1.db.query('DELETE FROM tournament_rankings');
    await connection_1.db.query('ALTER TABLE tournament_rankings ALTER COLUMN planilla_id SET NOT NULL');
    await connection_1.db.query(`ALTER TABLE tournament_rankings ADD CONSTRAINT tournament_rankings_tournament_id_planilla_id_key UNIQUE (tournament_id, planilla_id)`);
    await connection_1.db.query(`CREATE INDEX IF NOT EXISTS idx_tournament_rankings_planilla ON tournament_rankings(planilla_id)`);
    console.log('✅ Migration 005 applied');
}

async function recalculateScores() {
    await applyMigration005();
    console.log('🏆 Calculando scores...');
    // Solo matches finalizados con resultado válido
    const matchesResult = await connection_1.db.query(`
        SELECT id, resultado_local, resultado_visitante
        FROM matches
        WHERE estado = 'finished'
          AND resultado_local IS NOT NULL
          AND resultado_visitante IS NOT NULL
    `);
    let scoreCount = 0;
    for (const match of matchesResult.rows) {
        const betsResult = await connection_1.db.query('SELECT * FROM bets WHERE match_id = $1', [match.id]);
        for (const bet of betsResult.rows) {
            const score = calculateScore(bet.goles_local, bet.goles_visitante, match.resultado_local, match.resultado_visitante);
            await connection_1.db.query(`INSERT INTO scores (planilla_id, match_id, puntos_obtenidos, bonus_aplicado, detalle_json)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (planilla_id, match_id) DO UPDATE SET
           puntos_obtenidos = EXCLUDED.puntos_obtenidos,
           bonus_aplicado = EXCLUDED.bonus_aplicado,
           detalle_json = EXCLUDED.detalle_json`, [bet.planilla_id, match.id, score.points, score.bonus, score.detail]);
            scoreCount++;
        }
    }
    console.log(`✅ ${scoreCount} scores calculados`);

    // Limpiar scores huérfanos: rows de scores cuyo match ya no está 'finished'
    // (admin revirtió el resultado). Si no se borran, el ranking los seguiría
    // sumando porque el LEFT JOIN preserva la fila aunque m no matchee.
    const orphanRes = await connection_1.db.query(`
        DELETE FROM scores WHERE match_id IN (
            SELECT id FROM matches WHERE estado != 'finished'
        )
    `);
    console.log(`🧹 Scores huérfanos borrados: ${orphanRes.rowCount}`);

    console.log('📈 Actualizando ranking...');
    // Lógica idéntica a actualizarRanking() en routes/matches.js
    // 1. Insertar/actualizar agregados para TODAS las planillas (no filtrar por precio_pagado)
    await connection_1.db.query(`
    INSERT INTO ranking (
      planilla_id,
      puntos_totales,
      exactos_count,
      aciertos_celeste,
      aciertos_rojo,
      aciertos_verde,
      aciertos_amarillo,
      updated_at
    )
    SELECT
      p.id as planilla_id,
      COALESCE(SUM(s.puntos_obtenidos) FILTER (WHERE m.estado = 'finished'), 0) as puntos_totales,
      COUNT(s.id) FILTER (WHERE s.puntos_obtenidos >= 3 AND m.estado = 'finished') as exactos_count,
      COUNT(s.id) FILTER (WHERE s.puntos_obtenidos = 4 AND m.estado = 'finished') as aciertos_celeste,
      COUNT(s.id) FILTER (WHERE s.puntos_obtenidos = 3 AND m.estado = 'finished') as aciertos_rojo,
      COUNT(s.id) FILTER (WHERE s.puntos_obtenidos = 2 AND m.estado = 'finished') as aciertos_verde,
      COUNT(s.id) FILTER (WHERE s.puntos_obtenidos = 1 AND m.estado = 'finished') as aciertos_amarillo,
      NOW() as updated_at
    FROM planillas p
    LEFT JOIN scores s ON p.id = s.planilla_id
    LEFT JOIN matches m ON s.match_id = m.id AND m.estado = 'finished'
    GROUP BY p.id
    ON CONFLICT (planilla_id) DO UPDATE SET
      puntos_totales = EXCLUDED.puntos_totales,
      exactos_count = EXCLUDED.exactos_count,
      aciertos_celeste = EXCLUDED.aciertos_celeste,
      aciertos_rojo = EXCLUDED.aciertos_rojo,
      aciertos_verde = EXCLUDED.aciertos_verde,
      aciertos_amarillo = EXCLUDED.aciertos_amarillo,
      updated_at = NOW()
  `);

    // 2. Limpiar posiciones de planillas no pagadas
    await connection_1.db.query(`
    UPDATE ranking r
    SET position = NULL
    FROM planillas p
    WHERE r.planilla_id = p.id AND p.precio_pagado = false
  `);

    // 3. Calcular posiciones solo para planillas pagadas con criterios de desempate oficiales
    await connection_1.db.query(`
    WITH ranked AS (
      SELECT r.id, ROW_NUMBER() OVER (
        ORDER BY
          r.puntos_totales DESC,
          r.aciertos_celeste DESC,
          r.aciertos_rojo DESC,
          r.aciertos_verde DESC,
          r.aciertos_amarillo DESC
      ) as position
      FROM ranking r
      JOIN planillas p ON r.planilla_id = p.id
      WHERE p.precio_pagado = true
    )
    UPDATE ranking r SET position = ranked.position FROM ranked WHERE r.id = ranked.id
  `);
    console.log('✅ Ranking actualizado');

    // 4. Recalcular rankings de torneos activos (mismo behavior que matches.js en runtime)
    console.log('🏟️  Actualizando rankings de torneos...');
    await (0, tournamentRanking_1.recalculateAllTournamentRankings)();
    console.log('✅ Tournament rankings actualizados');

    process.exit(0);
}
recalculateScores().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
//# sourceMappingURL=recalculateScores.js.map
