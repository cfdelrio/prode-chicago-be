'use strict'

const mockPost = jest.fn()

jest.mock('axios', () => ({
  create: jest.fn(() => ({ post: mockPost })),
}))

jest.mock('../utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

const originalEnabled = process.env.ENGAGE_ENABLED

describe('engageClient', () => {
  let sendEvent, sendEventBatch, sendWithRetry

  beforeAll(() => {
    process.env.ENGAGE_ENABLED = 'true'
    process.env.ENGAGE_API_URL = 'https://test.engage.com'
    process.env.ENGAGE_API_KEY = 'test-key'
    ;({ sendEvent, sendEventBatch, sendWithRetry } = require('../services/engageClient'))
  })

  afterAll(() => {
    process.env.ENGAGE_ENABLED = originalEnabled
  })

  beforeEach(() => {
    mockPost.mockReset()
  })

  describe('sendEvent', () => {
    it('returns null when ENGAGE_ENABLED is not true', async () => {
      process.env.ENGAGE_ENABLED = 'false'
      const result = await sendEvent({ type: 'prode.verification_code', userId: '1' })
      expect(result).toBeNull()
      expect(mockPost).not.toHaveBeenCalled()
      process.env.ENGAGE_ENABLED = 'true'
    })

    it('posts event to /v1/events and returns eventId', async () => {
      mockPost.mockResolvedValue({ data: { eventId: 'evt_abc', status: 'queued' } })

      const result = await sendEvent({
        type: 'prode.verification_code',
        userId: 'pending:123',
        idempotencyKey: 'verification_code:123',
        payload: { code: '456789', expiresIn: 900 },
        metadata: { user_contact: { email: 'test@test.com', nombre: 'Test' } },
      })

      expect(mockPost).toHaveBeenCalledWith(
        '/v1/events',
        expect.objectContaining({
          type: 'prode.verification_code',
          userId: 'pending:123',
          idempotencyKey: 'verification_code:123',
        }),
      )
      expect(result).toEqual({ eventId: 'evt_abc', status: 'queued' })
    })

    it('returns null on 409 (duplicate idempotencyKey)', async () => {
      const err = new Error('Conflict')
      err.response = { status: 409 }
      mockPost.mockRejectedValue(err)

      const result = await sendEvent({
        type: 'prode.verification_code',
        userId: 'pending:123',
        idempotencyKey: 'dup-key',
      })
      expect(result).toBeNull()
    })

    it('throws on 400 (invalid schema)', async () => {
      const err = new Error('Bad Request')
      err.response = { status: 400, data: { error: 'Invalid event schema' } }
      mockPost.mockRejectedValue(err)

      await expect(
        sendEvent({ type: 'prode.verification_code', userId: '1' }),
      ).rejects.toThrow('Bad Request')
    })

    it('throws on 401 (invalid API key)', async () => {
      const err = new Error('Unauthorized')
      err.response = { status: 401 }
      mockPost.mockRejectedValue(err)

      await expect(
        sendEvent({ type: 'prode.verification_code', userId: '1' }),
      ).rejects.toThrow('Unauthorized')
    })

    it('throws on network error', async () => {
      mockPost.mockRejectedValue(new Error('ECONNREFUSED'))

      await expect(
        sendEvent({ type: 'prode.verification_code', userId: '1' }),
      ).rejects.toThrow('ECONNREFUSED')
    })
  })

  describe('sendEventBatch', () => {
    it('returns null when ENGAGE_ENABLED is not true', async () => {
      process.env.ENGAGE_ENABLED = 'false'
      const result = await sendEventBatch([{ type: 'prode.kickoff', userId: '1' }])
      expect(result).toBeNull()
      process.env.ENGAGE_ENABLED = 'true'
    })

    it('posts events array to /v1/events/batch', async () => {
      mockPost.mockResolvedValue({ data: { queued: 2 } })

      const events = [
        { type: 'prode.kickoff', userId: '1' },
        { type: 'prode.kickoff', userId: '2' },
      ]
      const result = await sendEventBatch(events)

      expect(mockPost).toHaveBeenCalledWith('/v1/events/batch', { events })
      expect(result).toEqual({ queued: 2 })
    })

    it('throws on batch failure', async () => {
      mockPost.mockRejectedValue(new Error('Service unavailable'))

      await expect(
        sendEventBatch([{ type: 'prode.kickoff', userId: '1' }]),
      ).rejects.toThrow('Service unavailable')
    })
  })

  describe('sendWithRetry — exponential backoff', () => {
    // Override setTimeout to avoid real delays in tests
    beforeAll(() => jest.useFakeTimers())
    afterAll(() => jest.useRealTimers())

    it('retries on network error and succeeds on 3rd attempt', async () => {
      const networkErr = new Error('ECONNRESET')
      let callCount = 0
      const fn = jest.fn(async () => {
        callCount++
        if (callCount < 3) throw networkErr
        return { eventId: 'success' }
      })

      // Run with minimal delay so timers advance quickly
      const promise = sendWithRetry(fn, 3, 1)
      // Advance timers through the exponential backoffs (1ms, 2ms)
      await jest.runAllTimersAsync()
      const result = await promise

      expect(result).toEqual({ eventId: 'success' })
      expect(fn).toHaveBeenCalledTimes(3)
    })

    it('does not retry on 4xx client errors (except 409 and 429)', async () => {
      const clientErr = new Error('Bad Request')
      clientErr.response = { status: 400 }
      const fn = jest.fn(async () => { throw clientErr })

      await expect(sendWithRetry(fn, 3, 1)).rejects.toThrow('Bad Request')
      // Must have thrown immediately without retrying
      expect(fn).toHaveBeenCalledTimes(1)
    })

    it('retries on 429 rate limit errors', async () => {
      const rateLimitErr = new Error('Too Many Requests')
      rateLimitErr.response = { status: 429 }
      let callCount = 0
      const fn = jest.fn(async () => {
        callCount++
        if (callCount < 2) throw rateLimitErr
        return { queued: true }
      })

      const promise = sendWithRetry(fn, 3, 1)
      await jest.runAllTimersAsync()
      const result = await promise

      expect(result).toEqual({ queued: true })
      expect(fn).toHaveBeenCalledTimes(2)
    })

    it('throws after exhausting all attempts', async () => {
      const err = new Error('Service unavailable')
      err.response = { status: 503 }
      const fn = jest.fn(async () => { throw err })

      const promise = sendWithRetry(fn, 3, 1)
      // Attach a no-op .catch() before advancing timers so the rejection that
      // occurs during timer advancement doesn't become an unhandled rejection.
      // The original `promise` reference still rejects — we assert on it below.
      promise.catch(() => {})
      await jest.runAllTimersAsync()

      await expect(promise).rejects.toThrow('Service unavailable')
      expect(fn).toHaveBeenCalledTimes(3)
    })
  })
})
