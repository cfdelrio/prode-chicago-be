'use strict';

jest.mock('../db/connection');
jest.mock('../services/engageClient');
jest.mock('../utils/engageHelpers');

const { db } = require('../db/connection');
const { sendEventBatch } = require('../services/engageClient');
const { buildEngageMetadata } = require('../utils/engageHelpers');
const { runVoiceMatchReminders, SKIP_REASONS } = require('../services/voiceMatchReminder');

describe('voiceMatchReminder.runVoiceMatchReminders', () => {
    const mockMatch = {
        id: 'match-1',
        home_team: 'Argentina',
        away_team: 'Brasil',
        start_time: '2026-05-24T13:00:00Z',
        tournament_id: 'tournament-1',
    };

    const mockUser = {
        user_id: 'user-1',
        nombre: 'Juan',
        email: 'juan@test.com',
        whatsapp_number: '+5491155996222',
        whatsapp_consent: true,
        tema_equipo: 'river',
        foto_url: null,
        created_at: '2024-01-01T00:00:00Z',
        rol: 'usuario',
        idioma_pref: 'es-AR',
        goles_local: 2,
        goles_visitante: 1,
        planilla_id: 'planilla-1',
        nombre_planilla: 'Mi Planilla',
    };

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.ENGAGE_ENABLED = 'true';
        buildEngageMetadata.mockReturnValue({ user_contact: {}, user_profile: {} });
        sendEventBatch.mockResolvedValue({});
    });

    it('should skip silently when ENGAGE_ENABLED is false (no dryRun)', async () => {
        process.env.ENGAGE_ENABLED = 'false';

        const result = await runVoiceMatchReminders();

        expect(result.engage_disabled).toBe(true);
        expect(result.users_notified).toBe(0);
        expect(db.query).not.toHaveBeenCalled();
    });

    it('should still run in dryRun mode even with ENGAGE_ENABLED=false', async () => {
        process.env.ENGAGE_ENABLED = 'false';
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runVoiceMatchReminders({ dryRun: true });

        expect(result.engage_disabled).toBeUndefined();
        expect(db.query).toHaveBeenCalled();
    });

    it('should return empty when no matches in window', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runVoiceMatchReminders();

        expect(result).toMatchObject({
            matches_in_window: 0,
            users_notified: 0,
            skipped: 0,
            skip_details: [],
        });
        expect(sendEventBatch).not.toHaveBeenCalled();
    });

    it('should use skipWindow query when skipWindow=true', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await runVoiceMatchReminders({ skipWindow: true });

        const queryUsed = db.query.mock.calls[0][0];
        expect(queryUsed).toContain('ORDER BY start_time ASC');
        expect(queryUsed).toContain('LIMIT 5');
        expect(queryUsed).not.toContain('BETWEEN NOW()');
    });

    it('should use time-window query when skipWindow=false (default)', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await runVoiceMatchReminders();

        const queryUsed = db.query.mock.calls[0][0];
        expect(queryUsed).toContain('BETWEEN NOW() + INTERVAL');
        expect(queryUsed).not.toContain('ORDER BY start_time ASC');
    });

    it('should skip user with NO_PHONE reason when whatsapp_number is null', async () => {
        const userNoPhone = { ...mockUser, whatsapp_number: null };
        db.query
            .mockResolvedValueOnce({ rows: [mockMatch] })
            .mockResolvedValueOnce({ rows: [userNoPhone] });

        const result = await runVoiceMatchReminders();

        expect(result.skipped).toBe(1);
        expect(result.skip_details).toEqual([
            { user_id: 'user-1', nombre: 'Juan', reason: SKIP_REASONS.NO_PHONE },
        ]);
        expect(result.users_notified).toBe(0);
    });

    it('should skip user with ALREADY_SENT reason when reminder_sent conflict', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [mockMatch] })
            .mockResolvedValueOnce({ rows: [mockUser] })
            .mockResolvedValueOnce({ rows: [] }); // INSERT returns no rows = conflict

        const result = await runVoiceMatchReminders();

        expect(result.skipped).toBe(1);
        expect(result.skip_details).toEqual([
            { user_id: 'user-1', nombre: 'Juan', reason: SKIP_REASONS.ALREADY_SENT },
        ]);
    });

    it('should notify user and send engage event when all conditions met', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [mockMatch] })
            .mockResolvedValueOnce({ rows: [mockUser] })
            .mockResolvedValueOnce({ rows: [{ user_id: 'user-1' }] }); // INSERT success

        const result = await runVoiceMatchReminders();

        expect(result.users_notified).toBe(1);
        expect(result.skipped).toBe(0);
        expect(sendEventBatch).toHaveBeenCalledWith([
            expect.objectContaining({
                type: 'prode.voice_match_reminder',
                userId: 'user-1',
                idempotencyKey: 'voice_match_reminder:user-1:match-1',
                payload: expect.objectContaining({
                    business_context: expect.objectContaining({
                        home_team: 'Argentina',
                        away_team: 'Brasil',
                        bet_local: 2,
                        bet_visitante: 1,
                    }),
                }),
            }),
        ]);
    });

    it('should use buildEngageMetadata helper for metadata', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [mockMatch] })
            .mockResolvedValueOnce({ rows: [mockUser] })
            .mockResolvedValueOnce({ rows: [{ user_id: 'user-1' }] });

        await runVoiceMatchReminders();

        expect(buildEngageMetadata).toHaveBeenCalledWith(
            mockUser,
            expect.objectContaining({
                planilla_nombre: 'Mi Planilla',
                planilla_id: 'planilla-1',
            })
        );
    });

    it('should not insert reminder_sent or call engage when dryRun=true', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [mockMatch] })
            .mockResolvedValueOnce({ rows: [mockUser] });

        const result = await runVoiceMatchReminders({ dryRun: true });

        expect(result.users_notified).toBe(1);
        expect(result.dry_run).toBe(true);
        expect(result.preview).toEqual([
            expect.objectContaining({
                match: 'Argentina vs Brasil',
                user: 'Juan',
                phone: '+5491155996222',
                bet: '2-1',
            }),
        ]);
        expect(sendEventBatch).not.toHaveBeenCalled();
        // Only 2 queries: matches + users (no INSERT)
        expect(db.query).toHaveBeenCalledTimes(2);
    });

    it('should filter by userIds when provided', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [mockMatch] })
            .mockResolvedValueOnce({ rows: [] });

        await runVoiceMatchReminders({ userIds: ['user-1', 'user-2'] });

        const userQueryCall = db.query.mock.calls[1];
        expect(userQueryCall[0]).toContain('u.id = ANY($2::uuid[])');
        expect(userQueryCall[1]).toEqual(['match-1', ['user-1', 'user-2']]);
    });
});
