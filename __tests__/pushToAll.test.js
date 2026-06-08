'use strict'

// VAPID keys must be set before push.js loads — we removed the hardcoded fallback
process.env.VAPID_PUBLIC_KEY = 'BTest_PublicKey_ForTests_OnlyNotReal'
process.env.VAPID_PRIVATE_KEY = 'TestPrivateKeyForTestsOnly'

jest.mock('../db/connection', () => ({
  db: { query: jest.fn() },
}))
jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn().mockResolvedValue(undefined),
}))

const { db } = require('../db/connection')
const webpush = require('web-push')
const { pushToAll } = require('../services/push')

const makeSub = (id) => ({
  id,
  user_id: `u${id}`,
  endpoint: `https://push.example/${id}`,
  p256dh: 'k1',
  auth: 'a1',
})

beforeEach(() => {
  db.query.mockReset()
  webpush.sendNotification.mockReset().mockResolvedValue(undefined)
  delete process.env.PUSH_BROADCAST_BATCH
})

describe('pushToAll — pagination', () => {
  it('procesa todas las subs en un único batch si caben en LIMIT', async () => {
    process.env.PUSH_BROADCAST_BATCH = '100'
    db.query
      .mockResolvedValueOnce({ rows: [makeSub(1), makeSub(2), makeSub(3)] })
      // No segundo batch porque rows.length < batchSize

    const out = await pushToAll({ title: 'hi', body: 'world' })

    expect(out).toEqual({ sent: 3, failed: 0 })
    expect(db.query).toHaveBeenCalledTimes(1)
    expect(webpush.sendNotification).toHaveBeenCalledTimes(3)
  })

  it('itera múltiples batches cuando rows.length == batchSize', async () => {
    process.env.PUSH_BROADCAST_BATCH = '2'
    db.query
      .mockResolvedValueOnce({ rows: [makeSub(1), makeSub(2)] })   // primer batch lleno
      .mockResolvedValueOnce({ rows: [makeSub(3), makeSub(4)] })   // segundo batch lleno
      .mockResolvedValueOnce({ rows: [makeSub(5)] })               // tercer batch incompleto → corte

    const out = await pushToAll({ title: 'x', body: 'y' })

    expect(out).toEqual({ sent: 5, failed: 0 })
    expect(db.query).toHaveBeenCalledTimes(3)
    expect(webpush.sendNotification).toHaveBeenCalledTimes(5)
    // El segundo y tercer query usan WHERE id > $1
    expect(db.query.mock.calls[1][0]).toMatch(/WHERE id > \$1/)
    expect(db.query.mock.calls[1][1][0]).toBe(2) // último id del batch 1
    expect(db.query.mock.calls[2][1][0]).toBe(4) // último id del batch 2
  })

  it('corta el loop cuando un batch viene vacío', async () => {
    process.env.PUSH_BROADCAST_BATCH = '5'
    db.query
      .mockResolvedValueOnce({ rows: [makeSub(1), makeSub(2), makeSub(3), makeSub(4), makeSub(5)] })
      .mockResolvedValueOnce({ rows: [] })

    const out = await pushToAll({ title: 'x', body: 'y' })

    expect(out.sent).toBe(5)
    expect(db.query).toHaveBeenCalledTimes(2)
  })

  it('cuenta failed y sigue cuando sendPush rechaza', async () => {
    process.env.PUSH_BROADCAST_BATCH = '10'
    db.query.mockResolvedValueOnce({ rows: [makeSub(1), makeSub(2), makeSub(3)] })
    webpush.sendNotification
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined)

    const out = await pushToAll({ title: 'x', body: 'y' })

    expect(out).toEqual({ sent: 2, failed: 1 })
  })
})
