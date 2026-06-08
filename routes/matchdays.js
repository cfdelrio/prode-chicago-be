"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const connection_1 = require("../db/connection");
const auth_1 = require("../middleware/auth");
const scoring_1 = require("../services/scoring");
const https = require("https");
const { sendWhatsAppTemplate } = require("../services/whatsapp");
const { runConcurrent } = require("../services/concurrency");
const { sendEvent, sendEventBatch } = require("../services/engageClient");
const router = (0, express_1.Router)();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

function openAiPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.openai.com',
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 60000,
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error('OpenAI parse error: ' + raw.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OpenAI timeout')); });
    req.write(data);
    req.end();
  });
}

// Parsea el value devuelto por pg (puede venir ya parseado si la columna es jsonb)
function parseConfigValue(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return null;
}

async function uploadImageToS3(imageData) {
  const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const s3 = new S3Client({ region: 'us-east-1' });
  const key = `winners/${Date.now()}.png`;

  let body;
  if (typeof imageData === 'string' && imageData.startsWith('data:image/')) {
    body = Buffer.from(imageData.split(',')[1], 'base64');
  } else if (typeof imageData === 'string' && imageData.startsWith('http')) {
    body = await new Promise((resolve, reject) => {
      https.get(imageData, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Descarga imagen falló: HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  } else {
    throw new Error('imageData debe ser base64 data URI o URL http(s)');
  }

  await s3.send(new PutObjectCommand({
    Bucket: 'prode-uploads-cdelrio',
    Key: key,
    Body: body,
    ContentType: 'image/png',
  }));

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: 'prode-uploads-cdelrio', Key: key }),
    { expiresIn: 10 * 365 * 24 * 3600 }
  );
  console.log('[winner] Imagen subida a S3:', key);
  return url;
}

async function processWinnerNotification(winner, matchday, winnerEmail, allEmails = []) {
  try {
    // 1. Find top scorers with GPT-4o (null = not found)
    let scorerNames = null;
    try {
      const scorersRes = await openAiPost('/v1/chat/completions', {
        model: 'gpt-4o',
        max_tokens: 200,
        messages: [{ role: 'user', content: `Para el torneo con ID '${matchday.tournament_id}' en la jornada '${matchday.name}', ¿cuáles fueron los 3 principales goleadores reales? Si no tenés información certera respondé con el array vacío []. Respondé ÚNICAMENTE con un array JSON sin markdown. Formato: [{"name": "Nombre Apellido", "goals": 2}]` }]
      });
      const raw = scorersRes.choices?.[0]?.message?.content || '';
      const scorers = JSON.parse(raw.replace(/```json|```/g, '').trim());
      if (Array.isArray(scorers) && scorers.length > 0) {
        scorerNames = scorers.map(s => `${s.name} (${s.goals} gol${s.goals !== 1 ? 'es' : ''})`).join(', ');
        console.log('Scorers:', scorerNames);
      }
    } catch(e) { console.warn('Scorers error:', e.message); }

    const MOTIVATIONAL = [
      '¡Sos un crack total! 🔥',
      '¡Nadie te para, campeón! 🏅',
      '¡Tu olfato para el fútbol no tiene rival! ⚽',
      '¡Leyenda del prode! 🌟',
      '¡Fenomenal, seguí así! 💪',
    ];
    const motivational = MOTIVATIONAL[Math.floor(Math.random() * MOTIVATIONAL.length)];

    const cardPrompt = `Create a FIFA Ultimate Team player card, ultra high quality digital art style.
- IMPORTANT: use the face and physical appearance of the person shown in the provided photo as the player's face on the card. Reproduce their likeness faithfully.
- Golden elite card with shiny gradient background and geometric patterns.
- Classic FIFA UT card layout: rating '99' top-left, position 'PRO' below it.
- Player wearing a blue and gold jersey, number 13, in a dynamic celebration pose (fist pumped).
- Player name at the bottom: '${winner.user_name.toUpperCase()}'.
- Card stats: PAS 99 | TIR 99 | REG 99 | FÍS 99 | RIT 99.
- Small caption text: '${matchday.name} · GANADOR'.
- Holographic card shine effect, dark background with golden particles.
- A fan in the background holds a banner that reads '¡CAMPEÓN!' and Maradona hands the player a trophy.
- Ultra-detailed, official FIFA game aesthetic, glossy finish.`;

    let imageUri = null;

    if (winner.user_avatar) {
      try {
        const respRes = await openAiPost('/v1/responses', {
          model: 'gpt-image-1',
          input: [{
            role: 'user',
            content: [
              { type: 'input_image', image_url: winner.user_avatar },
              { type: 'input_text', text: cardPrompt },
            ],
          }],
          tools: [{ type: 'image_generation', quality: 'high' }],
        });
        console.log('Responses API keys:', JSON.stringify(Object.keys(respRes || {})));
        if (respRes.error) {
          console.warn('Responses API error:', JSON.stringify(respRes.error));
        }
        const outputArr = respRes.output || respRes.outputs || [];
        console.log('Responses API output types:', JSON.stringify(outputArr.map(o => o.type)));
        const imgCall = outputArr.find(o => o.type === 'image_generation_call');
        if (imgCall?.result) {
          imageUri = `data:image/png;base64,${imgCall.result}`;
          console.log('Got image from Responses API (base64 length):', imgCall.result.length);
        } else {
          console.warn('Responses API returned no image_generation_call, falling back to DALL-E 3');
        }
      } catch(e) {
        console.warn('Responses API image error:', e.message, '— falling back to DALL-E 3');
      }
    }

    if (!imageUri) {
      const dallePrompt = `A FIFA Ultimate Team player card, ultra high quality digital art style.
- Golden elite card with shiny gradient background and geometric patterns.
- Classic FIFA UT card layout: rating 99 top-left, position PRO below it.
- Player wearing a blue and gold jersey, number 13, in a dynamic celebration pose with fist raised.
- Player name at the bottom: ${winner.user_name.toUpperCase()}.
- Card stats: PAS 99, TIR 99, REG 99, FIS 99, RIT 99.
- Caption text: ${matchday.name} GANADOR.
- Holographic card shine effect, dark background with golden particles.
- Ultra-detailed, official FIFA game aesthetic, glossy finish.`;
      const imageRes = await openAiPost('/v1/images/generations', {
        model: 'dall-e-3',
        prompt: dallePrompt,
        n: 1,
        size: '1024x1024',
        quality: 'hd',
      });
      if (imageRes.error) {
        console.error('DALL-E error:', JSON.stringify(imageRes.error));
      }
      imageUri = imageRes.data?.[0]?.url || null;
      console.log('DALL-E fallback image URL:', imageUri ? 'OK (URL received)' : 'null');
    }

    if (!imageUri) {
      console.warn('[winner] No se generó imagen — el carousel se actualiza sin imagen');
    }

    // ── Persistir ganador en carousel config (con o sin imagen) ─────────────
    let imageUrl = null;
    try {
      imageUrl = imageUri ? await uploadImageToS3(imageUri) : null;

      const entry = {
        image_url: imageUrl,
        matchday_label: matchday.name,
        user_name: winner.user_name,
        points: winner.points,
        updated_at: new Date().toISOString(),
      };
      const existingRes = await connection_1.db.query(`SELECT value FROM config WHERE key = 'ganadores_fechas'`);
      let carouselWinners = [];
      if (existingRes.rows.length > 0) {
        const parsed = parseConfigValue(existingRes.rows[0].value);
        if (Array.isArray(parsed)) carouselWinners = parsed;
      }
      // Reemplazar entrada existente para esta fecha (evitar duplicados)
      const idx = carouselWinners.findIndex(e => e.matchday_label === matchday.name);
      if (idx >= 0) carouselWinners[idx] = entry; else carouselWinners.push(entry);
      await connection_1.db.query(
        `INSERT INTO config (key, value, updated_at) VALUES ('ganadores_fechas', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
        [JSON.stringify(carouselWinners)]
      );
      await connection_1.db.query(
        `INSERT INTO config (key, value, updated_at) VALUES ('ganador_fecha', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
        [JSON.stringify(entry)]
      );
      console.log('[winner] Ganador guardado en carousel config — total:', carouselWinners.length, '— imagen:', imageUrl ? 'sí' : 'no');
    } catch (saveErr) {
      console.error('[winner] Error guardando en carousel config:', saveErr.message);
    }

    const recipients = allEmails.length > 0 ? allEmails : [winnerEmail];
    console.log(`Sending to ${recipients.length} recipients`);

    if (process.env.ENGAGE_ENABLED === 'true') {
      sendEvent({
        type: 'prode.winner.personal',
        userId: String(winner.user_id),
        idempotencyKey: `winner_personal:${winner.user_id}:${matchday.id}`,
        payload: {
          business_context: {
            winner_name: winner.user_name,
            matchday_name: matchday.name,
            points: winner.points,
            puntos: winner.points,
            scorer_line: scorerNames || motivational,
            ...(imageUrl ? { image_url: imageUrl } : {}),
          },
        },
        metadata: {
          user_contact: {
            nombre: winner.user_name,
            email: winnerEmail,
            idioma_pref: 'es-AR',
          },
        },
      }).catch(e => console.error('[winner] engage personal error:', e.message));

      try {
        const broadcastUsersRes = await connection_1.db.query(
          `SELECT id, nombre, email, whatsapp_number, whatsapp_consent FROM users WHERE email IS NOT NULL AND email != ''`
        );
        const broadcastEvents = broadcastUsersRes.rows.map(u => ({
          type: 'prode.winner.broadcast',
          userId: String(u.id),
          idempotencyKey: `winner_broadcast:${u.id}:${matchday.id}`,
          payload: {
            business_context: {
              winner_name: winner.user_name,
              matchday_name: matchday.name,
              points: winner.points,
              puntos: winner.points,
              scorer_line: scorerNames || motivational,
              ...(imageUrl ? { image_url: imageUrl } : {}),
            },
          },
          metadata: {
            user_contact: {
              nombre: u.nombre,
              email: u.email,
              phone: u.whatsapp_number,
              whatsapp_consent: u.whatsapp_consent,
              idioma_pref: 'es-AR',
            },
          },
        }));
        if (broadcastEvents.length > 0) {
          await sendEventBatch(broadcastEvents);
        }
        console.log(`[winner] Engage queued: personal + broadcast (${broadcastEvents.length} users)`);
      } catch (broadcastErr) {
        console.error('[winner] engage broadcast error:', broadcastErr.message);
      }
    } else {
      if (imageUri) {
        function sendImagemail(to, subject, message) {
          const body = JSON.stringify({ to, uri: imageUri, subject, message });
          return new Promise((resolve, reject) => {
            const req = https.request({
              hostname: process.env.API_HOSTNAME || 't49euho172.execute-api.us-east-1.amazonaws.com',
              path: '/prod/api/imagemail',
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
              timeout: 60000,
            }, (res) => { res.resume(); resolve(res.statusCode); });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('imagemail timeout')); });
            req.write(body);
            req.end();
          });
        }

        await runConcurrent(recipients, async (email) => {
          const isWinner = email === winnerEmail;
          const subject = isWinner
            ? `🏆 ¡Ganaste ${matchday.name}!`
            : `🏆 ${winner.user_name} ganó ${matchday.name}`;
          const scorerLine = scorerNames ? `Goleadores de la fecha: ${scorerNames}` : motivational;
          const message = isWinner
            ? `¡Felicitaciones ${winner.user_name}! Ganaste con ${winner.points} puntos.\n${scorerLine}`
            : `${winner.user_name} ganó ${matchday.name} con ${winner.points} puntos.\n${scorerLine}`;
          const status = await sendImagemail(email, subject, message);
          console.log(`Email sent to ${email} — status ${status}`);
        }, 10);
      } else {
        console.log('[winner] Sin imagen — emails de card omitidos');
      }

      try {
          const waUsers = await connection_1.db.query(
              `SELECT whatsapp_number FROM users WHERE whatsapp_number IS NOT NULL AND whatsapp_consent = true`
          );
          await runConcurrent(waUsers.rows, (u) =>
              sendWhatsAppTemplate({
                  to: u.whatsapp_number,
                  templateName: 'prode_ganador_fecha',
                  variables: {
                      '1': winner.user_name,
                      '2': matchday.name,
                      '3': String(winner.points),
                  },
              }).catch(e => console.error(`Winner WA error for ${u.whatsapp_number}:`, e.message))
          , 10);
          console.log(`Winner WA sent to ${waUsers.rows.length} users`);
      } catch(waErr) {
          console.error('Winner WA broadcast error:', waErr.message);
      }
    }

    console.log('Winner notification complete');

    try {
        const { pushToUser, pushToAll } = require('../services/push');
        await pushToUser(winner.user_id, {
            title: `🏆 ¡Ganaste ${matchday.name}!`,
            body: `${winner.points} puntos — ¡Sos el crack de la fecha!`,
            url: '/ranking',
            icon: '/favicon.svg',
        }).catch(e => console.error('Push winner error:', e.message));

        const scorerLine2 = scorerNames ? ` · ${scorerNames}` : '';
        await pushToAll({
            title: `🏆 ${winner.user_name} ganó ${matchday.name}`,
            body: `Con ${winner.points} puntos${scorerLine2}`,
            url: '/ranking',
            icon: '/favicon.svg',
        }).catch(e => console.error('Push broadcast error:', e.message));

        console.log('Winner push notifications sent');
    } catch(pushErr) {
        console.error('Winner push error:', pushErr.message);
    }
  } catch(err) {
    console.error('processWinnerNotification error:', err.message);
  }
}

// ── Timezone helpers ─────────────────────────────────────────────────────────
// Argentina es UTC-3 sin DST. Usamos Intl para que sea correcto incluso si
// en algún momento cambia el offset (históricamente ha variado).
const ARG_TZ = 'America/Argentina/Buenos_Aires';

function toArgentinaDateStr(date) {
  // Retorna 'YYYY-MM-DD' en hora argentina (en-CA da ese formato ISO)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ARG_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function toArgentinaDayMonth(date) {
  const parts = new Intl.DateTimeFormat('es-AR', {
    timeZone: ARG_TZ,
    day: '2-digit',
    month: '2-digit',
  }).formatToParts(date);
  const p = {};
  for (const { type, value } of parts) p[type] = value;
  return { day: p.day, month: p.month };
}
// ─────────────────────────────────────────────────────────────────────────────

async function ensureMatchday(tournamentId, matchDate) {
  const dateStr = toArgentinaDateStr(matchDate);
  const existing = await connection_1.db.query(
    'SELECT * FROM matchdays WHERE tournament_id = $1 AND match_date = $2',
    [tournamentId, dateStr]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const { day, month } = toArgentinaDayMonth(matchDate);
  const name = `Fecha ${day}/${month}`;

  const res = await connection_1.db.query(
    `INSERT INTO matchdays (tournament_id, name, match_date)
     VALUES ($1, $2, $3)
     ON CONFLICT (tournament_id, match_date) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [tournamentId, name, dateStr]
  );
  return res.rows[0];
}

async function _notifyMatchdayClose(rows, matchday, matchdayId) {
  const { pushToUser } = require('../services/push');
  const { sendPostMatchdayEmail } = require('../services/email');

  const top = rows[0]; // already sorted desc by points
  const totalPlanillas = rows.length;

  // Query all user emails for the email notifications
  const allUserIds = rows.map(r => r.user_id);
  const emailsRes = await connection_1.db.query(
    `SELECT id, email, whatsapp_number, whatsapp_consent FROM users WHERE id = ANY($1::uuid[])`,
    [allUserIds]
  );
  const emailMap = {};
  const phoneMap = {};
  const consentMap = {};
  for (const row of emailsRes.rows) {
    if (row.email) emailMap[row.id] = row.email;
    phoneMap[row.id] = row.whatsapp_number;
    consentMap[row.id] = row.whatsapp_consent;
  }

  // Also query global ranking positions for each planilla
  const rankingRes = await connection_1.db.query(
    `SELECT p.user_id, r.position FROM ranking r
     JOIN planillas p ON p.id = r.planilla_id
     WHERE p.user_id = ANY($1::uuid[]) AND r.position IS NOT NULL`,
    [allUserIds]
  );
  const globalPositionMap = {};
  for (const row of rankingRes.rows) globalPositionMap[row.user_id] = row.position;

  for (const r of rows) {
    const userEmail = emailMap[r.user_id];
    const globalPosition = globalPositionMap[r.user_id] || null;

    // ── Resumen post-fecha ─────────────────────────────────────────────────
    const isWinner = top.user_id === r.user_id;
    let summaryTitle, summaryBody;
    if (isWinner) {
      summaryTitle = `👑 ¡Ganaste ${matchday.name}!`;
      summaryBody = `${r.points} pts — sos el crack de la fecha.`;
    } else if (r.rank <= 3) {
      summaryTitle = `🏆 Terminaste #${r.rank} en ${matchday.name}`;
      summaryBody = `${r.points} pts. El ganador: ${top.user_name} con ${top.points} pts.`;
    } else {
      summaryTitle = `🏁 ${matchday.name} cerrada`;
      summaryBody = `${r.points} pts — #${r.rank} de ${totalPlanillas}. El ganador: ${top.user_name}.`;
    }
    const summaryPayload = {
      title: summaryTitle,
      body: summaryBody,
      icon: 'soccer',
    };

    pushToUser(r.user_id, { title: summaryPayload.title, body: summaryPayload.body }).catch(err =>
      console.error(`[matchday-close] push failed user=${r.user_id}:`, err.message)
    );
    await connection_1.db.query(
      `INSERT INTO notifications (user_id, type, payload, status, sent_at)
       VALUES ($1, 'matchday_summary', $2, 'sent', NOW())`,
      [r.user_id, JSON.stringify(summaryPayload)]
    ).catch(err => console.error(`[matchday-close] summary insert failed user=${r.user_id}:`, err.message));

    if (process.env.ENGAGE_ENABLED === 'true') {
      sendEvent({
        type: 'prode.matchday_summary',
        userId: String(r.user_id),
        idempotencyKey: `matchday_summary:${r.user_id}:${matchdayId}`,
        payload: {
          business_context: {
            matchday_name: matchday.name,
            points: r.points,
            puntos: r.points,
            posicion: globalPosition,
            rank_in_matchday: r.rank,
            global_position: globalPosition,
            total_planillas: totalPlanillas,
            top_name: top.user_name,
            top_points: top.points,
            is_winner: isWinner,
          },
        },
        metadata: {
          user_contact: {
            nombre: r.user_name,
            email: userEmail,
            phone: phoneMap[r.user_id],
            whatsapp_consent: consentMap[r.user_id],
            idioma_pref: 'es-AR',
          },
        },
      }).catch(err => console.error(`[matchday-close] engage summary failed user=${r.user_id}:`, err.message));
    } else if (userEmail) {
      sendPostMatchdayEmail({
        userEmail,
        userName: r.user_name,
        matchdayName: matchday.name,
        points: r.points,
        rankInMatchday: r.rank,
        globalPosition,
        topName: top.user_name,
        topPoints: top.points,
        totalPlanillas,
      }).catch(err => console.error(`[matchday-close] email failed user=${r.user_id}:`, err.message));
    }

    // ── Récord personal ────────────────────────────────────────────────────
    const histRes = await connection_1.db.query(
      `SELECT MAX(points) AS max_pts FROM scores_by_matchday
       WHERE planilla_id = $1 AND matchday_id != $2`,
      [r.planilla_id, matchdayId]
    ).catch(() => ({ rows: [{ max_pts: null }] }));
    const maxPts = histRes.rows[0]?.max_pts ?? null;
    // Engage recibe siempre con los puntos actuales y el máximo anterior; Engage decide si es récord.
    // El fallback local (push/in-app) solo actúa cuando efectivamente hay un récord nuevo.
    if (process.env.ENGAGE_ENABLED === 'true') {
      sendEvent({
        type: 'prode.personal_record',
        userId: String(r.user_id),
        idempotencyKey: `personal_record:${r.user_id}:${matchdayId}`,
        payload: {
          business_context: {
            points: r.points,
            puntos: r.points,
            prev_max: maxPts !== null ? parseInt(maxPts) : null,
            matchday_name: matchday.name,
          },
        },
        metadata: {
          user_contact: {
            nombre: r.user_name,
            phone: phoneMap[r.user_id],
            whatsapp_consent: consentMap[r.user_id],
            idioma_pref: 'es-AR',
          },
        },
      }).catch(err => console.error(`[matchday-close] engage record failed user=${r.user_id}:`, err.message));
    } else if (maxPts !== null && r.points > parseInt(maxPts)) {
      const recordPayload = {
        title: '🔥 Nuevo récord personal',
        body: `${r.points} pts en ${matchday.name}. Superaste tu marca anterior (${parseInt(maxPts)} pts).`,
        icon: 'star',
      };
      pushToUser(r.user_id, { title: recordPayload.title, body: recordPayload.body }).catch(err =>
        console.error(`[matchday-close] record push failed user=${r.user_id}:`, err.message)
      );
      await connection_1.db.query(
        `INSERT INTO notifications (user_id, type, payload, status, sent_at)
         VALUES ($1, 'personal_record', $2, 'sent', NOW())`,
        [r.user_id, JSON.stringify(recordPayload)]
      ).catch(err => console.error(`[matchday-close] record insert failed user=${r.user_id}:`, err.message));
    }

    // ── Streak de exactos ──────────────────────────────────────────────────
    const streakRes = await connection_1.db.query(
      `SELECT s.puntos_obtenidos FROM scores s
       JOIN matches m ON s.match_id = m.id
       WHERE s.planilla_id = $1 AND m.estado = 'finished'
       ORDER BY m.start_time DESC LIMIT 10`,
      [r.planilla_id]
    ).catch(() => ({ rows: [] }));
    let streak = 0;
    for (const sr of streakRes.rows) {
      if (sr.puntos_obtenidos >= 3) streak++;
      else break;
    }
    // Engage recibe el streak siempre; Engage decide cuándo notificar (ej. cada 3).
    // El fallback local solo notifica en múltiplos de 3.
    if (process.env.ENGAGE_ENABLED === 'true') {
      sendEvent({
        type: 'prode.streak_exactos',
        userId: String(r.user_id),
        idempotencyKey: `streak_exactos:${r.user_id}:${matchdayId}`,
        payload: {
          business_context: { streak, matchday_name: matchday.name },
        },
        metadata: {
          user_contact: {
            nombre: r.user_name,
            phone: phoneMap[r.user_id],
            whatsapp_consent: consentMap[r.user_id],
            idioma_pref: 'es-AR',
          },
        },
      }).catch(err => console.error(`[matchday-close] engage streak failed user=${r.user_id}:`, err.message));
    } else if (streak > 0 && streak % 3 === 0) {
      const streakTitle = streak >= 9
        ? `🎯 ${streak} exactos seguidos 🔥`
        : streak >= 6
        ? `🎯 ¡${streak} exactos seguidos!`
        : `🎯 ${streak} exactos al hilo`;
      const streakBody = streak >= 9
        ? 'Histórico. Nadie llega a esto.'
        : streak >= 6
        ? 'Sos el más caliente del PRODE ahora mismo.'
        : 'Nadie te para. Seguís así y el podio es tuyo.';
      const streakPayload = { title: streakTitle, body: streakBody, icon: 'star' };
      pushToUser(r.user_id, { title: streakPayload.title, body: streakPayload.body }).catch(err =>
        console.error(`[matchday-close] streak push failed user=${r.user_id}:`, err.message)
      );
      await connection_1.db.query(
        `INSERT INTO notifications (user_id, type, payload, status, sent_at)
         VALUES ($1, 'streak_exactos', $2, 'sent', NOW())`,
        [r.user_id, JSON.stringify(streakPayload)]
      ).catch(err => console.error(`[matchday-close] streak insert failed user=${r.user_id}:`, err.message));
    }
  }
}

async function recalcMatchday(matchdayId) {
  const mdRes = await connection_1.db.query('SELECT * FROM matchdays WHERE id = $1', [matchdayId]);
  if (mdRes.rows.length === 0) throw new Error('Matchday not found');
  const matchday = mdRes.rows[0];

  const matchesRes = await connection_1.db.query(
    `SELECT m.id, m.resultado_local, m.resultado_visitante
     FROM matches m
     WHERE m.tournament_id = $1
       AND DATE(m.start_time AT TIME ZONE 'America/Argentina/Buenos_Aires') = $2
       AND m.estado = 'finished'
       AND m.resultado_local IS NOT NULL`,
    [matchday.tournament_id, matchday.match_date]
  );
  const dayMatches = matchesRes.rows;
  if (dayMatches.length === 0) return { matchday, updated: 0 };

  const matchIds = dayMatches.map(m => m.id);

  const betsRes = await connection_1.db.query(
    `SELECT b.planilla_id, b.match_id, b.goles_local, b.goles_visitante,
            p.user_id, u.nombre AS user_name, u.foto_url AS user_avatar
     FROM bets b
     JOIN planillas p ON p.id = b.planilla_id
     JOIN users u ON u.id = p.user_id
     WHERE b.match_id = ANY($1::uuid[])`,
    [matchIds]
  );

  const resultMap = {};
  for (const m of dayMatches) resultMap[m.id] = m;

  const planillaPoints = {};
  for (const bet of betsRes.rows) {
    const match = resultMap[bet.match_id];
    if (!match) continue;
    const score = (0, scoring_1.calcularPuntaje)(
      { goles_local: bet.goles_local, goles_visitante: bet.goles_visitante },
      { resultado_local: match.resultado_local, resultado_visitante: match.resultado_visitante }
    );
    if (!planillaPoints[bet.planilla_id]) {
      planillaPoints[bet.planilla_id] = {
        planilla_id: bet.planilla_id,
        user_id: bet.user_id,
        user_name: bet.user_name,
        user_avatar: bet.user_avatar || null,
        points: 0,
      };
    }
    planillaPoints[bet.planilla_id].points += score.puntos;
  }

  const rows = Object.values(planillaPoints);
  if (rows.length === 0) return { matchday, updated: 0 };

  rows.sort((a, b) => b.points - a.points);
  let currentRank = 1;
  for (let i = 0; i < rows.length; i++) {
    if (i > 0 && rows[i].points < rows[i - 1].points) currentRank = i + 1;
    rows[i].rank = currentRank;
    rows[i].is_winner = currentRank === 1;
  }

  for (const r of rows) {
    await connection_1.db.query(
      `INSERT INTO scores_by_matchday
         (matchday_id, planilla_id, user_id, user_name, user_avatar, points, rank_in_matchday, is_winner, calculated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (matchday_id, planilla_id) DO UPDATE SET
         points           = EXCLUDED.points,
         rank_in_matchday = EXCLUDED.rank_in_matchday,
         is_winner        = EXCLUDED.is_winner,
         user_name        = EXCLUDED.user_name,
         user_avatar      = EXCLUDED.user_avatar,
         calculated_at    = NOW()`,
      [matchdayId, r.planilla_id, r.user_id, r.user_name, r.user_avatar, r.points, r.rank, r.is_winner]
    );
  }

  const winner = rows.find(r => r.is_winner);
  if (winner) {
    try {
      // Only fire winner notifications when ALL matches of the matchday are finished
      const totalRes = await connection_1.db.query(
        `SELECT COUNT(*) AS total FROM matches
         WHERE tournament_id = $1
           AND DATE(start_time AT TIME ZONE 'America/Argentina/Buenos_Aires') = $2`,
        [matchday.tournament_id, matchday.match_date]
      );
      const totalMatches = parseInt(totalRes.rows[0].total);
      const allFinished = dayMatches.length === totalMatches && totalMatches > 0;

      if (!allFinished) {
        console.log(`[matchday] ${dayMatches.length}/${totalMatches} partidos terminados — esperando último resultado para notificar ganador`);
      } else if (matchday.winner_announced_at) {
        console.log(`[matchday] Winner ya notificado el ${matchday.winner_announced_at} — skip dedup`);
      } else {
        // Post-matchday notifications: resumen + récord personal + streak de exactos
        await _notifyMatchdayClose(rows, matchday, matchdayId).catch(err =>
          console.error('[matchday] _notifyMatchdayClose failed:', err.message)
        );

        const allUserIds = rows.map(r => r.user_id);
        const emailsRes = await connection_1.db.query(
          `SELECT id, email FROM users WHERE id = ANY($1::uuid[]) AND email IS NOT NULL AND email != ''`,
          [allUserIds]
        );
        const emailMap = {};
        for (const row of emailsRes.rows) emailMap[row.id] = row.email;

        const winnerEmail = emailMap[winner.user_id] || '';
        const allEmails = Object.values(emailMap);

        const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
        const lambda = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });
        await lambda.send(new InvokeCommand({
          FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME || 'prode-api',
          InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify({
            source: 'winner-notification',
            winner: { user_id: winner.user_id, user_name: winner.user_name, user_avatar: winner.user_avatar, points: winner.points },
            matchday: { id: matchday.id, name: matchday.name, tournament_id: matchday.tournament_id },
            winnerEmail,
            allEmails,
          })),
        }));
        await connection_1.db.query(
          'UPDATE matchdays SET winner_announced_at = NOW() WHERE id = $1',
          [matchday.id]
        );
        console.log(`[matchday] Todos los partidos terminados — winner notification invocada async para ${winnerEmail} (${allEmails.length} destinatarios)`);
      }
    } catch (err) {
      console.error('Error preparing winner notification:', err.message);
    }
  }

  return { matchday, updated: rows.length };
}

router.get('/', async (req, res) => {
  try {
    const { tournament_id } = req.query;
    if (!tournament_id) {
      return res.status(400).json({ success: false, error: 'tournament_id requerido' });
    }
    const result = await connection_1.db.query(
      `SELECT md.*,
              (SELECT COUNT(*)::int FROM scores_by_matchday WHERE matchday_id = md.id) AS participant_count,
              (SELECT json_agg(json_build_object(
                 'user_id', s.user_id, 'user_name', s.user_name,
                 'user_avatar', s.user_avatar, 'points', s.points,
                 'planilla_id', s.planilla_id
               ))
               FROM scores_by_matchday s
               WHERE s.matchday_id = md.id AND s.is_winner = true
              ) AS winners
       FROM matchdays md
       WHERE md.tournament_id = $1
       ORDER BY md.match_date ASC`,
      [tournament_id]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('GET /matchdays error:', err);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

router.get('/:id/ranking', async (req, res) => {
  try {
    const { id } = req.params;
    const mdRes = await connection_1.db.query('SELECT * FROM matchdays WHERE id = $1', [id]);
    if (mdRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Fecha no encontrada' });
    }
    const ranking = await connection_1.db.query(
      `SELECT s.*, md.name AS matchday_name, md.match_date
       FROM scores_by_matchday s
       JOIN matchdays md ON md.id = s.matchday_id
       WHERE s.matchday_id = $1
       ORDER BY s.rank_in_matchday ASC, s.points DESC`,
      [id]
    );
    res.json({ success: true, data: { matchday: mdRes.rows[0], ranking: ranking.rows } });
  } catch (err) {
    console.error('GET /matchdays/:id/ranking error:', err);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { tournament_id } = req.query;
    let whereExtra = '';
    const params = [userId];
    if (tournament_id) {
      params.push(tournament_id);
      whereExtra = ` AND md.tournament_id = $${params.length}`;
    }
    const result = await connection_1.db.query(
      `SELECT s.*, md.name AS matchday_name, md.match_date, md.tournament_id
       FROM scores_by_matchday s
       JOIN matchdays md ON md.id = s.matchday_id
       WHERE s.user_id = $1${whereExtra}
       ORDER BY md.match_date DESC`,
      params
    );
    const wonCount = result.rows.filter(r => r.is_winner).length;
    res.json({ success: true, data: { history: result.rows, won_count: wonCount } });
  } catch (err) {
    console.error('GET /matchdays/user/:userId error:', err);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

router.get('/me', auth_1.authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { tournament_id } = req.query;
    let whereExtra = '';
    const params = [userId];
    if (tournament_id) {
      params.push(tournament_id);
      whereExtra = ` AND md.tournament_id = $${params.length}`;
    }
    const result = await connection_1.db.query(
      `SELECT s.*, md.name AS matchday_name, md.match_date, md.tournament_id
       FROM scores_by_matchday s
       JOIN matchdays md ON md.id = s.matchday_id
       WHERE s.user_id = $1${whereExtra}
       ORDER BY md.match_date DESC`,
      params
    );
    const wonCount = result.rows.filter(r => r.is_winner).length;
    res.json({ success: true, data: { history: result.rows, won_count: wonCount } });
  } catch (err) {
    console.error('GET /matchdays/me error:', err);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

router.post('/recalculate', auth_1.authMiddleware, async (req, res) => {
  try {
    if (req.user.rol !== 'admin') {
      return res.status(400).json({ success: false, error: 'Admin requerido' });
    }
    const { tournament_id, match_date, matchday_id } = req.body;

    let targetMatchdayId = matchday_id;

    if (!targetMatchdayId) {
      if (!tournament_id || !match_date) {
        return res.status(400).json({ success: false, error: 'Requiere matchday_id o (tournament_id + match_date)' });
      }
      const md = await ensureMatchday(tournament_id, new Date(match_date));
      targetMatchdayId = md.id;
    }

    const result = await recalcMatchday(targetMatchdayId);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('POST /matchdays/recalculate error:', err);
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

router.post('/recalculate-all', auth_1.authMiddleware, async (req, res) => {
  try {
    if (req.user.rol !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin requerido' });
    }
    const { tournament_id } = req.body;
    if (!tournament_id) {
      return res.status(400).json({ success: false, error: 'tournament_id requerido' });
    }

    const datesRes = await connection_1.db.query(
      `SELECT DISTINCT DATE(start_time AT TIME ZONE 'America/Argentina/Buenos_Aires') AS match_date
       FROM matches
       WHERE tournament_id = $1 AND estado = 'finished' AND resultado_local IS NOT NULL
       ORDER BY match_date ASC`,
      [tournament_id]
    );

    const results = [];
    for (const row of datesRes.rows) {
      const md = await ensureMatchday(tournament_id, new Date(row.match_date));
      const r  = await recalcMatchday(md.id);
      results.push({ date: row.match_date, matchday_id: md.id, updated: r.updated });
    }

    res.json({ success: true, data: { processed: results.length, results } });
  } catch (err) {
    console.error('POST /matchdays/recalculate-all error:', err);
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

const ALLOWED_EMOJIS = ['👏', '❤️', '🔥', '😮', '😂'];

router.post('/:id/react', auth_1.authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;
    const emoji = req.body.emoji || '👏';

    if (!ALLOWED_EMOJIS.includes(emoji)) {
      return res.status(400).json({ success: false, error: 'Emoji no válido' });
    }

    const mdRes = await connection_1.db.query('SELECT id FROM matchdays WHERE id = $1', [id]);
    if (mdRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Fecha no encontrada' });
    }

    const existing = await connection_1.db.query(
      'SELECT emoji FROM matchday_reactions WHERE matchday_id = $1 AND user_id = $2',
      [id, userId]
    );

    let userReaction = null;
    if (existing.rows.length > 0 && existing.rows[0].emoji === emoji) {
      await connection_1.db.query(
        'DELETE FROM matchday_reactions WHERE matchday_id = $1 AND user_id = $2',
        [id, userId]
      );
    } else if (existing.rows.length > 0) {
      await connection_1.db.query(
        'UPDATE matchday_reactions SET emoji = $3 WHERE matchday_id = $1 AND user_id = $2',
        [id, userId, emoji]
      );
      userReaction = emoji;
    } else {
      await connection_1.db.query(
        'INSERT INTO matchday_reactions (matchday_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT (matchday_id, user_id) DO UPDATE SET emoji = $3',
        [id, userId, emoji]
      );
      userReaction = emoji;
    }

    const countsRes = await connection_1.db.query(
      'SELECT emoji, COUNT(*)::int AS count FROM matchday_reactions WHERE matchday_id = $1 GROUP BY emoji',
      [id]
    );
    const reactions = {};
    for (const row of countsRes.rows) reactions[row.emoji] = row.count;

    res.json({ success: true, data: { userReaction, reactions } });
  } catch (err) {
    console.error('POST /matchdays/:id/react error:', err);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

router.get('/:id/reactions', async (req, res) => {
  try {
    const { id } = req.params;
    let userId = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
        userId = decoded.userId;
      } catch { /* no auth */ }
    }

    const countsRes = await connection_1.db.query(
      'SELECT emoji, COUNT(*)::int AS count FROM matchday_reactions WHERE matchday_id = $1 GROUP BY emoji',
      [id]
    );
    const reactions = {};
    for (const row of countsRes.rows) reactions[row.emoji] = row.count;

    let userReaction = null;
    if (userId) {
      const myRes = await connection_1.db.query(
        'SELECT emoji FROM matchday_reactions WHERE matchday_id = $1 AND user_id = $2',
        [id, userId]
      );
      if (myRes.rows.length > 0) userReaction = myRes.rows[0].emoji;
    }

    res.json({ success: true, data: { reactions, userReaction } });
  } catch (err) {
    console.error('GET /matchdays/:id/reactions error:', err);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

router.post('/test-email-only', auth_1.authMiddleware, async (req, res) => {
  try {
    const userRes = await connection_1.db.query(
      'SELECT email FROM users WHERE id = $1',
      [req.user.userId]
    );
    const recipient = req.body.target_email || userRes.rows[0]?.email;
    if (!recipient) return res.status(400).json({ success: false, error: 'No email found' });

    const testImageUrl = 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6e/Fussball.png/240px-Fussball.png';
    const body = JSON.stringify({ to: recipient, uri: testImageUrl, subject: 'Test Email Prode', message: 'Este es un email de prueba del pipeline imagemail.' });

    const result = await new Promise((resolve, reject) => {
      const r2 = https.request({
        hostname: process.env.API_HOSTNAME || 't49euho172.execute-api.us-east-1.amazonaws.com',
        path: '/prod/api/imagemail',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 30000,
      }, (r) => {
        let raw = '';
        r.on('data', c => raw += c);
        r.on('end', () => resolve({ status: r.statusCode, body: raw }));
      });
      r2.on('error', reject);
      r2.on('timeout', () => { r2.destroy(); reject(new Error('imagemail timeout')); });
      r2.write(body);
      r2.end();
    });

    res.json({ success: true, data: { recipient, imagemailStatus: result.status, imagemailBody: result.body } });
  } catch (err) {
    console.error('POST /matchdays/test-email-only error:', err);
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

router.post('/test-winner-notification', auth_1.authMiddleware, async (req, res) => {
  try {
    const userRes = await connection_1.db.query(
      'SELECT id, nombre, email, foto_url FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (userRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
    }
    const me = userRes.rows[0];
    const matchdayName = req.body.matchday_name || 'Test Abril 2026';
    const points       = typeof req.body.points === 'number' ? req.body.points : 42;
    const skipAvatar   = req.body.skip_avatar === true;
    const syncMode     = req.body.sync === true;

    const winner = {
      user_id:     me.id,
      user_name:   me.nombre,
      user_avatar: skipAvatar ? null : (me.foto_url || null),
      points,
    };
    const matchday = { id: '00000000-0000-0000-0000-000000000000', name: matchdayName, tournament_id: null };

    const notifPromise = processWinnerNotification(winner, matchday, me.email, [me.email]);

    if (syncMode) {
      try {
        await notifPromise;
        return res.json({
          success: true,
          data: { message: 'winner-notification completado (sync)', winner, matchday, recipient: me.email },
        });
      } catch (err) {
        return res.status(500).json({ success: false, error: String(err.message || err) });
      }
    }

    res.json({
      success: true,
      data: {
        message: 'winner-notification disparado inline (fire-and-forget) — revisá CloudWatch + bandeja',
        winner,
        matchday,
        recipient: me.email,
      },
    });
  } catch (err) {
    console.error('POST /matchdays/test-winner-notification error:', err);
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

async function recalcMatchdayForMatch(matchId, tournamentId, startTime) {
  const md = await ensureMatchday(tournamentId, new Date(startTime));
  await recalcMatchday(md.id);
}

module.exports = router;
module.exports.recalcMatchdayForMatch = recalcMatchdayForMatch;
module.exports.recalcMatchday = recalcMatchday;
module.exports.processWinnerNotification = processWinnerNotification;
exports.default = router;
