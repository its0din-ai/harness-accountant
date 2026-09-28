import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LEDGER_VERSION,
  UNITS_PER_UNIT,
  create_ledger,
  day_offset_key,
  deserialize_ledger,
  fold_sample,
  format_units,
  latest_closing_units,
  local_date_key,
  parse_decimal_to_units,
  prune_ledger,
  serialize_ledger,
  summarize_range,
} from '../lib/ledger.js'

/** A local-time instant, so assertions do not depend on the runner's timezone. */
function at(year, month, day, hour = 12) {
  return new Date(year, month - 1, day, hour, 0, 0, 0).getTime()
}

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
  fold_sample(ledger, { at: at(2026, 9, 28), units: 4_580_000, currency: 'USD' })
  const day = ledger.days['2026-09-28']
  assert.equal(day.opening_units, 4_580_000)
  assert.equal(day.closing_units, 4_580_000)
  assert.equal(day.spend_units, 0)
  assert.equal(day.topup_units, 0)
  assert.equal(day.samples, 1)
})

test('fold_sample counts drops as spend and rises as top-ups', () => {
  const ledger = create_ledger('USD')
  fold_sample(ledger, { at: at(2026, 9, 28, 9), units: 5_000_000, currency: 'USD' })
  fold_sample(ledger, { at: at(2026, 9, 28, 10), units: 4_700_000, currency: 'USD' })
  fold_sample(ledger, { at: at(2026, 9, 28, 11), units: 4_600_000, currency: 'USD' })
  fold_sample(ledger, { at: at(2026, 9, 28, 12), units: 14_600_000, currency: 'USD' })
  const day = ledger.days['2026-09-28']
  assert.equal(day.spend_units, 400_000)
  assert.equal(day.topup_units, 10_000_000, 'a top-up does not cancel recorded spend')
  assert.equal(day.closing_units, 14_600_000)
  assert.equal(day.samples, 4)
})

test('a new day opens at the previous day close', () => {
  const ledger = create_ledger('USD')
  fold_sample(ledger, { at: at(2026, 9, 28, 23), units: 4_000_000, currency: 'USD' })
  fold_sample(ledger, { at: at(2026, 9, 29, 1), units: 3_900_000, currency: 'USD' })
  assert.equal(ledger.days['2026-09-29'].opening_units, 4_000_000, 'spend across midnight is not lost')
  assert.equal(ledger.days['2026-09-29'].spend_units, 100_000)
})

test('an unchanged reading adds a sample but no spend', () => {
  const ledger = create_ledger('USD')
  fold_sample(ledger, { at: at(2026, 9, 28, 9), units: 4_000_000, currency: 'USD' })
  fold_sample(ledger, { at: at(2026, 9, 28, 10), units: 4_000_000, currency: 'USD' })
  assert.equal(ledger.days['2026-09-28'].spend_units, 0)
  assert.equal(ledger.days['2026-09-28'].samples, 2)
})

test('a currency change starts a fresh series', () => {
  const ledger = create_ledger('USD')
  fold_sample(ledger, { at: at(2026, 9, 28), units: 4_000_000, currency: 'USD' })
  fold_sample(ledger, { at: at(2026, 9, 29), units: 30_000_000, currency: 'CNY' })
  assert.equal(ledger.currency, 'CNY')
  assert.deepEqual(Object.keys(ledger.days), ['2026-09-29'])
})

test('summarize_range windows the ledger by calendar day', () => {
  const ledger = create_ledger('USD')
  const now = at(2026, 9, 28)
  for (let offset = 40; offset >= 0; offset -= 1) {
    fold_sample(ledger, { at: now - offset * 86_400_000, units: 10_000_000, currency: 'USD' })
    fold_sample(ledger, { at: now - offset * 86_400_000, units: 9_000_000, currency: 'USD' })
  }

  const one_day = summarize_range(ledger, now, 1)
  assert.equal(one_day.day_list.length, 1)
  assert.equal(one_day.spend_units, 1_000_000)

  const week = summarize_range(ledger, now, 7)
  assert.equal(week.day_list.length, 7)
  assert.equal(week.spend_units, 7_000_000)

  const month = summarize_range(ledger, now, 30)
  assert.equal(month.day_list.length, 30)
  assert.equal(month.spend_units, 30_000_000)
  assert.deepEqual(month.day_list.map((d) => d.date), [...month.day_list.map((d) => d.date)].sort())
})

test('day_offset_key walks local calendar days, not fixed 24h steps', () => {
  const now = at(2026, 3, 1)
  assert.equal(local_date_key(now), '2026-03-01')
  assert.equal(day_offset_key(now, 1), '2026-02-28')
  assert.equal(day_offset_key(now, 29), '2026-01-31')
  assert.equal(day_offset_key(now, 0), '2026-03-01')
})

test('prune_ledger keeps the retention window and clamps absurd input', () => {
  const ledger = create_ledger('USD')
  const now = at(2026, 9, 28)
  for (let offset = 60; offset >= 0; offset -= 1) {
    fold_sample(ledger, { at: now - offset * 86_400_000, units: 5_000_000, currency: 'USD' })
  }
  prune_ledger(ledger, 7, now)
  assert.equal(Object.keys(ledger.days).length, 7)

  prune_ledger(ledger, 0, now)
  assert.equal(Object.keys(ledger.days).length, 1, 'retention clamps to at least today')

  prune_ledger(ledger, Number.POSITIVE_INFINITY, now)
  assert.equal(Object.keys(ledger.days).length, 1, 'infinite retention must not delete everything')
})

test('latest_closing_units reports the newest day', () => {
  const ledger = create_ledger('USD')
  assert.equal(latest_closing_units(ledger), undefined)
  fold_sample(ledger, { at: at(2026, 9, 27), units: 5_000_000, currency: 'USD' })
  fold_sample(ledger, { at: at(2026, 9, 28), units: 4_000_000, currency: 'USD' })
  assert.equal(latest_closing_units(ledger), 4_000_000)
})

test('serialize then deserialize round-trips', () => {
  const ledger = create_ledger('USD')
  fold_sample(ledger, { at: at(2026, 9, 28, 9), units: 5_000_000, currency: 'USD' })
  fold_sample(ledger, { at: at(2026, 9, 28, 10), units: 4_000_000, currency: 'USD' })
  const restored = deserialize_ledger(serialize_ledger(ledger))
  assert.equal(restored.version, LEDGER_VERSION)
  assert.equal(restored.currency, 'USD')
  assert.deepEqual(restored.days['2026-09-28'], ledger.days['2026-09-28'])
})

test('deserialize_ledger rejects malformed documents instead of repairing them', () => {
  const bad = [
    'not json',
    'null',
    '[]',
    JSON.stringify({ version: 2, currency: 'USD', days: {} }),
    JSON.stringify({ version: 1, currency: 'EUR', days: {} }),
    JSON.stringify({ version: 1, currency: 'USD', days: [] }),
    JSON.stringify({ version: 1, currency: 'USD', days: { 'not-a-date': {} } }),
    JSON.stringify({ version: 1, currency: 'USD', days: { '2026-09-28': {} } }),
    JSON.stringify({ version: 1, currency: 'USD', days: { '2026-09-28': { opening_units: 1.5, closing_units: 0, spend_units: 0, topup_units: 0, samples: 0, last_at: 0 } } }),
    JSON.stringify({ version: 1, currency: 'USD', days: { '2026-09-28': { opening_units: 0, closing_units: 0, spend_units: -1, topup_units: 0, samples: 0, last_at: 0 } } }),
  ]
  for (const text of bad) {
    assert.equal(deserialize_ledger(text), undefined, `expected rejection for ${text}`)
  }
})

test('deserialize_ledger ignores prototype-polluting keys', () => {
  const polluted = '{"version":1,"currency":"USD","days":{"__proto__":{"spend_units":999}}}'
  assert.equal(deserialize_ledger(polluted), undefined)
  assert.equal({}.spend_units, undefined, 'Object.prototype was not touched')
})
