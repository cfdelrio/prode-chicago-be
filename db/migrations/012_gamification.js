'use strict';

/**
 * Migration: Gamification tables
 *
 * Crea 3 tablas nuevas (solo aditivas, no modifica nada existente):
 *
 * 1. user_streaks — tracking de rachas de exactos consecutivos por planilla
 * 2. user_badges — logros desbloqueados por usuario (primer_exacto, racha_3, etc)
 * 3. user_rivalries — seguimiento de rivales para trash talk personalizado
 *
 * Idempotente: usa CREATE TABLE IF NOT EXISTS.
 */

async function migrate(db) {
    // 1. user_streaks: racha actual y mejor histórico por planilla
    await db.query(`
        CREATE TABLE IF NOT EXISTS user_streaks (
            planilla_id UUID NOT NULL REFERENCES planillas(id) ON DELETE CASCADE,
            streak_type VARCHAR(50) NOT NULL,
            current_streak INT NOT NULL DEFAULT 0,
            best_streak INT NOT NULL DEFAULT 0,
            last_match_id UUID REFERENCES matches(id) ON DELETE SET NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (planilla_id, streak_type)
        )
    `);
    console.log('  ✓ user_streaks created');

    // 2. user_badges: logros desbloqueados (1 por user+tipo)
    await db.query(`
        CREATE TABLE IF NOT EXISTS user_badges (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            badge_type VARCHAR(50) NOT NULL,
            badge_data JSONB,
            awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (user_id, badge_type)
        )
    `);
    await db.query(`
        CREATE INDEX IF NOT EXISTS idx_user_badges_user_id ON user_badges(user_id)
    `);
    console.log('  ✓ user_badges created');

    // 3. user_rivalries: rival tracking para trash talk
    await db.query(`
        CREATE TABLE IF NOT EXISTS user_rivalries (
            follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            rival_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            last_notified_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (follower_id, rival_id),
            CHECK (follower_id <> rival_id)
        )
    `);
    console.log('  ✓ user_rivalries created');
}

module.exports = { migrate };
