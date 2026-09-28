/**
 * Client-half smoke tests.
 *
 * The browser half cannot run in Node, so this file supplies just enough of a
 * browser - a module loader, a tiny hook runtime, a stub DOM with the three
 * class hooks the seating logic looks for, and a `fetch` - to prove that the
 * envelope loads, that `apply` registers a real `settings.section`, that the
 * card is seated above the Settings row, and that the eye toggle masks the
 * digits without changing the currency or the layout.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// ------------------------------------------------------------ fake DOM

function make_element(tag) {
  const element = {
    tag,
    attributes: {},
    children: [],
    parentElement: null,
    setAttribute(name, value) {
      element.attributes[name] = value
    },
    hasAttribute(name) {
      return element.attributes[name] !== undefined
    },
    append(child) {
      child.parentElement = element
      element.children.push(child)
    },
    insertBefore(child, before) {
      child.parentElement = element
      const index = element.children.indexOf(before)
      if (index === -1) element.children.push(child)
      else element.children.splice(index, 0, child)
    },
    remove() {
      if (element.parentElement === null) return
      const siblings = element.parentElement.children
      const index = siblings.indexOf(element)
      if (index !== -1) siblings.splice(index, 1)
      element.parentElement = null
    },
    contains(node) {
      let current = node
      while (current !== null && current !== undefined) {
        if (current === element) return true
        current = current.parentElement
      }
      return false
    },
    querySelector(selector) {
      return query_selector(element, selector)
    },
    querySelectorAll(selector) {
      return query_selector_all(element, selector)
    },
    // A getter, like the real DOM: `textContent` walks the whole subtree, so a
    // nav cell can be matched on the label a span inside it carries.
    get textContent() {
      let text = ''
      walk(element, (node) => {
        if (typeof node.text === 'string') text += node.text
      })
      return text
    },
  }
  return element
}

/** A text node, the one thing `make_element` cannot express. */
function make_text(value) {
  return { text: value, parentElement: null }
}

/**
 * One settings-nav row as the shell draws it: a `<hash>_navCell` button holding
 * a `<hash>_navIcon` svg (the gear: two paths) and a `<hash>_navLabel` span.
 * The shell builds this, not this plugin, so the test has to build it by hand.
 */
function make_nav_cell(label, path_count = 2) {
  const svg = make_element('svg')
  svg.attributes.class = 'VOzbGW_navIcon'
  svg.attributes.viewBox = '0 0 16 16'
  for (let index = 0; index < path_count; index += 1) {
    const path = make_element('path')
    path.attributes.d = `gear-path-${index}`
    path.attributes.stroke = 'currentColor'
    svg.append(path)
  }
  const span = make_element('span')
  span.attributes.class = 'VOzbGW_navLabel'
  span.append(make_text(label))
  const button = make_element('button')
  button.attributes.class = 'VOzbGW_navCell'
  button.append(svg)
  button.append(span)
  return { button, svg }
}

function matches_selector(element, selector) {
  const attributes = element.attributes ?? {}
  const exact = /^\[([a-zA-Z-]+)="([^"]*)"\]$/.exec(selector)
  if (exact !== null) return attributes[exact[1]] === exact[2]
  const contains = /^\[([a-zA-Z-]+)\*="([^"]*)"\]$/.exec(selector)
  if (contains !== null) return (attributes[contains[1]] ?? '').includes(contains[2])
  const present = /^\[([a-zA-Z-]+)\]$/.exec(selector)
  if (present !== null) return attributes[present[1]] !== undefined
  return false
}

function walk(element, visit) {
  visit(element)
  for (const child of element.children ?? []) walk(child, visit)
}

function query_selector(root, selector) {
  const parts = selector.split(',').map((part) => part.trim())
  let found
  walk(root, (element) => {
    if (found === undefined && parts.some((part) => matches_selector(element, part))) found = element
  })
  // The real DOM contract is `null`, not `undefined`, and the client half
  // relies on it (`!== null` for the idempotency guard).
  return found ?? null
}

function query_selector_all(root, selector) {
  const parts = selector.split(',').map((part) => part.trim())
  const found = []
  walk(root, (element) => {
    if (parts.some((part) => matches_selector(element, part))) found.push(element)
  })
  return found
}

// ------------------------------------------------------- fake hook runtime

function create_react_stub() {
  let hooks = []
  let cursor = 0

  const react = {
    createElement(type, props, ...children) {
      const shape = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
      return { type, props: { ...(props ?? {}), children: shape }, __is_element: true }
    },
    useState(initial) {
      const index = cursor++
      if (hooks[index] === undefined) hooks[index] = { value: initial }
      const hook = hooks[index]
      return [
        hook.value,
        (next) => {
          hook.value = typeof next === 'function' ? next(hook.value) : next
        },
      ]
    },
    useSyncExternalStore(_subscribe, get) {
      cursor += 1
      return get()
    },
  }

  function render(component) {
    hooks = []
    cursor = 0
    return component()
  }

  return { react, render }
}

/** Collect every element in an element tree that satisfies `predicate`. */
function find_all(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string') return out
  if (Array.isArray(node)) {
    for (const child of node) find_all(child, predicate, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (node.__is_element === true && predicate(node)) out.push(node)
  find_all(node.props?.children, predicate, out)
  return out
}

/** Flatten every text child, so a rendered number can be asserted as text. */
function text_of(node, out = []) {
  if (typeof node === 'string') {
    out.push(node)
    return out
  }
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    for (const child of node) text_of(child, out)
    return out
  }
  if (typeof node !== 'object') return out
  text_of(node.props?.children, out)
  return out
}

// ---------------------------------------------------------------- harness

const OVERVIEW = {
  ok: true,
  currency: 'USD',
  // The schedule the host publishes: peak 01:00-04:00 and 06:00-10:00 UTC,
  // Monday through Friday, with Chinese public holidays deliberately absent.
  peak: { reference: 'UTC', windows: [[60, 240], [360, 600]], weekdays: [1, 2, 3, 4, 5], holidays_modelled: false },
  balance: { units: 4_580_000, text: '$4.58', is_available: true, wallets: [{ currency: 'USD', text: '$4.58' }] },
  credential_source: 'file',
  last_ok_at: 1_790_000_000_000,
  last_probe_at: 1_790_000_000_000,
  ranges: {
    day: { days: 1, start_date: '2026-09-28', end_date: '2026-09-28', spend_text: '$0.02', spend_units: 20_000, topup_text: '$0.00', topup_units: 0, samples: 3, day_list: [{ date: '2026-09-28', spend_units: 20_000, spend_text: '$0.02', topup_units: 0, samples: 3 }] },
    week: { days: 7, start_date: '2026-09-22', end_date: '2026-09-28', spend_text: '$0.05', spend_units: 50_000, topup_text: '$0.00', topup_units: 0, samples: 9, day_list: [{ date: '2026-09-28', spend_units: 20_000, spend_text: '$0.02', topup_units: 0, samples: 3 }, { date: '2026-09-27', spend_units: 30_000, spend_text: '$0.03', topup_units: 0, samples: 6 }] },
    month: { days: 30, start_date: '2026-08-30', end_date: '2026-09-28', spend_text: '$0.05', spend_units: 50_000, topup_text: '$0.00', topup_units: 0, samples: 9, day_list: [] },
  },
}

/**
 * Build the fake browser, load `lib/client.js` into it, and run its factory.
 * @returns handles plus an async `restore`.
 */
async function load_client(options = {}) {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

  const saved = {}
  for (const key of ['window', 'document', 'MutationObserver', 'fetch', 'AbortSignal']) {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key)
  }

  // Mirrors the real shell, verified from the shipped bundles:
  //   div.<hash>_frame[data-sidebar-collapsed] > div.<hash>_sidebarCol
  //     > div.<hash>_footArea > { footerActions, settingsArea }
  // The hashes differ per build, so the stub uses the same stable suffixes the
  // client matches on. An earlier stub invented a `data-pane="sidebar"`
  // attribute that the real shell does not have.
  const settings_area = make_element('div')
  settings_area.attributes.class = 'hHd-Xa_settingsArea'
  const footer_actions = make_element('div')
  footer_actions.attributes.class = 'hHd-Xa_footerActions'
  const foot_area = make_element('div')
  foot_area.attributes.class = 'hHd-Xa_footArea'
  foot_area.append(footer_actions)
  foot_area.append(settings_area)
  const sidebar = make_element('div')
  sidebar.attributes.class = 'pI_x6G_sidebarCol'
  sidebar.append(foot_area)
  // The collapsed marker lives on the frame, not on the sidebar, and is set to
  // `true` only while collapsed - `sidebarCollapsed || void 0` in the real
  // shell, so React omits the attribute entirely when it is false.
  const frame = make_element('div')
  frame.attributes.class = 'pI_x6G_frame'
  frame.append(sidebar)
  const body = make_element('body')
  body.append(frame)

  const storage = new Map()
  const observers = []
  const timers = []
  const document_listeners = new Map()

  const document_stub = {
    body,
    visibilityState: 'visible',
    querySelector: (selector) => query_selector(body, selector),
    querySelectorAll: (selector) => query_selector_all(body, selector),
    createElement: (tag) => make_element(tag),
    addEventListener: (name, listener) => {
      if (!document_listeners.has(name)) document_listeners.set(name, new Set())
      document_listeners.get(name).add(listener)
    },
    removeEventListener: (name, listener) => {
      document_listeners.get(name)?.delete(listener)
    },
  }

  function fire_document(name) {
    for (const listener of Array.from(document_listeners.get(name) ?? [])) listener()
  }

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback
      this.disconnected = false
      observers.push(this)
    }
    observe(target, config) {
      this.target = target
      this.config = config
    }
    disconnect() {
      this.disconnected = true
    }
  }

  const { react, render } = create_react_stub()
  const roots = []

  const window_stub = {
    __ModuleLoader__: {
      load(definition) {
        window_stub.loaded = definition
      },
    },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, value),
    },
    // Deterministic: fire the coalescing callback immediately.
    requestAnimationFrame: (callback) => {
      callback()
      return 1
    },
    setInterval: () => 1,
    clearInterval: () => {},
    // Real enough to be driven by hand: the peak ticker arms exactly one timer,
    // for the instant the tier next changes, and a test fires it itself.
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimeout: (timer) => {
      if (timer !== undefined && timer !== null) timer.cleared = true
    },
    matchMedia: () => ({ matches: options.reduced_motion === true }),
  }

  Object.defineProperty(globalThis, 'window', { value: window_stub, configurable: true })
  Object.defineProperty(globalThis, 'document', { value: document_stub, configurable: true })
  Object.defineProperty(globalThis, 'MutationObserver', { value: FakeMutationObserver, configurable: true })
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => ({
      ok: true,
      status: 200,
      json: async () => options.overview ?? OVERVIEW,
    }),
  })

  // Evaluate the envelope. `new Function` keeps the file's top-level
  // `window.__ModuleLoader__.load(...)` call working without a real DOM.
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'MutationObserver', 'fetch', source)(
    window_stub,
    document_stub,
    FakeMutationObserver,
    globalThis.fetch,
  )

  const require_stub = (specifier) => {
    if (specifier === 'react') return react
    if (specifier === 'react-dom/client') {
      return {
        createRoot(container) {
          const root = {
            container,
            element: undefined,
            render(element) {
              root.element = element
              container.__rendered = element
            },
            unmount() {
              container.__unmounted = true
            },
          }
          roots.push(root)
          return root
        },
      }
    }
    throw new Error(`unexpected require: ${specifier}`)
  }

  const module_exports = window_stub.loaded.factory(require_stub)

  async function restore() {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete globalThis[key]
      else Object.defineProperty(globalThis, key, saved[key])
    }
  }

  return {
    exports: module_exports,
    window: window_stub,
    document: document_stub,
    body,
    frame,
    sidebar,
    foot_area,
    footer_actions,
    settings_area,
    observers,
    roots,
    storage,
    render,
    restore,
    timers,
    fire_document,
  }
}

function make_plugin_context() {
  const registrations = []
  const effects = []
  return {
    registrations,
    effects,
    slots: {
      inject(name, factory) {
        effects.push({ name, factory })
        factory()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {
          const index = registrations.findIndex((entry) => entry.options.id === options.id)
          if (index !== -1) registrations.splice(index, 1)
        }
      },
    },
    effect(callback, label) {
      const dispose = callback()
      effects.push({ label, dispose })
      return dispose
    },
  }
}

// ------------------------------------------------------------------ tests

/**
 * Peak and off-peak are a function of the wall clock, so a test has to own the
 * clock. Only `Date.now` is pinned: `new Date(ms)` still behaves, which is what
 * the tier maths reads.
 */
async function with_clock(ms, body) {
  const real_now = Date.now
  Date.now = () => ms
  try {
    return await body()
  } finally {
    Date.now = real_now
  }
}

/**
 * Apply the plugin with the clock pinned to `ms`, let the first fetch settle,
 * and hand back the root. The pinned instant matters at mount, not at render:
 * the tier is recomputed when an overview lands, and the render only reads the
 * snapshot that left behind.
 */
function mount_at(app, ms) {
  return with_clock(ms, async () => {
    app.exports.apply(make_plugin_context())
    await new Promise((resolve) => setImmediate(resolve))
    return app.roots[0]
  })
}

/** Every `data-harness-accountant-peak` element in a rendered tree. */
function peak_rows(tree) {
  return find_all(tree, (node) => node.props?.['data-harness-accountant-peak'] !== undefined)
}

/** The one peak ticker still armed. */
function armed_timer(app) {
  const live = app.timers.filter((timer) => !timer.cleared)
  return live[live.length - 1]
}

const HOUR_MS = 60 * 60 * 1000
// 2026-09-30 is a Wednesday, so 02:00 UTC is inside the first window and 05:00
// UTC is in the gap between the two.
const PEAK_INSTANT = Date.UTC(2026, 8, 30, 2, 0)
const OFF_PEAK_INSTANT = Date.UTC(2026, 8, 30, 5, 0)
// 2026-10-02 is a Friday and 2026-10-03 a Saturday: the first is the last peak
// of the week, the second is the weekend that is off-peak in full.
const FRIDAY_CLOSE_INSTANT = Date.UTC(2026, 9, 2, 10, 0)
const SATURDAY_INSTANT = Date.UTC(2026, 9, 3, 2, 0)

test('the envelope exposes apply and the slots injection', async () => {
  const app = await load_client()
  try {
    assert.equal(typeof app.exports.apply, 'function')
    assert.deepEqual(app.exports.inject, ['slots'])
  } finally {
    await app.restore()
  }
})

test('apply registers a settings.section beside the other sections', async () => {
  const app = await load_client()
  try {
    const ctx = make_plugin_context()
    app.exports.apply(ctx)

    assert.equal(ctx.registrations.length, 1)
    const { options, component } = ctx.registrations[0]
    assert.equal(options.name, 'settings.section')
    assert.equal(options.id, 'harness-accountant')
    assert.equal(options.order, 152)
    assert.equal(options.label, 'Accountant')
    assert.equal(typeof component, 'function')
  } finally {
    await app.restore()
  }
})

test('the foot card is seated directly above the Settings row', async () => {
  const app = await load_client()
  try {
    app.exports.apply(make_plugin_context())

    const card = app.foot_area.children.find(
      (child) => child.attributes['data-harness-accountant-foot-card'] !== undefined,
    )
    assert.ok(card, 'the card container should be inside the foot area')
    // The real foot is [footerActions, settingsArea]. The card must land
    // between them: below the footer actions, directly above the Settings row.
    assert.equal(app.foot_area.children[0], app.footer_actions)
    assert.equal(app.foot_area.children[1], card)
    assert.equal(app.foot_area.children[2], app.settings_area)
    // Two observers now share this range: the placement one and the collapse
    // one, so find them by what they watch rather than by construction order.
    const placement = app.observers.find(
      (entry) => entry.config?.childList === true && entry.config?.subtree === true,
    )
    assert.deepEqual(placement.config, { childList: true, subtree: true })
  } finally {
    await app.restore()
  }
})

test('the card never renders twice into the same foot', async () => {
  const app = await load_client()
  try {
    app.exports.apply(make_plugin_context())
    app.exports.apply(make_plugin_context())

    const cards = app.foot_area.children.filter(
      (child) => child.attributes['data-harness-accountant-foot-card'] !== undefined,
    )
    assert.equal(cards.length, 1)
  } finally {
    await app.restore()
  }
})

test('the balance, the currency, and the mask toggle render', async () => {
  const app = await load_client()
  try {
    app.exports.apply(make_plugin_context())
    // Let the first fetch settle, then render the component the root holds.
    await new Promise((resolve) => setImmediate(resolve))

    const root = app.roots[0]
    const tree = app.render(root.element.type)
    const text = text_of(tree).join(' ')

    assert.match(text, /\$4\.58/)
    assert.match(text, /Balance/)
    assert.match(text, /Today/)
    assert.match(text, /\$0\.02/)

    // The eye toggle masks every digit but keeps the currency symbol.
    const eye = find_all(tree, (node) => node.props.title === 'Hide balance')
    assert.equal(eye.length, 1)
    eye[0].props.onClick()

    const masked_text = text_of(app.render(root.element.type)).join(' ')
    assert.ok(!masked_text.includes('4.58'))
    // Digits become asterisks, but the currency symbol, the decimal point, and
    // the layout all stay put.
    assert.match(masked_text, /\$\*\.\*\*/)
    assert.equal(app.storage.get('harness-accountant.masked'), '1')
  } finally {
    await app.restore()
  }
})

test('the collapsed rail shows today and nothing else', async () => {
  const app = await load_client()
  try {
    app.exports.apply(make_plugin_context())
    await new Promise((resolve) => setImmediate(resolve))

    const root = app.roots[0]
    const draw = () => app.render(root.element.type)

    const expanded = text_of(draw()).join(' ')
    assert.match(expanded, /Balance/)
    assert.match(expanded, /Today/)
    assert.match(expanded, /\$0\.02/)

    // The shell marks its frame while the rail is collapsed.
    app.frame.setAttribute('data-sidebar-collapsed', 'true')
    const watcher = app.observers.find((entry) => entry.config?.attributeFilter !== undefined)
    assert.ok(watcher, 'the card should watch the shell collapsed marker')
    assert.deepEqual(watcher.config.attributeFilter, ['data-sidebar-collapsed'])
    watcher.callback()

    const rail = draw()
    // Exactly one string, and it is today's figure: no label, no mask control,
    // no error line. The balance is not lost, it moves into the tooltip.
    assert.deepEqual(text_of(rail), ['$0.02'])
    assert.equal(find_all(rail, (node) => node.props.onClick !== undefined).length, 0)
    assert.match(
      rail.props.title,
      /^Today \$0\.02 - balance \$4\.58 - (?:Peak|Off-peak) hours - changes (?:[A-Z][a-z]{2} )?\d{2}:\d{2} - public holidays not modelled$/,
    )

    // The mask is shared state, not card-local: it still applies to the rail.
    delete app.frame.attributes['data-sidebar-collapsed']
    watcher.callback()
    const eye = find_all(draw(), (node) => node.props.title === 'Hide balance')
    assert.equal(eye.length, 1)
    eye[0].props.onClick()

    app.frame.setAttribute('data-sidebar-collapsed', 'true')
    watcher.callback()
    const masked_rail = draw()
    assert.deepEqual(text_of(masked_rail), ['$*.**'])
    assert.match(
      masked_rail.props.title,
      /^Today \$\*\.\*\* - balance \$\*\.\*\* - (?:Peak|Off-peak) hours - changes /,
    )
  } finally {
    await app.restore()
  }
})

test('the settings nav gear is repainted as a coin stack', async () => {
  const app = await load_client()
  try {
    app.exports.apply(make_plugin_context())
    await new Promise((resolve) => setImmediate(resolve))

    // The nav belongs to the shell; it appears only once Settings is opened,
    // which portals a child onto the body.
    const watcher = app.observers.find(
      (entry) => entry.config?.childList === true && entry.config?.subtree !== true,
    )
    assert.ok(watcher, 'the coin should watch the body for the settings modal')
    assert.equal(watcher.target, app.body)

    const other = make_nav_cell('Models')
    const odd = make_nav_cell('Accountant', 3)
    const ours = make_nav_cell('Accountant')
    app.body.append(other.button)
    app.body.append(odd.button)
    app.body.append(ours.button)
    watcher.callback()

    // Ours is repainted, keeping the two-path shape it was checked against...
    assert.equal(ours.svg.hasAttribute('data-harness-accountant-coin'), true)
    assert.equal(ours.svg.children.length, 2)
    assert.notEqual(ours.svg.children[0].attributes.d, 'gear-path-0')
    assert.notEqual(ours.svg.children[1].attributes.d, 'gear-path-1')
    assert.equal(ours.svg.children[0].attributes.stroke, 'currentColor')

    // ...another section keeps its own icon...
    assert.equal(other.svg.hasAttribute('data-harness-accountant-coin'), false)
    assert.equal(other.svg.children[0].attributes.d, 'gear-path-0')

    // ...and so does artwork that is not the shape this was written against.
    assert.equal(odd.svg.hasAttribute('data-harness-accountant-coin'), false)
    assert.equal(odd.svg.children[0].attributes.d, 'gear-path-0')

    // Repainting is idempotent, so a later mutation cannot undo it.
    const painted = ours.svg.children[0].attributes.d
    watcher.callback()
    assert.equal(ours.svg.children[0].attributes.d, painted)
  } finally {
    await app.restore()
  }
})

test('the settings panel exposes all three windows', async () => {
  const app = await load_client()
  try {
    const ctx = make_plugin_context()
    app.exports.apply(ctx)
    await new Promise((resolve) => setImmediate(resolve))

    const panel = app.render(ctx.registrations[0].component)
    const tree_text = text_of(panel).join(' ')
    const labels = find_all(panel, (node) => node.__is_element === true).map((node) => node.props.children)

    assert.match(tree_text, /\$4\.58/)
    assert.ok(labels.includes('24 hours'))
    assert.ok(labels.includes('7 days'))
    assert.ok(labels.includes('30 days'))
    // Defaults to the day window, so its per-day row is present.
    assert.match(tree_text, /2026-09-28/)
    assert.ok(!tree_text.includes('2026-09-27'))
  } finally {
    await app.restore()
  }
})

test('the disposer removes the card and disconnects the observer', async () => {
  const app = await load_client()
  try {
    const ctx = make_plugin_context()
    app.exports.apply(ctx)
    await new Promise((resolve) => setImmediate(resolve))

    const card = app.foot_area.children.find(
      (child) => child.attributes['data-harness-accountant-foot-card'] !== undefined,
    )
    assert.ok(card, 'the card container should be inside the foot area')

    const effect = ctx.effects.find((entry) => entry.label === 'harness-accountant: sidebar card')
    assert.ok(effect, 'the card effect should be registered under its label')
    effect.dispose()

    assert.equal(app.roots[0].container.__unmounted, true)
    assert.equal(app.foot_area.children.includes(card), false)
    assert.ok(app.observers.every((entry) => entry.disconnected === true))
  } finally {
    await app.restore()
  }
})

test('the card names the tier the clock is in, above the balance', async () => {
  const app = await load_client()
  try {
    // Wednesday 02:00 UTC is inside the first window, so the tier is peak.
    const root = await mount_at(app, PEAK_INSTANT)
    const drawn = await with_clock(PEAK_INSTANT, async () => app.roots[0] && app.render(root.element.type))

    const rows = peak_rows(drawn)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].props['data-harness-accountant-peak'], 'peak')
    // Colour is never the only carrier: the words say the same thing, and the
    // row is the first line of the card, above the balance.
    const texts = text_of(drawn)
    assert.equal(texts[0], 'Peak hours')
    assert.equal(texts[1], 'Balance')
  } finally {
    await app.restore()
  }
})

test('off-peak is the answer between the windows, and the ticker knows when it ends', async () => {
  const app = await load_client()
  try {
    // 05:00 UTC on the same Wednesday sits in the gap between the two windows.
    const root = await mount_at(app, OFF_PEAK_INSTANT)
    const drawn = app.render(root.element.type)
    assert.equal(peak_rows(drawn)[0].props['data-harness-accountant-peak'], 'off_peak')
    assert.equal(text_of(drawn)[0], 'Off-peak hours')
    // Exactly one timer, armed for 06:00 UTC - one hour away, plus the cushion
    // that lands the wakeup just after the boundary rather than on it.
    assert.equal(armed_timer(app).delay, HOUR_MS + 250)
  } finally {
    await app.restore()
  }
})

test('firing the ticker past a boundary flips the tier', async () => {
  const app = await load_client()
  try {
    const root = await mount_at(app, PEAK_INSTANT)
    const draw = () => app.render(root.element.type)
    assert.equal(peak_rows(draw())[0].props['data-harness-accountant-peak'], 'peak')
    // Inside the first window the tier holds until 04:00 UTC.
    const timer = armed_timer(app)
    assert.equal(timer.delay, 2 * HOUR_MS + 250)

    // The clock reaches the boundary; the callback recomputes rather than
    // trusting the timer, so the reading is right regardless of when it fires.
    await with_clock(Date.UTC(2026, 8, 30, 4, 0), async () => timer.callback())

    assert.equal(peak_rows(draw())[0].props['data-harness-accountant-peak'], 'off_peak')
    // Off-peak now, until the second window opens two hours later.
    assert.equal(armed_timer(app).delay, 2 * HOUR_MS + 250)
  } finally {
    await app.restore()
  }
})

test('the closing minute is already off-peak and the weekend is skipped', async () => {
  const app = await load_client()
  try {
    // 10:00 UTC on a Friday is the closing edge of the last window of the week.
    // The windows are half-open, so this minute is off-peak...
    const root = await mount_at(app, FRIDAY_CLOSE_INSTANT)
    assert.equal(peak_rows(app.render(root.element.type))[0].props['data-harness-accountant-peak'], 'off_peak')
    // ...and the next window does not open until Monday 01:00 UTC, 63 hours on:
    // Saturday and Sunday are off-peak in full.
    assert.equal(armed_timer(app).delay, 63 * HOUR_MS + 250)
  } finally {
    await app.restore()
  }
})

test('the weekend is off-peak, not a long peak', async () => {
  const app = await load_client()
  try {
    // Saturday 02:00 UTC is the hour that would be peak on a weekday.
    const root = await mount_at(app, SATURDAY_INSTANT)
    assert.equal(peak_rows(app.render(root.element.type))[0].props['data-harness-accountant-peak'], 'off_peak')
    // Monday 01:00 UTC is 47 hours away.
    assert.equal(armed_timer(app).delay, 47 * HOUR_MS + 250)
  } finally {
    await app.restore()
  }
})

test('a missing or unusable schedule degrades to off-peak with no ticker', async () => {
  const unusable = [
    undefined,
    { reference: 'local', windows: [[60, 240]], weekdays: [1] },
    { reference: 'UTC', windows: [[600, 360]], weekdays: [1] },
    { reference: 'UTC', windows: [[60, 240]], weekdays: [9] },
    { reference: 'UTC', windows: [[60, 1441]], weekdays: [1] },
  ]
  for (const peak of unusable) {
    const app = await load_client({ overview: { ...OVERVIEW, peak } })
    try {
      const root = await mount_at(app, PEAK_INSTANT)
      // The stated default, and nothing to wait for: a schedule with no
      // boundaries has no timer, so the client does not spin.
      assert.equal(peak_rows(app.render(root.element.type))[0].props['data-harness-accountant-peak'], 'off_peak')
      assert.equal(armed_timer(app), undefined)
    } finally {
      await app.restore()
    }
  }
})

test('the rail dot is yellow in peak and green off it', async () => {
  const cases = [
    [PEAK_INSTANT, '#f0c000'],
    [OFF_PEAK_INSTANT, '#38c172'],
  ]
  for (const [instant, colour] of cases) {
    const app = await load_client()
    try {
      const root = await mount_at(app, instant)
      app.frame.setAttribute('data-sidebar-collapsed', 'true')
      app.observers.find((entry) => entry.config?.attributeFilter !== undefined).callback()

      const rail = app.render(root.element.type)
      const dot = peak_rows(rail)[0]
      assert.equal(dot.props.style.background, colour)
      assert.equal(dot.props.style.borderRadius, '999px')
      // The dot carries the tier as colour alone; today's figure is unchanged.
      assert.deepEqual(text_of(rail), ['$0.02'])
    } finally {
      await app.restore()
    }
  }
})

test('the card dot breathes while its label holds still', async () => {
  const app = await load_client()
  try {
    const root = await mount_at(app, PEAK_INSTANT)
    const tree = app.render(root.element.type)
    const breathers = find_all(tree, (node) => typeof node.props?.ref === 'function')
    assert.equal(breathers.length, 1)
    assert.equal(breathers[0].props.style.background, '#f0c000')
    // The circle is a sibling of the words, never their parent, so the label
    // cannot inherit the opacity animation. That is the whole point of the fix.
    assert.deepEqual(text_of(breathers[0]), [])
    assert.ok(text_of(tree).includes('Peak hours'))
  } finally {
    await app.restore()
  }
})

test('the tier circle breathes slowly, once, and honours reduced motion', async () => {
  const app = await load_client()
  try {
    const root = await mount_at(app, PEAK_INSTANT)
    app.frame.setAttribute('data-sidebar-collapsed', 'true')
    app.observers.find((entry) => entry.config?.attributeFilter !== undefined).callback()
    const dot = peak_rows(app.render(root.element.type))[0]

    const frames = []
    const cancelled = []
    const node = {
      animate: (key, options) => {
        frames.push({ key, options })
        return { cancel: () => cancelled.push('cancelled') }
      },
    }
    // The stub never invokes refs, so the test drives it - twice, because React
    // hands a fresh node on every render and the animation must not restart.
    dot.props.ref(node)
    dot.props.ref(node)
    assert.equal(frames.length, 1)
    assert.deepEqual(frames[0].key, [{ opacity: 1 }, { opacity: 0.25 }, { opacity: 1 }])
    assert.equal(frames[0].options.iterations, Infinity)
    // Slow enough to sit in the corner of the eye rather than pull at it.
    assert.equal(frames[0].options.duration, 3000)

    // Collapsing and expanding swaps the rail for the card. The animation that
    // belonged to the unmounted node is cancelled rather than left running on a
    // detached element.
    assert.deepEqual(cancelled, [])
    dot.props.ref({ animate: () => ({ cancel: () => cancelled.push('cancelled') }) })
    assert.deepEqual(cancelled, ['cancelled'])
  } finally {
    await app.restore()
  }

  const still = await load_client({ reduced_motion: true })
  try {
    const root = await mount_at(still, PEAK_INSTANT)
    still.frame.setAttribute('data-sidebar-collapsed', 'true')
    still.observers.find((entry) => entry.config?.attributeFilter !== undefined).callback()
    const dot = peak_rows(still.render(root.element.type))[0]
    let animated = 0
    dot.props.ref({ animate: () => { animated += 1 } })
    assert.equal(animated, 0)
  } finally {
    await still.restore()
  }
})
