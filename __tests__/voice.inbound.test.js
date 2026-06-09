'use strict'

// Mock DB connection (no DB needed for inbound endpoints, but required by module load)
jest.mock('../db/connection', () => ({ db: { query: jest.fn() } }))
jest.mock('../middleware/auth', () => ({
  authMiddleware: (_req, _res, next) => next(),
  requireAdmin:   (_req, _res, next) => next(),
}))

// Mock twilio so validateRequest is controllable in each test
const mockValidateRequest = jest.fn(() => true)
jest.mock('twilio', () => ({
  validateRequest: (...args) => mockValidateRequest(...args),
}))

const express = require('express')
const request = require('supertest')

// TWILIO_AUTH_TOKEN must be set so the middleware doesn't short-circuit with 500
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token'

const voiceRouter = require('../routes/voice')

function buildApp() {
  const app = express()
  app.use(express.urlencoded({ extended: false }))
  app.use(express.json())
  app.use('/api/voice', voiceRouter)
  return app
}

// Helper: request with a fake Twilio signature header (mock always validates true)
function twilioPost(app, path) {
  return request(app)
    .post(path)
    .set('x-twilio-signature', 'fake-sig-for-tests')
}

// ─── Twilio signature security tests ─────────────────────────────────────────

describe('Twilio signature validation', () => {
  beforeEach(() => mockValidateRequest.mockReturnValue(true))

  it('retorna 403 si falta el header X-Twilio-Signature', async () => {
    const res = await request(buildApp())
      .post('/api/voice')
      .send({ CallSid: 'CA123' })
    // No X-Twilio-Signature header → 403 Missing Twilio signature
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/missing twilio signature/i)
  })

  it('retorna 403 si la firma es inválida', async () => {
    mockValidateRequest.mockReturnValue(false)
    const res = await request(buildApp())
      .post('/api/voice')
      .set('x-twilio-signature', 'bad-sig')
      .send({ CallSid: 'CA123' })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/invalid twilio signature/i)
  })

  it('retorna 500 si TWILIO_AUTH_TOKEN no está configurado', async () => {
    const saved = process.env.TWILIO_AUTH_TOKEN
    delete process.env.TWILIO_AUTH_TOKEN
    const res = await request(buildApp())
      .post('/api/voice')
      .set('x-twilio-signature', 'any-sig')
      .send({})
    expect(res.status).toBe(500)
    process.env.TWILIO_AUTH_TOKEN = saved
  })

  it('pasa con firma válida (mock)', async () => {
    const res = await twilioPost(buildApp(), '/api/voice').send({})
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/xml/)
  })
})

// ─── POST /api/voice (inbound) ────────────────────────────────────────────────

describe('POST /api/voice', () => {
  beforeEach(() => mockValidateRequest.mockReturnValue(true))

  it('responde 200 con Content-Type text/xml', async () => {
    const res = await twilioPost(buildApp(), '/api/voice')
      .send({ CallSid: 'CA123', From: '+5491155996222' })

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/xml/)
  })

  it('devuelve TwiML con <Gather> y <Say> de bienvenida', async () => {
    const res = await twilioPost(buildApp(), '/api/voice').send({})

    expect(res.text).toContain('<Gather')
    expect(res.text).toContain('<Say')
    expect(res.text).toContain('Prode High Rolling')
  })

  it('el Gather apunta a /api/voice/menu', async () => {
    const res = await twilioPost(buildApp(), '/api/voice').send({})
    expect(res.text).toMatch(/action="[^"]*\/voice\/menu"/)
  })

  it('menciona las 4 opciones', async () => {
    const res = await twilioPost(buildApp(), '/api/voice').send({})
    expect(res.text).toMatch(/presioná 1/i)
    expect(res.text).toMatch(/presioná 2/i)
    expect(res.text).toMatch(/presioná 3/i)
    expect(res.text).toMatch(/presioná 4/i)
  })

  it('incluye fallback si no se presiona nada', async () => {
    const res = await twilioPost(buildApp(), '/api/voice').send({})
    // El <Say> fuera del <Gather> es el fallback
    const fallbackCount = (res.text.match(/<Say/g) || []).length
    expect(fallbackCount).toBeGreaterThanOrEqual(2)
  })
})

// ─── POST /api/voice/menu ─────────────────────────────────────────────────────

describe('POST /api/voice/menu', () => {
  beforeEach(() => mockValidateRequest.mockReturnValue(true))

  it('opción 1 → reproduce el reglamento', async () => {
    const res = await twilioPost(buildApp(), '/api/voice/menu')
      .send({ Digits: '1', CallSid: 'CA456' })

    expect(res.status).toBe(200)
    expect(res.text).toMatch(/reglamento/i)
    expect(res.text).toMatch(/90 minutos/i)
  })

  it('opción 2 → reproduce cómo jugar', async () => {
    const res = await twilioPost(buildApp(), '/api/voice/menu')
      .send({ Digits: '2' })

    expect(res.text).toMatch(/ingresá a Prode High Rolling/i)
    expect(res.text).toMatch(/ranking en vivo/i)
  })

  it('opción 3 → reproduce info de la primera ronda', async () => {
    const res = await twilioPost(buildApp(), '/api/voice/menu')
      .send({ Digits: '3' })

    expect(res.text).toMatch(/primera ronda/i)
    expect(res.text).toMatch(/segunda ronda/i)
  })

  it('opción 4 → reproduce info del canal de WhatsApp', async () => {
    const res = await twilioPost(buildApp(), '/api/voice/menu')
      .send({ Digits: '4' })

    expect(res.text).toMatch(/WhatsApp/i)
    expect(res.text).toMatch(/canal oficial/i)
  })

  it('opción válida ofrece volver al menú', async () => {
    const res = await twilioPost(buildApp(), '/api/voice/menu')
      .send({ Digits: '2' })

    expect(res.text).toMatch(/menú principal/i)
    expect(res.text).toContain('<Gather')
  })

  it('opción inválida → reproduce el menú de nuevo', async () => {
    const res = await twilioPost(buildApp(), '/api/voice/menu')
      .send({ Digits: '9' })

    expect(res.status).toBe(200)
    expect(res.text).toContain('<Gather')
    expect(res.text).toMatch(/presioná 1/i)
  })

  it('sin dígito → reproduce el menú de nuevo', async () => {
    const res = await twilioPost(buildApp(), '/api/voice/menu')
      .send({})

    expect(res.status).toBe(200)
    expect(res.text).toContain('<Gather')
  })

  it('cada respuesta es XML válido (tiene declaración XML)', async () => {
    for (const digit of ['1', '2', '3', '4', '9']) {
      const res = await twilioPost(buildApp(), '/api/voice/menu')
        .send({ Digits: digit })
      expect(res.text).toMatch(/^<\?xml/)
    }
  })
})

// ─── GET /api/voice (sanity check — no signature required) ──────────────────

describe('GET /api/voice', () => {
  it('responde 200 con XML', async () => {
    const res = await request(buildApp()).get('/api/voice')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/xml/)
  })
})
