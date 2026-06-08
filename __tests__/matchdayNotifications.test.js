'use strict'

jest.mock('../db/connection', () => ({ db: { query: jest.fn() } }))
jest.mock('../services/push', () => ({ pushToUser: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../services/email', () => ({
  sendPostMatchdayEmail: jest.fn().mockResolvedValue(undefined),
}))

const { db } = require('../db/connection')
const { pushToUser } = require('../services/push')
const { sendPostMatchdayEmail } = require('../services/email')

// Import the private function by requiring the module (it exports via router internals,
// but we'll unit-test by calling the helper directly. We expose it for testing.)
// Since _notifyMatchdayClose is not exported, we test via the exported recalcMatchday
// indirectly by mocking the full scenario in an integration style.

// Instead, let's test the helper by requiring a wrapper. We'll do a manual import test.
// The function _notifyMatchdayClose is embedded in matchdays.js.
// We'll simulate by mocking all dependencies and calling the exported router indirectly.

// Actually, let's extract the logic by using jest module augmentation or just test the
// key behaviors through observable side effects (push + in-app inserts).

// We'll expose the private function through a test-only export pattern by requiring
// matchdays.js with jest and checking db.query calls.

// ── Setup ────────────────────────────────────────────────────────────────────

const USER_A  = 'a0000000-0000-0000-0000-000000000001'
const USER_B  = 'b0000000-0000-0000-0000-000000000002'
const PL_A    = 'c0000000-0000-0000-0000-000000000003'
const PL_B    = 'd0000000-0000-0000-0000-000000000004'
const MD_ID   = 'e0000000-0000-0000-0000-000000000005'

// We'll directly require and invoke _notifyMatchdayClose by accessing module internals
// via a thin wrapper module. Since we can't reach private fns directly, we test via
// mocking the full recalcMatchday integration scenario.

// For focused unit tests we'll invoke _notifyMatchdayClose through a test shim.
// We expose it by creating a temporary wrapper around the module's DB mocks.

// ── Approach: require the module, mock all, trigger indirectly ────────────────

// Additional mocks needed by matchdays.js
jest.mock('../middleware/auth', () => ({
  authMiddleware: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}))
jest.mock('../services/whatsapp', () => ({
  sendWhatsAppTemplate: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../services/concurrency', () => ({
  runConcurrent: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({}),
  })),
  InvokeCommand: jest.fn(),
}))

// ── Helper: build a minimal matchday scenario where all matches are finished ──

function mockRecalcMatchdayFull({
  matchdayId = MD_ID,
  matchday = { id: MD_ID, tournament_id: 't1', match_date: '2025-06-01', name: 'Fecha 1', winner_announced_at: null },
  matchRows = [],         // finished matches
  totalMatchCount = 1,
  betsRows = [],
  planillaRows = [],
  users = [],
  histMax = null,         // previous max for personal record
  streakScores = [],      // recent scores for streak
}) {
  // recalcMatchday queries in order:
  // 1. SELECT matchday
  db.query.mockResolvedValueOnce({ rows: [matchday] })
  // 2. SELECT finished matches
  db.query.mockResolvedValueOnce({ rows: matchRows })
  // if no matches, early return — else:
  if (matchRows.length === 0) return

  // 3. SELECT bets
  db.query.mockResolvedValueOnce({ rows: betsRows })
  // 4. INSERT scores_by_matchday (one per planilla — use mockResolvedValue for multiple)
  planillaRows.forEach(() => db.query.mockResolvedValueOnce({ rows: [] }))
  // 5. SELECT COUNT total matches
  db.query.mockResolvedValueOnce({ rows: [{ total: String(totalMatchCount) }] })

  // _notifyMatchdayClose queries (only if allFinished && !winner_announced_at):
  // 6. SELECT emails
  db.query.mockResolvedValueOnce({ rows: users.map(u => ({ id: u.user_id, email: u.email })) })
  // 7. SELECT global ranking positions
  db.query.mockResolvedValueOnce({ rows: users.map((u, i) => ({ user_id: u.user_id, position: i + 4 })) })

  // For each planilla: summary insert, record query, streak query
  planillaRows.forEach((pl, i) => {
    // summary notification INSERT
    db.query.mockResolvedValueOnce({ rows: [] })
    // record: MAX(points) historical
    db.query.mockResolvedValueOnce({ rows: [{ max_pts: histMax }] })
    if (histMax !== null && pl.points > parseInt(histMax)) {
      // record notification INSERT
      db.query.mockResolvedValueOnce({ rows: [] })
    }
    // streak scores query
    db.query.mockResolvedValueOnce({ rows: streakScores })
    if (streakScores.filter(s => s.puntos_obtenidos >= 3).length >= 3) {
      const count = streakScores.filter(s => s.puntos_obtenidos >= 3).length
      // Only if streak % 3 === 0
      if (count % 3 === 0) {
        db.query.mockResolvedValueOnce({ rows: [] }) // streak notification INSERT
      }
    }
  })

  // winner-notification path:
  // SELECT emails for winner
  db.query.mockResolvedValueOnce({ rows: users.map(u => ({ id: u.user_id, email: u.email })) })
  // UPDATE matchdays winner_announced_at
  db.query.mockResolvedValueOnce({ rows: [] })
}

beforeEach(() => {
  db.query.mockReset()
  pushToUser.mockClear()
  sendPostMatchdayEmail.mockClear()
  db.query.mockResolvedValue({ rows: [] })
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('_notifyMatchdayClose — resumen post-fecha', () => {
  it('envía push de resumen a todos los jugadores al cerrar la fecha', async () => {
    const { recalcMatchday } = getRecalcMatchday()

    const matchRows = [{ id: 'm1', resultado_local: 2, resultado_visitante: 1 }]
    const betsRows = [
      { planilla_id: PL_A, match_id: 'm1', goles_local: 2, goles_visitante: 1, user_id: USER_A, user_name: 'Ana', user_avatar: null },
      { planilla_id: PL_B, match_id: 'm1', goles_local: 0, goles_visitante: 0, user_id: USER_B, user_name: 'Bob', user_avatar: null },
    ]
    mockRecalcMatchdayFull({
      matchRows, betsRows, totalMatchCount: 1,
      planillaRows: [{ planilla_id: PL_A, points: 3 }, { planilla_id: PL_B, points: 0 }],
      users: [
        { user_id: USER_A, email: 'a@t.com' },
        { user_id: USER_B, email: 'b@t.com' },
      ],
    })

    await recalcMatchday(MD_ID)

    const summaryCalls = pushToUser.mock.calls.filter(c =>
      c[1]?.title?.includes('Fecha 1')
    )
    expect(summaryCalls.length).toBeGreaterThanOrEqual(2)
  })

  it('envía email de resumen a usuarios con email', async () => {
    const { recalcMatchday } = getRecalcMatchday()

    const matchRows = [{ id: 'm1', resultado_local: 1, resultado_visitante: 0 }]
    const betsRows = [
      { planilla_id: PL_A, match_id: 'm1', goles_local: 1, goles_visitante: 0, user_id: USER_A, user_name: 'Ana', user_avatar: null },
    ]
    mockRecalcMatchdayFull({
      matchRows, betsRows, totalMatchCount: 1,
      planillaRows: [{ planilla_id: PL_A, points: 3 }],
      users: [{ user_id: USER_A, email: 'ana@test.com' }],
    })

    await recalcMatchday(MD_ID)

    expect(sendPostMatchdayEmail).toHaveBeenCalledWith(expect.objectContaining({
      userEmail: 'ana@test.com',
      userName: 'Ana',
      matchdayName: 'Fecha 1',
    }))
  })
})

describe('_notifyMatchdayClose — récord personal', () => {
  it('notifica si los puntos de esta fecha superan el histórico', async () => {
    const { recalcMatchday } = getRecalcMatchday()

    // Exact result → calcularPuntaje returns 3 pts; histMax = 2 → 3 > 2 → notify
    const matchRows = [{ id: 'm1', resultado_local: 2, resultado_visitante: 0 }]
    const betsRows = [
      { planilla_id: PL_A, match_id: 'm1', goles_local: 2, goles_visitante: 0, user_id: USER_A, user_name: 'Ana', user_avatar: null },
    ]
    mockRecalcMatchdayFull({
      matchRows, betsRows, totalMatchCount: 1,
      planillaRows: [{ planilla_id: PL_A, points: 3 }], // actual score from calcularPuntaje
      users: [{ user_id: USER_A, email: 'a@t.com' }],
      histMax: '2', // previous best was 2, now got 3 → record!
    })

    await recalcMatchday(MD_ID)

    const recordCalls = pushToUser.mock.calls.filter(c =>
      c[1]?.title === '🔥 Nuevo récord personal'
    )
    expect(recordCalls.length).toBe(1)
    expect(recordCalls[0][0]).toBe(USER_A)
  })

  it('no notifica si no supera el histórico', async () => {
    const { recalcMatchday } = getRecalcMatchday()

    const matchRows = [{ id: 'm1', resultado_local: 1, resultado_visitante: 0 }]
    const betsRows = [
      { planilla_id: PL_A, match_id: 'm1', goles_local: 1, goles_visitante: 0, user_id: USER_A, user_name: 'Ana', user_avatar: null },
    ]
    mockRecalcMatchdayFull({
      matchRows, betsRows, totalMatchCount: 1,
      planillaRows: [{ planilla_id: PL_A, points: 2 }],
      users: [{ user_id: USER_A, email: 'a@t.com' }],
      histMax: '5', // previous best was 5, now got 2
    })

    await recalcMatchday(MD_ID)

    const recordCalls = pushToUser.mock.calls.filter(c =>
      c[1]?.title === '🔥 Nuevo récord personal'
    )
    expect(recordCalls).toHaveLength(0)
  })
})

describe('_notifyMatchdayClose — streak de exactos', () => {
  it('notifica en múltiplos de 3 exactos seguidos', async () => {
    const { recalcMatchday } = getRecalcMatchday()

    const matchRows = [{ id: 'm1', resultado_local: 2, resultado_visitante: 1 }]
    const betsRows = [
      { planilla_id: PL_A, match_id: 'm1', goles_local: 2, goles_visitante: 1, user_id: USER_A, user_name: 'Ana', user_avatar: null },
    ]
    const streakScores = [
      { puntos_obtenidos: 3 },
      { puntos_obtenidos: 3 },
      { puntos_obtenidos: 3 },
    ] // 3 consecutive exactos

    mockRecalcMatchdayFull({
      matchRows, betsRows, totalMatchCount: 1,
      planillaRows: [{ planilla_id: PL_A, points: 3 }],
      users: [{ user_id: USER_A, email: 'a@t.com' }],
      streakScores,
    })

    await recalcMatchday(MD_ID)

    const streakCalls = pushToUser.mock.calls.filter(c =>
      c[1]?.title?.includes('exactos')
    )
    expect(streakCalls.length).toBe(1)
    expect(streakCalls[0][1].title).toContain('3 exactos')
  })

  it('no notifica si el streak no es múltiplo de 3', async () => {
    const { recalcMatchday } = getRecalcMatchday()

    const matchRows = [{ id: 'm1', resultado_local: 2, resultado_visitante: 1 }]
    const betsRows = [
      { planilla_id: PL_A, match_id: 'm1', goles_local: 2, goles_visitante: 1, user_id: USER_A, user_name: 'Ana', user_avatar: null },
    ]
    const streakScores = [
      { puntos_obtenidos: 3 },
      { puntos_obtenidos: 3 },
      { puntos_obtenidos: 1 }, // streak breaks at 2
    ]

    mockRecalcMatchdayFull({
      matchRows, betsRows, totalMatchCount: 1,
      planillaRows: [{ planilla_id: PL_A, points: 3 }],
      users: [{ user_id: USER_A, email: 'a@t.com' }],
      streakScores,
    })

    await recalcMatchday(MD_ID)

    const streakCalls = pushToUser.mock.calls.filter(c =>
      c[1]?.title?.includes('exactos')
    )
    expect(streakCalls).toHaveLength(0)
  })

  it('no envía notificaciones si la fecha no está completa', async () => {
    const { recalcMatchday } = getRecalcMatchday()

    // matchday has 3 total matches but only 1 is finished
    db.query
      .mockResolvedValueOnce({ rows: [{ id: MD_ID, tournament_id: 't1', match_date: '2025-06-01', name: 'Fecha 1', winner_announced_at: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'm1', resultado_local: 1, resultado_visitante: 0 }] }) // 1 finished match
      .mockResolvedValueOnce({ rows: [{ planilla_id: PL_A, match_id: 'm1', goles_local: 1, goles_visitante: 0, user_id: USER_A, user_name: 'Ana', user_avatar: null }] }) // bets
      .mockResolvedValueOnce({ rows: [] }) // scores_by_matchday INSERT
      .mockResolvedValueOnce({ rows: [{ total: '3' }] }) // total matches = 3 → allFinished = false

    await recalcMatchday(MD_ID)

    expect(sendPostMatchdayEmail).not.toHaveBeenCalled()
    const summaryCalls = pushToUser.mock.calls.filter(c => c[1]?.title?.includes('cerrada'))
    expect(summaryCalls).toHaveLength(0)
  })
})

// ── Helper to get recalcMatchday from matchdays module ────────────────────────

function getRecalcMatchday() {
  // recalcMatchday is not exported directly, access via module export
  const matchdays = require('../routes/matchdays')
  // It exports the router; recalcMatchday is called internally.
  // We expose it for testing via a known export pattern.
  // If not exported, we need to test through HTTP or extract it.
  // Check if the module exports it:
  if (typeof matchdays.recalcMatchday === 'function') {
    return { recalcMatchday: matchdays.recalcMatchday }
  }
  // Fall back: access via module's internal exports
  return { recalcMatchday: matchdays.recalcMatchday || matchdays._recalcMatchday }
}
