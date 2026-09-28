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

import { API_PREFIX, apply, config_value, inject, is_same_origin_local_request, next_poll_delay_sec } from '../lib/index.js'

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
      // No body at all: a non-ok response is never read, and this stub proves it.
      return { ok: false, status: options.fetch_status }
    }
    const text = JSON.stringify(options.payload ?? {
      is_available: true,
      balance_infos: [
        { currency: 'USD', total_balance: '4.58', granted_balance: '0.00', topped_up_balance: '4.58' },
      ],
    })
    const bytes = new TextEncoder().encode(text)
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      }),
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

// ------------------------------------------------------------ configuration

test('config_value reads a volatile reference instead of falling back', () => {
  // Regression: a `.volatile()` field is delivered as a frozen `{get()}` handle
  // (schemastery/lib/index.cjs:480), not as its value. Reading the handle
  // directly made every field look like an empty object, so the credential
  // reference was never a string and the very first probe could not resolve.
  let current = 'from-reference'
  const reference = Object.freeze({ get: () => current })

  assert.equal(config_value(reference, 'fallback'), 'from-reference')
  current = 'after-a-settings-save'
  assert.equal(config_value(reference, 'fallback'), 'after-a-settings-save')

  // Plain values are still passed through untouched, including falsy ones.
  assert.equal(config_value('plain', 'fallback'), 'plain')
  assert.equal(config_value(false, true), false)
  assert.equal(config_value(0, 42), 0)

  // A missing or unreadable field uses the fallback.
  assert.equal(config_value(undefined, 'fallback'), 'fallback')
  assert.equal(config_value({ get: () => undefined }, 'fallback'), 'fallback')
})

test('inject waits for the initialized credential provider', () => {
  // Regression: with only `webServer` injected, activation did not wait for
  // `dsh-credentials-local` to run `[Service.init]`, which is what populates
  // the reference map (`dsh-credentials-local/lib/index.js:647`). The first
  // probe therefore read an empty store and the ledger was never written.
  assert.deepEqual(inject, ['webServer', 'credentials'])
})

// ------------------------------------------------------------ poll backoff

test('next_poll_delay_sec holds the cadence, doubles past the grace, then caps', () => {
  // Three failures are tolerated at the configured interval.
  assert.equal(next_poll_delay_sec(60, 0), 60)
  assert.equal(next_poll_delay_sec(60, 1), 60)
  assert.equal(next_poll_delay_sec(60, 3), 60)
  // Then each further consecutive failure doubles the wait ...
  assert.equal(next_poll_delay_sec(60, 4), 120)
  assert.equal(next_poll_delay_sec(60, 5), 240)
  assert.equal(next_poll_delay_sec(60, 6), 480)
  assert.equal(next_poll_delay_sec(60, 7), 960)
  // ... up to sixteen times the base, which is as bad as it gets.
  assert.equal(next_poll_delay_sec(60, 8), 960)
  assert.equal(next_poll_delay_sec(60, 500), 960)
})

test('next_poll_delay_sec refuses nonsense without inventing a huge wait', () => {
  // A missing or unusable base falls back to the floor the poll loop applies.
  assert.equal(next_poll_delay_sec(undefined, 0), 30)
  assert.equal(next_poll_delay_sec(0, 0), 30)
  assert.equal(next_poll_delay_sec(-5, 0), 30)
  assert.equal(next_poll_delay_sec(NaN, 0), 30)
  // A missing or unusable streak is read as "no failures yet", never as more.
  assert.equal(next_poll_delay_sec(60, undefined), 60)
  assert.equal(next_poll_delay_sec(60, -3), 60)
  assert.equal(next_poll_delay_sec(60, NaN), 60)
  assert.equal(next_poll_delay_sec(60, Infinity), 60)
  // A fraction is truncated toward zero rather than rounded up.
  assert.equal(next_poll_delay_sec(60, 4.9), 120)
  // The grace period is overridable, including down to zero.
  assert.equal(next_poll_delay_sec(60, 1, 0), 120)
  assert.equal(next_poll_delay_sec(60, 1, 10), 60)
  // A negative grace is not "no grace" - it is unusable, so it falls back to
  // the documented default rather than making the backoff start immediately.
  assert.equal(next_poll_delay_sec(60, 12, -1), next_poll_delay_sec(60, 12))
  assert.equal(next_poll_delay_sec(60, 12, -1), 960)
})

test('a failing probe backs the poll interval off, and a success resets it', async (t) => {
  // `fetch_throws` is read live from this object on every call, so the test can
  // heal the origin halfway through without unmounting the plugin.
  const options = { config: { poll_interval_sec: 30 }, fetch_throws: true }
  const app = await mount(t, options)

  // Drive the failure path one probe at a time. The first probe is fired by
  // activation itself, so the streak the first response reports is not fixed -
  // collect until the streak is well past the grace period and assert on the
  // pairs rather than on a fixed iteration count.
  const steps = []
  let body
  for (let i = 0; i < 12 && (body === undefined || body.consecutive_failures < 8); i += 1) {
    body = body_of(await app.call(`${API_PREFIX}/refresh`, make_request({ method: 'POST' })))
    steps.push({ streak: body.consecutive_failures, delay: body.next_probe_in_sec })
  }

  assert.ok(body.consecutive_failures >= 8, 'the failure path should have been exercised')
  assert.ok(typeof body.error === 'string' && body.error.length > 0)

  // Every observed pair is the policy's own answer for that streak.
  for (const step of steps) assert.equal(step.delay, next_poll_delay_sec(30, step.streak))

  const delay_at = new Map(steps.map((step) => [step.streak, step.delay]))
  assert.equal(delay_at.get(3), 30, 'the grace period keeps the configured cadence')
  assert.equal(delay_at.get(4), 60)
  assert.equal(delay_at.get(5), 120)
  assert.equal(delay_at.get(8), 480, 'the backoff caps at sixteen times the base')
  assert.ok(delay_at.get(8) > delay_at.get(3), 'the interval must actually grow')

  // The origin comes back: one good reading clears the streak and the wait.
  options.fetch_throws = false
  body = body_of(await app.call(`${API_PREFIX}/refresh`, make_request({ method: 'POST' })))
  assert.equal(body.consecutive_failures, 0)
  assert.equal(body.next_probe_in_sec, 30)
  assert.equal(body.error, undefined)
  assert.equal(body.balance.text, '$4.58')

  await app.dispose()
})
