/**
 * harness-accountant - browser half.
 *
 * Hand-written module-loader envelope: no bundler, no JSX, no framework
 * imports at runtime. The host hands `ctx` to `apply`, and the only modules
 * pulled from the loader are `react` and `react-dom/client`.
 *
 * This half renders numbers the host already computed. It never sees the API
 * key, the credential reference, or the ledger file.
 *
 * @module harness-accountant/client
 */
window.__ModuleLoader__.load({
  id: 'harness-accountant',
  factory: (require) => {
    // CommonJS shape the module loader expects. It hands over `require` only;
    // `module`/`exports` are ours to declare.
    const module = { exports: {} }
    const exports = module.exports

    const react = require('react')
    const react_dom_client = require('react-dom/client')

    const h = react.createElement

    /**
     * Document-relative on purpose: the GUI is served with `<base href="./">`,
     * so a sub-path deployment must resolve these against its entry directory
     * rather than escape to the origin root.
     */
    const API_BASE = 'api/harness-accountant'
    const REFRESH_MS = 30_000
    const FETCH_TIMEOUT_MS = 20_000
    const MASK_STORAGE_KEY = 'harness-accountant.masked'
    const FOOT_CARD_ATTRIBUTE = 'data-harness-accountant-foot-card'
    const FOOT_CARD_SELECTOR = `[${FOOT_CARD_ATTRIBUTE}]`
    /**
     * The layout shell puts this attribute on its frame while the sidebar is
     * collapsed (verified in `client-ui-layout/lib/client.js`, which reads
     * `"data-sidebar-collapsed": sidebarCollapsed || void 0`). It is a plain
     * attribute rather than a css-module class, and the shell's own stylesheet
     * keys on it, so unlike the `footArea` suffix it cannot drift with a hash.
     */
    const COLLAPSED_ATTRIBUTE = 'data-sidebar-collapsed'
    const SECTION_ID = 'harness-accountant'
    /** First-level nav slot directly below the Workshop section (order 150). */
    const SECTION_ORDER = 152
    /**
     * The nav label, and the anchor the coin below is painted onto.
     *
     * A `settings.section` registration carries only `id`, `order` and `label`
     * (the shell's own `SettingsSectionRow` is exactly that shape), so there is
     * no icon field to declare. The shell's `navIcon(row.id)` returns
     * `IconSettingsOutlineMedium` - a gear - for every id it does not
     * recognise, and ours is one of them.
     */
    const SECTION_LABEL = 'Accountant'
    const COIN_ATTRIBUTE = 'data-harness-accountant-coin'
    const COIN_SELECTOR = `[${COIN_ATTRIBUTE}]`
    /**
     * The settings nav cell and the icon inside it, matched on the stable
     * suffix of the shell's css-module class names - the same technique the
     * foot card is seated with. The hash in front of the suffix changes per
     * build; the suffix does not.
     */
    const NAV_CELL_SELECTOR = '[class*="navCell"]'
    const NAV_ICON_SELECTOR = '[class*="navIcon"]'
    /**
     * `d` for the two paths of the shipped gear artwork, in order. Overwriting
     * these is the whole patch: the artwork is a 16x16 `stroke: currentColor`
     * outline with exactly two paths, so a coin stack drawn in the same box and
     * the same two sub-paths needs no other change - not the viewBox, not the
     * size, not the style. See `paint_coin` for why only attributes are touched.
     */
    const COIN_PATHS = [
      // The top coin, seen face-on.
      'M8 6.6C10.872 6.6 13.2 5.615 13.2 4.4C13.2 3.185 10.872 2.2 8 2.2C5.128 2.2 2.8 3.185 2.8 4.4C2.8 5.615 5.128 6.6 8 6.6Z',
      // The stack the top coin sits on: both walls, the base, and the coin below.
      'M2.8 4.4V11.6C2.8 12.815 5.128 13.8 8 13.8C10.872 13.8 13.2 12.815 13.2 11.6V4.4M2.8 8C2.8 9.215 5.128 10.2 8 10.2C10.872 10.2 13.2 9.215 13.2 8',
    ]
    const MAX_DISPLAYED_ERROR = 160

    // ---------------------------------------------------------------- store

    const listeners = new Set()
    let snapshot = { status: 'loading' }
    let inflight

    function publish(next) {
      snapshot = next
      // The peak schedule rides the overview, so the tier is re-derived from
      // the clock whenever a fresh answer lands - and only then. No timer of
      // its own watches the host for this.
      adopt_peak_from(next)
      for (const listener of Array.from(listeners)) listener()
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }

    function get_snapshot() {
      return snapshot
    }

    const use_sync_external_store = react.useSyncExternalStore
    const use_state = react.useState

    async function fetch_overview(force) {
      // The custom header is load-bearing: it is not CORS-safelisted, so a
      // cross-site caller cannot send it without a preflight this host never
      // approves. `credentials: same-origin` keeps the session cookie scoped.
      const response = await fetch(`${API_BASE}/${force ? 'refresh' : 'overview'}`, {
        method: force ? 'POST' : 'GET',
        headers: { 'x-harness-accountant': '1' },
        credentials: 'same-origin',
        cache: 'no-store',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`host returned ${response.status}`)
      return await response.json()
    }

    function load_overview(force) {
      if (inflight !== undefined) return inflight
      inflight = fetch_overview(force)
        .then(
          (data) => {
            publish({ status: 'ready', data })
          },
          (error) => {
            publish({ status: 'error', error: error instanceof Error ? error.message : 'host unreachable' })
          },
        )
        .finally(() => {
          inflight = undefined
        })
      return inflight
    }

    let poll_timer

    function start_polling() {
      if (poll_timer !== undefined) return
      void load_overview(false)
      poll_timer = window.setInterval(() => {
        void load_overview(false)
      }, REFRESH_MS)
    }

    function stop_polling() {
      if (poll_timer === undefined) return
      window.clearInterval(poll_timer)
      poll_timer = undefined
    }

    // ----------------------------------------------------------- mask store

    // Shared so the sidebar card and the settings panel never disagree about
    // whether the balance is hidden.
    const mask_listeners = new Set()
    let mask_value = read_stored_mask()

    function read_stored_mask() {
      try {
        return window.localStorage.getItem(MASK_STORAGE_KEY) === '1'
      } catch {
        return false
      }
    }

    function subscribe_mask(listener) {
      mask_listeners.add(listener)
      return () => {
        mask_listeners.delete(listener)
      }
    }

    function get_mask() {
      return mask_value
    }

    function toggle_mask() {
      mask_value = !mask_value
      try {
        window.localStorage.setItem(MASK_STORAGE_KEY, mask_value ? '1' : '0')
      } catch {
        // Storage disabled (private mode): the toggle still works for this page.
      }
      for (const listener of Array.from(mask_listeners)) listener()
    }

    // -------------------------------------------------------- collapse store

    // Collapsed, the shell narrows the sidebar to a 56px rail, and its own
    // padding leaves the card about 36px of usable width. Two labelled rows
    // cannot say anything useful in that space - they stack into a column of
    // single characters. So the card watches the shell's own collapsed marker
    // and renders one figure instead: today's spend, and nothing else.
    const collapsed_listeners = new Set()
    let collapsed_value = false

    function subscribe_collapsed(listener) {
      collapsed_listeners.add(listener)
      return () => {
        collapsed_listeners.delete(listener)
      }
    }

    function get_collapsed() {
      return collapsed_value
    }

    function publish_collapsed(next) {
      if (next === collapsed_value) return
      collapsed_value = next
      for (const listener of Array.from(collapsed_listeners)) listener()
    }

    /** True when any ancestor of `element` carries the shell's collapsed marker. */
    function read_collapsed(element) {
      for (let node = element.parentElement; node !== null; node = node.parentElement) {
        if (node.hasAttribute(COLLAPSED_ATTRIBUTE)) return true
      }
      return false
    }

    /**
     * Hide every digit but keep the currency symbol and layout stable, so
     * masking is a shoulder-surfing guard and not a claim of secrecy.
     *
     * Plain ASCII asterisks: this lands in a terminal, a log, or a screenshot
     * as often as in the browser, and a non-ASCII bullet is a rendering
     * liability in all three.
     */
    function mask_text(text) {
      return String(text).replace(/[0-9]/g, '*')
    }

    function display(text, masked) {
      // A plain hyphen, not a typographic dash: this is rendered text, and the
      // repository is ASCII end to end (m01475).
      if (text === undefined) return '-'
      return masked ? mask_text(text) : text
    }

    function short_error(value) {
      return String(value).slice(0, MAX_DISPLAYED_ERROR)
    }

    // ------------------------------------------------------------ peak store

    /**
     * DeepSeek bills peak and off-peak at different rates, and the schedule is
     * published in UTC: peak is 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday
     * through Friday, and every other hour is off-peak. The host sends that
     * schedule as data; this half owns the clock (m02930).
     *
     * Nothing here is polled. The tier is a pure function of the wall clock, so
     * a network round trip would be strictly worse than reading the clock
     * already in the browser, and a fixed timer would be waste on top of it:
     * exactly one timer is armed, for the instant the tier next changes.
     *
     * Times are UTC throughout, which is what makes the indicator correct for a
     * user in any timezone - the reader's own clock never enters the decision.
     * Only the tooltip renders in local time, so the hour it names is one the
     * reader can recognise.
     *
     * Chinese public holidays are deliberately not modelled: the published
     * schedule excludes them from peak, and this plugin carries no holiday
     * calendar, so on those days it reports peak while DeepSeek bills off-peak.
     * `holidays_modelled` carries that admission from the host into the tooltip
     * rather than leaving the omission invisible.
     */
    const MINUTE_MS = 60 * 1000
    const DAY_MINUTES = 24 * 60
    const DAY_MS = DAY_MINUTES * MINUTE_MS
    const WEEK_MS = 7 * DAY_MS
    /** Wake just after the boundary, so the tick lands on the new tier. */
    const PEAK_TICK_CUSHION_MS = 250
    /** Floor on the delay, so a clock that jumps backwards cannot spin. */
    const PEAK_TICK_FLOOR_MS = 1000
    /**
     * One full breath, in milliseconds. Deliberately slow: the circle is a
     * status light that stays on screen all day, so at a brisker cadence it
     * reads as an alarm competing for attention rather than as a quiet signal.
     * Three seconds is slow enough to sit in the corner of the eye without
     * pulling at it, and it is the only thing on the card that moves.
     */
    const PEAK_BREATH_MS = 3000
    const PEAK_ATTRIBUTE = 'data-harness-accountant-peak'
    const PEAK_LABEL = { peak: 'Peak hours', off_peak: 'Off-peak hours' }
    const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

    /**
     * The schedule as half-open millisecond intervals inside one UTC week, or
     * `[]` when the host sent nothing usable. An unusable schedule degrades to
     * "never peak" rather than throwing: off-peak is the stated default, and an
     * indicator that says nothing beats one that guesses.
     */
    function peak_intervals(schedule) {
      if (schedule === null || typeof schedule !== 'object') return []
      if (schedule.reference !== 'UTC') return []
      const weekdays = schedule.weekdays
      const windows = schedule.windows
      if (!Array.isArray(weekdays) || weekdays.length === 0) return []
      if (!Array.isArray(windows) || windows.length === 0) return []
      const intervals = []
      for (const weekday of weekdays) {
        if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return []
        for (const window of windows) {
          if (!Array.isArray(window) || window.length !== 2) return []
          const start = window[0]
          const end = window[1]
          // A window spans one UTC day: whole minutes, inside the day, and
          // never wrapping midnight. Anything else is not this schedule.
          if (!Number.isInteger(start) || !Number.isInteger(end)) return []
          if (start < 0 || end > DAY_MINUTES || start >= end) return []
          intervals.push([weekday * DAY_MS + start * MINUTE_MS, weekday * DAY_MS + end * MINUTE_MS])
        }
      }
      intervals.sort((left, right) => left[0] - right[0])
      return intervals
    }

    /** Sunday 00:00 UTC of the week `at_ms` falls in. */
    function week_origin_ms(at_ms) {
      const date = new Date(at_ms)
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - date.getUTCDay())
    }

    /**
     * Which tier `at_ms` is in, and the instant the next one begins.
     * `until_ms` is `undefined` when the schedule has no boundaries at all.
     */
    function peak_state_at(schedule, at_ms) {
      const intervals = peak_intervals(schedule)
      if (intervals.length === 0) return { tier: 'off_peak', until_ms: undefined }
      const origin = week_origin_ms(at_ms)
      const offset = at_ms - origin
      let ends_at
      for (const interval of intervals) {
        if (offset >= interval[0] && offset < interval[1]) {
          // Overlapping windows would each claim the instant; the latest end is
          // the one that keeps the reading inside peak.
          if (ends_at === undefined || interval[1] > ends_at) ends_at = interval[1]
        }
      }
      if (ends_at !== undefined) return { tier: 'peak', until_ms: origin + ends_at }
      let starts_at
      for (const interval of intervals) {
        const start = interval[0] > offset ? interval[0] : interval[0] + WEEK_MS
        if (starts_at === undefined || start < starts_at) starts_at = start
      }
      return { tier: 'off_peak', until_ms: origin + starts_at }
    }

    const peak_listeners = new Set()
    // Off-peak until a schedule and a clock say otherwise: this is the value the
    // first paint uses, before any overview has arrived.
    let peak_snapshot = { tier: 'off_peak', until_ms: undefined, holidays_modelled: false }
    let peak_schedule
    let peak_timer
    let peak_breathing_node
    let peak_breath_animation

    function publish_peak(next) {
      if (
        next.tier === peak_snapshot.tier &&
        next.until_ms === peak_snapshot.until_ms &&
        next.holidays_modelled === peak_snapshot.holidays_modelled
      ) {
        return
      }
      peak_snapshot = next
      for (const listener of Array.from(peak_listeners)) listener()
    }

    function subscribe_peak(listener) {
      peak_listeners.add(listener)
      return () => {
        peak_listeners.delete(listener)
      }
    }

    function get_peak_snapshot() {
      return peak_snapshot
    }

    /**
     * Re-read the clock and arm exactly one timer for the next boundary. The
     * tier is always recomputed from the clock rather than advanced by the
     * timer, so a throttled, coalesced or sleep-delayed wakeup cannot leave the
     * indicator stale - it can only delay the correction.
     */
    function schedule_peak_tick() {
      if (peak_timer !== undefined) {
        window.clearTimeout(peak_timer)
        peak_timer = undefined
      }
      const until = peak_snapshot.until_ms
      if (until === undefined) return
      const delay = Math.max(PEAK_TICK_FLOOR_MS, until - Date.now() + PEAK_TICK_CUSHION_MS)
      peak_timer = window.setTimeout(refresh_peak, delay)
    }

    function refresh_peak() {
      const state = peak_state_at(peak_schedule, Date.now())
      publish_peak({
        tier: state.tier,
        until_ms: state.until_ms,
        holidays_modelled: peak_schedule?.holidays_modelled === true,
      })
      schedule_peak_tick()
    }

    /**
     * Adopt the schedule an overview carries. A failed poll carries none, and
     * the published windows are static, so the last one that arrived is still
     * the right answer; only a client that has never seen a schedule - or one
     * whose host has stopped sending it - falls back to off-peak.
     */
    function adopt_peak_from(next) {
      if (next.status === 'ready') peak_schedule = next.data?.peak
      refresh_peak()
    }

    function stop_peak() {
      if (peak_timer === undefined) return
      window.clearTimeout(peak_timer)
      peak_timer = undefined
    }

    /**
     * The tier's breathing circle. A composited opacity animation rather than an
     * interval: the card re-renders on every poll, and a timer that exists only
     * to move one alpha channel would run forever for a purely decorative
     * effect. The node is remembered so React's ref churn cannot restart the
     * animation on each render, and the previous animation is cancelled when the
     * card and the rail trade places - otherwise it would outlive its node,
     * detached, still running. A reduced-motion preference leaves the circle lit
     * and still.
     *
     * Only the circle breathes. It is a sibling of the label, never its parent,
     * so the words hold still while the colour pulses.
     */
    function attach_breath(node) {
      if (node === null || node === undefined) return
      if (node === peak_breathing_node) return
      if (peak_breath_animation !== undefined) {
        if (typeof peak_breath_animation.cancel === 'function') peak_breath_animation.cancel()
        peak_breath_animation = undefined
      }
      peak_breathing_node = node
      if (typeof node.animate !== 'function') return
      if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      peak_breath_animation = node.animate([{ opacity: 1 }, { opacity: 0.25 }, { opacity: 1 }], {
        duration: PEAK_BREATH_MS,
        iterations: Infinity,
        easing: 'ease-in-out',
      })
    }

    /** Local clock time of the boundary, e.g. "18:30". */
    function boundary_clock(date) {
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    }

    /**
     * The tooltip. The boundary is rendered in the reader's own timezone - the
     * one place local time is allowed in, since the decision itself is UTC.
     * A boundary beyond today also names its weekday, which matters most on a
     * Friday, when the next peak is not until Monday.
     */
    function peak_title(peak) {
      const label = PEAK_LABEL[peak.tier]
      const holiday = peak.holidays_modelled === true ? '' : ' - public holidays not modelled'
      if (peak.until_ms === undefined) return `${label}${holiday}`
      const now = new Date(Date.now())
      const until = new Date(peak.until_ms)
      const same_day =
        until.getFullYear() === now.getFullYear() &&
        until.getMonth() === now.getMonth() &&
        until.getDate() === now.getDate()
      const when = same_day ? boundary_clock(until) : `${WEEKDAY_NAMES[until.getDay()]} ${boundary_clock(until)}`
      return `${label} - changes ${when}${holiday}`
    }

    // ---------------------------------------------------------------- style

    // 14px is the sidebar shell's own text size, not a guess:
    // `[data-platform=darwin] .<hash>_root { ...; font-size: 14px; ... }` and the
    // Settings row button (`font-size: 14px; font-weight: 500; line-height:
    // 22px; padding: 8px 12px`) in dsh-client-ui-sidebar/lib/client.js. The card
    // sits directly above that row, so anything smaller reads as a second type
    // scale (E-014). Children inherit this unless they set their own size.
    const CARD_STYLE = { display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 8px', fontSize: '14px', lineHeight: '1.5' }
    const CARD_ROW_STYLE = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }
    /**
     * The collapsed rail: the tier as a breathing circle, then today's figure.
     * The figure is 11px rather than the card's 14px because the shell drops its
     * own type and hit targets inside the rail; a 14px figure plus a currency
     * symbol does not fit the ~36px the shell leaves, and shrinking is the local
     * rule there rather than a second scale imposed on the card. `ellipsis`
     * means an unusually large amount degrades to a truncation instead of
     * overflowing, with the full figure left in the tooltip - which is also the
     * only place with room to name the tier in words.
     */
    const RAIL_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '3px',
      maxWidth: '100%',
      padding: '2px 0',
      opacity: 0.85,
    }
    const RAIL_DOT_STYLE = { width: '8px', height: '8px', borderRadius: '999px', flex: '0 0 auto' }
    const RAIL_VALUE_STYLE = {
      maxWidth: '100%',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontSize: '11px',
      fontWeight: 600,
      fontVariantNumeric: 'tabular-nums',
    }
    /**
     * Peak is yellow and off-peak is green, as asked. Two shades per tier
     * rather than one: the dot is a filled shape read at a glance, so it carries
     * the saturated hue, while the label in the card is 14px text that has to
     * stay legible on whichever theme the shell is in - and the shipped shell
     * exposes no semantic colour to lean on. Its 65 `--dsh-*` custom properties
     * are sizes, insets and scrollbar tokens; the one colour reference in this
     * file, `--dsh-color-danger`, falls back in every case observed.
     */
    const PEAK_DOT_COLOR = '#f0c000'
    const PEAK_TEXT_COLOR = '#b8860b'
    const OFF_PEAK_DOT_COLOR = '#38c172'
    const OFF_PEAK_TEXT_COLOR = '#2e8b57'
    const PEAK_ROW_STYLE = { ...CARD_ROW_STYLE, fontWeight: 600 }
    const LABEL_STYLE = { opacity: 0.65 }
    const BALANCE_VALUE_STYLE = { fontWeight: 600, fontVariantNumeric: 'tabular-nums' }
    const SUBTLE_VALUE_STYLE = { fontVariantNumeric: 'tabular-nums', opacity: 0.85 }
    const ICON_BUTTON_STYLE = { border: 'none', background: 'transparent', cursor: 'pointer', padding: '0 2px', fontSize: '14px', lineHeight: '1', opacity: 0.75, color: 'inherit' }
    const ERROR_STYLE = { opacity: 0.75, color: 'var(--dsh-color-danger, #d46a6a)' }
    const PANEL_STYLE = { display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 0' }
    const PANEL_HEAD_STYLE = { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px' }
    const PANEL_BALANCE_STYLE = { fontSize: '22px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }
    const TAB_ROW_STYLE = { display: 'flex', gap: '6px' }
    const TAB_STYLE = { padding: '4px 10px', borderRadius: '999px', border: '1px solid currentColor', background: 'transparent', cursor: 'pointer', fontSize: '12px', color: 'inherit', opacity: 0.7 }
    const TAB_ACTIVE_STYLE = { ...TAB_STYLE, opacity: 1, fontWeight: 600 }
    const TOTALS_STYLE = { display: 'flex', gap: '28px', flexWrap: 'wrap' }
    const TOTAL_VALUE_STYLE = { fontSize: '15px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }
    const DAY_ROW_STYLE = { display: 'grid', gridTemplateColumns: '92px 1fr 84px', alignItems: 'center', gap: '10px', fontSize: '12px', padding: '2px 0' }
    const DAY_DATE_STYLE = { fontVariantNumeric: 'tabular-nums', opacity: 0.8 }
    const DAY_VALUE_STYLE = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
    const BAR_TRACK_STYLE = { height: '6px', borderRadius: '999px', background: 'currentColor', opacity: 0.15 }
    const BAR_FILL_STYLE = { height: '100%', borderRadius: '999px', background: 'currentColor', opacity: 0.85 }
    const NOTE_STYLE = { fontSize: '11px', opacity: 0.6, maxWidth: '52ch' }

    // ------------------------------------------------------------ components

    function use_overview() {
      return use_sync_external_store(subscribe, get_snapshot, get_snapshot)
    }

    function use_mask() {
      return use_sync_external_store(subscribe_mask, get_mask, get_mask)
    }

    function use_collapsed() {
      return use_sync_external_store(subscribe_collapsed, get_collapsed, get_collapsed)
    }

    function use_peak() {
      return use_sync_external_store(subscribe_peak, get_peak_snapshot, get_peak_snapshot)
    }

    /**
     * The tier as a coloured dot and name, above the balance - the eye only has
     * to reach the top of the card to know whether the tokens it is about to
     * spend are billed at the peak rate. Colour is never the only carrier: the
     * words say the same thing, which is what makes the indicator readable to
     * someone who cannot separate the two hues.
     */
    function peak_row(peak) {
      const color = peak.tier === 'peak' ? PEAK_TEXT_COLOR : OFF_PEAK_TEXT_COLOR
      const dot = peak.tier === 'peak' ? PEAK_DOT_COLOR : OFF_PEAK_DOT_COLOR
      return h(
        'div',
        { style: { ...PEAK_ROW_STYLE, color }, title: peak_title(peak), key: 'peak', [PEAK_ATTRIBUTE]: peak.tier },
        h(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', gap: '5px' } },
          h('span', { ref: attach_breath, style: { ...RAIL_DOT_STYLE, background: dot } }),
          h('span', null, PEAK_LABEL[peak.tier]),
        ),
      )
    }

    function balance_rows(state, masked, peak) {
      const data = state.status === 'ready' ? state.data : undefined
      const today = data?.ranges?.day
      return [
        peak_row(peak),
        h(
          'div',
          { style: CARD_ROW_STYLE, key: 'balance' },
          h('span', { style: LABEL_STYLE }, 'Balance'),
          h(
            'span',
            null,
            h('span', { style: BALANCE_VALUE_STYLE }, display(data?.balance?.text, masked)),
            h(
              'button',
              {
                type: 'button',
                style: ICON_BUTTON_STYLE,
                onClick: toggle_mask,
                title: masked ? 'Show balance' : 'Hide balance',
                'aria-label': masked ? 'Show balance' : 'Hide balance',
              },
              masked ? '\u25cb' : '\u25c9',
            ),
          ),
        ),
        h(
          'div',
          { style: CARD_ROW_STYLE, key: 'today' },
          h('span', { style: LABEL_STYLE }, 'Today'),
          h('span', { style: SUBTLE_VALUE_STYLE }, display(today?.spend_text, masked)),
        ),
      ]
    }

    /**
     * The collapsed rail: the tier as a breathing circle, then today's spend.
     * There is no room for a label at about 36px wide - the same reason the mask
     * control and the error line are dropped here - so the tier travels as
     * colour alone, and the tooltip carries both the tier in words and the
     * balance the two-row card would have shown.
     */
    function rail_card(state, masked, peak) {
      const data = state.status === 'ready' ? state.data : undefined
      const today = display(data?.ranges?.day?.spend_text, masked)
      const balance = display(data?.balance?.text, masked)
      const dot = peak.tier === 'peak' ? PEAK_DOT_COLOR : OFF_PEAK_DOT_COLOR
      return h(
        'div',
        { style: RAIL_STYLE, title: `Today ${today} - balance ${balance} - ${peak_title(peak)}` },
        h('span', {
          [PEAK_ATTRIBUTE]: peak.tier,
          ref: attach_breath,
          style: { ...RAIL_DOT_STYLE, background: dot },
        }),
        h('span', { style: RAIL_VALUE_STYLE }, today),
      )
    }

    /** The compact card seated directly above the shell's Settings row. */
    function foot_card() {
      const state = use_overview()
      const masked = use_mask()
      const collapsed = use_collapsed()
      const peak = use_peak()

      if (collapsed) return rail_card(state, masked, peak)

      const data = state.status === 'ready' ? state.data : undefined

      return h(
        'div',
        { style: CARD_STYLE },
        ...balance_rows(state, masked, peak),
        data?.error === undefined ? null : h('div', { style: ERROR_STYLE }, short_error(data.error)),
        state.status === 'error' ? h('div', { style: ERROR_STYLE }, short_error(state.error)) : null,
      )
    }

    const RANGE_TABS = [
      { key: 'day', label: '24 hours' },
      { key: 'week', label: '7 days' },
      { key: 'month', label: '30 days' },
    ]

    function totals_block(range, masked, currency) {
      const entries = [
        { label: `Spent (${currency})`, value: display(range?.spend_text, masked) },
        { label: `Topped up (${currency})`, value: display(range?.topup_text, masked) },
        { label: 'Readings', value: String(range?.samples ?? 0) },
        { label: 'Days recorded', value: String(range?.day_list?.length ?? 0) },
      ]
      return h(
        'div',
        { style: TOTALS_STYLE },
        ...entries.map((entry) =>
          h(
            'div',
            { key: entry.label },
            h('div', { style: LABEL_STYLE }, entry.label),
            h('div', { style: TOTAL_VALUE_STYLE }, entry.value),
          ),
        ),
      )
    }

    function day_breakdown(range, masked) {
      const day_list = range?.day_list ?? []
      if (day_list.length === 0) {
        return h('div', { style: LABEL_STYLE }, 'No readings recorded in this range yet.')
      }
      const peak = day_list.reduce((highest, entry) => Math.max(highest, entry.spend_units), 0)
      // Newest first: the recent days are the interesting ones.
      const ordered = day_list.slice().reverse()
      return h(
        'div',
        null,
        ...ordered.map((entry) =>
          h(
            'div',
            { style: DAY_ROW_STYLE, key: entry.date },
            h('span', { style: DAY_DATE_STYLE }, entry.date),
            h(
              'div',
              { style: BAR_TRACK_STYLE },
              h('div', {
                style: { ...BAR_FILL_STYLE, width: peak === 0 ? '0%' : `${Math.round((entry.spend_units / peak) * 100)}%` },
              }),
            ),
            h('span', { style: DAY_VALUE_STYLE }, display(entry.spend_text, masked)),
          ),
        ),
      )
    }

    /** The detailed panel registered into the Settings modal. */
    function settings_panel() {
      const state = use_overview()
      const masked = use_mask()
      const [range_key, set_range_key] = use_state('day')

      const data = state.status === 'ready' ? state.data : undefined
      const currency = data?.currency ?? 'USD'
      const range = data?.ranges?.[range_key]

      return h(
        'div',
        { style: PANEL_STYLE },
        h(
          'div',
          { style: PANEL_HEAD_STYLE },
          h('div', { style: PANEL_BALANCE_STYLE }, display(data?.balance?.text, masked)),
          h(
            'div',
            { style: TAB_ROW_STYLE },
            ...RANGE_TABS.map((tab) =>
              h(
                'button',
                {
                  key: tab.key,
                  type: 'button',
                  style: tab.key === range_key ? TAB_ACTIVE_STYLE : TAB_STYLE,
                  onClick: () => set_range_key(tab.key),
                },
                tab.label,
              ),
            ),
          ),
        ),
        state.status === 'error' ? h('div', { style: ERROR_STYLE }, short_error(state.error)) : null,
        data?.error === undefined ? null : h('div', { style: ERROR_STYLE }, short_error(data.error)),
        totals_block(range, masked, currency),
        day_breakdown(range, masked),
        h(
          'div',
          { style: NOTE_STYLE },
          'Spend is the movement of the account balance between readings, so it includes every session and  ',
          'client on this account - not only this window. A balance that rises is recorded as a top-up. ',
          'Readings older than the retention window are dropped.',
        ),
      )
    }

    // ------------------------------------------------------------ DOM seating

    function find_foot_area() {
      // Verified against the shipped shell, not inferred:
      //   client-ui-layout/lib/client.js   -> div.<hash>_sidebarCol, whose
      //                                       `children` is the sidebar
      //   client-ui-sidebar/lib/client.js  -> div.<hash>_footArea, whose
      //                                       children are <hash>_footerActions
      //                                       then <hash>_settingsArea
      // The prefixes are per-build css-module hashes, so match the stable
      // suffix. There is no `data-pane` attribute anywhere in the shell - an
      // earlier version of this function matched one, and it was dead code.
      const sidebar = document.querySelector('[class*="sidebarCol"]')
      if (sidebar === null) return undefined
      return sidebar.querySelector('[class*="footArea"]') ?? undefined
    }

    /**
     * Seat the card directly above the shell's Settings row.
     *
     * The foot's only slot stacks ABOVE the Settings row and cannot host a
     * block, so - following the one plugin known to do this - the card is a
     * plain `div` with its own React root, inserted into the shell's foot area
     * by DOM surgery. Owning the root means the shell's reconciliation never
     * sees the card's children, and a MutationObserver re-seats the container
     * whenever a re-render displaces it.
     * @returns a disposer that removes the card and its observer.
     */
    function mount_foot_card() {
      if (document.querySelector(FOOT_CARD_SELECTOR) !== null) return () => {}

      const container = document.createElement('div')
      container.setAttribute(FOOT_CARD_ATTRIBUTE, '')
      const root = react_dom_client.createRoot(container)

      function place() {
        const foot = find_foot_area()
        if (foot === undefined || container.parentElement === foot) return
        const settings = foot.querySelector('[class*="settingsArea"]')
        if (settings !== null && settings.parentElement === foot) foot.insertBefore(container, settings)
        else foot.append(container)
      }

      function sync_collapsed() {
        publish_collapsed(read_collapsed(container))
      }

      // The frame carrying the collapsed marker is an ancestor of this
      // container, but the shell creates and tears that frame down on its own
      // schedule, so the observer sits on the body and is filtered to that one
      // attribute name rather than bound to an element that may be replaced.
      const collapse_observer = new MutationObserver(sync_collapsed)
      collapse_observer.observe(document.body, {
        attributes: true,
        attributeFilter: [COLLAPSED_ATTRIBUTE],
        subtree: true,
      })

      place()
      // Read only after placement: before it, the container has no ancestors to
      // walk, so a sidebar that mounts already collapsed would paint the card.
      sync_collapsed()
      root.render(h(foot_card))

      let scheduled = false
      function schedule_place() {
        if (scheduled) return
        scheduled = true
        window.requestAnimationFrame(() => {
          scheduled = false
          place()
        })
      }

      const observer = new MutationObserver((records) => {
        for (const record of records) {
          // Ignore our own subtree: React writing the card's contents would
          // otherwise re-trigger the observer on every tick.
          if (container.contains(record.target)) continue
          schedule_place()
          return
        }
      })
      observer.observe(find_foot_area() ?? document.body, { childList: true, subtree: true })

      return () => {
        collapse_observer.disconnect()
        observer.disconnect()
        root.unmount()
        container.remove()
      }
    }

    /**
     * Repaint the settings nav's gear for this section as a stack of coins.
     *
     * There is no supported way to do this: the slot carries no icon (see
     * `SECTION_LABEL`), so the coin is painted onto the artwork the shell has
     * already rendered, by matching the nav cell on its label and rewriting the
     * two `d` attributes of the gear's paths.
     *
     * Attributes only, and node identity left alone, on purpose. React owns
     * that tree: replacing or removing any of its nodes would leave a fiber
     * pointing at a detached element, and its next reconcile would either
     * operate on the wrong node or throw on a `removeChild` of a node that is
     * no longer there. An attribute write is invisible to that reconcile,
     * because React diffs props rather than the DOM and the icon's props
     * (`className`, `size`) never change - so nothing here is ever reverted.
     * Re-running the patch is harmless for the same reason; it is idempotent.
     *
     * @returns a disposer that stops watching for the settings modal.
     */
    function mount_nav_icon() {
      function paint_coin() {
        // The modal is portaled onto the body and rebuilt from scratch each
        // time it opens, so a marker that is still in the document means this
        // has already run for the open modal and the scan can be skipped.
        if (document.querySelector(COIN_SELECTOR) !== null) return
        for (const cell of document.querySelectorAll(NAV_CELL_SELECTOR)) {
          if (cell.textContent.trim() !== SECTION_LABEL) continue
          const svg = cell.querySelector(NAV_ICON_SELECTOR)
          if (svg === null) continue
          // `children`, not a `path` selector: an HTMLCollection and the stub's
          // array both index and count the same way, so the two agree.
          const paths = svg.children
          // Only touch artwork that is the shape this was written against. A
          // future shell that draws something else keeps its own icon.
          if (paths.length !== COIN_PATHS.length) continue
          COIN_PATHS.forEach((d, index) => {
            paths[index].setAttribute('d', d)
          })
          svg.setAttribute(COIN_ATTRIBUTE, '')
          return
        }
      }

      let scheduled = false
      /**
       * Wait one frame before painting. A commit can append the modal's
       * container before its subtree, and this reads the whole nav, so running
       * on the raw mutation record would sometimes look at a half-built tree and
       * then never be woken again.
       */
      function schedule_paint() {
        if (scheduled) return
        scheduled = true
        window.requestAnimationFrame(() => {
          scheduled = false
          paint_coin()
        })
      }

      // The settings panel is portaled onto the body as a direct child, so a
      // childList observer without `subtree` catches it opening without being
      // woken by every message the GUI streams into its own containers.
      const observer = new MutationObserver(schedule_paint)
      observer.observe(document.body, { childList: true })
      paint_coin()
      return () => observer.disconnect()
    }

    // ----------------------------------------------------------------- apply

    function apply(ctx) {
      ctx.effect(() => {
        const dispose_foot_card = mount_foot_card()
        const dispose_nav_icon = mount_nav_icon()
        // The timer that arms the next boundary can be delayed by a sleeping
        // machine or a throttled background tab. Nothing accumulates while it
        // is late - the tier is read from the clock, never counted up to - so
        // the only thing needed on return is to look again.
        const on_visible = () => {
          if (document.visibilityState === 'hidden') return
          refresh_peak()
        }
        document.addEventListener('visibilitychange', on_visible)
        start_polling()
        return () => {
          document.removeEventListener('visibilitychange', on_visible)
          stop_polling()
          stop_peak()
          dispose_nav_icon()
          dispose_foot_card()
        }
      }, 'harness-accountant: sidebar card')

      ctx.slots.inject('settings.section', () => {
        try {
          const unregister = ctx.slots.register(
            {
              name: 'settings.section',
              id: SECTION_ID,
              order: SECTION_ORDER,
              label: SECTION_LABEL,
            },
            settings_panel,
          )
          return () => {
            unregister()
          }
        } catch {
          return () => {}
        }
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    return exports
  },
})
