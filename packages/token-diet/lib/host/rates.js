/**
 * USD → CNY exchange rate service.
 *
 * The rate is display-only: every cost in this plugin is computed in USD and
 * multiplied by the current rate when the UI shows CNY, so a stale or built-in
 * rate degrades accuracy, never correctness. That is why this module is
 * written to be structurally incapable of throwing at the plugin boundary.
 *
 * Behaviour, in priority order:
 *
 * 1. a manual override (`config.overridden` / `setOverride(n)`) wins, needs no
 *    network and is persisted in the cache file;
 * 2. a cached automatic rate younger than the TTL (12 h by default);
 * 3. a live fetch: `open.er-api.com` first, `frankfurter.app` second, accepting
 *    only a finite value inside `5 … 10`;
 * 4. when both sources fail: the last good automatic rate, else the built-in
 *    `7.2` with `source: 'builtin'`, plus an `error` explaining what failed.
 *
 * All network traffic goes through the injectable `fetchImpl`, followed redirects
 * and a 15 s `AbortSignal.timeout`, so tests never touch the network.
 *
 * @module dsh-token-diet/lib/host/rates
 */

import { join } from 'node:path'

import { createJsonStore } from './store.js'

/** Default cache lifetime: 12 hours. */
const DEFAULT_REFRESH_MS = 43_200_000
/** Plausible USD→CNY band. Outside it, a source is treated as broken. */
const MIN_RATE = 5
const MAX_RATE = 10
/** Built-in fallback when no source has ever succeeded. */
const BUILTIN_RATE = 7.2
/** Abort a fetch after this long; a hanging rate lookup must not block paint. */
const FETCH_TIMEOUT_MS = 15_000

/** The two rate sources, in priority order. */
const SOURCES = [
  { source: 'open.er-api.com', url: 'https://open.er-api.com/v6/latest/USD' },
  { source: 'frankfurter', url: 'https://api.frankfurter.app/latest?from=USD&to=CNY' },
]

/**
 * Create the exchange-rate service.
 *
 * @param {object} options Service options.
 * @param {string} options.home Harness home directory; the cache lives in
 *   `<home>/token-diet/rate.v1.json`.
 * @param {{ warn?: (...args: any[]) => void, error?: (...args: any[]) => void }} [options.logger]
 *   Sink for degraded-path reports.
 * @param {{ refreshMs?: number, overridden?: number | null }} [options.config]
 *   `refreshMs` overrides the 12 h TTL, `overridden` supplies a manual rate.
 * @param {typeof fetch} [options.fetchImpl] Injectable fetch (tests / showcase).
 * @returns {{
 *   config: { refreshMs: number, overridden: number | null },
 *   init: () => Promise<void>,
 *   current: () => { cnyPerUsd: number, source: string, fetchedAt: string, error?: string },
 *   refresh: (force?: boolean) => Promise<{ cnyPerUsd: number, source: string, fetchedAt: string, error?: string }>,
 *   setOverride: (cnyPerUsd: number | null) => Promise<{ cnyPerUsd: number, source: string, fetchedAt: string, error?: string }>,
 * }}
 */
export function createRateService({ home, logger, config, fetchImpl } = {}) {
  const settings = {
    refreshMs: positive(config?.refreshMs, DEFAULT_REFRESH_MS),
    // A manual override is user intent, not a network sample, so it only has to
    // be a finite positive number; the 5…10 band guards automatic sources.
    overridden: positiveOrNull(config?.overridden),
  }
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch

  const store = createJsonStore({
    file: typeof home === 'string' && home.length > 0 ? join(home, 'token-diet', 'rate.v1.json') : null,
    logger,
    defaults: () => ({}),
  })

  /**
   * The automatic (network) rate remembered from the last success. Kept
   * separately from the snapshot so a manual override does not destroy it.
   *
   * @type {{ cnyPerUsd: number, source: string, fetchedAt: string } | null}
   */
  let automatic = null
  /** Override supplied by the composition; wins over the persisted one. */
  const configuredOverride = settings.overridden
  /** Effective manual override: config first, then whatever the cache holds. */
  let storedOverride = configuredOverride
  /** Last failure message, surfaced on the snapshot until a refresh succeeds. */
  let lastError = null
  /** The snapshot `current()` returns; `null` only before the very first call. */
  let snapshot = null
  /** Deduped in-flight refresh. */
  let inFlight = null

  /**
   * Build the snapshot for the current state without touching the network.
   *
   * @returns {{ cnyPerUsd: number, source: string, fetchedAt: string, error?: string }}
   *   A complete `RateSnapshot`.
   */
  function compose() {
    const manual = storedOverride
    let base
    if (manual !== null) {
      // An override keeps the automatic sample's timestamp so the UI can still
      // show when the underlying market rate was observed.
      base = {
        cnyPerUsd: manual,
        source: 'manual',
        fetchedAt: automatic?.fetchedAt ?? new Date().toISOString(),
      }
    } else if (automatic !== null) {
      base = { ...automatic }
    } else {
      base = { cnyPerUsd: BUILTIN_RATE, source: 'builtin', fetchedAt: new Date().toISOString() }
    }
    return lastError === null ? base : { ...base, error: lastError }
  }

  /** Persist the cache payload: automatic sample plus override marker. */
  async function persist() {
    await store.save({
      ...(automatic === null ? {} : { automatic }),
      override: storedOverride,
    })
  }

  /**
   * Try one source; returns the parsed rate or `undefined` when unusable.
   *
   * @param {{ source: string, url: string }} entry Source descriptor.
   * @returns {Promise<{ cnyPerUsd: number, source: string } | undefined>} Accepted rate.
   */
  async function fetchOne(entry) {
    try {
      const response = await doFetch(entry.url, {
        redirect: 'follow',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (response === null || typeof response !== 'object' || !response.ok) {
        warn(`[token-diet] rate source ${entry.source} returned HTTP ${response?.status ?? 'no response'}`)
        return undefined
      }
      const json = await response.json()
      const value = json?.rates?.CNY
      if (!validRate(value)) {
        warn(`[token-diet] rate source ${entry.source} returned an implausible CNY rate: ${String(value)}`)
        return undefined
      }
      return { cnyPerUsd: value, source: entry.source }
    } catch (error) {
      warn(`[token-diet] rate source ${entry.source} failed: ${describe(error)}`)
      return undefined
    }
  }

  /**
   * Fetch the automatic rate from the first working source.
   *
   * @returns {Promise<{ cnyPerUsd: number, source: string } | undefined>} The accepted
   *   sample, or `undefined` when every source failed.
   */
  async function fetchAutomatic() {
    // A manual override still short-circuits the network entirely.
    if (storedOverride !== null) return undefined
    for (const entry of SOURCES) {
      const sample = await fetchOne(entry)
      if (sample !== undefined) return sample
    }
    return undefined
  }

  /**
   * Load the cache file, then refresh when the cached automatic sample is stale.
   *
   * Never throws: a corrupt cache and an offline machine both degrade to the
   * built-in rate.
   *
   * @returns {Promise<void>} Resolves once the snapshot reflects the cache and,
   *   when needed, one refresh attempt.
   */
  async function init() {
    try {
      const cached = await store.load()
      const automaticCached = cached?.automatic
      if (
        automaticCached !== null &&
        typeof automaticCached === 'object' &&
        validRate(automaticCached.cnyPerUsd) &&
        typeof automaticCached.fetchedAt === 'string'
      ) {
        automatic = {
          cnyPerUsd: automaticCached.cnyPerUsd,
          source: typeof automaticCached.source === 'string' ? automaticCached.source : 'builtin',
          fetchedAt: automaticCached.fetchedAt,
        }
      } else if (validRate(cached?.cnyPerUsd) && typeof cached?.fetchedAt === 'string') {
        // Tolerate a flat legacy cache shape: `{ cnyPerUsd, source, fetchedAt }`.
        automatic = {
          cnyPerUsd: cached.cnyPerUsd,
          source: typeof cached.source === 'string' ? cached.source : 'builtin',
          fetchedAt: cached.fetchedAt,
        }
      }
      // A composition override outranks the cache; otherwise the persisted choice
      // (a rate, or the explicit `null` written by `setOverride(null)`) applies.
      if (configuredOverride === null) {
        if (positiveOrNull(cached?.override) !== null) storedOverride = cached.override
        else if (cached?.override === null) storedOverride = null
      }
      snapshot = compose()
      await refresh(false)
    } catch (error) {
      warn(`[token-diet] rate init failed: ${describe(error)}`)
      snapshot = snapshot ?? compose()
    }
  }

  /**
   * Refresh the rate when stale or forced.
   *
   * Concurrent calls share one network round trip.
   *
   * @param {boolean} [force] Ignore the TTL and the manual override.
   * @returns {Promise<{ cnyPerUsd: number, source: string, fetchedAt: string, error?: string }>}
   *   The snapshot after the attempt; resolves rather than rejecting.
   */
  async function refresh(force = false) {
    if (inFlight !== null) return inFlight
    const manual = storedOverride
    // With a manual override there is nothing to fetch unless one was asked for;
    // `force` then re-reads the market rate in the background of the snapshot
    // while `current()` keeps reporting the override.
    if (manual !== null && !force) {
      snapshot = compose()
      return snapshot
    }
    if (manual === null && !force && automatic !== null) {
      const age = Date.now() - Date.parse(automatic.fetchedAt)
      if (Number.isFinite(age) && age >= 0 && age < settings.refreshMs) {
        snapshot = compose()
        return snapshot
      }
    }
    inFlight = (async () => {
      const sample = await fetchAutomatic()
      if (sample !== undefined) {
        automatic = { ...sample, fetchedAt: new Date().toISOString() }
        lastError = null
        await persist()
      } else if (storedOverride === null) {
        lastError =
          automatic === null
            ? '汇率未更新：两个汇率源都不可用，暂用内置汇率 7.20'
            : '汇率未更新：两个汇率源都不可用，暂用上一次成功获取的汇率'
        warn(`[token-diet] ${lastError}`)
      }
      snapshot = compose()
      return snapshot
    })()
    try {
      return await inFlight
    } finally {
      inFlight = null
    }
  }

  /**
   * The current rate snapshot. Pure read; cannot throw and never blocks.
   *
   * @returns {{ cnyPerUsd: number, source: string, fetchedAt: string, error?: string }}
   *   `source` is one of `open.er-api.com`, `frankfurter`, `builtin`, `manual`.
   */
  function current() {
    if (snapshot === null) snapshot = compose()
    return snapshot
  }

  /**
   * Set or clear the manual override.
   *
   * The `5 … 10` plausibility band applies to *automatic* sources only: a user may
   * legitimately want a different fixed number, so any finite positive value is
   * accepted here. `setOverride(null)` resumes automatic mode and immediately
   * refreshes so the UI does not have to wait for the TTL.
   *
   * @param {number | null} cnyPerUsd A positive CNY-per-USD rate, or `null` to clear.
   * @returns {Promise<{ cnyPerUsd: number, source: string, fetchedAt: string, error?: string }>}
   *   The snapshot after the change.
   */
  async function setOverride(cnyPerUsd) {
    if (cnyPerUsd === null || cnyPerUsd === undefined) {
      storedOverride = null
      lastError = null
      await persist()
      snapshot = compose()
      // Resume automatic mode with a fresh sample when one is due.
      return refresh(false)
    }
    if (typeof cnyPerUsd !== 'number' || !Number.isFinite(cnyPerUsd) || cnyPerUsd <= 0) {
      warn(`[token-diet] refusing non-positive rate override: ${String(cnyPerUsd)}`)
      return current()
    }
    storedOverride = cnyPerUsd
    lastError = null
    await persist()
    snapshot = compose()
    return snapshot
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
      /* logging must never break the service */
    }
  }

  return {
    /**
     * Live view of the tuning knobs: `refreshMs` is fixed, `overridden` always
     * reports the override currently in force (so it follows `setOverride`).
     */
    config: {
      refreshMs: settings.refreshMs,
      get overridden() {
        return storedOverride
      },
    },
    init,
    current,
    refresh,
    setOverride,
  }
}

/** Whether a value is a plausible USD→CNY rate from an automatic source. */
function validRate(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_RATE && value <= MAX_RATE
}

/** A finite positive number, or `null`. */
function positiveOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** A finite positive tunable, or `fallback`. */
function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** A compact one-line description of an unknown error value. */
function describe(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
