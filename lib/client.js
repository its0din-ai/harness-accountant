/**
 * harness-accountant — browser half.
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
    const SECTION_ID = 'harness-accountant'
    /** First-level nav slot directly below the Workshop section (order 150). */
    const SECTION_ORDER = 152
    const MAX_DISPLAYED_ERROR = 160

    // ---------------------------------------------------------------- store

    const listeners = new Set()
    let snapshot = { status: 'loading' }
    let inflight

    function publish(next) {
      snapshot = next
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
      if (text === undefined) return '\u2014'
      return masked ? mask_text(text) : text
    }

    function short_error(value) {
      return String(value).slice(0, MAX_DISPLAYED_ERROR)
    }

    // ---------------------------------------------------------------- style

    const CARD_STYLE = { display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 8px', fontSize: '11px', lineHeight: '1.5' }
    const CARD_ROW_STYLE = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }
    const LABEL_STYLE = { opacity: 0.65 }
    const BALANCE_VALUE_STYLE = { fontWeight: 600, fontVariantNumeric: 'tabular-nums' }
    const SUBTLE_VALUE_STYLE = { fontVariantNumeric: 'tabular-nums', opacity: 0.85 }
    const ICON_BUTTON_STYLE = { border: 'none', background: 'transparent', cursor: 'pointer', padding: '0 2px', fontSize: '11px', lineHeight: '1', opacity: 0.75, color: 'inherit' }
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

    function balance_rows(state, masked) {
      const data = state.status === 'ready' ? state.data : undefined
      const today = data?.ranges?.day
      return [
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

    /** The compact card seated directly above the shell's Settings row. */
    function foot_card() {
      const state = use_overview()
      const masked = use_mask()
      const data = state.status === 'ready' ? state.data : undefined

      return h(
        'div',
        { style: CARD_STYLE },
        ...balance_rows(state, masked),
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
          'client on this account — not only this window. A balance that rises is recorded as a top-up. ',
          'Readings older than the retention window are dropped.',
        ),
      )
    }

    // ------------------------------------------------------------ DOM seating

    function find_foot_area() {
      const sidebar = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]')
      if (sidebar === null) return undefined
      return sidebar.querySelector('[class*="footArea"]') ?? undefined
    }

    /**
     * Seat the card directly above the shell's Settings row.
     *
     * The foot's only slot stacks ABOVE the Settings row and cannot host a
     * block, so — following the one plugin known to do this — the card is a
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

      root.render(h(foot_card))
      place()

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
        observer.disconnect()
        root.unmount()
        container.remove()
      }
    }

    // ----------------------------------------------------------------- apply

    function apply(ctx) {
      ctx.effect(() => {
        const dispose_foot_card = mount_foot_card()
        start_polling()
        return () => {
          stop_polling()
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
              label: 'Accountant',
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
