'use strict';

const axios = require('axios');
const { createLogger } = require('../utils/logger');

const logger = createLogger('engage');

const _client = axios.create({
  baseURL: process.env.ENGAGE_API_URL || 'https://engage.orkestai.ar',
  headers: {
    'x-api-key': process.env.ENGAGE_API_KEY || '',
    'content-type': 'application/json',
  },
  timeout: 8000,
});

/**
 * Retries an async function with exponential backoff.
 * Does NOT retry on 4xx client errors (except 409 Conflict and 429 Rate Limit).
 */
async function sendWithRetry(fn, maxAttempts = 3, baseDelayMs = 1000) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      // Don't retry on definitive client errors (4xx except 409 duplicate and 429 rate limit)
      if (status >= 400 && status < 500 && status !== 409 && status !== 429) {
        throw err;
      }
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        logger.warn(`Attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms`, { err: err.message });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

async function sendEvent(payload) {
  if (process.env.ENGAGE_ENABLED !== 'true') return null;

  // Handle 409 (duplicate idempotency key) before retry logic
  const fn = async () => {
    try {
      const response = await _client.post('/v1/events', payload);
      logger.info('Event queued', { eventId: response.data.eventId, type: payload.type });
      return response.data;
    } catch (err) {
      if (err.response && err.response.status === 409) {
        logger.info('Duplicate event skipped', {
          idempotencyKey: payload.idempotencyKey,
          type: payload.type,
        });
        return null;
      }
      throw err;
    }
  };

  try {
    return await sendWithRetry(fn);
  } catch (err) {
    logger.error('Event submission failed after retries', { type: payload.type, err: err.message });
    throw err;
  }
}

async function sendEventBatch(payloads) {
  if (process.env.ENGAGE_ENABLED !== 'true') return null;

  try {
    const response = await sendWithRetry(() => _client.post('/v1/events/batch', { events: payloads }));
    logger.info('Batch queued', { count: payloads.length });
    return response.data;
  } catch (err) {
    logger.error('Batch submission failed after retries', { count: payloads.length, err: err.message });
    throw err;
  }
}

async function getEvent(eventId) {
  if (process.env.ENGAGE_ENABLED !== 'true') return { engage_disabled: true };
  const response = await _client.get(`/v1/events/${eventId}`);
  return response.data;
}

async function getUserDeliveries(userId) {
  if (process.env.ENGAGE_ENABLED !== 'true') return { engage_disabled: true, deliveries: [] };
  const response = await _client.get(`/v1/users/${userId}/deliveries`);
  return response.data;
}

async function getUsers({ limit = 10 } = {}) {
  if (process.env.ENGAGE_ENABLED !== 'true') return { engage_disabled: true, users: [] };
  const response = await _client.get(`/v1/users`, { params: { limit } });
  return response.data;
}

module.exports = { sendEvent, sendEventBatch, sendWithRetry, getEvent, getUserDeliveries, getUsers };
