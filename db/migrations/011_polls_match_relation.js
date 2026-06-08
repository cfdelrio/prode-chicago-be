'use strict';

/**
 * Migration: Connect polls with matches
 *
 * Adds two columns:
 * - poll_options.team_name: the team name as stored in matches.home_team/away_team
 *   Used to JOIN/query match results for each poll option (loose text match).
 * - public_polls.winner_option_id: FK to the option that won the tournament.
 *   Set by admin when the final result is known. Enables "X% acertó" stats.
 */

async function migrate(db) {
    // 1. Add team_name to poll_options
    await db.query(`
        ALTER TABLE poll_options
        ADD COLUMN IF NOT EXISTS team_name VARCHAR(100)
    `);

    // Default team_name to label for existing rows (same text in this context)
    await db.query(`
        UPDATE poll_options SET team_name = label WHERE team_name IS NULL
    `);

    console.log('  ✓ poll_options.team_name added');

    // 2. Add winner_option_id to public_polls
    await db.query(`
        ALTER TABLE public_polls
        ADD COLUMN IF NOT EXISTS winner_option_id INT
            REFERENCES poll_options(id) ON DELETE SET NULL
    `);

    console.log('  ✓ public_polls.winner_option_id added');
}

module.exports = { migrate };
