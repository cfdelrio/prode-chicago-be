'use strict'

// Mock global fetch (Node 20+)
const originalFetch = global.fetch
const mockFetch = jest.fn()

beforeEach(() => {
  jest.resetModules()
  global.fetch = mockFetch
  mockFetch.mockReset()
  delete process.env.INFOBIP_API_KEY
  delete process.env.INFOBIP_BASE_URL
  delete process.env.INFOBIP_SMS_FROM
  delete process.env.SMS_WHITELIST
})

afterAll(() => { global.fetch = originalFetch })

function loadModule() {
  return require('../services/sms')
}

describe('sendSMS (Infobip)', () => {
  it('skipea si no están las env vars', async () => {
    const { sendSMS } = loadModule()
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await sendSMS({ to: '+5491155996222', body: 'hola' })

    expect(result).toBeUndefined()
    expect(mockFetch).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Infobip env vars not set'))
    warn.mockRestore()
  })

  it('manda POST a /sms/2/text/advanced con Authorization App {key}', async () => {
    process.env.INFOBIP_API_KEY  = 'test-key'
    process.env.INFOBIP_BASE_URL = 'https://abc.api.infobip.com'
    process.env.INFOBIP_SMS_FROM = 'ProdeCaba'
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: [{ messageId: 'm1', status: { name: 'PENDING_ACCEPTED' } }] }),
    })

    const { sendSMS } = loadModule()
    await sendSMS({ to: '+5491155996222', body: 'hola' })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toBe('https://abc.api.infobip.com/sms/2/text/advanced')
    expect(opts.method).toBe('POST')
    expect(opts.headers.Authorization).toBe('App test-key')
    expect(opts.headers['Content-Type']).toBe('application/json')
    const payload = JSON.parse(opts.body)
    expect(payload).toEqual({
      messages: [{
        destinations: [{ to: '+5491155996222' }],
        from: 'ProdeCaba',
        text: 'hola',
      }],
    })
  })

  it('normaliza números sin + agregando el prefijo', async () => {
    process.env.INFOBIP_API_KEY  = 'k'
    process.env.INFOBIP_BASE_URL = 'https://abc.api.infobip.com'
    process.env.INFOBIP_SMS_FROM = 'ProdeCaba'
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [{}] }) })

    const { sendSMS } = loadModule()
    await sendSMS({ to: '5491155996222', body: 'x' })

    const payload = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(payload.messages[0].destinations[0].to).toBe('+5491155996222')
  })

  it('lanza si Infobip devuelve !ok', async () => {
    process.env.INFOBIP_API_KEY  = 'k'
    process.env.INFOBIP_BASE_URL = 'https://abc.api.infobip.com'
    process.env.INFOBIP_SMS_FROM = 'ProdeCaba'
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => '{"error":"Unauthorized"}',
    })

    const { sendSMS } = loadModule()
    await expect(sendSMS({ to: '+54911', body: 'x' })).rejects.toThrow(/Infobip SMS failed.*401/)
  })

  it('respeta SMS_WHITELIST si está seteada', async () => {
    process.env.INFOBIP_API_KEY  = 'k'
    process.env.INFOBIP_BASE_URL = 'https://abc.api.infobip.com'
    process.env.INFOBIP_SMS_FROM = 'ProdeCaba'
    process.env.SMS_WHITELIST    = '+5491155996222'

    const { sendSMS } = loadModule()
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})

    // Número fuera de whitelist → no hace fetch
    await sendSMS({ to: '+5491141843591', body: 'x' })
    expect(mockFetch).not.toHaveBeenCalled()

    // Número en whitelist → sí hace fetch
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [{}] }) })
    await sendSMS({ to: '+5491155996222', body: 'x' })
    expect(mockFetch).toHaveBeenCalledTimes(1)

    log.mockRestore()
  })
})

describe('sendSMSWithRetry', () => {
  beforeEach(() => {
    process.env.INFOBIP_API_KEY  = 'k'
    process.env.INFOBIP_BASE_URL = 'https://abc.api.infobip.com'
    process.env.INFOBIP_SMS_FROM = 'ProdeCaba'
    process.env.SMS_RETRY_BASE_MS = '0' // no sleep en tests
  })

  it('retorna sin reintentar si el primer envío tiene éxito', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [{ messageId: 'm1' }] }) })

    const { sendSMSWithRetry } = loadModule()
    await sendSMSWithRetry({ to: '+5491155996222', body: 'x' })

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('reintenta en error 5xx hasta tener éxito', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'Service Unavailable' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [{}] }) })

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const { sendSMSWithRetry } = loadModule()
    await sendSMSWithRetry({ to: '+5491155996222', body: 'x' })

    expect(mockFetch).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('NO reintenta en error 4xx (cliente)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'Bad number' })

    const { sendSMSWithRetry } = loadModule()
    await expect(sendSMSWithRetry({ to: 'bad', body: 'x' })).rejects.toThrow(/400/)

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('lanza después de agotar los reintentos (maxAttempts por defecto = 3)', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'x' })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'x' })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'x' })

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const { sendSMSWithRetry } = loadModule()
    await expect(sendSMSWithRetry({ to: '+5491155996222', body: 'x' })).rejects.toThrow(/503/)

    expect(mockFetch).toHaveBeenCalledTimes(3)
    warn.mockRestore()
  })
})
