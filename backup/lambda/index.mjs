import { Client } from 'pg';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { gzipSync } from 'node:zlib';

const BUCKET = process.env.BACKUP_BUCKET;
const REGION = process.env.AWS_REGION || 'us-east-1';

const s3 = new S3Client({ region: REGION });

async function getTables(client) {
  const res = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  return res.rows.map((r) => r.table_name);
}

async function getCreateTable(client, table) {
  const cols = await client.query(
    `SELECT column_name, data_type, udt_name, character_maximum_length,
            is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table]
  );

  const pks = await client.query(
    `SELECT a.attname
     FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = $1::regclass AND i.indisprimary`,
    [`public."${table}"`]
  );

  const colDefs = cols.rows.map((c) => {
    let type = c.data_type;
    if (type === 'USER-DEFINED' || type === 'ARRAY') type = c.udt_name;
    if (c.character_maximum_length) type += `(${c.character_maximum_length})`;
    let def = `  "${c.column_name}" ${type}`;
    if (c.column_default) def += ` DEFAULT ${c.column_default}`;
    if (c.is_nullable === 'NO') def += ' NOT NULL';
    return def;
  });

  if (pks.rows.length > 0) {
    const pkCols = pks.rows.map((r) => `"${r.attname}"`).join(', ');
    colDefs.push(`  PRIMARY KEY (${pkCols})`);
  }

  return `CREATE TABLE IF NOT EXISTS "${table}" (\n${colDefs.join(',\n')}\n);`;
}

function escapeValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (Buffer.isBuffer(v)) return `'\\x${v.toString('hex')}'`;
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function dumpTableData(client, table) {
  const res = await client.query(`SELECT * FROM "${table}"`);
  if (res.rows.length === 0) return '';
  const cols = res.fields.map((f) => `"${f.name}"`).join(', ');
  const lines = res.rows.map((row) => {
    const values = res.fields.map((f) => escapeValue(row[f.name])).join(', ');
    return `INSERT INTO "${table}" (${cols}) VALUES (${values});`;
  });
  return lines.join('\n');
}

async function getSequences(client) {
  const res = await client.query(`
    SELECT sequence_name FROM information_schema.sequences
    WHERE sequence_schema = 'public'
  `);
  const stmts = [];
  for (const { sequence_name } of res.rows) {
    const v = await client.query(`SELECT last_value FROM "${sequence_name}"`);
    stmts.push(`SELECT setval('"${sequence_name}"', ${v.rows[0].last_value});`);
  }
  return stmts.join('\n');
}

export const handler = async (event = {}) => {
  if (!BUCKET) throw new Error('BACKUP_BUCKET env var is required');

  const startedAt = Date.now();
  const date = new Date().toISOString().slice(0, 10);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const key = event.key || `db/${date}/prode-${ts}.sql.gz`;

  const client = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 240000,
  });

  await client.connect();
  try {
    const tables = await getTables(client);
    const parts = [
      `-- prode-backup`,
      `-- generated_at: ${new Date().toISOString()}`,
      `-- database: ${process.env.DB_NAME}`,
      `-- tables: ${tables.length}`,
      ``,
      `BEGIN;`,
      `SET session_replication_role = 'replica';`,
      ``,
    ];

    for (const table of tables) {
      parts.push(`-- ===== ${table} =====`);
      parts.push(await getCreateTable(client, table));
      parts.push(`TRUNCATE TABLE "${table}" CASCADE;`);
      const data = await dumpTableData(client, table);
      if (data) parts.push(data);
      parts.push('');
    }

    parts.push('-- ===== sequences =====');
    parts.push(await getSequences(client));
    parts.push('');
    parts.push(`SET session_replication_role = 'origin';`);
    parts.push(`COMMIT;`);

    const sql = parts.join('\n');
    const gz = gzipSync(sql);

    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: gz,
        ContentType: 'application/gzip',
        Metadata: {
          tables: String(tables.length),
          'generated-at': new Date().toISOString(),
          'raw-size': String(sql.length),
        },
      })
    );

    return {
      ok: true,
      bucket: BUCKET,
      key,
      tables: tables.length,
      rawBytes: sql.length,
      gzippedBytes: gz.length,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await client.end();
  }
};
