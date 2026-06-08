'use strict'

// Regression guards: el ranking global NO debe sumar scores huérfanos
// (rows en `scores` cuyo match ya no está estado='finished').
//
// Bug histórico (mayo 2026): admin publicaba un resultado, se calculaban
// los scores, luego revertía el match → estado!='finished' pero los scores
// quedaban. El LEFT JOIN en actualizarRanking() / recalculateScores no
// filtraba el lado `s`, entonces COUNT/SUM seguían incluyendo huérfanos.
//
// Síntoma: planilla con 0 partidos finalizados aciertos pero 10 amarillos
// en el ranking → puntos_totales=10 imposibles.

const fs = require('fs')
const path = require('path')

function readSource(rel) {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8')
}

describe('Ranking orphan-scores guard', () => {
  describe('routes/matches.js - actualizarRanking()', () => {
    const src = readSource('routes/matches.js')

    it('cada agregado de aciertos filtra por m.estado = finished', () => {
      // SUM debe ir junto a FILTER por estado finished
      expect(src).toMatch(/SUM\(s\.puntos_obtenidos\)\s+FILTER\s+\(WHERE\s+m\.estado\s*=\s*'finished'\)/i)
      // Todos los COUNT FILTER deben incluir m.estado = 'finished'
      const countFilterMatches = src.match(/COUNT\(s\.id\)\s+FILTER\s+\(WHERE[^)]+\)/gi) || []
      expect(countFilterMatches.length).toBeGreaterThan(0)
      countFilterMatches.forEach((expr) => {
        expect(expr).toMatch(/m\.estado\s*=\s*'finished'/i)
      })
    })

    it('NO debe usar el patrón viejo (filter en JOIN ON sin filter en aggregates)', () => {
      // El patrón roto era: LEFT JOIN matches m ON s.match_id = m.id AND m.estado = 'finished'
      // sin filtros adicionales. Con SUM/COUNT sin FILTER sobre m.estado, los huérfanos contaban.
      const buggyPattern = /SUM\(s\.puntos_obtenidos\)\s+as\s+puntos_totales/i
      expect(src).not.toMatch(buggyPattern)
    })
  })

  describe('scripts/recalculateScores.js', () => {
    const src = readSource('scripts/recalculateScores.js')

    it('limpia scores huérfanos antes de recalcular ranking', () => {
      expect(src).toMatch(/DELETE FROM scores WHERE match_id IN/i)
      expect(src).toMatch(/SELECT id FROM matches WHERE estado\s*!=\s*'finished'/i)
    })

    it('cada agregado filtra por m.estado = finished (defensa en profundidad)', () => {
      expect(src).toMatch(/SUM\(s\.puntos_obtenidos\)\s+FILTER\s+\(WHERE\s+m\.estado\s*=\s*'finished'\)/i)
      const countFilterMatches = src.match(/COUNT\(s\.id\)\s+FILTER\s+\(WHERE[^)]+\)/gi) || []
      expect(countFilterMatches.length).toBeGreaterThan(0)
      countFilterMatches.forEach((expr) => {
        expect(expr).toMatch(/m\.estado\s*=\s*'finished'/i)
      })
    })
  })
})
