"use strict";

// SMS via Infobip (separado de WhatsApp via Twilio — distinto provider, distinta API).

// SMS_WHITELIST: comma-separated numbers (e.g. "+5491155996222,+5491141843591")
// When set, only those numbers receive messages (sandbox/testing mode).
const SMS_WHITELIST = process.env.SMS_WHITELIST
    ? process.env.SMS_WHITELIST.split(',').map(n => n.trim()).filter(Boolean)
    : null;

const sendSMS = async ({ to, body }) => {
    const apiKey  = process.env.INFOBIP_API_KEY;
    const baseUrl = process.env.INFOBIP_BASE_URL; // e.g. https://xxx.api.infobip.com
    const from    = process.env.INFOBIP_SMS_FROM; // sender ID (alfanumérico hasta 11 chars) o número

    if (!apiKey || !baseUrl || !from) {
        console.warn('[sms] Infobip env vars not set, skipping');
        return;
    }

    if (SMS_WHITELIST) {
        const normalize = (n) => n.replace(/^\+/, '');
        if (!SMS_WHITELIST.map(normalize).includes(normalize(to))) {
            console.log(`[sms] ${to} not in whitelist, skipping`);
            return;
        }
    }

    const normalized = to.startsWith('+') ? to : `+${to}`;

    const response = await fetch(`${baseUrl}/sms/2/text/advanced`, {
        method: 'POST',
        headers: {
            'Authorization': `App ${apiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
        body: JSON.stringify({
            messages: [{
                destinations: [{ to: normalized }],
                from,
                text: body,
            }],
        }),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Infobip SMS failed: ${response.status} ${errText}`);
    }

    const data = await response.json();
    const messageId = data.messages?.[0]?.messageId;
    const status    = data.messages?.[0]?.status?.name;
    console.log(`[sms] sent to ${normalized} — id: ${messageId} status: ${status}`);
    return data;
};

// Retries transient SMS failures (5xx / network) with exponential backoff.
// Does NOT retry on 4xx (e.g. invalid phone) — those keep failing on retry.
// In tests, set SMS_RETRY_BASE_MS=0 to skip the backoff sleep.
const sendSMSWithRetry = async ({ to, body, maxAttempts = 3 }) => {
    const baseMs = Number(process.env.SMS_RETRY_BASE_MS ?? 1000);
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await sendSMS({ to, body });
        } catch (err) {
            lastErr = err;
            const msg = String(err.message || '');
            const is4xx = /Infobip SMS failed: 4\d{2}/.test(msg);
            if (is4xx) throw err;
            if (attempt < maxAttempts) {
                const delay = baseMs * Math.pow(2, attempt - 1); // 1s, 2s, 4s
                console.warn(`[sms-retry] attempt ${attempt}/${maxAttempts} failed for ${to}: ${msg} — retrying in ${delay}ms`);
                if (delay > 0) {
                    await new Promise(r => setTimeout(r, delay));
                }
            }
        }
    }
    throw lastErr;
};

module.exports = { sendSMS, sendSMSWithRetry };
