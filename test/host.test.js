/**
 * Host-half integration tests.
 *
 * These exercise the two loopback routes end to end with a fake context, a
 * stubbed `fetch`, and a throwaway `DSH_HOME`, so the request fence, the
 * ledger round-trip on disk, and the "no secret in the payload" guarantee are
 * all checked without touching the live profile.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { API_PREFIX, apply, is_same_origin_local_request } from '../lib/index.js'

const API_KEY = `sk-${'a'.repeat(32)}`
const ORIGIN = '127.0.0.1:3080'
const MOUNTED_SYMBOL = Symbol.for('harness-accountant.mounted')
const WAITERS_SYMBOL = Symbol.for('harness-accountant.mounted.waiters')

function make_request(options = {}) {
  return {
    method: options.method ?? 'GET',
    socket: { remoteAddress: 'address' in options ? options.address : '127.0.0.1' },
    headers: {
      host: options.host ?? ORIGIN,
      'sec-fetch-site': 'same-origin',
      'x-harness-accountant': '1',
      ...(options.headers ?? {}),
    },
  }
}

function make_response() {
  const captured = { status: 0, headers: undefined, raw: undefined }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
    },
    end(payload) {
      captured.raw = payload
    },
  }
}

function body_of(response) {
  return JSON.parse(response.captured.raw)
}

function make_context(options = {}) {
  const routes = new Map()
  const listeners = new Map()
  return {
    routes,
    listeners,
    get(name) {
      if (name !== 'credentials') return undefined
      if (options.credentials_throws === true) throw new Error('service exploded')
      return {
        async resolve() {
          if (options.credential_missing === true) return undefined
          return { value: options.credential ?? API_KEY, source: 'file' }
        },
      }
    },
    on(event, handler) {
      listeners.set(event, handler)
    },
    effect(callback) {
      return callback()
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => {
          routes.delete(route.path)
        }
      },
    },
  }
}

function default_config(overrides = {}) {
  return {
    enabled: true,
    poll_interval_sec: 60,
    retain_days: 400,
    api_key_env: 'DEEPSEEK_API_KEY',
    api_base_url: 'https://api.deepseek.com',
    ...overrides,
  }
}

/**
 * Mount the plugin against a temp `DSH_HOME` with a stubbed `fetch`.
 * @returns handles plus an async `dispose` that restores every global.
 */
async function mount(t, options = {}) {
  const created_home = options.home === undefined
  const home = options.home ?? (await mkdtemp(join(tmpdir(), 'harness-accountant-')))
  const original_home = process.env.DSH_HOME
  const original_fetch = globalThis.fetch
  const calls = []

  process.env.DSH_HOME = home
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    if (options.fetch_throws === true) throw new Error(`connect ECONNREFUSED ${url}`)
    if (options.fetch_status !== undefined) {
      return { ok: false, status: options.fetch_status, json: async () => ({}) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => options.payload ?? {
        is_available: true,
        balance_infos: [
          { currency: 'USD', total_balance: '4.58', granted_balance: '0.00', topped_up_balance: '4.58' },
        ],
      },
    }
  }

  const ctx = make_context(options)
  apply(ctx, default_config(options.config))

  let disposed = false
  async function dispose() {
    if (disposed) return
    disposed = true
    // The plugin registers a mount guard on `globalThis`; clear it so the next
    // test starts from a clean slot instead of queuing behind this one.
    delete globalThis[MOUNTED_SYMBOL]
    delete globalThis[WAITERS_SYMBOL]
    if (original_home === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = original_home
    globalThis.fetch = original_fetch
    if (created_home && options.keep_home !== true) {
      await rm(home, { recursive: true, force: true })
    }
  }
  if (t !== undefined) t.after(dispose)

  return {
    ctx,
    calls,
    home,
    ledger_path: join(home, 'harness-accountant', 'ledger.json'),
    route(path) {
      const found = ctx.routes.get(path)
      assert.ok(found, `route ${path} should be registered`)
      return found
    },
    async call(path, request = make_request()) {
      const response = make_response()
      await this.route(path).handler(request, response)
      return response
    },
    dispose,
  }
}

// ------------------------------------------------------------ request fence

test('the fence admits a well-formed loopback request', () => {
  assert.equal(is_same_origin_local_request(make_request()), true)
  assert.equal(is_same_origin_local_request(make_request({ address: '::1' })), true)
  assert.equal(is_same_origin_local_request(make_request({ address: '::ffff:127.0.0.1' })), true)
  assert.equal(is_same_origin_local_request(make_request({ host: 'localhost:3080' })), true)
  assert.equal(is_same_origin_local_request(make_request({ host: '[::1]:3080' })), true)
})

test('the fence rejects a non-loopback peer', () => {
  assert.equal(is_same_origin_local_request(make_request({ address: '192.168.1.20' })), false)
  assert.equal(is_same_origin_local_request(make_request({ address: undefined })), false)
})

test('the fence rejects a rebound Host header', () => {
  // The socket peer is still 127.0.0.1, which is exactly why this check exists.
  assert.equal(is_same_origin_local_request(make_request({ host: 'evil.example:3080' })), false)
  assert.equal(is_same_origin_local_request(make_request({ host: '127.0.0.1.evil.example' })), false)
})

test('the fence rejects a request without the custom header', () => {
  const request = make_request()
  delete request.headers['x-harness-accountant']
  assert.equal(is_same_origin_local_request(request), false)
})

test('the fence rejects a cross-site fetch', () => {
  assert.equal(is_same_origin_local_request(make_request({ headers: { 'sec-fetch-site': 'cross-site' } })), false)
})

// ----------------------------------------------------------------- routes

test('both routes are registered under the documented prefix', async (t) => {
  const app = await mount(t)
  assert.ok(app.ctx.routes.has(`${API_PREFIX}/overview`))
  assert.ok(app.ctx.routes.has(`${API_PREFIX}/refresh`))
  await app.dispose()
})

test('the overview route refuses a foreign caller with 403', async (t) => {
  const app = await mount(t)
  const request = make_request({ host: 'evil.example' })
  const response = await app.call(`${API_PREFIX}/overview`, request)
  assert.equal(response.captured.status, 403)
  assert.deepEqual(body_of(response), { ok: false, error: 'forbidden' })
  await app.dispose()
})

test('the overview route refuses the wrong method with 405', async (t) => {
  const app = await mount(t)
  const response = await app.call(`${API_PREFIX}/overview`, make_request({ method: 'POST' }))
  assert.equal(response.captured.status, 405)
  await app.dispose()
})

test('the first overview paint already carries a live balance', async (t) => {
  const app = await mount(t)
  const response = await app.call(`${API_PREFIX}/overview`)
  const body = body_of(response)

  assert.equal(response.captured.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.currency, 'USD')
  assert.equal(body.balance.text, '$4.58')
  assert.equal(body.balance.units, 4_580_000)
  assert.equal(body.credential_source, 'file')
  assert.deepEqual(Object.keys(body.ranges), ['day', 'week', 'month'])
  assert.equal(body.ranges.day.days, 1)
  assert.equal(body.ranges.week.days, 7)
  assert.equal(body.ranges.month.days, 30)
  await app.dispose()
})

test('the response headers disable caching, sniffing, and cross-origin reads', async (t) => {
  const app = await mount(t)
  const response = await app.call(`${API_PREFIX}/overview`)
  const headers = response.captured.headers

  assert.equal(headers['cache-control'], 'no-store')
  assert.equal(headers['x-content-type-options'], 'nosniff')
  assert.equal(headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(headers['access-control-allow-origin'], undefined)
  await app.dispose()
})

test('no part of the payload echoes the API key', async (t) => {
  const app = await mount(t)
  const response = await app.call(`${API_PREFIX}/overview`)
  const raw = response.captured.raw

  assert.ok(!raw.includes(API_KEY))
  assert.ok(!raw.includes('sk-a'))
  // The request did carry it, in the Authorization header only.
  assert.equal(app.calls[0].init.headers.authorization, `Bearer ${API_KEY}`)
  assert.equal(app.calls[0].url, 'https://api.deepseek.com/user/balance')
  assert.equal(app.calls[0].init.redirect, 'error')
  await app.dispose()
})

test('the refresh route probes and persists a 0600 ledger', async (t) => {
  const app = await mount(t)
  const response = await app.call(`${API_PREFIX}/refresh`, make_request({ method: 'POST' }))
  assert.equal(response.captured.status, 200)

  const file = await stat(app.ledger_path)
  assert.equal(file.mode & 0o777, 0o600)

  const ledger = JSON.parse(await readFile(app.ledger_path, 'utf8'))
  assert.equal(ledger.version, 1)
  assert.equal(ledger.currency, 'USD')
  const dates = Object.keys(ledger.days)
  assert.equal(dates.length, 1)
  assert.equal(ledger.days[dates[0]].closing_units, 4_580_000)
  await app.dispose()
})

test('a stored ledger is read back after a restart', async (t) => {
  const first = await mount(t, { keep_home: true })
  await first.call(`${API_PREFIX}/refresh`, make_request({ method: 'POST' }))
  await first.dispose()
  t.after(() => rm(first.home, { recursive: true, force: true }))

  // Restart against the same DSH_HOME with the probe now failing, so a balance
  // can only have come from disk.
  const second = await mount(t, { home: first.home, fetch_throws: true })
  const body = body_of(await second.call(`${API_PREFIX}/overview`))

  assert.equal(body.balance.text, '$4.58')
  assert.equal(body.balance.units, 4_580_000)
  assert.match(body.error, /request failed/)
  await second.dispose()
})

// ------------------------------------------------------------- degradation

test('a missing credential is reported, not thrown', async (t) => {
  const app = await mount(t, { credential_missing: true })
  const response = await app.call(`${API_PREFIX}/overview`)

  assert.equal(response.captured.status, 200)
  const body = body_of(response)
  assert.equal(body.balance, undefined)
  assert.match(body.error, /no credential stored for DEEPSEEK_API_KEY/)
  await app.dispose()
})

test('a credential lookup that throws degrades to a redacted reason', async (t) => {
  const app = await mount(t, { credentials_throws: true })
  const body = body_of(await app.call(`${API_PREFIX}/overview`))

  assert.equal(body.error, 'credentials service unavailable')
  await app.dispose()
})

test('a hostile error message has any key-shaped run removed', async (t) => {
  const app = await mount(t, { fetch_throws: true })
  const body = body_of(await app.call(`${API_PREFIX}/overview`))

  assert.match(body.error, /request failed/)
  assert.ok(!body.error.includes(API_KEY))
  await app.dispose()
})

test('an HTTP failure reports only the status code', async (t) => {
  const app = await mount(t, { fetch_status: 429 })
  const body = body_of(await app.call(`${API_PREFIX}/overview`))

  assert.equal(body.error, 'http 429')
  await app.dispose()
})

test('a plain-http base URL is refused before the key leaves the process', async (t) => {
  const app = await mount(t, { config: { api_base_url: 'http://api.deepseek.com' } })
  const before = app.calls.length
  const body = body_of(await app.call(`${API_PREFIX}/overview`))

  assert.equal(body.error, 'api_base_url must be a bare https origin')
  assert.equal(app.calls.length, before)
  await app.dispose()
})

test('disabling the plugin polls nothing at all', async (t) => {
  const app = await mount(t, { config: { enabled: false } })
  const body = body_of(await app.call(`${API_PREFIX}/overview`))

  assert.equal(app.calls.length, 0)
  assert.equal(body.balance, undefined)
  await app.dispose()
})
