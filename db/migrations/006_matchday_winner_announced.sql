-- Migration: agregar winner_announced_at a matchdays
-- Permite deduplicar la notificación de ganador: una vez enviada, no se re-envía
-- aunque el admin publique un resultado corregido.

ALTER TABLE matchdays
  ADD COLUMN IF NOT EXISTS winner_announced_at TIMESTAMPTZ;
