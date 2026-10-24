/**
 * Pure billing and aggregation functions shared by the host modules and the test suite.
 *
 * Nothing here performs I/O. Every exported function is deterministic so the test
 * suite can pin behaviour without a Harness.
 *
 * @module dsh-token-diet/lib/shared/billing
 */

/** An empty usage bucket. Never mutated; spread it before changing a field. */
export const ZERO_BUCKETS = Object.freeze({
  uncachedInput: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
})

/** Total tokens of one bucket, cell or totals object. */
export function tokensOf(buckets) {
  if (buckets === null || buckets === undefined) return 0
  return (
    (buckets.uncachedInput ?? 0) +
    (buckets.cacheRead ?? 0) +
    (buckets.cacheWrite ?? 0) +
    (buckets.output ?? 0)
  )
}

/** Cache hit ratio over the prompt side; `0` when the prompt side is empty. */
export function cacheHitRate(buckets) {
  const promptSide = (buckets?.uncachedInput ?? 0) + (buckets?.cacheRead ?? 0)
  if (promptSide <= 0) return 0
  return (buckets.cacheRead ?? 0) / promptSide
}

/**
 * Normalize one price so every rate is a finite non-negative number.
 * Cache read/write fall back to the input rate, as the plan specifies.
 */
export function normalizePrice(price) {
  const input = numberOr(price?.input, 0)
  return {
    input,
    output: numberOr(price?.output, 0),
    cacheRead: numberOr(price?.cacheRead, input),
    cacheWrite: numberOr(price?.cacheWrite, input),
  }
}

/** USD cost of one usage bucket at one price (USD per 1M tokens). */
export function costUsd(buckets, price) {
  const p = normalizePrice(price)
  return (
    ((buckets?.uncachedInput ?? 0) * p.input +
      (buckets?.cacheRead ?? 0) * p.cacheRead +
      (buckets?.cacheWrite ?? 0) * p.cacheWrite +
      (buckets?.output ?? 0) * p.output) /
    1_000_000
  )
}

/** Local `YYYY-MM-DD` for one epoch-millisecond timestamp. */
export function localDateKey(epochMs) {
  const date = new Date(epochMs)
  if (Number.isNaN(date.getTime())) return '1970-01-01'
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Every local date from `days` ago through today, ascending. */
export function dateRange(todayKey, days) {
  const [year, month, day] = todayKey.split('-').map(Number)
  const out = []
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(year, month - 1, day - offset)
    out.push(localDateKey(date.getTime()))
  }
  return out
}

/** Sum several buckets. */
export function addBuckets(left, right) {
  return {
    uncachedInput: (left?.uncachedInput ?? 0) + (right?.uncachedInput ?? 0),
    cacheRead: (left?.cacheRead ?? 0) + (right?.cacheRead ?? 0),
    cacheWrite: (left?.cacheWrite ?? 0) + (right?.cacheWrite ?? 0),
    output: (left?.output ?? 0) + (right?.output ?? 0),
  }
}

/**
 * Fold rows into totals, per day, per model and per workspace.
 *
 * @param rows Bucket rows.
 * @param priceOf `(provider, model) => { price, source, confidence } | null`.
 * @param options.dates Optional explicit day list so a trend keeps empty days.
 */
export function aggregate(rows, priceOf, options = {}) {
  const dates = options.dates ?? null
  const totals = { ...ZERO_BUCKETS, calls: 0, tokens: 0, costUsd: 0 }
  const byDay = new Map()
  const byModel = new Map()
  const byWorkspace = new Map()
  const missing = new Map()

  if (dates !== null) {
    for (const date of dates) byDay.set(date, { date, ...ZERO_BUCKETS, calls: 0, costUsd: 0 })
  }

  for (const row of rows) {
    const buckets = {
      uncachedInput: row.uncachedInput ?? 0,
      cacheRead: row.cacheRead ?? 0,
      cacheWrite: row.cacheWrite ?? 0,
      output: row.output ?? 0,
    }
    const tokens = tokensOf(buckets)
    const resolved = priceOf === undefined ? null : priceOf(row.provider, row.model)
    const cost = resolved === null ? null : costUsd(buckets, resolved.price)

    totals.uncachedInput += buckets.uncachedInput
    totals.cacheRead += buckets.cacheRead
    totals.cacheWrite += buckets.cacheWrite
    totals.output += buckets.output
    totals.calls += row.calls ?? 0
    totals.tokens += tokens
    if (cost !== null) totals.costUsd += cost

    const day = byDay.get(row.date) ?? { date: row.date, ...ZERO_BUCKETS, calls: 0, costUsd: 0 }
    day.uncachedInput += buckets.uncachedInput
    day.cacheRead += buckets.cacheRead
    day.cacheWrite += buckets.cacheWrite
    day.output += buckets.output
    day.calls += row.calls ?? 0
    if (cost !== null) day.costUsd += cost
    byDay.set(row.date, day)

    const modelKey = `${row.provider}\u0000${row.model}`
    const model =
      byModel.get(modelKey) ?? {
        provider: row.provider,
        model: row.model,
        calls: 0,
        uncachedInput: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        costUsd: 0,
        missing: resolved === null,
        source: resolved?.source ?? null,
        confidence: resolved?.confidence ?? null,
      }
    model.calls += row.calls ?? 0
    model.uncachedInput += buckets.uncachedInput
    model.cacheRead += buckets.cacheRead
    model.cacheWrite += buckets.cacheWrite
    model.output += buckets.output
    if (cost !== null) model.costUsd += cost
    byModel.set(modelKey, model)

    const workspace = row.workspace ?? ''
    const ws = byWorkspace.get(workspace) ?? { workspace, tokens: 0, costUsd: 0 }
    ws.tokens += tokens
    // Priced the same way as `byModel`: unpriced rows add tokens but no cost,
    // so a workspace whose models are all unpriced is not zero-cost by accident.
    if (cost !== null) ws.costUsd += cost
    byWorkspace.set(workspace, ws)

    if (resolved === null) {
      const miss = missing.get(modelKey) ?? { provider: row.provider, model: row.model, tokens: 0 }
      miss.tokens += tokens
      missing.set(modelKey, miss)
    }
  }

  const totalTokens = totals.tokens
  return {
    totals,
    byDay: [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    byModel: [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd || b.output - a.output),
    byWorkspace: [...byWorkspace.values()]
      .map((entry) => ({
        workspace: entry.workspace,
        tokens: entry.tokens,
        costUsd: entry.costUsd,
        share: totalTokens === 0 ? 0 : entry.tokens / totalTokens,
      }))
      .sort((a, b) => b.tokens - a.tokens),
    missing: [...missing.values()].sort((a, b) => b.tokens - a.tokens),
  }
}

/** Percentage change, or `null` when the previous period is zero. */
export function changeRatio(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null
  return (current - previous) / previous
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
