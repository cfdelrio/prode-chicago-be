'use strict'

jest.mock('../db/connection', () => ({
  db: { query: jest.fn() },
}))
jest.mock('../workers/notificationService', () => ({
  generarNotificacionKickoff: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../services/push', () => ({
  pushToUser: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../services/whatsapp', () => ({
  sendWhatsApp: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../services/sms', () => ({
  sendSMS: jest.fn().mockResolvedValue(undefined),
  sendSMSWithRetry: jest.fn().mockResolvedValue(undefined),
}))

const { db } = require('../db/connection')
const { generarNotificacionKickoff } = require('../workers/notificationService')
const { pushToUser } = require('../services/push')
const { sendSMSWithRetry: sendSMS } = require('../services/sms')
const { schedulerService } = require('../workers/schedulerService')

const MATCH_ID = 'a0000000-0000-0000-0000-000000000001'
const USER_ID  = 'b0000000-0000-0000-0000-000000000002'

const makeJob = (type = 'kickoff') => ({
  matchId: MATCH_ID,
  homeTeam: 'Argentina',
  awayTeam: 'Brasil',
  startTime: new Date('2025-06-01T20:00:00Z'),
  halftimeMinutes: 15,
  type,
})

beforeEach(() => {
  db.query.mockReset()
  generarNotificacionKickoff.mockClear()
  pushToUser.mockClear()
  sendSMS.mockClear()
})

describe('schedulerService.processPendingJobs', () => {
  it('no-op cuando no hay jobs pendientes', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }) // getPendingJobs

    await schedulerService.processPendingJobs()

    expect(generarNotificacionKickoff).not.toHaveBeenCalled()
    expect(pushToUser).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it('notifica in-app y push a usuarios con bets, sin SMS si no consintió', async () => {
    // getPendingJobs
    db.query.mockResolvedValueOnce({
      rows: [{
        match_id: MATCH_ID, job_type: 'kickoff', scheduled_for: new Date(),
        home_team: 'Argentina', away_team: 'Brasil',
        start_time: new Date('2025-06-01T20:00:00Z'), halftime_minutes: 15,
      }],
    })
    // betters query — user has no whatsapp_consent
    db.query.mockResolvedValueOnce({
      rows: [{ user_id: USER_ID, whatsapp_number: null, whatsapp_consent: false }],
    })
    // markJobCompleted
    db.query.mockResolvedValueOnce({ rows: [] })

    await schedulerService.processPendingJobs()

    expect(generarNotificacionKickoff).toHaveBeenCalledTimes(1)
    expect(generarNotificacionKickoff).toHaveBeenCalledWith(
      USER_ID, MATCH_ID, 'Argentina', 'Brasil', 'kickoff', expect.any(Date)
    )
    expect(pushToUser).toHaveBeenCalledTimes(1)
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it('envía SMS si el usuario tiene whatsapp_number y whatsapp_consent', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        match_id: MATCH_ID, job_type: 'kickoff', scheduled_for: new Date(),
        home_team: 'Argentina', away_team: 'Brasil',
        start_time: new Date('2025-06-01T20:00:00Z'), halftime_minutes: 15,
      }],
    })
    db.query.mockResolvedValueOnce({
      rows: [{ user_id: USER_ID, whatsapp_number: '+5491155996222', whatsapp_consent: true }],
    })
    db.query.mockResolvedValueOnce({ rows: [] })

    await schedulerService.processPendingJobs()

    expect(sendSMS).toHaveBeenCalledTimes(1)
    expect(sendSMS).toHaveBeenCalledWith({
      to: '+5491155996222',
      body: expect.stringContaining('Argentina vs Brasil'),
    })
  })

  it('usa label ¡Segundo tiempo! para job tipo second_half', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        match_id: MATCH_ID, job_type: 'second_half', scheduled_for: new Date(),
        home_team: 'Argentina', away_team: 'Brasil',
        start_time: new Date('2025-06-01T20:00:00Z'), halftime_minutes: 15,
      }],
    })
    db.query.mockResolvedValueOnce({
      rows: [{ user_id: USER_ID, whatsapp_number: '+5491155996222', whatsapp_consent: true }],
    })
    db.query.mockResolvedValueOnce({ rows: [] })

    await schedulerService.processPendingJobs()

    expect(generarNotificacionKickoff).toHaveBeenCalledWith(
      USER_ID, MATCH_ID, 'Argentina', 'Brasil', 'second_half', expect.any(Date)
    )
    expect(sendSMS).toHaveBeenCalledWith({
      to: '+5491155996222',
      body: expect.stringContaining('Segundo tiempo'),
    })
  })

  it('notifica múltiples usuarios independientemente', async () => {
    const USER2 = 'c0000000-0000-0000-0000-000000000003'
    db.query.mockResolvedValueOnce({
      rows: [{
        match_id: MATCH_ID, job_type: 'kickoff', scheduled_for: new Date(),
        home_team: 'Argentina', away_team: 'Brasil',
        start_time: new Date('2025-06-01T20:00:00Z'), halftime_minutes: 15,
      }],
    })
    db.query.mockResolvedValueOnce({
      rows: [
        { user_id: USER_ID, whatsapp_number: '+5491155996222', whatsapp_consent: true },
        { user_id: USER2, whatsapp_number: null, whatsapp_consent: false },
      ],
    })
    db.query.mockResolvedValueOnce({ rows: [] })

    await schedulerService.processPendingJobs()

    expect(generarNotificacionKickoff).toHaveBeenCalledTimes(2)
    expect(pushToUser).toHaveBeenCalledTimes(2)
    expect(sendSMS).toHaveBeenCalledTimes(1) // only user with consent
  })

  it('marca el job como completado incluso si no hay betters', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        match_id: MATCH_ID, job_type: 'kickoff', scheduled_for: new Date(),
        home_team: 'Argentina', away_team: 'Brasil',
        start_time: new Date('2025-06-01T20:00:00Z'), halftime_minutes: 15,
      }],
    })
    db.query.mockResolvedValueOnce({ rows: [] }) // no betters
    db.query.mockResolvedValueOnce({ rows: [] }) // markJobCompleted

    await schedulerService.processPendingJobs()

    // Third db.query call should be the UPDATE (markJobCompleted)
    expect(db.query).toHaveBeenCalledTimes(3)
    expect(db.query.mock.calls[2][0]).toMatch(/UPDATE scheduled_jobs SET status = 'completed'/)
  })

  it('continúa procesando otros jobs si uno falla', async () => {
    const MATCH2 = 'd0000000-0000-0000-0000-000000000004'
    db.query.mockResolvedValueOnce({
      rows: [
        {
          match_id: MATCH_ID, job_type: 'kickoff', scheduled_for: new Date(),
          home_team: 'ARG', away_team: 'BRA',
          start_time: new Date(), halftime_minutes: 15,
        },
        {
          match_id: MATCH2, job_type: 'kickoff', scheduled_for: new Date(),
          home_team: 'URU', away_team: 'CHI',
          start_time: new Date(), halftime_minutes: 15,
        },
      ],
    })
    // First job: betters query throws
    db.query.mockRejectedValueOnce(new Error('DB error'))
    // Second job: succeeds with one user
    db.query.mockResolvedValueOnce({ rows: [{ user_id: USER_ID, whatsapp_number: null, whatsapp_consent: false }] })
    db.query.mockResolvedValueOnce({ rows: [] }) // markJobCompleted for second job

    await schedulerService.processPendingJobs()

    // Second job's in-app notification should still run
    expect(generarNotificacionKickoff).toHaveBeenCalledTimes(1)
    expect(generarNotificacionKickoff).toHaveBeenCalledWith(
      USER_ID, MATCH2, 'URU', 'CHI', 'kickoff', expect.any(Date)
    )
  })
})

describe('schedulerService.scheduleMatchJobs', () => {
  it('inserta kickoff y second_half jobs correctamente', async () => {
    db.query.mockResolvedValueOnce({ rows: [] })

    const match = {
      id: MATCH_ID,
      home_team: 'Argentina',
      away_team: 'Brasil',
      start_time: '2025-06-01T20:00:00Z',
      halftime_minutes: 15,
    }

    await schedulerService.scheduleMatchJobs(match)

    expect(db.query).toHaveBeenCalledTimes(1)
    const [sql, params] = db.query.mock.calls[0]
    expect(sql).toMatch(/INSERT INTO scheduled_jobs/)
    expect(params[0]).toBe(MATCH_ID)
    // kickoff at start_time
    expect(params[1]).toEqual(new Date('2025-06-01T20:00:00Z'))
    // second_half = kickoff + 45min + halftime_minutes
    const expectedSecondHalf = new Date('2025-06-01T20:00:00Z').getTime() + (45 + 15) * 60 * 1000
    expect(params[2]).toEqual(new Date(expectedSecondHalf))
  })
})
