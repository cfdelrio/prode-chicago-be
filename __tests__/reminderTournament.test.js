'use strict'

jest.mock('../db/connection', () => ({ db: { query: jest.fn() } }))
jest.mock('../services/push', () => ({ pushToUser: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../services/sms', () => ({ sendSMSWithRetry: jest.fn().mockResolvedValue(undefined) }))

const { db } = require('../db/connection')
const { pushToUser } = require('../services/push')
const { sendSMSWithRetry } = require('../services/sms')
const { runTournamentReminders } = require('../services/reminderTournament')

const TOURNAMENT_ID = 'a0000000-0000-0000-0000-000000000001'
const MATCH_ID      = 'b0000000-0000-0000-0000-000000000002'
const USER_A        = 'c0000000-0000-0000-0000-000000000003'
const USER_B        = 'd0000000-0000-0000-0000-000000000004'

beforeEach(() => {
  db.query.mockReset()
  pushToUser.mockClear()
  sendSMSWithRetry.mockClear()
  db.query.mockResolvedValue({ rows: [] })
})

describe('runTournamentReminders', () => {
  it('no-op cuando no hay torneos en ventana 23-25h', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }) // tournaments query

    const result = await runTournamentReminders()

    expect(result.tournaments_in_window).toBe(0)
    expect(result.users_notified).toBe(0)
    expect(pushToUser).not.toHaveBeenCalled()
    expect(sendSMSWithRetry).not.toHaveBeenCalled()
  })

  it('notifica push + in-app a usuarios con pendientes', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ // tournaments
        tournament_id: TOURNAMENT_ID,
        tournament_name: 'Mundial 2026',
        first_match_start: new Date(),
        first_match_id: MATCH_ID,
      }] })
      .mockResolvedValueOnce({ rows: [{ // users with pending bets
        user_id: USER_A, whatsapp_number: null, whatsapp_consent: false, pending_count: '3',
      }] })
      .mockResolvedValueOnce({ rows: [{ user_id: USER_A }] }) // reminder_sent INSERT success

    const result = await runTournamentReminders()

    expect(result.users_notified).toBe(1)
    expect(pushToUser).toHaveBeenCalledTimes(1)
    expect(pushToUser).toHaveBeenCalledWith(USER_A, expect.objectContaining({
      title: '🏁 Mañana arranca Mundial 2026',
    }))
    expect(sendSMSWithRetry).not.toHaveBeenCalled()
  })

  it('incluye número de partidos pendientes en el mensaje', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ tournament_id: TOURNAMENT_ID, tournament_name: 'Copa', first_match_start: new Date(), first_match_id: MATCH_ID }] })
      .mockResolvedValueOnce({ rows: [{ user_id: USER_A, whatsapp_number: null, whatsapp_consent: false, pending_count: '1' }] })
      .mockResolvedValueOnce({ rows: [{ user_id: USER_A }] })

    await runTournamentReminders()

    const call = pushToUser.mock.calls[0]
    expect(call[1].body).toContain('1 partido')
  })

  it('envía SMS si el usuario tiene consent', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ tournament_id: TOURNAMENT_ID, tournament_name: 'Copa', first_match_start: new Date(), first_match_id: MATCH_ID }] })
      .mockResolvedValueOnce({ rows: [{ user_id: USER_A, whatsapp_number: '+5491155996222', whatsapp_consent: true, pending_count: '5' }] })
      .mockResolvedValueOnce({ rows: [{ user_id: USER_A }] })

    await runTournamentReminders()

    expect(sendSMSWithRetry).toHaveBeenCalledTimes(1)
    expect(sendSMSWithRetry).toHaveBeenCalledWith(expect.objectContaining({
      to: '+5491155996222',
      body: expect.stringContaining('Copa'),
    }))
  })

  it('no reenvía si ya existe reminder_sent para ese torneo', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ tournament_id: TOURNAMENT_ID, tournament_name: 'Copa', first_match_start: new Date(), first_match_id: MATCH_ID }] })
      .mockResolvedValueOnce({ rows: [{ user_id: USER_A, whatsapp_number: null, whatsapp_consent: false, pending_count: '2' }] })
      .mockResolvedValueOnce({ rows: [] }) // reminder_sent conflict → no rows

    const result = await runTournamentReminders()

    expect(result.skipped).toBe(1)
    expect(result.users_notified).toBe(0)
    expect(pushToUser).not.toHaveBeenCalled()
  })

  it('notifica múltiples usuarios de un mismo torneo', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ tournament_id: TOURNAMENT_ID, tournament_name: 'Copa', first_match_start: new Date(), first_match_id: MATCH_ID }] })
      .mockResolvedValueOnce({ rows: [
        { user_id: USER_A, whatsapp_number: null, whatsapp_consent: false, pending_count: '2' },
        { user_id: USER_B, whatsapp_number: '+5491155996222', whatsapp_consent: true, pending_count: '4' },
      ] })
      .mockResolvedValueOnce({ rows: [{ user_id: USER_A }] }) // reminder_sent A
      .mockResolvedValueOnce({ rows: [] })                    // notification INSERT A
      .mockResolvedValueOnce({ rows: [{ user_id: USER_B }] }) // reminder_sent B
      .mockResolvedValueOnce({ rows: [] })                    // notification INSERT B

    const result = await runTournamentReminders()

    expect(result.users_notified).toBe(2)
    expect(pushToUser).toHaveBeenCalledTimes(2)
    expect(sendSMSWithRetry).toHaveBeenCalledTimes(1) // only USER_B
  })
})
