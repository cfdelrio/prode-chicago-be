'use strict'

// Mock AWS SDK before requiring the service.
const mockS3Upload = jest.fn().mockReturnValue({
    promise: () => Promise.resolve({ Key: 'db/manual/2026-05-11_07-00-00.sql.gz', Location: 'https://s3/x' }),
})
const mockS3List = jest.fn().mockReturnValue({
    promise: () => Promise.resolve({
        Contents: [
            { Key: 'db/manual/2026-05-10_07-00-00.sql.gz', Size: 1024, LastModified: new Date('2026-05-10T07:00:00Z') },
            { Key: 'db/scheduled/2026-05-11_07-00-00.sql.gz', Size: 2048, LastModified: new Date('2026-05-11T07:00:00Z') },
        ],
    }),
})
const mockSignedUrl = jest.fn().mockResolvedValue('https://signed.example/url')
const mockCreateSnapshot = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) })
const mockDescribeSnapshots = jest.fn().mockReturnValue({
    promise: () => Promise.resolve({
        DBSnapshots: [
            { DBSnapshotIdentifier: 'prode-db-manual-1', SnapshotType: 'manual', Status: 'available',
              SnapshotCreateTime: new Date('2026-05-11T07:00:00Z'), AllocatedStorage: 20, Engine: 'postgres' },
        ],
    }),
})

jest.mock('aws-sdk', () => ({
    S3: jest.fn().mockImplementation(() => ({
        upload: mockS3Upload,
        listObjectsV2: mockS3List,
        getSignedUrlPromise: mockSignedUrl,
    })),
    RDS: jest.fn().mockImplementation(() => ({
        createDBSnapshot: mockCreateSnapshot,
        describeDBSnapshots: mockDescribeSnapshots,
    })),
}))

jest.mock('../db/connection', () => ({
    db: {
        query: jest.fn(),
        getClient: jest.fn(),
    },
}))

const { db } = require('../db/connection')
const backupService = require('../services/backupService')

beforeEach(() => {
    jest.clearAllMocks()
})

describe('quoteValue', () => {
    const { quoteValue } = backupService._internal
    it('renders null', () => expect(quoteValue(null)).toBe('NULL'))
    it('renders numbers', () => expect(quoteValue(42)).toBe('42'))
    it('renders booleans', () => expect(quoteValue(true)).toBe('TRUE'))
    it('escapes single quotes', () => expect(quoteValue("a'b")).toBe("'a''b'"))
    it('renders dates as ISO', () => {
        expect(quoteValue(new Date('2026-05-11T07:00:00Z'))).toBe("'2026-05-11T07:00:00.000Z'")
    })
    it('renders objects as jsonb', () => {
        expect(quoteValue({ a: 1 })).toBe("'{\"a\":1}'::jsonb")
    })
})

describe('quoteIdent', () => {
    const { quoteIdent } = backupService._internal
    it('wraps in double quotes', () => expect(quoteIdent('users')).toBe('"users"'))
    it('escapes embedded double quotes', () => expect(quoteIdent('a"b')).toBe('"a""b"'))
})

describe('listBackups', () => {
    it('returns sorted items with derived trigger', async () => {
        const items = await backupService.listBackups()
        expect(items).toHaveLength(2)
        expect(items[0].key).toBe('db/scheduled/2026-05-11_07-00-00.sql.gz')
        expect(items[0].trigger).toBe('scheduled')
        expect(items[1].trigger).toBe('manual')
    })
})

describe('getDownloadUrl', () => {
    it('rejects keys outside db/ prefix', async () => {
        await expect(backupService.getDownloadUrl('other/foo.sql.gz')).rejects.toThrow('invalid key')
    })
    it('returns presigned URL for valid key', async () => {
        const url = await backupService.getDownloadUrl('db/manual/x.sql.gz')
        expect(url).toBe('https://signed.example/url')
        expect(mockSignedUrl).toHaveBeenCalledWith('getObject', expect.objectContaining({
            Key: 'db/manual/x.sql.gz',
            Expires: 300,
        }))
    })
})

describe('createSnapshot', () => {
    it('calls RDS with tagged manual snapshot id', async () => {
        const result = await backupService.createSnapshot({ trigger: 'manual' })
        expect(result.instance).toBe('prode-db')
        expect(result.trigger).toBe('manual')
        expect(result.snapshot_id).toMatch(/^prode-db-manual-/)
        expect(mockCreateSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            DBInstanceIdentifier: 'prode-db',
            Tags: expect.arrayContaining([
                { Key: 'app', Value: 'prodecaballito' },
                { Key: 'trigger', Value: 'manual' },
            ]),
        }))
    })
})

describe('listSnapshots', () => {
    it('fetches manual + automated snapshots', async () => {
        const items = await backupService.listSnapshots()
        expect(mockDescribeSnapshots).toHaveBeenCalledTimes(2)
        expect(items).toHaveLength(2) // mock returns same row for both types
        expect(items[0]).toMatchObject({ snapshot_id: 'prode-db-manual-1', status: 'available' })
    })
})

describe('exportDatabase', () => {
    it('dumps all tables and uploads gzipped SQL to S3', async () => {
        // Mock pg_tables list
        db.query.mockImplementation((sql) => {
            if (sql.includes('FROM pg_tables')) {
                return Promise.resolve({ rows: [{ tablename: 'users' }] })
            }
            if (sql.includes('information_schema.columns')) {
                return Promise.resolve({ rows: [{ column_name: 'id' }, { column_name: 'nombre' }] })
            }
            return Promise.resolve({ rows: [] })
        })

        let fetchCalls = 0
        const fakeClient = {
            query: jest.fn().mockImplementation((sql) => {
                if (sql.startsWith('FETCH')) {
                    fetchCalls++
                    if (fetchCalls === 1) return Promise.resolve({ rows: [{ id: 1, nombre: "O'Brien" }] })
                    return Promise.resolve({ rows: [] })
                }
                return Promise.resolve({ rows: [] })
            }),
            release: jest.fn(),
        }
        db.getClient.mockResolvedValue(fakeClient)

        const result = await backupService.exportDatabase({ trigger: 'manual' })
        expect(result.key).toMatch(/^db\/manual\//)
        expect(result.bucket).toBe('prodecaballito-backups')
        expect(mockS3Upload).toHaveBeenCalledTimes(1)
        const uploadArgs = mockS3Upload.mock.calls[0][0]
        expect(uploadArgs.Bucket).toBe('prodecaballito-backups')
        expect(uploadArgs.ContentEncoding).toBe('gzip')
        expect(uploadArgs.Metadata.trigger).toBe('manual')
    })
})
