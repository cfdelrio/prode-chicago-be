'use strict'

const mockQuery = jest.fn()

jest.mock('../db/connection', () => ({
  db: { query: mockQuery },
}))

const { updateStreaks, awardBadge, checkAndAwardBadges, getGamificationSummary } = require('../services/gamification')

describe('gamification', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  describe('updateStreaks', () => {
    test('increments streak on exacto', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ current_streak: 2, best_streak: 3 }] }) // SELECT
        .mockResolvedValueOnce({ rows: [] }) // INSERT/UPDATE

      const result = await updateStreaks('planilla1', 'match1', true)
      expect(result.current).toBe(3)
      expect(result.best).toBe(3)
      expect(result.milestone).toBe('racha_3_exactos')
    })

    test('resets streak on miss', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ current_streak: 5, best_streak: 7 }] })
        .mockResolvedValueOnce({ rows: [] })

      const result = await updateStreaks('planilla1', 'match1', false)
      expect(result.current).toBe(0)
      expect(result.best).toBe(7)
      expect(result.milestone).toBeNull()
    })

    test('starts from 0 if no prior streak', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // no prior
        .mockResolvedValueOnce({ rows: [] })

      const result = await updateStreaks('planilla1', 'match1', true)
      expect(result.current).toBe(1)
      expect(result.best).toBe(1)
      expect(result.milestone).toBeNull()
    })

    test('detects milestone at 5', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ current_streak: 4, best_streak: 4 }] })
        .mockResolvedValueOnce({ rows: [] })

      const result = await updateStreaks('p1', 'm1', true)
      expect(result.milestone).toBe('racha_5_exactos')
    })
  })

  describe('awardBadge', () => {
    test('returns true when newly awarded', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'badge1' }] })
      const awarded = await awardBadge('user1', 'primer_exacto', { match_id: 'm1' })
      expect(awarded).toBe(true)
    })

    test('returns false when already exists', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] })
      const awarded = await awardBadge('user1', 'primer_exacto')
      expect(awarded).toBe(false)
    })
  })

  describe('checkAndAwardBadges', () => {
    test('awards primer_exacto on first exacto', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'b1' }] })
      const awarded = await checkAndAwardBadges({
        userId: 'u1', planillaId: 'p1', matchId: 'm1',
        isExacto: true, position: 5, streakResult: { milestone: null },
      })
      expect(awarded).toContain('primer_exacto')
    })

    test('awards lider_primera_vez when position=1', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'b2' }] })
      const awarded = await checkAndAwardBadges({
        userId: 'u1', planillaId: 'p1', matchId: 'm1',
        isExacto: false, position: 1, streakResult: { milestone: null },
      })
      expect(awarded).toContain('lider_primera_vez')
    })

    test('awards milestone badge from streak result', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'be' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'bs' }] })
      const awarded = await checkAndAwardBadges({
        userId: 'u1', planillaId: 'p1', matchId: 'm1',
        isExacto: true, position: 3, streakResult: { current: 3, milestone: 'racha_3_exactos' },
      })
      expect(awarded).toContain('primer_exacto')
      expect(awarded).toContain('racha_3_exactos')
    })

    test('no badges when none meet criteria', async () => {
      const awarded = await checkAndAwardBadges({
        userId: 'u1', planillaId: 'p1', matchId: 'm1',
        isExacto: false, position: 10, streakResult: { milestone: null },
      })
      expect(awarded).toEqual([])
    })
  })

  describe('getGamificationSummary', () => {
    test('returns streaks + badges + rivalries count', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ streak_type: 'exactos', current_streak: 3, best_streak: 5, nombre_planilla: 'P1' }] })
        .mockResolvedValueOnce({ rows: [{ badge_type: 'racha_3_exactos', badge_data: {}, awarded_at: new Date() }] })
        .mockResolvedValueOnce({ rows: [{ cnt: '2' }] })

      const summary = await getGamificationSummary('u1')
      expect(summary.streaks).toHaveLength(1)
      expect(summary.badges).toHaveLength(1)
      expect(summary.rivalries_count).toBe(2)
    })
  })
})
