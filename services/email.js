"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendRankingUpdateEmail = exports.sendVerificationCode = exports.sendWelcomeEmail = exports.sendEmail = void 0;
const { db } = require('../db/connection');
const RESEND_API_KEY = process.env.RESEND_API_KEY;
if (!RESEND_API_KEY) {
    console.warn('[email] RESEND_API_KEY not configured — email sending disabled');
}
const FROM_EMAIL = 'noreply@hr.prodecaballito.com';
const sendEmail = async ({ to, subject, html }) => {
    if (!RESEND_API_KEY) {
        console.warn('[email] Skipping email send — RESEND_API_KEY not configured');
        return null;
    }
    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: `PRODE High Rolling <${FROM_EMAIL}>`, to, subject, html }),
    });
    if (!res.ok) {
        const err = await res.text();
        console.error('Resend error:', err);
        throw new Error(`Resend API error: ${res.status} ${err}`);
    }
};
exports.sendEmail = sendEmail;
const sendRankingUpdateEmail = async (userEmail, userName, newPosition, previousPosition, points) => {
    const movement = previousPosition ? (previousPosition - newPosition) : 0;
    let headerEmoji = '';
    let headerTitle = '';
    let messageHtml = '';
    let subject = '';
    let bgColor = '#FFFFFF';

    if (movement > 0) {
        headerEmoji = '📈';
        headerTitle = '¡SUBISTE!';
        messageHtml = `Avanzaste <strong>${movement} posición${movement > 1 ? 'es' : ''}</strong> en el ranking. De #${previousPosition} a #${newPosition}.`;
        subject = `📈 Subiste ${movement} lugar${movement > 1 ? 'es' : ''} — ahora sos #${newPosition}`;
        bgColor = '#ECFDF5';
    } else if (movement < 0) {
        headerEmoji = '📉';
        headerTitle = 'BAJASTE EN EL RANKING';
        messageHtml = `Bajaste <strong>${Math.abs(movement)} posición${Math.abs(movement) > 1 ? 'es' : ''}</strong>. Ahora estás #${newPosition}. El próximo partido, tu revancha.`;
        subject = `📉 Bajaste ${Math.abs(movement)} lugar${Math.abs(movement) > 1 ? 'es' : ''} — estás #${newPosition}`;
        bgColor = '#FEF2F2';
    } else if (previousPosition === null) {
        headerEmoji = '⭐';
        headerTitle = '¡BIENVENIDO AL RANKING!';
        messageHtml = `Ya estás #${newPosition}. El podio te espera.`;
        subject = `⭐ ¡Entraste al ranking! Posición #${newPosition}`;
        bgColor = '#FFFBEB';
    } else {
        headerEmoji = '👀';
        headerTitle = 'MANTUVISTE TU POSICIÓN';
        messageHtml = `Seguís siendo <strong>#${newPosition}</strong> con ${points} puntos. La próxima fecha puede cambiar todo.`;
        subject = `👀 Mantuviste #${newPosition} — ${points} pts`;
        bgColor = '#FFFFFF';
    }

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background-color:#F1F5F9;">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td align="center" style="padding:32px 16px;">
    <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">
      <!-- Header -->
      <tr><td style="background-color:#001A4B;padding:32px 32px 24px;text-align:center;">
        <p style="margin:0;font-size:48px;line-height:1;">${headerEmoji}</p>
        <p style="margin:10px 0 4px;font-size:22px;font-weight:900;color:#FFCC00;font-family:Arial,sans-serif;letter-spacing:1px;">${headerTitle}</p>
        <p style="margin:0;font-size:13px;color:#93C5FD;font-family:Arial,sans-serif;">PRODE High Rolling</p>
      </td></tr>
      <!-- Body -->
      <tr><td style="background-color:${bgColor};padding:32px 32px 28px;">
        <p style="margin:0 0 8px;font-size:18px;font-weight:900;color:#001A4B;font-family:Arial,sans-serif;">Hola, ${userName}! 👋</p>
        <p style="margin:0 0 24px;font-size:15px;color:#374151;font-family:Arial,sans-serif;line-height:1.6;">
          ${messageHtml}
        </p>
        <!-- Ranking card -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">
          <tr>
            <td width="50%" style="padding:4px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#EFF6FF;border-radius:12px;padding:16px;text-align:center;">
                <tr><td>
                  <p style="margin:0;font-size:11px;color:#3B82F6;font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:1px;font-weight:bold;">Tu posición</p>
                  <p style="margin:4px 0 0;font-size:36px;font-weight:900;color:#1D4ED8;font-family:Arial,sans-serif;">#${newPosition}</p>
                </td></tr>
              </table>
            </td>
            <td width="50%" style="padding:4px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F0FDF4;border-radius:12px;padding:16px;text-align:center;">
                <tr><td>
                  <p style="margin:0;font-size:11px;color:#16A34A;font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:1px;font-weight:bold;">Tus puntos</p>
                  <p style="margin:4px 0 0;font-size:36px;font-weight:900;color:#15803D;font-family:Arial,sans-serif;">${points}</p>
                </td></tr>
              </table>
            </td>
          </tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td align="center">
            <a href="https://hr.prodecaballito.com/ranking" style="display:inline-block;background-color:#001A4B;color:#FFFFFF;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;padding:14px 36px;border-radius:50px;">Ver ranking completo →</a>
          </td></tr>
        </table>
      </td></tr>
      <!-- Footer -->
      <tr><td style="background-color:#F8FAFC;padding:16px 32px;text-align:center;">
        <p style="margin:0;font-size:11px;color:#9CA3AF;font-family:Arial,sans-serif;">hr.prodecaballito.com</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

    await (0, exports.sendEmail)({
        to: userEmail,
        subject,
        html,
    });
};
exports.sendRankingUpdateEmail = sendRankingUpdateEmail;
const sendWelcomeEmail = async (email, nombre) => {
    const [countResult, userResult] = await Promise.all([
        db.query('SELECT COUNT(*) as total FROM users'),
        db.query('SELECT foto_url FROM users WHERE email = $1', [email]),
    ]);
    const totalJugadores = Number(countResult.rows[0]?.total || 0).toLocaleString('es-AR');
    const fotoUrl = userResult.rows[0]?.foto_url || null;
    const avatarTd = fotoUrl
      ? `<td width="72" valign="middle" align="center" style="padding:0 12px;"><img src="${fotoUrl}" alt="avatar" width="60" height="60" style="border-radius:50%;border:2px solid #FFB700;object-fit:cover;display:block;margin:0 auto;" /></td>`
      : `<td width="52" valign="middle" style="padding-right:14px;"><div style="width:44px;height:44px;background:#FFB700;border-radius:50%;text-align:center;line-height:44px;font-size:22px;">⚠️</div></td>`;
    const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bienvenido - PRODE High Rolling</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f4;">
<tr><td align="center" style="padding:0;">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;margin:0 auto;">

  <!-- ── BLOQUE 1: HEADER ── -->
  <tr>
    <td style="background:#000;padding:14px 20px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td valign="middle">
            <table cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="middle" style="padding-right:8px;">
                  <div style="width:32px;height:32px;background:#fff;border-radius:50%;text-align:center;line-height:32px;font-size:16px;">⚽</div>
                </td>
                <td valign="middle">
                  <div style="color:#fff;font-size:13px;font-weight:900;font-family:'Arial Black',Arial,sans-serif;line-height:1.1;letter-spacing:0.5px;">PRODE</div>
                  <div style="color:#fff;font-size:10px;font-weight:400;font-family:Arial,sans-serif;letter-spacing:1px;">CABALLITO</div>
                </td>
              </tr>
            </table>
          </td>
          <td align="right" valign="middle">
            <span style="color:#fff;font-size:11px;font-family:Arial,sans-serif;letter-spacing:0.5px;">🔥 MUNDIAL 2026 · YA ARRANCÓ</span>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- ── BLOQUE 2: HERO (foto estadio real + overlay oscuro) ── -->
  <tr>
    <td bgcolor="#0a1628" style="background-image:url('https://hr.prodecaballito.com/ChatGPT%20Image%20Apr%2025%2C%202026%2C%2005_00_01%20PM.png');background-size:cover;background-position:center top;background-color:#0a1628;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="background:linear-gradient(to bottom,rgba(0,0,0,0.55) 0%,rgba(0,0,0,0.72) 100%);padding:48px 28px 44px;">
            <div style="color:#fff;font-size:52px;font-weight:900;font-family:'Arial Black',Arial,sans-serif;line-height:0.95;letter-spacing:-2px;text-transform:uppercase;margin-bottom:4px;">ESTO YA EMPEZÓ</div>
            <div style="color:#FFB700;font-size:44px;font-weight:900;font-family:'Arial Black',Arial,sans-serif;line-height:0.95;letter-spacing:-2px;text-transform:uppercase;margin-bottom:4px;">¿VAS A JUGAR</div>
            <div style="color:#FFB700;font-size:44px;font-weight:900;font-family:'Arial Black',Arial,sans-serif;line-height:0.95;letter-spacing:-2px;text-transform:uppercase;margin-bottom:20px;">O MIRAR?</div>
            <div style="color:rgba(255,255,255,0.85);font-size:15px;font-family:Arial,sans-serif;">Tus amigos ya están compitiendo.</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- ── BLOQUE 3: YA ESTÁS ADENTRO (fondo gris claro) ── -->
  <tr>
    <td style="background:#f0f0f0;padding:24px 20px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <!-- Columna izquierda -->
          <td width="56%" valign="top" style="padding-right:12px;">
            <div style="font-size:22px;margin-bottom:6px;">🎉</div>
            <div style="font-size:15px;font-weight:900;font-family:'Arial Black',Arial,sans-serif;line-height:1.2;margin-bottom:8px;">
              <span style="color:#111;">¡YA ESTÁS </span><span style="color:#F47C00;">ADENTRO DEL PRODE!</span>
            </div>
            <div style="color:#333;font-size:13px;font-family:Arial,sans-serif;margin-bottom:12px;">${nombre}, el juego ya empezó.</div>
            <!-- Bullet 1 -->
            <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:7px;">
              <tr>
                <td valign="middle" style="padding-right:8px;">
                  <div style="width:20px;height:20px;background:#27AE60;border-radius:50%;text-align:center;line-height:20px;font-size:11px;color:#fff;font-weight:bold;font-family:Arial;">✓</div>
                </td>
                <td valign="middle"><span style="color:#333;font-size:13px;font-family:Arial,sans-serif;">Cada partido suma</span></td>
              </tr>
            </table>
            <!-- Bullet 2 -->
            <table cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="middle" style="padding-right:8px;">
                  <div style="width:20px;height:20px;background:#27AE60;border-radius:50%;text-align:center;line-height:20px;font-size:11px;color:#fff;font-weight:bold;font-family:Arial;">✓</div>
                </td>
                <td valign="middle"><span style="color:#333;font-size:13px;font-family:Arial,sans-serif;">Cada punto te acerca al podio</span></td>
              </tr>
            </table>
          </td>
          <!-- Columna derecha: card oscura -->
          <td width="44%" valign="middle">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#1a1a2e;border-radius:12px;">
              <tr>
                <td align="center" style="padding:20px 14px;">
                  <div style="font-size:30px;margin-bottom:8px;">🏆</div>
                  <div style="color:#999;font-size:9px;font-family:Arial,sans-serif;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px;">TU OBJETIVO:</div>
                  <div style="color:#FFB700;font-size:17px;font-weight:900;font-family:'Arial Black',Arial,sans-serif;text-transform:uppercase;line-height:1.1;margin-bottom:6px;">EL PRIMER<br>PUESTO</div>
                  <div style="color:rgba(255,255,255,0.5);font-size:11px;font-family:Arial,sans-serif;">¿Estás listo para lograrlo?</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- ── BLOQUE 4: ALERTA (fondo oscuro, avatar izq, texto centro, 🔥 der) ── -->
  <tr>
    <td style="background:#222;padding:20px 24px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <!-- Avatar izquierda (si tiene foto) -->
          ${avatarTd}
          <!-- Texto central -->
          <td valign="middle" style="padding:0 12px;">
            <div style="color:#fff;font-size:15px;font-weight:900;font-family:'Arial Black',Arial,sans-serif;text-transform:uppercase;margin-bottom:4px;">NO TE QUEDES AFUERA</div>
            <div style="color:#ccc;font-size:12px;font-family:Arial,sans-serif;margin-bottom:3px;">Los primeros partidos ya se están jugando.</div>
            <div style="color:#fff;font-size:12px;font-family:Arial,sans-serif;">Si no apostás ahora, <strong>perdés puntos.</strong></div>
          </td>
          <!-- Llama derecha -->
          <td width="44" valign="middle" align="right">
            <div style="font-size:36px;line-height:1;">🔥</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- ── BLOQUE 5: STATS + CÓMO FUNCIONA (fondo blanco) ── -->
  <tr>
    <td style="background:#fff;padding:24px 20px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <!-- Columna izquierda: estadística jugadores -->
          <td width="38%" valign="top" style="padding-right:16px;border-right:1px solid #e5e5e5;">
            <div style="margin-bottom:8px;">
              <div style="display:inline-block;width:36px;height:36px;background:#F47C00;border-radius:50%;text-align:center;line-height:36px;font-size:18px;">👥</div>
            </div>
            <div style="color:#666;font-size:9px;font-family:Arial,sans-serif;letter-spacing:2px;text-transform:uppercase;margin-bottom:2px;">YA HAY</div>
            <div style="color:#1a2b4a;font-size:28px;font-weight:900;font-family:'Arial Black',Arial,sans-serif;line-height:1;margin-bottom:0;">${totalJugadores} JUGADORES</div>
            <div style="color:#1a2b4a;font-size:12px;font-weight:700;font-family:Arial,sans-serif;text-transform:uppercase;margin-bottom:6px;">COMPITIENDO</div>
            <div style="color:#888;font-size:11px;font-family:Arial,sans-serif;">¿Podés meterte en el top 10?</div>
          </td>
          <!-- Columna derecha: cómo funciona (3 pasos en columna) -->
          <td width="62%" valign="top" style="padding-left:16px;">
            <div style="color:#1a2b4a;font-size:13px;font-weight:900;font-family:'Arial Black',Arial,sans-serif;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:14px;">¿CÓMO FUNCIONA?</div>
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <!-- Paso 1 -->
                <td width="33%" valign="top" align="center" style="padding-right:6px;">
                  <div style="width:28px;height:28px;background:#1a2b4a;border-radius:50%;text-align:center;line-height:28px;font-size:13px;color:#fff;font-weight:bold;font-family:Arial;margin:0 auto 6px;">1</div>
                  <div style="font-size:18px;margin-bottom:4px;">📋</div>
                  <div style="color:#1a2b4a;font-size:10px;font-weight:700;font-family:Arial,sans-serif;text-transform:uppercase;margin-bottom:3px;">APOSTÁ</div>
                  <div style="color:#666;font-size:10px;font-family:Arial,sans-serif;line-height:1.3;">Pronosticá los resultados de cada partido.</div>
                </td>
                <!-- Paso 2 -->
                <td width="33%" valign="top" align="center" style="padding:0 3px;">
                  <div style="width:28px;height:28px;background:#1a2b4a;border-radius:50%;text-align:center;line-height:28px;font-size:13px;color:#fff;font-weight:bold;font-family:Arial;margin:0 auto 6px;">2</div>
                  <div style="font-size:18px;margin-bottom:4px;">🎯</div>
                  <div style="color:#1a2b4a;font-size:10px;font-weight:700;font-family:Arial,sans-serif;text-transform:uppercase;margin-bottom:3px;">SUMÁ PUNTOS</div>
                  <div style="color:#666;font-size:10px;font-family:Arial,sans-serif;line-height:1.3;">Acertá resultados y sumá la mayor cantidad de puntos.</div>
                </td>
                <!-- Paso 3 -->
                <td width="33%" valign="top" align="center" style="padding-left:6px;">
                  <div style="width:28px;height:28px;background:#1a2b4a;border-radius:50%;text-align:center;line-height:28px;font-size:13px;color:#fff;font-weight:bold;font-family:Arial;margin:0 auto 6px;">3</div>
                  <div style="font-size:18px;margin-bottom:4px;">🏆</div>
                  <div style="color:#1a2b4a;font-size:10px;font-weight:700;font-family:Arial,sans-serif;text-transform:uppercase;margin-bottom:3px;">SUBÍ EN EL RANKING</div>
                  <div style="color:#666;font-size:10px;font-family:Arial,sans-serif;line-height:1.3;">Escalá posiciones y competí por increíbles premios.</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- ── BLOQUE 5b: MINI INSTRUCTIVO ── -->
  <tr>
    <td style="background:#F0F4FF;padding:24px 20px;border-top:2px solid #E0E8FF;">
      <div style="color:#1a2b4a;font-size:13px;font-weight:900;font-family:'Arial Black',Arial,sans-serif;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:14px;">📋 ¿CÓMO CARGAR TU PLANILLA?</div>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;">
        <tr>
          <td width="33%" valign="top" align="center" style="padding-right:6px;">
            <div style="width:32px;height:32px;background:#F47C00;border-radius:50%;text-align:center;line-height:32px;font-size:15px;color:#fff;font-weight:bold;font-family:Arial;margin:0 auto 6px;">1</div>
            <div style="color:#1a2b4a;font-size:10px;font-weight:700;font-family:Arial,sans-serif;text-transform:uppercase;margin-bottom:3px;">ENTRÁ A /APUESTAS</div>
            <div style="color:#555;font-size:10px;font-family:Arial,sans-serif;line-height:1.4;">Seleccioná el torneo desde el menú principal.</div>
          </td>
          <td width="33%" valign="top" align="center" style="padding:0 3px;">
            <div style="width:32px;height:32px;background:#F47C00;border-radius:50%;text-align:center;line-height:32px;font-size:15px;color:#fff;font-weight:bold;font-family:Arial;margin:0 auto 6px;">2</div>
            <div style="color:#1a2b4a;font-size:10px;font-weight:700;font-family:Arial,sans-serif;text-transform:uppercase;margin-bottom:3px;">INGRESÁ EL MARCADOR</div>
            <div style="color:#555;font-size:10px;font-family:Arial,sans-serif;line-height:1.4;">Escribí goles local y visitante para cada partido.</div>
          </td>
          <td width="33%" valign="top" align="center" style="padding-left:6px;">
            <div style="width:32px;height:32px;background:#F47C00;border-radius:50%;text-align:center;line-height:32px;font-size:15px;color:#fff;font-weight:bold;font-family:Arial;margin:0 auto 6px;">3</div>
            <div style="color:#1a2b4a;font-size:10px;font-weight:700;font-family:Arial,sans-serif;text-transform:uppercase;margin-bottom:3px;">¡GUARDÁ Y LISTO!</div>
            <div style="color:#555;font-size:10px;font-family:Arial,sans-serif;line-height:1.4;">Tus pronósticos quedan guardados automáticamente.</div>
          </td>
        </tr>
      </table>
      <div style="color:#1a2b4a;font-size:12px;font-weight:900;font-family:'Arial Black',Arial,sans-serif;text-transform:uppercase;margin-bottom:8px;">🎯 SISTEMA DE PUNTOS</div>
      <table width="100%" cellpadding="0" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#D1DBF0;border-radius:8px;overflow:hidden;margin-bottom:12px;">
        <tr style="background:#1a2b4a;">
          <th style="padding:8px 10px;font-size:11px;color:#fff;text-align:left;font-family:Arial,sans-serif;">RESULTADO</th>
          <th style="padding:8px 10px;font-size:11px;color:#FFB700;text-align:center;font-family:Arial,sans-serif;">PTS</th>
        </tr>
        <tr style="background:#fff;">
          <td style="padding:7px 10px;font-size:11px;color:#333;font-family:Arial,sans-serif;">Marcador exacto (ej: 2-1 = 2-1)</td>
          <td style="padding:7px 10px;font-size:13px;font-weight:bold;text-align:center;color:#27AE60;font-family:Arial,sans-serif;">4</td>
        </tr>
        <tr style="background:#F9FAFB;">
          <td style="padding:7px 10px;font-size:11px;color:#333;font-family:Arial,sans-serif;">Resultado correcto (ej: local gana)</td>
          <td style="padding:7px 10px;font-size:13px;font-weight:bold;text-align:center;color:#2980B9;font-family:Arial,sans-serif;">3</td>
        </tr>
        <tr style="background:#fff;">
          <td style="padding:7px 10px;font-size:11px;color:#333;font-family:Arial,sans-serif;">No acertaste nada</td>
          <td style="padding:7px 10px;font-size:13px;font-weight:bold;text-align:center;color:#999;font-family:Arial,sans-serif;">0</td>
        </tr>
      </table>
      <div style="background:#FFF3CD;border:1px solid #FFD879;border-radius:6px;padding:10px 12px;">
        <span style="color:#856404;font-size:11px;font-family:Arial,sans-serif;">⏰ <strong>¿Cuándo cierra?</strong> Las apuestas cierran 5 minutos antes del primer partido del torneo. ¡No te quedes sin cargar!</span>
      </div>
    </td>
  </tr>

  <!-- ── BLOQUE 6: CTA BUTTON (fondo blanco, botón naranja) ── -->
  <tr>
    <td style="background:#fff;padding:20px 20px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td align="center">
            <a href="https://hr.prodecaballito.com" style="display:block;background:#F47C00;color:#fff;text-decoration:none;padding:16px 20px;border-radius:8px;font-size:17px;font-weight:900;font-family:'Arial Black',Arial,sans-serif;text-transform:uppercase;letter-spacing:0.5px;text-align:center;">
              ⚽ &nbsp;EMPEZAR A JUGAR AHORA →
            </a>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- ── BLOQUE 7: FOOTER MOTIVACIONAL (fondo oscuro) ── -->
  <tr>
    <td style="background:#111;padding:24px 20px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td width="55%" valign="middle" style="padding-right:12px;">
            <div style="font-size:26px;margin-bottom:8px;">🏆</div>
            <div style="color:#fff;font-size:17px;font-weight:900;font-family:'Arial Black',Arial,sans-serif;text-transform:uppercase;line-height:1.15;margin-bottom:6px;">ESTA PUEDE SER<br>TU SEMANA.</div>
            <div style="color:rgba(255,255,255,0.55);font-size:12px;font-family:Arial,sans-serif;">Entrá ahora y arrancá fuerte.</div>
          </td>
          <td width="45%" valign="middle" align="center">
            <div style="color:#FFB700;font-size:28px;font-weight:900;font-family:Georgia,'Times New Roman',serif;font-style:italic;line-height:1.1;transform:rotate(-3deg);display:inline-block;">Vamos<br><span style="font-size:34px;">POR TODO!</span></div>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- ── BLOQUE 8: FOOTER LEGAL (blanco) ── -->
  <tr>
    <td style="background:#fff;padding:16px 20px;text-align:center;border-top:1px solid #eee;">
      <div style="color:#666;font-size:12px;font-family:Arial,sans-serif;margin-bottom:5px;">Con cariño, el equipo de <strong>PRODE High Rolling</strong> ❤️</div>
      <div style="color:#aaa;font-size:10px;font-family:Arial,sans-serif;">Si no querés recibir más correos, podés <a href="https://hr.prodecaballito.com" style="color:#aaa;text-decoration:underline;">darte de baja aquí</a>.</div>
    </td>
  </tr>

</table>
</td></tr>
</table>

</body>
</html>
  `;
    await (0, exports.sendEmail)({
        to: email,
        subject: `🔥 ¡${nombre}, el Mundial 2026 arranca — ya sos parte del PRODE!`,
        html,
    });
};
exports.sendWelcomeEmail = sendWelcomeEmail;
const sendVerificationCode = async (email, nombre, code) => {
    const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Código de Verificación - PRODE High Rolling</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f3f4f6;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background: linear-gradient(135deg, #0042A5 0%, #001A4B 100%); padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
      <h1 style="color: white; margin: 0; font-size: 28px;">⚽ PRODE High Rolling</h1>
      <p style="color: #FFDF00; margin: 10px 0 0 0; font-size: 14px;">⚡ Mundial 2026</p>
    </div>
    <div style="background: white; padding: 40px 30px; border-radius: 0 0 12px 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
      <h2 style="color: #1F2937; margin-top: 0;">¡Hola ${nombre}! 👋</h2>
      <p style="color: #4B5563; line-height: 1.6;">
        Gracias por registrarte en PRODE High Rolling. Para completar tu registro, 
        usa el siguiente código de verificación:
      </p>
      <div style="background: linear-gradient(135deg, #F3F4F6 0%, #E5E7EB 100%); padding: 30px; margin: 30px 0; text-align: center; border-radius: 12px; border: 3px dashed #0042A5;">
        <p style="color: #6B7280; margin: 0 0 10px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 2px;">
          Tu Código
        </p>
        <div style="font-size: 42px; font-weight: bold; color: #0042A5; letter-spacing: 12px; font-family: 'Courier New', monospace;">
          ${code}
        </div>
      </div>
      <div style="background: #FEF3C7; border-left: 4px solid #F59E0B; padding: 15px; margin: 20px 0; border-radius: 6px;">
        <p style="color: #92400E; margin: 0; font-size: 14px;">
          ⏱️ <strong>Este código expira en 15 minutos.</strong>
        </p>
      </div>
      <p style="color: #4B5563; line-height: 1.6; margin-top: 30px;">
        Si no solicitaste este código, puedes ignorar este email.
      </p>
    </div>
    <div style="text-align: center; padding: 20px; color: #9CA3AF; font-size: 12px;">
      <p style="margin: 5px 0;">© 2026 PRODE High Rolling - Qatar 2026</p>
      <p style="margin: 5px 0;">Este es un email automático, por favor no respondas.</p>
    </div>
  </div>
</body>
</html>
  `;
    await (0, exports.sendEmail)({
        to: email,
        subject: '🎯 Código de Verificación - PRODE High Rolling',
        html,
    });
};
exports.sendVerificationCode = sendVerificationCode;

const sendReminderEmail = async (reminder) => {
    const { user_email, user_nombre, home_team, away_team, start_time, time_cutoff, goles_local, goles_visitante, remind_minutes } = reminder;
    const hasBet = goles_local != null && goles_visitante != null;

    const fmtAR = (d) => new Date(d).toLocaleString('es-AR', {
        timeZone: 'America/Argentina/Buenos_Aires',
        weekday: 'long', day: 'numeric', month: 'long',
        hour: '2-digit', minute: '2-digit'
    });

    const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#001A4B;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#001A4B">
  <tr><td align="center" style="padding:40px 20px;">
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">

      <!-- Header -->
      <tr><td align="center" style="padding-bottom:24px;">
        <p style="margin:0;font-size:40px;line-height:1;">⏰</p>
        <h1 style="color:#ffffff;margin:10px 0 0;font-size:26px;font-weight:800;font-family:Arial,sans-serif;">PRODE High Rolling</h1>
        <p style="color:#FFDF00;margin:6px 0 0;font-size:14px;font-weight:600;font-family:Arial,sans-serif;">
          Recordatorio — ${remind_minutes} min antes del partido
        </p>
      </td></tr>

      <!-- Main card -->
      <tr><td style="background-color:#ffffff;border-radius:20px;overflow:hidden;">

        <!-- Yellow banner -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td bgcolor="#FFCC00" align="center" style="padding:32px 30px;border-radius:20px 20px 0 0;">
            <p style="margin:0 0 6px;color:#001A4B;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;font-family:Arial,sans-serif;">Próximo partido</p>
            <h2 style="color:#001A4B;margin:0;font-size:26px;font-weight:900;font-family:Arial,sans-serif;">${home_team} vs ${away_team}</h2>
            <p style="color:#0042A5;margin:10px 0 0;font-size:15px;font-weight:700;font-family:Arial,sans-serif;">🕐 ${fmtAR(start_time)} hs</p>
          </td></tr>
        </table>

        <!-- Body -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="padding:32px 30px;">

            <p style="color:#374151;font-size:16px;margin:0 0 16px;font-family:Arial,sans-serif;">
              ¡Hola <strong>${user_nombre}</strong>! 👋
            </p>
            <p style="color:#4B5563;font-size:15px;line-height:1.7;margin:0 0 24px;font-family:Arial,sans-serif;">
              El partido <strong>${home_team} vs ${away_team}</strong> comienza en
              <strong>${remind_minutes} minutos</strong>.
              Las apuestas cierran a las <strong>${fmtAR(time_cutoff)} hs</strong>.
            </p>

            ${hasBet ? `
            <!-- Tu pronóstico -->
            <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#EFF6FF" style="border-radius:14px;margin-bottom:24px;">
              <tr><td style="padding:20px 24px;border-left:4px solid #0042A5;border-radius:14px;">
                <p style="color:#0042A5;margin:0 0 8px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;font-family:Arial,sans-serif;">Tu pronóstico guardado</p>
                <p style="color:#001A4B;margin:0;font-size:30px;font-weight:900;text-align:center;font-family:Arial,sans-serif;">
                  ${home_team} <span style="color:#0042A5;">${goles_local} — ${goles_visitante}</span> ${away_team}
                </p>
              </td></tr>
            </table>
            ` : `
            <!-- Sin pronóstico -->
            <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FEF3C7" style="border-radius:14px;margin-bottom:24px;">
              <tr><td style="padding:20px 24px;border-left:4px solid #F59E0B;border-radius:14px;">
                <p style="color:#92400E;margin:0;font-size:15px;font-weight:700;font-family:Arial,sans-serif;">⚠️ Todavía no cargaste tu pronóstico para este partido.</p>
                <p style="color:#B45309;margin:8px 0 0;font-size:13px;font-family:Arial,sans-serif;">Tenés hasta las ${fmtAR(time_cutoff)} hs para apostar.</p>
              </td></tr>
            </table>
            `}

            <!-- CTA -->
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
              <tr><td align="center">
                <a href="https://hr.prodecaballito.com/apuestas"
                   style="display:inline-block;background-color:#0042A5;color:#ffffff;text-decoration:none;padding:16px 40px;border-radius:50px;font-size:17px;font-weight:700;font-family:Arial,sans-serif;">
                  ⚽ Ver mis pronósticos
                </a>
              </td></tr>
            </table>

            <p style="color:#9CA3AF;font-size:12px;text-align:center;margin:0;font-family:Arial,sans-serif;">
              Con cariño, el equipo de <strong>PRODE High Rolling</strong> 💙
            </p>
          </td></tr>
        </table>
      </td></tr>

      <!-- Footer -->
      <tr><td align="center" style="padding-top:20px;">
        <p style="color:rgba(255,255,255,0.5);font-size:12px;margin:0;font-family:Arial,sans-serif;">
          © 2026 PRODE High Rolling · <a href="https://hr.prodecaballito.com" style="color:rgba(255,255,255,0.6);text-decoration:none;">hr.prodecaballito.com</a>
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;

    await (0, exports.sendEmail)({
        to: user_email,
        subject: `⏰ En ${remind_minutes} min: ${home_team} vs ${away_team} — PRODE High Rolling`,
        html,
    });
};
exports.sendReminderEmail = sendReminderEmail;

const sendResultEmail = async ({ userEmail, userName, homeTeam, awayTeam, resultLocal, resultVisitante, betLocal, betVisitante, puntos, rankingPos }) => {
    const fmtAR = (d) => new Date(d).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'long', day: 'numeric', month: 'long' });
    const hasBet = betLocal != null && betVisitante != null;
    const colorMap = { 4: '#1D4ED8', 3: '#DC2626', 2: '#16A34A', 1: '#D97706', 0: '#6B7280' };
    const labelMap = { 4: '¡Exacto + bonus! 🔥', 3: 'Exacto 🎯', 2: 'Parcialmente exacto ✅', 1: 'Ganador correcto 👍', 0: 'Sin puntos ❌' };
    const ptsColor = colorMap[puntos] || '#6B7280';
    const ptsLabel = labelMap[puntos] || '';

    const betPanel = hasBet ? `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0;">
        <tr><td style="background:#EFF6FF;border-radius:10px;padding:16px;text-align:center;">
          <p style="margin:0 0 6px;font-size:13px;color:#1E40AF;font-family:Arial,sans-serif;">Tu pronóstico</p>
          <p style="margin:0;font-size:28px;font-weight:900;color:${ptsColor};font-family:Arial,sans-serif;">${betLocal} — ${betVisitante}</p>
          <p style="margin:6px 0 0;font-size:14px;font-weight:bold;color:${ptsColor};font-family:Arial,sans-serif;">${ptsLabel} &nbsp;·&nbsp; +${puntos} pts</p>
        </td></tr>
      </table>` : `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0;">
        <tr><td style="background:#FEF3C7;border-radius:10px;padding:16px;text-align:center;">
          <p style="margin:0;font-size:14px;color:#92400E;font-family:Arial,sans-serif;">No tenías pronóstico en este partido</p>
        </td></tr>
      </table>`;

    const rankingPanel = rankingPos ? `
      <p style="text-align:center;font-size:14px;color:#374151;font-family:Arial,sans-serif;margin:0 0 20px;">
        🏆 Estás <strong>#${rankingPos}</strong> en el ranking
      </p>` : '';

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background-color:#F1F5F9;">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td align="center" style="padding:32px 16px;">
    <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">
      <!-- Header -->
      <tr><td style="background-color:#001A4B;padding:28px 32px;text-align:center;">
        <p style="margin:0;font-size:24px;font-weight:900;color:#FFFFFF;font-family:Arial,sans-serif;letter-spacing:1px;">⚽ PRODE High Rolling</p>
        <p style="margin:6px 0 0;font-size:13px;color:#93C5FD;font-family:Arial,sans-serif;">Resultado publicado</p>
      </td></tr>
      <!-- Score banner -->
      <tr><td style="background-color:#FFCC00;padding:20px 32px;text-align:center;">
        <p style="margin:0;font-size:13px;font-weight:bold;color:#78350F;font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:1px;">${homeTeam} vs ${awayTeam}</p>
        <p style="margin:8px 0 0;font-size:48px;font-weight:900;color:#001A4B;font-family:Arial,sans-serif;letter-spacing:4px;">${resultLocal} — ${resultVisitante}</p>
      </td></tr>
      <!-- Body -->
      <tr><td style="background-color:#FFFFFF;padding:28px 32px;">
        <p style="margin:0 0 4px;font-size:16px;font-weight:bold;color:#001A4B;font-family:Arial,sans-serif;">Hola, ${userName}!</p>
        <p style="margin:0 0 16px;font-size:14px;color:#6B7280;font-family:Arial,sans-serif;">Ya podés ver cuántos puntos sumaste en este partido.</p>
        ${betPanel}
        ${rankingPanel}
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td align="center">
            <a href="https://hr.prodecaballito.com/ranking" style="display:inline-block;background-color:#0042A5;color:#FFFFFF;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;padding:14px 32px;border-radius:50px;">Ver ranking completo →</a>
          </td></tr>
        </table>
      </td></tr>
      <!-- Footer -->
      <tr><td style="background-color:#F8FAFC;padding:16px 32px;text-align:center;">
        <p style="margin:0;font-size:11px;color:#9CA3AF;font-family:Arial,sans-serif;">hr.prodecaballito.com</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

    await sendEmail({
        to: userEmail,
        subject: `⚽ Resultado: ${homeTeam} ${resultLocal}-${resultVisitante} ${awayTeam} — PRODE High Rolling`,
        html,
    });
};
exports.sendResultEmail = sendResultEmail;

const sendNewLeaderEmail = async ({ userEmail, userName, puntos, homeTeam, awayTeam, resultLocal, resultVisitante }) => {
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background-color:#F1F5F9;">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td align="center" style="padding:32px 16px;">
    <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">
      <!-- Header -->
      <tr><td style="background-color:#001A4B;padding:32px 32px 24px;text-align:center;">
        <p style="margin:0;font-size:48px;line-height:1;">🔥</p>
        <p style="margin:10px 0 4px;font-size:22px;font-weight:900;color:#FFCC00;font-family:Arial,sans-serif;letter-spacing:1px;">¡NUEVO LÍDER!</p>
        <p style="margin:0;font-size:13px;color:#93C5FD;font-family:Arial,sans-serif;">PRODE High Rolling</p>
      </td></tr>
      <!-- Banner resultado -->
      <tr><td style="background-color:#FFCC00;padding:14px 32px;text-align:center;">
        <p style="margin:0;font-size:12px;font-weight:bold;color:#78350F;font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:1px;">⚽ ${homeTeam} ${resultLocal}–${resultVisitante} ${awayTeam}</p>
      </td></tr>
      <!-- Body -->
      <tr><td style="background-color:#FFFFFF;padding:32px 32px 28px;">
        <p style="margin:0 0 8px;font-size:18px;font-weight:900;color:#001A4B;font-family:Arial,sans-serif;">¡Hola, ${userName}! 👋</p>
        <p style="margin:0 0 24px;font-size:15px;color:#374151;font-family:Arial,sans-serif;line-height:1.6;">
          Después del resultado de hoy, <strong>subiste al primer puesto</strong> del ranking de PRODE High Rolling. ¡Bien jugado!
        </p>
        <!-- Podio card -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">
          <tr><td style="background:linear-gradient(135deg,#001A4B 0%,#0042A5 100%);border-radius:14px;padding:24px;text-align:center;">
            <p style="margin:0 0 4px;font-size:13px;color:#93C5FD;font-family:Arial,sans-serif;letter-spacing:2px;text-transform:uppercase;">Posición actual</p>
            <p style="margin:0;font-size:56px;font-weight:900;color:#FFCC00;font-family:Arial,sans-serif;line-height:1;">🥇</p>
            <p style="margin:6px 0 0;font-size:20px;font-weight:900;color:#FFFFFF;font-family:Arial,sans-serif;">${puntos} puntos</p>
            <p style="margin:4px 0 0;font-size:13px;color:#93C5FD;font-family:Arial,sans-serif;">Puesto #1 del ranking</p>
          </td></tr>
        </table>
        <p style="margin:0 0 24px;font-size:14px;color:#6B7280;font-family:Arial,sans-serif;text-align:center;line-height:1.5;">
          Seguí apostando para mantener el liderazgo.<br>Los demás están cerca 👀
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td align="center">
            <a href="https://hr.prodecaballito.com/ranking" style="display:inline-block;background-color:#0042A5;color:#FFFFFF;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;padding:14px 36px;border-radius:50px;">Ver el ranking completo →</a>
          </td></tr>
        </table>
      </td></tr>
      <!-- Footer -->
      <tr><td style="background-color:#F8FAFC;padding:16px 32px;text-align:center;">
        <p style="margin:0;font-size:11px;color:#9CA3AF;font-family:Arial,sans-serif;">hr.prodecaballito.com</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

    await sendEmail({
        to: userEmail,
        subject: `🔥 ¡Sos el nuevo líder del PRODE High Rolling con ${puntos} pts!`,
        html,
    });
};
exports.sendNewLeaderEmail = sendNewLeaderEmail;

// ── Weekly summary email ─────────────────────────────────────────────────────

const TEAM_FLAGS = {
    'argentina': '🇦🇷', 'brasil': '🇧🇷', 'brazil': '🇧🇷',
    'france': '🇫🇷', 'francia': '🇫🇷',
    'spain': '🇪🇸', 'españa': '🇪🇸',
    'germany': '🇩🇪', 'alemania': '🇩🇪',
    'england': '🏴󠁧󠁢󠁥󠁮󠁧󠁿', 'inglaterra': '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
    'italy': '🇮🇹', 'italia': '🇮🇹',
    'portugal': '🇵🇹',
    'netherlands': '🇳🇱', 'holanda': '🇳🇱', 'países bajos': '🇳🇱',
    'croatia': '🇭🇷', 'croacia': '🇭🇷',
    'morocco': '🇲🇦', 'marruecos': '🇲🇦',
    'usa': '🇺🇸', 'estados unidos': '🇺🇸', 'united states': '🇺🇸',
    'canada': '🇨🇦', 'canadá': '🇨🇦',
    'mexico': '🇲🇽', 'méxico': '🇲🇽',
    'japan': '🇯🇵', 'japón': '🇯🇵',
    'south korea': '🇰🇷', 'corea del sur': '🇰🇷', 'corea': '🇰🇷',
    'senegal': '🇸🇳', 'ecuador': '🇪🇨', 'uruguay': '🇺🇾',
    'colombia': '🇨🇴', 'chile': '🇨🇱', 'peru': '🇵🇪', 'perú': '🇵🇪',
    'bolivia': '🇧🇴', 'venezuela': '🇻🇪', 'paraguay': '🇵🇾',
    'switzerland': '🇨🇭', 'suiza': '🇨🇭',
    'belgium': '🇧🇪', 'bélgica': '🇧🇪',
    'poland': '🇵🇱', 'polonia': '🇵🇱',
    'denmark': '🇩🇰', 'dinamarca': '🇩🇰',
    'austria': '🇦🇹', 'sweden': '🇸🇪', 'suecia': '🇸🇪',
    'norway': '🇳🇴', 'noruega': '🇳🇴',
    'jordan': '🇯🇴', 'jordania': '🇯🇴',
    'nigeria': '🇳🇬', 'ghana': '🇬🇭', 'cameroon': '🇨🇲', 'camerún': '🇨🇲',
    'saudi arabia': '🇸🇦', 'arabia saudita': '🇸🇦',
    'iran': '🇮🇷', 'australia': '🇦🇺', 'new zealand': '🇳🇿',
    'turkey': '🇹🇷', 'turquía': '🇹🇷',
    'serbia': '🇷🇸', 'ukraine': '🇺🇦', 'ucrania': '🇺🇦',
    'czech republic': '🇨🇿', 'república checa': '🇨🇿',
    'romania': '🇷🇴', 'rumania': '🇷🇴',
    'hungary': '🇭🇺', 'hungría': '🇭🇺',
    'scotland': '🏴󠁧󠁢󠁳󠁣󠁴󠁿', 'escocia': '🏴󠁧󠁢󠁳󠁣󠁴󠁿',
    'wales': '🏴󠁧󠁢󠁷󠁬󠁳󠁿', 'gales': '🏴󠁧󠁢󠁷󠁬󠁳󠁿',
};

function getTeamFlag(team) {
    if (!team) return '⚽';
    return TEAM_FLAGS[team.toLowerCase().trim()] || '⚽';
}

function buildTightMatchSection(tightMatch) {
    if (!tightMatch || tightMatch.resultado_local == null) return '';
    const homeFlag = getTeamFlag(tightMatch.home_team);
    const awayFlag = getTeamFlag(tightMatch.away_team);
    const hits = parseInt(tightMatch.exact_hits) || 0;
    const hitsText = hits === 0
        ? '¡Nadie acertó el resultado exacto!'
        : hits === 1
            ? 'Solo 1 jugador acertó el resultado exacto'
            : `Solo ${hits} jugadores acertaron el resultado exacto`;

    return `
      <tr>
        <td style="padding:0 24px 24px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
            <tr>
              <td style="padding:12px 18px;border-bottom:1px solid #f3f4f6;">
                <p style="margin:0;font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:1px;font-family:Arial,sans-serif;">🔥 Partido más reñido de la semana</p>
              </td>
            </tr>
            <tr>
              <td bgcolor="#ffffff" style="padding:24px 16px;">
                <table width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td width="27%" align="center">
                      <p style="margin:0;font-size:36px;line-height:1;">${homeFlag}</p>
                      <p style="margin:6px 0 0;font-size:12px;font-weight:700;color:#374151;font-family:Arial,sans-serif;">${tightMatch.home_team}</p>
                    </td>
                    <td width="22%" align="center">
                      <p style="margin:0;font-size:40px;font-weight:900;color:#001A4B;font-family:Arial,sans-serif;letter-spacing:2px;line-height:1;">${tightMatch.resultado_local} - ${tightMatch.resultado_visitante}</p>
                    </td>
                    <td width="27%" align="center">
                      <p style="margin:0;font-size:36px;line-height:1;">${awayFlag}</p>
                      <p style="margin:6px 0 0;font-size:12px;font-weight:700;color:#374151;font-family:Arial,sans-serif;">${tightMatch.away_team}</p>
                    </td>
                    <td width="24%" style="padding-left:12px;border-left:1px solid #e5e7eb;vertical-align:middle;">
                      <p style="margin:0;font-size:12px;font-weight:700;color:#2563eb;font-family:Arial,sans-serif;line-height:1.4;">${hitsText}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>`;
}

function buildUpcomingSection(upcomingMatches, appUrl) {
    if (!upcomingMatches || upcomingMatches.length === 0) return '';
    const cards = upcomingMatches.map((m, i) => {
        const homeFlag = getTeamFlag(m.home_team);
        const awayFlag = getTeamFlag(m.away_team);
        const d = new Date(m.start_time);
        const dateStr = d.toLocaleDateString('es-AR', {
            timeZone: 'America/Argentina/Buenos_Aires',
            weekday: 'short', day: 'numeric', month: 'numeric',
        });
        const timeStr = d.toLocaleTimeString('es-AR', {
            timeZone: 'America/Argentina/Buenos_Aires',
            hour: '2-digit', minute: '2-digit',
        });
        const badgeHtml = m.badge ? `
              <tr>
                <td bgcolor="#FEF3C7" style="padding:5px 16px;">
                  <p style="margin:0;font-size:11px;font-weight:700;color:#92400E;font-family:Arial,sans-serif;">${m.badge}</p>
                </td>
              </tr>` : '';
        const bottomPad = i < upcomingMatches.length - 1 ? 'padding:0 0 10px;' : 'padding:0;';
        return `
        <tr>
          <td style="${bottomPad}">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
              ${badgeHtml}
              <tr>
                <td bgcolor="#FFF8F0" style="padding:16px 16px;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="font-size:22px;line-height:1;width:28px;">${homeFlag}</td>
                      <td style="padding:0 10px;font-family:Arial,sans-serif;">
                        <p style="margin:0;font-size:13px;font-weight:700;color:#111827;">${m.home_team} vs ${m.away_team}</p>
                        <p style="margin:3px 0 0;font-size:11px;color:#6b7280;">${dateStr} &middot; ${timeStr} hs</p>
                      </td>
                      <td align="right" style="width:90px;">
                        <a href="${appUrl}" style="display:inline-block;background-color:#FFCC00;color:#001A4B;font-size:13px;font-weight:900;text-decoration:none;padding:10px 16px;border-radius:20px;font-family:Arial,sans-serif;white-space:nowrap;">Apostar →</a>
                      </td>
                      <td style="font-size:22px;line-height:1;width:28px;text-align:right;padding-left:8px;">${awayFlag}</td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>`;
    }).join('');

    return `
      <tr>
        <td style="padding:0 24px 24px;">
          <p style="margin:0 0 12px;font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:1px;font-family:Arial,sans-serif;">⚽ Próximos partidos para pronosticar</p>
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            ${cards}
          </table>
        </td>
      </tr>`;
}

const sendWeeklyEmail = async (email, {
    userName, weekDate, userPosition, totalPlayers,
    userPoints, bestRound, bestRoundPoints,
    diferenciaPuntos = 0, pendingBets = 0,
    tightMatch, upcomingMatches, appUrl, unsubscribeUrl,
}) => {
    const tightMatchHtml = buildTightMatchSection(tightMatch);
    const upcomingHtml = buildUpcomingSection(upcomingMatches, appUrl);

    // Determinar segmento para subject dinámico
    let emailSubject = `⚽ Tu resumen semanal — PRODE High Rolling`;
    if (userPosition === 1) {
      emailSubject = `👑 Seguís primero, ${userName}. Esta semana podés agrandar la ventaja.`;
    } else if (userPosition <= 3) {
      emailSubject = `🏆 Estás en el podio, ${userName}. Esta semana mantené la posición.`;
    } else if (userPosition <= 10) {
      emailSubject = `📈 En la zona caliente, ${userName}. Esta semana podés hacer más.`;
    } else {
      emailSubject = `⚽ Esta semana tu prode puede cambiar todo, ${userName}.`;
    }

    const pendingBadge = pendingBets > 0
        ? `<table cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;">
            <tr>
              <td bgcolor="#FFCC00" style="padding:9px 18px;border-radius:20px;">
                <p style="margin:0;font-size:13px;font-weight:700;color:#001A4B;font-family:Arial,sans-serif;">⚡ Tenés ${pendingBets} pronóstico${pendingBets !== 1 ? 's' : ''} pendiente${pendingBets !== 1 ? 's' : ''} para esta fecha</p>
              </td>
            </tr>
          </table>`
        : '';

    const diferencia = userPosition <= 5
        ? `<p style="margin:3px 0 0;font-size:14px;color:#059669;font-family:Arial,sans-serif;font-weight:700;">🏆 ¡Estás en el top 5!</p>`
        : `<p style="margin:3px 0 0;font-size:14px;color:#6b7280;font-family:Arial,sans-serif;">Estás a <strong style="color:#DC2626;">${diferenciaPuntos} pts</strong> del top 5.</p>`;

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tu resumen semanal — PRODE High Rolling</title>
</head>
<body style="margin:0;padding:0;background-color:#eef2f7;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#eef2f7">
  <tr>
    <td align="center" style="padding:24px 16px;">
      <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:16px;overflow:hidden;">

        <!-- HEADER -->
        <tr>
          <td bgcolor="#ffffff" style="padding:18px 24px;border-bottom:1px solid #f0f4fb;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td>
                  <span style="font-size:22px;vertical-align:middle;">⚽</span>
                  <strong style="font-size:17px;color:#001A4B;font-family:Arial,sans-serif;vertical-align:middle;"> PRODE High Rolling</strong>
                </td>
                <td align="right">
                  <p style="margin:0;font-size:11px;color:#9ca3af;font-family:Arial,sans-serif;">Resumen semanal</p>
                  <p style="margin:2px 0 0;font-size:12px;color:#374151;font-weight:700;font-family:Arial,sans-serif;">${weekDate}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- HERO: background-image con gradiente oscuro overlay -->
        <tr>
          <td bgcolor="#001A4B" style="background:linear-gradient(to bottom,rgba(0,10,50,0.42) 0%,rgba(0,10,70,0.90) 100%),url('https://images.unsplash.com/photo-1574629810360-7efbbe195018?w=600&q=90&fit=crop&h=360') center/cover no-repeat;padding:72px 28px 42px;">
            <p style="margin:0 0 10px;font-size:11px;font-weight:700;color:#FFCC00;font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:2.5px;">MUNDIAL 2026</p>
            <h1 style="margin:0;font-size:34px;font-weight:900;color:#ffffff;font-family:Arial,sans-serif;line-height:1.1;text-transform:uppercase;">ARRANCA UNA NUEVA SEMANA</h1>
            <h1 style="margin:4px 0 18px;font-size:34px;font-weight:900;color:#FFCC00;font-family:Arial,sans-serif;line-height:1.1;text-transform:uppercase;">DE MUNDIAL</h1>
            <p style="margin:0;font-size:14px;color:rgba(255,255,255,0.82);font-family:Arial,sans-serif;">Así viene tu prode y lo que se juega esta semana.</p>
            ${pendingBadge}
          </td>
        </tr>

        <!-- PERSONALIZATION -->
        <tr>
          <td style="padding:22px 24px 0;">
            <p style="margin:0 0 2px;font-size:16px;color:#111827;font-family:Arial,sans-serif;font-weight:600;">Hola, <strong style="color:#001A4B;">${userName}</strong> 👋</p>
            <p style="margin:0 0 2px;font-size:14px;color:#6b7280;font-family:Arial,sans-serif;">Estás <strong style="color:#001A4B;">${userPosition}°</strong> de ${totalPlayers} jugadores.</p>
            ${diferencia}
          </td>
        </tr>

        <!-- STATS: 3 cards -->
        <tr>
          <td style="padding:18px 24px 24px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td width="31%" align="center" bgcolor="#f8faff" style="padding:22px 8px;border-radius:12px;">
                  <p style="margin:0;font-size:28px;line-height:1;">🏆</p>
                  <p style="margin:10px 0 2px;font-size:36px;font-weight:900;color:#001A4B;font-family:Arial,sans-serif;line-height:1;">${userPosition}°</p>
                  <p style="margin:0;font-size:10px;color:#6b7280;font-family:Arial,sans-serif;line-height:1.5;text-transform:uppercase;letter-spacing:0.3px;">Tu posición<br>de ${totalPlayers}</p>
                </td>
                <td width="4%"></td>
                <td width="31%" align="center" bgcolor="#f8faff" style="padding:22px 8px;border-radius:12px;">
                  <p style="margin:0;font-size:28px;line-height:1;">🎯</p>
                  <p style="margin:10px 0 2px;font-size:36px;font-weight:900;color:#001A4B;font-family:Arial,sans-serif;line-height:1;">${userPoints} <span style="font-size:18px;font-weight:700;">pts</span></p>
                  <p style="margin:0;font-size:10px;color:#6b7280;font-family:Arial,sans-serif;line-height:1.5;text-transform:uppercase;letter-spacing:0.3px;">Tus puntos</p>
                </td>
                <td width="4%"></td>
                <td width="31%" align="center" bgcolor="#f8faff" style="padding:22px 8px;border-radius:12px;">
                  <p style="margin:0;font-size:28px;line-height:1;">📅</p>
                  <p style="margin:10px 0 2px;font-size:22px;font-weight:900;color:#001A4B;font-family:Arial,sans-serif;line-height:1;">${bestRound}</p>
                  <p style="margin:0;font-size:10px;color:#6b7280;font-family:Arial,sans-serif;line-height:1.5;text-transform:uppercase;letter-spacing:0.3px;">Tu mejor fecha<br>(${bestRoundPoints} pts)</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        ${tightMatchHtml}

        ${upcomingHtml}

        <!-- CTA PRINCIPAL -->
        <tr>
          <td style="padding:4px 24px 32px;">
            <a href="${appUrl}" style="display:block;background-color:#001A4B;color:#ffffff;text-decoration:none;padding:18px 32px;border-radius:10px;font-size:16px;font-weight:700;font-family:Arial,sans-serif;text-align:center;">
              Completá tus pronósticos ahora →
            </a>
          </td>
        </tr>

        <!-- FOOTER -->
        <tr>
          <td align="center" bgcolor="#f9fafb" style="padding:22px 24px 26px;border-top:1px solid #f0f4fb;">
            <p style="margin:0;font-size:13px;color:#4b5563;font-family:Arial,sans-serif;line-height:1.7;">
              Gracias por jugar en <strong>PRODE High Rolling</strong> 💙<br>Esta semana puede ser la tuya.
            </p>
            <p style="margin:14px 0 0;font-size:11px;color:#9ca3af;font-family:Arial,sans-serif;">
              <a href="${unsubscribeUrl}" style="color:#9ca3af;text-decoration:underline;">Cancelar suscripción</a>
              &nbsp;&middot;&nbsp;
              <a href="https://hr.prodecaballito.com" style="color:#9ca3af;text-decoration:none;">hr.prodecaballito.com</a>
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

    await (0, exports.sendEmail)({
        to: email,
        subject: emailSubject,
        html,
    });
};
exports.sendWeeklyEmail = sendWeeklyEmail;

// ── Post-matchday summary email ──────────────────────────────────────────────

const sendPostMatchdayEmail = async ({ userEmail, userName, matchdayName, points, rankInMatchday, globalPosition, topName, topPoints, totalPlanillas }) => {
    const isWinner = rankInMatchday === 1;
    const isPodio = rankInMatchday >= 2 && rankInMatchday <= 3;
    const posEmoji = rankInMatchday === 1 ? '🥇' : rankInMatchday === 2 ? '🥈' : rankInMatchday === 3 ? '🥉' : `#${rankInMatchday}`;

    let headerEmoji = '🏁';
    let headerTitle = `${matchdayName} — CERRADA`;
    let titlePrefix = `🏁 ${matchdayName} cerrada`;
    let introText = `Así quedaron tus resultados en <strong>${matchdayName}</strong>:`;
    let bodyColor = '#FFFFFF';

    if (isWinner) {
      headerEmoji = '👑';
      headerTitle = `¡GANASTE ${matchdayName.toUpperCase()}!`;
      titlePrefix = `👑 ¡Ganaste ${matchdayName}!`;
      introText = `<strong>${points} puntos</strong> — el crack de la fecha. El PRODE habla de vos.`;
      bodyColor = '#FFFBEB';
    } else if (isPodio) {
      headerEmoji = '🏆';
      headerTitle = `TOP 3 EN ${matchdayName.toUpperCase()}`;
      titlePrefix = `🏆 Terminaste #${rankInMatchday} en ${matchdayName}`;
      introText = `<strong>${points} puntos</strong> te pusieron #${rankInMatchday}. El ganador hizo ${topPoints} pts.`;
      bodyColor = '#F0FDF4';
    }

    const globalStr = globalPosition != null ? `Estás #${globalPosition} en el ranking general.` : '';
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background-color:#F1F5F9;">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td align="center" style="padding:32px 16px;">
    <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">
      <!-- Header -->
      <tr><td style="background-color:#001A4B;padding:32px 32px 24px;text-align:center;">
        <p style="margin:0;font-size:40px;line-height:1;">${headerEmoji}</p>
        <p style="margin:10px 0 4px;font-size:20px;font-weight:900;color:#FFCC00;font-family:Arial,sans-serif;letter-spacing:1px;">${headerTitle}</p>
        <p style="margin:0;font-size:13px;color:#93C5FD;font-family:Arial,sans-serif;">PRODE High Rolling</p>
      </td></tr>
      <!-- Body -->
      <tr><td style="background-color:${bodyColor};padding:32px 32px 28px;">
        <p style="margin:0 0 8px;font-size:18px;font-weight:900;color:#001A4B;font-family:Arial,sans-serif;">¡Hola, ${userName}! 👋</p>
        <p style="margin:0 0 24px;font-size:15px;color:#374151;font-family:Arial,sans-serif;line-height:1.6;">
          ${introText}
        </p>
        <!-- Score card -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
          <tr>
            <td width="50%" style="padding:4px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#EFF6FF;border-radius:12px;padding:16px;text-align:center;">
                <tr><td>
                  <p style="margin:0;font-size:11px;color:#3B82F6;font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:1px;font-weight:bold;">Tus puntos</p>
                  <p style="margin:4px 0 0;font-size:36px;font-weight:900;color:#1D4ED8;font-family:Arial,sans-serif;">${points}</p>
                </td></tr>
              </table>
            </td>
            <td width="50%" style="padding:4px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F0FDF4;border-radius:12px;padding:16px;text-align:center;">
                <tr><td>
                  <p style="margin:0;font-size:11px;color:#16A34A;font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:1px;font-weight:bold;">Tu posición en la fecha</p>
                  <p style="margin:4px 0 0;font-size:36px;font-weight:900;color:#15803D;font-family:Arial,sans-serif;">${posEmoji}</p>
                </td></tr>
              </table>
            </td>
          </tr>
        </table>
        ${globalStr ? `<p style="margin:0 0 12px;font-size:14px;color:#6B7280;font-family:Arial,sans-serif;text-align:center;">${globalStr}</p>` : ''}
        <!-- Top performer -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0 24px;background:#FFF7ED;border-radius:12px;padding:16px;">
          <tr><td style="text-align:center;">
            <p style="margin:0;font-size:12px;color:#EA580C;font-family:Arial,sans-serif;font-weight:bold;text-transform:uppercase;letter-spacing:1px;">Top de la fecha</p>
            <p style="margin:6px 0 0;font-size:16px;font-weight:900;color:#9A3412;font-family:Arial,sans-serif;">🏆 ${topName} — ${topPoints} pts</p>
          </td></tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td align="center">
            <a href="https://hr.prodecaballito.com/ranking" style="display:inline-block;background-color:#0042A5;color:#FFFFFF;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;padding:14px 36px;border-radius:50px;">Ver el ranking completo →</a>
          </td></tr>
        </table>
      </td></tr>
      <!-- Footer -->
      <tr><td style="background-color:#F8FAFC;padding:16px 32px;text-align:center;">
        <p style="margin:0;font-size:11px;color:#9CA3AF;font-family:Arial,sans-serif;">hr.prodecaballito.com</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

    const subject = isWinner
      ? `👑 ${userName}, ganaste ${matchdayName} con ${points} pts`
      : isPodio
        ? `🏆 Terminaste #${rankInMatchday} en ${matchdayName} — ${points} pts`
        : `🏁 ${matchdayName} cerrada — ${points} pts | #${rankInMatchday} de ${totalPlanillas}`;

    await sendEmail({
        to: userEmail,
        subject,
        html,
    });
};
exports.sendPostMatchdayEmail = sendPostMatchdayEmail;

const sendPlanillaCierreEmail = async ({ userEmail, userName, planillaNombre, torneoName, matches }) => {
    const totalMatches = matches.length;
    const completedBets = matches.filter(m => m.goles_local != null && m.goles_visitante != null).length;
    const isComplete = completedBets === totalMatches;

    const subject = isComplete
        ? `✅ Tu planilla "${planillaNombre}" está lista para ${torneoName}`
        : `⚠️ Tu planilla "${planillaNombre}" cerró con ${totalMatches - completedBets} pronóstico${totalMatches - completedBets === 1 ? '' : 's'} sin cargar`;

    const rows = matches.map(m => {
        const bet = m.goles_local != null && m.goles_visitante != null
            ? `${m.goles_local}-${m.goles_visitante}`
            : '—';
        return `<tr style="border-bottom:1px solid #E5E7EB;">
          <td style="padding:10px 12px;font-size:13px;color:#111827;font-family:Arial,sans-serif;">${m.home_team} vs ${m.away_team}</td>
          <td style="padding:10px 12px;font-size:13px;text-align:center;font-weight:bold;color:${bet === '—' ? '#9CA3AF' : '#001A4B'};font-family:Arial,sans-serif;">${bet}</td>
        </tr>`;
    }).join('');

    const headerColor = isComplete ? '#166534' : '#92400E';
    const headerBg = isComplete ? '#DCFCE7' : '#FEF3C7';
    const headerEmoji = isComplete ? '✅' : '⚠️';
    const headerLabel = isComplete ? 'PLANILLA CONFIRMADA' : 'PLANILLA CON PRONÓSTICOS FALTANTES';

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background-color:#F1F5F9;">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td align="center" style="padding:32px 16px;">
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">
      <tr><td style="background-color:#001A4B;padding:28px 32px 20px;text-align:center;">
        <p style="margin:0;font-size:22px;font-weight:900;color:#FFFFFF;font-family:Arial,sans-serif;">⚽ PRODE High Rolling</p>
        <p style="margin:6px 0 0;font-size:13px;color:#93C5FD;font-family:Arial,sans-serif;">${torneoName}</p>
      </td></tr>
      <tr><td style="background-color:${headerBg};padding:16px 32px;text-align:center;">
        <p style="margin:0;font-size:15px;font-weight:900;color:${headerColor};font-family:Arial,sans-serif;">${headerEmoji} ${headerLabel}</p>
        <p style="margin:4px 0 0;font-size:13px;color:${headerColor};font-family:Arial,sans-serif;">Cargaste ${completedBets} de ${totalMatches} pronósticos</p>
      </td></tr>
      <tr><td style="background-color:#FFFFFF;padding:28px 32px;">
        <p style="margin:0 0 16px;font-size:16px;font-weight:900;color:#001A4B;font-family:Arial,sans-serif;">Hola ${userName} 👋</p>
        <p style="margin:0 0 20px;font-size:14px;color:#374151;font-family:Arial,sans-serif;line-height:1.6;">
          ${isComplete
            ? `Tu planilla <strong>"${planillaNombre}"</strong> está lista. Este es tu resumen de pronósticos para ${torneoName}.`
            : `El torneo cerró. Te dejamos el resumen de tu planilla <strong>"${planillaNombre}"</strong>. Los pronósticos con <strong>—</strong> no estaban cargados al cierre.`}
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#E5E7EB;border-radius:8px;overflow:hidden;">
          <tr style="background-color:#F9FAFB;">
            <th style="padding:10px 12px;font-size:12px;font-weight:bold;color:#6B7280;text-align:left;font-family:Arial,sans-serif;">PARTIDO</th>
            <th style="padding:10px 12px;font-size:12px;font-weight:bold;color:#6B7280;text-align:center;font-family:Arial,sans-serif;">TU PRONÓSTICO</th>
          </tr>
          ${rows}
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">
          <tr><td align="center">
            <a href="https://hr.prodecaballito.com/planillas" style="display:inline-block;background-color:#001A4B;color:#FFFFFF;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;padding:14px 36px;border-radius:50px;">Ver mi planilla →</a>
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="background-color:#F8FAFC;padding:16px 32px;text-align:center;">
        <p style="margin:0;font-size:11px;color:#9CA3AF;font-family:Arial,sans-serif;">hr.prodecaballito.com · Este es tu resumen de planilla al cierre del torneo</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

    await sendEmail({ to: userEmail, subject, html });
};
exports.sendPlanillaCierreEmail = sendPlanillaCierreEmail;

const sendBetConfirmationEmail = async ({ userEmail, userName, planillaNombre, torneoName, matches }) => {
    const subject = `✅ Pronósticos guardados — ${planillaNombre}`;
    const rows = matches.map(m => {
        const bet = m.goles_local != null && m.goles_visitante != null
            ? `${m.goles_local}-${m.goles_visitante}`
            : '—';
        return `<tr style="border-bottom:1px solid #E5E7EB;">
          <td style="padding:10px 12px;font-size:13px;color:#111827;font-family:Arial,sans-serif;">${m.home_team} vs ${m.away_team}</td>
          <td style="padding:10px 12px;font-size:13px;text-align:center;font-weight:bold;color:${bet === '—' ? '#9CA3AF' : '#166534'};font-family:Arial,sans-serif;">${bet}</td>
        </tr>`;
    }).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background-color:#F1F5F9;">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td align="center" style="padding:32px 16px;">
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">
      <tr><td style="background-color:#001A4B;padding:28px 32px 20px;text-align:center;">
        <p style="margin:0;font-size:22px;font-weight:900;color:#FFFFFF;font-family:Arial,sans-serif;">⚽ PRODE High Rolling</p>
        <p style="margin:6px 0 0;font-size:13px;color:#93C5FD;font-family:Arial,sans-serif;">${torneoName}</p>
      </td></tr>
      <tr><td style="background-color:#DCFCE7;padding:16px 32px;text-align:center;">
        <p style="margin:0;font-size:15px;font-weight:900;color:#166534;font-family:Arial,sans-serif;">✅ PRONÓSTICOS GUARDADOS</p>
        <p style="margin:4px 0 0;font-size:13px;color:#166534;font-family:Arial,sans-serif;">¡Todos tus pronósticos están listos!</p>
      </td></tr>
      <tr><td style="background-color:#FFFFFF;padding:28px 32px;">
        <p style="margin:0 0 16px;font-size:16px;font-weight:900;color:#001A4B;font-family:Arial,sans-serif;">¡Bien hecho, ${userName}! 🎉</p>
        <p style="margin:0 0 20px;font-size:14px;color:#374151;font-family:Arial,sans-serif;line-height:1.6;">
          Cargaste todos tus pronósticos para <strong>${planillaNombre}</strong>. Guardamos este resumen para que tengas un comprobante.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#E5E7EB;border-radius:8px;overflow:hidden;">
          <tr style="background-color:#F9FAFB;">
            <th style="padding:10px 12px;font-size:12px;font-weight:bold;color:#6B7280;text-align:left;font-family:Arial,sans-serif;">PARTIDO</th>
            <th style="padding:10px 12px;font-size:12px;font-weight:bold;color:#6B7280;text-align:center;font-family:Arial,sans-serif;">TU PRONÓSTICO</th>
          </tr>
          ${rows}
        </table>
        <div style="margin-top:16px;padding:12px;background:#FEF9C3;border:1px solid #FDE047;border-radius:8px;">
          <p style="margin:0;font-size:12px;color:#713F12;font-family:Arial,sans-serif;">⏰ Recordá que las apuestas cierran 5 minutos antes del primer partido. Podés editarlas hasta ese momento.</p>
        </div>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;">
          <tr><td align="center">
            <a href="https://hr.prodecaballito.com/apuestas" style="display:inline-block;background-color:#001A4B;color:#FFFFFF;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;padding:14px 36px;border-radius:50px;">Ver mi planilla →</a>
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="background-color:#F8FAFC;padding:16px 32px;text-align:center;">
        <p style="margin:0;font-size:11px;color:#9CA3AF;font-family:Arial,sans-serif;">hr.prodecaballito.com · Comprobante de pronósticos</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

    await sendEmail({ to: userEmail, subject, html });
};
exports.sendBetConfirmationEmail = sendBetConfirmationEmail;

const sendPlanillaGeneralEmail = async ({ userEmail, userName, torneoName, matches, betsByUser }) => {
    const subject = `🔮 La planilla general de ${torneoName} — ¿quién apostó qué?`;

    const MAX_COLS = 8;
    const users = betsByUser.slice(0, MAX_COLS);
    const hasMore = betsByUser.length > MAX_COLS;

    const headerCols = users.map(u =>
        `<th style="padding:8px 6px;font-size:10px;font-weight:bold;color:#fff;text-align:center;font-family:Arial,sans-serif;white-space:nowrap;">${u.nombre.split(' ')[0]}</th>`
    ).join('');

    const dataRows = matches.map(m => {
        const betCols = users.map(u => {
            const b = u.bets[m.id];
            const txt = b != null ? `${b.local}-${b.visitante}` : '—';
            const isMe = u.email === userEmail;
            return `<td style="padding:8px 6px;font-size:12px;text-align:center;font-weight:${isMe ? 'bold' : 'normal'};color:${txt === '—' ? '#9CA3AF' : isMe ? '#001A4B' : '#374151'};background:${isMe ? '#EFF6FF' : 'transparent'};font-family:Arial,sans-serif;">${txt}</td>`;
        }).join('');
        return `<tr style="border-bottom:1px solid #E5E7EB;">
          <td style="padding:8px 10px;font-size:11px;color:#111827;font-family:Arial,sans-serif;white-space:nowrap;">${m.home_team} vs ${m.away_team}</td>
          ${betCols}
        </tr>`;
    }).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background-color:#F1F5F9;">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td align="center" style="padding:32px 16px;">
    <table width="640" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;width:100%;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">
      <tr><td style="background-color:#001A4B;padding:28px 32px 20px;text-align:center;">
        <p style="margin:0;font-size:22px;font-weight:900;color:#FFFFFF;font-family:Arial,sans-serif;">⚽ PRODE High Rolling</p>
        <p style="margin:6px 0 0;font-size:13px;color:#93C5FD;font-family:Arial,sans-serif;">${torneoName} — Las apuestas cerraron</p>
      </td></tr>
      <tr><td style="background-color:#FFFFFF;padding:28px 32px;">
        <p style="margin:0 0 8px;font-size:16px;font-weight:900;color:#001A4B;font-family:Arial,sans-serif;">🔮 ¿Quién apostó qué, ${userName}?</p>
        <p style="margin:0 0 20px;font-size:13px;color:#6B7280;font-family:Arial,sans-serif;">Tu columna está resaltada en azul. Las apuestas ya están cerradas — ahora a esperar los resultados.</p>
        <div style="overflow-x:auto;">
          <table cellpadding="0" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#E5E7EB;min-width:100%;">
            <tr style="background-color:#001A4B;">
              <th style="padding:8px 10px;font-size:10px;font-weight:bold;color:#93C5FD;text-align:left;font-family:Arial,sans-serif;">PARTIDO</th>
              ${headerCols}
            </tr>
            ${dataRows}
          </table>
        </div>
        ${hasMore ? `<p style="margin:12px 0 0;font-size:11px;color:#9CA3AF;font-family:Arial,sans-serif;">* Se muestran ${MAX_COLS} participantes. Ver la planilla completa en la app.</p>` : ''}
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">
          <tr><td align="center">
            <a href="https://hr.prodecaballito.com/matriz" style="display:inline-block;background-color:#001A4B;color:#FFFFFF;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;padding:14px 36px;border-radius:50px;">Ver la matriz completa →</a>
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="background-color:#F8FAFC;padding:16px 32px;text-align:center;">
        <p style="margin:0;font-size:11px;color:#9CA3AF;font-family:Arial,sans-serif;">hr.prodecaballito.com · Planilla general al cierre del torneo</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

    await sendEmail({ to: userEmail, subject, html });
};
exports.sendPlanillaGeneralEmail = sendPlanillaGeneralEmail;

const sendPlanillaDeletedEmail = async ({ userEmail, userName, planillaNombre }) => {
    const firstName = (userName || 'jugador').split(' ')[0];
    const subject = `Tu planilla "${planillaNombre}" fue eliminada`;
    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.07);">
        <tr><td style="background:#001A4B;padding:24px 32px;">
          <p style="margin:0;font-size:20px;font-weight:bold;color:#FFDF00;">⚽ PRODE High Rolling</p>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="font-size:16px;color:#333;margin:0 0 16px;">Hola <strong>${firstName}</strong>,</p>
          <p style="font-size:14px;color:#555;margin:0 0 16px;">
            Tu planilla <strong>"${planillaNombre}"</strong> fue eliminada por un administrador.
          </p>
          <p style="font-size:14px;color:#555;margin:0 0 24px;">
            Si tenés dudas o creés que fue un error, escribinos por WhatsApp.
          </p>
          <a href="https://hr.prodecaballito.com" style="display:inline-block;background:#001A4B;color:#FFDF00;text-decoration:none;font-size:14px;font-weight:bold;padding:12px 28px;border-radius:50px;">
            Ir al PRODE →
          </a>
        </td></tr>
        <tr><td style="padding:16px 32px;background:#f8f8f8;border-top:1px solid #eee;">
          <p style="font-size:11px;color:#999;margin:0;">© ${new Date().getFullYear()} PRODE High Rolling · noreply@hr.prodecaballito.com</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
    await sendEmail({ to: userEmail, subject, html });
};
exports.sendPlanillaDeletedEmail = sendPlanillaDeletedEmail;

//# sourceMappingURL=email.js.map