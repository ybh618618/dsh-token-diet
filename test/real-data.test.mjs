/**
 * Real-data render check: boots the real Host half against this machine's
 * caches (via `helpers/real-host.mjs`, inside a throw-away home) and renders
 * every client component against the payloads it answers with, so a shape drift
 * between halves fails a test instead of blanking the page.
 *
 * The test skips when no index cache exists (fresh machine, CI).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { bootRealHost } from './helpers/real-host.mjs'

const BUNDLE = fileURLToPath(new URL('../packages/token-diet/lib/client.js', import.meta.url))

const real = await bootRealHost()

test('the client renders the real Host payloads', { skip: real === null ? 'no Host cache on this machine' : false }, async () => {
  const caches = { index: real.index }
  const rpc = { call: real.call }
  const dispose = () => {
    void real.dispose()
  }

  const React = createReact()
  installDom()
  const source = await readFile(BUNDLE, 'utf8')
  let registration
  const context = vm.createContext({
    window: { __ModuleLoader__: { load: (entry) => (registration = entry) } },
    document: globalThis.document,
    console,
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
    fetch: async () => {
      throw new Error('no fetch expected')
    },
    AbortController,
    ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    location: { href: 'http://127.0.0.1:50963/', hostname: '127.0.0.1' },
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
  const exports = registration.factory((spec) => (spec === 'react' ? React : undefined))
  const TD = exports.__TD

  const dictionaries = []
  const fakeCtx = {
    effect: (fn) => {
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
          for (const [name, value] of Object.entries(params ?? {})) text = text.split(`{${name}}`).join(String(value))
          return text
        }
      },
    },
    slots: {
      inject(_key, callback) {
        callback()
        return () => {}
      },
      register: () => () => {},
    },
    get: (name) => (name === 'connection' ? { rpc } : undefined),
  }
  exports.apply(fakeCtx)
  TD.ctx = fakeCtx

  const connection = { rpc }
  const props = { t: fakeCtx.locale.bind('token-diet'), ctx: fakeCtx, connection }

  const pageText = await renderUntilStable(TD.StatsPage, props, React)
  assert.ok(pageText.includes('Token 统计'), 'the page title renders from the real payload')
  assert.ok(!pageText.includes('page.'), `no raw keys leaked: ${pageText.slice(0, 300)}`)
  assert.ok(pageText.length > 500, `the page rendered real content (${pageText.length} chars)`)

  // The budget field must render for a real session id.
  const firstSession = Object.keys(caches.index.sessions ?? {})[0]
  assert.ok(typeof firstSession === 'string' && firstSession.length > 0, 'a real session id exists')
  const fieldText = await renderUntilStable(TD.BudgetField, { ...props, sessionId: firstSession }, React)
  assert.ok(fieldText.length > 0, 'the budget field rendered for a real session')
  assert.ok(fieldText.includes('¥'), `the field shows a CNY amount: ${fieldText.slice(0, 160)}`)
  assert.ok(!fieldText.includes('budget.'), 'no raw keys leaked in the field')

  // No render threw, and every RPC round trip stayed on our channel.
  dispose()

  function createReact() {
    const states = []
    let cursor = 0
    return {
      createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.flat(Infinity) } }),
      useState(initial) {
        const index = cursor++
        if (states[index] === undefined) states[index] = { value: typeof initial === 'function' ? initial() : initial }
        return [states[index].value, (next) => (states[index].value = typeof next === 'function' ? next(states[index].value) : next)]
      },
      useRef(initial) {
        const index = cursor++
        if (states[index] === undefined) states[index] = { current: initial ?? null }
        return states[index]
      },
      useMemo: (factory) => (cursor++, factory()),
      useCallback: (fn) => (cursor++, fn),
      useEffect: (effect) => (cursor++, effect()),
      useLayoutEffect: (effect) => (cursor++, effect()),
      useSyncExternalStore: (_subscribe, getSnapshot) => (cursor++, getSnapshot()),
      useReducer(reducer, initial) {
        const index = cursor++
        if (states[index] === undefined) states[index] = { value: initial }
        return [states[index].value, (action) => (states[index].value = reducer(states[index].value, action))]
      },
      useId: () => (cursor++, 'id-' + cursor),
      useTransition: () => (cursor++, [false, (fn) => fn()]),
      useDeferredValue: (value) => (cursor++, value),
      startTransition: (fn) => fn(),
      memo: (component) => component,
      forwardRef: (component) => component,
      createContext: (value) => ({ Provider: 'Provider', Consumer: 'Consumer', _currentValue: value }),
      Fragment: 'Fragment',
      __begin: () => {
        cursor = 0
      },
    }
  }

  function installDom() {
    const styleElements = []
    globalThis.document = {
      head: { appendChild: (node) => styleElements.push(node) },
      querySelector: () => styleElements[0] ?? null,
      querySelectorAll: () => [],
      createElement: (tag) => ({
        tag,
        dataset: {},
        attributes: {},
        style: {},
        setAttribute(name, value) {
          this.attributes[name] = String(value)
        },
        appendChild() {},
        removeChild() {},
        addEventListener() {},
        removeEventListener() {},
        getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
        focus() {},
        contains: () => false,
      }),
      addEventListener() {},
      removeEventListener() {},
      body: { appendChild() {} },
      documentElement: { style: {}, dataset: {} },
    }
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
  }

  function renderTree(element, react, depth = 0) {
    if (depth > 40) return ''
    if (element === null || element === undefined || element === false || element === true) return ''
    if (typeof element === 'string' || typeof element === 'number') return String(element)
    if (Array.isArray(element)) return element.map((child) => renderTree(child, react, depth + 1)).join('')
    if (typeof element.type === 'function') {
      react.__begin()
      const next = { ...element.props }
      delete next.children
      return renderTree(element.type({ ...next, children: element.props.children }), react, depth + 1)
    }
    return renderTree(element.props?.children, react, depth + 1)
  }

  async function renderUntilStable(Component, props, react, maxPasses = 8) {
    let previous = null
    for (let pass = 0; pass < maxPasses; pass += 1) {
      react.__begin()
      const text = renderTree(Component(props), react)
      for (let flush = 0; flush < 6; flush += 1) await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (text === previous) return text
      previous = text
    }
    return previous ?? ''
  }
})
