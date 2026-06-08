'use strict';

/**
 * Migration: Create voice survey tables
 * Defines schema for voice survey and response tracking
 */

async function migrate(db) {
    console.log('  Creating voice_surveys table...');

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

    console.log('  Creating voice_survey_responses table...');

    await db.query(`
        CREATE TABLE IF NOT EXISTS voice_survey_responses (
            id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            survey_id    TEXT NOT NULL REFERENCES voice_surveys(id) ON DELETE CASCADE,
            call_sid     TEXT,
            phone_number TEXT,
            digit        TEXT,
            call_status  TEXT,
            created_at   TIMESTAMP DEFAULT NOW(),
            UNIQUE (survey_id, call_sid)
        )
    `);

    console.log('  Creating voice survey indices...');

    await db.query(`
        CREATE INDEX IF NOT EXISTS idx_vsr_survey_id
        ON voice_survey_responses(survey_id)
    `);

    console.log('  ✓ voice survey tables created');
}

module.exports = { migrate };
