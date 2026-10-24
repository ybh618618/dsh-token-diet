/**
 * Host half of the `dsh-token-diet` bundle.
 *
 * Responsibilities, in wiring order:
 *
 * 1. resolve the Harness home and construct the four durable services
 *    (usage index, pricing, exchange rate, budgets);
 * 2. install the `/token-diet` RPC channel the Web client talks to;
 * 3. install the budget guard on `agent/pre-step`, which refuses the next model
 *    request once a session (including its sub-agents) reaches its budget;
 * 4. keep the index live from `session/event` and pick up forked sessions.
 *
 * Everything DSH-specific is confined to this file and `lib/host/rpc.js`: the
 * other host modules are plain factories over `node:*`. No `@deepseek-ai/*`
 * import is used anywhere, so a DSH API change only affects this adapter.
 *
 * @module dsh-token-diet
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { createUsageIndex } from './host/index-store.js'
import { createPricingService } from './host/pricing.js'
import { createRateService } from './host/rates.js'
import { createBudgetService } from './host/budget.js'
import { installRpc } from './host/rpc.js'

/** Loader entry id; also the settings namespace of this plugin. */
export const name = 'token-diet'

/**
 * Inert defaults. Every field is optional so the composed row in
 * `cordis.patch.yml` can stay empty.
 */
export const Config = undefined

/** Services this plugin starts with when the composition provides them. */
export const inject = []

const DEFAULT_HOLD_MS = 300_000
const DEFAULT_PRICE_TTL_MS = 86_400_000
const DEFAULT_RATE_TTL_MS = 43_200_000
const DEFAULT_SCAN_BATCH = 8

/**
 * Resolve the Harness home the way every other DSH component does: the
 * `DSH_HOME` environment variable, else `~/.dsh`.
 */
function resolveHome(config) {
  const fromConfig = typeof config?.home === 'string' && config.home.length > 0 ? config.home : undefined
  if (fromConfig !== undefined) return fromConfig
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

/** A minimal console-backed logger; DSH's `ctx.logger` is used when present. */
function makeLogger(ctx) {
  const logger = ctx?.logger
  return {
    debug: (...args) => logger?.debug?.(...args),
    info: (...args) => logger?.info?.(...args),
    warn: (...args) => (logger?.warn ?? console.warn)(...args),
    error: (...args) => (logger?.error ?? console.error)(...args),
  }
}

/**
 * Install the bundle.
 *
 * @param ctx Cordis context of this plugin entry.
 * @param config Optional row configuration (see `normalizeConfig`).
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  const logger = makeLogger(ctx)
  const home = resolveHome(settings)
  const fetchImpl = (input, init) => globalThis.fetch(input, init)

  const rates = createRateService({
    home,
    logger,
    fetchImpl,
    config: { refreshMs: settings.rateTtlMs, overridden: settings.rateOverride },
  })
  const pricing = createPricingService({
    home,
    logger,
    fetchImpl,
    config: {
      refreshMs: settings.priceTtlMs,
      // When a provider is unknown, fall back to matching by model name and always
      // report that the match is inexact.
      fuzzy: true,
      providerAliases: settings.providerAliases,
      // Model-name aliases canonicalise spellings of one model (for example every
      // `deepseek-v4.1-flash` / `deepseek-flash` route to the official
      // `deepseek/deepseek-flash` price) and outrank the generic matching.
      modelAliases: settings.modelAliases,
    },
  })
  const budgets = createBudgetService({ home, logger })
  const index = createUsageIndex({
    home,
    logger,
    sessionPersistence: ctx.get('sessionPersistence'),
    agents: ctx.get('agents'),
    getRate: () => rates.current().cnyPerUsd,
    config: { batchSize: settings.scanBatch },
  })

  /** Cost + budget state used by the RPC table and the guard. */
  const guard = createGuard({ ctx, index, pricing, rates, budgets, settings, logger })

  ctx.effect(() => {
    let disposed = false
    void (async () => {
      await Promise.allSettled([rates.init(), pricing.init(), budgets.init()])
      if (disposed) return
      await index.init().catch((error) => logger.warn('[token-diet] index init failed', error))
    })()
    return () => {
      disposed = true
    }
  }, 'token-diet: services')

  // The RPC carrier. `installRpc` prefers the Host Connection channel (it
  // authenticates the browser for us) and falls back to a `webServer` prefix
  // route, so the client always has exactly one working transport.
  const rpcServices = {
    get index() {
      return index
    },
    get pricing() {
      return pricing
    },
    get rates() {
      return rates
    },
    get budgets() {
      return budgets
    },
    get guard() {
      return guard
    },
    config: { displayCurrency: settings.displayCurrency },
  }
  let disposeChannel = null
  const install = () => {
    if (disposeChannel !== null) return
    disposeChannel = installRpc({ ctx, services: rpcServices })
  }
  install()
  // Connection may activate after this entry; re-install on arrival, replacing
  // the fallback route with the authenticated channel.
  ctx.inject(['connection'], () => {
    if (disposeChannel !== null) disposeChannel()
    disposeChannel = null
    install()
  })
  ctx.effect(
    () => () => {
      if (disposeChannel !== null) disposeChannel()
      disposeChannel = null
    },
    'token-diet: RPC carrier',
  )

  // Live fold: every committed session event updates the index increments and the
  // guard's running cost, so the budget field tracks a running turn.
  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        try {
          index.onEvent(session, event)
          guard.onEvent(session, event)
        } catch (error) {
          logger.warn('[token-diet] live fold failed', error)
        }
      }),
    'token-diet: session/event fold',
  )

  // Fork inheritance: a seeded child session starts with its parent's budget.
  ctx.effect(
    () =>
      ctx.on('session/created', (session) => {
        const parent = session?.header?.parentSession
        if (parent === undefined || parent === null) return
        void budgets.inherit(parent, session.header.id).catch((error) => {
          logger.warn('[token-diet] budget inheritance failed', error)
        })
      }),
    'token-diet: fork budget inheritance',
  )

  // Budget guard: refuse the next model request of an over-budget session and hold
  // the step until the client raises the limit, dismisses the notice or the turn is
  // cancelled.
  ctx.effect(
    () =>
      ctx.on('agent/pre-step', async (payload, next) => {
        try {
          const root = index.resolveRoot(payload.agent.id)
          const verdict = await guard.beforeStep({
            root,
            signal: payload.signal,
          })
          if (verdict === 'proceed') return next()
          return { kind: 'reject' }
        } catch (error) {
          logger.warn('[token-diet] budget guard failed, allowing the step', error)
          return next()
        }
      }),
    'token-diet: budget guard',
  )

  logger.info?.(`[token-diet] ready (home=${home})`)
}

/** Normalize the row configuration, keeping every tunable overridable in yaml. */
function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  return {
    home: typeof raw.home === 'string' ? raw.home : undefined,
    displayCurrency: raw.displayCurrency === 'USD' ? 'USD' : 'CNY',
    rateOverride: typeof raw.rateOverride === 'number' && raw.rateOverride > 0 ? raw.rateOverride : null,
    priceTtlMs: positive(raw.priceRefreshHours, 24) * 3_600_000 || DEFAULT_PRICE_TTL_MS,
    rateTtlMs: positive(raw.rateRefreshHours, 12) * 3_600_000 || DEFAULT_RATE_TTL_MS,
    budgetHoldMs: positive(raw.budgetHoldSeconds, DEFAULT_HOLD_MS / 1000) * 1000 || DEFAULT_HOLD_MS,
    scanBatch: positive(raw.scanBatch, DEFAULT_SCAN_BATCH),
    providerAliases:
      raw.providerAliases !== null && typeof raw.providerAliases === 'object' ? raw.providerAliases : undefined,
    modelAliases:
      raw.modelAliases !== null && typeof raw.modelAliases === 'object' ? raw.modelAliases : undefined,
  }
}

function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * The budget guard's behaviour, split out of {@link apply} so the RPC table and
 * the `agent/pre-step` listener share one implementation.
 *
 * Cost is always computed in USD and converted with the *current* rate when a
 * budget is denominated in CNY, which matches the plan's "汇率更新后历史成本的
 * 人民币金额会随之微调" rule.
 */
function createGuard({ index, pricing, rates, budgets, settings, logger }) {
  /** Per-session override of the reach marker published to the client. */
  const holds = new Map()

  /** USD cost of one session plus every descendant, priced at today's prices. */
  function spentUsdOf(sessionId) {
    const root = index.resolveRoot(sessionId)
    const headers = index.headers()
    let spent = 0
    for (const [id] of headers) {
      const sessionRoot = index.resolveRoot(id)
      if (sessionRoot !== root) continue
      const usage = index.sessionUsage(id)
      if (usage === undefined) continue
      for (const cell of usage.buckets) {
        const resolved = pricing.resolve(cell.provider, cell.model)
        if (resolved === null) continue
        spent +=
          ((cell.uncachedInput ?? 0) * resolved.price.input +
            (cell.cacheRead ?? 0) * resolved.price.cacheRead +
            (cell.cacheWrite ?? 0) * resolved.price.cacheWrite +
            (cell.output ?? 0) * resolved.price.output) /
          1_000_000
      }
    }
    return spent
  }

  /** Count the models of one session tree that carry no price. */
  function unpricedCount(sessionId) {
    const root = index.resolveRoot(sessionId)
    const seen = new Set()
    for (const [id] of index.headers()) {
      if (index.resolveRoot(id) !== root) continue
      const usage = index.sessionUsage(id)
      if (usage === undefined) continue
      for (const cell of usage.buckets) {
        if (pricing.resolve(cell.provider, cell.model) === null) {
          seen.add(`${cell.provider}\u0000${cell.model}`)
        }
      }
    }
    return seen.size
  }

  /** Compare the session tree's cost against its budget in the budget's currency. */
  function stateOf(sessionId) {
    const root = index.resolveRoot(sessionId)
    const budget = budgets.get(root)
    const spentUsd = spentUsdOf(root)
    const rate = rates.current().cnyPerUsd
    const currency = budget?.currency ?? settings.displayCurrency
    const spent = currency === 'CNY' ? spentUsd * rate : spentUsd
    const reached = budget !== null && budget !== undefined ? spent >= budget.limit : false
    return {
      root,
      budget,
      spentUsd,
      spent,
      currency,
      rate,
      reached,
      unpriced: unpricedCount(root),
      limit: budget?.limit ?? null,
    }
  }

  return {
    spentUsdOf,
    unpricedCount,
    stateOf,

    /** Kept for rpc.js interface parity. */
    spentOf(sessionId) {
      return stateOf(sessionId).spent
    },

    /** Kept for rpc.js interface parity. */
    currencyOf(sessionId) {
      return stateOf(sessionId).currency
    },

    /**
     * Called before every model step. Returns `'proceed'` when the step may run,
     * `'reject'` when the turn must stop.
     */
    async beforeStep({ root, signal }) {
      const state = stateOf(root)
      if (state.budget === null || !state.reached) return 'proceed'
      const reach = {
        spent: state.spent,
        limit: state.budget.limit,
        currency: state.currency,
        at: new Date().toISOString(),
      }
      // Publishing the marker is what makes the client popover appear; it polls
      // `sessionCost`, so no push channel is needed.
      await budgets.markReached(root, reach)
      const outcome = await budgets.waitForDecision(root, signal, settings.budgetHoldMs)
      if (outcome === 'raised') return 'proceed'
      return 'reject'
    },

    async raiseAndContinue(sessionId, limit, currency) {
      const root = index.resolveRoot(sessionId)
      await budgets.set(root, limit, currency)
      await budgets.clearReached(root)
      budgets.settle(root, 'raised')
      return true
    },

    async dismiss(sessionId) {
      const root = index.resolveRoot(sessionId)
      budgets.settle(root, 'dismissed')
      return true
    },

    /**
     * On every committed assistant settlement, drop a stale reach marker whose
     * limit the user has since raised (defensive: the raise path clears it too).
     */
    onEvent(session, event) {
      if (event?.type !== 'assistant/message') return
      const id = session?.id
      if (typeof id !== 'string') return
      const root = index.resolveRoot(id)
      const reach = budgets.reach(root)
      if (reach === null || reach === undefined) return
      const budget = budgets.get(root)
      if (budget !== null && budget !== undefined && budget.limit > reach.limit) {
        void budgets.clearReached(root).catch((error) => logger.warn('[token-diet] clear reach failed', error))
      }
    },

    /** Exposed for tests. */
    _holds: holds,
  }
}
