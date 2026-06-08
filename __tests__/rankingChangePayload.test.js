'use strict'

const { buildRankingChangePayload } = require('../routes/matches')

describe('buildRankingChangePayload', () => {
  it('primera entrada al ranking (prevPos = null)', () => {
    const p = buildRankingChangePayload({ prevPos: null, newPos: 5, planillaNombre: 'Caballito' })
    expect(p.title).toBe('⭐ ¡Estás en el ranking!')
    expect(p.body).toContain('#5')
    expect(p.body).toContain('Caballito')
    expect(p.body).toContain('podio')
    expect(p.icon).toBe('trophy')
  })

  it('sube al podio (newPos <= 3)', () => {
    const p = buildRankingChangePayload({ prevPos: 5, newPos: 2, planillaNombre: 'Mi Planilla' })
    expect(p.title).toBe('🥈 Estás en el podio')
    expect(p.body).toContain('Pasaste 3 personas')
    expect(p.body).toContain('Seguís así')
  })

  it('remontada grande (delta >= 5)', () => {
    const p = buildRankingChangePayload({ prevPos: 10, newPos: 5, planillaNombre: 'X' })
    expect(p.title).toBe('📈 ¡Qué remontada!')
    expect(p.body).toContain('+5')
    expect(p.body).toContain('#5')
  })

  it('sube en el ranking de forma normal (prevPos > newPos, no podio, delta < 5)', () => {
    const p = buildRankingChangePayload({ prevPos: 8, newPos: 5, planillaNombre: 'Mi Planilla' })
    expect(p.title).toBe('📈 Subiste')
    expect(p.body).toContain('+3')
    expect(p.body).toContain('#5')
    expect(p.body).toContain('Mi Planilla')
  })

  it('baja en el ranking (prevPos < newPos)', () => {
    const p = buildRankingChangePayload({ prevPos: 2, newPos: 5, planillaNombre: 'X' })
    expect(p.title).toBe('📉 Bajaste en el ranking')
    expect(p.body).toContain('Bajaste 3 posiciones')
    expect(p.body).toContain('#5')
  })

  it('singular vs plural en bajada de 1 posición', () => {
    const baja = buildRankingChangePayload({ prevPos: 2, newPos: 3, planillaNombre: 'X' })
    expect(baja.body).toMatch(/Bajaste 1 posición\b/)
    expect(baja.body).not.toMatch(/posiciones/)
  })

  it('singular en podio con delta 1 (pasaste 1 persona)', () => {
    const sube = buildRankingChangePayload({ prevPos: 3, newPos: 2, planillaNombre: 'X' })
    expect(sube.title).toBe('🥈 Estás en el podio')
    expect(sube.body).toContain('Pasaste 1 persona')
    expect(sube.body).not.toContain('personas')
  })

  it('omite el nombre de planilla si viene vacío/null', () => {
    const p = buildRankingChangePayload({ prevPos: 5, newPos: 1, planillaNombre: null })
    expect(p.body).not.toContain('en ""')
    expect(p.title).toBe('🥇 Estás en el podio')
  })
})
