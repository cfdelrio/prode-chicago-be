"use strict";

// WhatsApp via Twilio. Para SMS regular (Infobip) ver services/sms.js

// WHATSAPP_ENABLED: set to "false" to disable all WhatsApp sends (e.g. while WABA is restricted).
const WHATSAPP_ENABLED = process.env.WHATSAPP_ENABLED !== 'false';

// WHATSAPP_WHITELIST: comma-separated numbers (e.g. "+5491155996222,+5491141843591")
// When set, only those numbers receive messages (sandbox/testing mode).
// Remove or leave empty in production to send to all users.
const WHITELIST = process.env.WHATSAPP_WHITELIST
    ? process.env.WHATSAPP_WHITELIST.split(',').map(n => n.trim()).filter(Boolean)
    : null;

// Templates aprobados por Meta via Twilio Content API
const TEMPLATES = {
    // Body: "🔥 ¡Sos el nuevo líder del PRODE Caballito!\nCon {{1}} puntos estás en el puesto #1.\n\n¡No lo sueltes! 👉 prodecaballito.com/ranking"
    // Variables: { 1: puntos }
    prode_nuevo_lider: 'HX3d2e4229b56b20d222ae85b64a2e607e',

    // Body: "⚽ {{1}} {{2}}-{{3}} {{4}}\n\n{{5}}\n🏆 Estás #{{6}} en el ranking\n\n👉 prodecaballito.com/ranking"
    // Variables: { 1: equipo_local, 2: goles_local, 3: goles_visitante, 4: equipo_visitante, 5: betLine, 6: posicion }
    prode_resultado_partido: 'HX7ed5ef7d53402b094a81ecd8d4cbf5af',

    // Body: "🏆 ¡{{1}} ganó {{2}}!\nCon {{3}} puntos exactos.\n\n👉 prodecaballito.com/ranking"
    // Variables: { 1: nombre_ganador, 2: nombre_fecha, 3: puntos }
    prode_ganador_fecha: 'HX037ab7e8789f1de1575a26737ff8a233',
};

const sendWhatsApp = async ({ to, body }) => {
    if (!WHATSAPP_ENABLED) {
        console.log(`[whatsapp] WHATSAPP_ENABLED=false, skipping send to ${to}`);
        return;
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken  = process.env.TWILIO_AUTH_TOKEN;
    const from       = process.env.TWILIO_WHATSAPP_FROM; // 'whatsapp:+14155238886'

    if (!accountSid || !authToken || !from) {
        console.warn('[whatsapp] Twilio env vars not set, skipping');
        return;
    }

    if (WHITELIST) {
        const normalize = (n) => n.replace(/^\+/, '');
        if (!WHITELIST.map(normalize).includes(normalize(to))) {
            console.log(`[whatsapp] ${to} not in whitelist, skipping`);
            return;
        }
    }

    // Normalizar número: asegurar que empiece con +
    const normalized = to.startsWith('+') ? to : `+${to}`;

    const twilio = require('twilio')(accountSid, authToken);
    const message = await twilio.messages.create({
        from,
        to: `whatsapp:${normalized}`,
        body,
    });
    console.log(`[whatsapp] sent to ${to} — sid: ${message.sid}`);
    return message;
};

const sendWhatsAppTemplate = async ({ to, templateName, variables }) => {
    if (!WHATSAPP_ENABLED) {
        console.log(`[whatsapp-template] WHATSAPP_ENABLED=false, skipping "${templateName}" to ${to}`);
        return;
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken  = process.env.TWILIO_AUTH_TOKEN;
    const from       = process.env.TWILIO_WHATSAPP_FROM;

    if (!accountSid || !authToken || !from) {
        console.warn('[whatsapp-template] Twilio env vars not set, skipping');
        return;
    }

    const contentSid = TEMPLATES[templateName];
    if (!contentSid) {
        console.error(`[whatsapp-template] Template desconocido: ${templateName}`);
        return;
    }

    const normalized = to.startsWith('+') ? to : `+${to}`;
    console.log(`[whatsapp-template] enviando "${templateName}" a ${normalized}`);

    const twilio = require('twilio')(accountSid, authToken);
    const message = await twilio.messages.create({
        from,
        to: `whatsapp:${normalized}`,
        contentSid,
        contentVariables: JSON.stringify(variables),
    });
    console.log(`[whatsapp-template] "${templateName}" → ${normalized} — sid: ${message.sid}`);
    return message;
};

module.exports = { sendWhatsApp, sendWhatsAppTemplate, TEMPLATES };
