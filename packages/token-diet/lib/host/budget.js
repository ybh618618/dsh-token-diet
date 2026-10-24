/**
 * Durable per-session budgets and the guard's hold handshake.
 *
 * The plan originally wanted budgets in the session log, but DSH refuses a
 * persisted event whose type is not part of the closed `KNOWN_SESSION_EVENT_TYPES`
 * set (see docs/ARCHITECTURE.md, "Hard constraints"). Budgets therefore live in
 * their own JSON document under `<home>/token-diet/budgets.v1.json`, which is
 * safe to delete: losing it only forgets the user's limits.
 *
 * This module is pure `node:*`. The atomic file writer is implemented here on
 * purpose because `lib/host/store.js` belongs to the usage-index owner and this
 * file must stay independently replaceable.
 *
 * @module dsh-token-diet/lib/host/budget
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** On-disk schema version. A mismatch discards the file (it is only a cache). */
const SCHEMA_VERSION = 1

/** Directory and file name inside the Harness home. */
const DIR_NAME = 'token-diet'
const FILE_NAME = 'budgets.v1.json'

/** Outcomes a held step can settle with. */
const OUTCOMES = new Set(['raised', 'dismissed', 'aborted', 'timeout'])

/** An empty but valid document. */
function emptyState() {
  return { version: SCHEMA_VERSION, budgets: {}, reached: {} }
}

/** A logger that never throws, even when the caller passes nothing useful. */
function safeLogger(logger) {
  const call = (level) => (...args) => {
    try {
      const fn = logger?.[level]
      if (typeof fn === 'function') fn(...args)
    } catch {
      /* logging must never break the budget service */
    }
  }
  return { debug: call('debug'), info: call('info'), warn: call('warn'), error: call('error') }
}

/** Coerce to a finite number, else `null`. */
function finiteOrNull(value) {
  if (value === null || value === undefined) return null
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

/** Only `CNY` and `USD` are accepted; anything else falls back. */
function currencyOf(value, fallback = 'CNY') {
  return value === 'USD' ? 'USD' : value === 'CNY' ? 'CNY' : fallback
}

/** ISO timestamp for "now". */
function nowIso() {
  return new Date().toISOString()
}

/**
 * One atomic JSON document: `read()` never throws, `write()` serializes all
 * writers through a promise chain and replaces the file with a rename so a crash
 * mid-write can never leave a truncated `budgets.v1.json`.
 *
 * @param {string|null} file Absolute path, or `null` for memory-only operation.
 * @param {{warn: Function}} log Safe logger.
 * @returns {{ read: () => Promise<unknown>, write: (value: unknown) => Promise<void> }}
 */
function createAtomicDocument(file, log) {
  let counter = 0
  let queue = Promise.resolve()

  async function read() {
    if (file === null) return null
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        log.warn('[token-diet] budgets read failed, starting empty', error)
      }
      return null
    }
  }

  function write(value) {
    if (file === null) return Promise.resolve()
    queue = queue.then(async () => {
      await mkdir(dirname(file), { recursive: true })
      counter += 1
      const tmp = `${file}.${process.pid}.${counter}.tmp`
      try {
        await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
        await rename(tmp, file)
      } catch (error) {
        await unlink(tmp).catch(() => {})
        throw error
      }
    })
    // Swallow failures so a read-only home can never reject a budget mutation.
    queue = queue.catch((error) => {
      log.warn('[token-diet] budgets write failed', error)
    })
    return queue
  }

  return { read, write }
}

/** Normalize one persisted budget record; `null` when the record is unusable. */
function normalizeBudget(record) {
  const limit = finiteOrNull(record?.limit)
  if (limit === null || limit < 0) return null
  return {
    limit,
    currency: currencyOf(record?.currency),
    setAt: typeof record?.setAt === 'string' ? record.setAt : nowIso(),
  }
}

/** Normalize one persisted reach marker; `null` when the record is unusable. */
function normalizeReach(record) {
  const spent = finiteOrNull(record?.spent)
  const limit = finiteOrNull(record?.limit)
  if (spent === null || limit === null || spent < 0 || limit < 0) return null
  return {
    spent,
    limit,
    currency: currencyOf(record?.currency),
    at: typeof record?.at === 'string' ? record.at : nowIso(),
  }
}

/** Load a document into the canonical shape, dropping anything malformed. */
function normalizeState(raw) {
  const state = emptyState()
  if (raw === null || typeof raw !== 'object') return state
  if (raw.version !== SCHEMA_VERSION) return state
  if (raw.budgets !== null && typeof raw.budgets === 'object') {
    for (const [sessionId, record] of Object.entries(raw.budgets)) {
      const budget = normalizeBudget(record)
      if (budget !== null) state.budgets[sessionId] = budget
    }
  }
  if (raw.reached !== null && typeof raw.reached === 'object') {
    for (const [sessionId, record] of Object.entries(raw.reached)) {
      const reach = normalizeReach(record)
      if (reach !== null) state.reached[sessionId] = reach
    }
  }
  return state
}

/**
 * Create the budget service.
 *
 * Every member either never throws (`get`, `reach`, `settle`, `pending`) or
 * resolves even when the disk is unavailable (the async ones), because the guard
 * and the RPC table call them on hot paths where an exception would either stall a
 * turn or fail a client poll.
 *
 * @param {object} [options]
 * @param {string} [options.home] DSH home directory; omit for memory-only mode.
 * @param {object} [options.logger] `ctx.logger`-shaped logger.
 * @returns {{
 *   init(): Promise<void>,
 *   get(sessionId: string): { limit: number, currency: 'CNY'|'USD', setAt: string } | null,
 *   set(sessionId: string, limit: number|null, currency?: 'CNY'|'USD'): Promise<void>,
 *   reach(sessionId: string): { spent: number, limit: number, currency: 'CNY'|'USD', at: string } | null,
 *   markReached(sessionId: string, reach: object): Promise<void>,
 *   clearReached(sessionId: string): Promise<void>,
 *   inherit(parentId: string, childId: string): Promise<void>,
 *   raiseBudget(sessionId: string, limit: number, currency?: 'CNY'|'USD'): Promise<void>,
 *   settle(sessionId: string, outcome: 'raised'|'dismissed'|'aborted'|'timeout'): boolean,
 *   pending(sessionId: string): Promise<'raised'|'dismissed'|'aborted'|'timeout'>|null,
 *   waitForDecision(sessionId: string, signal?: object, timeoutMs?: number):
 *     Promise<'raised'|'dismissed'|'aborted'|'timeout'>,
 * }}
 */
export function createBudgetService({ home, logger } = {}) {
  const log = safeLogger(logger)
  const file = typeof home === 'string' && home.length > 0 ? join(home, DIR_NAME, FILE_NAME) : null
  const document = createAtomicDocument(file, log)

  let state = emptyState()

  /**
   * Pending holds: session id → `{ promise, resolve, settled, timer, cleanup }`.
   * `resolve` is idempotent through the `settled` flag, and the entry leaves the
   * map before it resolves, so a repeated settle is harmless.
   */
  const holds = new Map()

  /** Settle one pending hold if there is one; returns whether it fired. */
  function settle(sessionId, outcome) {
    const id = typeof sessionId === 'string' ? sessionId : ''
    const entry = holds.get(id)
    if (entry === undefined) return false
    entry.resolve(outcome)
    return true
  }

  /** Persist the current state; never rejects. */
  function persist() {
    return document.write(state)
  }

  /** Read the document into memory. Safe to await more than once. */
  async function load() {
    try {
      state = normalizeState(await document.read())
    } catch (error) {
      log.warn('[token-diet] budgets load failed, starting empty', error)
      state = emptyState()
    }
    log.debug?.(`[token-diet] budgets loaded (${Object.keys(state.budgets).length} budgets)`)
  }

  // Loading starts immediately so `get()`/`reach()` are useful before `init()`
  // resolves, and every mutation awaits the same load, so a caller that forgets
  // `init()` cannot overwrite the file with an empty document.
  let ready = load()

  /** Ensure the document has been read before a mutation reads or writes it. */
  async function ensureReady() {
    await ready.catch(() => {})
    ready = Promise.resolve()
  }

  const service = {
    /** Load `budgets.v1.json`. Resolves after the first load completes. */
    async init() {
      await ready.catch(() => {})
    },

    /**
     * The budget currently attached to one session.
     *
     * @param {string} sessionId
     * @returns {{ limit: number, currency: 'CNY'|'USD', setAt: string } | null}
     */
    get(sessionId) {
      const budget = state.budgets[typeof sessionId === 'string' ? sessionId : '']
      return budget === undefined ? null : { ...budget }
    },

    /**
     * Set or clear one session's budget.
     *
     * `limit === null` (or any unusable number) removes both the budget and its
     * reach marker — "留空表示不限". A successful set also releases a held step
     * with `'raised'`, because a new limit is the answer the guard waits for.
     *
     * @param {string} sessionId
     * @param {number|null} limit
     * @param {'CNY'|'USD'} [currency]
     * @returns {Promise<void>}
     */
    async set(sessionId, limit, currency) {
      await ensureReady()
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      const numeric = finiteOrNull(limit)
      if (numeric === null || numeric < 0) {
        delete state.budgets[sessionId]
        delete state.reached[sessionId]
        await persist()
        settle(sessionId, 'raised')
        return
      }
      state.budgets[sessionId] = { limit: numeric, currency: currencyOf(currency), setAt: nowIso() }
      await persist()
      settle(sessionId, 'raised')
    },

    /**
     * The reach marker published to the client, or `null`.
     *
     * @param {string} sessionId
     * @returns {{ spent: number, limit: number, currency: 'CNY'|'USD', at: string } | null}
     */
    reach(sessionId) {
      const reach = state.reached[typeof sessionId === 'string' ? sessionId : '']
      return reach === undefined ? null : { ...reach }
    },

    /**
     * Record that a session tree has reached its budget. The client polls
     * `sessionCost`, so persisting this marker is what makes the popover appear.
     *
     * @param {string} sessionId Root session id.
     * @param {{ spent: number, limit: number, currency?: 'CNY'|'USD', at?: string }} reach
     * @returns {Promise<void>}
     */
    async markReached(sessionId, reach) {
      await ensureReady()
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      const normalized = normalizeReach(reach)
      if (normalized === null) return
      state.reached[sessionId] = normalized
      await persist()
    },

    /**
     * Clear the reach marker of one session. A no-op when there is none.
     *
     * @param {string} sessionId
     * @returns {Promise<void>}
     */
    async clearReached(sessionId) {
      await ensureReady()
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      if (state.reached[sessionId] === undefined) return
      delete state.reached[sessionId]
      await persist()
    },

    /**
     * Fork inheritance: a seeded child session starts with the parent's budget.
     * The child's own budget always wins and the parent's reach marker is not
     * copied.
     *
     * @param {string} parentId
     * @param {string} childId
     * @returns {Promise<void>}
     */
    async inherit(parentId, childId) {
      await ensureReady()
      if (typeof parentId !== 'string' || typeof childId !== 'string') return
      if (parentId.length === 0 || childId.length === 0 || parentId === childId) return
      const parent = state.budgets[parentId]
      if (parent === undefined || state.budgets[childId] !== undefined) return
      state.budgets[childId] = { limit: parent.limit, currency: parent.currency, setAt: nowIso() }
      await persist()
    },

    /**
     * Convenience wrapper for the guard: set the limit, drop the reach marker and
     * release the hold with `'raised'`.
     *
     * @param {string} sessionId
     * @param {number} limit
     * @param {'CNY'|'USD'} [currency]
     * @returns {Promise<void>}
     */
    async raiseBudget(sessionId, limit, currency) {
      await service.set(sessionId, limit, currency)
      await service.clearReached(sessionId)
      settle(sessionId, 'raised')
    },

    /**
     * Settle one pending hold. Synchronous and harmless when nobody is waiting,
     * so `setBudget`/`dismissBudget` can call it unconditionally.
     *
     * @param {string} sessionId
     * @param {'raised'|'dismissed'|'aborted'|'timeout'} outcome
     * @returns {boolean} Whether a hold was actually waiting.
     */
    settle(sessionId, outcome) {
      return settle(sessionId, outcome)
    },

    /**
     * The promise a hold is currently awaiting, or `null` when the session has no
     * pending hold. `waitForDecision` stays the entry point that creates holds.
     *
     * @param {string} sessionId
     * @returns {Promise<'raised'|'dismissed'|'aborted'|'timeout'> | null}
     */
    pending(sessionId) {
      const entry = holds.get(typeof sessionId === 'string' ? sessionId : '')
      return entry === undefined ? null : entry.promise
    },

    /**
     * Hold the caller until a decision settles the budget conflict.
     *
     * Resolves with:
     *
     * - `'raised'` — the limit was raised (or the budget was cleared);
     * - `'dismissed'` — the user dismissed the popover, or another wait for the
     *   same session superseded this one;
     * - `'aborted'` — the step's `AbortSignal` fired (or was already aborted);
     * - `'timeout'` — `timeoutMs` elapsed first.
     *
     * The timer and the abort listener are removed on every exit path, and the
     * pending entry is deleted before resolving, so a second settle is harmless.
     * Never rejects.
     *
     * @param {string} sessionId
     * @param {object} [signal] `AbortSignal` of the paused step.
     * @param {number} [timeoutMs] Hold budget; `config.budgetHoldMs` by default.
     * @returns {Promise<'raised'|'dismissed'|'aborted'|'timeout'>}
     */
    waitForDecision(sessionId, signal, timeoutMs) {
      const id = typeof sessionId === 'string' ? sessionId : ''
      if (id.length === 0) return Promise.resolve('dismissed')

      // A second wait for the same session replaces the first: the older step
      // must not stay parked forever.
      const previous = holds.get(id)
      if (previous !== undefined) previous.resolve('dismissed')

      let entry = null
      const promise = new Promise((resolve) => {
        const current = { promise: null, resolve: null, settled: false, timer: null, cleanup: null }
        const finish = (outcome) => {
          if (current.settled) return
          current.settled = true
          if (current.timer !== null) {
            clearTimeout(current.timer)
            current.timer = null
          }
          if (current.cleanup !== null) {
            try {
              current.cleanup()
            } catch {
              /* removing a listener must not throw */
            }
            current.cleanup = null
          }
          if (holds.get(id) === current) holds.delete(id)
          resolve(OUTCOMES.has(outcome) ? outcome : 'dismissed')
        }
        current.resolve = finish
        entry = current
        holds.set(id, current)

        if (signal !== null && signal !== undefined && signal.aborted === true) {
          finish('aborted')
          return
        }
        if (signal !== null && signal !== undefined && typeof signal.addEventListener === 'function') {
          const onAbort = () => finish('aborted')
          signal.addEventListener('abort', onAbort, { once: true })
          current.cleanup = () => signal.removeEventListener?.('abort', onAbort)
        }
        const ms = finiteOrNull(timeoutMs)
        if (ms !== null && ms > 0) {
          // Deliberately not `unref()`d: the contract says the timer resolves
          // 'timeout', and an unref'd timer is dropped when nothing else keeps the
          // loop alive (a bare script, a unit test, a shutdown race). Every exit
          // path clears it, so it can never outlive the hold it belongs to.
          current.timer = setTimeout(() => finish('timeout'), ms)
        }
      })
      if (entry !== null) entry.promise = promise
      return promise
    },
  }

  return service
}
