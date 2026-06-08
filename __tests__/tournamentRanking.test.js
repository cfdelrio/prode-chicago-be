'use strict'

const mockQuery = jest.fn()

jest.mock('../db/connection', () => ({
  db: { query: mockQuery },
}))

const { recalculateTournamentRanking, recalculateAllTournamentRankings } = require('../services/tournamentRanking')

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeBetStats(rows = []) {
  return { rows }
}

function setupQuerySequence(...results) {
  results.forEach((r, i) => {
    mockQuery.mockResolvedValueOnce(r)
  })
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('recalculateTournamentRanking', () => {
  beforeEach(() => jest.clearAllMocks())

  it('ejecuta SELECT, DELETE, INSERT por fila y UPDATE en orden', async () => {
    const betStats = [
      { user_id: 'u1', planilla_id: 'p1', total_points: 10, aciertos: 3, exactos: 1 },
      { user_id: 'u2', planilla_id: 'p2', total_points: 8,  aciertos: 2, exactos: 0 },
    ]
    setupQuerySequence(
      makeBetStats(betStats), // SELECT betStats
      { rows: [] },           // DELETE existing rankings
      { rows: [] },           // INSERT u1
      { rows: [] },           // INSERT u2
      { rows: [] },           // UPDATE positions
    )

    const result = await recalculateTournamentRanking('t1')

    expect(result).toBe(true)
    expect(mockQuery).toHaveBeenCalledTimes(5)

    // Primer call: SELECT con tournamentId
    expect(mockQuery.mock.calls[0][1]).toContain('t1')

    // Segundo call: DELETE con tournamentId
    expect(mockQuery.mock.calls[1][0]).toMatch(/DELETE/i)
    expect(mockQuery.mock.calls[1][1]).toContain('t1')

    // Tercer y cuarto call: INSERT para cada planilla
    expect(mockQuery.mock.calls[2][0]).toMatch(/INSERT/i)
    expect(mockQuery.mock.calls[3][0]).toMatch(/INSERT/i)

    // Quinto call: UPDATE posiciones
    expect(mockQuery.mock.calls[4][0]).toMatch(/UPDATE/i)
  })

  it('sin apuestas → DELETE + UPDATE sin INSERTs intermedios', async () => {
    setupQuerySequence(
      makeBetStats([]),  // SELECT betStats → vacío
      { rows: [] },      // DELETE
      { rows: [] },      // UPDATE positions
    )

    const result = await recalculateTournamentRanking('t1')

    expect(result).toBe(true)
    expect(mockQuery).toHaveBeenCalledTimes(3)
  })

  it('error en DB → lanza la excepción', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB connection failed'))

    await expect(recalculateTournamentRanking('t1')).rejects.toThrow('DB connection failed')
  })

  it('INSERT incluye tournament_id, user_id, planilla_id y puntos de cada fila', async () => {
    const betStats = [
      { user_id: 'u1', planilla_id: 'p1', total_points: 15, aciertos: 4, exactos: 2 },
    ]
    setupQuerySequence(
      makeBetStats(betStats),
      { rows: [] },
      { rows: [] },
      { rows: [] },
    )

    await recalculateTournamentRanking('t42')

    const insertCall = mockQuery.mock.calls[2]
    expect(insertCall[0]).toMatch(/planilla_id/i)
    expect(insertCall[0]).toMatch(/ON CONFLICT \(tournament_id, planilla_id\)/i)
    expect(insertCall[1]).toContain('t42')  // tournament_id
    expect(insertCall[1]).toContain('u1')   // user_id
    expect(insertCall[1]).toContain('p1')   // planilla_id
    expect(insertCall[1]).toContain(15)     // puntos
  })

  // REGRESION GUARD: solo planillas pagadas entran al ranking del torneo.
  it('el SELECT filtra por precio_pagado = true', async () => {
    setupQuerySequence(
      makeBetStats([]),
      { rows: [] },
      { rows: [] },
    )

    await recalculateTournamentRanking('t1')

    const selectCall = mockQuery.mock.calls[0]
    expect(selectCall[0]).toMatch(/precio_pagado\s*=\s*true/i)
  })

  // REGRESION GUARD: solo partidos con resultado publicado (estado='finished').
  // m.finished=true es una columna distinta — puede estar en true para partidos sin resultado.
  it('el SELECT usa estado = finished, no la columna booleana finished', async () => {
    setupQuerySequence(
      makeBetStats([]),
      { rows: [] },
      { rows: [] },
    )

    await recalculateTournamentRanking('t1')

    const selectCall = mockQuery.mock.calls[0]
    expect(selectCall[0]).toMatch(/estado\s*=\s*'finished'/i)
    expect(selectCall[0]).not.toMatch(/m\.finished\s*=\s*true/i)
  })

  // REGRESION GUARD: la regla de negocio dice "ranking por planilla, no por usuario".
  // Sumar puntos por usuario daría ventaja a quien compra más planillas.
  it('usuario con 2 planillas genera 2 INSERTs distintos (no se suma ni overwrite)', async () => {
    const betStats = [
      { user_id: 'u1', planilla_id: 'p1', total_points: 10, aciertos: 3, exactos: 1 },
      { user_id: 'u1', planilla_id: 'p2', total_points: 5,  aciertos: 2, exactos: 0 },
    ]
    setupQuerySequence(
      makeBetStats(betStats),
      { rows: [] }, // DELETE
      { rows: [] }, // INSERT planilla1
      { rows: [] }, // INSERT planilla2
      { rows: [] }, // UPDATE positions
    )

    await recalculateTournamentRanking('t1')

    // Debe haber 2 INSERTs distintos (uno por planilla del mismo user)
    const insertCalls = mockQuery.mock.calls.filter(c => /^\s*INSERT/i.test(c[0]))
    expect(insertCalls).toHaveLength(2)

    // Cada INSERT lleva su propio planilla_id
    const planillaIds = insertCalls.map(c => c[1][2]) // 3er param = planilla_id
    expect(planillaIds).toEqual(expect.arrayContaining(['p1', 'p2']))

    // Y ambos comparten user_id (validación de invariante)
    const userIds = insertCalls.map(c => c[1][1])
    expect(userIds).toEqual(['u1', 'u1'])

    // El ON CONFLICT debe ser sobre planilla_id (no user_id) — esto previene la regresión
    insertCalls.forEach(call => {
      expect(call[0]).toMatch(/ON CONFLICT \(tournament_id, planilla_id\)/i)
      expect(call[0]).not.toMatch(/ON CONFLICT \(tournament_id, user_id\)/i)
    })
  })
})

describe('recalculateAllTournamentRankings', () => {
  beforeEach(() => jest.clearAllMocks())

  it('procesa cada torneo activo en secuencia', async () => {
    const tournaments = [{ id: 't1' }, { id: 't2' }]
    // Primera query: SELECT active tournaments
    mockQuery.mockResolvedValueOnce({ rows: tournaments })
    // Queries para t1: betStats, delete, update (sin filas)
    mockQuery.mockResolvedValue({ rows: [] })

    await recalculateAllTournamentRankings()

    // Primera call: SELECT torneos activos
    expect(mockQuery.mock.calls[0][0]).toMatch(/SELECT.*tournaments/i)
    // Total de calls: 1 (torneos) + 3 por torneo × 2 torneos = 7
    expect(mockQuery.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('sin torneos activos → no hace queries adicionales', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    await recalculateAllTournamentRankings()

    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('error en un torneo → propaga la excepción', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 't1' }] })
    mockQuery.mockRejectedValueOnce(new Error('Falla en torneo'))

    await expect(recalculateAllTournamentRankings()).rejects.toThrow('Falla en torneo')
  })
})
