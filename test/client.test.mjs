/**
 * Renders the generated client bundle in a fake browser environment.
 *
 * `lib/client.js` is a plain `window.__ModuleLoader__.load({ id, factory })`
 * bundle: this harness supplies the module loader, a minimal React that records
 * the element tree, fake DOM/style/ResizeObserver globals, and a fake Connection
 * whose RPC returns realistic payloads. Every component is rendered and the
 * produced text is checked for untranslated keys and exceptions.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const BUNDLE = fileURLToPath(new URL('../packages/token-diet/lib/client.js', import.meta.url))

/* ---------- a React stand-in ---------- */

/** Runs `fn` once per mount, like useEffect with an empty dep list. */
function createFakeReact() {
  const states = []
  let cursor = 0
  return {
    __states: states,
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.flat(Infinity) } }
    },
    useState(initial) {
      const index = cursor++
      if (states[index] === undefined) states[index] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = states[index]
      const set = (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
      }
      return [slot.value, set]
    },
    useRef(initial) {
      const index = cursor++
      if (states[index] === undefined) states[index] = { current: initial ?? null }
      return states[index]
    },
    useMemo(factory) {
      cursor++
      return factory()
    },
    useCallback(fn) {
      cursor++
      return fn
    },
    useEffect(effect) {
      cursor++
      effect()
    },
    useLayoutEffect(effect) {
      cursor++
      effect()
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      cursor++
      return getSnapshot()
    },
    useReducer(reducer, initial) {
      const index = cursor++
      if (states[index] === undefined) states[index] = { value: initial }
      const slot = states[index]
      const dispatch = (action) => {
        slot.value = reducer(slot.value, action)
      }
      return [slot.value, dispatch]
    },
    useId() {
      cursor++
      return 'id-' + cursor
    },
    useTransition() {
      cursor++
      return [false, (fn) => fn()]
    },
    useDeferredValue(value) {
      cursor++
      return value
    },
    startTransition(fn) {
      fn()
    },
    memo(component) {
      return component
    },
    forwardRef(component) {
      return component
    },
    createContext(defaultValue) {
      return { Provider: 'Provider', Consumer: 'Consumer', _currentValue: defaultValue }
    },
    Fragment: 'Fragment',
    __reset() {
      cursor = 0
    },
    __begin() {
      cursor = 0
    },
  }
}

/* ---------- browser globals ---------- */

function installBrowser(React) {
  const styles = []
  const styleElements = []

  const document = {
    head: {
      appendChild(node) {
        styleElements.push(node)
        styles.push(node.textContent ?? '')
      },
    },
    querySelector(selector) {
      // Match a keyed sheet exactly; `installStyles(css, key)` must be able to
      // tell its own sheet from every other one this plugin installs.
      const keyed = /^style\[data-dsh-token-diet="([^"]+)"\]$/.exec(selector)
      if (keyed !== null) {
        return styleElements.find((node) => node.dataset?.dshTokenDiet === keyed[1]) ?? null
      }
      if (selector.includes('style[data-dsh-token-diet')) return styleElements[0] ?? null
      if (selector.includes('style[data-plugin-css')) return styleElements[0] ?? null
      return null
    },
    querySelectorAll() {
      return []
    },
    createElement(tag) {
      return {
        tag,
        dataset: {},
        attributes: {},
        children: [],
        textContent: '',
        parentNode: null,
        style: {},
        setAttribute(name, value) {
          this.attributes[name] = String(value)
        },
        getAttribute(name) {
          return this.attributes[name] ?? null
        },
        removeAttribute(name) {
          delete this.attributes[name]
        },
        appendChild(child) {
          this.children.push(child)
          if (child !== null && typeof child === 'object') child.parentNode = this
          return child
        },
        removeChild(child) {
          const index = this.children.indexOf(child)
          if (index >= 0) this.children.splice(index, 1)
          if (child !== null && typeof child === 'object') child.parentNode = null
          return child
        },
        addEventListener() {},
        removeEventListener() {},
        getBoundingClientRect() {
          return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }
        },
        focus() {},
        blur() {},
        contains() {
          return false
        },
        scrollIntoView() {},
        closest() {
          return null
        },
      }
    },
    addEventListener() {},
    removeEventListener() {},
    body: { appendChild() {} },
    documentElement: { style: {}, dataset: {} },
  }

  globalThis.document = document
  globalThis.window = globalThis
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  }
  globalThis.AbortController = globalThis.AbortController ?? class {},
  globalThis.fetch = async () => {
    throw new Error('the harness must not reach fetch')
  }
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  globalThis.location = { href: 'http://127.0.0.1:50963/', hostname: '127.0.0.1', pathname: '/' }
  return { styles, styleElements, React }
}

/* ---------- the fake connection ---------- */

const SUMMARY = {
  range: 30,
  currency: 'CNY',
  rate: 7.2,
  rateInfo: { cnyPerUsd: 7.2, source: 'open.er-api.com', fetchedAt: '2026-10-23T11:30:00.000Z' },
  kpis: {
    totalTokens: 13_400_000,
    costUsd: 12.34,
    dailyCostUsd: 0.41,
    cacheHitRate: 0.78,
    calls: 1420,
    missingCount: 1,
    unpricedTokens: 640_000,
    prev: { totalTokens: 11_000_000, costUsd: 10.1, dailyCostUsd: 0.34, cacheHitRate: 0.72 },
  },
  trend: Array.from({ length: 30 }, (_, index) => ({
    date: `2026-${index < 8 ? '09' : '10'}-${String((index % 28) + 1).padStart(2, '0')}`,
    uncachedInput: 120_000 + index * 1000,
    cacheRead: 260_000 + index * 2000,
    output: 30_000 + index * 100,
    costUsd: 0.3 + index * 0.01,
  })),
  byModel: [
    {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      calls: 900,
      input: 3_000_000,
      cacheRead: 7_000_000,
      output: 500_000,
      cacheHitRate: 0.7,
      costUsd: 9.1,
      source: 'models.dev',
      confidence: 'exact',
      missing: false,
    },
    {
      provider: 'magpie',
      model: 'workbuddy-ai/deepseek-v4.1-flash',
      calls: 400,
      input: 1_000_000,
      cacheRead: 1_500_000,
      output: 260_000,
      cacheHitRate: 0.6,
      costUsd: 2.4,
      source: 'models.dev',
      confidence: 'fuzzy',
      missing: false,
    },
    {
      provider: 'local',
      model: 'qwen-image',
      calls: 120,
      input: 640_000,
      cacheRead: 0,
      output: 100_000,
      cacheHitRate: 0,
      costUsd: 0,
      source: null,
      confidence: null,
      missing: true,
    },
  ],
  byWorkspace: [
    { workspace: 'code', tokens: 9_000_000, share: 0.67, costUsd: 8.5, costDisplay: 8.5 },
    { workspace: 'images', tokens: 3_000_000, share: 0.22, costUsd: 2.1, costDisplay: 2.1 },
    { workspace: '默认工作区', tokens: 1_400_000, share: 0.11, costUsd: 0.9, costDisplay: 0.9 },
  ],
  missing: [
    { provider: 'local', model: 'qwen-image', tokens: 640_000, suggestion: { provider: 'qwen', model: 'qwen-image', confidence: 'fuzzy', score: 2 } },
  ],
  progress: { state: 'ready', done: 12, total: 12 },
  pricesMeta: { source: 'models.dev', fetchedAt: '2026-10-23T09:00:00.000Z', refreshing: false },
}

const PRICES = {
  rows: [
    {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      calls: 900,
      tokens: 10_500_000,
      input: 3_000_000,
      cacheRead: 7_000_000,
      cacheWrite: 0,
      output: 500_000,
      price: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0.15 },
      source: 'models.dev',
      confidence: 'exact',
      matchedProvider: 'deepseek',
      matchedModel: 'deepseek-v4-flash',
      suggestions: [],
    },
    {
      provider: 'local',
      model: 'qwen-image',
      calls: 120,
      tokens: 740_000,
      input: 640_000,
      cacheRead: 0,
      cacheWrite: 0,
      output: 100_000,
      price: null,
      source: null,
      confidence: null,
      matchedProvider: null,
      matchedModel: null,
      suggestions: [{ provider: 'qwen', model: 'qwen-image', confidence: 'fuzzy', score: 2 }],
    },
  ],
  meta: { source: 'models.dev', fetchedAt: '2026-10-23T09:00:00.000Z', refreshing: false },
  rate: 7.2,
  rateInfo: { cnyPerUsd: 7.2, source: 'open.er-api.com', fetchedAt: '2026-10-23T11:30:00.000Z' },
}

function createConnection(overrides = {}) {
  const calls = []
  return {
    calls,
    rpc: {
      async call(channel, method, payload) {
        calls.push({ channel, method, payload })
        if (channel !== '/token-diet') {
          return { ok: false, error: { code: 'bad-request', message: 'wrong channel', details: {} } }
        }
        if (method === 'summary') return { ok: true, value: overrides.summary ?? SUMMARY }
        if (method === 'prices' || method === 'refreshPrices') return { ok: true, value: overrides.prices ?? PRICES }
        if (method === 'setCustomPrice' || method === 'removeCustomPrice') return { ok: true, value: overrides.prices ?? PRICES }
        if (method === 'rate' || method === 'refreshRate' || method === 'setRateOverride') {
          return { ok: true, value: { rate: 7.2, rateInfo: PRICES.rateInfo } }
        }
        if (method === 'indexStatus') return { ok: true, value: { progress: { state: 'ready', done: 3, total: 3 } } }
        if (method === 'sessionCost') return { ok: true, value: overrides.sessionCost ?? { spent: 0.62, limit: 1, currency: 'CNY', budgetCurrency: 'CNY', reached: false, unpriced: 0, rate: 7.2, rateInfo: PRICES.rateInfo } }
        if (method === 'setBudget') return { ok: true, value: overrides.sessionCost ?? { spent: 0.62, limit: 1, currency: 'CNY', budgetCurrency: 'CNY', reached: false, unpriced: 0, rate: 7.2 } }
        if (method === 'raiseBudgetAndContinue') return { ok: true, value: { spent: 0.62, limit: 2, currency: 'CNY', budgetCurrency: 'CNY', reached: false, unpriced: 0, rate: 7.2, continued: true } }
        if (method === 'dismissBudget') return { ok: true, value: { ok: true } }
        return { ok: false, error: { code: 'bad-request', message: `unknown ${method}`, details: {} } }
      },
    },
  }
}

/* ---------- bundle loading ---------- */

/** Load the built bundle and return the factory exports plus the shared namespace. */
async function loadBundle() {
  const source = await readFile(BUNDLE, 'utf8')
  const React = createFakeReact()
  const browser = installBrowser(React)
  let registration
  const window = {
    __ModuleLoader__: {
      load(entry) {
        registration = entry
      },
    },
  }
  const context = vm.createContext({
    window,
    document: globalThis.document,
    console,
    // `usePolling` schedules a real interval; `unref` keeps the test process from
    // waiting on it after the assertions finish.
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms)
      timer.unref?.()
      return timer
    },
    clearTimeout,
    setInterval: (fn, ms) => {
      const timer = setInterval(fn, ms)
      timer.unref?.()
      return timer
    },
    clearInterval,
    fetch: globalThis.fetch,
    AbortController: globalThis.AbortController,
    ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    matchMedia: globalThis.matchMedia,
    location: globalThis.location,
    queueMicrotask,
    URL,
    Date,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    Promise,
    Error,
    isFinite,
    isNaN,
    parseInt,
    parseFloat,
  })
  vm.runInContext(source, context, { filename: 'client.js' })
  assert.ok(registration !== undefined, 'the bundle registered a module')
  assert.equal(registration.id, 'dsh-token-diet', 'the module id is the package name')

  const captured = new Map()
  const require = (spec) => {
    if (spec === 'react') return React
    return captured.get(spec)
  }
  const exportsObject = registration.factory(require)
  return { exports: exportsObject, React, browser, context }
}

/** Deeply render an element tree, invoking function components. */
function renderTree(element, React, depth = 0) {
  if (depth > 40) return ''
  if (element === null || element === undefined || element === false || element === true) return ''
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  if (Array.isArray(element)) return element.map((child) => renderTree(child, React, depth + 1)).join('')
  if (typeof element === 'function') {
    React.__begin()
    return renderTree(element({}), React, depth + 1)
  }
  if (typeof element.type === 'function') {
    React.__begin()
    const props = { ...element.props }
    delete props.children
    return renderTree(element.type({ ...props, children: element.props.children }), React, depth + 1)
  }
  if (typeof element.type === 'string') {
    return renderTree(element.props?.children, React, depth + 1)
  }
  return renderTree(element.props?.children, React, depth + 1)
}

/**
 * Render one component repeatedly until its output stops changing, flushing
 * microtasks between passes so `useEffect` + async RPC results are applied.
 *
 * This models what React does with a `setState` from a resolved promise: the
 * fake `useState` keeps a stable slot per call index, so the next pass reads the
 * settled value.
 */
async function renderUntilStable(Component, props, React, options = {}) {
  const maxPasses = options.maxPasses ?? 8
  let previous = null
  for (let pass = 0; pass < maxPasses; pass += 1) {
    React.__begin()
    let tree
    try {
      tree = Component(props)
    } catch (error) {
      throw new Error(`render pass ${pass} threw: ${error && error.stack ? error.stack : error}`)
    }
    const text = renderTree(tree, React)
    // Let promise callbacks (RPC resolves) run before the next pass.
    for (let flush = 0; flush < 4; flush += 1) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (text === previous) return text
    previous = text
  }
  return previous ?? ''
}

/** Collect every element of a rendered tree whose className contains `name`. */
function elementsWithClass(tree, name, out = []) {
  if (tree === null || tree === undefined) return out
  if (Array.isArray(tree)) {
    for (const child of tree) elementsWithClass(child, name, out)
    return out
  }
  if (typeof tree !== 'object') return out
  const className = tree.props?.className
  if (typeof className === 'string' && className.split(/\s+/).includes(name)) out.push(tree)
  if (tree.type !== undefined) elementsWithClass(tree.props?.children, name, out)
  return out
}

/* ---------- tests ---------- */

test('the bundle registers the package id and the expected exports', async () => {
  const { exports } = await loadBundle()
  assert.equal(typeof exports.apply, 'function')
  assert.ok(Array.isArray(exports.inject))
  assert.ok(exports.inject.includes('slots'))
  assert.ok(exports.inject.includes('locale'))
})

test('apply registers the locale dictionaries and the four slots', async () => {
  const { exports } = await loadBundle()
  const registrations = []
  const dictionaries = []
  const styleEffects = []

  const fakeCtx = {
    effect(fn, label) {
      styleEffects.push(label)
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    locale: {
      register(ns, dicts) {
        dictionaries.push({ ns, dicts })
        return () => {}
      },
      bind() {
        return (key, params) => {
          const dict = dictionaries[0]?.dicts?.zh ?? {}
          let text = dict[key] ?? key
          for (const [name, value] of Object.entries(params ?? {})) {
            text = text.split(`{${name}}`).join(String(value))
          }
          return text
        }
      },
    },
    slots: {
      inject(key, callback) {
        registrations.push(key)
        callback()
        return () => {}
      },
      register(options) {
        registrations.push(options)
        return () => {}
      },
    },
    get(name) {
      if (name === 'connection') return undefined
      return undefined
    },
  }

  exports.apply(fakeCtx)

  assert.equal(dictionaries.length, 1, 'one locale registration')
  assert.equal(dictionaries[0].ns, 'token-diet')
  const { en, zh } = dictionaries[0].dicts
  assert.ok(Object.keys(en).length > 100, `expected a populated dictionary, got ${Object.keys(en).length}`)
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'en and zh keys match')

  const slotKeys = registrations.filter((entry) => typeof entry === 'string')
  assert.deepEqual(slotKeys.sort(), [
    'conversation.composer.dock',
    'conversation.input.overlay',
    'conversation.input.right',
    'main',
    'sidebar.panellist',
  ])

  const options = registrations.filter((entry) => typeof entry === 'object')
  const sidebar = options.find((entry) => entry.name === 'sidebar.panellist')
  assert.equal(sidebar.id, 'token-diet')
  assert.equal(typeof sidebar.label, 'function')
  assert.equal(sidebar.label(), 'Token 统计')

  const main = options.find((entry) => entry.name === 'main')
  assert.equal(main.key, 'token-diet')

  const budget = options.find((entry) => entry.name === 'conversation.input.right')
  assert.equal(budget.id, 'token-diet-budget')

  const popover = options.find((entry) => entry.name === 'conversation.input.overlay')
  assert.equal(popover.id, 'token-diet-budget-popover')
})

test('the stats page renders the real summary without throwing', async () => {
  const { exports, React, browser } = await loadBundle()
  const connection = createConnection()

  const fakeCtx = makeCtx(connection)
  exports.apply(fakeCtx)
  const TD = exports.__TD
  assert.ok(TD !== undefined, 'the bundle exposes its namespace for tests')
  TD.ctx = fakeCtx

  const Page = TD.StatsPage
  assert.equal(typeof Page, 'function')

  const text = await renderUntilStable(Page, { t: fakeCtx.locale.bind('token-diet'), ctx: fakeCtx, connection }, React)

  assert.ok(text.includes('Token 统计'), 'the page title renders')
  assert.ok(text.length > 200, 'the page produced content')
  assert.ok(!text.includes('page.'), `no raw dictionary keys leaked: ${text.slice(0, 400)}`)
  assert.ok(browser.styles.length >= 1, 'a stylesheet was injected')
  assert.ok(connection.calls.some((call) => call.method === 'summary'), 'summary was requested')
  // The real numbers must reach the DOM, not just the loading state.
  assert.ok(/13\.4M|13\.40M|13400000/.test(text), `expected the total token figure, got: ${text.slice(0, 600)}`)
  assert.ok(text.includes('缓存命中') || text.includes('cache hit'), 'the cache-hit KPI rendered')
  assert.ok(text.includes('deepseek-v4-flash'), 'the model table rendered')
  assert.ok(text.includes('qwen-image'), 'the unpriced model is listed')
})

/** Render the stats page until `ready(tree)` is true, flushing async RPC. */
async function renderStatsPage(TD, React, props, ready = () => true) {
  let tree = null
  for (let pass = 0; pass < 8; pass += 1) {
    React.__begin()
    tree = TD.StatsPage(props)
    for (let flush = 0; flush < 4; flush += 1) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (ready(tree)) break
  }
  return tree
}

test('the by-workspace block shows tokens, share and cost', async () => {
  const { exports, React } = await loadBundle()
  const connection = createConnection()
  const fakeCtx = makeCtx(connection)
  exports.apply(fakeCtx)
  const TD = exports.__TD
  TD.ctx = fakeCtx

  const tree = await renderStatsPage(
    TD,
    React,
    { t: fakeCtx.locale.bind('token-diet'), ctx: fakeCtx, connection },
    (candidate) => elementsWithClass(candidate, 'td-ws-refresh').length > 0,
  )

  const blocks = elementsWithClass(tree, 'td-share')
  assert.equal(blocks.length, 1, 'the workspace block rendered')
  const rowText = renderTree(blocks[0], React)
  assert.ok(rowText.includes('code'), 'the workspace name renders')
  assert.ok(rowText.includes(TD.util.fmtTokens(9_000_000)), 'the token count renders')
  assert.ok(rowText.includes(TD.util.fmtPct(0.67)), 'the share renders')
  assert.ok(
    rowText.includes(TD.util.fmtCost(8.5, 'CNY', 1)),
    `the workspace cost renders: ${rowText}`,
  )
})

test('the by-workspace refresh button re-fetches the summary', async () => {
  const { exports, React } = await loadBundle()
  const connection = createConnection()
  const fakeCtx = makeCtx(connection)
  exports.apply(fakeCtx)
  const TD = exports.__TD
  TD.ctx = fakeCtx

  const tree = await renderStatsPage(
    TD,
    React,
    { t: fakeCtx.locale.bind('token-diet'), ctx: fakeCtx, connection },
    (candidate) => elementsWithClass(candidate, 'td-ws-refresh').length > 0,
  )

  const buttons = elementsWithClass(tree, 'td-ws-refresh')
  assert.equal(buttons.length, 1, 'one refresh button in the workspace section head')
  assert.notEqual(buttons[0].props.disabled, true, 'it is enabled when idle')
  assert.ok(renderTree(buttons[0], React).includes('刷新'), 'it carries a label')

  const count = () => connection.calls.filter((call) => call.method === 'summary').length
  const before = count()
  buttons[0].props.onClick()
  assert.equal(count(), before + 1, 'clicking refresh asks the Host for the summary again')
})

test('the tab bar switches between the usage and prices sub-pages', async () => {
  const { exports, React } = await loadBundle()
  const connection = createConnection()
  const fakeCtx = makeCtx(connection)
  exports.apply(fakeCtx)
  const TD = exports.__TD
  TD.ctx = fakeCtx
  const props = { t: fakeCtx.locale.bind('token-diet'), ctx: fakeCtx, connection }

  const tree = await renderStatsPage(TD, React, props, (candidate) => elementsWithClass(candidate, 'td-share').length > 0)
  const usageText = renderTree(tree, React)
  assert.ok(usageText.includes('按工作区'), 'the usage tab starts on the usage sections')
  assert.ok(!usageText.includes('模型价格'), 'the price table is not on the usage tab')

  const tabs = elementsWithClass(tree, 'td-tab')
  assert.equal(tabs.length, 2, 'two sub-page tabs')
  assert.equal(tabs[0].props['aria-pressed'], 'true', 'usage is the default tab')
  assert.equal(tabs[1].props['aria-pressed'], 'false')

  tabs[1].props.onClick()
  const pricesTree = await renderStatsPage(TD, React, props)
  const pricesText = renderTree(pricesTree, React)
  assert.ok(pricesText.includes('模型价格'), 'the prices tab renders the price table')
  assert.ok(pricesText.includes('从 models.dev 刷新'), 'the prices tab keeps its refresh action')
  assert.ok(!pricesText.includes('按工作区'), 'the usage body is not on the prices tab')
  const pressed = elementsWithClass(pricesTree, 'td-tab')
  assert.equal(pressed[1].props['aria-pressed'], 'true', 'the prices tab reports itself as pressed')

  // ...and switching back leaves the price table behind.
  pressed[0].props.onClick()
  const backTree = await renderStatsPage(TD, React, props)
  const backText = renderTree(backTree, React)
  assert.ok(backText.includes('按工作区'), 'the usage tab comes back')
  assert.ok(!backText.includes('模型价格'), 'the price table is gone again')
})

test('an empty summary renders an explanatory state, not a crash', async () => {
  const { exports, React } = await loadBundle()
  const connection = createConnection({
    summary: {
      ...SUMMARY,
      kpis: { totalTokens: 0, costUsd: 0, dailyCostUsd: 0, cacheHitRate: 0, calls: 0, missingCount: 0, unpricedTokens: 0, prev: { totalTokens: 0, costUsd: 0, dailyCostUsd: 0, cacheHitRate: 0 } },
      trend: [],
      byModel: [],
      byWorkspace: [],
      missing: [],
      progress: { state: 'scanning', done: 4, total: 12 },
    },
  })
  const fakeCtx = makeCtx(connection)
  exports.apply(fakeCtx)
  const TD = exports.__TD
  TD.ctx = fakeCtx
  const text = await renderUntilStable(
    TD.StatsPage,
    { t: fakeCtx.locale.bind('token-diet'), ctx: fakeCtx, connection },
    React,
  )
  assert.ok(text.length > 0)
  assert.ok(!text.includes('page.'), 'no raw keys leaked in the empty state')
  assert.ok(text.includes('扫描') || text.includes('Indexing') || text.includes('暂无'), 'the empty/scanning state is explained')
})

test('the budget field renders used/limit and the warning states', async () => {
  const { exports, React } = await loadBundle()
  const cases = [
    { sessionCost: { spent: 0.62, limit: 1, currency: 'CNY', budgetCurrency: 'CNY', reached: false, unpriced: 0, rate: 7.2 } },
    { sessionCost: { spent: 0.85, limit: 1, currency: 'CNY', budgetCurrency: 'CNY', reached: false, unpriced: 2, rate: 7.2 } },
    { sessionCost: { spent: 1.2, limit: 1, currency: 'CNY', budgetCurrency: 'CNY', reached: true, unpriced: 0, rate: 7.2 } },
    { sessionCost: { spent: 0, limit: null, currency: 'CNY', budgetCurrency: null, reached: false, unpriced: 0, rate: 7.2 } },
  ]
  for (const entry of cases) {
    const connection = createConnection(entry)
    const fakeCtx = makeCtx(connection)
    exports.apply(fakeCtx)
    const TD = exports.__TD
    TD.ctx = fakeCtx
    const text = await renderUntilStable(
      TD.BudgetField,
      { sessionId: 'session-1', t: fakeCtx.locale.bind('token-diet'), ctx: fakeCtx, connection },
      React,
    )
    assert.ok(text.length > 0, `the field rendered for ${JSON.stringify(entry.sessionCost)}`)
    assert.ok(!text.includes('budget.'), 'no raw keys leaked in the budget field')
    assert.ok(text.includes('¥') || text.includes('不限'), `the money/placeholder text rendered, got: ${text.slice(0, 200)}`)
  }
})

test('the budget field never converts an already-converted amount twice', async () => {
  // Real Host payload: `spent` is ALREADY in the display currency (CNY) and
  // `spentUsd` carries the USD figure. Treating `spent` as USD inflated the field
  // by the exchange rate — the reported ¥81.67 was really ¥12.21.
  const { exports, React } = await loadBundle()
  const connection = createConnection({
    sessionCost: {
      sessionId: 'session-1',
      root: 'session-1',
      spent: 13.014613, // CNY
      spentUsd: 1.945899, // the same amount in USD
      limit: null,
      currency: 'CNY',
      budgetCurrency: null,
      reached: false,
      unpriced: 0,
      rate: 6.6882,
    },
  })
  const fakeCtx = makeCtx(connection)
  exports.apply(fakeCtx)
  const TD = exports.__TD
  TD.ctx = fakeCtx

  const text = await renderUntilStable(
    TD.BudgetField,
    { sessionId: 'session-1', t: fakeCtx.locale.bind('token-diet'), ctx: fakeCtx, connection },
    React,
  )

  assert.ok(text.includes('¥13.01'), `expected the real CNY amount ¥13.01, got: ${text.slice(0, 200)}`)
  assert.ok(
    !text.includes('87.0') && !text.includes('¥87'),
    `the double-converted amount must not appear: ${text.slice(0, 200)}`,
  )

  // The same rule holds for a USD display: 1.945899 must not become 13.01.
  const usdConnection = createConnection({
    sessionCost: {
      sessionId: 'session-1',
      spent: 1.945899,
      spentUsd: 1.945899,
      limit: null,
      currency: 'USD',
      budgetCurrency: null,
      reached: false,
      unpriced: 0,
      rate: 6.6882,
    },
  })
  const usdCtx = makeCtx(usdConnection)
  exports.apply(usdCtx)
  TD.ctx = usdCtx
  const usdText = await renderUntilStable(
    TD.BudgetField,
    { sessionId: 'session-1', t: usdCtx.locale.bind('token-diet'), ctx: usdCtx, connection: usdConnection },
    React,
  )
  assert.ok(usdText.includes('$1.95'), `expected $1.95 in USD mode, got: ${usdText.slice(0, 200)}`)
  assert.ok(!usdText.includes('$13'), 'the amount must not be scaled by the rate in USD mode')
})

test('the budget popover renders only once reached', async () => {
  const { exports, React } = await loadBundle()

  const idleConnection = createConnection()
  const idleCtx = makeCtx(idleConnection)
  exports.apply(idleCtx)
  const TD = exports.__TD
  TD.ctx = idleCtx
  const idle = await renderUntilStable(
    TD.BudgetPopover,
    { sessionId: 'session-1', t: idleCtx.locale.bind('token-diet'), ctx: idleCtx, connection: idleConnection },
    React,
    { maxPasses: 3 },
  )
  assert.equal(idle.trim(), '', 'no popover while under budget')

  const reachedConnection = createConnection({
    sessionCost: { spent: 1.2, limit: 1, currency: 'CNY', budgetCurrency: 'CNY', reached: true, unpriced: 0, rate: 7.2 },
  })
  const reachedCtx = makeCtx(reachedConnection)
  exports.apply(reachedCtx)
  TD.ctx = reachedCtx
  const reached = await renderUntilStable(
    TD.BudgetPopover,
    { sessionId: 'session-1', t: reachedCtx.locale.bind('token-diet'), ctx: reachedCtx, connection: reachedConnection },
    React,
  )
  assert.ok(reached.length > 0, 'the popover rendered once reached')
  assert.ok(!reached.includes('budget.'), 'no raw keys leaked in the popover')
  assert.ok(reachedConnection.calls.some((call) => call.method === 'sessionCost'))
})

test('the budget sheet gets its own <style> element, not the chrome one', async () => {
  // Regression: `installStyles` used one shared tag, so the chrome sheet
  // installed from `apply()` swallowed the budget sheet mounted later. The
  // field, popover and notice then rendered with no CSS at all — the popover
  // showed up as plain inline text on top of the composer.
  const { exports, React, browser } = await loadBundle()
  const connection = createConnection()
  const fakeCtx = makeCtx(connection)
  exports.apply(fakeCtx)

  const chrome = browser.styleElements.filter(
    (node) => node.dataset?.dshTokenDiet === 'token-diet-chrome',
  )
  assert.equal(chrome.length, 1, 'the chrome sheet is installed under its own key')

  const TD = exports.__TD
  TD.ctx = fakeCtx
  await renderUntilStable(
    TD.BudgetField,
    { sessionId: 'session-1', t: fakeCtx.locale.bind('token-diet'), ctx: fakeCtx, connection },
    React,
  )

  const budget = browser.styleElements.filter(
    (node) => node.dataset?.dshTokenDiet === 'token-diet-budget',
  )
  assert.equal(budget.length, 1, 'the budget sheet is installed under its own key')
  const css = budget[0].textContent
  assert.ok(css.includes('.td-bud-field'), 'the field rules are present')
  assert.ok(css.includes('.td-bud-pop'), 'the popover rules are present')
  assert.ok(
    /\.td-bud-pop\{[^}]*position:fixed/.test(css),
    'the popover is placed from viewport coordinates, not by its container',
  )
  assert.ok(!/\.td-bud-pop\{[^}]*right:0/.test(css), 'the popover is no longer anchored with right:0')
})

test('the popover is never laid out in the composer flow', async () => {
  const { exports, React } = await loadBundle()
  const connection = createConnection({
    sessionCost: { spent: 1.2, limit: 1, currency: 'CNY', budgetCurrency: 'CNY', reached: true, unpriced: 0, rate: 7.2 },
  })
  const fakeCtx = makeCtx(connection)
  exports.apply(fakeCtx)
  const TD = exports.__TD
  TD.ctx = fakeCtx

  let tree = null
  // The card only appears after the poll's promise resolves, so render the way
  // the other tests do: repeat passes, flushing the RPC microtasks in between.
  for (let pass = 0; pass < 8; pass += 1) {
    React.__begin()
    tree = TD.BudgetPopover({
      sessionId: 'session-1',
      t: fakeCtx.locale.bind('token-diet'),
      ctx: fakeCtx,
      connection,
    })
    for (let flush = 0; flush < 4; flush += 1) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (elementsWithClass(tree, 'td-bud-pop').length > 0) break
  }

  const cards = elementsWithClass(tree, 'td-bud-pop')
  assert.equal(cards.length, 1, 'one popover card is rendered')
  const style = cards[0].props.style
  assert.ok(style !== undefined, 'the card carries an explicit placement style')
  assert.equal(style.position, 'fixed', 'the card leaves normal flow immediately')
  assert.equal(style.visibility, 'hidden', 'unmeasured cards stay invisible instead of flashing in flow')
  assert.equal(style.left, '-9999px')
  assert.equal(cards[0].props.role, 'alertdialog')
  assert.equal(cards[0].props['aria-modal'], 'true')
  assert.ok(
    style.right === undefined && style.bottom === undefined,
    'no container-relative anchoring is used any more',
  )
})

/** A fake client ctx sufficient for apply() + component rendering. */
function makeCtx(connection) {
  const dictionaries = []
  return {
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    locale: {
      register(ns, dicts) {
        dictionaries.push({ ns, dicts })
        return () => {}
      },
      bind() {
        const dict = dictionaries[0]?.dicts?.zh ?? {}
        return (key, params) => {
          let text = dict[key] ?? key
          for (const [name, value] of Object.entries(params ?? {})) {
            text = text.split(`{${name}}`).join(String(value))
          }
          return text
        }
      },
    },
    slots: {
      inject(_key, callback) {
        callback()
        return () => {}
      },
      register() {
        return () => {}
      },
    },
    get(name) {
      return name === 'connection' ? connection : undefined
    },
  }
}
