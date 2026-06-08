'use strict'

const { db } = require('../db/connection')
const { pushToUser } = require('./push')
const { sendSMSWithRetry } = require('./sms')
const { sendEmail } = require('./email')
const { sendEvent } = require('./engageClient')

const REMINDER_TYPE = 'payment_7days'

async function runPaymentReminders() {
    // Find unpaid planillas whose tournament has matches starting in the next 7 days
    const planillasRes = await db.query(`
        SELECT p.id AS planilla_id, p.nombre_planilla,
               u.id AS user_id, u.nombre, u.email, u.whatsapp_number, u.whatsapp_consent,
               t.name AS torneo_name,
               MIN(m.start_time) AS primer_partido,
               (ARRAY_AGG(m.id ORDER BY m.start_time ASC))[1] AS first_match_id
        FROM planillas p
        JOIN users u ON u.id = p.user_id
        JOIN tournaments t ON t.id = p.tournament_id
        JOIN matches m ON m.tournament_id = t.id
        WHERE p.precio_pagado = false
          AND m.estado = 'scheduled'
        GROUP BY p.id, p.nombre_planilla, u.id, u.nombre, u.email, u.whatsapp_number, u.whatsapp_consent, t.name
        HAVING MIN(m.start_time) BETWEEN NOW() AND NOW() + INTERVAL '7 days'
    `)

    if (planillasRes.rows.length === 0) {
        return { planillas_found: 0, users_notified: 0, skipped: 0 }
    }

    let notified = 0
    let skipped = 0

    for (const p of planillasRes.rows) {
        const insertRes = await db.query(
            `INSERT INTO reminder_sent (user_id, match_id, reminder_type)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, match_id, reminder_type) DO NOTHING
             RETURNING user_id`,
            [p.user_id, p.first_match_id, REMINDER_TYPE]
        ).catch(() => ({ rows: [] }))

        if (insertRes.rows.length === 0) { skipped++; continue }

        const daysLeft = Math.max(1, Math.ceil((new Date(p.primer_partido).getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
        const payload = {
            title: `💸 "${p.nombre_planilla}" sin pagar`,
            body: `El torneo arranca en ${daysLeft} día${daysLeft === 1 ? '' : 's'}. Sin pago no sumás puntos.`,
            icon: 'warning',
        }

        pushToUser(p.user_id, { title: payload.title, body: payload.body }).catch(err =>
            console.error(`[payment-reminder] push failed user=${p.user_id}:`, err.message)
        )

        await db.query(
            `INSERT INTO notifications (user_id, type, payload, status, sent_at)
             VALUES ($1, 'payment_pending', $2, 'sent', NOW())`,
            [p.user_id, JSON.stringify(payload)]
        ).catch(err => console.error(`[payment-reminder] insert failed user=${p.user_id}:`, err.message))

        if (process.env.ENGAGE_ENABLED === 'true') {
            sendEvent({
                type: 'prode.payment_pending',
                userId: String(p.user_id),
                idempotencyKey: `payment_pending:${p.user_id}:${p.first_match_id}`,
                payload: {
                    business_context: {
                        planilla_nombre: p.nombre_planilla,
                        torneo_name: p.torneo_name,
                        days_left: daysLeft,
                    },
                },
                metadata: {
                    user_contact: {
                        nombre: p.nombre,
                        email: p.email,
                        phone: p.whatsapp_number,
                        whatsapp_consent: p.whatsapp_consent,
                        idioma_pref: 'es-AR',
                    },
                },
            }).catch(err => console.error(`[payment-reminder] engage failed user=${p.user_id}:`, err.message))
        } else {
            if (p.email) {
                sendEmail({
                    to: p.email,
                    subject: `💸 Tu planilla "${p.nombre_planilla}" todavía no está paga`,
                    html: buildPaymentEmailHtml({ nombre: p.nombre, planillaNombre: p.nombre_planilla, torneoName: p.torneo_name }),
                }).catch(err => console.error(`[payment-reminder] email failed user=${p.user_id}:`, err.message))
            }

            if (p.whatsapp_number && p.whatsapp_consent) {
                sendSMSWithRetry({
                    to: p.whatsapp_number,
                    body: `💸 "${p.nombre_planilla}" para ${p.torneo_name} sigue sin pagar. Arrancan en ${daysLeft} día${daysLeft === 1 ? '' : 's'}. 👉 prodecaballito.com/planillas`,
                }).catch(err => console.error(`[payment-reminder] SMS failed user=${p.user_id}:`, err.message))
            }
        }

        notified++
    }

    console.log(`[payment-reminder] planillas_found=${planillasRes.rows.length} notified=${notified} skipped=${skipped}`)
    return { planillas_found: planillasRes.rows.length, users_notified: notified, skipped }
}

function buildPaymentEmailHtml({ nombre, planillaNombre, torneoName }) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background-color:#F1F5F9;">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td align="center" style="padding:32px 16px;">
    <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">
      <tr><td style="background-color:#7C2D12;padding:32px 32px 24px;text-align:center;">
        <p style="margin:0;font-size:40px;line-height:1;">💸</p>
        <p style="margin:10px 0 4px;font-size:20px;font-weight:900;color:#FED7AA;font-family:Arial,sans-serif;">PLANILLA SIN PAGAR</p>
        <p style="margin:0;font-size:13px;color:#FDBA74;font-family:Arial,sans-serif;">PRODE Caballito</p>
      </td></tr>
      <tr><td style="background-color:#FFFFFF;padding:32px 32px 28px;">
        <p style="margin:0 0 8px;font-size:18px;font-weight:900;color:#001A4B;font-family:Arial,sans-serif;">¡Hola, ${nombre}! 👋</p>
        <p style="margin:0 0 24px;font-size:15px;color:#374151;font-family:Arial,sans-serif;line-height:1.6;">
          Tu planilla <strong>"${planillaNombre}"</strong> para <strong>${torneoName}</strong> todavía no está paga.<br><br>
          Sin el pago confirmado, tus pronósticos <strong>no cuentan para el ranking</strong>.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td align="center">
            <a href="https://prodecaballito.com/planillas" style="display:inline-block;background-color:#EA580C;color:#FFFFFF;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;padding:14px 36px;border-radius:50px;">Confirmar pago →</a>
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="background-color:#F8FAFC;padding:16px 32px;text-align:center;">
        <p style="margin:0;font-size:11px;color:#9CA3AF;font-family:Arial,sans-serif;">prodecaballito.com</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`
}

module.exports = { runPaymentReminders }
