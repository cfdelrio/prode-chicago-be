'use strict'

// RESEND_API_KEY must be set before email.js loads — we removed the hardcoded fallback
process.env.RESEND_API_KEY = 'test-resend-key'

const mockFetch = jest.fn()
global.fetch = mockFetch

const mockDbQuery = jest.fn()
jest.mock('../db/connection', () => ({
  db: { query: mockDbQuery },
}))

const { sendEmail, sendWelcomeEmail, sendVerificationCode } = require('../services/email')

beforeEach(() => {
  mockFetch.mockReset()
  mockFetch.mockResolvedValue({ ok: true })
  mockDbQuery.mockReset()
  // default: 42 users, no avatar
  mockDbQuery
    .mockResolvedValueOnce({ rows: [{ total: 42 }] })
    .mockResolvedValueOnce({ rows: [{ foto_url: null }] })
})

describe('sendEmail', () => {
  it('llama a Resend con los parámetros correctos', async () => {
    await sendEmail({ to: 'a@b.com', subject: 'Test', html: '<p>hi</p>' })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body)
    expect(body.to).toBe('a@b.com')
    expect(body.subject).toBe('Test')
    expect(body.from).toContain('PRODE High Rolling')
  })

  it('lanza error si Resend responde con status no-ok', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 422, text: async () => 'invalid_email' })
    await expect(sendEmail({ to: 'bad', subject: 'x', html: 'y' })).rejects.toThrow('Resend API error')
  })
})

describe('sendWelcomeEmail', () => {
  it('envía el email con el subject correcto', async () => {
    await sendWelcomeEmail('user@test.com', 'Carlos')
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.subject).toContain('Carlos')
    expect(body.subject).toContain('Mundial 2026')
    expect(body.to).toBe('user@test.com')
  })

  it('incluye el nombre en el HTML', async () => {
    await sendWelcomeEmail('user@test.com', 'Martina')
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.html).toContain('Martina')
  })

  it('incluye el headline principal del diseño', async () => {
    await sendWelcomeEmail('user@test.com', 'Juan')
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.html).toContain('ESTO YA EMPEZ')
    expect(body.html).toContain('VAS A JUGAR')
    expect(body.html).toContain('O MIRAR')
  })

  it('incluye el CTA con link a hr.prodecaballito.com', async () => {
    await sendWelcomeEmail('user@test.com', 'Juan')
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.html).toContain('hr.prodecaballito.com')
    expect(body.html).toContain('EMPEZAR A JUGAR')
  })

  it('incluye la sección de alerta', async () => {
    await sendWelcomeEmail('user@test.com', 'Juan')
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.html).toContain('NO TE QUEDES AFUERA')
    expect(body.html).toContain('perd')
  })

  it('incluye los 3 pasos de cómo funciona', async () => {
    await sendWelcomeEmail('user@test.com', 'Juan')
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.html).toContain('APOSTÁ')
    expect(body.html).toContain('SUMÁ PUNTOS')
    expect(body.html).toContain('SUBÍ EN EL RANKING')
  })

  it('usa colores del diseño (dorado y oscuro)', async () => {
    await sendWelcomeEmail('user@test.com', 'Juan')
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.html).toContain('#FFB700')
    expect(body.html).toContain('#111')
  })

  it('muestra el total real de jugadores desde la DB', async () => {
    await sendWelcomeEmail('user@test.com', 'Juan')
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.html).toContain('42')
    expect(body.html).toContain('JUGADORES')
  })

  it('muestra ⚠️ en la alerta si el usuario no tiene foto', async () => {
    await sendWelcomeEmail('user@test.com', 'Juan')
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.html).not.toContain('<img')
    expect(body.html).toContain('⚠️')
  })

  it('incluye avatar dentro del bloque de alerta, entre texto y llama', async () => {
    mockDbQuery.mockReset()
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ total: 10 }] })
      .mockResolvedValueOnce({ rows: [{ foto_url: 'https://cdn.example.com/avatar.jpg' }] })
    await sendWelcomeEmail('user@test.com', 'Juan')
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.html).toContain('https://cdn.example.com/avatar.jpg')
    expect(body.html).toContain('border-radius:50%')
    // avatar aparece dentro del bloque alerta (antes del texto, antes de los stats)
    const alertaPos = body.html.indexOf('NO TE QUEDES AFUERA')
    const avatarPos = body.html.indexOf('cdn.example.com')
    const statsPos  = body.html.indexOf('JUGADORES')
    expect(avatarPos).toBeLessThan(alertaPos)
    expect(avatarPos).toBeLessThan(statsPos)
  })

  it('HTML es válido (tiene doctype, head y body)', async () => {
    await sendWelcomeEmail('user@test.com', 'Juan')
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.html).toMatch(/<!DOCTYPE html/i)
    expect(body.html).toContain('<head>')
    expect(body.html).toContain('</body>')
  })
})

describe('sendVerificationCode', () => {
  it('envía email con el código en el subject y html', async () => {
    await sendVerificationCode('v@test.com', 'Ana', '123456')
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.html).toContain('123456')
    expect(body.to).toBe('v@test.com')
  })
})
