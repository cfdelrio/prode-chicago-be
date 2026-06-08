'use strict'

jest.mock('../config', () => ({
  config: { app: { apiUrl: 'http://localhost:3001' } },
}))

const express = require('express')
const supertest = require('supertest')
const { corsMiddleware } = require('../middleware/common')

function makeApp() {
  const app = express()
  app.use(corsMiddleware)
  app.get('/test', (_req, res) => res.json({ ok: true }))
  app.use((err, _req, res, _next) => {
    res.status(403).json({ error: err.message })
  })
  return app
}

const ALLOWED = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://d2vjb37mnj30m1.cloudfront.net',
  'https://d16s2xc71j0bqo.cloudfront.net',
  'https://prodecaballito.com',
  'https://www.prodecaballito.com',
]

describe('corsMiddleware — whitelist', () => {
  let agent

  beforeAll(() => { agent = supertest(makeApp()) })

  it.each(ALLOWED)('permite origin %s', async (origin) => {
    const res = await agent.get('/test').set('Origin', origin)
    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe(origin)
  })

  it('bloquea origin no listado', async () => {
    const res = await agent.get('/test').set('Origin', 'https://evil.com')
    expect(res.status).toBe(403)
  })

  it('permite requests sin Origin (server-to-server)', async () => {
    const res = await agent.get('/test')
    expect(res.status).toBe(200)
  })
})
