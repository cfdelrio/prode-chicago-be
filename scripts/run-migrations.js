'use strict';

require('dotenv').config();
// config/index.js throws if JWT_SECRET is missing in production.
// Migration scripts don't use JWT — set a dummy to satisfy the check.
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'migration-no-jwt-needed';

const { db } = require('../db/connection');
const fs = require('fs');
const path = require('path');

/**
 * Migration runner with idempotent schema_migrations tracking
 * - Creates schema_migrations table if it doesn't exist
 * - Reads all .js files from db/migrations/ in alphabetical order
 * - Checks which have already been executed
 * - Runs only pending migrations
 * - Records each execution
 */
async function initSchemaMigrationsTable() {
    console.log('Initializing schema_migrations table...');

    await db.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            filename TEXT PRIMARY KEY,
            executed_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    console.log('✓ schema_migrations table ready');
}

async function getExecutedMigrations() {
    const result = await db.query(
        'SELECT filename FROM schema_migrations ORDER BY filename'
    );
    return result.rows.map(row => row.filename);
}

async function recordMigration(filename) {
    await db.query(
        'INSERT INTO schema_migrations (filename, executed_at) VALUES ($1, NOW())',
        [filename]
    );
}

async function runMigrations() {
    try {
        console.log('🚀 Starting migration runner...\n');

        // Initialize tracking table
        await initSchemaMigrationsTable();

        // Get list of already executed migrations
        const executed = await getExecutedMigrations();
        console.log(`Previously executed migrations: ${executed.length || 'none'}`);
        if (executed.length > 0) {
            executed.forEach(m => console.log(`  ✓ ${m}`));
        }
        console.log('');

        // Read migration files from db/migrations/
        const migrationsDir = path.join(__dirname, '../db/migrations');
        const files = fs.readdirSync(migrationsDir)
            .filter(f => f.endsWith('.js'))
            .sort();

        if (files.length === 0) {
            console.log('ℹ No migration files found');
            process.exit(0);
        }

        // Find pending migrations
        const pending = files.filter(f => !executed.includes(f));

        if (pending.length === 0) {
            console.log('✓ All migrations already executed');
            process.exit(0);
        }

        console.log(`Found ${pending.length} pending migration(s):\n`);

        // Execute pending migrations in order
        for (const filename of pending) {
            const filepath = path.join(migrationsDir, filename);

            try {
                console.log(`⏳ Running: ${filename}`);

                // Load migration module and verify it exports async function migrate(db)
                const migrationModule = require(filepath);

                if (typeof migrationModule.migrate !== 'function') {
                    throw new Error(
                        `Migration ${filename} must export an async function 'migrate(db)'`
                    );
                }

                // Run the migration
                await migrationModule.migrate(db);

                // Record successful execution
                await recordMigration(filename);
                console.log(`✓ ${filename} executed successfully\n`);

            } catch (error) {
                console.error(`\n❌ Migration failed: ${filename}`);
                console.error(`   Error: ${error.message}`);
                throw error;
            }
        }

        console.log(`✅ All ${pending.length} migration(s) completed successfully!`);
        process.exit(0);

    } catch (error) {
        console.error('\n❌ Migration runner failed');
        console.error(`   ${error.message}`);
        process.exit(1);
    }
}

// Run if invoked directly
if (require.main === module) {
    runMigrations();
}

module.exports = { runMigrations };
