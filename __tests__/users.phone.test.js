'use strict'

const USER_ID = 'a0000000-0000-0000-0000-000000000001'
const mockQuery = jest.fn()

jest.mock('../db/connection', () => ({ db: { query: mockQuery } }))
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req, _res, next) => { req.user = { userId: USER_ID, rol: 'usuario' }; next() },
  requireAdmin: (_req, _res, next) => next(),
}))
jest.mock('../middleware/rateLimit', () => ({ uploadLimiter: (_req, _res, next) => next() }))
jest.mock('../config', () => ({ config: { aws: { cdnUrl: 'https://cdn.example.com' } } }))
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn().mockResolvedValue({}) })),
  PutObjectCommand: jest.fn().mockImplementation(p => p),
}))

const express = require('express')
const supertest = require('supertest')

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/users', require('../routes/users').default)
  return app
}

describe('PUT /users/:id — validación whatsapp_number E.164', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockQuery.mockResolvedValue({ rows: [{ id: USER_ID, nombre: 'Test', email: 't@t.com', rol: 'usuario', whatsapp_number: null, whatsapp_consent: false }] })
  })

  const cases = [
    // [description, number, shouldPass]
    ['número argentino con + correcto', '+5491155996222', true],
    ['número de EEUU con +', '+12125551234', true],
    ['número español con +', '+34612345678', true],
    ['número argentino sin + → rechazado (no E.164)', '5491155996222', false],
    ['número local sin código de país → rechazado', '1155996222', false],
    ['número demasiado corto → rechazado', '+123456789', false],
    ['solo dígitos locales sin código → rechazado', '155996222', false],
    ['string vacío → acepta (borra el número)', '', true],
  ]

  for (const [desc, number, shouldPass] of cases) {
    it(desc, async () => {
      const res = await supertest(makeApp())
        .put(`/users/${USER_ID}`)
        .send({ whatsapp_number: number })

      if (shouldPass) {
        expect(res.status).not.toBe(400)
      } else {
        expect(res.status).toBe(400)
        expect(res.body.error).toMatch(/formato internacional|inválido/i)
      }
    })
  }

  it('número con + se guarda con + en la DB', async () => {
    await supertest(makeApp())
      .put(`/users/${USER_ID}`)
      .send({ whatsapp_number: '+5491155996222' })

    const updateCall = mockQuery.mock.calls.find(c => /UPDATE users/.test(c[0]))
    // $5 es el normalizedPhone
    expect(updateCall[1][4]).toBe('+5491155996222')
  })

  it('número con espacios o guiones se normaliza', async () => {
    await supertest(makeApp())
      .put(`/users/${USER_ID}`)
      .send({ whatsapp_number: '+54 9 11 5599-6222' })

    const updateCall = mockQuery.mock.calls.find(c => /UPDATE users/.test(c[0]))
    expect(updateCall[1][4]).toBe('+5491155996222')
  })
})
