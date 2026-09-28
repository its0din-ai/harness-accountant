import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

import {
  DEFAULT_UTC_OFFSET_MINUTES,
  LEDGER_VERSION,
  UNITS_PER_UNIT,
  accounting_date_key,
  accounting_day_offset_key,
  create_ledger,
  deserialize_ledger,
  fold_sample,
  format_units,
  latest_closing_units,
  normalize_utc_offset,
  parse_decimal_to_units,
  prune_ledger,
  serialize_ledger,
  summarize_range,
} from '../lib/ledger.js'

/** Path the child-process timezone probe imports. */
const LEDGER_MODULE_URL = new URL('../lib/ledger.js', import.meta.url).href

/**
 * The accounting-day offset these tests pin the boundary at. Passing it in is
 * the point of the rule under test: a runner in any timezone must see the same
 * days, so the tests never rely on the ambient one.
 */
const UTC = 0
const SHANGHAI = 480

/** An instant built from UTC fields, so assertions do not depend on the runner's timezone. */
function at(year, month, day, hour = 12, minute = 0) {
  return Date.UTC(year, month - 1, day, hour, minute, 0, 0)
}

/** Day-key assertions below are stated at UTC; production runs at SHANGHAI. */
const fold = (ledger, sample) => fold_sample(ledger, sample, UTC)
const prune = (ledger, retain_days, now_ms) => prune_ledger(ledger, retain_days, now_ms, UTC)
const summarize = (ledger, now_ms, days) => summarize_range(ledger, now_ms, days, UTC)

test('parse_decimal_to_units reads plain decimals', () => {
  assert.equal(parse_decimal_to_units('4.58'), 4_580_000)
  assert.equal(parse_decimal_to_units('0.00'), 0)
  assert.equal(parse_decimal_to_units('12'), 12 * UNITS_PER_UNIT)
  assert.equal(parse_decimal_to_units(' 4.5 '), 4_500_000)
  assert.equal(parse_decimal_to_units('-1.25'), -1_250_000)
  assert.equal(parse_decimal_to_units('4.5812349'), 4_581_234, 'truncates past six digits')
})

test('parse_decimal_to_units refuses anything that is not a decimal', () => {
  for (const bad of ['', 'abc', '1e3', '4.5.6', null, undefined, 4.58, {}, [], 'NaN', 'Infinity', '0x10']) {
    assert.equal(parse_decimal_to_units(bad), undefined, `expected undefined for ${String(bad)}`)
  }
  assert.equal(parse_decimal_to_units('9999999999'), undefined, 'beyond safe-integer range')
})

test('format_units renders two fractional digits and a currency symbol', () => {
  assert.equal(format_units(4_580_000, 'USD'), '$4.58')
  assert.equal(format_units(0, 'CNY'), '\u00a50.00')
  assert.equal(format_units(1_200_000_000, 'USD'), '$1200.00')
  assert.equal(format_units(-2_500_000, 'USD'), '-$2.50')
})

test('fold_sample opens the first day at its own reading and records no spend', () => {
  const ledger = create_ledger('USD')
  fold(ledger, { at: at(2026, 9, 28), units: 4_580_000, currency: 'USD' })
  const day = ledger.days['2026-09-28']
  assert.equal(day.opening_units, 4_580_000)
  assert.equal(day.closing_units, 4_580_000)
  assert.equal(day.spend_units, 0)
  assert.equal(day.topup_units, 0)
  assert.equal(day.samples, 1)
})

test('fold_sample counts drops as spend and rises as top-ups', () => {
  const ledger = create_ledger('USD')
  fold(ledger, { at: at(2026, 9, 28, 9), units: 5_000_000, currency: 'USD' })
  fold(ledger, { at: at(2026, 9, 28, 10), units: 4_700_000, currency: 'USD' })
  fold(ledger, { at: at(2026, 9, 28, 11), units: 4_600_000, currency: 'USD' })
  fold(ledger, { at: at(2026, 9, 28, 12), units: 14_600_000, currency: 'USD' })
  const day = ledger.days['2026-09-28']
  assert.equal(day.spend_units, 400_000)
  assert.equal(day.topup_units, 10_000_000, 'a top-up does not cancel recorded spend')
  assert.equal(day.closing_units, 14_600_000)
  assert.equal(day.samples, 4)
})

test('a new day opens at the previous day close', () => {
  const ledger = create_ledger('USD')
  fold(ledger, { at: at(2026, 9, 28, 23), units: 4_000_000, currency: 'USD' })
  fold(ledger, { at: at(2026, 9, 29, 1), units: 3_900_000, currency: 'USD' })
  assert.equal(ledger.days['2026-09-29'].opening_units, 4_000_000, 'spend across midnight is not lost')
  assert.equal(ledger.days['2026-09-29'].spend_units, 100_000)
})

test('an unchanged reading adds a sample but no spend', () => {
  const ledger = create_ledger('USD')
  fold(ledger, { at: at(2026, 9, 28, 9), units: 4_000_000, currency: 'USD' })
  fold(ledger, { at: at(2026, 9, 28, 10), units: 4_000_000, currency: 'USD' })
  assert.equal(ledger.days['2026-09-28'].spend_units, 0)
  assert.equal(ledger.days['2026-09-28'].samples, 2)
})

test('a currency change starts a fresh series', () => {
  const ledger = create_ledger('USD')
  fold(ledger, { at: at(2026, 9, 28), units: 4_000_000, currency: 'USD' })
  fold(ledger, { at: at(2026, 9, 29), units: 30_000_000, currency: 'CNY' })
  assert.equal(ledger.currency, 'CNY')
  assert.deepEqual(Object.keys(ledger.days), ['2026-09-29'])
})

test('summarize_range windows the ledger by calendar day', () => {
  const ledger = create_ledger('USD')
  const now = at(2026, 9, 28)
  for (let offset = 40; offset >= 0; offset -= 1) {
    fold(ledger, { at: now - offset * 86_400_000, units: 10_000_000, currency: 'USD' })
    fold(ledger, { at: now - offset * 86_400_000, units: 9_000_000, currency: 'USD' })
  }

  const one_day = summarize(ledger, now, 1)
  assert.equal(one_day.day_list.length, 1)
  assert.equal(one_day.spend_units, 1_000_000)

  const week = summarize(ledger, now, 7)
  assert.equal(week.day_list.length, 7)
  assert.equal(week.spend_units, 7_000_000)

  const month = summarize(ledger, now, 30)
  assert.equal(month.day_list.length, 30)
  assert.equal(month.spend_units, 30_000_000)
  assert.deepEqual(month.day_list.map((d) => d.date), [...month.day_list.map((d) => d.date)].sort())
})

test('accounting_date_key reads the configured offset, not the host zone', () => {
  // UTC: the boundary is 00:00Z.
  assert.equal(accounting_date_key(at(2026, 9, 28, 23, 59), UTC), '2026-09-28')
  assert.equal(accounting_date_key(at(2026, 9, 29, 0, 0), UTC), '2026-09-29')

  // UTC+08:00: Beijing midnight is 16:00Z the day before.
  assert.equal(accounting_date_key(at(2026, 9, 28, 15, 59), SHANGHAI), '2026-09-28')
  assert.equal(accounting_date_key(at(2026, 9, 28, 16, 0), SHANGHAI), '2026-09-29')

  // A negative offset reaches back a day instead.
  assert.equal(accounting_date_key(at(2026, 9, 28, 3, 0), -480), '2026-09-27')
  assert.equal(accounting_date_key(at(2026, 9, 28, 12, 0), -480), '2026-09-28')

  assert.equal(DEFAULT_UTC_OFFSET_MINUTES, SHANGHAI, 'the default is DeepSeek\'s billing day')
})

test('accounting_day_offset_key steps whole accounting days', () => {
  const now = at(2026, 3, 1)
  assert.equal(accounting_date_key(now, UTC), '2026-03-01')
  assert.equal(accounting_day_offset_key(now, 1, UTC), '2026-02-28')
  assert.equal(accounting_day_offset_key(now, 29, UTC), '2026-01-31')
  assert.equal(accounting_day_offset_key(now, 0, UTC), '2026-03-01')
  assert.equal(accounting_day_offset_key(now, -1, UTC), '2026-03-02', 'a negative step walks forward')
})

test('the accounting day is identical across the host DST transitions', () => {
  // Instants bracketing the 2026 US transitions (08 Mar and 01 Nov). A host
  // zone that observes DST moves its own local day here; the accounting key
  // must not move with it.
  const instants = [at(2026, 3, 8, 6, 30), at(2026, 3, 8, 7, 30), at(2026, 11, 1, 5, 30), at(2026, 11, 1, 6, 30)]
  const expected = instants.map((epoch_ms) => accounting_date_key(epoch_ms, SHANGHAI))

  for (const tz of ['America/New_York', 'Europe/Berlin', 'Australia/Lord_Howe', 'Pacific/Kiritimati']) {
    const observed = instants.map((epoch_ms) => accounting_date_key_in_timezone(tz, epoch_ms, SHANGHAI))
    assert.deepEqual(observed, expected, `${tz} must not shift the accounting day`)
  }
  assert.deepEqual(expected, ['2026-03-08', '2026-03-08', '2026-11-01', '2026-11-01'])
})

test('a whole accounting day is always 86_400_000 ms long', () => {
  // Walk two years of instants across both 2026 US transitions and a leap day;
  // every 24h step must land exactly one calendar day later, never zero and
  // never two.
  const start = at(2026, 1, 1)
  let previous = accounting_date_key(start, SHANGHAI)
  for (let day = 1; day <= 730; day += 1) {
    const key = accounting_date_key(start + day * 86_400_000, SHANGHAI)
    assert.equal(key, accounting_day_offset_key(start + day * 86_400_000, 0, SHANGHAI))
    assert.equal(key_date_diff(previous, key), 1, `${previous} -> ${key} must be one day (step ${day})`)
    previous = key
  }
})

test('a malformed configured offset falls back to the documented default', () => {
  for (const bad of ['480', null, undefined, NaN, Number.POSITIVE_INFINITY, {}, [], 1e9, -1e9]) {
    assert.equal(normalize_utc_offset(bad), DEFAULT_UTC_OFFSET_MINUTES, `expected fallback for ${String(bad)}`)
  }
  assert.equal(normalize_utc_offset(0), 0)
  assert.equal(normalize_utc_offset(-720), -720)
  assert.equal(normalize_utc_offset(840), 840)
  assert.equal(normalize_utc_offset(480.9), 480, 'fractional minutes truncate')
  assert.equal(accounting_date_key(at(2026, 9, 28, 16, 0), 'nonsense'), '2026-09-29', 'the key uses the fallback')
})

test('prune_ledger keeps the retention window and clamps absurd input', () => {
  const ledger = create_ledger('USD')
  const now = at(2026, 9, 28)
  for (let offset = 60; offset >= 0; offset -= 1) {
    fold(ledger, { at: now - offset * 86_400_000, units: 5_000_000, currency: 'USD' })
  }
  prune(ledger, 7, now)
  assert.equal(Object.keys(ledger.days).length, 7)

  prune(ledger, 0, now)
  assert.equal(Object.keys(ledger.days).length, 1, 'retention clamps to at least today')

  prune(ledger, Number.POSITIVE_INFINITY, now)
  assert.equal(Object.keys(ledger.days).length, 1, 'infinite retention must not delete everything')
})

test('latest_closing_units reports the newest day', () => {
  const ledger = create_ledger('USD')
  assert.equal(latest_closing_units(ledger), undefined)
  fold(ledger, { at: at(2026, 9, 27), units: 5_000_000, currency: 'USD' })
  fold(ledger, { at: at(2026, 9, 28), units: 4_000_000, currency: 'USD' })
  assert.equal(latest_closing_units(ledger), 4_000_000)
})

test('serialize then deserialize round-trips', () => {
  const ledger = create_ledger('USD')
  fold(ledger, { at: at(2026, 9, 28, 9), units: 5_000_000, currency: 'USD' })
  fold(ledger, { at: at(2026, 9, 28, 10), units: 4_000_000, currency: 'USD' })
  ledger.accounting_utc_offset_minutes = -300
  const restored = deserialize_ledger(serialize_ledger(ledger))
  assert.equal(restored.status, 'ready')
  assert.equal(restored.migrated_from, undefined, 'a current document is not migrated')
  assert.equal(restored.ledger.version, LEDGER_VERSION)
  assert.equal(restored.ledger.currency, 'USD')
  assert.equal(restored.ledger.accounting_utc_offset_minutes, -300, 'the offset survives the round trip')
  assert.deepEqual(restored.ledger.days['2026-09-28'], ledger.days['2026-09-28'])
})

test('a version-1 document is migrated rather than refused', () => {
  const v1 = JSON.stringify({
    version: 1,
    currency: 'CNY',
    days: {
      '2026-09-28': { opening_units: 0, closing_units: 1, spend_units: 1, topup_units: 0, samples: 2, last_at: 1 },
    },
  })
  const result = deserialize_ledger(v1)
  assert.equal(result.status, 'ready')
  assert.equal(result.migrated_from, 1)
  assert.equal(result.ledger.version, LEDGER_VERSION)
  assert.equal(result.ledger.currency, 'CNY')
  assert.equal(
    result.ledger.accounting_utc_offset_minutes,
    DEFAULT_UTC_OFFSET_MINUTES,
    'version 1 could only have bucketed days at the default offset',
  )
  assert.equal(result.ledger.days['2026-09-28'].spend_units, 1)
})

test('a document older than the first migration is refused with a reason', () => {
  const result = deserialize_ledger(JSON.stringify({ version: 0, currency: 'USD', days: {} }))
  assert.equal(result.status, 'failed')
  assert.match(result.reason, /version 0 is older/)
})

test('a document from a newer plugin is refused with a reason', () => {
  const result = deserialize_ledger(JSON.stringify({ version: LEDGER_VERSION + 1, currency: 'USD', days: {} }))
  assert.equal(result.status, 'failed')
  assert.match(result.reason, /newer than this plugin understands/)
})

test('deserialize_ledger refuses malformed documents instead of repairing them', () => {
  const day = { opening_units: 0, closing_units: 0, spend_units: 0, topup_units: 0, samples: 0, last_at: 0 }
  const current = (overrides) =>
    JSON.stringify({
      version: LEDGER_VERSION,
      currency: 'USD',
      accounting_utc_offset_minutes: DEFAULT_UTC_OFFSET_MINUTES,
      days: {},
      ...overrides,
    })
  const bad = [
    ['not json', /not valid JSON/],
    ['null', /not a JSON object/],
    ['[]', /not a JSON object/],
    ['"4.58"', /not a JSON object/],
    [JSON.stringify({ currency: 'USD', days: {} }), /version is missing/],
    [current({ version: 2.5 }), /version is missing/],
    [current({ currency: 'EUR' }), /currency/],
    [current({ accounting_utc_offset_minutes: undefined }), /accounting_utc_offset_minutes/],
    [current({ accounting_utc_offset_minutes: 900 }), /accounting_utc_offset_minutes/],
    [current({ accounting_utc_offset_minutes: '480' }), /accounting_utc_offset_minutes/],
    [current({ days: [] }), /days is not a JSON object/],
    [current({ days: { 'not-a-date': day } }), /not a date/],
    [current({ days: { '2026-09-28': {} } }), /2026-09-28 does not match/],
    [current({ days: { '2026-09-28': { ...day, opening_units: 1.5 } } }), /does not match/],
    [current({ days: { '2026-09-28': { ...day, spend_units: -1 } } }), /does not match/],
  ]
  for (const [text, pattern] of bad) {
    const result = deserialize_ledger(text)
    assert.equal(result.status, 'failed', `expected refusal for ${text}`)
    assert.match(result.reason, pattern, `unexpected reason for ${text}`)
  }
})

test('deserialize_ledger ignores prototype-polluting keys', () => {
  const polluted = `{"version":${LEDGER_VERSION},"currency":"USD","accounting_utc_offset_minutes":480,"days":{"__proto__":{"spend_units":999}}}`
  const result = deserialize_ledger(polluted)
  assert.equal(result.status, 'failed')
  assert.match(result.reason, /not a date/)
  assert.equal({}.spend_units, undefined, 'Object.prototype was not touched')
})

/**
 * Whole-day distance between two `YYYY-MM-DD` keys.
 * @returns the number of days `later` is after `earlier`.
 */
function key_date_diff(earlier, later) {
  return (Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000
}

/**
 * Compute an accounting key in a child process running under `tz`.
 *
 * The assertion this serves is about the host timezone, so it cannot be made
 * in-process: Node fixes the ambient zone at startup.
 * @returns the key the child printed.
 */
function accounting_date_key_in_timezone(tz, epoch_ms, utc_offset_minutes) {
  const script = [
    `const m = await import(${JSON.stringify(LEDGER_MODULE_URL)})`,
    `process.stdout.write(m.accounting_date_key(${epoch_ms}, ${utc_offset_minutes}))`,
  ].join(';')
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  })
}
