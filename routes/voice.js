'use strict';

const express = require('express');
const twilio  = require('twilio');
const router  = express.Router();
const { db }  = require('../db/connection');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

const API_BASE = process.env.API_URL || 'https://t49euho172.execute-api.us-east-1.amazonaws.com/prod/api';

// ─── Twilio signature validation middleware ────────────────────────────────────

/**
 * Validates the X-Twilio-Signature header on incoming Twilio webhook POSTs.
 * Must run AFTER express.urlencoded() has parsed req.body.
 * Returns 403 on invalid/missing signature, 500 if TWILIO_AUTH_TOKEN is not set.
 */
function validateTwilioSignature(req, res, next) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.error('[voice] TWILIO_AUTH_TOKEN not set — cannot validate webhook signature');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const signature = req.headers['x-twilio-signature'];
  if (!signature) {
    console.warn('[voice] Missing X-Twilio-Signature from', req.ip);
    return res.status(403).json({ error: 'Missing Twilio signature' });
  }

  // Full URL Twilio used to POST — must match exactly what Twilio was configured with.
  const url = `${process.env.API_URL || 'https://api-hr.prodecaballito.com'}${req.originalUrl}`;
  const params = req.body || {};

  const isValid = twilio.validateRequest(authToken, signature, url, params);
  if (!isValid) {
    console.error('[voice] Invalid Twilio signature for', req.originalUrl, 'from', req.ip);
    return res.status(403).json({ error: 'Invalid Twilio signature' });
  }
  next();
}

// ─── Inbound 0800 ─────────────────────────────────────────────────────────────

const MENU_MESSAGES = {
  '1': 'El reglamento es simple. Hacés tus pronósticos antes del inicio de cada partido. Los resultados se toman al finalizar los 90 minutos reglamentarios. No cuentan alargues ni penales. Sumás puntos según tus aciertos y competís en el ranking general.',
  '2': 'Para jugar, ingresá a Prode High Rolling, completá tus pronósticos y seguí el ranking en vivo. La idea es demostrar quién sabe más de fútbol entre amigos, conocidos y fanáticos.',
  '3': 'La primera ronda es la etapa inicial del juego. Luego, cuando el Mundial esté avanzado, se habilitará la segunda ronda. Cada jornada suma emoción y actualiza el ranking.',
  '4': 'Sumate al canal oficial de WhatsApp de Prode High Rolling para recibir novedades, cierres, rankings y avisos importantes. El link está disponible en nuestras redes y en la web oficial.',
};

function buildWelcomeTwiml() {
  const menuUrl = `${API_BASE}/voice/menu`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="${menuUrl}" method="POST" timeout="8">
    <Say language="es-AR" voice="Polly.Conchita">
      Bienvenido a Prode High Rolling.
      El prode futbolero donde competís contra todos en tiempo real.
      Para escuchar el reglamento, presioná 1.
      Para saber cómo jugar, presioná 2.
      Para información sobre la primera ronda, presioná 3.
      Para sumarte al canal oficial de WhatsApp, presioná 4.
    </Say>
  </Gather>
  <Say language="es-AR" voice="Polly.Conchita">No recibimos ninguna opción. Gracias por llamar a Prode High Rolling. ¡Nos vemos en el podio!</Say>
</Response>`;
}

// POST /api/voice — punto de entrada para llamadas entrantes del 0800
router.post('/', validateTwilioSignature, (req, res) => {
  const { CallSid, From } = req.body || {};
  console.log(`[voice-inbound] CallSid=${CallSid} from=${From || 'unknown'}`);
  res.type('text/xml');
  res.send(buildWelcomeTwiml());
});

// GET /api/voice — sanity check en browser
router.get('/', (_req, res) => {
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say language="es-AR">Voice inbound endpoint OK.</Say></Response>`);
});

// POST /api/voice/menu — maneja la opción elegida por el usuario
router.post('/menu', validateTwilioSignature, (req, res) => {
  const { Digits, CallSid, From } = req.body || {};
  console.log(`[voice-menu] CallSid=${CallSid} from=${From || 'unknown'} digit=${Digits}`);

  const text = MENU_MESSAGES[Digits];
  const menuUrl = `${API_BASE}/voice`;

  res.type('text/xml');

  if (text) {
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="es-AR" voice="Polly.Conchita">${text}</Say>
  <Gather numDigits="1" action="${API_BASE}/voice/menu" method="POST" timeout="8">
    <Say language="es-AR" voice="Polly.Conchita">Presioná 1 para volver al menú principal, o colgá cuando quieras.</Say>
  </Gather>
  <Say language="es-AR" voice="Polly.Conchita">Gracias por llamar a Prode High Rolling. ¡Hasta la próxima!</Say>
</Response>`);
  } else if (Digits === '1' || !Digits) {
    // Volver al menú (desde el "presioná 1 para volver")
    res.send(buildWelcomeTwiml());
  } else {
    // Opción inválida — repetir menú una vez
    res.send(buildWelcomeTwiml());
  }
});

// POST /api/voice/twiml
// Called by Twilio when the user answers — returns TwiML that plays the survey
router.post('/twiml', validateTwilioSignature, (req, res) => {
    const { surveyId, question, options: optionsRaw } = req.query;
    let options = [];
    try { options = JSON.parse(optionsRaw); } catch { /* malformed options — proceed with empty */ }

    const optionsPhrased = options.map(o => `Presioná ${o.digit} para ${o.label}`).join('. ');
    const responseUrl = `${API_BASE}/voice/response?surveyId=${encodeURIComponent(surveyId)}`;

    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="${responseUrl}" method="POST" timeout="10">
    <Say language="es-AR" voice="Polly.Conchita">${question}. ${optionsPhrased}. Repetimos: ${question}. ${optionsPhrased}.</Say>
  </Gather>
  <Say language="es-AR" voice="Polly.Conchita">No recibimos tu respuesta. Gracias igual. Hasta la próxima del PRODE High Rolling.</Say>
</Response>`);
});

// GET /api/voice/twiml — sanity check en browser
router.get('/twiml', (_req, res) => {
    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say language="es-AR">Voice survey endpoint OK.</Say></Response>`);
});

// POST /api/voice/response
// Called by Twilio after the user presses a digit
router.post('/response', validateTwilioSignature, async (req, res) => {
    const { surveyId } = req.query;
    const { Digits, CallSid, From } = req.body;

    try {
        if (Digits) {
            await db.query(
                `INSERT INTO voice_survey_responses (survey_id, call_sid, phone_number, digit, created_at)
                 VALUES ($1, $2, $3, $4, NOW())
                 ON CONFLICT (survey_id, call_sid) DO UPDATE SET digit = EXCLUDED.digit`,
                [surveyId, CallSid, From, Digits]
            );
            console.log(`[voice-response] surveyId=${surveyId} from=${From} digit=${Digits}`);
        }
    } catch (err) {
        console.error('[voice-response] db error:', err.message);
    }

    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="es-AR" voice="Polly.Conchita">¡Gracias por tu voto! Hasta la próxima del PRODE High Rolling.</Say>
  <Hangup/>
</Response>`);
});

// POST /api/voice/status
// Twilio status callback — tracks call outcome (completed, no-answer, busy, failed)
router.post('/status', validateTwilioSignature, async (req, res) => {
    const { CallSid, CallStatus, To } = req.body;
    try {
        await db.query(
            `UPDATE voice_survey_responses SET call_status = $2 WHERE call_sid = $1`,
            [CallSid, CallStatus]
        );
    } catch { /* no row yet if call didn't reach response stage — ignore */ }
    console.log(`[voice-status] sid=${CallSid} status=${CallStatus} to=${To}`);
    res.sendStatus(200);
});

// GET /api/voice/results/:surveyId — admin only
router.get('/results/:surveyId', authMiddleware, requireAdmin, async (req, res) => {
    const { surveyId } = req.params;
    try {
        const [surveyRes, responsesRes] = await Promise.all([
            db.query(`SELECT * FROM voice_surveys WHERE id = $1`, [surveyId]),
            db.query(
                `SELECT digit, COUNT(*)::int AS count
                 FROM voice_survey_responses
                 WHERE survey_id = $1 AND digit IS NOT NULL
                 GROUP BY digit ORDER BY digit`,
                [surveyId]
            ),
        ]);

        if (surveyRes.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Encuesta no encontrada' });
        }

        const options = surveyRes.rows[0].options || [];
        const byDigit = Object.fromEntries(responsesRes.rows.map(r => [r.digit, r.count]));
        const resultsWithLabels = options.map(o => ({
            digit:  o.digit,
            label:  o.label,
            count:  byDigit[o.digit] || 0,
        }));
        const total = resultsWithLabels.reduce((acc, r) => acc + r.count, 0);

        res.json({
            success: true,
            data: {
                survey: surveyRes.rows[0],
                results: resultsWithLabels,
                total_responses: total,
            },
        });
    } catch (err) {
        console.error('[voice-results] error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
