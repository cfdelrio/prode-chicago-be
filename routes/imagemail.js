"use strict";
const { Router } = require('express');
const { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses');
const nodemailer = require('nodemailer');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const router = Router();

const ses = new SESClient({ region: process.env.AWS_REGION || 'us-east-1' });
const transporter = nodemailer.createTransport({
  SES: { ses, aws: { SendRawEmailCommand } },
});

router.post('/', async (req, res) => {
  try {
    const toStr = (v) => v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));

    const { uri, subject, message, to: toField } = req.body || {};
    const to      = toStr(toField) || 'cfdelrio@gmail.com';
    const subj    = toStr(subject) || '🏆 Nueva imagen';
    const bodyTxt = toStr(message) || '';

    const mailOptions = {
      from: process.env.SES_FROM_EMAIL || 'noreply@prode.com',
      to,
      subject: subj,
      text: bodyTxt,
    };

    // Intentar descargar imagen y adjuntarla + embeber en HTML
    if (uri) {
      try {
        new URL(uri);
        const { buffer, contentType } = await fetchUrl(uri);
        const cid = 'poster@prode';
        const filename = `poster_${Date.now()}.jpg`;

        mailOptions.attachments = [{
          filename,
          content: buffer,
          contentType,
          cid,
        }];

        mailOptions.html = `
          <div style="background:#0b1220;padding:24px;font-family:Arial,sans-serif;color:#fff;">
            <p style="font-size:16px;margin:0 0 16px;">${bodyTxt.replace(/\n/g, '<br>')}</p>
            <img src="cid:${cid}" style="max-width:100%;border-radius:12px;display:block;" alt="Poster ganador"/>
          </div>`;
      } catch (fetchErr) {
        console.warn('No se pudo obtener imagen desde URI:', fetchErr.message);
        mailOptions.html = `<p>${bodyTxt}</p>`;
      }
    } else {
      mailOptions.html = `<p>${bodyTxt}</p>`;
    }

    await transporter.sendMail(mailOptions);
    res.json({ success: true });
  } catch (err) {
    console.error('POST /imagemail error:', err);
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

function fetchUrl(uri, redirectCount = 0) {
  // Handle base64 data URIs (e.g. from OpenAI Responses API image_generation_call)
  if (uri.startsWith('data:')) {
    return new Promise((resolve, reject) => {
      try {
        const commaIdx = uri.indexOf(',');
        const header = uri.slice(0, commaIdx);        // e.g. "data:image/png;base64"
        const data   = uri.slice(commaIdx + 1);
        const contentType = header.split(':')[1]?.split(';')[0] || 'image/png';
        const buffer = Buffer.from(data, 'base64');
        resolve({ buffer, contentType });
      } catch(e) { reject(e); }
    });
  }
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Demasiadas redirecciones'));
    const parsed = new URL(uri);
    const client = parsed.protocol === 'https:' ? https : http;
    client.get(uri, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return fetchUrl(response.headers.location, redirectCount + 1).then(resolve).catch(reject);
      }
      const chunks = [];
      const contentType = response.headers['content-type'] || 'image/jpeg';
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType }));
      response.on('error', reject);
    }).on('error', reject);
  });
}

module.exports = router;
