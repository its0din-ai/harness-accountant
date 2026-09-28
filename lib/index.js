/**
 * harness-accountant - host half.
 *
 * Owns the poll loop, the on-disk ledger, and the two loopback-only JSON
 * routes the browser half reads. It never hands the API key, the credential
 * reference, or the ledger path to the client.
 *
 * Deliberately dependency-light: `@deepseek-ai/schemastery` for the config
 * schema plus the two local modules. No bundler, no HTTP framework, no
 * storage library - `ctx.webServer` and `node:fs` are the whole surface.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import z from '@deepseek-ai/schemastery'

import {
  DEFAULT_UTC_OFFSET_MINUTES,
  create_ledger,
  deserialize_ledger,
  fold_sample,
  format_units,
  latest_closing_units,
  normalize_utc_offset,
  prune_ledger,
  serialize_ledger,
  summarize_range,
} from './ledger.js'
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_API_KEY_ENV,
  DEFAULT_MAX_RESPONSE_BYTES,
  probe_balance,
  redact_secret,
  resolve_api_key,
} from './probe.js'

export const name = 'harness-accountant'

/**
 * Both are hard requirements.
 *
 * The web server provides the routes. The credential provider must be *fully
 * initialized* before the first probe: its `[Service.init]` is what populates
 * the reference map (`dsh-credentials-local/lib/index.js:647`, via
 * `loadInitial`), so a plugin that only looks the service up lazily races that
 * load and reads an empty store on its first probe. `inject` is what makes the
 * loader defer activation until both are ready.
 *
 * Neither is really optional: both ship in `@deepseek-ai/dsh-base`, which every
 * profile's bundle list starts from.
 */
export const inject = ['webServer', 'credentials']

/** Every route lives under this prefix. */
export const API_PREFIX = '/api/harness-accountant'

/**
 * DeepSeek's published peak schedule, quoted from
 * https://api-docs.deepseek.com/quick_start/pricing : "Peak hours are 01:00 -
 * 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public
 * holidays. All other hours are off-peak, including weekends and Chinese public
 * holidays in full." Off-peak rates are half of peak.
 *
 * The host does not evaluate this. The client holds the clock and decides
 * whether `now` is peak, so the schedule travels as data and nothing is polled
 * to answer a question the wall clock already answers. `windows` are minutes
 * from midnight UTC, half-open (`[start, end)`) and never wrapping midnight;
 * `weekdays` uses `Date#getUTCDay` numbering, where 0 is Sunday.
 *
 * `holidays_modelled: false` is a deliberate omission rather than an oversight:
 * the published schedule excludes Chinese public holidays from peak, and this
 * plugin carries no holiday calendar, so on roughly eleven days a year it
 * reports peak while DeepSeek bills off-peak. The flag travels to the client so
 * the tooltip can say so instead of the omission staying invisible.
 */
export const PEAK_SCHEDULE = Object.freeze({
  reference: 'UTC',
  windows: Object.freeze([Object.freeze([60, 240]), Object.freeze([360, 600])]),
  weekdays: Object.freeze([1, 2, 3, 4, 5]),
  holidays_modelled: false,
})

/**
 * Config schema. Under the 0.1.7 settings model this schema IS the entry's
 * settings page, and `.volatile()` is what keeps a save from remounting the
 * loader row.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  poll_interval_sec: z.number().min(30).max(3600).default(60).volatile(),
  retain_days: z.number().min(7).max(730).default(400).volatile(),
  /**
   * Accounting-day offset from UTC, in minutes. The default 480 is UTC+08:00,
   * DeepSeek's billing day. This is a fixed offset, not a timezone: it does not
   * model daylight saving.
   */
  accounting_utc_offset_minutes: z.number().min(-720).max(840).default(DEFAULT_UTC_OFFSET_MINUTES).volatile(),
  /**
   * Which wallet the plugin follows. `auto` (the default) takes the first
   * usable wallet in the order the balance response lists them; `CNY` or `USD`
   * pins it. Read case-insensitively, and anything unrecognised falls back to
   * `auto`.
   *
   * A pin that the account stops reporting fails the probe by name rather than
   * being substituted, because a change of currency discards the ledger's whole
   * day series - the two are not comparable, and summing them would be
   * meaningless.
   *
   * A plain string rather than a closed set: this schema IS the entry's
   * settings page, and `@deepseek-ai/schemastery` here has no `enum`
   * (`z.enum` is undefined; only `const` and `union` exist), so a union would
   * be the first of its kind in this file and its rendering in the settings
   * page is unverified. A text field behaves exactly like `api_key_env`.
   */
  currency: z.string().default('auto').volatile(),
  api_key_env: z.string().default(DEFAULT_API_KEY_ENV).volatile(),
  api_base_url: z.string().default(DEFAULT_API_BASE_URL).volatile(),
  /**
   * Ceiling on the bytes the probe will buffer from a response body. A balance
   * payload is a few hundred bytes, so the default is pure headroom; the field
   * exists so a hostile or broken origin cannot make the host allocate without
   * bound.
   */
  max_response_bytes: z.number().min(1024).max(1_048_576).default(DEFAULT_MAX_RESPONSE_BYTES).volatile(),
})

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** Custom header the browser half always sends; see `is_same_origin_local_request`. */
const CLIENT_HEADER = 'x-harness-accountant'

/** Minimum accepted poll interval, in seconds, regardless of configuration. */
const MIN_POLL_SECONDS = 30

/**
 * Consecutive probe failures tolerated at the configured cadence before the
 * poll interval starts growing. A single transient error is not a reason to
 * slow down, and a service that blinks should be retried at the normal rate.
 */
const FAILURES_BEFORE_BACKOFF = 3

/** How many times the delay may double past the grace period, so 16x at most. */
const MAX_BACKOFF_DOUBLINGS = 4

/** Ledger retention default, kept in step with the `Config` schema. */
const DEFAULT_RETAIN_DAYS = 400

/**
 * Extract the hostname from a `Host` header, tolerating an IPv6 literal and a
 * port suffix.
 * @param host_header - raw header value.
 * @returns the lowercase hostname, `[... ]` preserved for IPv6.
 */
function hostname_of(host_header) {
  const normalized = host_header.trim().toLowerCase()
  if (normalized.startsWith('[')) {
    const end = normalized.indexOf(']')
    return end === -1 ? normalized : normalized.slice(0, end + 1)
  }
  const colon = normalized.lastIndexOf(':')
  return colon === -1 ? normalized : normalized.slice(0, colon)
}

/**
 * Decide whether a request may read or trigger a balance probe.
 *
 * Four checks, each closing a different hole:
 *  1. the socket peer is loopback - nothing off-box reaches these routes;
 *  2. the `Host` header names loopback - this is the DNS-rebinding defense,
 *     because a rebound request carries the attacker's domain in `Host` even
 *     though the socket peer is 127.0.0.1;
 *  3. `Sec-Fetch-Site`, when the browser sends it, is `same-origin`/`none` - a
 *     cross-site `fetch` to 127.0.0.1 would otherwise pass checks 1 and 2;
 *  4. a custom header is present - it forces a CORS preflight that this server
 *     never approves, which is what actually stops a cross-site POST from
 *     having its side effect.
 *
 * @param request - incoming request.
 * @returns `true` only when every check passes.
 */
export function is_same_origin_local_request(request) {
  const address = request.socket?.remoteAddress
  if (typeof address !== 'string' || !LOOPBACK_ADDRESSES.has(address)) return false

  const host_header = request.headers?.host
  if (typeof host_header !== 'string' || !LOOPBACK_HOSTNAMES.has(hostname_of(host_header))) return false

  const fetch_site = request.headers?.['sec-fetch-site']
  if (typeof fetch_site === 'string' && fetch_site !== 'same-origin' && fetch_site !== 'none') return false

  return request.headers?.[CLIENT_HEADER] === '1'
}

function write_json(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // Personal financial data: never cached, never sniffed, and - by never
    // sending an Access-Control-Allow-Origin - never readable cross-origin.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(payload)
}

function dsh_home() {
  const configured = process.env.DSH_HOME
  return typeof configured === 'string' && configured !== '' ? configured : join(homedir(), '.dsh')
}

/**
 * Read one delivered config field.
 *
 * Under the 0.1.7 settings model a `.volatile()` field is delivered as a
 * *reference*, never as its value: `schemastery/lib/index.cjs:480` returns
 * `createVolatile(schema.meta.default)`, which is a frozen `{get()}` handle.
 * The house idiom is therefore `field.get()` - see
 * `dsh-bash-local/lib/index.js:52` and `dsh-agent-loop/lib/index.js:553`.
 * Non-volatile fields arrive plain, so both shapes are accepted here.
 *
 * Reading through `.get()` at the point of use (rather than copying the value
 * once at mount) is also what lets a settings save reach the next probe.
 *
 * @param field - the field as delivered on the config object.
 * @param fallback - used when the field is absent or yields nothing.
 * @returns the current value.
 */
export function config_value(field, fallback) {
  if (field !== null && typeof field === 'object' && typeof field.get === 'function') {
    const current = field.get()
    return current === undefined ? fallback : current
  }
  return field === undefined ? fallback : field
}

/**
 * The accounting-day offset configured for this entry. `fold_sample`,
 * `prune_ledger` and `summarize_range` all take it, so every day key in the
 * ledger comes from one rule.
 */
function accounting_offset(state) {
  return config_value(state.config.accounting_utc_offset_minutes, DEFAULT_UTC_OFFSET_MINUTES)
}

/**
 * The wallet currency the operator pinned, or `undefined` for `auto`. The field
 * is a plain string, so it is read case-insensitively and trimmed; anything
 * that is not one of the two currencies the ledger knows reads as `auto` rather
 * than reaching the probe as a currency it would then refuse every cycle.
 */
function pinned_currency(config) {
  const configured = config_value(config === null || config === undefined ? undefined : config.currency, 'auto')
  const wanted = typeof configured === 'string' ? configured.trim().toUpperCase() : ''
  return wanted === 'CNY' || wanted === 'USD' ? wanted : undefined
}

function create_state(ctx, config) {
  // A pin also seeds the ledger, so a CNY operator sees CNY from the first
  // paint - including one that happens before any probe has succeeded. Without
  // a pin the placeholder is USD, which is only ever a placeholder: the first
  // good reading replaces it with what the response actually reports.
  const pinned = pinned_currency(config)
  return {
    ctx,
    config,
    ledger_path: join(dsh_home(), 'harness-accountant', 'ledger.json'),
    ledger: create_ledger(pinned ?? 'USD'),
    ledger_loaded: false,
    ledger_notice: undefined,
    timer: undefined,
    probe_promise: undefined,
    stopped: false,
    failure_streak: 0,
    next_delay_sec: undefined,
    last_probe_at: 0,
    last_ok_at: 0,
    last_error: undefined,
    credential_source: undefined,
    is_available: false,
    wallets: [],
    balance_units: undefined,
    currency: pinned ?? 'USD',
    pending_write: Promise.resolve(),
  }
}

/**
 * Read the ledger from disk, if it is there.
 *
 * Whatever this layer finds is reported through `ledger_notice` rather than
 * `last_error`: `last_error` is the probe's channel and every probe rewrites
 * it, so a refusal parked there would be gone by the time the route answered.
 * @param state - plugin state.
 */
async function load_ledger(state) {
  if (state.ledger_loaded) return
  state.ledger_loaded = true

  let text
  try {
    text = await readFile(state.ledger_path, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') state.ledger_notice = 'ledger file could not be read'
    return
  }

  const result = deserialize_ledger(text)
  if (result.status === 'failed') {
    /*
     * The file will not be read, and the next successful probe would write
     * straight over it. Move it aside first so a refusal never destroys the
     * data: the rename takes the 0600 mode and the 0700 directory with it, and
     * the fixed name means only the most recent refusal is kept. The path is
     * deliberately not echoed - the client is never told where the ledger lives.
     */
    try {
      await rename(state.ledger_path, `${state.ledger_path}.incompatible`)
      state.ledger_notice = `${result.reason}; the file was moved aside`
    } catch {
      state.ledger_notice = `${result.reason}; the file could not be moved aside`
    }
    return
  }

  state.ledger = result.ledger
  state.currency = result.ledger.currency
  if (result.migrated_from !== undefined) {
    state.ledger_notice = `ledger upgraded from schema version ${result.migrated_from} to ${result.ledger.version}`
  }
}

/**
 * Queue an atomic ledger write. Writes are serialized through one promise
 * chain so two overlapping probes cannot interleave a tmp-file rename, and the
 * chain is kept non-rejecting so a failed write never wedges the next one.
 * @param state - plugin state.
 * @returns a promise that settles when this write (and any earlier one) is done.
 */
function persist_ledger(state) {
  // Stamp the offset in force, so the file says how its day keys were bucketed.
  state.ledger.accounting_utc_offset_minutes = normalize_utc_offset(accounting_offset(state))
  const snapshot = serialize_ledger(state.ledger)
  state.pending_write = state.pending_write
    .then(async () => {
      await mkdir(dirname(state.ledger_path), { recursive: true, mode: 0o700 })
      const temporary = `${state.ledger_path}.tmp`
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, state.ledger_path)
    })
    .catch(() => {
      state.last_error = 'ledger write failed'
    })
  return state.pending_write
}

/**
 * Run one probe cycle: resolve the key, ask DeepSeek, fold the reading in,
 * persist. Never throws - failures land in `state.last_error` so the route can
 * report them without the process dying.
 *
 * Concurrent callers join the in-flight cycle instead of racing it, which is
 * what lets the overview route await the very first probe rather than render
 * an empty card behind it.
 * @param state - plugin state.
 * @returns a promise settling when this cycle (not necessarily this caller's) is done.
 */
function run_probe(state) {
  if (state.probe_promise !== undefined) return state.probe_promise
  if (state.stopped) return Promise.resolve()

  state.probe_promise = (async () => {
    try {
      await load_ledger(state)
      state.last_probe_at = Date.now()

      const key = await resolve_api_key(state.ctx, config_value(state.config.api_key_env, DEFAULT_API_KEY_ENV))
      if (key.status !== 'ready') {
        record_probe_failure(state, key.reason)
        return
      }

      const result = await probe_balance({
        api_base_url: config_value(state.config.api_base_url, DEFAULT_API_BASE_URL),
        api_key: key.api_key,
        max_response_bytes: config_value(state.config.max_response_bytes, DEFAULT_MAX_RESPONSE_BYTES),
        preferred_currency: pinned_currency(state.config),
      })
      if (result.status !== 'ready') {
        record_probe_failure(state, result.reason)
        return
      }

      state.balance_units = result.balance_units
      state.currency = result.currency
      state.wallets = result.wallets
      state.is_available = result.is_available
      state.credential_source = key.source
      state.last_ok_at = Date.now()
      state.last_error = undefined
      // A good reading clears the streak, so the delay collapses back to the
      // configured interval on the very next cycle.
      state.failure_streak = 0

      fold_sample(
        state.ledger,
        {
          at: state.last_ok_at,
          units: result.balance_units,
          currency: result.currency,
        },
        accounting_offset(state),
      )
      prune_ledger(
        state.ledger,
        config_value(state.config.retain_days, DEFAULT_RETAIN_DAYS),
        state.last_ok_at,
        accounting_offset(state),
      )
      await persist_ledger(state)
    } catch (error) {
      record_probe_failure(state, redact_secret(error instanceof Error ? error.message : 'probe failed'))
    } finally {
      state.probe_promise = undefined
    }
  })()

  return state.probe_promise
}

function build_range(state, now_ms, days) {
  const summary = summarize_range(state.ledger, now_ms, days, accounting_offset(state))
  return {
    days: summary.days,
    start_date: summary.start_key,
    end_date: summary.end_key,
    spend_units: summary.spend_units,
    spend_text: format_units(summary.spend_units, state.currency),
    topup_units: summary.topup_units,
    topup_text: format_units(summary.topup_units, state.currency),
    samples: summary.samples,
    day_list: summary.day_list.map((entry) => ({
      date: entry.date,
      spend_units: entry.spend_units,
      spend_text: format_units(entry.spend_units, state.currency),
      topup_units: entry.topup_units,
      samples: entry.samples,
    })),
  }
}

/**
 * Shape the client payload. Field-by-field rather than spreading internal
 * state, so nothing added to `state` later can leak by accident.
 * @param state - plugin state.
 * @param now_ms - reference instant.
 * @returns a JSON-serializable overview.
 */
function build_overview(state, now_ms) {
  const current_units = state.balance_units ?? latest_closing_units(state.ledger)
  return {
    ok: true,
    currency: state.currency,
    peak: PEAK_SCHEDULE,
    balance:
      current_units === undefined
        ? undefined
        : {
            units: current_units,
            text: format_units(current_units, state.currency),
            is_available: state.is_available,
            wallets: state.wallets.map((wallet) => ({
              currency: wallet.currency,
              text: format_units(wallet.units, wallet.currency),
            })),
          },
    credential_source: state.credential_source,
    ledger_notice: state.ledger_notice,
    consecutive_failures: state.failure_streak,
    next_probe_in_sec: state.next_delay_sec,
    last_ok_at: state.last_ok_at === 0 ? undefined : state.last_ok_at,
    last_probe_at: state.last_probe_at === 0 ? undefined : state.last_probe_at,
    error: state.last_error,
    ranges: {
      day: build_range(state, now_ms, 1),
      week: build_range(state, now_ms, 7),
      month: build_range(state, now_ms, 30),
    },
  }
}

function guard(request, response, method) {
  if (!is_same_origin_local_request(request)) {
    write_json(response, 403, { ok: false, error: 'forbidden' })
    return false
  }
  if (request.method !== method) {
    write_json(response, 405, { ok: false, error: 'method not allowed' })
    return false
  }
  return true
}

function make_overview_route(state) {
  return {
    kind: 'exact',
    path: `${API_PREFIX}/overview`,
    handler: async (request, response) => {
      if (!guard(request, response, 'GET')) return
      // Serve the first paint from a live probe rather than an empty card -
      // but only while polling is on, so `enabled: false` really is inert and
      // an explicit refresh stays the one way to probe by hand.
      if (config_value(state.config.enabled, true) !== false && state.last_probe_at === 0) await run_probe(state)
      write_json(response, 200, build_overview(state, Date.now()))
    },
  }
}

function make_refresh_route(state) {
  return {
    kind: 'exact',
    path: `${API_PREFIX}/refresh`,
    handler: async (request, response) => {
      if (!guard(request, response, 'POST')) return
      await run_probe(state)
      // A manual probe re-arms the clock, so the next automatic wait reflects
      // the streak this probe left behind rather than the previous one's.
      schedule_next_probe(state)
      write_json(response, 200, build_overview(state, Date.now()))
    },
  }
}

/**
 * Delay before the next probe, in seconds, given the current failure streak.
 *
 * The first `failures_before_backoff` failures keep the configured cadence: a
 * brief outage is not a reason to slow the poll down. Past that the delay
 * doubles per consecutive failure, capped at `MAX_BACKOFF_DOUBLINGS`
 * doublings, so a long outage settles at one probe per 16 intervals instead of
 * hammering an origin that is already unhappy.
 * @param base_seconds - the configured interval, already floored.
 * @param failure_streak - consecutive failed probes so far.
 * @param failures_before_backoff - grace period before the doubling starts.
 * @returns the delay in seconds.
 */
export function next_poll_delay_sec(base_seconds, failure_streak, failures_before_backoff = FAILURES_BEFORE_BACKOFF) {
  const base = Number.isFinite(base_seconds) && base_seconds > 0 ? base_seconds : MIN_POLL_SECONDS
  const streak = Number.isFinite(failure_streak) && failure_streak > 0 ? Math.trunc(failure_streak) : 0
  const grace =
    Number.isFinite(failures_before_backoff) && failures_before_backoff >= 0
      ? Math.trunc(failures_before_backoff)
      : FAILURES_BEFORE_BACKOFF
  if (streak <= grace) return base
  return base * 2 ** Math.min(streak - grace, MAX_BACKOFF_DOUBLINGS)
}

/**
 * Record one failed probe: the reason the route reports, plus the streak that
 * decides how long to wait before trying again.
 * @param state - plugin state.
 * @param reason - human-readable failure text.
 */
function record_probe_failure(state, reason) {
  state.last_error = reason
  state.failure_streak += 1
}

/**
 * The configured poll interval, floored at `MIN_POLL_SECONDS`.
 * @param state - plugin state.
 * @returns the base interval in seconds.
 */
function poll_base_seconds(state) {
  const configured = Number(config_value(state.config.poll_interval_sec, 60))
  return Number.isFinite(configured) ? Math.max(configured, MIN_POLL_SECONDS) : 60
}

function stop_polling(state) {
  if (state.timer !== undefined) {
    clearTimeout(state.timer)
    state.timer = undefined
  }
  state.next_delay_sec = undefined
}

/**
 * Arm the next probe. One `setTimeout` at a time rather than a fixed
 * `setInterval`, because the delay now depends on how the last probe went.
 * @param state - plugin state.
 */
function schedule_next_probe(state) {
  if (state.stopped) return
  if (config_value(state.config.enabled, true) === false) return
  const delay_sec = next_poll_delay_sec(poll_base_seconds(state), state.failure_streak)
  state.next_delay_sec = delay_sec
  state.timer = setTimeout(() => {
    state.timer = undefined
    state.next_delay_sec = undefined
    void run_probe(state).then(() => schedule_next_probe(state))
  }, delay_sec * 1000)
  // Do not let the poll timer hold the host process open.
  if (typeof state.timer.unref === 'function') state.timer.unref()
}

function start_polling(state) {
  stop_polling(state)
  if (config_value(state.config.enabled, true) === false) return
  state.failure_streak = 0
  void run_probe(state).then(() => schedule_next_probe(state))
}

const MOUNTED_SYMBOL = Symbol.for('harness-accountant.mounted')
const WAITERS_SYMBOL = Symbol.for('harness-accountant.mounted.waiters')

function begin_mount(ctx, config, package_name, setup) {
  const mounted = (globalThis[MOUNTED_SYMBOL] ??= new Set())
  mounted.add(package_name)
  ctx.effect(() => {
    const dispose = setup(ctx, config)
    return () => {
      try {
        dispose?.()
      } finally {
        mounted.delete(package_name)
        const waiters = (globalThis[WAITERS_SYMBOL] ??= [])
        const next = waiters.shift()
        if (next !== undefined) queueMicrotask(next)
      }
    }
  }, `${package_name}: runtime`)
}

/**
 * Guard against the reload race the loader creates: a replacement loader entry
 * is constructed before the old one is disposed, so an unguarded second mount
 * would be refused by the loader and the plugin would stay dead while its row
 * still read "active". A refused mount is queued and replayed one microtask
 * after the holder releases.
 * @param package_name - stable identity for the mount slot.
 * @param setup - receives `(ctx, config)`, returns a disposer.
 * @returns a cordis plugin `apply` function.
 */
export function mount_once(package_name, setup) {
  return (ctx, config) => {
    const mounted = (globalThis[MOUNTED_SYMBOL] ??= new Set())
    if (mounted.has(package_name)) {
      const waiters = (globalThis[WAITERS_SYMBOL] ??= [])
      waiters.push(() => begin_mount(ctx, config, package_name, setup))
      return
    }
    begin_mount(ctx, config, package_name, setup)
  }
}

export const apply = mount_once(name, (ctx, config) => {
  const state = create_state(ctx, config)

  const disposers = [
    ctx.webServer.register(make_overview_route(state)),
    ctx.webServer.register(make_refresh_route(state)),
  ]

  // A settings save commits into the running fiber instead of remounting it,
  // so re-read the new values and restart the timer on this signal only.
  ctx.on('loader/volatile-update', () => {
    state.config = config
    start_polling(state)
  })

  start_polling(state)

  return () => {
    state.stopped = true
    stop_polling(state)
    for (const dispose of disposers) dispose()
  }
})
