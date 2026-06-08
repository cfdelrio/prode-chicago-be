'use strict'

const { calcularPuntaje } = require('../services/scoring')

const bet = (local, visitante) => ({ goles_local: local, goles_visitante: visitante })
const res = (local, visitante) => ({ resultado_local: local, resultado_visitante: visitante })

describe('calcularPuntaje', () => {

  // ── 0 pts ─────────────────────────────────────────────────────────────────

  it('0 pts — se equivocó el ganador (apostó local, ganó visitante)', () => {
    expect(calcularPuntaje(bet(1, 0), res(0, 1)).puntos).toBe(0)
  })

  it('0 pts — se equivocó el ganador (apostó visitante, ganó local)', () => {
    expect(calcularPuntaje(bet(0, 2), res(2, 0)).puntos).toBe(0)
  })

  it('0 pts — apostó empate pero ganó un equipo', () => {
    expect(calcularPuntaje(bet(0, 0), res(1, 0)).puntos).toBe(0)
  })

  it('0 pts — apostó ganador pero empató', () => {
    expect(calcularPuntaje(bet(1, 0), res(0, 0)).puntos).toBe(0)
  })

  // ── 1 pt — ganador correcto, sin gol exacto ──────────────────────────────

  it('1 pt — ganó correcto, sin gol exacto (3-1 vs 1-0)', () => {
    const r = calcularPuntaje(bet(3, 1), res(1, 0))
    expect(r.puntos).toBe(1)
    expect(r.bonus).toBe(false)
    expect(r.detalle.exactos_count).toBe(0)
  })

  it('1 pt — empate correcto, marcador diferente sin gol exacto (0-0 vs 1-1)', () => {
    // En empate exactos_count es 0 o 2, nunca 1 → nunca verde
    const r = calcularPuntaje(bet(0, 0), res(1, 1))
    expect(r.puntos).toBe(1)
    expect(r.detalle.acerto_diferencia).toBe(true)
    expect(r.detalle.exactos_count).toBe(0)
  })

  it('1 pt — empate correcto, marcador diferente sin gol exacto (1-1 vs 2-2)', () => {
    expect(calcularPuntaje(bet(1, 1), res(2, 2)).puntos).toBe(1)
  })

  it('1 pt — diff correcta pero sin gol exacto (3-1 vs 4-2)', () => {
    const r = calcularPuntaje(bet(3, 1), res(4, 2))
    expect(r.puntos).toBe(1)
    expect(r.detalle.acerto_diferencia).toBe(true)
    expect(r.detalle.exactos_count).toBe(0)
  })

  it('1 pt — diff correcta pero sin gol exacto (2-1 vs 3-2)', () => {
    expect(calcularPuntaje(bet(2, 1), res(3, 2)).puntos).toBe(1)
  })

  it('1 pt — diff correcta pero sin gol exacto (1-3 vs 0-2)', () => {
    expect(calcularPuntaje(bet(1, 3), res(0, 2)).puntos).toBe(1)
  })

  // ── 2 pts — ganador correcto + exactamente 1 gol exacto (verde) ──────────

  it('2 pts — local exacto (2-1 vs 2-0)', () => {
    const r = calcularPuntaje(bet(2, 1), res(2, 0))
    expect(r.puntos).toBe(2)
    expect(r.detalle.acerto_exacto_local).toBe(true)
    expect(r.detalle.exactos_count).toBe(1)
  })

  it('2 pts — visitante exacto (2-0 vs 1-0)', () => {
    const r = calcularPuntaje(bet(2, 0), res(1, 0))
    expect(r.puntos).toBe(2)
    expect(r.detalle.acerto_exacto_visitante).toBe(true)
    expect(r.detalle.exactos_count).toBe(1)
  })

  it('2 pts — local exacto, visitante gana (0-2 vs 0-3)', () => {
    // local=0 exacto en ambos; visitante distinto
    const r = calcularPuntaje(bet(0, 2), res(0, 3))
    expect(r.puntos).toBe(2)
    expect(r.detalle.acerto_exacto_local).toBe(true)
    expect(r.detalle.exactos_count).toBe(1)
  })

  // ── 3 pts — marcador exacto sin bonus ────────────────────────────────────

  it('3 pts — exacto 1-0 (1 gol total, sin bonus)', () => {
    expect(calcularPuntaje(bet(1, 0), res(1, 0)).puntos).toBe(3)
    expect(calcularPuntaje(bet(1, 0), res(1, 0)).bonus).toBe(false)
  })

  it('3 pts — exacto 2-1 (3 goles total, sin bonus)', () => {
    const r = calcularPuntaje(bet(2, 1), res(2, 1))
    expect(r.puntos).toBe(3)
    expect(r.bonus).toBe(false)
    expect(r.detalle.total_goles).toBe(3)
  })

  it('3 pts — exacto empate 1-1 (sin bonus por ser <4 goles)', () => {
    expect(calcularPuntaje(bet(1, 1), res(1, 1)).puntos).toBe(3)
    expect(calcularPuntaje(bet(1, 1), res(1, 1)).bonus).toBe(false)
  })

  it('3 pts — exacto 0-0 (sin bonus)', () => {
    const r = calcularPuntaje(bet(0, 0), res(0, 0))
    expect(r.puntos).toBe(3)
    expect(r.bonus).toBe(false)
  })

  // ── 4 pts — marcador exacto con bonus (≥4 goles) ─────────────────────────

  it('4 pts — exacto 3-1 (4 goles, bonus)', () => {
    const r = calcularPuntaje(bet(3, 1), res(3, 1))
    expect(r.puntos).toBe(4)
    expect(r.bonus).toBe(true)
    expect(r.detalle.total_goles).toBe(4)
  })

  it('4 pts — exacto 2-2 (4 goles, bonus)', () => {
    const r = calcularPuntaje(bet(2, 2), res(2, 2))
    expect(r.puntos).toBe(4)
    expect(r.bonus).toBe(true)
  })

  it('4 pts — exacto 3-2 (5 goles, bonus)', () => {
    expect(calcularPuntaje(bet(3, 2), res(3, 2)).puntos).toBe(4)
  })

  it('4 pts — exacto 4-0 (4 goles, bonus)', () => {
    const r = calcularPuntaje(bet(4, 0), res(4, 0))
    expect(r.puntos).toBe(4)
    expect(r.bonus).toBe(true)
  })

  // ── Detalle ───────────────────────────────────────────────────────────────

  it('detalle incluye todas las claves incluyendo acerto_diferencia', () => {
    const r = calcularPuntaje(bet(1, 0), res(1, 0))
    expect(r.detalle).toMatchObject({
      acerto_global: true,
      acerto_exacto_local: true,
      acerto_exacto_visitante: true,
      exactos_count: 2,
      total_goles: 1,
      acerto_diferencia: true,
    })
  })

  it('detalle acerto_diferencia=true con diff correcta sin exacto', () => {
    const r = calcularPuntaje(bet(3, 1), res(4, 2))
    expect(r.detalle.acerto_diferencia).toBe(true)
    expect(r.detalle.exactos_count).toBe(0)
  })
})
