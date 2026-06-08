'use strict'

// Mock all heavy dependencies before requiring lambda.js
jest.mock('../db/connection', () => ({ db: { query: jest.fn() } }))
jest.mock('../middleware', () => ({
  securityMiddleware: (_req, _res, next) => next(),
  corsMiddleware:     (_req, _res, next) => next(),
  compressionMiddleware: (_req, _res, next) => next(),
}))
jest.mock('../middleware/rateLimit', () => ({
  authLimiter:   (_req, _res, next) => next(),
  uploadLimiter: (_req, _res, next) => next(),
}))
jest.mock('../middleware/auth', () => ({
  authMiddleware: (_req, _res, next) => next(),
  requireAdmin:   (_req, _res, next) => next(),
}))
jest.mock('../routes', () => ({
  authRoutes: require('express').Router(),
  usersRoutes: require('express').Router(),
  matchesRoutes: require('express').Router(),
  betsRoutes: require('express').Router(),
  rankingRoutes: require('express').Router(),
  commentsRoutes: require('express').Router(),
  notificationsRoutes: require('express').Router(),
  planillasRoutes: require('express').Router(),
  messagesRoutes: require('express').Router(),
  subscriptionsRoutes: require('express').Router(),
  configRoutes: require('express').Router(),
  themeRoutes: require('express').Router(),
  tournamentsRoutes: require('express').Router(),
  matchdaysRoutes: require('express').Router(),
  imagemailRoutes: require('express').Router(),
  pushRoutes: require('express').Router(),
  adminRoutes: require('express').Router(),
  voiceRoutes: require('express').Router(),
  pollsRoutes: require('express').Router(),
}))
jest.mock('../services/whatsapp', () => ({ sendWhatsApp: jest.fn() }))
jest.mock('../services/concurrency', () => ({ runConcurrent: jest.fn().mockResolvedValue([]) }))

const mockProcessPendingJobs = jest.fn().mockResolvedValue(undefined)
jest.mock('../workers/schedulerService', () => ({
  schedulerService: { processPendingJobs: mockProcessPendingJobs },
}))

const mockProcessBetReminders = jest.fn().mockResolvedValue({ processed: 0, sent: 0, failed: 0 })
jest.mock('../services/betReminders', () => ({
  processBetReminders: mockProcessBetReminders,
}))

const mockRunCutoffReminders = jest.fn().mockResolvedValue({ matches: 0, users_notified: 0 })
jest.mock('../services/reminderCutoff', () => ({
  runCutoffReminders: mockRunCutoffReminders,
}))

const mockRunTournamentReminders = jest.fn().mockResolvedValue({ tournaments_in_window: 0, users_notified: 0, skipped: 0 })
jest.mock('../services/reminderTournament', () => ({
  runTournamentReminders: mockRunTournamentReminders,
}))

const mockRunPaymentReminders = jest.fn().mockResolvedValue({ planillas_found: 0, users_notified: 0, skipped: 0 })
jest.mock('../services/reminderPayment', () => ({
  runPaymentReminders: mockRunPaymentReminders,
}))

const mockSendWeeklyEmailBatch = jest.fn().mockResolvedValue({ sent: 0 })
jest.mock('../routes/admin', () => ({
  sendWeeklyEmailBatch: mockSendWeeklyEmailBatch,
}))

const { handler } = require('../lambda')
const fakeContext = { callbackWaitsForEmptyEventLoop: true }

describe('Lambda EventBridge handlers', () => {
  beforeEach(() => jest.clearAllMocks())

  it('prode.process-jobs → llama processPendingJobs y processBetReminders y retorna 200', async () => {
    const res = await handler({ source: 'prode.process-jobs' }, fakeContext)
    expect(res.statusCode).toBe(200)
    expect(mockProcessPendingJobs).toHaveBeenCalledTimes(1)
    expect(mockProcessBetReminders).toHaveBeenCalledTimes(1)
  })

  it('prode.reminder-cutoff → llama runCutoffReminders + runTournamentReminders y retorna 200', async () => {
    const res = await handler({ source: 'prode.reminder-cutoff' }, fakeContext)
    expect(res.statusCode).toBe(200)
    expect(mockRunCutoffReminders).toHaveBeenCalledTimes(1)
    expect(mockRunTournamentReminders).toHaveBeenCalledTimes(1)
  })

  it('prode.payment-reminder → llama runPaymentReminders y retorna 200', async () => {
    const res = await handler({ source: 'prode.payment-reminder' }, fakeContext)
    expect(res.statusCode).toBe(200)
    expect(mockRunPaymentReminders).toHaveBeenCalledTimes(1)
  })

  it('prode.weekly → llama sendWeeklyEmailBatch y retorna 200', async () => {
    const res = await handler({ source: 'prode.weekly' }, fakeContext)
    expect(res.statusCode).toBe(200)
    expect(mockSendWeeklyEmailBatch).toHaveBeenCalledTimes(1)
  })

  it('prode.process-jobs no interfiere con prode.reminder-cutoff', async () => {
    await handler({ source: 'prode.process-jobs' }, fakeContext)
    expect(mockRunCutoffReminders).not.toHaveBeenCalled()
    expect(mockProcessPendingJobs).toHaveBeenCalledTimes(1)
  })
})
