'use strict';

const { db } = require('../db/connection');

const BADGE_THRESHOLDS = {
    racha_3_exactos: 3,
    racha_5_exactos: 5,
    racha_10_exactos: 10,
};

/**
 * Actualiza el streak de exactos de una planilla.
 * Llamado tras publicar resultado de un match.
 *
 * @param {string} planillaId
 * @param {string} matchId
 * @param {boolean} isExacto - true si fue resultado exacto (4 pts)
 * @returns {Promise<{current: number, best: number, milestone: string|null}>}
 */
async function updateStreaks(planillaId, matchId, isExacto) {
    const streakType = 'exactos';

    const currentRes = await db.query(
        `SELECT current_streak, best_streak FROM user_streaks
         WHERE planilla_id = $1 AND streak_type = $2`,
        [planillaId, streakType]
    ).catch(() => ({ rows: [] }));

    const prev = currentRes.rows[0] || { current_streak: 0, best_streak: 0 };
    const newCurrent = isExacto ? prev.current_streak + 1 : 0;
    const newBest = Math.max(prev.best_streak, newCurrent);

    await db.query(
        `INSERT INTO user_streaks (planilla_id, streak_type, current_streak, best_streak, last_match_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (planilla_id, streak_type)
         DO UPDATE SET current_streak = $3, best_streak = $4, last_match_id = $5, updated_at = NOW()`,
        [planillaId, streakType, newCurrent, newBest, matchId]
    ).catch(err => console.error('[gamification] updateStreaks error:', err.message));

    let milestone = null;
    if (newCurrent === 3) milestone = 'racha_3_exactos';
    else if (newCurrent === 5) milestone = 'racha_5_exactos';
    else if (newCurrent === 10) milestone = 'racha_10_exactos';

    return { current: newCurrent, best: newBest, milestone };
}

/**
 * Otorga un badge si no lo tiene. Idempotente via UNIQUE (user_id, badge_type).
 *
 * @param {string} userId
 * @param {string} badgeType
 * @param {object} [badgeData]
 * @returns {Promise<boolean>} true si fue otorgado por primera vez
 */
async function awardBadge(userId, badgeType, badgeData = {}) {
    const res = await db.query(
        `INSERT INTO user_badges (user_id, badge_type, badge_data)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, badge_type) DO NOTHING
         RETURNING id`,
        [userId, badgeType, JSON.stringify(badgeData)]
    ).catch(err => {
        console.error('[gamification] awardBadge error:', err.message);
        return { rows: [] };
    });

    return res.rows.length > 0;
}

/**
 * Chequea condiciones y otorga badges relevantes después de un resultado.
 *
 * @param {object} ctx
 * @param {string} ctx.userId
 * @param {string} ctx.planillaId
 * @param {string} ctx.matchId
 * @param {boolean} ctx.isExacto
 * @param {number} ctx.position - posición actual en ranking
 * @param {object} ctx.streakResult - resultado de updateStreaks
 * @returns {Promise<string[]>} array de badge types otorgados
 */
async function checkAndAwardBadges({ userId, planillaId, matchId, isExacto, position, streakResult }) {
    const awarded = [];

    if (isExacto) {
        if (await awardBadge(userId, 'primer_exacto', { match_id: matchId, planilla_id: planillaId })) {
            awarded.push('primer_exacto');
        }
    }

    if (streakResult?.milestone) {
        const data = { streak: streakResult.current, match_id: matchId, planilla_id: planillaId };
        if (await awardBadge(userId, streakResult.milestone, data)) {
            awarded.push(streakResult.milestone);
        }
    }

    if (position === 1) {
        if (await awardBadge(userId, 'lider_primera_vez', { match_id: matchId, planilla_id: planillaId })) {
            awarded.push('lider_primera_vez');
        }
    }

    return awarded;
}

/**
 * Devuelve summary de gamification para un usuario.
 * Usado por weekly_summary y endpoints de profile.
 *
 * @param {string} userId
 * @returns {Promise<{streaks: object[], badges: object[], rivalries_count: number}>}
 */
async function getGamificationSummary(userId) {
    const [streaksRes, badgesRes, rivalriesRes] = await Promise.all([
        db.query(`
            SELECT us.streak_type, us.current_streak, us.best_streak, p.nombre_planilla
            FROM user_streaks us
            JOIN planillas p ON p.id = us.planilla_id
            WHERE p.user_id = $1 AND us.current_streak > 0
            ORDER BY us.current_streak DESC
        `, [userId]).catch(() => ({ rows: [] })),
        db.query(`
            SELECT badge_type, badge_data, awarded_at FROM user_badges
            WHERE user_id = $1
            ORDER BY awarded_at DESC
        `, [userId]).catch(() => ({ rows: [] })),
        db.query(`
            SELECT COUNT(*) as cnt FROM user_rivalries WHERE follower_id = $1
        `, [userId]).catch(() => ({ rows: [{ cnt: 0 }] })),
    ]);

    return {
        streaks: streaksRes.rows,
        badges: badgesRes.rows,
        rivalries_count: parseInt(rivalriesRes.rows[0]?.cnt || 0),
    };
}

/**
 * Detecta si un user_id sigue al overtaker como rival.
 * Si sí, devuelve true → se debe enviar voice_trash_talk personalizado.
 *
 * @param {string} followerId - el que fue superado
 * @param {string} rivalId - el que superó
 * @returns {Promise<boolean>}
 */
async function isTrackedRival(followerId, rivalId) {
    const res = await db.query(
        `SELECT 1 FROM user_rivalries WHERE follower_id = $1 AND rival_id = $2`,
        [followerId, rivalId]
    ).catch(() => ({ rows: [] }));
    return res.rows.length > 0;
}

module.exports = {
    updateStreaks,
    awardBadge,
    checkAndAwardBadges,
    getGamificationSummary,
    isTrackedRival,
    BADGE_THRESHOLDS,
};
