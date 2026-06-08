'use strict';

/**
 * Migration: Create polls tables
 * Defines schema for public_polls, poll_options, and poll_votes
 */

async function migrate(db) {
    console.log('  Creating public_polls table...');

    await db.query(`
        CREATE TABLE IF NOT EXISTS public_polls (
            id         SERIAL PRIMARY KEY,
            slug       VARCHAR(100) UNIQUE NOT NULL,
            title      VARCHAR(300) NOT NULL,
            subtitle   VARCHAR(300),
            active     BOOLEAN DEFAULT true,
            ended      BOOLEAN DEFAULT false,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    console.log('  Creating poll_options table...');

    await db.query(`
        CREATE TABLE IF NOT EXISTS poll_options (
            id            SERIAL PRIMARY KEY,
            poll_id       INTEGER NOT NULL REFERENCES public_polls(id) ON DELETE CASCADE,
            label         VARCHAR(100) NOT NULL,
            flag_emoji    VARCHAR(20),
            flag_code     VARCHAR(5),
            display_order INTEGER DEFAULT 0
        )
    `);

    console.log('  Creating poll_votes table...');

    await db.query(`
        CREATE TABLE IF NOT EXISTS poll_votes (
            id            SERIAL PRIMARY KEY,
            poll_id       INTEGER NOT NULL REFERENCES public_polls(id) ON DELETE CASCADE,
            option_id     INTEGER NOT NULL REFERENCES poll_options(id),
            user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
            ip_hash       VARCHAR(64) NOT NULL,
            session_token VARCHAR(64),
            created_at    TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    console.log('  Creating poll indices...');

    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS poll_votes_ip_poll   ON poll_votes(poll_id, ip_hash)`);
    await db.query(`CREATE INDEX        IF NOT EXISTS poll_votes_option_id ON poll_votes(option_id)`);
    await db.query(`CREATE INDEX        IF NOT EXISTS poll_votes_created   ON poll_votes(created_at DESC)`);

    console.log('  ✓ polls tables created');

    // Seed poll mundial-2026
    const pollRes = await db.query(`
        INSERT INTO public_polls (slug, title, subtitle, active, ended)
        VALUES ($1, $2, $3, true, false)
        ON CONFLICT (slug) DO NOTHING
        RETURNING id
    `, [
        'mundial-2026',
        '⚽ ¿Quién pensás que sale campeón del mundo?',
        'Miles de futboleros ya dejaron su pronóstico.',
    ]);

    if (pollRes.rows.length === 0) {
        console.log('  ✓ poll mundial-2026 ya existe, saltando seed');
        return;
    }

    const pollId = pollRes.rows[0].id;
    console.log(`  ✓ poll mundial-2026 creado (id=${pollId})`);

    const options = [
        { label: 'Argentina',  flag_emoji: '🇦🇷', flag_code: 'AR', display_order: 1 },
        { label: 'Brasil',     flag_emoji: '🇧🇷', flag_code: 'BR', display_order: 2 },
        { label: 'Francia',    flag_emoji: '🇫🇷', flag_code: 'FR', display_order: 3 },
        { label: 'España',     flag_emoji: '🇪🇸', flag_code: 'ES', display_order: 4 },
        { label: 'Alemania',   flag_emoji: '🇩🇪', flag_code: 'DE', display_order: 5 },
        { label: 'Inglaterra', flag_emoji: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', flag_code: 'EN', display_order: 6 },
        { label: 'Portugal',   flag_emoji: '🇵🇹', flag_code: 'PT', display_order: 7 },
        { label: 'Otro',       flag_emoji: '🌍',   flag_code: 'XX', display_order: 8 },
    ];

    for (const opt of options) {
        await db.query(
            `INSERT INTO poll_options (poll_id, label, flag_emoji, flag_code, display_order)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
            [pollId, opt.label, opt.flag_emoji, opt.flag_code, opt.display_order]
        );
    }
    console.log(`  ✓ ${options.length} países insertados`);
}

module.exports = { migrate };
