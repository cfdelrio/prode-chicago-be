// Migration: add locked column to planillas, separate from precio_pagado.
// precio_pagado = admin-managed payment status (never blocks bet edits)
// locked        = user-triggered freeze (blocks bet edits)

exports.up = async (db) => {
  await db.query(`
    ALTER TABLE planillas
    ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT false
  `);
};

exports.down = async (db) => {
  await db.query(`ALTER TABLE planillas DROP COLUMN IF EXISTS locked`);
};
