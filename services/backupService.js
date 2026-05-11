"use strict";

const zlib = require('zlib');
const { Readable } = require('stream');
const AWS = require('aws-sdk');
const { db } = require('../db/connection');

const REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET = process.env.BACKUP_BUCKET || 'prodecaballito-backups';
const DB_PREFIX = 'db/';
const RDS_INSTANCE_ID = process.env.RDS_INSTANCE_ID || 'prode-db';

const s3 = new AWS.S3({ region: REGION });
const rds = new AWS.RDS({ region: REGION });

// ── SQL serialization helpers ────────────────────────────────────────────────

function quoteIdent(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
}

function quoteValue(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (v instanceof Date) return "'" + v.toISOString() + "'";
    if (Buffer.isBuffer(v)) return "'\\x" + v.toString('hex') + "'";
    if (typeof v === 'object') return "'" + JSON.stringify(v).replace(/'/g, "''") + "'::jsonb";
    return "'" + String(v).replace(/'/g, "''") + "'";
}

async function listTables() {
    const res = await db.query(`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
        ORDER BY tablename
    `);
    return res.rows.map(r => r.tablename);
}

// Yields SQL chunks for the entire dump.
async function* dumpChunks() {
    yield `-- prodecaballito DB backup\n-- Generated: ${new Date().toISOString()}\n\n`;
    yield `SET statement_timeout = 0;\nSET client_encoding = 'UTF8';\nSET standard_conforming_strings = on;\n\n`;

    const tables = await listTables();
    for (const table of tables) {
        const ident = quoteIdent(table);
        yield `-- ── Table: ${table} ─────────────────────────────────\n`;
        yield `TRUNCATE TABLE ${ident} RESTART IDENTITY CASCADE;\n`;

        const colRes = await db.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1
            ORDER BY ordinal_position
        `, [table]);
        const cols = colRes.rows.map(r => r.column_name);
        if (cols.length === 0) continue;

        const colList = cols.map(quoteIdent).join(', ');

        // Stream rows with a server-side cursor to avoid loading everything.
        const client = await db.getClient();
        try {
            await client.query('BEGIN');
            await client.query(`DECLARE backup_cur CURSOR FOR SELECT ${colList} FROM ${ident}`);
            while (true) {
                const batch = await client.query('FETCH 500 FROM backup_cur');
                if (batch.rows.length === 0) break;
                for (const row of batch.rows) {
                    const vals = cols.map(c => quoteValue(row[c])).join(', ');
                    yield `INSERT INTO ${ident} (${colList}) VALUES (${vals});\n`;
                }
            }
            await client.query('CLOSE backup_cur');
            await client.query('COMMIT');
        } catch (e) {
            try { await client.query('ROLLBACK'); } catch {}
            throw e;
        } finally {
            client.release();
        }
        yield '\n';
    }
}

function dumpStream() {
    const iter = dumpChunks();
    return Readable.from(iter, { encoding: 'utf8' });
}

// ── S3 upload / list / presign ───────────────────────────────────────────────

function makeKey(prefix = 'manual') {
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    return `${DB_PREFIX}${prefix}/${stamp}.sql.gz`;
}

async function exportDatabase({ trigger = 'manual' } = {}) {
    const key = makeKey(trigger);
    const body = dumpStream().pipe(zlib.createGzip());
    const result = await s3.upload({
        Bucket: BUCKET,
        Key: key,
        Body: body,
        ContentType: 'application/gzip',
        ContentEncoding: 'gzip',
        Metadata: { trigger, generated_at: new Date().toISOString() },
    }).promise();
    return { key: result.Key, location: result.Location, bucket: BUCKET };
}

async function listBackups() {
    const res = await s3.listObjectsV2({ Bucket: BUCKET, Prefix: DB_PREFIX }).promise();
    const items = (res.Contents || [])
        .map(o => ({
            key: o.Key,
            size: o.Size,
            last_modified: o.LastModified,
            trigger: o.Key.split('/')[1] || 'manual',
        }))
        .sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));
    return items;
}

async function getDownloadUrl(key, expiresInSeconds = 300) {
    if (!key.startsWith(DB_PREFIX)) throw new Error('invalid key');
    return s3.getSignedUrlPromise('getObject', {
        Bucket: BUCKET,
        Key: key,
        Expires: expiresInSeconds,
    });
}

// ── RDS snapshots ────────────────────────────────────────────────────────────

function snapshotId(prefix = 'manual') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).toLowerCase();
    return `${RDS_INSTANCE_ID}-${prefix}-${stamp}`.replace(/[^a-z0-9-]/g, '-');
}

async function createSnapshot({ trigger = 'manual' } = {}) {
    const id = snapshotId(trigger);
    await rds.createDBSnapshot({
        DBInstanceIdentifier: RDS_INSTANCE_ID,
        DBSnapshotIdentifier: id,
        Tags: [
            { Key: 'app', Value: 'prodecaballito' },
            { Key: 'trigger', Value: trigger },
        ],
    }).promise();
    return { snapshot_id: id, instance: RDS_INSTANCE_ID, trigger };
}

async function listSnapshots() {
    const all = [];
    for (const type of ['manual', 'automated']) {
        const res = await rds.describeDBSnapshots({
            DBInstanceIdentifier: RDS_INSTANCE_ID,
            SnapshotType: type,
            MaxRecords: 50,
        }).promise();
        for (const s of res.DBSnapshots || []) {
            all.push({
                snapshot_id: s.DBSnapshotIdentifier,
                type: s.SnapshotType,
                status: s.Status,
                created_at: s.SnapshotCreateTime,
                size_gb: s.AllocatedStorage,
                engine: s.Engine,
            });
        }
    }
    return all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

module.exports = {
    exportDatabase,
    listBackups,
    getDownloadUrl,
    createSnapshot,
    listSnapshots,
    // exported for testing
    _internal: { quoteValue, quoteIdent, listTables, makeKey, snapshotId },
};
