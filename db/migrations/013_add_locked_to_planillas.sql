-- Separate "locked" (user closed planilla) from "precio_pagado" (admin confirmed payment)
ALTER TABLE planillas ADD COLUMN IF NOT EXISTS locked BOOLEAN DEFAULT false;

-- Existing planillas with precio_pagado=true that were locked by users (not admin)
-- will be handled by a data migration: locked=true for all currently paid planillas
UPDATE planillas SET locked = true WHERE precio_pagado = true;
