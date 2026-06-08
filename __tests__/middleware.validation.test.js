'use strict'

const express = require('express')
const supertest = require('supertest')
const {
  validate,
  registerValidation,
  loginValidation,
  betValidation,
  betScoreValidation,
  planillaValidation,
  uuidParam,
  messageValidation,
  commentValidation,
  paginationQuery,
} = require('../middleware/validation')

const VALID_UUID = '123e4567-e89b-12d3-a456-426614174000'

function makeApp(middleware, method = 'post', path = '/') {
  const app = express()
  app.use(express.json())
  app[method](path, middleware, (_req, res) => res.json({ ok: true }))
  return app
}

// ── validate() ──────────────────────────────────────────────────────────────

describe('validate()', () => {
  it('llama next() si no hay errores de validación', () => {
    const req = { body: {} }
    req.__validationErrors = []
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const next = jest.fn()
    validate(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })
})

// ── registerValidation ───────────────────────────────────────────────────────

describe('registerValidation', () => {
  let agent
  beforeAll(() => { agent = supertest(makeApp(registerValidation)) })

  it('acepta datos válidos', async () => {
    const res = await agent.post('/').send({
      nombre: 'Juan Pérez',
      email: 'juan@example.com',
      password: 'secreto123',
    })
    expect(res.status).toBe(200)
  })

  it('rechaza email inválido', async () => {
    const res = await agent.post('/').send({
      nombre: 'Juan',
      email: 'no-es-email',
      password: 'secreto123',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Validation failed')
  })

  it('rechaza password corto', async () => {
    const res = await agent.post('/').send({
      nombre: 'Juan',
      email: 'juan@example.com',
      password: '123',
    })
    expect(res.status).toBe(400)
  })

  it('rechaza nombre vacío', async () => {
    const res = await agent.post('/').send({
      nombre: '',
      email: 'juan@example.com',
      password: 'secreto123',
    })
    expect(res.status).toBe(400)
  })

  it('rechaza idioma_pref inválido', async () => {
    const res = await agent.post('/').send({
      nombre: 'Juan',
      email: 'juan@example.com',
      password: 'secreto123',
      idioma_pref: 'fr',
    })
    expect(res.status).toBe(400)
  })

  it('acepta idioma_pref pt-BR', async () => {
    const res = await agent.post('/').send({
      nombre: 'João',
      email: 'joao@example.com',
      password: 'secreto123',
      idioma_pref: 'pt-BR',
    })
    expect(res.status).toBe(200)
  })
})

// ── loginValidation ──────────────────────────────────────────────────────────

describe('loginValidation', () => {
  let agent
  beforeAll(() => { agent = supertest(makeApp(loginValidation)) })

  it('acepta credenciales válidas', async () => {
    const res = await agent.post('/').send({ email: 'a@b.com', password: 'x' })
    expect(res.status).toBe(200)
  })

  it('rechaza email inválido', async () => {
    const res = await agent.post('/').send({ email: 'no-email', password: 'x' })
    expect(res.status).toBe(400)
  })

  it('rechaza password vacío', async () => {
    const res = await agent.post('/').send({ email: 'a@b.com', password: '' })
    expect(res.status).toBe(400)
  })
})

// ── betValidation ────────────────────────────────────────────────────────────

describe('betValidation', () => {
  let agent
  beforeAll(() => { agent = supertest(makeApp(betValidation)) })

  it('acepta apuesta válida', async () => {
    const res = await agent.post('/').send({
      planilla_id: VALID_UUID,
      match_id: VALID_UUID,
      goles_local: 2,
      goles_visitante: 1,
    })
    expect(res.status).toBe(200)
  })

  it('rechaza planilla_id no UUID', async () => {
    const res = await agent.post('/').send({
      planilla_id: 'no-uuid',
      match_id: VALID_UUID,
      goles_local: 2,
      goles_visitante: 1,
    })
    expect(res.status).toBe(400)
  })

  it('rechaza goles_local negativo', async () => {
    const res = await agent.post('/').send({
      planilla_id: VALID_UUID,
      match_id: VALID_UUID,
      goles_local: -1,
      goles_visitante: 1,
    })
    expect(res.status).toBe(400)
  })

  it('rechaza goles_visitante > 99', async () => {
    const res = await agent.post('/').send({
      planilla_id: VALID_UUID,
      match_id: VALID_UUID,
      goles_local: 0,
      goles_visitante: 100,
    })
    expect(res.status).toBe(400)
  })
})

// ── betScoreValidation ───────────────────────────────────────────────────────

describe('betScoreValidation', () => {
  let agent
  beforeAll(() => { agent = supertest(makeApp(betScoreValidation)) })

  it.each(['2-1', '0-0', '3:2', '10-0'])('acepta formato válido: %s', async (score) => {
    const res = await agent.post('/').send({
      planilla_id: VALID_UUID,
      match_id: VALID_UUID,
      score,
    })
    expect(res.status).toBe(200)
  })

  it.each(['x-y', '2', 'gol', '2-', '-1'])('rechaza formato inválido: %s', async (score) => {
    const res = await agent.post('/').send({
      planilla_id: VALID_UUID,
      match_id: VALID_UUID,
      score,
    })
    expect(res.status).toBe(400)
  })
})

// ── planillaValidation ───────────────────────────────────────────────────────

describe('planillaValidation', () => {
  let agent
  beforeAll(() => { agent = supertest(makeApp(planillaValidation)) })

  it('acepta nombre válido', async () => {
    const res = await agent.post('/').send({ nombre_planilla: 'Mi Planilla' })
    expect(res.status).toBe(200)
  })

  it('rechaza nombre vacío', async () => {
    const res = await agent.post('/').send({ nombre_planilla: '' })
    expect(res.status).toBe(400)
  })

  it('rechaza nombre mayor a 100 caracteres', async () => {
    const res = await agent.post('/').send({ nombre_planilla: 'a'.repeat(101) })
    expect(res.status).toBe(400)
  })
})

// ── uuidParam ────────────────────────────────────────────────────────────────

describe('uuidParam', () => {
  let agent
  beforeAll(() => { agent = supertest(makeApp(uuidParam, 'get', '/:id')) })

  it('acepta UUID válido', async () => {
    const res = await agent.get(`/${VALID_UUID}`)
    expect(res.status).toBe(200)
  })

  it('rechaza ID no UUID', async () => {
    const res = await agent.get('/no-es-uuid')
    expect(res.status).toBe(400)
  })

  it('rechaza UUID con formato incorrecto', async () => {
    const res = await agent.get('/1234-5678-abcd')
    expect(res.status).toBe(400)
  })
})

// ── messageValidation ────────────────────────────────────────────────────────

describe('messageValidation', () => {
  let agent
  beforeAll(() => { agent = supertest(makeApp(messageValidation, 'post', '/:otherUserId')) })

  it('acepta mensaje válido', async () => {
    const res = await agent.post(`/${VALID_UUID}`).send({ content: 'Hola!' })
    expect(res.status).toBe(200)
  })

  it('rechaza otherUserId no UUID', async () => {
    const res = await agent.post('/no-uuid').send({ content: 'Hola' })
    expect(res.status).toBe(400)
  })

  it('rechaza mensaje vacío', async () => {
    const res = await agent.post(`/${VALID_UUID}`).send({ content: '' })
    expect(res.status).toBe(400)
  })

  it('rechaza mensaje mayor a 1000 caracteres', async () => {
    const res = await agent.post(`/${VALID_UUID}`).send({ content: 'a'.repeat(1001) })
    expect(res.status).toBe(400)
  })
})

// ── commentValidation ────────────────────────────────────────────────────────

describe('commentValidation', () => {
  let agent
  beforeAll(() => { agent = supertest(makeApp(commentValidation)) })

  it('acepta comentario válido', async () => {
    const res = await agent.post('/').send({
      target_type: 'match',
      target_id: VALID_UUID,
      content: 'Buen partido!',
    })
    expect(res.status).toBe(200)
  })

  it('rechaza target_type inválido', async () => {
    const res = await agent.post('/').send({
      target_type: 'otro',
      target_id: VALID_UUID,
      content: 'hola',
    })
    expect(res.status).toBe(400)
  })

  it('rechaza content vacío', async () => {
    const res = await agent.post('/').send({
      target_type: 'ranking',
      target_id: VALID_UUID,
      content: '',
    })
    expect(res.status).toBe(400)
  })

  it('rechaza content mayor a 280 caracteres', async () => {
    const res = await agent.post('/').send({
      target_type: 'ranking',
      target_id: VALID_UUID,
      content: 'a'.repeat(281),
    })
    expect(res.status).toBe(400)
  })
})

// ── paginationQuery ──────────────────────────────────────────────────────────

describe('paginationQuery', () => {
  let agent
  beforeAll(() => { agent = supertest(makeApp(paginationQuery, 'get', '/')) })

  it('acepta sin parámetros', async () => {
    const res = await agent.get('/')
    expect(res.status).toBe(200)
  })

  it('acepta page y limit válidos', async () => {
    const res = await agent.get('/?page=2&limit=50')
    expect(res.status).toBe(200)
  })

  it('rechaza page=0', async () => {
    const res = await agent.get('/?page=0')
    expect(res.status).toBe(400)
  })

  it('rechaza limit=101', async () => {
    const res = await agent.get('/?limit=101')
    expect(res.status).toBe(400)
  })
})
