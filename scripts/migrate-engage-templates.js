'use strict';

/**
 * migrate-engage-templates.js
 *
 * One-shot script to fix variable syntax in all 50 Engage templates.
 * Root cause: templates were created with un-prefixed variables ({{nombre}})
 * that Engage can't resolve. They need explicit scope prefixes:
 *   {{user.*}}             → contact store (auto-upserted from metadata)
 *   {{business_context.*}} → event payload
 *
 * Run:
 *   ENGAGE_API_URL=https://engage.orkestai.ar \
 *   ENGAGE_API_KEY=<key> \
 *   node scripts/migrate-engage-templates.js [--dry-run]
 *
 * --dry-run  Print what would change without making API calls.
 */

const axios = require('axios');

const DRY_RUN = process.argv.includes('--dry-run');
const API_URL = process.env.ENGAGE_API_URL || 'https://engage.orkestai.ar';
const API_KEY = process.env.ENGAGE_API_KEY || '';

if (!API_KEY) {
  console.error('❌  ENGAGE_API_KEY is required');
  process.exit(1);
}

const client = axios.create({
  baseURL: API_URL,
  headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
  timeout: 10_000,
});

// ── Variable replacement map ──────────────────────────────────────────────────
// Order matters: more specific patterns first (e.g. puntos_total before puntos).
// Each entry: [searchRegex, replacement]

const REPLACEMENTS = [
  // contact store — {{user.*}}
  [/\{\{nombre\}\}/g,       '{{user.nombre}}'],
  [/\{\{planilla\}\}/g,     '{{user.planilla_nombre}}'],
  [/\{\{torneo\}\}/g,       '{{user.tournament_name}}'],
  [/\{\{racha\}\}/g,        '{{user.current_streak}}'],
  [/\{\{puntos_total\}\}/g, '{{user.puntos_totales}}'],   // must be before {{puntos}}

  // event payload — {{business_context.*}}
  [/\{\{puntos\}\}/g,          '{{business_context.puntos}}'],
  [/\{\{posicion\}\}/g,        '{{business_context.posicion}}'],
  [/\{\{ranking\}\}/g,         '{{business_context.posicion}}'],
  [/\{\{delta\}\}/g,           '{{business_context.delta}}'],
  [/\{\{posiciones\}\}/g,      '{{business_context.posiciones}}'],
  [/\{\{local\}\}/g,           '{{business_context.match.local}}'],
  [/\{\{away\}\}/g,            '{{business_context.match.away}}'],
  [/\{\{goles_local\}\}/g,     '{{business_context.match.goles_local}}'],
  [/\{\{goles_visitante\}\}/g, '{{business_context.match.goles_visitante}}'],
  [/\{\{pred_local\}\}/g,      '{{business_context.bet.goles_local}}'],
  [/\{\{pred_visitante\}\}/g,  '{{business_context.bet.goles_visitante}}'],
  [/\{\{codigo\}\}/g,          '{{business_context.code}}'],
  [/\{\{horas\}\}/g,           '{{business_context.horas}}'],
  [/\{\{minutos\}\}/g,         '{{business_context.minutos}}'],
  [/\{\{exactos\}\}/g,         '{{business_context.exactos}}'],
  [/\{\{fecha_nombre\}\}/g,    '{{business_context.fecha_nombre}}'],
  [/\{\{ganador\}\}/g,         '{{business_context.ganador}}'],
  [/\{\{nueva_fecha\}\}/g,     '{{business_context.nueva_fecha}}'],
];

function applyReplacements(text) {
  if (!text) return text;
  let result = text;
  for (const [pattern, replacement] of REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function migrateTemplate(tpl) {
  const updated = { ...tpl };
  let changed = false;

  for (const field of ['subject', 'body', 'content', 'text', 'html', 'preview']) {
    if (typeof tpl[field] === 'string') {
      const migrated = applyReplacements(tpl[field]);
      if (migrated !== tpl[field]) {
        updated[field] = migrated;
        changed = true;
      }
    }
  }

  return { updated, changed };
}

// ── Duplicate detection ───────────────────────────────────────────────────────
// Same `name` → keep the one with the lexicographically largest ID (newest cuid2).
// The rest are duplicates to delete.

function findDuplicates(templates) {
  const byName = {};
  for (const tpl of templates) {
    if (!byName[tpl.name]) byName[tpl.name] = [];
    byName[tpl.name].push(tpl);
  }

  const toDelete = [];
  for (const [name, group] of Object.entries(byName)) {
    if (group.length <= 1) continue;
    // Sort descending by id (newest first) and keep only the first
    const sorted = group.sort((a, b) => (b.id > a.id ? 1 : -1));
    const [keep, ...dupes] = sorted;
    console.log(`  dup "${name}": keep ${keep.id}, delete ${dupes.map(d => d.id).join(', ')}`);
    toDelete.push(...dupes.map(d => d.id));
  }
  return toDelete;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔧 Engage template migration${DRY_RUN ? ' [DRY RUN]' : ''}`);
  console.log(`   API: ${API_URL}\n`);

  // 1. Fetch all templates
  const res = await client.get('/v1/templates', { params: { limit: 200 } });
  const templates = res.data?.templates ?? res.data?.data ?? res.data ?? [];
  console.log(`📋 Found ${templates.length} templates\n`);

  if (!Array.isArray(templates) || templates.length === 0) {
    console.log('No templates found — check API response shape:', JSON.stringify(res.data).slice(0, 300));
    process.exit(0);
  }

  // 2. Detect and delete duplicates
  console.log('🗑  Checking duplicates...');
  const toDelete = findDuplicates(templates);
  console.log(`   ${toDelete.length} duplicates to delete\n`);

  if (!DRY_RUN) {
    for (const id of toDelete) {
      try {
        await client.delete(`/v1/templates/${id}`);
        console.log(`   ✓ Deleted ${id}`);
      } catch (e) {
        console.warn(`   ⚠ Delete ${id} failed: ${e.response?.status} ${e.message}`);
      }
    }
  }

  // 3. Migrate variable syntax
  console.log('\n🔁 Migrating variable syntax...');
  let migrated = 0;
  let skipped  = 0;

  const deleteIds = new Set(toDelete);
  const unique = templates.filter(t => !deleteIds.has(t.id));

  for (const tpl of unique) {
    const { updated, changed } = migrateTemplate(tpl);
    if (!changed) { skipped++; continue; }

    console.log(`  → ${tpl.name} (${tpl.id})`);
    if (DRY_RUN) {
      // Show diff for changed fields
      for (const field of ['subject', 'body', 'content', 'text', 'html']) {
        if (tpl[field] !== updated[field]) {
          console.log(`     ${field}: ${tpl[field]?.slice(0, 80)} → ${updated[field]?.slice(0, 80)}`);
        }
      }
    } else {
      try {
        await client.put(`/v1/templates/${tpl.id}`, updated);
        console.log(`   ✓ Updated`);
        migrated++;
      } catch (e) {
        console.warn(`   ⚠ Update failed: ${e.response?.status} ${e.message}`);
      }
    }
    if (DRY_RUN) migrated++;
  }

  console.log(`\n✅ Done. Updated: ${migrated} | Unchanged: ${skipped} | Deleted: ${toDelete.length}`);
  if (DRY_RUN) console.log('   (dry run — no changes made)');
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
