'use strict'

jest.mock('../db/connection', () => ({
  db: { query: jest.fn() },
}))
jest.mock('../services/push', () => ({
  pushToUser: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../services/sms', () => ({
  sendSMS: jest.fn().mockResolvedValue(undefined),
  sendSMSWithRetry: jest.fn().mockResolvedValue(undefined),
}))

const { db } = require('../db/connection')
const { pushToUser } = require('../services/push')
const { sendSMSWithRetry: sendSMS } = require('../services/sms')
const {
  runCutoffReminders, buildPayload, getTournamentCutoffMinutes,
  REMINDER_TYPE, DEFAULT_CUTOFF_MINUTES,
} = require('../services/reminderCutoff')

const T1 = '11111111-1111-1111-1111-111111111111'
const M1 = '22222222-2222-2222-2222-222222222222'
const M2 = '33333333-3333-3333-3333-333333333333'
const U1 = '44444444-4444-4444-4444-444444444444'

// First match starts in 30 min → cutoff (=first - 5min) lands in 25 min (in 20-40 window)
const firstMatchIn30Min = () => new Date(Date.now() + 30 * 60 * 1000)
// First match starts in 5 min → cutoff already passed (not in window)
const firstMatchTooSoon = () => new Date(Date.now() + 5 * 60 * 1000)
// First match starts in 60 min → cutoff in 55 min (not yet in window)
const firstMatchIn60Min = () => new Date(Date.now() + 60 * 60 * 1000)

beforeEach(() => {
  db.query.mockReset()
  db.query.mockResolvedValue({ rows: [] })
  pushToUser.mockClear()
  sendSMS.mockClear()
})

describe('buildPayload', () => {
  it('mensaje específico cuando falta 1 partido y hay firstMatch', () => {
    const p = buildPayload({ pending: 1, firstMatch: { home_team: 'ARG', away_team: 'BRA' }, minutesLeft: 25 })
    expect(p.title).toMatch(/Cerrás/)
    expect(p.body).toBe('ARG vs BRA — si no apostás, regalás puntos.')
    expect(p.url).toBe('/apuestas')
  })

  it('mensaje con nombre del torneo cuando faltan varios', () => {
    const p = buildPayload({ pending: 3, tournamentName: 'Mundial 2026', firstMatch: null })
    expect(p.body).toBe('Tenés 3 sin cargar en Mundial 2026. Ahora o nunca.')
  })

  it('mensaje genérico si no hay nombre de torneo y faltan varios', () => {
    const p = buildPayload({ pending: 2, tournamentName: null, firstMatch: null })
    expect(p.body).toBe('Tenés 2 pronósticos sin cargar. Ahora o nunca.')
  })
})

describe('getTournamentCutoffMinutes', () => {
  it('devuelve DEFAULT_CUTOFF_MINUTES (5) si no hay config', async () => {
    db.query.mockResolvedValueOnce({ rows: [] })
    const m = await getTournamentCutoffMinutes(T1)
    expect(m).toBe(DEFAULT_CUTOFF_MINUTES)
    expect(DEFAULT_CUTOFF_MINUTES).toBe(5)
  })

  it('devuelve el valor de config si existe', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ value: '10' }] })
    const m = await getTournamentCutoffMinutes(T1)
    expect(m).toBe(10)
  })

  it('devuelve default si config tiene valor inválido', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ value: 'abc' }] })
    const m = await getTournamentCutoffMinutes(T1)
    expect(m).toBe(DEFAULT_CUTOFF_MINUTES)
  })
})

describe('runCutoffReminders — tournament-level', () => {
  it('no-op si no hay torneos ni partidos en ventana', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })       // tournaments
      .mockResolvedValueOnce({ rows: [] })       // standalone matches

    const out = await runCutoffReminders()

    expect(out.tournaments_in_window).toBe(0)
    expect(out.standalone_matches).toBe(0)
    expect(out.users_notified).toBe(0)
    expect(pushToUser).not.toHaveBeenCalled()
  })

  it('ignora torneos cuyo cutoff está fuera de la ventana', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [
        // first_match en 5min → cutoff ya pasó
        { tournament_id: T1, tournament_name: 'X', first_match_start: firstMatchTooSoon(),
          first_match_id: M1, first_home: 'A', first_away: 'B' },
      ]})
      .mockResolvedValueOnce({ rows: [] }) // cutoff_minutes config
      .mockResolvedValueOnce({ rows: [] }) // standalone matches

    const out = await runCutoffReminders()

    expect(out.tournaments_in_window).toBe(0)
    expect(pushToUser).not.toHaveBeenCalled()
  })

  it('notifica a usuarios con bets faltantes en un torneo en ventana', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [
        { tournament_id: T1, tournament_name: 'Mundial', first_match_start: firstMatchIn30Min(),
          first_match_id: M1, first_home: 'ARG', first_away: 'BRA' },
      ]})
      .mockResolvedValueOnce({ rows: [] })                                        // cutoff_minutes config (default=5)
      .mockResolvedValueOnce({ rows: [{ user_id: U1, missing_count: '3',
        whatsapp_number: '+5491155996222', whatsapp_consent: true }] })           // missing bets + user info
      .mockResolvedValueOnce({ rows: [{ match_id: M1 }] })                        // INSERT reminder_sent RETURNING
      .mockResolvedValueOnce({ rows: [] })                                        // standalone matches

    const out = await runCutoffReminders()

    expect(out.tournaments_in_window).toBe(1)
    expect(out.users_notified).toBe(1)
    expect(pushToUser).toHaveBeenCalledWith(U1, expect.objectContaining({
      body: expect.stringContaining('3'),
    }))
    expect(sendSMS).toHaveBeenCalledWith(expect.objectContaining({
      to: '+5491155996222',
      body: expect.stringContaining('Mundial'),
    }))
    // Inserta notif in-app para historial (type='cutoff_reminder')
    const notifCall = db.query.mock.calls.find(c =>
      typeof c[0] === 'string' && /INSERT INTO notifications.*'cutoff_reminder'/s.test(c[0])
    )
    expect(notifCall).toBeDefined()
    expect(notifCall[1][0]).toBe(U1)
    expect(notifCall[1][1]).toBe(M1) // first_match_id
  })

  it('skip si reminder_sent ya tenía registro (ON CONFLICT)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [
        { tournament_id: T1, tournament_name: 'X', first_match_start: firstMatchIn30Min(),
          first_match_id: M1, first_home: 'A', first_away: 'B' },
      ]})
      .mockResolvedValueOnce({ rows: [] })                                        // cutoff_minutes config
      .mockResolvedValueOnce({ rows: [{ user_id: U1, missing_count: '2' }] })     // missing bets
      .mockResolvedValueOnce({ rows: [] })                                        // INSERT returns 0 rows = conflict
      .mockResolvedValueOnce({ rows: [] })                                        // standalone

    const out = await runCutoffReminders()

    expect(out.users_notified).toBe(0)
    expect(out.skipped).toBe(1)
    expect(pushToUser).not.toHaveBeenCalled()
  })

  it('no envía SMS si whatsapp_consent es false', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [
        { tournament_id: T1, tournament_name: 'X', first_match_start: firstMatchIn30Min(),
          first_match_id: M1, first_home: 'A', first_away: 'B' },
      ]})
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ user_id: U1, missing_count: '1',
        whatsapp_number: '+5491155996222', whatsapp_consent: false }] })
      .mockResolvedValueOnce({ rows: [{ match_id: M1 }] })
      .mockResolvedValueOnce({ rows: [] })

    await runCutoffReminders()

    expect(pushToUser).toHaveBeenCalledTimes(1)
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it('usa cutoff_minutes de config si está seteado (cutoff fuera de ventana)', async () => {
    // config = 15min → first_match en 60min → cutoff en 45min → fuera de ventana (20-40)
    db.query
      .mockResolvedValueOnce({ rows: [
        { tournament_id: T1, tournament_name: 'X', first_match_start: firstMatchIn60Min(),
          first_match_id: M1, first_home: 'A', first_away: 'B' },
      ]})
      .mockResolvedValueOnce({ rows: [{ value: '15' }] }) // cutoff_minutes = 15
      .mockResolvedValueOnce({ rows: [] }) // standalone

    const out = await runCutoffReminders()

    expect(out.tournaments_in_window).toBe(0)
    expect(pushToUser).not.toHaveBeenCalled()
  })
})

describe('runCutoffReminders — standalone matches', () => {
  it('notifica a usuarios con planilla y bet faltante en match sin tournament_id', async () => {
    const P1 = '55555555-5555-5555-5555-555555555555'
    db.query
      .mockResolvedValueOnce({ rows: [] }) // tournaments
      .mockResolvedValueOnce({ rows: [
        { id: M2, home_team: 'ARG', away_team: 'BRA',
          time_cutoff: new Date(Date.now() + 30 * 60 * 1000), planilla_id: P1 },
      ]})
      .mockResolvedValueOnce({ rows: [{ user_id: U1,
        whatsapp_number: '+5491155996222', whatsapp_consent: true }] }) // missing bets + user
      .mockResolvedValueOnce({ rows: [{ match_id: M2 }] }) // INSERT RETURNING

    const out = await runCutoffReminders()

    expect(out.standalone_matches).toBe(1)
    expect(out.users_notified).toBe(1)
    expect(sendSMS).toHaveBeenCalledWith(expect.objectContaining({
      to: '+5491155996222',
      body: expect.stringContaining('ARG vs BRA'),
    }))
  })

  it('filtra missing bets por planilla_id del match (no notifica a planillas ajenas)', async () => {
    const P1 = '55555555-5555-5555-5555-555555555555'
    db.query
      .mockResolvedValueOnce({ rows: [] }) // tournaments
      .mockResolvedValueOnce({ rows: [
        { id: M2, home_team: 'ARG', away_team: 'BRA',
          time_cutoff: new Date(Date.now() + 30 * 60 * 1000), planilla_id: P1 },
      ]})
      .mockResolvedValueOnce({ rows: [] }) // missing bets — ninguna planilla coincide
      .mockResolvedValueOnce({ rows: [] }) // no más queries

    const out = await runCutoffReminders()

    expect(out.users_notified).toBe(0)
    expect(pushToUser).not.toHaveBeenCalled()
    // Verifica que la query incluyó match.planilla_id como parámetro
    const missingBetsCall = db.query.mock.calls[2]
    expect(missingBetsCall[1]).toContain(P1)
  })
})

describe('constantes exportadas', () => {
  it('REMINDER_TYPE es estable', () => {
    expect(REMINDER_TYPE).toBe('cutoff_30min')
  })

  it('DEFAULT_CUTOFF_MINUTES es 5 (regla de negocio)', () => {
    expect(DEFAULT_CUTOFF_MINUTES).toBe(5)
  })
})
