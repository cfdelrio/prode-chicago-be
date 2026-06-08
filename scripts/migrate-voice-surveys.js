'use strict';

require('dotenv').config();
const { db } = require('../db/connection');

async function migrate() {
    console.log('Creating voice survey tables...');

    await db.query(`
        CREATE TABLE IF NOT EXISTS voice_surveys (
            id           TEXT PRIMARY KEY,
            question     TEXT NOT NULL,
            options      JSONB NOT NULL DEFAULT '[]',
            status       TEXT DEFAULT 'pending',
            total_called INTEGER DEFAULT 0,
            created_at   TIMESTAMP DEFAULT NOW()
        )
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS voice_survey_responses (
            id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            survey_id    TEXT NOT NULL REFERENCES voice_surveys(id),
            call_sid     TEXT,
            phone_number TEXT,
            digit        TEXT,
            call_status  TEXT,
            created_at   TIMESTAMP DEFAULT NOW(),
            UNIQUE (survey_id, call_sid)
        )
    `);

    await db.query(`
        CREATE INDEX IF NOT EXISTS idx_vsr_survey_id ON voice_survey_responses(survey_id)
    `);

    console.log('✅ Done');
    process.exit(0);
}

migrate().catch(err => {
    console.error('Migration failed:', err.message);
    process.exit(1);
});
