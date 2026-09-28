/**
 * harness-accountant — DeepSeek balance probe.
 *
 * The only place in this plugin that touches a secret or the network. It is
 * kept separate from the ledger and the HTTP surface so that the whole
 * secret-handling surface is one short file that can be reviewed at once.
 *
 * Rules this file holds to:
 *  - the API key is read from the harness credential store per operation and
 *    is never cached, never logged, and never placed in a return value;
 *  - the key only ever travels to an `https:` origin, with redirects refused
 *    so it cannot be re-sent to a host the operator did not configure;
 *  - no response body, header, or endpoint text is ever echoed into an error
 *    string, because those can contain the request that was just authorized.
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'

import { parse_decimal_to_units } from './ledger.js'

/** DeepSeek public API origin. Overridable, but only to another https origin. */
export const DEFAULT_API_BASE_URL = 'https://api.deepseek.com'

/** Environment-variable name the credential store is asked for. */
export const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

const BALANCE_PATH = '/user/balance'
const PROBE_TIMEOUT_MS = 15_000
const MAX_ERROR_CHARS = 300
const ALLOWED_CURRENCIES = new Set(['CNY', 'USD'])

/** Key-shaped runs, redacted out of any text that might reach a log or the UI. */
const SECRET_SHAPE = /sk-[A-Za-z0-9_-]{4,}/g

function message_of(error) {
  // Deliberately narrow: reading `.message` off an arbitrary value would run
  // attacker-controlled property access or `toString`.
  return error instanceof Error ? error.message : 'unknown error'
}

/**
 * Remove anything key-shaped from text before it is stored or displayed.
 * @param text - candidate diagnostic text.
 * @returns the text, truncated, with `sk-…` runs replaced by `sk-***`.
 */
export function redact_secret(text) {
  const trimmed = typeof text === 'string' ? text.slice(0, MAX_ERROR_CHARS) : ''
  return trimmed.replace(SECRET_SHAPE, 'sk-***')
}

/**
 * Validate and normalize a configured API base URL.
 * @param raw - operator-supplied base URL.
 * @returns the origin (plus any path prefix) without a trailing slash, or
 * `undefined` when the value is not a bare `https:` origin. Plain `http:` is
 * refused outright — it would put the API key on the wire in clear text.
 */
export function normalize_base_url(raw) {
  if (typeof raw !== 'string') return undefined
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:') return undefined
  if (parsed.username !== '' || parsed.password !== '') return undefined
  if (parsed.search !== '' || parsed.hash !== '') return undefined
  return parsed.origin + parsed.pathname.replace(/\/+$/, '')
}

/**
 * Resolve the API key for one operation through the harness credential store.
 *
 * The store is looked up without an `inject` requirement so the plugin still
 * loads (and reports a clear reason) when credentials are not mounted.
 *
 * @param ctx - host context.
 * @param env_name - POSIX-style reference name, e.g. `DEEPSEEK_API_KEY`.
 * @returns `{status:'ready', api_key, source}` or `{status:'missing', reason}`.
 */
export async function resolve_api_key(ctx, env_name) {
  let credentials
  try {
    credentials = ctx.get('credentials')
  } catch {
    credentials = undefined
  }
  if (credentials === undefined || typeof credentials.resolve !== 'function') {
    return { status: 'missing', reason: 'credentials service unavailable' }
  }

  let resolved
  try {
    resolved = await credentials.resolve(credentialRef(env_name))
  } catch (error) {
    return { status: 'missing', reason: `credential lookup failed: ${redact_secret(message_of(error))}` }
  }

  if (resolved === undefined || typeof resolved.value !== 'string' || resolved.value.trim() === '') {
    return { status: 'missing', reason: `no credential stored for ${redact_secret(env_name)}` }
  }

  return {
    status: 'ready',
    api_key: resolved.value,
    source: typeof resolved.source === 'string' ? redact_secret(resolved.source) : 'unknown',
  }
}

/**
 * Extract the spendable balance from a `/user/balance` payload.
 *
 * Currency is restricted to the two the ledger knows, so a hostile or broken
 * response cannot push an arbitrary string into storage or the UI. USD is
 * preferred when the account reports both wallets, matching what the account
 * service displays.
 *
 * @param payload - parsed JSON body.
 * @returns `{status:'ready', ...}` or `{status:'failed', reason}`.
 */
export function parse_balance_payload(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { status: 'failed', reason: 'unexpected response shape' }
  }

  const infos = Array.isArray(payload.balance_infos) ? payload.balance_infos : []
  const wallets = []
  for (const info of infos) {
    if (typeof info !== 'object' || info === null || Array.isArray(info)) continue
    const currency = ALLOWED_CURRENCIES.has(info.currency) ? info.currency : undefined
    const units = parse_decimal_to_units(info.total_balance)
    if (currency === undefined || units === undefined) continue
    wallets.push({ currency, units })
  }

  const wallet =
    wallets.find((candidate) => candidate.currency === 'USD') ??
    wallets.find((candidate) => candidate.currency === 'CNY') ??
    wallets[0]
  if (wallet === undefined) return { status: 'failed', reason: 'no usable balance in response' }

  return {
    status: 'ready',
    is_available: payload.is_available === true,
    wallets,
    balance_units: wallet.units,
    currency: wallet.currency,
  }
}

/**
 * Perform one balance probe.
 * @param options - `{api_base_url, api_key, fetch_impl?, timeout_ms?}`.
 * @returns `{status:'ready', ...}` or `{status:'failed', reason}`. The failure
 * shape never carries the key, the request, or the response body.
 */
export async function probe_balance(options) {
  const base_url = normalize_base_url(options.api_base_url)
  if (base_url === undefined) {
    return { status: 'failed', reason: 'api_base_url must be a bare https origin' }
  }

  const fetch_impl = options.fetch_impl ?? globalThis.fetch
  if (typeof fetch_impl !== 'function') {
    return { status: 'failed', reason: 'fetch is unavailable' }
  }

  let response
  try {
    response = await fetch_impl(`${base_url}${BALANCE_PATH}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${options.api_key}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeout_ms ?? PROBE_TIMEOUT_MS),
    })
  } catch (error) {
    return { status: 'failed', reason: `request failed: ${redact_secret(message_of(error))}` }
  }

  if (response.ok !== true) {
    // The body is intentionally not read: an error page or proxy notice can
    // echo the request it just rejected.
    return { status: 'failed', reason: `http ${response.status}` }
  }

  let payload
  try {
    payload = await response.json()
  } catch {
    return { status: 'failed', reason: 'response was not json' }
  }

  return parse_balance_payload(payload)
}
