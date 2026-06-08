'use strict'

jest.mock('../db/connection', () => ({ db: { query: jest.fn() } }))
jest.mock('../services/email', () => ({ sendRankingUpdateEmail: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../services/push', () => ({ pushToUser: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../services/tournamentRanking', () => ({ recalculateTournamentRanking: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../services/cache', () => ({ invalidatePrefix: jest.fn() }))

const { db } = require('../db/connection')
const { pushToUser } = require('../services/push')
const { actualizarRanking } = require('../routes/matches')

const MATCH_ID = 'a0000000-0000-0000-0000-000000000001'
const USER_A   = 'b0000000-0000-0000-0000-000000000002'
const USER_B   = 'c0000000-0000-0000-0000-000000000003'
const USER_C   = 'd0000000-0000-0000-0000-000000000004'
const PL_A     = 'e0000000-0000-0000-0000-000000000005'
const PL_B     = 'f0000000-0000-0000-0000-000000000006'
const PL_C     = '10000000-0000-0000-0000-000000000007'

function mockRankingSequence({ prevRows, newRows, nearPodioConflict = false }) {
  // 1. prevResult SELECT
  db.query.mockResolvedValueOnce({ rows: prevRows })
  // 2. INSERT/UPSERT ranking totals
  db.query.mockResolvedValueOnce({ rows: [] })
  // 3. UPDATE unpaid planillas → position = NULL
  db.query.mockResolvedValueOnce({ rows: [] })
  // 4. UPDATE positions via ROW_NUMBER()
  db.query.mockResolvedValueOnce({ rows: [] })
  // 5. newResult SELECT
  db.query.mockResolvedValueOnce({ rows: newRows })

  // For each row that triggers a notification we need to mock the INSERT
  // We use mockResolvedValue (default) for the rest
  if (nearPodioConflict) {
    db.query.mockResolvedValueOnce({ rows: [] }) // reminder_sent conflict → skip
  }
}

beforeEach(() => {
  db.query.mockReset()
  pushToUser.mockClear()
  // Default fallback for any extra queries (emails, inserts)
  db.query.mockResolvedValue({ rows: [] })
})

// ──────────────────────────────────────────────────────────────────────────────
// "Te pasaron en el ranking"
// ──────────────────────────────────────────────────────────────────────────────

describe('"Te pasaron en el ranking"', () => {
  it('notifica push + in-app cuando alguien te supera', async () => {
    // USER_A estaba #1, ahora está #2; USER_B estaba #2, ahora está #1
    const prevRows = [
      { planilla_id: PL_A, position: 1, puntos_totales: 10, user_id: USER_A, nombre: 'Ana', email: 'ana@test.com' },
      { planilla_id: PL_B, position: 2, puntos_totales: 8,  user_id: USER_B, nombre: 'Bob', email: 'bob@test.com' },
    ]
    const newRows = [
      { planilla_id: PL_A, position: 2, puntos_totales: 10, user_id: USER_A, nombre_planilla: 'Mi Planilla', nombre: 'Ana', email: 'ana@test.com' },
      { planilla_id: PL_B, position: 1, puntos_totales: 12, user_id: USER_B, nombre_planilla: 'Su Planilla', nombre: 'Bob', email: 'bob@test.com' },
    ]

    mockRankingSequence({ prevRows, newRows })

    await actualizarRanking(MATCH_ID)

    // USER_A should receive "te pasaron" notification (dynamic title with overtaker's name)
    const pasaronCalls = pushToUser.mock.calls.filter(c =>
      typeof c[1]?.title === 'string' && c[1].title.includes('te bajó del')
    )
    expect(pasaronCalls.length).toBe(1)
    expect(pasaronCalls[0][0]).toBe(USER_A)
    // USER_B should NOT receive "te pasaron" (they moved up)
    expect(pasaronCalls.some(c => c[0] === USER_B)).toBe(false)
  })

  it('el cuerpo del mensaje menciona quién te pasó y la posición', async () => {
    const prevRows = [
      { planilla_id: PL_A, position: 2, puntos_totales: 8,  user_id: USER_A, nombre: 'Ana', email: 'a@t.com' },
      { planilla_id: PL_B, position: 3, puntos_totales: 6,  user_id: USER_B, nombre: 'Bob', email: 'b@t.com' },
    ]
    const newRows = [
      { planilla_id: PL_A, position: 3, puntos_totales: 8,  user_id: USER_A, nombre_planilla: 'Mi Planilla', nombre: 'Ana', email: 'a@t.com' },
      { planilla_id: PL_B, position: 2, puntos_totales: 10, user_id: USER_B, nombre_planilla: 'Su Planilla', nombre: 'Bob', email: 'b@t.com' },
    ]

    mockRankingSequence({ prevRows, newRows })
    await actualizarRanking(MATCH_ID)

    const call = pushToUser.mock.calls.find(c =>
      c[0] === USER_A && typeof c[1]?.title === 'string' && c[1].title.includes('te bajó del')
    )
    expect(call).toBeDefined()
    expect(call[1].title).toContain('Bob')
    expect(call[1].body).toContain('#3')
  })

  it('no notifica si el usuario no tenía posición previa (primera vez en ranking)', async () => {
    const prevRows = [
      { planilla_id: PL_A, position: null, puntos_totales: 0, user_id: USER_A, nombre: 'Ana', email: 'a@t.com' },
    ]
    const newRows = [
      { planilla_id: PL_A, position: 1, puntos_totales: 5, user_id: USER_A, nombre_planilla: 'P', nombre: 'Ana', email: 'a@t.com' },
    ]

    mockRankingSequence({ prevRows, newRows })
    await actualizarRanking(MATCH_ID)

    const pasaronCalls = pushToUser.mock.calls.filter(c =>
      typeof c[1]?.title === 'string' && c[1].title.includes('te bajó del')
    )
    expect(pasaronCalls).toHaveLength(0)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// "Cerca del podio"
// ──────────────────────────────────────────────────────────────────────────────

describe('"Cerca del podio"', () => {
  it('notifica cuando un usuario está a ≤5 pts del #3', async () => {
    const prevRows = [
      { planilla_id: PL_A, position: 1, puntos_totales: 20, user_id: USER_A, nombre: 'Ana', email: 'a@t.com' },
      { planilla_id: PL_B, position: 2, puntos_totales: 18, user_id: USER_B, nombre: 'Bob', email: 'b@t.com' },
      { planilla_id: PL_C, position: 4, puntos_totales: 10, user_id: USER_C, nombre: 'Car', email: 'c@t.com' },
    ]
    const newRows = [
      { planilla_id: PL_A, position: 1, puntos_totales: 20, user_id: USER_A, nombre_planilla: 'PA', nombre: 'Ana', email: 'a@t.com' },
      { planilla_id: PL_B, position: 2, puntos_totales: 18, user_id: USER_B, nombre_planilla: 'PB', nombre: 'Bob', email: 'b@t.com' },
      { planilla_id: PL_C, position: 4, puntos_totales: 15, user_id: USER_C, nombre_planilla: 'PC', nombre: 'Car', email: 'c@t.com' },
    ]
    // #3 doesn't exist in this scenario → no near-podio (need a row at position 3)
    // Let's add a #3 row
    newRows.push({ planilla_id: '30000000-0000-0000-0000-000000000003', position: 3, puntos_totales: 17, user_id: '30000000-0000-0000-0000-000000000099', nombre_planilla: 'P3', nombre: 'Tres', email: 't@t.com' })
    prevRows.push({ planilla_id: '30000000-0000-0000-0000-000000000003', position: 3, puntos_totales: 15, user_id: '30000000-0000-0000-0000-000000000099', nombre: 'Tres', email: 't@t.com' })

    // reminder_sent INSERT returns a row (new notification)
    db.query
      .mockResolvedValueOnce({ rows: prevRows })     // prevResult
      .mockResolvedValueOnce({ rows: [] })            // INSERT ranking
      .mockResolvedValueOnce({ rows: [] })            // UPDATE NULL positions
      .mockResolvedValueOnce({ rows: [] })            // UPDATE positions
      .mockResolvedValueOnce({ rows: newRows })       // newResult
      .mockResolvedValue({ rows: [{ user_id: USER_C }] }) // reminder_sent INSERT succeeds

    await actualizarRanking(MATCH_ID)

    const nearCalls = pushToUser.mock.calls.filter(c =>
      typeof c[1]?.title === 'string' && (
        c[1].title.includes('podio') || c[1].title.includes('Zona de podio')
      )
    )
    expect(nearCalls).toHaveLength(1)
    expect(nearCalls[0][0]).toBe(USER_C)
    // gap = 17 - 15 = 2 pts → title: '🎯 A 2 pts del podio'
    expect(nearCalls[0][1].title).toContain('2 pts')
  })

  it('no notifica cuando el gap es >5 pts', async () => {
    const prevRows = [
      { planilla_id: PL_A, position: 1, puntos_totales: 20, user_id: USER_A, nombre: 'Ana', email: 'a@t.com' },
      { planilla_id: PL_B, position: 2, puntos_totales: 18, user_id: USER_B, nombre: 'Bob', email: 'b@t.com' },
      { planilla_id: PL_C, position: 4, puntos_totales: 5,  user_id: USER_C, nombre: 'Car', email: 'c@t.com' },
    ]
    const newRows = [
      { planilla_id: PL_A, position: 1, puntos_totales: 20, user_id: USER_A, nombre_planilla: 'PA', nombre: 'Ana', email: 'a@t.com' },
      { planilla_id: PL_B, position: 2, puntos_totales: 18, user_id: USER_B, nombre_planilla: 'PB', nombre: 'Bob', email: 'b@t.com' },
      { planilla_id: '30000000-0000-0000-0000-000000000003', position: 3, puntos_totales: 15, user_id: '30000000-0000-0000-0000-000000000099', nombre_planilla: 'P3', nombre: 'Tres', email: 't@t.com' },
      { planilla_id: PL_C, position: 4, puntos_totales: 5,  user_id: USER_C, nombre_planilla: 'PC', nombre: 'Car', email: 'c@t.com' },
    ]

    mockRankingSequence({ prevRows, newRows })
    await actualizarRanking(MATCH_ID)

    const nearCalls = pushToUser.mock.calls.filter(c =>
      c[1]?.title === '🎯 Cerca del podio'
    )
    expect(nearCalls).toHaveLength(0)
  })

  it('no notifica si matchId es null (recalculate-ranking manual)', async () => {
    const prevRows = [
      { planilla_id: PL_A, position: 1, puntos_totales: 20, user_id: USER_A, nombre: 'Ana', email: 'a@t.com' },
      { planilla_id: PL_B, position: 3, puntos_totales: 17, user_id: USER_B, nombre: 'Bob', email: 'b@t.com' },
      { planilla_id: PL_C, position: 4, puntos_totales: 15, user_id: USER_C, nombre: 'Car', email: 'c@t.com' },
    ]
    const newRows = [
      { planilla_id: PL_A, position: 1, puntos_totales: 20, user_id: USER_A, nombre_planilla: 'PA', nombre: 'Ana', email: 'a@t.com' },
      { planilla_id: PL_B, position: 3, puntos_totales: 17, user_id: USER_B, nombre_planilla: 'PB', nombre: 'Bob', email: 'b@t.com' },
      { planilla_id: PL_C, position: 4, puntos_totales: 15, user_id: USER_C, nombre_planilla: 'PC', nombre: 'Car', email: 'c@t.com' },
    ]

    mockRankingSequence({ prevRows, newRows })
    await actualizarRanking(null) // manual recalc — no matchId

    const nearCalls = pushToUser.mock.calls.filter(c =>
      c[1]?.title === '🎯 Cerca del podio'
    )
    expect(nearCalls).toHaveLength(0)
  })

  it('no reenvía si ya existe reminder_sent para ese partido', async () => {
    const prevRows = [
      { planilla_id: PL_A, position: 1, puntos_totales: 20, user_id: USER_A, nombre: 'Ana', email: 'a@t.com' },
      { planilla_id: PL_B, position: 3, puntos_totales: 17, user_id: USER_B, nombre: 'Bob', email: 'b@t.com' },
      { planilla_id: PL_C, position: 4, puntos_totales: 15, user_id: USER_C, nombre: 'Car', email: 'c@t.com' },
    ]
    const newRows = [
      { planilla_id: PL_A, position: 1, puntos_totales: 20, user_id: USER_A, nombre_planilla: 'PA', nombre: 'Ana', email: 'a@t.com' },
      { planilla_id: PL_B, position: 3, puntos_totales: 17, user_id: USER_B, nombre_planilla: 'PB', nombre: 'Bob', email: 'b@t.com' },
      { planilla_id: PL_C, position: 4, puntos_totales: 15, user_id: USER_C, nombre_planilla: 'PC', nombre: 'Car', email: 'c@t.com' },
    ]

    db.query
      .mockResolvedValueOnce({ rows: prevRows })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: newRows })
      .mockResolvedValue({ rows: [] }) // reminder_sent conflict → no rows returned

    await actualizarRanking(MATCH_ID)

    const nearCalls = pushToUser.mock.calls.filter(c =>
      c[1]?.title === '🎯 Cerca del podio'
    )
    expect(nearCalls).toHaveLength(0)
  })
})
