-- Migration 008: unlock_requests.admin_id → ON DELETE SET NULL
--
-- La tabla unlock_requests se crea inline en routes/bets.js con:
--   admin_id UUID REFERENCES users(id)   -- sin ON DELETE → default NO ACTION
--
-- Si se elimina el usuario admin que aprobó/rechazó la solicitud,
-- PostgreSQL bloquearía el DELETE. Con SET NULL el registro histórico
-- queda intacto pero admin_id = NULL.

DO $$
DECLARE v_name TEXT;
BEGIN
  SELECT conname INTO v_name
  FROM pg_constraint
  WHERE conrelid = 'unlock_requests'::regclass
    AND contype = 'f'
    AND conkey = ARRAY[(
      SELECT attnum FROM pg_attribute
      WHERE attrelid = 'unlock_requests'::regclass AND attname = 'admin_id' AND attnum > 0
    )]
    AND confdeltype != 'n';  -- solo si aún NO es SET NULL
  IF v_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE unlock_requests DROP CONSTRAINT ' || quote_ident(v_name);
    ALTER TABLE unlock_requests
      ADD CONSTRAINT unlock_requests_admin_id_fkey
      FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;
