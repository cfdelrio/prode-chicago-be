'use strict'

jest.mock('../db/connection', () => ({ db: { query: jest.fn() } }))
jest.mock('../services/push', () => ({ pushToUser: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../services/sms', () => ({
  sendSMS: jest.fn().mockResolvedValue(undefined),
  sendSMSWithRetry: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req, _res, next) => { req.user = { userId: 'admin-id', role: 'admin' }; next(); },
  requireAdmin: (_req, _res, next) => next(),
}))
const noopMiddleware = (_req, _res, next) => next()
jest.mock('../middleware/validation', () => ({
  matchUpdateValidation: noopMiddleware,
  matchValidation: noopMiddleware,
  matchResultValidation: noopMiddleware,
  uuidParam: noopMiddleware,
}))
jest.mock('../workers/schedulerService', () => ({
  schedulerService: { scheduleMatchJobs: jest.fn().mockResolvedValue(undefined) },
}))
jest.mock('../services/tournamentRanking', () => ({ recalculateTournamentRanking: jest.fn() }))
jest.mock('../services/cache', () => ({ invalidatePrefix: jest.fn() }))
jest.mock('../services/email', () => ({ sendRankingUpdateEmail: jest.fn().mockResolvedValue(undefined) }))

const { db } = require('../db/connection')
const { pushToUser } = require('../services/push')
const { sendSMSWithRetry } = require('../services/sms')

const MATCH_ID = 'a0000000-0000-0000-0000-000000000001'
const USER_A   = 'b0000000-0000-0000-0000-000000000002'
const USER_B   = 'c0000000-0000-0000-0000-000000000003'

const express = require('express')
const request = require('supertest')

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/matches', require('../routes/matches').default || require('../routes/matches'))
  return app
}

const OLD_START = '2025-06-01T20:00:00Z'
const NEW_START = '2025-06-02T21:00:00Z'

const oldMatch = {
  id: MATCH_ID, home_team: 'Argentina', away_team: 'Brasil',
  start_time: new Date(OLD_START), estado: 'scheduled', finished: false,
  home_team_pt: null, away_team_pt: null, halftime_minutes: 15,
  time_cutoff: null, tournament_id: null, sede: null, grupo: null, jornada: null,
}
const newMatch = { ...oldMatch, start_time: new Date(NEW_START) }

beforeEach(() => {
  db.query.mockReset()
  pushToUser.mockClear()
  sendSMSWithRetry.mockClear()
  db.query.mockResolvedValue({ rows: [] })
})

describe('PUT /matches/:id — reschedule notification', () => {
  it('no envía notificación si start_time no cambió', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [oldMatch] })  // SELECT old match
      .mockResolvedValueOnce({ rows: [oldMatch] })  // UPDATE RETURNING

    const app = buildApp()
    await request(app)
      .put(`/matches/${MATCH_ID}`)
      .send({ home_team: 'Argentina', away_team: 'Brasil' }) // no start_time change

    expect(pushToUser).not.toHaveBeenCalled()
    expect(sendSMSWithRetry).not.toHaveBeenCalled()
  })

  it('envía push + in-app a usuarios con bets cuando start_time cambia', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [oldMatch] })   // SELECT old match
      .mockResolvedValueOnce({ rows: [newMatch] })   // UPDATE RETURNING
      .mockResolvedValueOnce({ rows: [] })           // audit_log INSERT
      .mockResolvedValueOnce({ rows: [] })           // UPDATE bet_reminders (fire-and-forget)
      .mockResolvedValueOnce({ rows: [
        { user_id: USER_A, nombre: 'Ana', whatsapp_number: null, whatsapp_consent: false },
        { user_id: USER_B, nombre: 'Bob', whatsapp_number: null, whatsapp_consent: false },
      ] }) // betters SELECT

    const app = buildApp()
    await request(app)
      .put(`/matches/${MATCH_ID}`)
      .send({ start_time: NEW_START })

    // Wait for async fire-and-forget
    await new Promise(r => setTimeout(r, 50))

    expect(pushToUser).toHaveBeenCalledTimes(2)
    expect(pushToUser).toHaveBeenCalledWith(USER_A, expect.objectContaining({
      title: '📅 Cambio de horario',
    }))
    expect(pushToUser).toHaveBeenCalledWith(USER_B, expect.objectContaining({
      title: '📅 Cambio de horario',
    }))
    expect(sendSMSWithRetry).not.toHaveBeenCalled()
  })

  it('envía SMS si el usuario tiene whatsapp_number y consent', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [oldMatch] })
      .mockResolvedValueOnce({ rows: [newMatch] })
      .mockResolvedValueOnce({ rows: [] })           // audit_log
      .mockResolvedValueOnce({ rows: [] })           // UPDATE bet_reminders
      .mockResolvedValueOnce({ rows: [
        { user_id: USER_A, nombre: 'Ana', whatsapp_number: '+5491155996222', whatsapp_consent: true },
      ] }) // betters

    const app = buildApp()
    await request(app)
      .put(`/matches/${MATCH_ID}`)
      .send({ start_time: NEW_START })

    await new Promise(r => setTimeout(r, 50))

    expect(sendSMSWithRetry).toHaveBeenCalledTimes(1)
    expect(sendSMSWithRetry).toHaveBeenCalledWith(expect.objectContaining({
      to: '+5491155996222',
      body: expect.stringContaining('Argentina vs Brasil'),
    }))
  })

  it('no notifica si no hay betters para el partido', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [oldMatch] })
      .mockResolvedValueOnce({ rows: [newMatch] })
      .mockResolvedValueOnce({ rows: [] })           // audit_log
      .mockResolvedValueOnce({ rows: [] })           // UPDATE bet_reminders
      .mockResolvedValueOnce({ rows: [] })           // betters SELECT (empty)

    const app = buildApp()
    await request(app)
      .put(`/matches/${MATCH_ID}`)
      .send({ start_time: NEW_START })

    await new Promise(r => setTimeout(r, 50))

    expect(pushToUser).not.toHaveBeenCalled()
    expect(sendSMSWithRetry).not.toHaveBeenCalled()
  })
})
