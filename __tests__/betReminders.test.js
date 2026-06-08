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
const { processBetReminders } = require('../services/betReminders')

const U1 = '11111111-1111-1111-1111-111111111111'
const M1 = '22222222-2222-2222-2222-222222222222'
const M2 = '33333333-3333-3333-3333-333333333333'

beforeEach(() => {
  db.query.mockReset()
  // Default for any unmocked call (e.g. notifications INSERT, bet_reminders UPDATE)
  db.query.mockResolvedValue({ rows: [] })
  pushToUser.mockClear()
  sendSMS.mockClear()
})

describe('processBetReminders', () => {
  it('no-op cuando no hay rows due', async () => {
    db.query.mockResolvedValueOnce({ rows: [] })

    const out = await processBetReminders()

    expect(out).toEqual({ processed: 0, sent: 0, failed: 0 })
    expect(pushToUser).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it('envía push y SMS y marca email_sent=true', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [
        { id: 1, user_id: U1, match_id: M1, remind_minutes: 30,
          home_team: 'ARG', away_team: 'BRA', start_time: new Date(),
          whatsapp_number: '+5491155996222', whatsapp_consent: true },
      ]})
      .mockResolvedValueOnce({ rows: [] }) // UPDATE

    const out = await processBetReminders()

    expect(out.sent).toBe(1)
    expect(pushToUser).toHaveBeenCalledWith(U1, expect.objectContaining({
      title: expect.stringContaining('30 min'),
      body: expect.stringContaining('todavía podés apostar'),
    }))
    expect(sendSMS).toHaveBeenCalledWith(expect.objectContaining({
      to: '+5491155996222',
      body: expect.stringContaining('30 min'),
    }))
    // call[0]=SELECT, call[1]=INSERT notifications, call[2]=UPDATE bet_reminders
    expect(db.query.mock.calls[1][0]).toMatch(/INSERT INTO notifications.*'bet_reminder'/s)
    expect(db.query.mock.calls[1][1][0]).toBe(U1)
    expect(db.query.mock.calls[1][1][1]).toBe(M1)
    expect(db.query.mock.calls[2][0]).toMatch(/UPDATE bet_reminders SET email_sent = true/)
    expect(db.query.mock.calls[2][1]).toEqual([1])
  })

  it('no envía SMS si whatsapp_consent es false', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [
        { id: 2, user_id: U1, match_id: M1, remind_minutes: 30,
          home_team: 'ARG', away_team: 'BRA', start_time: new Date(),
          whatsapp_number: '+5491155996222', whatsapp_consent: false },
      ]})
      .mockResolvedValueOnce({ rows: [] })

    await processBetReminders()

    expect(pushToUser).toHaveBeenCalledTimes(1)
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it('no envía SMS si no hay whatsapp_number', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [
        { id: 3, user_id: U1, match_id: M1, remind_minutes: 30,
          home_team: 'ARG', away_team: 'BRA', start_time: new Date(),
          whatsapp_number: null, whatsapp_consent: true },
      ]})
      .mockResolvedValueOnce({ rows: [] })

    await processBetReminders()

    expect(sendSMS).not.toHaveBeenCalled()
  })

  it('procesa varios reminders independientemente', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [
        { id: 1, user_id: U1, match_id: M1, remind_minutes: 30,
          home_team: 'A', away_team: 'B', start_time: new Date(),
          whatsapp_number: '+5491155996222', whatsapp_consent: true },
        { id: 2, user_id: U1, match_id: M2, remind_minutes: 15,
          home_team: 'C', away_team: 'D', start_time: new Date(),
          whatsapp_number: null, whatsapp_consent: false },
      ]})
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const out = await processBetReminders()

    expect(out.processed).toBe(2)
    expect(out.sent).toBe(2)
    expect(pushToUser).toHaveBeenCalledTimes(2)
    expect(sendSMS).toHaveBeenCalledTimes(1)
  })

  it('no rompe si push/sms fallan — loggea y sigue', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [
        { id: 1, user_id: U1, match_id: M1, remind_minutes: 30,
          home_team: 'A', away_team: 'B', start_time: new Date(),
          whatsapp_number: '+5491155996222', whatsapp_consent: true },
      ]})
      .mockResolvedValueOnce({ rows: [] })
    pushToUser.mockRejectedValueOnce(new Error('push fail'))
    sendSMS.mockRejectedValueOnce(new Error('sms fail'))

    const out = await processBetReminders()

    expect(out.sent).toBe(1) // still marked sent
    expect(out.failed).toBe(0)
  })

  it('respeta el remind_minutes guardado por usuario (15 min)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [
        { id: 1, user_id: U1, match_id: M1, remind_minutes: 15,
          home_team: 'ARG', away_team: 'BRA', start_time: new Date(),
          whatsapp_number: '+5491155996222', whatsapp_consent: true },
      ]})
      .mockResolvedValueOnce({ rows: [] })

    await processBetReminders()

    expect(pushToUser).toHaveBeenCalledWith(U1, expect.objectContaining({
      title: expect.stringContaining('15 min'),
    }))
    expect(sendSMS).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('15 min'),
    }))
  })
})
