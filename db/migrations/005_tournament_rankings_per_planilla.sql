-- Migration: tournament_rankings per-planilla (no per-user)
-- Business rule: el ranking de torneo se calcula por planilla individual.
-- Si un usuario tiene N planillas, debe aparecer N veces en el ranking del torneo.
-- Sumar puntos por usuario daría ventaja a quien compra más planillas.

-- 1. Agregar planilla_id (FK a planillas)
ALTER TABLE tournament_rankings
  ADD COLUMN IF NOT EXISTS planilla_id UUID REFERENCES planillas(id) ON DELETE CASCADE;

-- 2. Dropear la unique constraint vieja (tournament_id, user_id)
-- Nota: el nombre del constraint depende de cómo fue creado originalmente
DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    SELECT conname INTO constraint_name
    FROM pg_constraint
    WHERE conrelid = 'tournament_rankings'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) LIKE '%user_id%'
      AND pg_get_constraintdef(oid) NOT LIKE '%planilla_id%'
    LIMIT 1;

    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE tournament_rankings DROP CONSTRAINT %I', constraint_name);
    END IF;
END $$;

-- 3. Limpiar filas existentes (se recalculan al primer recalc del torneo)
DELETE FROM tournament_rankings;

-- 4. Hacer planilla_id NOT NULL después de limpiar
ALTER TABLE tournament_rankings ALTER COLUMN planilla_id SET NOT NULL;

-- 5. Crear nueva unique constraint (tournament_id, planilla_id)
ALTER TABLE tournament_rankings
  ADD CONSTRAINT tournament_rankings_tournament_id_planilla_id_key
  UNIQUE (tournament_id, planilla_id);

-- 6. Índice para consultas por planilla
CREATE INDEX IF NOT EXISTS idx_tournament_rankings_planilla
  ON tournament_rankings(planilla_id);
