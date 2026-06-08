-- La voz de la hinchada — public polls
-- Run via prode-sql-temp Lambda:
-- aws lambda invoke --function-name prode-sql-temp \
--   --payload "$(echo '{"sql":"<statement>"}' | base64)" \
--   --cli-binary-format raw-in-base64-out out.json
--
-- Ejecutar cada bloque por separado en prode-sql-temp.

-- 1. Tablas
CREATE TABLE IF NOT EXISTS public_polls (
  id          SERIAL PRIMARY KEY,
  slug        VARCHAR(100) UNIQUE NOT NULL,
  title       VARCHAR(300) NOT NULL,
  subtitle    VARCHAR(300),
  active      BOOLEAN DEFAULT true,
  ended       BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS poll_options (
  id            SERIAL PRIMARY KEY,
  poll_id       INTEGER NOT NULL REFERENCES public_polls(id) ON DELETE CASCADE,
  label         VARCHAR(100) NOT NULL,
  flag_emoji    VARCHAR(20),
  flag_code     VARCHAR(5),
  display_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS poll_votes (
  id             SERIAL PRIMARY KEY,
  poll_id        INTEGER NOT NULL REFERENCES public_polls(id) ON DELETE CASCADE,
  option_id      INTEGER NOT NULL REFERENCES poll_options(id),
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ip_hash        VARCHAR(64) NOT NULL,
  session_token  VARCHAR(64),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS poll_votes_ip_poll   ON poll_votes(poll_id, ip_hash);
CREATE INDEX        IF NOT EXISTS poll_votes_option_id ON poll_votes(option_id);
CREATE INDEX        IF NOT EXISTS poll_votes_created   ON poll_votes(created_at DESC);

-- 2. Seed poll mundial-2026
INSERT INTO public_polls (slug, title, subtitle, active, ended)
VALUES (
  'mundial-2026',
  '⚽ ¿Quién pensás que sale campeón del mundo?',
  'Miles de futboleros ya dejaron su pronóstico.',
  true,
  false
) ON CONFLICT (slug) DO NOTHING;

-- 3. Seed opciones (ejecutar después del INSERT anterior)
DO $$
DECLARE v_poll_id INTEGER;
BEGIN
  SELECT id INTO v_poll_id FROM public_polls WHERE slug = 'mundial-2026';
  IF v_poll_id IS NULL THEN RAISE EXCEPTION 'Poll not found'; END IF;
  INSERT INTO poll_options (poll_id, label, flag_emoji, flag_code, display_order) VALUES
    (v_poll_id, 'Argentina', '🇦🇷', 'AR', 1),
    (v_poll_id, 'Brasil',    '🇧🇷', 'BR', 2),
    (v_poll_id, 'Francia',   '🇫🇷', 'FR', 3),
    (v_poll_id, 'España',    '🇪🇸', 'ES', 4),
    (v_poll_id, 'Alemania',  '🇩🇪', 'DE', 5),
    (v_poll_id, 'Inglaterra','🏴󠁧󠁢󠁥󠁮󠁧󠁿', 'EN', 6),
    (v_poll_id, 'Portugal',  '🇵🇹', 'PT', 7),
    (v_poll_id, 'Otro',      '🌍',  'XX', 8)
  ON CONFLICT DO NOTHING;
END $$;
