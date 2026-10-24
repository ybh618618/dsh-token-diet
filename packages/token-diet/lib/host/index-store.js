/**
 * The durable usage index: session logs → `(day, provider, model, workspace)` cells.
 *
 * Session logs are the single source of truth; `index.v1.json` is a rebuildable
 * derived cache. That contract drives the whole design:
 *
 * - every session folded into the cache carries the persistence `revision` it
 *   was read at, so a scan only reopens sessions whose revision changed;
 * - a failed or partial scan leaves the previous cache intact and the UI keeps
 *   serving whatever is already known;
 * - live `session/event` folding updates the same in-memory cache so a running
 *   turn shows up immediately, and marks that session stale so the next scan
 *   re-reads it authoritatively from the log.
 *
 * ## Fork deduplication
 *
 * A seeded (forked) session's log starts with an inherited copy of its parent's
 * prefix. Folding the whole log would bill the parent's history twice, so only
 * events with `seq >= inheritedEventCount` count (`inheritedEventCount` is a
 * count, so the fork-copied prefix is `0 .. inherited-1`). `resolveRoot` walks the
 * `parentSession` chain for the budget guard, which needs "this conversation and
 * everything it spawned" as one tree.
 *
 * ## Usage semantics
 *
 * `TokenUsage.inputTokens` is *uncached* prompt input; cache traffic arrives
 * separately, so a bucket maps 1:1 onto the bill:
 * `uncachedInput ← inputTokens`, `cacheRead ← cacheReadTokens`,
 * `cacheWrite ← cacheWriteTokens`, `output ← outputTokens`.
 *
 * Only `@deepseek-ai/dsh-token-meter`'s two contributing event kinds are folded:
 * `assistant/message` (its `data.usage`) and `assistant/attempt` (a `usage`
 * stream chunk written when an attempt errored or was aborted, so a retried step
 * contributes each attempt). Everything else is ignored.
 *
 * @module dsh-token-diet/lib/host/index-store
 */

import { basename, join } from 'node:path'

import { localDateKey } from '../shared/billing.js'
import { createJsonStore } from './store.js'

/** Cache schema version; bump when the stored shape changes incompatibly. */
const INDEX_VERSION = 1
/** Sessions folded per event-loop batch before yielding. */
const DEFAULT_BATCH_SIZE = 8
/** Workspace label used when a session header carries no `cwd`. */
const DEFAULT_WORKSPACE = '默认工作区'
/** Debounce for persisting a live-folded change, in milliseconds. */
const LIVE_SAVE_DELAY_MS = 1_000

/**
 * Create the usage index.
 *
 * @param {object} options Service options.
 * @param {string} options.home Harness home; the cache is
 *   `<home>/token-diet/index.v1.json`.
 * @param {{ warn?: (...args: any[]) => void, error?: (...args: any[]) => void }} [options.logger]
 *   Sink for degraded-path reports.
 * @param {{ batchSize?: number }} [options.config] `batchSize` overrides the
 *   per-batch session count (default 8).
 * @param {{
 *   list: (options?: any) => Promise<Array<{ header: any, revision: any, eventCount?: number }>>,
 *   open: (id: string, access: 'read', options?: any) => Promise<any>,
 *   stat?: (id: string, options?: any) => Promise<any>,
 * }} [options.sessionPersistence] DSH `SessionPersistence` seam. When absent the
 *   index stays empty and reports `ready`.
 * @param {any} [options.agents] Accepted for interface parity; unused.
 * @param {(() => number) | undefined} [options.getRate] Accepted for interface
 *   parity; unused (costing happens in `rpc.js`).
 * @returns {{
 *   init: () => Promise<void>,
 *   progress: () => { state: 'idle'|'scanning'|'ready', done: number, total: number },
 *   scan: (force?: boolean) => Promise<void>,
 *   onEvent: (session: any, event: any) => void,
 *   rows: () => Array<{ date: string, provider: string, model: string, workspace: string, calls: number, uncachedInput: number, cacheRead: number, cacheWrite: number, output: number }>,
 *   sessionUsage: (sessionId: string) => { buckets: Array<any> } | undefined,
 *   headers: () => Map<string, { cwd?: string, parentSession?: string, origin?: string, createdAt: number }>,
 *   resolveRoot: (sessionId: string) => string,
 * }}
 */
export function createUsageIndex({ home, logger, config, sessionPersistence, agents, getRate } = {}) {
  void agents
  void getRate
  const batchSize = positive(config?.batchSize, DEFAULT_BATCH_SIZE)
  const persistence = isPersistence(sessionPersistence) ? sessionPersistence : undefined

  const store = createJsonStore({
    file: typeof home === 'string' && home.length > 0 ? join(home, 'token-diet', 'index.v1.json') : null,
    logger,
    defaults: () => ({}),
  })

  /**
   * The index proper.
   *
   * `sessions` maps a session id to its cached fold. `revision === null` means
   * "live-folded and stale": the next scan must re-read that session.
   *
   * @type {Map<string, {
   *   revision: string | null,
   *   eventCount: number,
   *   header: { cwd?: string, parentSession?: string, origin?: string, createdAt: number },
   *   rows: Array<{ date: string, provider: string, model: string, workspace: string, calls: number, uncachedInput: number, cacheRead: number, cacheWrite: number, output: number }>,
   * }>}
   */
  const sessions = new Map()

  /** Latest `request/header` provider/model per session, for live `assistant/attempt` folds. */
  const liveHeaderConfig = new Map()

  /**
   * `<session id>\0<turn>\0<step>` keys already settled by a live
   * `assistant/message`, so a later `assistant/attempt` for the same call is not
   * billed again. Bounded by the number of steps seen since start-up.
   */
  const settledSteps = new Set()

  /** Scan progress published by `progress()`. */
  const status = { state: 'idle', done: 0, total: 0 }

  /** Memoized flattened rows; invalidated by any mutation. */
  let rowsCache = null
  /** Serializes scans so two calls cannot fold the same session concurrently. */
  let scanChain = Promise.resolve()
  /** Pending debounced cache write for live folds. */
  let liveSaveTimer = null
  /** Whether the cache was loaded at least once. */
  let cacheLoaded = false

  /* ------------------------------------------------------------------ loading */

  /**
   * Restore the cache file into memory.
   *
   * A missing or malformed file simply leaves the index empty; the following scan
   * rebuilds it from the logs.
   *
   * @returns {Promise<void>} Resolves after the attempt.
   */
  async function loadCache() {
    if (cacheLoaded) return
    cacheLoaded = true
    try {
      const cached = await store.load()
      if (cached === null || typeof cached !== 'object') return
      if (cached.version !== INDEX_VERSION) return
      const stored = cached.sessions
      if (stored === null || typeof stored !== 'object') return
      for (const [id, entry] of Object.entries(stored)) {
        if (entry === null || typeof entry !== 'object') continue
        if (!Array.isArray(entry.rows)) continue
        sessions.set(id, {
          revision: typeof entry.revision === 'string' ? entry.revision : null,
          eventCount: Number.isSafeInteger(entry.eventCount) ? entry.eventCount : 0,
          header: normalizeHeader(entry.header),
          rows: entry.rows.filter(isBucket).map(copyBucket),
        })
        // A cached session is stale by definition until a scan confirms it; its
        // revision still lets the scan skip re-reading when the file is untouched.
      }
      // The Web client polls `summary` while the cache is still being read, and
      // `rows()` memoizes whatever it computed. Without this, the first read
      // (empty) stayed pinned: the page showed zero usage for minutes on a
      // cache-only start — no scan was running to invalidate it.
      rowsCache = null
    } catch (error) {
      warn(`[token-diet] index cache load failed: ${describe(error)}`)
    }
  }

  /**
   * Persist the cache file.
   *
   * @returns {Promise<void>} Resolves after the write attempt.
   */
  async function saveCache() {
    const out = {}
    for (const [id, entry] of sessions) {
      out[id] = {
        revision: entry.revision,
        eventCount: entry.eventCount,
        header: entry.header,
        rows: entry.rows,
      }
    }
    try {
      await store.save({ version: INDEX_VERSION, sessions: out })
    } catch (error) {
      warn(`[token-diet] index cache save failed: ${describe(error)}`)
    }
  }

  /* -------------------------------------------------------------------- scan */

  /**
   * Load the cache, then start a scan in the background.
   *
   * `init()` deliberately does not await the scan: a cold index over hundreds of
   * sessions must not delay plugin start-up, and the page renders partial
   * progress instead.
   *
   * @returns {Promise<void>} Resolves once the cache is loaded and the scan started.
   */
  async function init() {
    try {
      await loadCache()
    } catch (error) {
      warn(`[token-diet] index init failed: ${describe(error)}`)
    }
    if (persistence === undefined) {
      status.state = 'ready'
      status.done = 0
      status.total = 0
      return
    }
    // Fire and forget; any rejection is handled inside `scan`.
    void scan(false)
  }

  /**
   * Reconcile the index with the session logs.
   *
   * Sessions whose persistence `revision` matches the cached one are skipped
   * unless `force` is set. The rest are opened one at a time, read fully, closed,
   * and folded. Work is done in batches of `batchSize` with a `setImmediate`
   * yield between them so a large first scan cannot starve the event loop.
   *
   * @param {boolean} [force] Re-read every session, ignoring cached revisions.
   * @returns {Promise<void>} Resolves when this scan settled; never rejects.
   */
  async function scan(force = false) {
    if (persistence === undefined) {
      status.state = 'ready'
      return
    }
    // Serialize scans: a second caller waits for the running one rather than
    // racing it. A forced scan still runs its own pass afterwards.
    const run = scanChain.then(async () => {
      try {
        await loadCache()
      } catch (error) {
        warn(`[token-diet] index cache load failed: ${describe(error)}`)
      }
      let snapshots
      try {
        snapshots = await persistence.list()
      } catch (error) {
        warn(`[token-diet] cannot list sessions: ${describe(error)}`)
        status.state = sessions.size > 0 ? 'ready' : 'ready'
        return
      }
      if (!Array.isArray(snapshots)) {
        status.state = 'ready'
        return
      }
      status.state = 'scanning'
      status.total = snapshots.length
      status.done = 0
      let changed = false

      for (let start = 0; start < snapshots.length; start += batchSize) {
        const batch = snapshots.slice(start, start + batchSize)
        for (const snapshot of batch) {
          const id = snapshot?.header?.id
          if (typeof id !== 'string' || id.length === 0) {
            status.done += 1
            continue
          }
          const revision = typeof snapshot.revision === 'string' ? snapshot.revision : null
          const cached = sessions.get(id)
          const eventCount = Number.isSafeInteger(snapshot.eventCount) ? snapshot.eventCount : 0
          if (!force && cached !== undefined && revision !== null && cached.revision === revision) {
            // Unchanged: keep the cached rows, but refresh the cheap header fields
            // in case a rename or a cwd change landed without touching events.
            cached.header = headerOf(snapshot.header)
            status.done += 1
            continue
          }
          const folded = await foldSession(id, snapshot, revision)
          if (folded !== null) {
            sessions.set(id, folded)
            changed = true
          }
          status.done += 1
        }
        // Yield so timers, sockets and the renderer keep running.
        if (start + batchSize < snapshots.length) await new Promise((resolve) => setImmediate(resolve))
      }

      status.state = 'ready'
      // Prune sessions that no longer exist so deleting a log actually frees rows.
      const liveIds = new Set()
      for (const snapshot of snapshots) {
        const id = snapshot?.header?.id
        if (typeof id === 'string') liveIds.add(id)
      }
      for (const id of [...sessions.keys()]) {
        if (!liveIds.has(id)) {
          sessions.delete(id)
          liveHeaderConfig.delete(id)
          changed = true
        }
      }
      if (changed) {
        rowsCache = null
        await saveCache()
      }
    })
    scanChain = run.then(
      () => undefined,
      () => undefined,
    )
    await run
  }

  /**
   * Read and fold one session.
   *
   * The handle is always closed, even when the read throws. A missing session
   * (deleted between `list` and `open`) yields `null` and drops the cached entry.
   *
   * @param {string} id Session id.
   * @param {{ header: any, revision: any }} snapshot Listing snapshot.
   * @param {string | null} revision Revision to record, or `null` for "always stale".
   * @returns {Promise<{ revision: string | null, eventCount: number, header: any, rows: Array<any> } | null>}
   *   The fold, or `null` when the session could not be read.
   */
  async function foldSession(id, snapshot, revision) {
    let handle
    try {
      handle = await persistence.open(id, 'read')
    } catch (error) {
      // The log disappeared between list and open: forget it rather than keep
      // stale rows around.
      if (sessions.delete(id)) rowsCache = null
      liveHeaderConfig.delete(id)
      warn(`[token-diet] cannot open session ${id}: ${describe(error)}`)
      return null
    }
    try {
      const inherited = Number.isSafeInteger(handle?.inheritedEventCount)
        ? handle.inheritedEventCount
        : 0
      const result = await handle.read(0)
      const events = Array.isArray(result?.events) ? result.events : []
      const header = headerOf(snapshot?.header ?? handle?.header)
      const rows = foldEvents(events, inherited, workspaceOf(header), liveHeaderConfig, id)
      return {
        revision,
        eventCount: Number.isSafeInteger(snapshot?.eventCount) ? snapshot.eventCount : events.length,
        header,
        rows,
      }
    } catch (error) {
      warn(`[token-diet] cannot read session ${id}: ${describe(error)}`)
      return null
    } finally {
      try {
        await handle.close()
      } catch (error) {
        // A read handle's close is a no-op in practice; never let it mask the fold.
        warn(`[token-diet] cannot close session ${id}: ${describe(error)}`)
      }
    }
  }

  /* ------------------------------------------------------------------- folding */

  /**
   * Fold a whole session read into bucket rows.
   *
   * Tracks the newest `request/header` provider/model so `assistant/attempt`
   * events (which carry only a stream) can be attributed. Events at or below the
   * fork cut are skipped, because they belong to the parent session that already
   * counted them.
   *
   * @param {Array<any>} events Events in log order.
   * @param {number} inherited Number of inherited (fork-copied) events.
   * @param {string} workspace Workspace label of the owning session.
   * @param {Map<string, { provider: string, model: string }>} configBySession
   *   Per-session header cache, updated as a side effect for the live fold.
   * @param {string} sessionId Owning session id.
   * @returns {Array<any>} Bucket rows.
   */
  function foldEvents(events, inherited, workspace, configBySession, sessionId) {
    const cells = new Map()
    /**
     * Usage per model call, keyed by `turn/step`.
     *
     * A retried step logs `assistant/attempt` for each try and one final
     * `assistant/message`; both carry provider usage for overlapping calls, so
     * adding them all would bill the step several times. The settlement wins
     * outright, and an attempt is kept only for a step that never settled (a
     * process killed mid-step still spent those tokens).
     *
     * @type {Map<string, { sample: any, provider: string, model: string, seq: number, time: number, settled: boolean }>}
     */
    const steps = new Map()
    let provider = ''
    let model = ''
    for (let position = 0; position < events.length; position += 1) {
      const event = events[position]
      if (event === null || typeof event !== 'object') continue
      const seq = Number.isSafeInteger(event.seq) ? event.seq : position
      if (event.type === 'request/header') {
        // The header in force may itself be inherited, so it is tracked on both
        // sides of the fork cut; only the live-fold cache is cut-scoped.
        const config = event?.data?.header?.config
        if (typeof config?.provider === 'string') provider = config.provider
        if (typeof config?.model === 'string') model = config.model
        if (seq >= inherited) configBySession.set(sessionId, { provider, model })
        continue
      }
      // `inherited` is a *count*: the fork-copied prefix occupies seq
      // `0 .. inherited-1`, and this session's own first event is `seq ===
      // inherited`. Comparing with `<=` dropped that first event of every session
      // (and of every fork), which silently undercounted usage.
      if (seq < inherited) continue
      const sample = usageOf(event)
      if (sample === null) continue
      const eventProvider = nonEmpty(sample.provider) ?? nonEmpty(provider) ?? 'unknown'
      const eventModel = nonEmpty(sample.model) ?? nonEmpty(model) ?? 'unknown'
      const key = stepKeyOf(event)
      const time = Number.isFinite(event.time) ? event.time : Date.now()
      if (key === null) {
        // No step identity to dedupe on: bill the event on its own.
        addCell(cells, {
          date: localDateKey(time),
          provider: eventProvider,
          model: eventModel,
          workspace,
          calls: 1,
          uncachedInput: count(sample.usage.inputTokens),
          cacheRead: count(sample.usage.cacheReadTokens),
          cacheWrite: count(sample.usage.cacheWriteTokens),
          output: count(sample.usage.outputTokens),
        })
        continue
      }
      const previous = steps.get(key)
      if (sample.settlesStep === true) {
        steps.set(key, { sample, provider: eventProvider, model: eventModel, seq, time, settled: true })
      } else if (previous === undefined || previous.settled !== true) {
        // Keep the newest unsettled attempt; a settlement replaces it below.
        if (previous === undefined || seq >= previous.seq) {
          steps.set(key, { sample, provider: eventProvider, model: eventModel, seq, time, settled: false })
        }
      }
    }
    for (const { sample, provider: eventProvider, model: eventModel, time } of steps.values()) {
      addCell(cells, {
        date: localDateKey(time),
        provider: eventProvider,
        model: eventModel,
        workspace,
        calls: 1,
        uncachedInput: count(sample.usage.inputTokens),
        cacheRead: count(sample.usage.cacheReadTokens),
        cacheWrite: count(sample.usage.cacheWriteTokens),
        output: count(sample.usage.outputTokens),
      })
    }
    return [...cells.values()]
  }

  /**
   * Fold one live event into the cached rows of its session.
   *
   * Kept deliberately cheap: one lookup, one bucket merge, one stale marker and a
   * debounced write. It never throws into the `session/event` dispatcher.
   *
   * @param {any} session The live `Session` (uses `id` and `header`).
   * @param {any} event The committed session event.
   * @returns {void}
   */
  function onEvent(session, event) {
    try {
      if (persistence === undefined) return
      const id = session?.id
      if (typeof id !== 'string' || id.length === 0) return
      if (event === null || typeof event !== 'object') return

      if (event.type === 'request/header') {
        const config = event?.data?.header?.config
        if (typeof config?.provider === 'string' && typeof config?.model === 'string') {
          liveHeaderConfig.set(id, { provider: config.provider, model: config.model })
        }
        return
      }

      const sample = usageOf(event)
      if (sample === null) return

      let entry = sessions.get(id)
      if (entry === undefined) {
        entry = {
          revision: null,
          eventCount: 0,
          header: headerOf(session?.header),
          rows: [],
        }
        sessions.set(id, entry)
      }
      const tracked = liveHeaderConfig.get(id)
      const provider = nonEmpty(sample.provider) ?? nonEmpty(tracked?.provider) ?? 'unknown'
      const model = nonEmpty(sample.model) ?? nonEmpty(tracked?.model) ?? 'unknown'

      // A settlement supersedes an unsettled attempt for the same call, exactly as
      // the full fold does, so the live path cannot bill a step twice either.
      const stepKey = stepKeyOf(event)
      if (stepKey !== null && sample.settlesStep !== true) {
        if (settledSteps.has(`${id}\u0000${stepKey}`)) return
      }
      if (stepKey !== null && sample.settlesStep === true) {
        settledSteps.add(`${id}\u0000${stepKey}`)
      }

      const cells = new Map()
      for (const row of entry.rows) cells.set(cellKey(row), copyBucket(row))
      addCell(cells, {
        date: localDateKey(Number.isFinite(event.time) ? event.time : Date.now()),
        provider,
        model,
        workspace: workspaceOf(entry.header),
        calls: 1,
        uncachedInput: count(sample.usage.inputTokens),
        cacheRead: count(sample.usage.cacheReadTokens),
        cacheWrite: count(sample.usage.cacheWriteTokens),
        output: count(sample.usage.outputTokens),
      })
      entry.rows = [...cells.values()]
      // Count the event so the revision comparison alone cannot decide the session
      // is unchanged. `revision` is dropped because the live fold is provisional:
      // the next scan re-reads the authoritative log and replaces these rows.
      entry.eventCount = Math.max(entry.eventCount ?? 0, Number.isSafeInteger(event.seq) ? event.seq + 1 : 0)
      entry.revision = null
      rowsCache = null
      scheduleLiveSave()
    } catch (error) {
      warn(`[token-diet] live fold failed: ${describe(error)}`)
    }
  }

  /**
   * Persist live-folded changes soon, without writing once per event.
   *
   * @returns {void}
   */
  function scheduleLiveSave() {
    if (liveSaveTimer !== null) return
    liveSaveTimer = setTimeout(() => {
      liveSaveTimer = null
      void saveCache()
    }, LIVE_SAVE_DELAY_MS)
    // Do not keep the process alive just to flush a derived cache.
    liveSaveTimer.unref?.()
  }

  /* -------------------------------------------------------------------- reads */

  /**
   * Scan progress for the "正在统计历史会话 32/186" hint.
   *
   * @returns {{ state: 'idle'|'scanning'|'ready', done: number, total: number }}
   *   Snapshot of the current scan.
   */
  function progress() {
    return { state: status.state, done: status.done, total: status.total }
  }

  /**
   * Every bucket of the whole index, flattened and merged across sessions.
   *
   * Cells with the same `(date, provider, model, workspace)` key are summed, so
   * the result is a set of unique cells whether or not several sessions shared
   * one.
   *
   * @returns {Array<{ date: string, provider: string, model: string, workspace: string, calls: number, uncachedInput: number, cacheRead: number, cacheWrite: number, output: number }>}
   *   The full index.
   */
  function rows() {
    if (rowsCache !== null) return rowsCache
    const cells = new Map()
    for (const entry of sessions.values()) {
      for (const row of entry.rows) addCell(cells, row)
    }
    rowsCache = [...cells.values()]
    return rowsCache
  }

  /**
   * One session's usage, summed per model.
   *
   * Cost and budget arithmetic only needs `(provider, model, tokens)`, so a
   * session-scoped read merges away the day and workspace dimensions; `date`
   * keeps the latest day seen and `workspace` the session's own label.
   *
   * @param {string} sessionId Session id.
   * @returns {{ buckets: Array<{ provider: string, model: string, date: string, workspace: string, calls: number, uncachedInput: number, cacheRead: number, cacheWrite: number, output: number }> } | undefined}
   *   `undefined` for an unknown session.
   */
  function sessionUsage(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    const entry = sessions.get(sessionId)
    if (entry === undefined) return undefined
    const cells = new Map()
    for (const row of entry.rows) {
      const key = `${row.provider}\u0000${row.model}`
      const current = cells.get(key)
      if (current === undefined) {
        cells.set(key, copyBucket(row))
        continue
      }
      current.calls += row.calls
      current.uncachedInput += row.uncachedInput
      current.cacheRead += row.cacheRead
      current.cacheWrite += row.cacheWrite
      current.output += row.output
      // Keep the most recent day so the shape stays informative.
      if (row.date > current.date) current.date = row.date
    }
    return { buckets: [...cells.values()] }
  }

  /**
   * Every known session header, for the workspace breakdown and root resolution.
   *
   * @returns {Map<string, { cwd?: string, parentSession?: string, origin?: string, createdAt: number }>}
   *   Session id → header projection.
   */
  function headers() {
    const out = new Map()
    for (const [id, entry] of sessions) out.set(id, { ...entry.header })
    return out
  }

  /**
   * Walk `parentSession` up to the outermost session.
   *
   * The budget of a conversation applies to the conversation plus every
   * sub-agent it spawned, so the guard needs one stable root id for a session
   * tree. Cycles (never expected, but a corrupted log could produce one) are
   * detected with a visited set, and an unknown id resolves to itself.
   *
   * @param {string} sessionId Any session id.
   * @returns {string} The root session id, or the input when it cannot be resolved.
   */
  function resolveRoot(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return sessionId
    const visited = new Set()
    let current = sessionId
    for (;;) {
      if (visited.has(current)) return sessionId
      visited.add(current)
      const parent = sessions.get(current)?.header?.parentSession
      if (typeof parent !== 'string' || parent.length === 0) return current
      if (!sessions.has(parent)) return current
      current = parent
    }
  }

  /**
   * Report one degraded-path failure through the optional logger.
   *
   * @param {string} message Human-readable diagnostic.
   */
  function warn(message) {
    try {
      logger?.warn?.(message)
    } catch {
      /* logging must never break the index */
    }
  }

  return {
    init,
    progress,
    scan,
    onEvent,
    rows,
    sessionUsage,
    headers,
    resolveRoot,
  }
}

/* -------------------------------------------------------------------- helpers */

/**
 * Extract the usage sample of a contributing event.
 *
 * @param {any} event Session event.
 * @returns {{ usage: any, provider?: string, model?: string } | null}
 *   `provider`/`model` are only set for `assistant/message`, which carries them
 *   on `data.message.source`.
 */
function usageOf(event) {
  if (event === null || typeof event !== 'object') return null
  if (event.type === 'assistant/message') {
    const usage = event?.data?.usage
    if (usage === null || typeof usage !== 'object') return null
    const source = event?.data?.message?.source
    return {
      usage,
      provider: typeof source?.provider === 'string' ? source.provider : undefined,
      model: typeof source?.model === 'string' ? source.model : undefined,
      // A settlement supersedes the streaming sample of the same step.
      settlesStep: true,
    }
  }
  if (event.type === 'assistant/attempt') {
    const stream = event?.data?.stream
    if (!Array.isArray(stream)) return null
    // The last usage chunk wins, matching token-meter's `lastAssistantStreamChunk`.
    let usage = null
    for (const record of stream) {
      if (record?.type !== 'chunk') continue
      const chunk = record.chunk
      if (chunk?.type !== 'usage' || chunk.usage === null || typeof chunk.usage !== 'object') continue
      usage = chunk.usage
    }
    return usage === null ? null : { usage, settlesStep: false }
  }
  return null
}

/**
 * Identity of the model call one event belongs to: `turn/step`.
 *
 * A retried step appends `assistant/attempt` events as well as its final
 * `assistant/message`. Both carry provider usage for overlapping calls, so the
 * fold must not bill a step twice. The settlement (`assistant/message`) always
 * wins; an attempt only contributes when no settlement exists for its step, which
 * covers a process that died mid-step.
 *
 * @param {any} event Usage-bearing event.
 * @returns {string | null} Step identity, or `null` when it cannot be derived.
 */
function stepKeyOf(event) {
  const turn = event?.data?.turn
  const step = event?.data?.step
  if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step)) return null
  return `${turn}\u0000${step}`
}

/**
 * Merge one row into a keyed cell map, summing every counter.
 *
 * @param {Map<string, any>} cells Destination map keyed by {@link cellKey}.
 * @param {any} row Bucket to merge.
 * @returns {void}
 */
function addCell(cells, row) {
  const key = cellKey(row)
  const current = cells.get(key)
  if (current === undefined) {
    cells.set(key, {
      date: row.date,
      provider: row.provider,
      model: row.model,
      workspace: row.workspace,
      calls: count(row.calls),
      uncachedInput: count(row.uncachedInput),
      cacheRead: count(row.cacheRead),
      cacheWrite: count(row.cacheWrite),
      output: count(row.output),
    })
    return
  }
  current.calls += count(row.calls)
  current.uncachedInput += count(row.uncachedInput)
  current.cacheRead += count(row.cacheRead)
  current.cacheWrite += count(row.cacheWrite)
  current.output += count(row.output)
}

/** Stable identity of one bucket cell. */
function cellKey(row) {
  return `${row.date}\u0000${row.provider}\u0000${row.model}\u0000${row.workspace}`
}

/** A deep-enough copy of one bucket. */
function copyBucket(row) {
  return {
    date: row.date,
    provider: row.provider,
    model: row.model,
    workspace: row.workspace,
    calls: count(row.calls),
    uncachedInput: count(row.uncachedInput),
    cacheRead: count(row.cacheRead),
    cacheWrite: count(row.cacheWrite),
    output: count(row.output),
  }
}

/** Whether a stored row looks like a bucket. */
function isBucket(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.date === 'string' &&
    typeof value.provider === 'string' &&
    typeof value.model === 'string' &&
    typeof value.workspace === 'string'
  )
}

/**
 * Project a full session header onto the four fields the index needs.
 *
 * @param {any} header A `SessionHeader` (or a cached projection).
 * @returns {{ cwd?: string, parentSession?: string, origin?: string, createdAt: number }}
 *   The projection; absent optional fields are omitted.
 */
function headerOf(header) {
  const out = {
    createdAt: Number.isSafeInteger(header?.createdAt) ? header.createdAt : 0,
  }
  if (typeof header?.cwd === 'string' && header.cwd.length > 0) out.cwd = header.cwd
  if (typeof header?.parentSession === 'string' && header.parentSession.length > 0) {
    out.parentSession = header.parentSession
  }
  if (typeof header?.origin === 'string' && header.origin.length > 0) out.origin = header.origin
  return out
}

/**
 * Normalize a header read back from the cache file.
 *
 * @param {any} header Cached header projection.
 * @returns {{ cwd?: string, parentSession?: string, origin?: string, createdAt: number }}
 *   A valid projection.
 */
function normalizeHeader(header) {
  return headerOf(header)
}

/**
 * Workspace label of a session: the basename of its `cwd`, else the default.
 *
 * Both separators are normalized first so a Windows path still yields its last
 * segment on a POSIX host (and vice versa).
 *
 * @param {{ cwd?: string } | undefined} header Session header projection.
 * @returns {string} A non-empty workspace label.
 */
function workspaceOf(header) {
  const cwd = header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return DEFAULT_WORKSPACE
  const normalized = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalized.length === 0) return DEFAULT_WORKSPACE
  const label = basename(normalized)
  return label.length > 0 ? label : DEFAULT_WORKSPACE
}

/** A non-negative finite counter, or `0`. */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** A non-empty string, or `undefined` (so `??` chains skip blank ids). */
function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** A positive finite tunable, or `fallback`. */
function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** Whether a value looks like the `SessionPersistence` seam. */
function isPersistence(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.list === 'function' &&
    typeof value.open === 'function'
  )
}

/** A compact one-line description of an unknown error value. */
function describe(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
