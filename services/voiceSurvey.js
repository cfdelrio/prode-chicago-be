'use strict';

const { db } = require('../db/connection');
const { runConcurrent } = require('./concurrency');

const API_BASE = process.env.API_URL || 'https://t49euho172.execute-api.us-east-1.amazonaws.com/prod/api';

/**
 * Run an outbound voice survey to all users with whatsapp_number.
 *
 * @param {object} params
 * @param {string} params.surveyId   - Unique identifier for this survey run
 * @param {string} params.question   - The question text (spoken via TTS)
 * @param {Array}  params.options    - [{ digit: '1', label: 'Argentina' }, ...]
 * @param {Array}  [params.userIds]  - Optional: restrict to specific user UUIDs
 */
async function runVoiceSurvey({ surveyId, question, options, userIds = null }) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken  = process.env.TWILIO_AUTH_TOKEN;
    const from       = process.env.TWILIO_VOICE_FROM || process.env.TWILIO_SMS_FROM;

    if (!accountSid || !authToken || !from) {
        console.warn('[voice-survey] Twilio env vars not set, skipping');
        return { called: 0, failed: 0 };
    }

    let query  = `SELECT id, nombre, whatsapp_number FROM users WHERE whatsapp_number IS NOT NULL AND whatsapp_consent = true`;
    const params = [];
    if (userIds && userIds.length > 0) {
        query += ` AND id = ANY($1)`;
        params.push(userIds);
    }
    const { rows: users } = await db.query(query, params);

    if (users.length === 0) {
        console.log('[voice-survey] no users with phone numbers');
        return { called: 0, failed: 0 };
    }

    await db.query(
        `INSERT INTO voice_surveys (id, question, options, status, created_at)
         VALUES ($1, $2, $3, 'running', NOW())
         ON CONFLICT (id) DO UPDATE SET status = 'running'`,
        [surveyId, question, JSON.stringify(options)]
    );

    const twimlUrl   = `${API_BASE}/voice/twiml?surveyId=${encodeURIComponent(surveyId)}&question=${encodeURIComponent(question)}&options=${encodeURIComponent(JSON.stringify(options))}`;
    const statusUrl  = `${API_BASE}/voice/status`;
    const twilio     = require('twilio')(accountSid, authToken);

    const results = await runConcurrent(users, async (user) => {
        const to   = user.whatsapp_number.startsWith('+') ? user.whatsapp_number : `+${user.whatsapp_number}`;
        const call = await twilio.calls.create({
            from,
            to,
            url: twimlUrl,
            statusCallback: statusUrl,
            statusCallbackMethod: 'POST',
            machineDetection: 'DetectMessageEnd',
        });
        console.log(`[voice-survey] called ${to} — sid: ${call.sid}`);
        return call;
    }, 5);

    let called = 0, failed = 0;
    for (const r of results) {
        if (r.status === 'fulfilled') called++;
        else { failed++; console.error('[voice-survey] call failed:', r.reason?.message); }
    }

    await db.query(
        `UPDATE voice_surveys SET status = 'sent', total_called = $2 WHERE id = $1`,
        [surveyId, called]
    );

    console.log(`[voice-survey] surveyId=${surveyId} called=${called} failed=${failed}`);
    return { called, failed };
}

module.exports = { runVoiceSurvey };
