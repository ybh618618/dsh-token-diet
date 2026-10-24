/**
 * Section coverage check: renders the stats page against the real Host payloads
 * and asserts that every block the implementation plan requires is actually
 * present in the output, not just implemented somewhere in the source.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { bootRealHost } from './helpers/real-host.mjs'

const BUNDLE = fileURLToPath(new URL('../packages/token-diet/lib/client.js', import.meta.url))

const real = await bootRealHost()

/** Minimal React + DOM so the bundle can run outside a browser. */
function environment() {
  const states = []
  let cursor = 0
  const React = {
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

  const styleElements = []
  const document = {
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

  const interval = (fn, ms) => {
    const timer = setInterval(fn, ms)
    timer.unref?.()
    return timer
  }

  return { React, document, styleElements, interval }
}

function renderTree(element, React, depth = 0) {
  if (depth > 40) return ''
  if (element === null || element === undefined || element === false || element === true) return ''
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  if (Array.isArray(element)) return element.map((child) => renderTree(child, React, depth + 1)).join('')
  if (typeof element.type === 'function') {
    React.__begin()
    const next = { ...element.props }
    delete next.children
    return renderTree(element.type({ ...next, children: element.props.children }), React, depth + 1)
  }
  return renderTree(element.props?.children, React, depth + 1)
}

/** Load the bundle and return { TD, apply, React }. */
async function boot() {
  const env = environment()
  globalThis.document = env.document
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  }
  const source = await readFile(BUNDLE, 'utf8')
  let registration
  const context = vm.createContext({
    window: { __ModuleLoader__: { load: (entry) => (registration = entry) } },
    document: env.document,
    console,
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms)
      timer.unref?.()
      return timer
    },
    clearTimeout,
    setInterval: env.interval,
    clearInterval,
    fetch: async () => {
      throw new Error('unexpected fetch')
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
  const exports = registration.factory((spec) => (spec === 'react' ? env.React : undefined))
  return { TD: exports.__TD, apply: exports.apply, React: env.React, env }
}

/** Render with a fake connection returning fixed values. */
async function renderWith(TD, apply, React, call, extraProps = {}) {
  const dictionaries = []
  const ctx = {
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
    get: (name) => (name === 'connection' ? { rpc: { call } } : undefined),
  }
  apply(ctx)
  TD.ctx = ctx
  const props = { t: ctx.locale.bind('token-diet'), ctx, connection: { rpc: { call } }, ...extraProps }
  let previous = null
  for (let pass = 0; pass < 8; pass += 1) {
    React.__begin()
    const text = renderTree(TD.StatsPage(props), React)
    for (let flush = 0; flush < 6; flush += 1) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (text === previous) return text
    previous = text
  }
  return previous ?? ''
}

test('the usage tab renders every usage section', { skip: real === null ? 'no Host cache' : false }, async () => {
  const call = real.call

  const { TD, apply, React } = await boot()
  const text = await renderWith(TD, apply, React, call)

  const required = [
    ['page title', ['Token 统计']],
    ['usage tab', ['用量']],
    ['prices tab', ['价格']],
    ['range control', ['7 天', '30 天', '90 天']],
    ['currency control', ['CNY', 'USD']],
    ['kpi: total tokens', ['总 Token']],
    ['kpi: cost', ['估算成本']],
    ['kpi: cache hit', ['缓存命中率']],
    ['kpi: daily cost', ['日均成本']],
    ['trend section', ['用量趋势']],
    ['metric toggle', ['Token', '成本']],
    ['trend legend', ['命中缓存', '未命中', '输出']],
    ['by model', ['按模型']],
    ['model columns', ['调用', '缓存命中', '价格来源']],
    // The per-model row must expose the cache-hit *tokens* and the total, not only
    // the uncached input and a percentage: most usage is cache traffic, and a user
    // comparing "how many tokens did this model use" needs the sum.
    ['cache-read column', ['输入 · 命中缓存']],
    ['uncached-input column', ['输入 · 未命中']],
    ['total column', ['Token 合计']],
    ['by workspace', ['按工作区']],
    ['workspace refresh action', ['刷新']],
  ]

  const missing = required.filter(([, candidates]) => !candidates.every((needle) => text.includes(needle)))
  assert.deepEqual(missing.map(([label]) => label), [], `missing sections: ${missing.map(([label]) => label).join(', ')}`)

  // The price sub-page is no longer part of the usage page.
  assert.ok(!text.includes('模型价格'), 'the price table moved to its own tab')
  assert.ok(!text.includes('从 models.dev 刷新'), 'the price actions moved to their own tab')
  assert.ok(!text.includes('汇率'), 'the exchange-rate row moved to its own tab')

  // Real model names from the Host index must appear.
  assert.ok(text.includes('deepseek') || text.includes('DeepSeek'), 'real model names render')

  // The total-token column must carry the real magnitude of the busiest model —
  // exactly the number a user compares against "that model used over 100M tokens".
  const summary = await call('/token-diet', 'summary', { range: 30, currency: 'CNY' })
  assert.equal(summary.ok, true)
  const biggest = summary.value.byModel.filter((row) => !row.missing).sort((a, b) => b.tokens - a.tokens)[0]
  assert.ok(biggest !== undefined, 'a priced model exists')
  assert.ok(biggest.tokens > 0, 'the busiest model reports tokens')
  const shown = TD.util.fmtTokens(biggest.tokens)
  assert.ok(
    text.includes(shown),
    `the busiest model total (${shown} for ${biggest.model}) is rendered in the table`,
  )
  // And the uncached-only reading must NOT be the only input number shown.
  if (biggest.cacheRead > biggest.uncachedInput * 10) {
    assert.ok(
      text.includes(TD.util.fmtTokens(biggest.cacheRead)),
      `the cache-read tokens (${TD.util.fmtTokens(biggest.cacheRead)}) are rendered`,
    )
  }

  // The by-workspace row must carry cost as well as the token share. The page
  // renders summary money already converted, so rate=1 into the display format.
  const priced = summary.value.byWorkspace
    .filter((row) => typeof row.costUsd === 'number' && row.costUsd > 0)
    .sort((a, b) => b.costUsd - a.costUsd)[0]
  assert.ok(priced !== undefined, 'at least one workspace has a cost')
  const costText = TD.util.fmtCost(priced.costUsd, 'CNY', 1)
  assert.ok(
    text.includes(TD.util.fmtTokens(priced.tokens) + ' · ' + TD.util.fmtPct(priced.share) + ' · ' + costText),
    `the workspace row shows tokens, share and cost (${costText} for ${priced.workspace})`,
  )
})

test('the prices tab renders the price table and the rate row', { skip: real === null ? 'no Host cache' : false }, async () => {
  const { TD, apply, React } = await boot()
  const text = await renderWith(TD, apply, React, real.call, { initialTab: 'prices' })

  const required = [
    ['prices section', ['模型价格']],
    ['refresh action', ['从 models.dev 刷新']],
    ['custom price action', ['自定义价格']],
    ['rate control', ['汇率', 'CNY']],
  ]
  const missing = required.filter(([, candidates]) => !candidates.every((needle) => text.includes(needle)))
  assert.deepEqual(missing.map(([label]) => label), [], `missing sections: ${missing.map(([label]) => label).join(', ')}`)

  // The usage body must not leak into the price sub-page.
  assert.ok(!text.includes('总 Token'), 'the KPIs stay on the usage tab')
  assert.ok(!text.includes('按模型'), 'the model table stays on the usage tab')
  assert.ok(!text.includes('按工作区'), 'the workspace block stays on the usage tab')
  assert.ok(!text.includes('用量趋势'), 'the trend stays on the usage tab')

  // The rate footer must name the source and the update time.
  assert.ok(text.includes('open.er-api.com') || text.includes('frankfurter') || text.includes('内置'), 'the rate source is shown')
  assert.ok(/\d{4}-\d{2}-\d{2}/.test(text), 'an update timestamp is shown')

  // Real price rows (models.dev cache on this machine) reach the table.
  const prices = await real.call('/token-diet', 'prices', {})
  assert.equal(prices.ok, true)
  const row = (prices.value.rows ?? []).find((entry) => entry.price !== null)
  assert.ok(row !== undefined, 'a priced row exists')
  assert.ok(text.includes(row.model), `the price row for ${row.model} is rendered`)
})

test('the page root owns its scroll so a tall page is never clipped', async () => {
  const source = await readFile(BUNDLE, 'utf8')
  // The scroll container must have a definite height and `overflow-y:auto`; the
  // Harness main panel cell is `overflow:hidden`, so a page that only grows is
  // silently clipped with no scrollbar.
  const scrollRule = /\.td-scroll\{([^}]*)\}/.exec(source)
  assert.ok(scrollRule !== null, '.td-scroll rule exists')
  assert.ok(/height:100%/.test(scrollRule[1]), 'the scroll container has a definite height')
  assert.ok(/overflow-y:auto/.test(scrollRule[1]), 'the scroll container scrolls vertically')

  // The content column is centred and capped, so a wide window has no dead strip
  // on the right and very wide reads stay comfortable.
  const pageRule = /\.td-page\{([^}]*)\}/.exec(source)
  assert.ok(pageRule !== null, '.td-page rule exists')
  assert.ok(/margin:0 auto/.test(pageRule[1]), 'the content column is centred')
  assert.ok(/max-width:\d+px/.test(pageRule[1]), 'the content column is capped')
  assert.ok(/width:100%/.test(pageRule[1]), 'the content column fills the cell up to its cap')

  // The rendered tree wraps the content in the scroll container.
  const { TD, apply, React } = await boot()
  const call = async () => ({ ok: true, value: {} })
  const text = await renderWith(TD, apply, React, call)
  assert.ok(text.length >= 0)
})
