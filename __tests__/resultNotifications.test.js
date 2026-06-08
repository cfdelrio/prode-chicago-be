'use strict';

jest.mock('../db/connection');
jest.mock('../services/scoring');
jest.mock('../services/email');
jest.mock('../services/sms');
jest.mock('../services/push');
jest.mock('../services/engageClient');
jest.mock('../services/gamification');
jest.mock('../utils/engageHelpers');

const { notifyResult } = require('../services/resultNotifications');
const { db } = require('../db/connection');
const { calcularPuntaje } = require('../services/scoring');
const { pushToAll } = require('../services/push');
const { sendEvent } = require('../services/engageClient');
const { updateStreaks, checkAndAwardBadges } = require('../services/gamification');
const { buildEngageMetadata } = require('../utils/engageHelpers');

describe('resultNotifications.notifyResult', () => {
  const mockMatch = {
    id: 'match-123',
    home_team: 'River',
    away_team: 'Boca',
  };

  const mockUser = {
    user_id: 'user-1',
    nombre: 'Juan',
    email: 'juan@test.com',
    tema_equipo: 'river',
    rol: 'usuario',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENGAGE_ENABLED = 'false';
    db.query.mockResolvedValue({ rows: [] });
    buildEngageMetadata.mockReturnValue({ user_contact: {}, user_profile: {} });
  });

  it('should query ranking table to load user data', async () => {
    await notifyResult({
      match: mockMatch,
      resultLocal: 2,
      resultVisitante: 1,
      bets: [],
      prevLeader: null,
    });

    const rankingQuery = db.query.mock.calls[0][0];
    expect(rankingQuery).toContain('SELECT p.user_id');
    expect(rankingQuery).toContain('FROM ranking r');
  });

  it('should broadcast push notification to all users', async () => {
    await notifyResult({
      match: mockMatch,
      resultLocal: 2,
      resultVisitante: 1,
      bets: [],
      prevLeader: null,
    });

    expect(pushToAll).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining('River 2–1 Boca'),
        body: expect.any(String),
        url: '/ranking',
      })
    );
  });

  it('should handle db errors gracefully', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    db.query.mockRejectedValue(new Error('DB connection failed'));

    await notifyResult({
      match: mockMatch,
      resultLocal: 2,
      resultVisitante: 1,
      bets: [],
      prevLeader: null,
    });

    expect(consoleSpy).toHaveBeenCalled();
    const errorCall = consoleSpy.mock.calls[0].join('');
    expect(errorCall).toContain('[result-notif]');
    consoleSpy.mockRestore();
  });

  it('should send engage event when ENGAGE_ENABLED=true', async () => {
    process.env.ENGAGE_ENABLED = 'true';
    db.query.mockResolvedValue({ rows: [mockUser] });

    await notifyResult({
      match: mockMatch,
      resultLocal: 2,
      resultVisitante: 1,
      bets: [],
      prevLeader: { user_id: 'user-2', nombre: 'Carlos' },
    });

    expect(sendEvent).toHaveBeenCalled();
  });

  it('should not send engage event when ENGAGE_ENABLED=false', async () => {
    process.env.ENGAGE_ENABLED = 'false';
    db.query.mockResolvedValue({ rows: [mockUser] });

    await notifyResult({
      match: mockMatch,
      resultLocal: 2,
      resultVisitante: 1,
      bets: [],
      prevLeader: null,
    });

    expect(sendEvent).not.toHaveBeenCalled();
  });

  describe('Bet result notifications', () => {
    it('should call updateStreaks for each bet when exacto', async () => {
      db.query
        .mockResolvedValueOnce({ rows: [mockUser] })
        .mockResolvedValueOnce({ rows: [{ id: 'p1', user_id: 'user-1' }] });
      calcularPuntaje.mockReturnValue({ puntos: 4 });
      updateStreaks.mockResolvedValue({ current: 1, best: 1 });

      const bet = {
        planilla_id: 'p1',
        goles_local: 2,
        goles_visitante: 1,
      };

      await notifyResult({
        match: mockMatch,
        resultLocal: 2,
        resultVisitante: 1,
        bets: [bet],
        prevLeader: null,
      });

      expect(updateStreaks).toHaveBeenCalledWith('p1', 'match-123', true);
    });

    it('should call updateStreaks with isExacto=false when result incorrect', async () => {
      db.query
        .mockResolvedValueOnce({ rows: [mockUser] })
        .mockResolvedValueOnce({ rows: [{ id: 'p1', user_id: 'user-1' }] });
      calcularPuntaje.mockReturnValue({ puntos: 0 });
      updateStreaks.mockResolvedValue({ current: 0, best: 1 });

      const bet = {
        planilla_id: 'p1',
        goles_local: 3,
        goles_visitante: 0,
      };

      await notifyResult({
        match: mockMatch,
        resultLocal: 2,
        resultVisitante: 1,
        bets: [bet],
        prevLeader: null,
      });

      expect(updateStreaks).toHaveBeenCalledWith('p1', 'match-123', false);
    });

    it('should call checkAndAwardBadges with streak data', async () => {
      db.query
        .mockResolvedValueOnce({ rows: [mockUser] })
        .mockResolvedValueOnce({ rows: [{ id: 'p1', user_id: 'user-1' }] });
      calcularPuntaje.mockReturnValue({ puntos: 4 });
      updateStreaks.mockResolvedValue({ current: 3, best: 5 });

      const bet = {
        planilla_id: 'p1',
        goles_local: 2,
        goles_visitante: 1,
      };

      await notifyResult({
        match: mockMatch,
        resultLocal: 2,
        resultVisitante: 1,
        bets: [bet],
        prevLeader: null,
      });

      expect(checkAndAwardBadges).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          planillaId: 'p1',
          matchId: 'match-123',
          isExacto: true,
          streakResult: { current: 3, best: 5 },
        })
      );
    });

    it('should handle multiple bets in single match', async () => {
      db.query
        .mockResolvedValueOnce({ rows: [mockUser] })
        .mockResolvedValueOnce({ rows: [
          { id: 'p1', user_id: 'user-1' },
          { id: 'p2', user_id: 'user-2' },
        ] });
      calcularPuntaje.mockReturnValue({ puntos: 4 });
      updateStreaks.mockResolvedValue({ current: 1, best: 1 });

      const bets = [
        { planilla_id: 'p1', goles_local: 2, goles_visitante: 1 },
        { planilla_id: 'p2', goles_local: 2, goles_visitante: 1 },
      ];

      await notifyResult({
        match: mockMatch,
        resultLocal: 2,
        resultVisitante: 1,
        bets,
        prevLeader: null,
      });

      // Verify that bets were processed (at least one updateStreaks call)
      expect(updateStreaks).toHaveBeenCalled();
      expect(calcularPuntaje).toHaveBeenCalled();
    });
  });

  describe('buildEngageMetadata integration', () => {
    it('should call buildEngageMetadata for each user when sending engage events', async () => {
      process.env.ENGAGE_ENABLED = 'true';
      db.query.mockResolvedValue({ rows: [mockUser] });

      await notifyResult({
        match: mockMatch,
        resultLocal: 2,
        resultVisitante: 1,
        bets: [],
        prevLeader: { user_id: 'user-2', nombre: 'Carlos' },
      });

      expect(buildEngageMetadata).toHaveBeenCalled();
    });

    it('should pass user object and extras to buildEngageMetadata', async () => {
      process.env.ENGAGE_ENABLED = 'true';
      db.query.mockResolvedValue({ rows: [mockUser] });

      await notifyResult({
        match: mockMatch,
        resultLocal: 2,
        resultVisitante: 1,
        bets: [],
        prevLeader: { user_id: 'user-2', nombre: 'Carlos' },
      });

      expect(buildEngageMetadata).toHaveBeenCalledWith(
        mockUser,
        expect.any(Object)
      );
    });
  });
});
