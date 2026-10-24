/**
 * models.dev pricing, custom price overrides and inexact model matching.
 *
 * ## Why this module exists
 *
 * Session usage is recorded per `(provider, model)` exactly as the model adapter
 * reported it. Those ids rarely line up with models.dev: DSH is pointed at
 * proxies and custom endpoints (`magpie`, `workbuddy`, `cmdc`, `openai-codex`,
 * `owlapi`), some vendors publish dated or suffixed ids, and a locally served
 * model has no public price at all. Turning a usage row into money therefore
 * needs three layers, applied in this order:
 *
 * 1. a **user price** (`setCustom`) — always wins, can express "local model,
 *    count it as zero";
 * 2. an **exact** models.dev provider+model id;
 * 3. the provider **alias** table, then the same exact lookup;
 * 4. the same model id under **any** provider (`cross-provider`);
 * 5. a conservative **normalized fuzzy** match.
 *
 * The result always names the resolution's confidence so the UI can badge an
 * inexact match instead of silently presenting a guess as fact.
 *
 * ## Memory
 *
 * models.dev's `api.json` is several megabytes. It is parsed once, folded into a
 * compact table (provider → model → price, plus a normalized-id index) and then
 * dropped; `refresh` never retains the raw payload.
 *
 * ## Network
 *
 * The only endpoint is `https://models.dev/api.json`; all traffic goes through
 * the injectable `fetchImpl` with a 15 s `AbortSignal.timeout` and followed
 * redirects. `init()` and `refresh()` never throw.
 *
 * @module dsh-token-diet/lib/host/pricing
 */

import { join } from 'node:path'

import { normalizePrice } from '../shared/billing.js'
import { createJsonStore } from './store.js'

/** Default price-table lifetime: 24 hours. */
const DEFAULT_REFRESH_MS = 86_400_000
/** Source of the price table. */
const MODELS_DEV_URL = 'https://models.dev/api.json'
/** Abort a fetch after this long. */
const FETCH_TIMEOUT_MS = 15_000
/** Trailing id tokens that carry no pricing meaning. */
const TAIL_TOKENS = new Set(['latest', 'free', 'preview', 'exp', 'experimental'])
/** Suffixes such as `:free` / `:latest` stripped from an id before normalizing. */
const SUFFIX_TAG = /:(latest|free|preview|exp|experimental)$/i
/**
 * Shortest normalized id allowed into the edit-distance fuzzy tier. Below this a
 * single edit covers too much of the id for the match to mean anything.
 */
const MIN_EDIT_QUERY = 6

/**
 * Minimum containment ratio for the first fuzzy tier.
 *
 * The ratio is `shorter / longer` of the two normalized ids. A value near 1 means
 * one id is the other plus a small tag (`-sg`, `-vision`), which is the case this
 * tier exists for. A small value means they merely share a stem — `echo` inside
 * `echo-supported` is 0.29 and names a different model — so it must not price.
 * `echo-cc` vs `echo` is 0.67, still a different model, hence the tight floor.
 */
const MIN_CONTAINMENT_RATIO = 0.75

/**
 * Distinguishing suffixes that mark a *different* model rather than a variant of
 * the same one. When the only difference between the query and a candidate is one
 * of these tags on either side, the fuzzy tiers refuse: `space-bunny-alpha` is not
 * `space-bunny-free`, and `deepseek-v4-flash` is not `deepseek-v4-flash-vision`.
 *
 * Region and packaging tags (`sg`, `us`, `latest`, `free`, `preview`) are NOT
 * listed: those really do name the same model at a different location or tier.
 */
const DISTINCT_VARIANT_TAGS = new Set([
  'alpha',
  'beta',
  'rc',
  'canary',
  'nightly',
  'mini',
  'nano',
  'lite',
  'pro',
  'max',
  'plus',
  'turbo',
  'vision',
  'thinking',
  'reasoning',
  'instruct',
  'chat',
  'code',
  'coder',
  'cc',
  'an',
  'supported',
  'unsupported',
  'echo',
])

/**
 * Built-in provider alias table, mapping a DSH provider id to a models.dev
 * provider id. Case-insensitive; extend it with `config.providerAliases`.
 *
 * @type {Readonly<Record<string, string>>}
 */
const DEFAULT_PROVIDER_ALIASES = Object.freeze({
  // Magpie fronts DeepSeek models.
  magpie: 'deepseek',
  // The WorkBuddy endpoint also serves DeepSeek models.
  workbuddy: 'deepseek',
  // OpenAI-compatible gateways.
  owlapi: 'openai',
  'openai-codex': 'openai',
  // CMDC is another DeepSeek-compatible relay.
  cmdc: 'deepseek',
})

/**
 * Built-in **model-name** alias table: a normalized model id → the canonical
 * `{ provider, model }` that must price it.
 *
 * Keys are compared after {@link normalizeModelId}, so a vendor prefix
 * (`workbuddy-ai/deepseek-v4.1-flash`), a separator style (`deepseek_v4.1_flash`)
 * or a packaging suffix (`:free`) all reach the same key. This runs right after
 * custom prices and ahead of every models.dev lookup, because the point is that
 * these spellings are the *same* model and must not be priced off whichever
 * reseller happens to list them (a reseller may carry a markup, or a different
 * cache-read rate).
 *
 * Extend it with `config.modelAliases` (`{ normalizedId: 'provider/model' }`).
 *
 * @type {Readonly<Record<string, { provider: string, model: string }>>}
 */
const DEFAULT_MODEL_ALIASES = Object.freeze({
  // DeepSeek Flash, however a route spells it. `deepseek-flash` is the official
  // models.dev id; `deepseek-v4.1-flash` is the version-stamped name Magpie, CMDC
  // and the WorkBuddy endpoints report for the same model.
  deepseekflash: { provider: 'deepseek', model: 'deepseek-flash' },
  deepseekv41flash: { provider: 'deepseek', model: 'deepseek-flash' },
})

/**
 * Create the pricing service.
 *
 * @param {object} options Service options.
 * @param {string} options.home Harness home; the cache is
 *   `<home>/token-diet/prices.v1.json`.
 * @param {{ warn?: (...args: any[]) => void, error?: (...args: any[]) => void }} [options.logger]
 *   Sink for degraded-path reports.
 * @param {{ refreshMs?: number, fuzzy?: boolean, providerAliases?: Record<string, string> }} [options.config]
 *   `refreshMs` overrides the 24 h TTL, `fuzzy: false` disables the inexact
 *   fallback, `providerAliases` extends the built-in table.
 * @param {typeof fetch} [options.fetchImpl] Injectable fetch (tests / showcase).
 * @returns {{
 *   init: () => Promise<void>,
 *   meta: () => { source: 'models.dev'|'cache'|'none', fetchedAt: string|null, refreshing: boolean, error?: string },
 *   refresh: (force?: boolean) => Promise<{ source: 'models.dev'|'cache'|'none', fetchedAt: string|null, refreshing: boolean, error?: string }>,
 *   resolve: (provider: string, model: string) => ({ price: {input:number,output:number,cacheRead:number,cacheWrite:number}, source: 'models.dev'|'custom', confidence: 'exact'|'model-alias'|'alias'|'cross-provider'|'fuzzy'|'custom', matchedProvider: string, matchedModel: string } | null),
 *   suggestions: (provider: string, model: string, limit?: number) => Array<{ provider: string, model: string, confidence: string, score: number }>,
 *   setCustom: (provider: string, model: string, price: {input:number,output:number,cacheRead?:number,cacheWrite?:number} | null) => Promise<void>,
 *   custom: () => Array<{ provider: string, model: string, price: {input:number,output:number,cacheRead:number,cacheWrite:number} }>,
 * }}
 */
export function createPricingService({ home, logger, config, fetchImpl } = {}) {
  const refreshMs = positive(config?.refreshMs, DEFAULT_REFRESH_MS)
  const fuzzyEnabled = config?.fuzzy !== false
  const aliases = buildAliasTable(config?.providerAliases)
  const modelAliases = buildModelAliasTable(config?.modelAliases)
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch

  const store = createJsonStore({
    file: typeof home === 'string' && home.length > 0 ? join(home, 'token-diet', 'prices.v1.json') : null,
    logger,
    defaults: () => ({}),
  })

  /**
   * Compact models.dev table.
   *
   * `providers` maps a models.dev provider id to its display name and a model →
   * price map; `normalized` maps a normalized model id to every `(provider,
   * model)` that normalizes to it. Both are `Map`s so iteration order is stable
   * and a provider sort is cheap.
   *
   * @type {{
   *   fetchedAt: string | null,
   *   providers: Map<string, { name: string, models: Map<string, import('../shared/billing.js').Price> }>,
   *   normalized: Map<string, Array<{ provider: string, model: string }>>,
   * }}
   */
  const table = { fetchedAt: null, providers: new Map(), normalized: new Map() }

  /** Custom prices keyed `"<provider>/<model>"`, exactly as persisted. */
  const customPrices = new Map()
  /** Where the table came from in this process. */
  let origin = 'none'
  /** Last refresh failure, surfaced through `meta()`. */
  let lastError = null
  /** Whether a refresh is in flight. */
  let refreshing = false
  /** Deduped in-flight refresh. */
  let inFlight = null

  /* ------------------------------------------------------------------ loading */

  /**
   * Fold a parsed models.dev payload into the compact table in place.
   *
   * Accepts both the live shape
   * (`{ [pid]: { name, models: { [mid]: { cost } } } }`) and the compact cache
   * shape written by `serialize`, so one function serves both.
   *
   * @param {any} payload Parsed models.dev JSON or a cache payload.
   * @param {string} [fetchedAt] Timestamp to record; a cache payload supplies its own.
   * @returns {void}
   */
  function adopt(payload, fetchedAt) {
    const providers = new Map()
    const normalized = new Map()
    const record = payload !== null && typeof payload === 'object' ? payload : {}
    for (const [providerId, value] of Object.entries(record)) {
      if (providerId === 'fetchedAt' || providerId === 'custom' || providerId === 'providers') continue
      if (value === null || typeof value !== 'object') continue
      const models = new Map()
      const modelSource = value.models !== null && typeof value.models === 'object' ? value.models : null
      if (modelSource === null) continue
      for (const [modelId, modelValue] of Object.entries(modelSource)) {
        const price = priceOfModel(modelValue)
        if (price === null) continue
        models.set(modelId, price)
        const key = normalizeModelId(modelId)
        if (key === '') continue
        const bucket = normalized.get(key) ?? []
        bucket.push({ provider: providerId, model: modelId })
        normalized.set(key, bucket)
      }
      if (models.size === 0) continue
      const name = typeof value.name === 'string' && value.name.length > 0 ? value.name : providerId
      providers.set(providerId, { name, models })
    }
    table.providers = providers
    table.normalized = normalized
    table.fetchedAt = typeof fetchedAt === 'string' ? fetchedAt : null
  }

  /**
   * Load the cache file into memory.
   *
   * @returns {Promise<void>} Resolves even when the file is missing or corrupt.
   */
  async function loadCache() {
    const payload = await store.load()
    if (payload === null || typeof payload !== 'object') return
    if (payload.custom !== null && typeof payload.custom === 'object') {
      for (const [key, value] of Object.entries(payload.custom)) {
        const price = normalizePrice(value)
        customPrices.set(key, price)
      }
    }
    if (payload.providers !== null && typeof payload.providers === 'object') {
      adopt(payload.providers, payload.fetchedAt)
      if (table.providers.size > 0) {
        origin = 'cache'
        table.fetchedAt = typeof payload.fetchedAt === 'string' ? payload.fetchedAt : null
      }
    }
  }

  /**
   * Build the on-disk payload: compact providers plus the custom price map.
   *
   * @returns {{ fetchedAt?: string, providers: Record<string, any>, custom: Record<string, any> }} Serializable cache.
   */
  function serialize() {
    const providers = {}
    for (const [providerId, entry] of table.providers) {
      const models = {}
      for (const [modelId, price] of entry.models) {
        models[modelId] = {
          cost: {
            input: price.input,
            output: price.output,
            cache_read: price.cacheRead,
            cache_write: price.cacheWrite,
          },
        }
      }
      providers[providerId] = { name: entry.name, models }
    }
    const custom = {}
    for (const [key, price] of customPrices) custom[key] = { ...price }
    return {
      ...(table.fetchedAt === null ? {} : { fetchedAt: table.fetchedAt }),
      providers,
      custom,
    }
  }

  /* ---------------------------------------------------------------- networking */

  /**
   * Fetch and adopt models.dev's table.
   *
   * @returns {Promise<string | null>} The new `fetchedAt` on success, or `null`.
   */
  async function fetchTable() {
    let json
    try {
      const response = await doFetch(MODELS_DEV_URL, {
        redirect: 'follow',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (response === null || typeof response !== 'object' || !response.ok) {
        throw new Error(`models.dev returned HTTP ${response?.status ?? 'no response'}`)
      }
      json = await readJsonBody(response)
    } catch (error) {
      fail(`models.dev fetch failed: ${describe(error)}`)
      return null
    }
    if (json === null || typeof json !== 'object') {
      fail('models.dev payload is not a JSON object')
      return null
    }
    adopt(json, undefined)
    if (table.providers.size === 0) {
      fail('models.dev payload contained no priced models')
      return null
    }
    table.fetchedAt = new Date().toISOString()
    origin = 'models.dev'
    return table.fetchedAt
  }

  /**
   * Record a refresh failure and keep the previous table.
   *
   * @param {string} message Human-readable diagnostic.
   */
  function fail(message) {
    lastError = message
    try {
      logger?.warn?.(`[token-diet] ${message}`)
    } catch {
      /* logging must never break the service */
    }
  }

  /* --------------------------------------------------------------- lifecycle */

  /**
   * Load the cache and refresh when it is missing or older than the TTL.
   *
   * Never throws and never blocks on a broken cache or a dead network.
   *
   * @returns {Promise<void>} Resolves after the first attempt.
   */
  async function init() {
    try {
      await loadCache()
    } catch (error) {
      fail(`price cache load failed: ${describe(error)}`)
    }
    try {
      await refresh(false)
    } catch (error) {
      // `refresh` is written not to reject; this is belt and braces.
      fail(`price refresh failed: ${describe(error)}`)
    }
  }

  /**
   * Whether the cached table is still inside the TTL.
   *
   * @returns {boolean} `true` when a refresh can be skipped.
   */
  function fresh() {
    if (table.fetchedAt === null) return false
    const age = Date.now() - Date.parse(table.fetchedAt)
    return Number.isFinite(age) && age >= 0 && age < refreshMs
  }

  /**
   * Refresh the models.dev table.
   *
   * Concurrent calls share one request. A failed refresh keeps the previous
   * table and reports through `meta().error`.
   *
   * @param {boolean} [force] Ignore the TTL.
   * @returns {Promise<{ source: 'models.dev'|'cache'|'none', fetchedAt: string|null, refreshing: boolean, error?: string }>}
   *   The metadata after the attempt.
   */
  async function refresh(force = false) {
    if (!force && fresh()) return meta()
    if (inFlight !== null) return inFlight
    inFlight = (async () => {
      refreshing = true
      try {
        const fetchedAt = await fetchTable()
        if (fetchedAt !== null) {
          lastError = null
          await saveCache()
        }
        return meta()
      } catch (error) {
        fail(`price refresh failed: ${describe(error)}`)
        return meta()
      } finally {
        refreshing = false
      }
    })()
    try {
      return await inFlight
    } finally {
      inFlight = null
    }
  }

  /**
   * Persist the compact table plus custom prices.
   *
   * @returns {Promise<void>} Resolves after the write attempt.
   */
  async function saveCache() {
    try {
      await store.save(serialize())
    } catch (error) {
      fail(`price cache save failed: ${describe(error)}`)
    }
  }

  /**
   * Metadata for the price tables panel.
   *
   * @returns {{ source: 'models.dev'|'cache'|'none', fetchedAt: string|null, refreshing: boolean, error?: string }}
   *   `source` distinguishes a table fetched this run from one restored from disk.
   */
  function meta() {
    const base = {
      source: origin,
      fetchedAt: table.fetchedAt,
      refreshing,
    }
    return lastError === null ? base : { ...base, error: lastError }
  }

  /* ---------------------------------------------------------------- resolving */

  /**
   * Resolve the price of one `(provider, model)` pair, synchronously.
   *
   * @param {string} provider Provider id exactly as the session logged it.
   * @param {string} model Model id exactly as the session logged it.
   * @returns {{ price: { input: number, output: number, cacheRead: number, cacheWrite: number }, source: 'models.dev'|'custom', confidence: 'exact'|'model-alias'|'alias'|'cross-provider'|'fuzzy'|'custom', matchedProvider: string, matchedModel: string } | null}
   *   A resolution, or `null` when no price could be found.
   */
  function resolve(provider, model) {
    const providerId = typeof provider === 'string' ? provider : ''
    const modelId = typeof model === 'string' ? model : ''
    if (modelId.length === 0) return null

    // 1. Custom price: exact on the persisted `"<provider>/<model>"` key.
    const custom = customPrices.get(`${providerId}/${modelId}`)
    if (custom !== undefined) {
      return {
        price: custom,
        source: 'custom',
        confidence: 'custom',
        matchedProvider: providerId,
        matchedModel: modelId,
      }
    }

    // 2. Model-name alias: a canonical mapping declared for this model id. It
    // outranks every models.dev lookup so a reseller listing the same model under
    // its own id/price cannot change what the user pays for it.
    const canonical = modelAliasOf(modelId)
    if (canonical !== null) {
      const target = lookup(canonical.provider, canonical.model)
      if (target !== null) return resolutionOf(target, 'model-alias')
      // The canonical id is not in the current table (models.dev renamed or
      // removed it): fall through to the generic matching below rather than
      // reporting a price we cannot justify.
    }

    // 3. Exact provider id + model id.
    const direct = lookup(providerId, modelId)
    if (direct !== null) return resolutionOf(direct, 'exact')

    // 4. Provider alias, then exact model id under the aliased provider.
    const aliased = aliasOf(providerId)
    if (aliased !== null && aliased !== providerId) {
      const viaAlias = lookup(aliased, modelId)
      if (viaAlias !== null) return resolutionOf(viaAlias, 'alias')
    }

    // 5. The same model id under any other provider, in stable provider order.
    const cross = crossProvider(modelId)
    if (cross !== null) return resolutionOf(cross, 'cross-provider')

    // 6. Normalized fuzzy match, only when unambiguous.
    if (!fuzzyEnabled) return null
    const fuzzy = fuzzyMatch(modelId)
    return fuzzy === null ? null : resolutionOf(fuzzy, 'fuzzy')
  }

  /**
   * Exact `(provider, model)` table lookup.
   *
   * Provider ids are lowercase in models.dev, so a case-insensitive retry covers
   * a composition that passes `DeepSeek`. The model id is never case-folded here.
   *
   * @param {string} provider Provider id.
   * @param {string} model Model id.
   * @returns {{ provider: string, model: string, price: any } | null} The hit.
   */
  function lookup(provider, model) {
    const entry = table.providers.get(provider) ?? table.providers.get(provider.toLowerCase())
    if (entry === undefined) return null
    const price = entry.models.get(model)
    if (price === undefined) return null
    return { provider: table.providers.has(provider) ? provider : provider.toLowerCase(), model, price }
  }

  /**
   * Map a provider id through the alias table (built-ins, config, `deepseek-*`).
   *
   * @param {string} provider Provider id as logged.
   * @returns {string | null} The models.dev provider id, or `null`.
   */
  function aliasOf(provider) {
    if (typeof provider !== 'string' || provider.length === 0) return null
    const key = provider.toLowerCase()
    const mapped = aliases.get(key)
    if (mapped !== undefined) return mapped
    // `deepseek-official`, `deepseek-r1-endpoint`, … all front DeepSeek models.
    if (/^deepseek[-_]/.test(key)) return 'deepseek'
    return null
  }

  /**
   * The canonical `{ provider, model }` declared for one model id, or `null`.
   *
   * The lookup is by {@link normalizeModelId}, so every spelling of the same model
   * — `workbuddy-ai/deepseek-v4.1-flash`, `deepseek-v4.1-flash`,
   * `deepseek_v4.1_flash:free` — reaches one key.
   *
   * @param {string} model Raw model id from a session event.
   * @returns {{ provider: string, model: string } | null}
   */
  function modelAliasOf(model) {
    if (modelAliases.size === 0) return null
    const key = normalizeModelId(model)
    if (key.length === 0) return null
    return modelAliases.get(key) ?? null
  }

  /**
   * Find a model id under any provider, choosing a stable provider order.
   *
   * @param {string} model Model id.
   * @returns {{ provider: string, model: string, price: any } | null} The first hit.
   */
  function crossProvider(model) {
    const providers = [...table.providers.keys()].sort(compareStrings)
    for (const providerId of providers) {
      const price = table.providers.get(providerId).models.get(model)
      if (price !== undefined) return { provider: providerId, model, price }
    }
    return null
  }

  /**
   * Conservative two-tier fuzzy match.
   *
   * Tier 1 (highest confidence) is normalized substring containment, which is
   * exact and explainable. Tier 2 is a *bounded* edit distance for the very common
   * case where a gateway renames a model (`workbuddy-ai/deepseek-v4.1-flash` vs
   * models.dev's `deepseek-v4-flash`): one character apart, obviously the same
   * model. Both tiers resolve to `confidence: 'fuzzy'`, which the client badges as
   * an inexact match, so a guess is never presented as a fact.
   *
   * @param {string} model Model id as logged.
   * @returns {{ provider: string, model: string, price: any } | null} The single best hit.
   */
  function fuzzyMatch(model) {
    // A 1–2 character id cannot be matched responsibly.
    if (model.trim().length <= 2) return null
    const query = normalizeModelId(model)
    if (query === '') return null

    const containment = bestContainmentCandidate(query)
    if (containment !== null) return hitOf(containment.candidate)

    const edit = bestEditCandidate(query)
    return edit === null ? null : hitOf(edit.candidate)
  }

  /**
   * Tier 1: the tightest candidate that contains (or is contained by) the query.
   *
   * The score is the containment ratio, which prefers the tightest candidate
   * (`gpt4o` over `gpt4o-mini` for the query `gpt4`). Two *different* normalized
   * model ids sharing the winning score is genuinely ambiguous and yields no
   * match; the same id under several providers is not.
   *
   * A containment floor keeps this tier from matching on a shared stem alone:
   * `echo-supported` contains `echo`, but 4/14 of the id is not evidence that they
   * name the same model. The shorter side must be at least
   * {@link MIN_CONTAINMENT_RATIO} of the longer one, so
   * `deepseek-v4.1-flash-sg` vs `deepseek-v4.1-flash` (0.9) still matches while
   * `echo` vs `echo-supported` (0.29) does not.
   *
   * @param {string} query Normalized query.
   * @returns {{ candidate: { provider: string, model: string }, score: number } | null} Unique best.
   */
  function bestContainmentCandidate(query) {
    let best = null
    for (const [key, candidates] of table.normalized) {
      const score = containmentScore(query, key)
      if (score === null || score < MIN_CONTAINMENT_RATIO) continue
      const candidate = pickProvider(candidates)
      // Sharing a stem is not enough when the extra segment is a variant tag.
      if (differsByVariantTag(query, candidate.model)) continue
      if (best === null || score > best.score) {
        best = { key, score, candidate }
      } else if (score === best.score && key !== best.key) {
        // A different model id scoring identically: refuse to guess.
        best = { ...best, ambiguous: true }
      }
    }
    return best === null || best.ambiguous === true ? null : best
  }

  /**
   * Tier 2: a bounded Levenshtein match, rejecting ambiguous families.
   *
   * `maxDistance` is `max(1, floor(len / 10))`, so an 8-character id tolerates one
   * edit and a 20-character id two. Queries shorter than {@link MIN_EDIT_QUERY}
   * never take this path: a short id is within a couple of edits of everything.
   *
   * Ambiguity: **exactly one distinct normalized model id** may fall inside the
   * edit budget. Two ids at the minimum distance is a tie (no match); a runner-up
   * that is still inside the budget is an ambiguous family (no match either), so
   * `gpt-4o` can never be guessed as `gpt-4o-mini`. Several providers exposing
   * the *same* model id are not ambiguous — the provider is chosen by
   * {@link pickProvider}.
   *
   * @param {string} query Normalized query.
   * @returns {{ candidate: { provider: string, model: string }, score: number } | null} Unique best;
   *   `score` is the edit distance (lower is better).
   */
  function bestEditCandidate(query) {
    if (query.length < MIN_EDIT_QUERY) return null
    const maxDistance = Math.max(1, Math.floor(query.length / 10))
    /** @type {Map<string, { distance: number, candidates: Array<{ provider: string, model: string }> }>} */
    const within = new Map()
    for (const [key, candidates] of table.normalized) {
      // Cheap pre-filter: a length gap wider than the budget cannot be bridged.
      if (Math.abs(key.length - query.length) > maxDistance) continue
      const distance = boundedLevenshtein(query, key, maxDistance)
      if (distance === null) continue
      within.set(key, { distance, candidates })
    }
    if (within.size !== 1) return null // no candidate, or an ambiguous family
    const [entry] = [...within.values()]
    const candidate = pickProvider(entry.candidates)
    // A one-edit difference that flips a variant tag names a different model
    // (`space-bunny-alpha` vs `space-bunny-free`, `echo` vs `echo-cc`).
    if (differsByVariantTag(query, candidate.model)) return null
    return { candidate, score: entry.distance }
  }

  /**
   * Choose one provider when several expose the identical model id.
   *
   * The alias target wins (a `magpie` model is reported under `deepseek`), then
   * the lexicographically first provider id, so the result is stable across runs.
   *
   * @param {Array<{ provider: string, model: string }>} candidates Same-model hits.
   * @returns {{ provider: string, model: string }} The chosen candidate.
   */
  function pickProvider(candidates) {
    const sorted = [...candidates].sort(
      (a, b) => rankProvider(a.provider) - rankProvider(b.provider) || compareStrings(a.provider, b.provider),
    )
    return sorted[0]
  }

  /**
   * Prefer providers that are alias targets over accidental resellers.
   *
   * @param {string} provider models.dev provider id.
   * @returns {number} Sort rank; `0` for an alias target, `1` otherwise.
   */
  function rankProvider(provider) {
    for (const target of aliases.values()) {
      if (target === provider) return 0
    }
    return 1
  }

  /**
   * Wrap a candidate in a table hit.
   *
   * @param {{ provider: string, model: string } | null} candidate Chosen candidate.
   * @returns {{ provider: string, model: string, price: any } | null} The hit, or `null`.
   */
  function hitOf(candidate) {
    if (candidate === null) return null
    const price = table.providers.get(candidate.provider)?.models.get(candidate.model)
    if (price === undefined) return null
    return { provider: candidate.provider, model: candidate.model, price }
  }

  /* -------------------------------------------------------------- suggestions */

  /**
   * Candidate prices for the "add price" dialog.
   *
   * Exact model-id hits across providers come first (they are facts), then fuzzy
   * candidates (containment, then bounded edit distance) that the user confirms.
   *
   * **`score` is lower-is-better**: `0` for an exact id hit and the edit distance
   * (or a fractional penalty derived from the containment ratio) otherwise. The
   * list is sorted by `score` ascending.
   *
   * @param {string} provider The provider id that had no price.
   * @param {string} model The model id that had no price.
   * @param {number} [limit] Maximum number of candidates; defaults to 3.
   * @returns {Array<{ provider: string, model: string, confidence: 'exact'|'cross-provider'|'fuzzy', score: number }>}
   *   Best-first candidates; empty when nothing plausible exists.
   */
  function suggestions(provider, model, limit = 3) {
    const max = Number.isSafeInteger(limit) && limit > 0 ? limit : 3
    const providerId = typeof provider === 'string' ? provider : ''
    const modelId = typeof model === 'string' ? model : ''
    if (modelId.length === 0) return []
    const seen = new Set()
    const candidates = []

    /** Record one candidate once, keeping the best (lowest) score it ever got. */
    const remember = (candidate, confidence, score) => {
      const key = `${candidate.provider}\u0000${candidate.model}`
      const existing = seen.has(key) ? candidates.find((entry) => entry.key === key) : undefined
      if (existing !== undefined) {
        if (score < existing.score) {
          existing.score = score
          existing.confidence = confidence
        }
        return
      }
      seen.add(key)
      candidates.push({ key, provider: candidate.provider, model: candidate.model, confidence, score })
    }

    for (const candidate of crossProviderCandidates(modelId)) {
      remember(candidate, candidate.provider === providerId ? 'exact' : 'cross-provider', 0)
    }

    if (fuzzyEnabled) {
      const query = normalizeModelId(modelId)
      if (query !== '') {
        for (const [key, group] of table.normalized) {
          const containment = containmentScore(query, key)
          if (containment !== null && containment >= MIN_CONTAINMENT_RATIO) {
            // Map (0, 1] onto (0, 1]: 1.0 is a perfect containment, closer is better.
            remember(pickProvider(group), 'fuzzy', 1 - containment + 0.001)
            continue
          }
          if (query.length < MIN_EDIT_QUERY) continue
          if (Math.abs(key.length - query.length) > Math.max(1, Math.floor(query.length / 10))) continue
          const distance = boundedLevenshtein(query, key, Math.max(1, Math.floor(query.length / 10)))
          if (distance === null) continue
          // Edit distance dominates the ordering; the small offset keeps a
          // containment hit strictly ahead of an equally distant edit hit.
          remember(pickProvider(group), 'fuzzy', 1 + distance)
        }
      }
    }

    candidates.sort(
      (a, b) =>
        a.score - b.score ||
        compareStrings(a.provider, b.provider) ||
        compareStrings(a.model, b.model),
    )
    return candidates.slice(0, max).map(({ key, ...rest }) => {
      void key
      return rest
    })
  }

  /**
   * Every provider exposing one exact model id, in stable provider order.
   *
   * @param {string} model Model id.
   * @returns {Array<{ provider: string, model: string }>} Hits.
   */
  function crossProviderCandidates(model) {
    const out = []
    for (const providerId of [...table.providers.keys()].sort(compareStrings)) {
      if (table.providers.get(providerId).models.has(model)) out.push({ provider: providerId, model })
    }
    return out
  }

  /* ------------------------------------------------------------ custom prices */

  /**
   * Persist or remove one custom price.
   *
   * The in-memory table is updated before the await, so a `resolve` right after
   * the call already sees the new price.
   *
   * @param {string} provider Provider id.
   * @param {string} model Model id.
   * @param {{ input: number, output: number, cacheRead?: number, cacheWrite?: number } | null} price
   *   All four rates per million USD; omitted cache rates default to `input`.
   *   `null` removes the entry.
   * @returns {Promise<void>} Resolves after the write attempt.
   */
  async function setCustom(provider, model, price) {
    const providerId = typeof provider === 'string' ? provider.trim() : ''
    const modelId = typeof model === 'string' ? model.trim() : ''
    if (providerId.length === 0 || modelId.length === 0) {
      fail('setCustom needs a non-empty provider and model')
      return
    }
    const key = `${providerId}/${modelId}`
    if (price === null || price === undefined) {
      customPrices.delete(key)
    } else {
      customPrices.set(key, normalizePrice(price))
    }
    await saveCache()
  }

  /**
   * Every custom price, sorted by provider then model.
   *
   * @returns {Array<{ provider: string, model: string, price: { input: number, output: number, cacheRead: number, cacheWrite: number } }>}
   *   Custom prices for the settings table.
   */
  function custom() {
    const rows = []
    for (const [key, price] of customPrices) {
      const cut = key.indexOf('/')
      if (cut <= 0) continue
      rows.push({ provider: key.slice(0, cut), model: key.slice(cut + 1), price })
    }
    rows.sort((a, b) => compareStrings(a.provider, b.provider) || compareStrings(a.model, b.model))
    return rows
  }

  return {
    init,
    meta,
    refresh,
    resolve,
    suggestions,
    setCustom,
    custom,
  }

  /**
   * Wrap a table hit in the public `PriceResolution` shape.
   *
   * @param {{ provider: string, model: string, price: any }} hit Table hit.
   * @param {'exact'|'alias'|'cross-provider'|'fuzzy'} confidence How it was found.
   * @returns {{ price: any, source: 'models.dev', confidence: string, matchedProvider: string, matchedModel: string }}
   *   The resolution.
   */
  function resolutionOf(hit, confidence) {
    return {
      price: hit.price,
      source: 'models.dev',
      confidence,
      matchedProvider: hit.provider,
      matchedModel: hit.model,
    }
  }
}

/**
 * Read a JSON body from a fetch response.
 *
 * Prefers `text()` + `JSON.parse` so the raw string can be dropped immediately
 * after the fold (models.dev's payload is several megabytes), and falls back to
 * `json()` for response objects that only implement it — the DSH connection
 * wrapper and test doubles both do.
 *
 * @param {{ text?: () => Promise<string>, json?: () => Promise<any> }} response Fetch response.
 * @returns {Promise<any>} The parsed payload.
 */
async function readJsonBody(response) {
  if (typeof response.text === 'function') {
    const text = await response.text()
    return JSON.parse(text)
  }
  if (typeof response.json === 'function') return await response.json()
  throw new Error('response has neither text() nor json()')
}

/* ------------------------------------------------------------------ helpers */

/**
 * Convert one models.dev model record into a normalized price.
 *
 * @param {any} model Either `{ cost: { input, output, cache_read, cache_write } }`
 *   or a bare cost object.
 * @returns {{ input: number, output: number, cacheRead: number, cacheWrite: number } | null}
 *   The price, or `null` when the record carries no usable cost.
 */
function priceOfModel(model) {
  if (model === null || typeof model !== 'object') return null
  const cost = model.cost !== null && typeof model.cost === 'object' ? model.cost : model
  const input = finite(cost.input)
  const output = finite(cost.output)
  // A model without input or output pricing cannot be billed; leaving it out of
  // the table makes it show up as "missing price" instead of as a fake zero.
  if (input === null && output === null) return null
  const normalized = normalizePrice({
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: finite(cost.cache_read) ?? finite(cost.cacheRead) ?? undefined,
    cacheWrite: finite(cost.cache_write) ?? finite(cost.cacheWrite) ?? undefined,
  })
  return normalized
}

/**
 * Normalize a model id for inexact matching.
 *
 * Lowercase; drop a leading `<vendor>/` segment; strip a `:free` / `:latest`
 * style tag; drop trailing noise tokens; collapse `[._\-\s]+` by removing them.
 *
 * @param {string} id Raw model id.
 * @returns {string} The normalized id (`''` when nothing is left).
 */
function normalizeModelId(id) {
  if (typeof id !== 'string') return ''
  let value = id.trim().toLowerCase()
  if (value === '') return ''
  value = value.replace(SUFFIX_TAG, '')
  // Drop everything up to and including the last `/` (a vendor or routing prefix).
  const slash = value.lastIndexOf('/')
  if (slash >= 0 && slash < value.length - 1) value = value.slice(slash + 1)
  const tokens = value.split(/[._\-\s]+/).filter((token) => token.length > 0)
  while (tokens.length > 1 && TAIL_TOKENS.has(tokens[tokens.length - 1])) tokens.pop()
  return tokens.join('')
}

/**
 * Containment score of one normalized candidate for one normalized query.
 *
 * @param {string} query Normalized query.
 * @param {string} candidate Normalized candidate.
 * @returns {number | null} Ratio in `(0, 1]` (higher is better), or `null` when
 *   neither contains the other.
 */
function containmentScore(query, candidate) {
  if (query.length === 0 || candidate.length === 0) return null
  if (candidate === query) return 1
  if (candidate.includes(query)) return query.length / candidate.length
  if (query.includes(candidate)) return candidate.length / query.length
  return null
}

/**
 * Whether two model ids differ only by a tag that marks a *different* variant.
 *
 * Both ids are tokenized the same way as {@link normalizeModelId}. When the token
 * lists are equal except for one extra token, and that token is a
 * {@link DISTINCT_VARIANT_TAGS} entry on either side, the two ids name different
 * models and must not share a price. Region and packaging tags are absent from
 * that set, so `deepseek-v4.1-flash` and `deepseek-v4.1-flash-sg` still agree.
 *
 * @param {string} queryId The queried model id (raw).
 * @param {string} candidateId The candidate model id (raw).
 * @returns {boolean} True when the difference is a distinguishing variant tag.
 */
function differsByVariantTag(queryId, candidateId) {
  const left = tokenizeModelId(queryId)
  const right = tokenizeModelId(candidateId)
  if (left.length === 0 || right.length === 0) return false

  let extra = null
  if (left.length === right.length) {
    // Same length: only a same-position substitution can be a variant flip.
    const differing = []
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) differing.push([left[index], right[index]])
    }
    if (differing.length !== 1) return false
    const [pair] = differing
    return DISTINCT_VARIANT_TAGS.has(pair[0]) || DISTINCT_VARIANT_TAGS.has(pair[1])
  }

  // Different length: one side must be the other plus exactly one token.
  const [shorter, longer] = left.length < right.length ? [left, right] : [right, left]
  if (longer.length !== shorter.length + 1) return false
  for (let index = 0; index < longer.length; index += 1) {
    const without = longer.slice(0, index).concat(longer.slice(index + 1))
    if (without.join('\u0000') === shorter.join('\u0000')) {
      extra = longer[index]
      break
    }
  }
  if (extra === null) return false
  return DISTINCT_VARIANT_TAGS.has(extra)
}

/**
 * Split a model id into its comparable tokens: vendor prefix dropped, known
 * packaging suffixes dropped, separators collapsed away.
 *
 * @param {string} id Raw model id.
 * @returns {string[]} Lowercase tokens, possibly empty.
 */
function tokenizeModelId(id) {
  if (typeof id !== 'string') return []
  let value = id.trim().toLowerCase()
  if (value === '') return []
  value = value.replace(SUFFIX_TAG, '')
  const slash = value.lastIndexOf('/')
  if (slash >= 0 && slash < value.length - 1) value = value.slice(slash + 1)
  return value.split(/[._\-\s]+/).filter((token) => token.length > 0)
}

/**
 * Levenshtein distance capped at `limit`.
 *
 * Returns `null` when the distance exceeds `limit`. The caller pre-filters on
 * `|length difference| > limit` (a necessary condition), so only a handful of
 * candidates reach the full dynamic program; two rolling rows keep it allocation
 * light. This runs only when exact, alias and cross-provider lookups have all
 * missed, i.e. a few times per model at most.
 *
 * @param {string} left First string.
 * @param {string} right Second string.
 * @param {number} limit Maximum distance of interest.
 * @returns {number | null} The distance when `<= limit`, else `null`.
 */
function boundedLevenshtein(left, right, limit) {
  if (left === right) return 0
  if (Math.abs(left.length - right.length) > limit) return null
  const width = right.length + 1
  let previous = new Array(width)
  let current = new Array(width)
  for (let column = 0; column < width; column += 1) previous[column] = column
  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row
    for (let column = 1; column < width; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1
      current[column] = Math.min(previous[column - 1] + cost, previous[column] + 1, current[column - 1] + 1)
    }
    const swap = previous
    previous = current
    current = swap
  }
  const distance = previous[right.length]
  return distance <= limit ? distance : null
}

/**
 * Build the effective alias table: built-ins, then config overrides.
 *
 * @param {Record<string, string> | undefined} overrides Extra aliases.
 * @returns {Map<string, string>} Lowercased source id → models.dev provider id.
 */
function buildAliasTable(overrides) {
  const map = new Map()
  for (const [from, to] of Object.entries(DEFAULT_PROVIDER_ALIASES)) map.set(from.toLowerCase(), to)
  if (overrides !== null && typeof overrides === 'object') {
    for (const [from, to] of Object.entries(overrides)) {
      if (typeof from !== 'string' || typeof to !== 'string' || to.length === 0) continue
      map.set(from.toLowerCase(), to.toLowerCase())
    }
  }
  return map
}

/**
 * Build the effective model-name alias table.
 *
 * Built-ins first, then `config.modelAliases`. An override value may be either
 * `'provider/model'` or `{ provider, model }`; an entry whose target cannot be
 * read is ignored rather than guessing. Override keys are normalized too, so a
 * config written as `{ 'deepseek-v4.1-flash': 'deepseek/deepseek-flash' }` works.
 *
 * @param {Record<string, string | { provider?: string, model?: string }> | undefined} overrides
 * @returns {Map<string, { provider: string, model: string }>} Normalized id → target.
 */
function buildModelAliasTable(overrides) {
  const map = new Map()
  for (const [from, to] of Object.entries(DEFAULT_MODEL_ALIASES)) {
    map.set(normalizeModelId(from), { provider: to.provider, model: to.model })
  }
  if (overrides === null || typeof overrides !== 'object') return map
  for (const [from, raw] of Object.entries(overrides)) {
    if (typeof from !== 'string') continue
    const key = normalizeModelId(from)
    if (key.length === 0) continue
    let provider
    let model
    if (typeof raw === 'string') {
      const slash = raw.indexOf('/')
      if (slash <= 0 || slash === raw.length - 1) continue
      provider = raw.slice(0, slash)
      model = raw.slice(slash + 1)
    } else if (raw !== null && typeof raw === 'object') {
      if (typeof raw.provider !== 'string' || typeof raw.model !== 'string') continue
      provider = raw.provider
      model = raw.model
    } else {
      continue
    }
    if (provider.length === 0 || model.length === 0) continue
    map.set(key, { provider, model })
  }
  return map
}

/** Locale-independent string ordering used for stable provider order. */
function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

/** A finite number, or `null`. */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
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
