'use strict'

let originalEnv

beforeEach(() => {
  originalEnv = process.env.NODE_ENV
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  process.env.NODE_ENV = originalEnv
  jest.restoreAllMocks()
  jest.resetModules()
})

function getLogger(env) {
  process.env.NODE_ENV = env
  jest.resetModules()
  return require('../utils/logger').createLogger('test-ctx')
}

// ── producción ────────────────────────────────────────────────────────────────

describe('logger en producción', () => {
  it('escribe JSON en stdout', () => {
    const logger = getLogger('production')
    logger.info('hello', { foo: 'bar' })
    expect(process.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining('"level":"info"')
    )
  })

  it('incluye ctx y msg', () => {
    const logger = getLogger('production')
    logger.warn('mensaje de prueba')
    const [raw] = process.stdout.write.mock.calls[0]
    const parsed = JSON.parse(raw)
    expect(parsed.ctx).toBe('test-ctx')
    expect(parsed.msg).toBe('mensaje de prueba')
  })

  it('incluye timestamp ISO', () => {
    const logger = getLogger('production')
    logger.error('boom')
    const [raw] = process.stdout.write.mock.calls[0]
    const parsed = JSON.parse(raw)
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('expande objetos meta como campos de nivel superior', () => {
    const logger = getLogger('production')
    logger.info('evento', { userId: 'u1', action: 'login' })
    const [raw] = process.stdout.write.mock.calls[0]
    const parsed = JSON.parse(raw)
    expect(parsed.userId).toBe('u1')
    expect(parsed.action).toBe('login')
  })

  it('serializa Error con message y stack', () => {
    const logger = getLogger('production')
    logger.error('fallo', new Error('algo salió mal'))
    const [raw] = process.stdout.write.mock.calls[0]
    const parsed = JSON.parse(raw)
    expect(parsed.error).toBe('algo salió mal')
    expect(parsed.stack).toContain('Error:')
  })

  it('serializa meta primitivo como detail', () => {
    const logger = getLogger('production')
    logger.warn('atención', 'código 42')
    const [raw] = process.stdout.write.mock.calls[0]
    const parsed = JSON.parse(raw)
    expect(parsed.detail).toBe('código 42')
  })

  it('los cuatro niveles emiten JSON válido', () => {
    const logger = getLogger('production')
    logger.info('i')
    logger.warn('w')
    logger.error('e')
    logger.debug('d')
    expect(process.stdout.write).toHaveBeenCalledTimes(4)
    for (const [raw] of process.stdout.write.mock.calls) {
      expect(() => JSON.parse(raw)).not.toThrow()
    }
  })

  it('no llama a console.log ni console.error', () => {
    const logger = getLogger('production')
    logger.info('x')
    logger.error('y')
    expect(console.log).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
  })
})

// ── desarrollo ────────────────────────────────────────────────────────────────

describe('logger en desarrollo', () => {
  it('usa console.log para info y debug', () => {
    const logger = getLogger('development')
    logger.info('test')
    logger.debug('dbg')
    expect(console.log).toHaveBeenCalledTimes(2)
    expect(process.stdout.write).not.toHaveBeenCalled()
  })

  it('usa console.error para error y warn', () => {
    const logger = getLogger('development')
    logger.error('fallo')
    logger.warn('cuidado')
    expect(console.error).toHaveBeenCalledTimes(2)
  })

  it('incluye el contexto en el mensaje', () => {
    const logger = getLogger('development')
    logger.info('algo')
    const [prefix] = console.log.mock.calls[0]
    expect(prefix).toContain('[test-ctx]')
  })

  it('pasa meta como argumento adicional', () => {
    const logger = getLogger('development')
    logger.info('con meta', { key: 'val' })
    const call = console.log.mock.calls[0]
    expect(call).toHaveLength(3)
    expect(call[2]).toEqual({ key: 'val' })
  })
})
