/**
 * The `/token-diet` RPC endpoint table.
 *
 * This is one of the two DSH-facing files of the bundle (the other is
 * `lib/index.js`): it is the only place that knows the Connection RPC channel
 * shape. Everything else it touches arrives through the `services` bag, so the
 * module can be imported and unit-tested with plain fakes.
 *
 * Wire rules, from docs/ARCHITECTURE.md:
 *
 * - success → `{ ok: true, value }`;
 * - failure → `{ ok: false, error: { code, message, details } }`;
 * - the handler never throws, and never rejects;
 * - unknown endpoint → `code: 'bad-request'`.
 *
 * Money is computed in USD throughout the host and converted exactly once, here,
 * into the requested display currency; every `costUsd`/`costDisplay` number in a
 * response is therefore already in `currency`.
 *
 * @module dsh-token-diet/lib/host/rpc
 */

import {
  aggregate,
  cacheHitRate,
  changeRatio,
  dateRange,
  localDateKey,
  tokensOf,
} from '../shared/billing.js'

/** The single channel this plugin owns. */
const CHANNEL = '/token-diet'

/** Display currencies the client understands. */
const CURRENCIES = new Set(['CNY', 'USD'])

/** Time ranges offered by the stats page toolbar. */
const RANGES = new Set([7, 30, 90])

/** Fallback exchange rate, matching the rate service's builtin snapshot. */
const BUILTIN_RATE = 7.2

/** Cost decimals and ratio decimals on the wire. */
const COST_DIGITS = 6
const RATIO_DIGITS = 4

/**
 * Create an Error carrying an RPC error code. The handler maps these onto the
 * failure envelope instead of turning them into `internal`.
 *
 * @param {'bad-request'|'unsupported'|'internal'} code
 * @param {string} message
 * @param {object} [details]
 * @returns {Error & { code: string, details: object }}
 */
function rpcError(code, message, details) {
  const error = new Error(message)
  error.code = code
  error.details = details !== null && typeof details === 'object' ? details : {}
  return error
}

/** A logger that cannot throw, so logging never breaks an endpoint. */
function safeLogger(logger) {
  const call = (level) => (...args) => {
    try {
      const fn = logger?.[level]
      if (typeof fn === 'function') fn(...args)
    } catch {
      /* never let logging fail an RPC call */
    }
  }
  return { debug: call('debug'), info: call('info'), warn: call('warn'), error: call('error') }
}

/** Finite number or `fallback`. */
function num(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Non-negative integer on the wire. */
function integer(value) {
  const n = num(value, 0)
  return n < 0 ? -Math.round(-n) : Math.round(n)
}

/** Round to fixed decimals without `toFixed`'s large-number surprises. */
function round(value, digits) {
  const n = num(value, 0)
  if (!Number.isFinite(n)) return 0
  const factor = 10 ** digits
  return Math.round(n * factor) / factor
}

/** A dollar amount on the wire. */
function money(value) {
  return round(value, COST_DIGITS)
}

/** A ratio on the wire. */
function ratio(value) {
  return round(value, RATIO_DIGITS)
}

/** A ratio that keeps "no previous period" explicit as `null`. */
function ratioOrNull(value) {
  return value === null || value === undefined || !Number.isFinite(value) ? null : ratio(value)
}

/** Coerce an unknown payload into a plain object. */
function payloadOf(payload) {
  return payload !== null && typeof payload === 'object' ? payload : {}
}

/** Read a required string field. */
function stringField(payload, key) {
  const value = payload[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw rpcError('bad-request', `missing or invalid "${key}"`, { field: key })
  }
  return value
}

/**
 * Read a numeric field that may be absent:
 * `undefined` → `undefined`, otherwise must be a finite number `>= min`.
 */
function optionalNumber(payload, key, min = 0) {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < min) {
    throw rpcError('bad-request', `"${key}" must be a number >= ${min}`, { field: key })
  }
  return n
}

/** Read a `number | null` field, preserving `null` (the "clear" signal). */
function nullableNumber(payload, key, min = 0) {
  const value = payload[key]
  if (value === null) return null
  if (value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < min) {
    throw rpcError('bad-request', `"${key}" must be a number >= ${min} or null`, { field: key })
  }
  return n
}

/** Read the currency field, falling back to the configured display currency. */
function currencyField(payload, key, fallback) {
  const value = payload[key]
  if (CURRENCIES.has(value)) return value
  return CURRENCIES.has(fallback) ? fallback : 'CNY'
}

/**
 * Call an optional member. A member that is absent (a composition without that
 * service) yields `undefined`; a member that exists and throws is allowed to
 * propagate, so the channel handler reports `'internal'` instead of silently
 * rendering an empty page.
 */
function softCall(target, method, ...args) {
  if (target === null || target === undefined) return undefined
  const fn = target[method]
  if (typeof fn !== 'function') return undefined
  return fn.apply(target, args)
}

/**
 * Call an optional async member. Absent → `undefined`; a rejected promise is
 * propagated to the handler's `'internal'` path for the same reason.
 */
async function softAwait(target, method, ...args) {
  const result = softCall(target, method, ...args)
  if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
    return await result
  }
  return result
}

/**
 * Install the `/token-diet` RPC channel.
 *
 * The returned disposer removes the channel registration; it is safe to call
 * more than once. When the `connection` service is absent (a composition without
 * the Web carrier) a warning is logged and a no-op disposer is returned, so the
 * host half stays inert instead of failing to load.
 *
 * @param {object} options
 * @param {object} options.ctx Cordis context of the plugin entry.
 * @param {{
 *   index?: object,
 *   pricing?: object,
 *   rates?: object,
 *   budgets?: object,
 *   guard?: object,
 *   config?: { displayCurrency?: 'CNY'|'USD' },
 * }} options.services Host services; every member is optional.
 * @returns {() => void} Disposer for the channel registration.
 */
export function installRpc({ ctx, services } = {}) {
  const log = safeLogger(ctx?.logger)
  const connection = resolveConnection(ctx)

  const endpoints = createEndpoints({ services: services ?? {}, log })

  /**
   * The channel handler: dispatch, wrap, never throw.
   *
   * @param {string} endpoint Path segment after `/token-diet/`.
   * @param {unknown} payload Client payload.
   * @param {AbortSignal} [signal] Request signal.
   * @param {object} [peer] Connection peer.
   */
  async function handler(endpoint, payload, signal, peer) {
    try {
      const run =
        typeof endpoint === 'string' && Object.prototype.hasOwnProperty.call(endpoints, endpoint)
          ? endpoints[endpoint]
          : undefined
      if (run === undefined) {
        throw rpcError('bad-request', `unknown endpoint ${JSON.stringify(endpoint)}`, {
          endpoint: typeof endpoint === 'string' ? endpoint : null,
        })
      }
      const value = await run(payloadOf(payload), { signal, peer })
      return { ok: true, value: value ?? {} }
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'internal'
      if (code === 'bad-request' || code === 'unsupported') {
        return {
          ok: false,
          error: {
            code,
            message: String(error?.message ?? 'bad request'),
            details: error?.details ?? {},
          },
        }
      }
      log.warn(`[token-diet] rpc ${String(endpoint)} failed`, error)
      return {
        ok: false,
        error: {
          code: 'internal',
          message: error instanceof Error ? error.message : String(error),
          details: {},
        },
      }
    }
  }

  let disposer = null

  if (connection !== null && typeof connection.rpc?.handle === 'function') {
    try {
      disposer = connection.rpc.handle(CHANNEL, handler)
    } catch (error) {
      log.warn('[token-diet] connection RPC registration failed; trying webServer', error)
    }
  } else {
    log.warn('[token-diet] connection service unavailable; falling back to a webServer route')
  }

  if (disposer === null) {
    disposer = installWebRoute(ctx, handler, log)
    if (disposer === null) {
      log.warn('[token-diet] no host carrier available; /token-diet RPC not registered')
      return () => {}
    }
  }

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    try {
      if (typeof disposer === 'function') disposer()
    } catch (error) {
      log.warn('[token-diet] /token-diet RPC dispose failed', error)
    }
  }
}

/** Resolve the Connection service without hard-failing on a missing one. */
function resolveConnection(ctx) {
  if (ctx === null || ctx === undefined) return null
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    if (viaGet !== null && viaGet !== undefined) return viaGet
  } catch {
    /* ctx.get may throw outside an active scope */
  }
  try {
    const viaProperty = ctx.connection
    if (viaProperty !== null && viaProperty !== undefined) return viaProperty
  } catch {
    /* service accessors may throw when the service is absent */
  }
  return null
}

/**
 * Fallback carrier: a `webServer` prefix route speaking the same wire envelope.
 *
 * The Connection channel is the preferred carrier because it authenticates the
 * browser and returns 401 on its own. This route is used only when no Connection
 * service exists in the composition. It therefore performs its own trust check:
 * loopback Host, same-origin `Origin` when present, and no cross-site fetch
 * metadata — the same defences `dsh-client-connection` documents.
 *
 * @param {object} ctx Cordis context.
 * @param {(endpoint: string, payload: unknown, signal?: AbortSignal, peer?: object) => Promise<object>} handler
 * @param {ReturnType<typeof safeLogger>} log
 * @returns {(() => void) | null} Disposer, or `null` when no web server exists.
 */
function installWebRoute(ctx, handler, log) {
  const webServer = softService(ctx, 'webServer')
  if (webServer === null || typeof webServer.register !== 'function') return null

  const route = {
    kind: 'prefix',
    path: CHANNEL,
    async handler(request, response) {
      try {
        if (request.method !== 'POST') {
          response.writeHead(405, { 'content-type': 'text/plain' })
          response.end('method not allowed')
          return
        }
        if (!isTrustedLocalRequest(request, webServer)) {
          response.writeHead(403, { 'content-type': 'text/plain' })
          response.end('forbidden')
          return
        }
        const contentType = String(request.headers?.['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
        if (contentType !== 'application/json') {
          response.writeHead(415, { 'content-type': 'text/plain' })
          response.end('content type must be application/json')
          return
        }
        const body = await readJsonBody(request)
        if (body === null || typeof body !== 'object' || body.type !== 'client-request' || typeof body.method !== 'string') {
          response.writeHead(400, { 'content-type': 'text/plain' })
          response.end('invalid envelope')
          return
        }
        const prefix = `${CHANNEL}/`
        const pathname = String(request.url ?? '').split('?', 1)[0]
        if (!pathname.startsWith(prefix)) {
          response.writeHead(404, { 'content-type': 'text/plain' })
          response.end('not found')
          return
        }
        let endpoint
        try {
          endpoint = decodeURIComponent(pathname.slice(prefix.length))
        } catch {
          response.writeHead(400, { 'content-type': 'text/plain' })
          response.end('bad endpoint')
          return
        }
        if (endpoint.length === 0 || endpoint.includes('/') || endpoint === '.' || endpoint === '..') {
          response.writeHead(404, { 'content-type': 'text/plain' })
          response.end('not found')
          return
        }
        const result = await handler(endpoint, body.payload, undefined, undefined)
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result }))
      } catch (error) {
        log.warn('[token-diet] web RPC route failed', error)
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'text/plain' })
        }
        response.end('internal error')
      }
    },
  }

  try {
    return webServer.register(route)
  } catch (error) {
    log.warn('[token-diet] webServer route registration failed', error)
    return null
  }
}

/** Resolve one optional service by name. */
function softService(ctx, name) {
  if (ctx === null || ctx === undefined) return null
  try {
    const found = typeof ctx.get === 'function' ? ctx.get(name) : undefined
    if (found !== null && found !== undefined) return found
  } catch {
    /* absent services throw on access in some compositions */
  }
  try {
    const viaProperty = ctx[name]
    if (viaProperty !== null && viaProperty !== undefined) return viaProperty
  } catch {
    /* ignore */
  }
  return null
}

/** Collect a JSON request body with a hard size cap. */
async function readJsonBody(request, limitBytes = 1_048_576) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += buffer.length
    if (total > limitBytes) return null
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

/**
 * DNS-rebinding and cross-site defences for the fallback route.
 *
 * Mirrors the documented `dsh-client-connection` policy: a loopback Host that is
 * either the bind literal or any loopback address, an `Origin` that names the
 * same authority, and no `sec-fetch-site: cross-site` marker.
 */
function isTrustedLocalRequest(request, webServer) {
  const headers = request.headers ?? {}
  const rawHost = String(headers.host ?? '')
  if (rawHost.length === 0) return false
  const hostname = stripPort(rawHost)
  if (!isLoopbackName(hostname)) {
    // A non-loopback bind may legitimately serve its own literal address.
    let bindHost
    try {
      bindHost = webServer.host
    } catch {
      bindHost = undefined
    }
    if (typeof bindHost !== 'string' || normalizeHost(bindHost) !== normalizeHost(hostname)) return false
  }
  const site = String(headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return false
  const origin = headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      const parsed = new URL(origin)
      if (normalizeHost(parsed.host) !== normalizeHost(rawHost)) return false
    } catch {
      return false
    }
  }
  return true
}

function stripPort(host) {
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end === -1 ? host : host.slice(0, end + 1)
  }
  const colon = host.indexOf(':')
  return colon === -1 ? host : host.slice(0, colon)
}

function normalizeHost(value) {
  return String(value).trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '')
}

function isLoopbackName(hostname) {
  const name = normalizeHost(hostname)
  if (name === 'localhost' || name === '::1') return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) return true
  return /^::ffff:127\./.test(name)
}

/**
 * Build the endpoint table, closing over the services bag.
 *
 * @param {{ services: object, log: ReturnType<typeof safeLogger> }} options
 * @returns {Record<string, (payload: object, context: object) => Promise<object>>}
 */
function createEndpoints({ services, log }) {
  const config = services.config !== null && typeof services.config === 'object' ? services.config : {}
  const displayCurrency = CURRENCIES.has(config.displayCurrency) ? config.displayCurrency : 'CNY'

  /** Current USD → CNY rate; the builtin fallback keeps every number valid. */
  function currentRate() {
    const snapshot = safeRateSnapshot()
    const value = num(snapshot?.cnyPerUsd, BUILTIN_RATE)
    return value > 0 ? value : BUILTIN_RATE
  }

  /** The last rate snapshot the rate service holds, or `null`. */
  function safeRateSnapshot() {
    const snapshot = softCall(services.rates, 'current')
    if (snapshot === null || typeof snapshot !== 'object') return null
    return snapshot
  }

  /** `{ cnyPerUsd, source, fetchedAt, error? }` for the price-section footer. */
  function rateInfo() {
    const snapshot = safeRateSnapshot()
    const info = {
      cnyPerUsd: round(currentRate(), RATIO_DIGITS),
      source: typeof snapshot?.source === 'string' ? snapshot.source : 'builtin',
      fetchedAt: typeof snapshot?.fetchedAt === 'string' ? snapshot.fetchedAt : null,
    }
    if (typeof snapshot?.error === 'string' && snapshot.error.length > 0) info.error = snapshot.error
    return info
  }

  /** Price resolver handed to `aggregate()`; never throws. */
  function priceOf(provider, model) {
    const resolved = softCall(services.pricing, 'resolve', provider, model)
    return resolved !== null && typeof resolved === 'object' ? resolved : null
  }

  /** Current pricing metadata for the price section. */
  function priceMeta() {
    const meta = softCall(services.pricing, 'meta')
    if (meta === null || typeof meta !== 'object') {
      return { source: 'none', fetchedAt: null, refreshing: false }
    }
    const out = {
      source: typeof meta.source === 'string' ? meta.source : 'none',
      fetchedAt: typeof meta.fetchedAt === 'string' ? meta.fetchedAt : null,
      refreshing: meta.refreshing === true,
    }
    if (typeof meta.error === 'string' && meta.error.length > 0) out.error = meta.error
    return out
  }

  /** Index scanning progress for the stats page. */
  function progress() {
    const value = softCall(services.index, 'progress')
    if (value === null || typeof value !== 'object') return { state: 'idle', done: 0, total: 0 }
    return {
      state: value.state === 'scanning' || value.state === 'ready' ? value.state : 'idle',
      done: integer(value.done),
      total: integer(value.total),
    }
  }

  /** Every indexed bucket row. */
  function allRows() {
    const rows = softCall(services.index, 'rows')
    return Array.isArray(rows) ? rows : []
  }

  /** Walk to the budget-owning root session. */
  function resolveRoot(sessionId) {
    const root = softCall(services.index, 'resolveRoot', sessionId)
    return typeof root === 'string' && root.length > 0 ? root : sessionId
  }

  /**
   * The guard's cached view of a session tree, when the guard exposes one.
   * Defensive on purpose: the budget field polls `sessionCost` every 1500 ms, and
   * a transient guard failure should degrade to a recomputed number rather than
   * blank the field with an `internal` error.
   */
  function guardState(sessionId) {
    try {
      const state = softCall(services.guard, 'stateOf', sessionId)
      return state !== null && typeof state === 'object' ? state : null
    } catch (error) {
      log.warn('[token-diet] guard.stateOf failed; recomputing', error)
      return null
    }
  }

  /** A budget record read straight from the store. */
  function budgetOf(root) {
    const budget = softCall(services.budgets, 'get', root)
    return budget !== null && typeof budget === 'object' ? budget : null
  }

  /** A reach marker read straight from the store. */
  function reachOf(root) {
    const marker = softCall(services.budgets, 'reach', root)
    return marker !== null && typeof marker === 'object' ? marker : null
  }

  /** Local date list of the current window, ascending. */
  function windowDates(range, endKey) {
    return dateRange(endKey ?? localDateKey(Date.now()), range)
  }

  /** The `range` days that ended the day before `firstKey`. */
  function previousDates(firstKey, range) {
    const [year, month, day] = String(firstKey).split('-').map(Number)
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
      return windowDates(range, firstKey)
    }
    const endOfPrevious = localDateKey(new Date(year, month - 1, day - 1).getTime())
    return windowDates(range, endOfPrevious)
  }

  /** Filter rows down to one set of local days. */
  function rowsIn(rows, dates) {
    const wanted = new Set(dates)
    return rows.filter((row) => wanted.has(row?.date))
  }

  /** Convert a USD amount into the requested display currency. */
  function toCurrency(usd, currency, rate) {
    return currency === 'CNY' ? usd * rate : usd
  }

  /**
   * The KPI block of one window. Both the raw numbers the Lead's client reads
   * (`costUsd` in the requested currency, `dailyCostUsd`) and the `*Display`
   * aliases of the contract are emitted; nothing here is pre-formatted text.
   */
  function kpisOf(totals, dates, currency, rate, missing, unpricedTokens) {
    const promptSide = num(totals.uncachedInput) + num(totals.cacheRead)
    const hit = promptSide > 0 ? num(totals.cacheRead) / promptSide : 0
    const cost = toCurrency(num(totals.costUsd), currency, rate)
    const days = Math.max(1, dates.length)
    return {
      totalTokens: integer(totals.tokens),
      costUsd: money(cost),
      costDisplay: money(cost),
      cacheHitRate: ratio(hit),
      dailyCostUsd: money(cost / days),
      dailyCostDisplay: money(cost / days),
      calls: integer(totals.calls),
      missingCount: Array.isArray(missing) ? missing.length : integer(missing),
      unpricedTokens: integer(unpricedTokens),
    }
  }

  /** `summary` — KPIs, trend, per-model, per-workspace and missing prices. */
  function summaryValue(payload) {
    const requestedRange = payload.range
    const range = RANGES.has(requestedRange) ? requestedRange : 30
    const currency = currencyField(payload, 'currency', displayCurrency)
    const rate = currentRate()
    const rows = allRows()

    const dates = windowDates(range)
    const prevDates = previousDates(dates[0], range)
    const currentRows = rowsIn(rows, dates)
    const previousRows = rowsIn(rows, prevDates)

    const current = aggregate(currentRows, priceOf, { dates })
    const previous = aggregate(previousRows, priceOf, { dates: prevDates })

    const missingTokens = current.missing.reduce((sum, entry) => sum + num(entry.tokens), 0)
    const kpis = kpisOf(current.totals, dates, currency, rate, current.missing, missingTokens)
    const prevKpis = kpisOf(
      previous.totals,
      prevDates,
      currency,
      rate,
      previous.missing,
      previous.missing.reduce((sum, entry) => sum + num(entry.tokens), 0),
    )

    // The client renders "对比上一周期". A ratio is `null` when the previous
    // window is empty (division by zero), which the client shows as "—".
    kpis.prev = {
      totalTokens: prevKpis.totalTokens,
      costUsd: prevKpis.costUsd,
      cacheHitRate: prevKpis.cacheHitRate,
      dailyCostUsd: prevKpis.dailyCostUsd,
      calls: prevKpis.calls,
    }
    kpis.tokensChange = ratioOrNull(changeRatio(kpis.totalTokens, prevKpis.totalTokens))
    kpis.costChange = ratioOrNull(changeRatio(kpis.costUsd, prevKpis.costUsd))
    kpis.cacheHitRateChange = ratio(kpis.cacheHitRate - prevKpis.cacheHitRate)

    const trend = current.byDay.map((day) => ({
      date: day.date,
      uncachedInput: integer(day.uncachedInput),
      cacheRead: integer(day.cacheRead),
      cacheWrite: integer(day.cacheWrite),
      output: integer(day.output),
      tokens: integer(tokensOf(day)),
      costUsd: money(toCurrency(num(day.costUsd), currency, rate)),
      calls: integer(day.calls),
    }))

    const byModel = current.byModel.map((model) => ({
      provider: model.provider,
      model: model.model,
      calls: integer(model.calls),
      input: integer(model.uncachedInput),
      uncachedInput: integer(model.uncachedInput),
      cacheRead: integer(model.cacheRead),
      cacheWrite: integer(model.cacheWrite),
      output: integer(model.output),
      tokens: integer(tokensOf(model)),
      cacheHitRate: ratio(
        cacheHitRate({
          uncachedInput: model.uncachedInput,
          cacheRead: model.cacheRead,
        }),
      ),
      costUsd: money(toCurrency(num(model.costUsd), currency, rate)),
      costDisplay: money(toCurrency(num(model.costUsd), currency, rate)),
      source: model.source ?? null,
      confidence: model.confidence ?? null,
      missing: model.missing === true,
    }))

    const byWorkspace = current.byWorkspace.map((entry) => {
      // `byModel` emits both the raw converted amount and its display alias; the
      // per-workspace rows mirror that so a client can read either field.
      const cost = money(toCurrency(num(entry.costUsd), currency, rate))
      return {
        workspace: entry.workspace,
        tokens: integer(entry.tokens),
        share: ratio(entry.share),
        costUsd: cost,
        costDisplay: cost,
      }
    })

    const missing = current.missing.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      tokens: integer(entry.tokens),
      suggestion: suggestionOf(entry.provider, entry.model),
    }))

    return {
      range,
      currency,
      rate: round(rate, RATIO_DIGITS),
      rateInfo: rateInfo(),
      kpis,
      trend,
      byModel,
      byWorkspace,
      missing,
      progress: progress(),
      pricesMeta: priceMeta(),
    }
  }

  /**
   * The best "did you mean" candidate for one unpriced model, or `null`.
   * `pricing.suggestions()` returns `{ provider, model, score }`; the contract
   * wants `{ provider, model, confidence }` as well, so both are provided.
   */
  function suggestionOf(provider, model) {
    const list = softCall(services.pricing, 'suggestions', provider, model, 1)
    if (!Array.isArray(list) || list.length === 0) return null
    const first = list[0]
    if (first === null || typeof first !== 'object') return null
    return {
      provider: typeof first.provider === 'string' ? first.provider : provider,
      model: typeof first.model === 'string' ? first.model : model,
      confidence: typeof first.confidence === 'string' ? first.confidence : 'fuzzy',
      score: num(first.score, 0),
    }
  }

  /** `prices` — every model the index knows, priced or not. */
  function pricesValue() {
    const rate = currentRate()
    const folded = aggregate(allRows(), priceOf)

    const rows = folded.byModel.map((model) => {
      const resolved = priceOf(model.provider, model.model)
      const suggestions = softCall(services.pricing, 'suggestions', model.provider, model.model, 3)
      return {
        provider: model.provider,
        model: model.model,
        calls: integer(model.calls),
        tokens: integer(tokensOf(model)),
        input: integer(model.uncachedInput),
        cacheRead: integer(model.cacheRead),
        cacheWrite: integer(model.cacheWrite),
        output: integer(model.output),
        price:
          resolved !== null && resolved.price !== null && typeof resolved.price === 'object'
            ? {
                input: num(resolved.price.input),
                output: num(resolved.price.output),
                cacheRead: num(resolved.price.cacheRead, num(resolved.price.input)),
                cacheWrite: num(resolved.price.cacheWrite, num(resolved.price.input)),
              }
            : null,
        source: resolved?.source ?? null,
        confidence: resolved?.confidence ?? null,
        matchedProvider: resolved?.matchedProvider ?? null,
        matchedModel: resolved?.matchedModel ?? null,
        suggestions: Array.isArray(suggestions) ? suggestions : [],
      }
    })

    return { rows, meta: priceMeta(), rate: round(rate, RATIO_DIGITS), rateInfo: rateInfo() }
  }

  /** `sessionCost` — the budget field's "已用 / 上限" numbers. */
  function sessionCostValue(payload) {
    const sessionId = stringField(payload, 'sessionId')
    const rate = currentRate()
    const state = guardState(sessionId)
    const root = typeof state?.root === 'string' && state.root.length > 0 ? state.root : resolveRoot(sessionId)
    const budget = state?.budget !== undefined ? state.budget : budgetOf(root)
    const budgetCurrency = CURRENCIES.has(budget?.currency) ? budget.currency : null
    const currency = budgetCurrency ?? displayCurrency

    const spentUsd =
      state !== null && Number.isFinite(state.spentUsd) ? num(state.spentUsd) : treeSpendUsd(root)
    const spent =
      state !== null && Number.isFinite(state.spent)
        ? num(state.spent)
        : toCurrency(spentUsd, currency, rate)

    const limit = budget !== null && budget !== undefined ? num(budget.limit, 0) : null
    const marker = reachOf(root)
    // A live comparison wins; a persisted marker keeps the "reached" record
    // visible even when the budget itself was removed out of band.
    const reached =
      limit === null ? marker !== null : spent >= limit || (marker !== null && spent >= num(marker.limit, 0))

    const unpriced =
      state !== null && Number.isFinite(state.unpriced)
        ? integer(state.unpriced)
        : treeUnpricedCount(root)

    return {
      sessionId,
      root,
      spent: money(spent),
      spentUsd: money(spentUsd),
      limit: limit === null ? null : money(limit),
      currency,
      budgetCurrency,
      reached: reached === true,
      unpriced,
      rate: round(rate, RATIO_DIGITS),
      rateInfo: rateInfo(),
    }
  }

  /**
   * Fallback USD cost of one session tree, used only when the guard does not
   * expose `spentUsdOf`/`stateOf`.
   */
  function treeSpendUsd(root) {
    const viaGuard = softCall(services.guard, 'spentUsdOf', root)
    if (typeof viaGuard === 'number' && Number.isFinite(viaGuard)) return viaGuard

    const headers = softCall(services.index, 'headers')
    if (headers === null || typeof headers.forEach !== 'function') return 0
    let total = 0
    for (const [id] of headers) {
      if (resolveRoot(id) !== root) continue
      const usage = softCall(services.index, 'sessionUsage', id)
      const cells = Array.isArray(usage?.buckets) ? usage.buckets : []
      for (const cell of cells) {
        const resolved = priceOf(cell?.provider, cell?.model)
        if (resolved === null) continue
        total +=
          ((num(cell.uncachedInput) * num(resolved.price?.input) +
            num(cell.cacheRead) * num(resolved.price?.cacheRead, num(resolved.price?.input)) +
            num(cell.cacheWrite) * num(resolved.price?.cacheWrite, num(resolved.price?.input)) +
            num(cell.output) * num(resolved.price?.output)) /
            1_000_000)
      }
    }
    return total
  }

  /** Fallback count of unpriced models in one session tree. */
  function treeUnpricedCount(root) {
    const viaGuard = softCall(services.guard, 'unpricedCount', root)
    if (typeof viaGuard === 'number' && Number.isFinite(viaGuard)) return integer(viaGuard)

    const headers = softCall(services.index, 'headers')
    if (headers === null || typeof headers.forEach !== 'function') return 0
    const seen = new Set()
    for (const [id] of headers) {
      if (resolveRoot(id) !== root) continue
      const usage = softCall(services.index, 'sessionUsage', id)
      const cells = Array.isArray(usage?.buckets) ? usage.buckets : []
      for (const cell of cells) {
        if (priceOf(cell?.provider, cell?.model) === null) {
          seen.add(`${cell?.provider ?? ''}\u0000${cell?.model ?? ''}`)
        }
      }
    }
    return seen.size
  }

  const endpoints = {
    summary: (payload) => summaryValue(payload),

    prices: () => pricesValue(),

    async refreshPrices() {
      await softAwait(services.pricing, 'refresh', true)
      return pricesValue()
    },

    async setCustomPrice(payload) {
      const provider = stringField(payload, 'provider')
      const model = stringField(payload, 'model')
      const input = optionalNumber(payload, 'input', 0)
      const output = optionalNumber(payload, 'output', 0)
      if (input === undefined || output === undefined) {
        throw rpcError('bad-request', '"input" and "output" are required', { fields: ['input', 'output'] })
      }
      const price = { input, output }
      const cacheRead = optionalNumber(payload, 'cacheRead', 0)
      const cacheWrite = optionalNumber(payload, 'cacheWrite', 0)
      if (cacheRead !== undefined) price.cacheRead = cacheRead
      if (cacheWrite !== undefined) price.cacheWrite = cacheWrite
      await softAwait(services.pricing, 'setCustom', provider, model, price)
      return pricesValue()
    },

    async removeCustomPrice(payload) {
      const provider = stringField(payload, 'provider')
      const model = stringField(payload, 'model')
      await softAwait(services.pricing, 'setCustom', provider, model, null)
      return pricesValue()
    },

    rate() {
      return { rate: round(currentRate(), RATIO_DIGITS), rateInfo: rateInfo() }
    },

    async refreshRate() {
      await softAwait(services.rates, 'refresh', true)
      return { rate: round(currentRate(), RATIO_DIGITS), rateInfo: rateInfo() }
    },

    async setRateOverride(payload) {
      const value = nullableNumber(payload, 'cnyPerUsd', 0)
      if (value !== null && value <= 0) {
        throw rpcError('bad-request', '"cnyPerUsd" must be a positive number or null', {
          field: 'cnyPerUsd',
        })
      }
      await softAwait(services.rates, 'setOverride', value)
      return { rate: round(currentRate(), RATIO_DIGITS), rateInfo: rateInfo() }
    },

    sessionCost(payload) {
      return sessionCostValue(payload)
    },

    async setBudget(payload) {
      const sessionId = stringField(payload, 'sessionId')
      const limit = nullableNumber(payload, 'limit', 0)
      const currency = currencyField(payload, 'currency', displayCurrency)
      const root = resolveRoot(sessionId)
      await softAwait(services.budgets, 'set', root, limit, currency)
      await softAwait(services.budgets, 'clearReached', root)
      return sessionCostValue({ sessionId })
    },

    async raiseBudgetAndContinue(payload) {
      const sessionId = stringField(payload, 'sessionId')
      const limit =
        payload.limit === undefined || payload.limit === null
          ? null
          : optionalNumber(payload, 'limit', 0)
      if (limit === null) {
        throw rpcError('bad-request', '"limit" is required', { field: 'limit' })
      }
      const currency = currencyField(payload, 'currency', displayCurrency)
      const root = resolveRoot(sessionId)
      let stored = false
      try {
        // `budgets.set` settles the pending hold with 'raised' on its own, so the
        // paused step proceeds even if the guard call below misbehaves.
        await softAwait(services.budgets, 'set', root, limit, currency)
        await softAwait(services.budgets, 'clearReached', root)
        stored = typeof services.budgets?.set === 'function'
      } catch (error) {
        log.warn('[token-diet] raiseBudgetAndContinue could not store the budget', error)
        stored = false
      }

      let continued = stored
      try {
        // The guard's answer is the strongest evidence that the held step was
        // released; `undefined` means the guard has no such member.
        const result = await softAwait(services.guard, 'raiseAndContinue', sessionId, limit, currency)
        if (result === true) continued = true
        else if (result === false) continued = false
      } catch (error) {
        log.warn('[token-diet] raiseBudgetAndContinue guard call failed', error)
      }
      // Never leave a paused step parked until the hold timeout: settling twice is
      // harmless, and settling is the only way out if the guard declined or threw.
      if (!continued) softCall(services.budgets, 'settle', root, 'raised')

      return { ...sessionCostValue({ sessionId }), continued: continued === true }
    },

    async dismissBudget(payload) {
      const sessionId = stringField(payload, 'sessionId')
      const root = resolveRoot(sessionId)
      // Closing a popover is the user's way out of a blocked turn: a guard
      // failure here must never leave the client unable to dismiss it.
      try {
        const result = await softAwait(services.guard, 'dismiss', sessionId)
        if (result === undefined) softCall(services.budgets, 'settle', root, 'dismissed')
      } catch (error) {
        log.warn('[token-diet] dismissBudget guard call failed', error)
        softCall(services.budgets, 'settle', root, 'dismissed')
      }
      return { ok: true }
    },

    indexStatus() {
      return { progress: progress() }
    },
  }

  return endpoints
}
