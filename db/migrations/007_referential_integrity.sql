-- Migration 007: integridad referencial
--
-- 1. FK matches.tournament_id → tournaments(id) ON DELETE SET NULL
-- 2. FK matches.planilla_id   → planillas(id)   ON DELETE SET NULL
-- 3. audit_log.user_id        → ON DELETE SET NULL (era NO ACTION)
-- 4. config.updated_by        → ON DELETE SET NULL (era NO ACTION)
-- 5. reports.reviewed_by      → ON DELETE SET NULL (era NO ACTION)
-- 6. Índices en FK columns sin indexar (messages, message_counters, notifications)

-- ── 1 & 2. matches: agregar columnas si no existen, luego FK NOT VALID ─────────
-- NOT VALID: aplica solo a filas nuevas, no revalida historial
ALTER TABLE matches ADD COLUMN IF NOT EXISTS tournament_id UUID;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS planilla_id  UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'matches'::regclass
      AND contype = 'f'
      AND conkey @> ARRAY[(
        SELECT attnum FROM pg_attribute
        WHERE attrelid = 'matches'::regclass AND attname = 'tournament_id' AND attnum > 0
      )]
  ) THEN
    ALTER TABLE matches
      ADD CONSTRAINT matches_tournament_id_fkey
      FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE SET NULL
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'matches'::regclass
      AND contype = 'f'
      AND conkey @> ARRAY[(
        SELECT attnum FROM pg_attribute
        WHERE attrelid = 'matches'::regclass AND attname = 'planilla_id' AND attnum > 0
      )]
  ) THEN
    ALTER TABLE matches
      ADD CONSTRAINT matches_planilla_id_fkey
      FOREIGN KEY (planilla_id) REFERENCES planillas(id) ON DELETE SET NULL
      NOT VALID;
  END IF;
END $$;

-- ── 3. audit_log.user_id: cambiar a ON DELETE SET NULL ────────────────────────
DO $$
DECLARE v_name TEXT;
BEGIN
  SELECT conname INTO v_name
  FROM pg_constraint
  WHERE conrelid = 'audit_log'::regclass
    AND contype = 'f'
    AND conkey = ARRAY[(
      SELECT attnum FROM pg_attribute
      WHERE attrelid = 'audit_log'::regclass AND attname = 'user_id' AND attnum > 0
    )]
    AND confdeltype != 'n';  -- solo si aún NO es SET NULL
  IF v_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE audit_log DROP CONSTRAINT ' || quote_ident(v_name);
    ALTER TABLE audit_log
      ADD CONSTRAINT audit_log_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── 4. config.updated_by: cambiar a ON DELETE SET NULL ────────────────────────
DO $$
DECLARE v_name TEXT;
BEGIN
  SELECT conname INTO v_name
  FROM pg_constraint
  WHERE conrelid = 'config'::regclass
    AND contype = 'f'
    AND conkey = ARRAY[(
      SELECT attnum FROM pg_attribute
      WHERE attrelid = 'config'::regclass AND attname = 'updated_by' AND attnum > 0
    )]
    AND confdeltype != 'n';
  IF v_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE config DROP CONSTRAINT ' || quote_ident(v_name);
    ALTER TABLE config
      ADD CONSTRAINT config_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── 5. reports.reviewed_by: cambiar a ON DELETE SET NULL ─────────────────────
DO $$
DECLARE v_name TEXT;
BEGIN
  SELECT conname INTO v_name
  FROM pg_constraint
  WHERE conrelid = 'reports'::regclass
    AND contype = 'f'
    AND conkey = ARRAY[(
      SELECT attnum FROM pg_attribute
      WHERE attrelid = 'reports'::regclass AND attname = 'reviewed_by' AND attnum > 0
    )]
    AND confdeltype != 'n';
  IF v_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE reports DROP CONSTRAINT ' || quote_ident(v_name);
    ALTER TABLE reports
      ADD CONSTRAINT reports_reviewed_by_fkey
      FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── 6. Índices en FK columns sin indexar ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_matches_tournament_id    ON matches(tournament_id);
CREATE INDEX IF NOT EXISTS idx_matches_planilla_id      ON matches(planilla_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender_id       ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_receiver_id     ON messages(receiver_id);
CREATE INDEX IF NOT EXISTS idx_msg_counters_user_a      ON message_counters(user_a);
CREATE INDEX IF NOT EXISTS idx_msg_counters_user_b      ON message_counters(user_b);
CREATE INDEX IF NOT EXISTS idx_notifications_match_id   ON notifications(match_id);
