import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ZERO_BUCKETS,
  tokensOf,
  cacheHitRate,
  normalizePrice,
  costUsd,
  localDateKey,
  dateRange,
  addBuckets,
  aggregate,
  changeRatio,
} from '../packages/token-diet/lib/shared/billing.js'

test('tokensOf sums every bucket', () => {
  assert.equal(tokensOf({ uncachedInput: 10, cacheRead: 20, cacheWrite: 30, output: 40 }), 100)
  assert.equal(tokensOf(ZERO_BUCKETS), 0)
  assert.equal(tokensOf(undefined), 0)
})

test('cacheHitRate divides by the prompt side only', () => {
  assert.equal(cacheHitRate({ uncachedInput: 25, cacheRead: 75, output: 1000 }), 0.75)
  assert.equal(cacheHitRate({ uncachedInput: 0, cacheRead: 0 }), 0)
})

test('normalizePrice defaults cache rates to input', () => {
  assert.deepEqual(normalizePrice({ input: 0.5, output: 2 }), {
    input: 0.5,
    output: 2,
    cacheRead: 0.5,
    cacheWrite: 0.5,
  })
  assert.deepEqual(normalizePrice({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5 }), {
    input: 1,
    output: 2,
    cacheRead: 0.1,
    cacheWrite: 1.5,
  })
  assert.deepEqual(normalizePrice(null), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
})

test('costUsd prices per million tokens', () => {
  const price = { input: 0.15, output: 0.6, cacheRead: 0.003 }
  const cost = costUsd({ uncachedInput: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 }, price)
  assert.equal(cost, 0.15)
  const mixed = costUsd({ uncachedInput: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 1_000_000 }, price)
  assert.equal(Number(mixed.toFixed(6)), 0.753)
})

test('localDateKey uses the local calendar day', () => {
  const noon = new Date(2026, 9, 23, 12, 0, 0).getTime()
  assert.equal(localDateKey(noon), '2026-10-23')
  assert.equal(localDateKey(new Date(2026, 0, 1, 0, 0, 1).getTime()), '2026-01-01')
  assert.equal(localDateKey(Number.NaN), '1970-01-01')
})

test('dateRange lists the inclusive window ascending', () => {
  assert.deepEqual(dateRange('2026-10-23', 3), ['2026-10-21', '2026-10-22', '2026-10-23'])
  assert.deepEqual(dateRange('2026-03-02', 2), ['2026-03-01', '2026-03-02'])
  assert.equal(dateRange('2026-10-23', 1).length, 1)
})

test('addBuckets is component-wise', () => {
  assert.deepEqual(
    addBuckets({ uncachedInput: 1, cacheRead: 2, cacheWrite: 3, output: 4 }, ZERO_BUCKETS),
    { uncachedInput: 1, cacheRead: 2, cacheWrite: 3, output: 4 },
  )
})

test('changeRatio reports null against an empty previous window', () => {
  assert.equal(changeRatio(10, 0), null)
  assert.equal(changeRatio(10, 5), 1)
  assert.equal(Number(changeRatio(5, 10).toFixed(4)), -0.5)
})

test('aggregate builds totals, days, models, workspaces and missing', () => {
  const prices = {
    'deepseek/deepseek-v4-flash': { input: 0.15, output: 0.6, cacheRead: 0.003 },
  }
  const priceOf = (provider, model) => {
    const found = prices[`${provider}/${model}`]
    return found === undefined ? null : { price: found, source: 'models.dev', confidence: 'exact' }
  }
  const rows = [
    { date: '2026-10-22', provider: 'deepseek', model: 'deepseek-v4-flash', workspace: 'code', calls: 2, uncachedInput: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
    { date: '2026-10-23', provider: 'deepseek', model: 'deepseek-v4-flash', workspace: 'code', calls: 1, uncachedInput: 0, cacheRead: 1_000_000, cacheWrite: 0, output: 1_000_000 },
    { date: '2026-10-23', provider: 'local', model: 'qwen-image', workspace: 'images', calls: 3, uncachedInput: 500, cacheRead: 0, cacheWrite: 0, output: 500 },
  ]
  const result = aggregate(rows, priceOf, { dates: dateRange('2026-10-23', 3) })

  assert.equal(result.totals.calls, 6)
  assert.equal(result.totals.tokens, 1_000_000 + 2_000_000 + 1_000)
  assert.equal(Number(result.totals.costUsd.toFixed(6)), Number((0.15 + 0.003 + 0.6).toFixed(6)))

  assert.equal(result.byDay.length, 3)
  assert.equal(result.byDay[0].date, '2026-10-21')
  assert.equal(result.byDay[0].calls, 0)
  assert.equal(result.byDay[2].date, '2026-10-23')

  const flash = result.byModel.find((row) => row.model === 'deepseek-v4-flash')
  assert.equal(flash.calls, 3)
  assert.equal(flash.missing, false)
  assert.equal(flash.confidence, 'exact')

  const unpriced = result.byModel.find((row) => row.model === 'qwen-image')
  assert.equal(unpriced.missing, true)
  assert.equal(unpriced.costUsd, 0)

  assert.equal(result.missing.length, 1)
  assert.equal(result.missing[0].model, 'qwen-image')
  assert.equal(result.missing[0].tokens, 1_000)

  assert.equal(result.byWorkspace[0].workspace, 'code')
  assert.equal(result.byWorkspace[0].tokens, 3_000_000)
  assert.equal(Number(result.byWorkspace[0].share.toFixed(4)), Number((3_000_000 / 3_001_000).toFixed(4)))
  // The workspace cost is folded from the same priced buckets as `byModel`; the
  // unpriced model contributes tokens but no cost.
  assert.equal(Number(result.byWorkspace[0].costUsd.toFixed(6)), Number((0.15 + 0.003 + 0.6).toFixed(6)))
  const images = result.byWorkspace.find((row) => row.workspace === 'images')
  assert.equal(images.costUsd, 0)
  assert.equal(images.tokens, 1_000)
})

test('aggregate keeps an unpriced model out of cost but in tokens', () => {
  const rows = [
    { date: '2026-10-23', provider: 'x', model: 'mystery', workspace: 'w', calls: 1, uncachedInput: 10, cacheRead: 0, cacheWrite: 0, output: 0 },
  ]
  const result = aggregate(rows, () => null, { dates: ['2026-10-23'] })
  assert.equal(result.totals.costUsd, 0)
  assert.equal(result.totals.tokens, 10)
  assert.equal(result.missing.length, 1)
})
