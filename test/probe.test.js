import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_API_BASE_URL,
  normalize_base_url,
  parse_balance_payload,
  probe_balance,
  redact_secret,
  resolve_api_key,
} from '../lib/probe.js'

const SAMPLE_KEY = 'sk-0123456789abcdef0123456789abcdef'

function json_response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

test('normalize_base_url accepts only bare https origins', () => {
  assert.equal(normalize_base_url(DEFAULT_API_BASE_URL), 'https://api.deepseek.com')
  assert.equal(normalize_base_url('https://api.deepseek.com/'), 'https://api.deepseek.com')
  assert.equal(normalize_base_url('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1')
  assert.equal(normalize_base_url('https://proxy.internal:8443'), 'https://proxy.internal:8443')

  for (const bad of [
    'http://api.deepseek.com',
    'https://user:pass@api.deepseek.com',
    'https://api.deepseek.com?token=1',
    'https://api.deepseek.com#frag',
    'file:///etc/passwd',
    'api.deepseek.com',
    '',
    undefined,
  ]) {
    assert.equal(normalize_base_url(bad), undefined, `expected rejection for ${String(bad)}`)
  }
})

test('redact_secret removes key-shaped runs and truncates', () => {
  assert.equal(redact_secret(`failed with Bearer ${SAMPLE_KEY} at host`), 'failed with Bearer sk-*** at host')
  assert.equal(redact_secret('no secret here'), 'no secret here')
  assert.equal(redact_secret('x'.repeat(5000)).length, 300)
  assert.equal(redact_secret(undefined), '')
})

test('parse_balance_payload prefers USD and keeps amounts exact', () => {
  const parsed = parse_balance_payload({
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '33.10', granted_balance: '0.00', topped_up_balance: '33.10' },
      { currency: 'USD', total_balance: '4.58', granted_balance: '0.00', topped_up_balance: '4.58' },
    ],
  })
  assert.equal(parsed.status, 'ready')
  assert.equal(parsed.is_available, true)
  assert.equal(parsed.currency, 'USD')
  assert.equal(parsed.balance_units, 4_580_000)
  assert.equal(parsed.wallets.length, 2)
})

test('parse_balance_payload falls back to CNY and then the first wallet', () => {
  const cny = parse_balance_payload({ balance_infos: [{ currency: 'CNY', total_balance: '10.00' }] })
  assert.equal(cny.currency, 'CNY')
  assert.equal(cny.balance_units, 10_000_000)

  const other = parse_balance_payload({ balance_infos: [{ currency: 'USD', total_balance: '1.00' }] })
  assert.equal(other.currency, 'USD')
})

test('parse_balance_payload rejects unusable payloads', () => {
  for (const bad of [
    null,
    'string',
    [],
    42,
    {},
    { balance_infos: [] },
    { balance_infos: 'nope' },
    { balance_infos: [{ currency: 'EUR', total_balance: '1.00' }] },
    { balance_infos: [{ currency: 'USD', total_balance: 'NaN' }] },
    { balance_infos: [{ currency: 'USD' }] },
    { balance_infos: [null, 7, 'x'] },
  ]) {
    const parsed = parse_balance_payload(bad)
    assert.equal(parsed.status, 'failed', `expected failure for ${JSON.stringify(bad)}`)
  }
})

test('probe_balance sends the bearer header to the balance endpoint and refuses redirects', async () => {
  let seen_url
  let seen_options
  const result = await probe_balance({
    api_base_url: DEFAULT_API_BASE_URL,
    api_key: SAMPLE_KEY,
    fetch_impl: async (url, options) => {
      seen_url = url
      seen_options = options
      return json_response({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '4.58' }] })
    },
  })

  assert.equal(seen_url, 'https://api.deepseek.com/user/balance')
  assert.equal(seen_options.method, 'GET')
  assert.equal(seen_options.headers.authorization, `Bearer ${SAMPLE_KEY}`)
  assert.equal(seen_options.redirect, 'error', 'the key must never follow a redirect')
  assert.ok(seen_options.signal, 'a timeout signal bounds the request')
  assert.equal(result.status, 'ready')
  assert.equal(result.balance_units, 4_580_000)
})

test('probe_balance refuses a non-https base url before touching the network', async () => {
  let called = false
  const result = await probe_balance({
    api_base_url: 'http://api.deepseek.com',
    api_key: SAMPLE_KEY,
    fetch_impl: async () => {
      called = true
      return json_response({})
    },
  })
  assert.equal(result.status, 'failed')
  assert.equal(called, false)
})

test('probe_balance never leaks the key through a failure reason', async () => {
  const thrown = await probe_balance({
    api_base_url: DEFAULT_API_BASE_URL,
    api_key: SAMPLE_KEY,
    fetch_impl: async () => {
      throw new Error(`connect failed for Bearer ${SAMPLE_KEY}`)
    },
  })
  assert.equal(thrown.status, 'failed')
  assert.ok(!thrown.reason.includes(SAMPLE_KEY), 'raw key must not appear')
  assert.ok(thrown.reason.includes('sk-***'))

  const hostile = await probe_balance({
    api_base_url: DEFAULT_API_BASE_URL,
    api_key: SAMPLE_KEY,
    fetch_impl: async () => ({ ok: false, status: 401, json: async () => ({ echo: SAMPLE_KEY }) }),
  })
  assert.equal(hostile.reason, 'http 401', 'a rejected response body is not read or echoed')

  const not_error = await probe_balance({
    api_base_url: DEFAULT_API_BASE_URL,
    api_key: SAMPLE_KEY,
    fetch_impl: async () => {
      throw { message: SAMPLE_KEY }
    },
  })
  assert.ok(!not_error.reason.includes(SAMPLE_KEY), 'a non-Error throw is not read for a message')
})

test('resolve_api_key reports a clear reason without a credential store', async () => {
  const missing = await resolve_api_key({ get: () => undefined }, 'DEEPSEEK_API_KEY')
  assert.equal(missing.status, 'missing')
  assert.equal(missing.reason, 'credentials service unavailable')

  const throwing = await resolve_api_key(
    { get: () => ({ resolve: async () => undefined }) },
    'DEEPSEEK_API_KEY',
  )
  assert.equal(throwing.status, 'missing')
  assert.equal(throwing.reason, 'no credential stored for DEEPSEEK_API_KEY')
})

test('resolve_api_key asks for the credential provider non-strictly', async () => {
  // Regression: the provider's fiber is commonly still activating when this
  // plugin mounts, and strict mode reports such a provider as absent - which
  // surfaced as "credentials service unavailable" on the first probe.
  const calls = []
  const ready = await resolve_api_key(
    {
      get(name, strict) {
        calls.push([name, strict])
        return { resolve: async () => ({ value: SAMPLE_KEY, source: 'env' }) }
      },
    },
    'DEEPSEEK_API_KEY',
  )

  assert.equal(ready.status, 'ready')
  assert.equal(ready.api_key, SAMPLE_KEY)
  assert.deepEqual(calls, [['credentials', false]])
})

test('resolve_api_key returns the value and redacts a hostile error message', async () => {
  const ok = await resolve_api_key(
    { get: () => ({ resolve: async () => ({ value: SAMPLE_KEY, source: 'file' }) }) },
    'DEEPSEEK_API_KEY',
  )
  assert.equal(ok.status, 'ready')
  assert.equal(ok.api_key, SAMPLE_KEY)
  assert.equal(ok.source, 'file')

  const failed = await resolve_api_key(
    {
      get: () => ({
        resolve: async () => {
          throw new Error(`bad record containing ${SAMPLE_KEY}`)
        },
      }),
    },
    'DEEPSEEK_API_KEY',
  )
  assert.equal(failed.status, 'missing')
  assert.ok(!failed.reason.includes(SAMPLE_KEY))
})
