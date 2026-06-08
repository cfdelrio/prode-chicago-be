'use strict'

jest.mock('../db/connection', () => ({ db: { query: jest.fn() } }))
jest.mock('../services/push', () => ({ pushToUser: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../services/sms', () => ({ sendSMSWithRetry: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../services/email', () => ({ sendEmail: jest.fn().mockResolvedValue(undefined) }))

const { db } = require('../db/connection')
const { pushToUser } = require('../services/push')
const { sendSMSWithRetry } = require('../services/sms')
const { sendEmail } = require('../services/email')
const { runPaymentReminders } = require('../services/reminderPayment')

const MATCH_ID = 'a0000000-0000-0000-0000-000000000001'
const USER_A   = 'b0000000-0000-0000-0000-000000000002'
const USER_B   = 'c0000000-0000-0000-0000-000000000003'
const PL_A     = 'd0000000-0000-0000-0000-000000000004'
const PL_B     = 'e0000000-0000-0000-0000-000000000005'

function makePlanilla(overrides = {}) {
  return {
    planilla_id: PL_A,
    nombre_planilla: 'Mi Planilla',
    user_id: USER_A,
    nombre: 'Ana',
    email: 'ana@test.com',
    whatsapp_number: null,
    whatsapp_consent: false,
    torneo_name: 'Mundial 2026',
    primer_partido: new Date(),
    first_match_id: MATCH_ID,
    ...overrides,
  }
}

beforeEach(() => {
  db.query.mockReset()
  pushToUser.mockClear()
  sendSMSWithRetry.mockClear()
  sendEmail.mockClear()
  db.query.mockResolvedValue({ rows: [] })
})

describe('runPaymentReminders', () => {
  it('no-op cuando no hay planillas sin pagar en la ventana de 7 días', async () => {
    db.query.mockResolvedValueOnce({ rows: [] })

    const result = await runPaymentReminders()

    expect(result.planillas_found).toBe(0)
    expect(result.users_notified).toBe(0)
    expect(pushToUser).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
    expect(sendSMSWithRetry).not.toHaveBeenCalled()
  })

  it('envía push + in-app + email a usuario con planilla sin pagar', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [makePlanilla()] })  // planillas query
      .mockResolvedValueOnce({ rows: [{ user_id: USER_A }] }) // reminder_sent INSERT success

    const result = await runPaymentReminders()

    expect(result.users_notified).toBe(1)
    expect(pushToUser).toHaveBeenCalledTimes(1)
    expect(pushToUser).toHaveBeenCalledWith(USER_A, expect.objectContaining({
      title: expect.stringContaining('sin pagar'),
      body: expect.stringContaining('Sin pago no sumás puntos'),
    }))
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'ana@test.com',
      subject: expect.stringContaining('Mi Planilla'),
    }))
  })

  it('envía SMS si el usuario tiene whatsapp_number y consent', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [makePlanilla({ whatsapp_number: '+5491155996222', whatsapp_consent: true })] })
      .mockResolvedValueOnce({ rows: [{ user_id: USER_A }] })

    await runPaymentReminders()

    expect(sendSMSWithRetry).toHaveBeenCalledTimes(1)
    expect(sendSMSWithRetry).toHaveBeenCalledWith(expect.objectContaining({
      to: '+5491155996222',
      body: expect.stringContaining('Mi Planilla'),
    }))
  })

  it('no envía SMS si el usuario no tiene consent', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [makePlanilla({ whatsapp_number: '+5491155996222', whatsapp_consent: false })] })
      .mockResolvedValueOnce({ rows: [{ user_id: USER_A }] })

    await runPaymentReminders()

    expect(sendSMSWithRetry).not.toHaveBeenCalled()
  })

  it('no reenvía si ya existe reminder_sent para esa planilla', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [makePlanilla()] })
      .mockResolvedValueOnce({ rows: [] }) // reminder_sent conflict

    const result = await runPaymentReminders()

    expect(result.skipped).toBe(1)
    expect(result.users_notified).toBe(0)
    expect(pushToUser).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('procesa múltiples planillas sin pagar', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [
        makePlanilla({ planilla_id: PL_A, user_id: USER_A, nombre: 'Ana', email: 'a@t.com' }),
        makePlanilla({ planilla_id: PL_B, user_id: USER_B, nombre: 'Bob', email: 'b@t.com', first_match_id: '99999999-0000-0000-0000-000000000001' }),
      ] })
      .mockResolvedValueOnce({ rows: [{ user_id: USER_A }] })   // reminder_sent A success
      .mockResolvedValueOnce({ rows: [] })                       // notification A
      .mockResolvedValueOnce({ rows: [{ user_id: USER_B }] })   // reminder_sent B success
      .mockResolvedValueOnce({ rows: [] })                       // notification B

    const result = await runPaymentReminders()

    expect(result.users_notified).toBe(2)
    expect(pushToUser).toHaveBeenCalledTimes(2)
    expect(sendEmail).toHaveBeenCalledTimes(2)
  })

  it('no envía email si el usuario no tiene email', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [makePlanilla({ email: null })] })
      .mockResolvedValueOnce({ rows: [{ user_id: USER_A }] })

    await runPaymentReminders()

    expect(pushToUser).toHaveBeenCalledTimes(1)
    expect(sendEmail).not.toHaveBeenCalled()
  })
})
