/**
 * harness-accountant — balance ledger.
 *
 * Pure: no I/O, no network, no globals. Everything here is a plain function
 * over plain data so it can be unit-tested and reviewed without a running
 * harness.
 *
 * Money is tracked as signed integer micro-units (1 unit = 1e-6 currency)
 * because the DeepSeek balance endpoint answers with a decimal STRING and
 * repeated binary-float subtraction drifts. The original string form is never
 * trusted for arithmetic here.
 *
 * Every field read back from disk is re-validated from scratch: the ledger
 * file is untrusted input, and a malformed one is discarded rather than
 * repaired into a plausible-looking number.
 */

/** On-disk schema version. A mismatch discards the file instead of guessing. */
export const LEDGER_VERSION = 1

/** Micro-units in one major currency unit. */
export const UNITS_PER_UNIT = 1_000_000

/** Currencies the ledger and the UI are allowed to carry. */
const KNOWN_CURRENCIES = new Set(['CNY', 'USD'])

/** Hard ceiling on retained days, independent of configuration. */
const MAX_RETAINED_DAYS = 3660

/** Up to 9 integer digits keeps `digits * UNITS_PER_UNIT` inside safe-integer range. */
const DECIMAL_PATTERN = /^(-?)(\d{1,9})(?:\.(\d+))?$/
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Parse a decimal money string into integer micro-units, truncating past six
 * fractional digits.
 * @param text - candidate decimal, e.g. `"4.58"`.
 * @returns the signed micro-unit count, or `undefined` when `text` is not a
 * plain decimal. Callers must treat `undefined` as "no reading", never as zero.
 */
export function parse_decimal_to_units(text) {
  if (typeof text !== 'string') return undefined
  const match = DECIMAL_PATTERN.exec(text.trim())
  if (match === null) return undefined
  const fraction = (match[3] ?? '').padEnd(6, '0').slice(0, 6)
  const magnitude = Number(match[2]) * UNITS_PER_UNIT + Number(fraction)
  if (!Number.isSafeInteger(magnitude)) return undefined
  return match[1] === '-' ? -magnitude : magnitude
}

/**
 * Render micro-units as a currency string with exactly two fractional digits.
 * @param units - signed micro-unit count.
 * @param currency - `"CNY"` or `"USD"`; anything else renders as `$`.
 * @returns display text, e.g. `"$4.58"`.
 */
export function format_units(units, currency) {
  const symbol = currency === 'CNY' ? '\u00a5' : '$'
  const magnitude = Math.abs(units)
  const whole = Math.floor(magnitude / UNITS_PER_UNIT)
  const fraction = String(magnitude % UNITS_PER_UNIT).padStart(6, '0').slice(0, 2)
  return `${units < 0 ? '-' : ''}${symbol}${whole}.${fraction}`
}

function date_key_of(date_obj) {
  const year = String(date_obj.getFullYear()).padStart(4, '0')
  const month = String(date_obj.getMonth() + 1).padStart(2, '0')
  const day = String(date_obj.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Local-time calendar key for an instant.
 * @param epoch_ms - epoch milliseconds.
 * @returns `YYYY-MM-DD` in the host's local timezone.
 */
export function local_date_key(epoch_ms) {
  return date_key_of(new Date(epoch_ms))
}

/**
 * Calendar key `offset` local days before `now_ms`. Uses `Date#setDate` so DST
 * transitions and month boundaries stay correct — a fixed 86_400_000 ms step
 * would land on the wrong date twice a year.
 * @param now_ms - reference instant, epoch milliseconds.
 * @param offset - whole days to step back (0 returns `now_ms`'s own key).
 * @returns `YYYY-MM-DD`.
 */
export function day_offset_key(now_ms, offset) {
  const shifted = new Date(now_ms)
  shifted.setDate(shifted.getDate() - offset)
  return date_key_of(shifted)
}

function is_plain_object(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function is_safe_integer(value) {
  return Number.isSafeInteger(value)
}

function own(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key)
}

/**
 * Build an empty ledger.
 * @param currency - starting currency; unknown values fall back to `"USD"`.
 * @returns a fresh ledger document.
 */
export function create_ledger(currency) {
  return {
    version: LEDGER_VERSION,
    currency: KNOWN_CURRENCIES.has(currency) ? currency : 'USD',
    days: Object.create(null),
  }
}

function previous_closing_units(ledger, date_key) {
  let best_key
  for (const key of Object.keys(ledger.days)) {
    if (key >= date_key) continue
    if (best_key === undefined || key > best_key) best_key = key
  }
  return best_key === undefined ? undefined : ledger.days[best_key].closing_units
}

/**
 * Fold one successful balance reading into the ledger.
 *
 * A drop in balance is spend; a rise is a top-up or an out-of-band correction
 * and is recorded separately rather than netted away — otherwise "spent" would
 * silently shrink every time credits were purchased. The first reading of a
 * day opens at the previous day's close so spend spanning local midnight is
 * attributed to the day it landed on, not lost.
 *
 * A currency change wipes the series: CNY and USD micro-units are not
 * comparable and summing them would produce a meaningless total.
 *
 * @param ledger - ledger to mutate.
 * @param sample - `{ at: epoch_ms, units: micro-units, currency: string }`.
 * @returns the same ledger, for chaining.
 */
export function fold_sample(ledger, sample) {
  const currency = KNOWN_CURRENCIES.has(sample.currency) ? sample.currency : ledger.currency
  if (ledger.currency !== currency) {
    ledger.currency = currency
    ledger.days = Object.create(null)
  }

  const date_key = local_date_key(sample.at)
  const existing = own(ledger.days, date_key) ? ledger.days[date_key] : undefined

  if (existing === undefined) {
    // Opening at the previous day's close means the movement between that
    // close and this first reading belongs to THIS day, so it is folded in
    // here rather than dropped.
    const opening_units = previous_closing_units(ledger, date_key) ?? sample.units
    const delta = opening_units - sample.units
    ledger.days[date_key] = {
      opening_units,
      closing_units: sample.units,
      spend_units: delta > 0 ? delta : 0,
      topup_units: delta < 0 ? -delta : 0,
      samples: 1,
      last_at: sample.at,
    }
    return ledger
  }

  const delta = existing.closing_units - sample.units
  if (delta > 0) existing.spend_units += delta
  else if (delta < 0) existing.topup_units += -delta
  existing.closing_units = sample.units
  existing.last_at = sample.at
  existing.samples += 1
  return ledger
}

/**
 * Drop day entries older than the retention window.
 * @param ledger - ledger to mutate.
 * @param retain_days - window length in calendar days, clamped to [1, 3660].
 * @param now_ms - reference instant, epoch milliseconds.
 * @returns the same ledger, for chaining.
 */
export function prune_ledger(ledger, retain_days, now_ms) {
  const requested = Math.trunc(retain_days)
  const bounded = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), MAX_RETAINED_DAYS) : 1
  const cutoff_key = day_offset_key(now_ms, bounded - 1)
  for (const key of Object.keys(ledger.days)) {
    if (key < cutoff_key) delete ledger.days[key]
  }
  return ledger
}

/**
 * Aggregate one trailing window of calendar days ending today.
 * @param ledger - ledger to read.
 * @param now_ms - reference instant, epoch milliseconds.
 * @param days - window length: `1` is today, `7` is today plus the six before.
 * @returns totals plus a per-day breakdown, oldest day first.
 */
export function summarize_range(ledger, now_ms, days) {
  const end_key = local_date_key(now_ms)
  const start_key = day_offset_key(now_ms, Math.max(days, 1) - 1)
  const day_list = []
  let spend_units = 0
  let topup_units = 0
  let samples = 0

  for (const key of Object.keys(ledger.days).sort()) {
    if (key < start_key || key > end_key) continue
    const entry = ledger.days[key]
    spend_units += entry.spend_units
    topup_units += entry.topup_units
    samples += entry.samples
    day_list.push({
      date: key,
      spend_units: entry.spend_units,
      topup_units: entry.topup_units,
      samples: entry.samples,
    })
  }

  return { days, start_key, end_key, spend_units, topup_units, samples, day_list }
}

/**
 * Closing balance of the most recent recorded day.
 * @param ledger - ledger to read.
 * @returns micro-units, or `undefined` when the ledger is empty.
 */
export function latest_closing_units(ledger) {
  let best_key
  for (const key of Object.keys(ledger.days)) {
    if (best_key === undefined || key > best_key) best_key = key
  }
  return best_key === undefined ? undefined : ledger.days[best_key].closing_units
}

function parse_day_entry(raw) {
  if (!is_plain_object(raw)) return undefined
  const counters = ['opening_units', 'closing_units', 'spend_units', 'topup_units', 'samples', 'last_at']
  for (const field of counters) {
    if (!is_safe_integer(raw[field])) return undefined
  }
  for (const field of ['spend_units', 'topup_units', 'samples', 'last_at']) {
    if (raw[field] < 0) return undefined
  }
  return {
    opening_units: raw.opening_units,
    closing_units: raw.closing_units,
    spend_units: raw.spend_units,
    topup_units: raw.topup_units,
    samples: raw.samples,
    last_at: raw.last_at,
  }
}

/**
 * Parse a ledger document, rejecting anything that does not match the schema.
 * Keys are re-validated against the date pattern, which also keeps a
 * `__proto__` or `constructor` key from ever reaching the map.
 * @param text - raw file contents.
 * @returns a validated ledger, or `undefined` when the document is unusable.
 */
export function deserialize_ledger(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!is_plain_object(raw)) return undefined
  if (raw.version !== LEDGER_VERSION) return undefined
  if (!KNOWN_CURRENCIES.has(raw.currency)) return undefined
  if (!is_plain_object(raw.days)) return undefined

  const days = Object.create(null)
  for (const key of Object.keys(raw.days)) {
    if (!DATE_KEY_PATTERN.test(key)) return undefined
    const entry = parse_day_entry(raw.days[key])
    if (entry === undefined) return undefined
    days[key] = entry
  }

  return { version: LEDGER_VERSION, currency: raw.currency, days }
}

/**
 * Serialize a ledger deterministically (days sorted, keys emitted in schema
 * order) so an unchanged ledger produces an unchanged file.
 * @param ledger - ledger to encode.
 * @returns pretty-printed JSON with a trailing newline.
 */
export function serialize_ledger(ledger) {
  const days = Object.create(null)
  for (const key of Object.keys(ledger.days).sort()) {
    days[key] = ledger.days[key]
  }
  return `${JSON.stringify({ version: LEDGER_VERSION, currency: ledger.currency, days }, null, 2)}\n`
}
