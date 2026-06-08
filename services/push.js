"use strict";

const { db } = require('../db/connection');

const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.warn('[push] VAPID keys not configured — push notifications disabled');
}

// Lazy-load web-push para que Lambda arranque aunque el paquete no esté
// en el deployment (evita ImportModuleError en cold start)
let _webpush = null;
function getWebpush() {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return null;
    if (!_webpush) {
        _webpush = require('web-push');
        _webpush.setVapidDetails(
            'mailto:admin@hr.prodecaballito.com',
            VAPID_PUBLIC_KEY,
            VAPID_PRIVATE_KEY
        );
    }
    return _webpush;
}

/**
 * Send a push notification to a single subscription row from DB.
 * Automatically removes expired/invalid subscriptions (410 Gone).
 * Returns null silently if VAPID keys are not configured.
 */
const sendPush = async (sub, payload) => {
    const webpush = getWebpush();
    if (!webpush) return null;
    const subscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
    };
    try {
        await webpush.sendNotification(subscription, JSON.stringify(payload));
    } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
            // Subscription expired — remove from DB
            await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint])
                .catch(() => {});
        } else {
            throw err;
        }
    }
};

/**
 * Send a push notification to all subscriptions of a specific user.
 */
const pushToUser = async (userId, payload) => {
    const res = await db.query(
        'SELECT * FROM push_subscriptions WHERE user_id = $1', [userId]
    );
    for (const sub of res.rows) {
        await sendPush(sub, payload).catch(e =>
            console.error(`Push failed for user ${userId}:`, e.message)
        );
    }
};

/**
 * Broadcast a push notification to all subscribed users.
 */
/**
 * Broadcast a push notification to all subscribed users.
 *
 * Uses keyset pagination over `id` to avoid loading the whole table into Lambda
 * memory when the subscriber count grows. The page size is bounded but tunable
 * via env var (PUSH_BROADCAST_BATCH).
 */
const pushToAll = async (payload) => {
    const batchSize = Math.max(1, parseInt(process.env.PUSH_BROADCAST_BATCH || '100', 10));
    let sent = 0, failed = 0;
    let afterId = null;
    while (true) {
        const res = afterId == null
            ? await db.query(
                'SELECT * FROM push_subscriptions ORDER BY id ASC LIMIT $1',
                [batchSize]
            )
            : await db.query(
                'SELECT * FROM push_subscriptions WHERE id > $1 ORDER BY id ASC LIMIT $2',
                [afterId, batchSize]
            );
        if (res.rows.length === 0) break;
        for (const sub of res.rows) {
            try {
                await sendPush(sub, payload);
                sent++;
            } catch (e) {
                console.error(`Push broadcast failed for ${sub.user_id}:`, e.message);
                failed++;
            }
        }
        afterId = res.rows[res.rows.length - 1].id;
        if (res.rows.length < batchSize) break;
    }
    console.log(`[push] broadcast sent=${sent} failed=${failed}`);
    return { sent, failed };
};

module.exports = { sendPush, pushToUser, pushToAll };
