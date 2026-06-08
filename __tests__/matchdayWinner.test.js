'use strict'

const mockQuery = jest.fn()
const mockSend = jest.fn().mockResolvedValue({})

jest.mock('../db/connection', () => ({
  db: { query: mockQuery },
}))

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  InvokeCommand: jest.fn().mockImplementation(params => params),
}))

jest.mock('../services/scoring', () => ({
  calcularPuntaje: jest.fn().mockReturnValue({ puntos: 3, bonus: false, detalle: {} }),
}))

jest.mock('../services/push', () => ({ pushToUser: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../services/email', () => ({
  sendPostMatchdayEmail: jest.fn().mockResolvedValue(undefined),
  sendEmail: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../services/whatsapp', () => ({ sendWhatsAppTemplate: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../services/concurrency', () => ({ runConcurrent: jest.fn().mockResolvedValue(undefined) }))

const { recalcMatchday } = require('../routes/matchdays')

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MATCHDAY = {
  id: 'md-1',
  tournament_id: 't-1',
  match_date: '2026-05-15',
  name: 'Fecha 15/05',
  winner_announced_at: null,
}

const MATCH = { id: 'm-1', resultado_local: 2, resultado_visitante: 1 }

const BET = {
  planilla_id: 'p-1', match_id: 'm-1',
  goles_local: 2, goles_visitante: 1,
  user_id: 'u-1', user_name: 'Cacho', user_avatar: null,
}

function q(rows) { return { rows } }

function setupSequence(...results) {
  results.forEach(r => mockQuery.mockResolvedValueOnce(r))
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('recalcMatchday — winner notification guard', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSend.mockResolvedValue({})
    // Default fallback: _notifyMatchdayClose intermediate queries return safe empty result
    mockQuery.mockResolvedValue({ rows: [] })
  })

  it('sin partidos terminados → retorna early sin notificación', async () => {
    setupSequence(
      q([MATCHDAY]),  // SELECT matchday
      q([]),          // SELECT finished matches → vacío
    )

    const result = await recalcMatchday('md-1')

    expect(result.updated).toBe(0)
    expect(mockSend).not.toHaveBeenCalled()
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })

  it('fecha parcial (1/3 terminados) → no notifica', async () => {
    setupSequence(
      q([MATCHDAY]),                     // SELECT matchday
      q([MATCH]),                        // SELECT finished matches (1 de 3)
      q([BET]),                          // SELECT bets
      q([]),                             // INSERT scores_by_matchday
      q([{ total: '3' }]),              // COUNT total matches → 3 en total
    )

    await recalcMatchday('md-1')

    expect(mockSend).not.toHaveBeenCalled()
  })

  it('todos los partidos terminados, primera vez → invoca Lambda y setea winner_announced_at', async () => {
    setupSequence(
      q([MATCHDAY]),                                        // 1. SELECT matchday
      q([MATCH]),                                           // 2. SELECT finished matches
      q([BET]),                                             // 3. SELECT bets
      q([]),                                                // 4. INSERT scores_by_matchday
      q([{ total: '1' }]),                                  // 5. COUNT total → allFinished
      // _notifyMatchdayClose queries (5 queries, no record/streak for this scenario):
      q([]),                                                // 6. SELECT emails (post-matchday)
      q([]),                                                // 7. SELECT ranking positions
      q([]),                                                // 8. INSERT notifications (summary)
      q([{ max_pts: null }]),                               // 9. SELECT MAX record → no record
      q([]),                                                // 10. SELECT streak scores → empty
      // Winner notification path:
      q([{ id: 'u-1', email: 'cacho@test.com' }]),          // 11. SELECT emails for winner
      q([]),                                                // 12. UPDATE winner_announced_at
    )

    await recalcMatchday('md-1')

    expect(mockSend).toHaveBeenCalledTimes(1)

    const updateCall = mockQuery.mock.calls.find(c => /UPDATE matchdays SET winner_announced_at/i.test(c[0]))
    expect(updateCall).toBeDefined()
    expect(updateCall[1]).toContain('md-1')
  })

  it('todos terminados, winner_announced_at ya seteado → skip dedup, no invoca Lambda', async () => {
    const alreadyAnnounced = { ...MATCHDAY, winner_announced_at: '2026-05-15T10:00:00Z' }
    setupSequence(
      q([alreadyAnnounced]),  // SELECT matchday (ya anunciado)
      q([MATCH]),             // SELECT finished matches
      q([BET]),               // SELECT bets
      q([]),                  // INSERT scores_by_matchday
      q([{ total: '1' }]),   // COUNT total matches → all finished
    )

    await recalcMatchday('md-1')

    expect(mockSend).not.toHaveBeenCalled()
    // No debe haber UPDATE winner_announced_at
    const updateCall = mockQuery.mock.calls.find(c => /UPDATE matchdays/.test(c[0]))
    expect(updateCall).toBeUndefined()
  })

  it('payload del Lambda incluye winner, matchday, emails', async () => {
    setupSequence(
      q([MATCHDAY]),
      q([MATCH]),
      q([BET]),
      q([]),                                          // INSERT scores_by_matchday
      q([{ total: '1' }]),                            // COUNT total
      // _notifyMatchdayClose:
      q([]),                                          // SELECT emails (post-matchday)
      q([]),                                          // SELECT ranking
      q([]),                                          // INSERT summary notification
      q([{ max_pts: null }]),                         // SELECT MAX record
      q([]),                                          // SELECT streak
      // Winner path:
      q([{ id: 'u-1', email: 'cacho@test.com' }]),   // SELECT emails for winner
      q([]),                                          // UPDATE winner_announced_at
    )

    await recalcMatchday('md-1')

    const invokeCall = mockSend.mock.calls[0][0]
    const payload = JSON.parse(Buffer.from(invokeCall.Payload).toString())

    expect(payload.source).toBe('winner-notification')
    expect(payload.winner.user_id).toBe('u-1')
    expect(payload.winner.user_name).toBe('Cacho')
    expect(payload.winner.points).toBe(3)
    expect(payload.matchday.id).toBe('md-1')
    expect(payload.matchday.name).toBe('Fecha 15/05')
    expect(payload.winnerEmail).toBe('cacho@test.com')
    expect(payload.allEmails).toContain('cacho@test.com')
    expect(invokeCall.InvocationType).toBe('Event')
  })

  it('sin apuestas → no hay ganador, no se notifica', async () => {
    setupSequence(
      q([MATCHDAY]),
      q([MATCH]),
      q([]),         // bets vacío → planillaPoints vacío → rows vacío → retorna early
    )

    const result = await recalcMatchday('md-1')

    expect(result.updated).toBe(0)
    expect(mockSend).not.toHaveBeenCalled()
  })
})
