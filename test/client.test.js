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
  }
  return element
}

function matches_selector(element, selector) {
  const exact = /^\[([a-zA-Z-]+)="([^"]*)"\]$/.exec(selector)
  if (exact !== null) return element.attributes[exact[1]] === exact[2]
  const contains = /^\[([a-zA-Z-]+)\*="([^"]*)"\]$/.exec(selector)
  if (contains !== null) return (element.attributes[contains[1]] ?? '').includes(contains[2])
  const present = /^\[([a-zA-Z-]+)\]$/.exec(selector)
  if (present !== null) return element.attributes[present[1]] !== undefined
  return false
}

function walk(element, visit) {
  visit(element)
  for (const child of element.children) walk(child, visit)
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

  const document_stub = {
    body,
    querySelector: (selector) => query_selector(body, selector),
    createElement: (tag) => make_element(tag),
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
    const placement = app.observers.find((entry) => entry.config?.childList === true)
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
    assert.equal(rail.props.title, 'Today $0.02 - balance $4.58')

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
    assert.equal(masked_rail.props.title, 'Today $*.** - balance $*.**')
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
