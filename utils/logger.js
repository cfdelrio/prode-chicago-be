'use strict'

function write(level, context, message, meta) {
  const isProd = process.env.NODE_ENV === 'production'
  const ts = new Date().toISOString()

  if (isProd) {
    const entry = { ts, level, ctx: context, msg: message }
    if (meta != null) {
      if (meta instanceof Error) {
        entry.error = meta.message
        entry.stack = meta.stack
      } else if (typeof meta === 'object') {
        Object.assign(entry, meta)
      } else {
        entry.detail = String(meta)
      }
    }
    process.stdout.write(JSON.stringify(entry) + '\n')
  } else {
    const prefix = `[${ts.slice(11, 23)}] ${level.toUpperCase().padEnd(5)} [${context}]`
    const fn = level === 'error' || level === 'warn' ? console.error : console.log
    if (meta !== undefined) {
      fn(prefix, message, meta instanceof Error ? meta.message : meta)
    } else {
      fn(prefix, message)
    }
  }
}

function createLogger(context) {
  return {
    info:  (msg, meta) => write('info',  context, msg, meta),
    warn:  (msg, meta) => write('warn',  context, msg, meta),
    error: (msg, meta) => write('error', context, msg, meta),
    debug: (msg, meta) => write('debug', context, msg, meta),
  }
}

module.exports = { createLogger }
