import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/token-diet/lib/index.js'
import { assistantEvent, createFakeCtx, createFakePersistence, fakeSession, waitFor, withHome } from './helpers/harness.mjs'

/** A models.dev-shaped payload covering the routes these tests use. */
const MODELS_DEV = {
  deepseek: {
    name: 'DeepSeek',
    models: {
      'deepseek-v4-flash': { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } },
      'deepseek-v4-pro': { cost: { input: 0.66, output: 1.98, cache_read: 0.022 } },
    },
  },
  openai: {
    name: 'OpenAI',
    models: {
      'gpt-6.1-sol': { cost: { input: 1.1, output: 4.4, cache_read: 0.11 } },
    },
  },
}

const RATES = { rates: { CNY: 7.2 } }

/** A fetch double: models.dev, primary rate source, everything else 404. */
function fakeFetch() {
  const calls = []
  const impl = async (url) => {
    calls.push(String(url))
    if (String(url).includes('models.dev')) return jsonResponse(MODELS_DEV)
    if (String(url).includes('open.er-api.com')) return jsonResponse(RATES)
    if (String(url).includes('frankfurter')) return jsonResponse(RATES)
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
  }
  impl.calls = calls
  return impl
}

function jsonResponse(value) {
  const body = JSON.stringify(value)
  return { ok: true, status: 200, json: async () => value, text: async () => body }
}

function fixtureSession() {
  const now = Date.now()
  const yesterday = now - 26 * 3_600_000
  return fakeSession({
    id: 'session-parent',
    cwd: 'C:\\Users\\test\\code\\demo',
    createdAt: yesterday,
    events: [
      { type: 'turn/start', seq: 0, time: yesterday, data: { turn: 1 } },
      assistantEvent({
        seq: 1,
        time: yesterday,
        provider: 'magpie',
        model: 'workbuddy-ai/deepseek-v4.1-flash',
        usage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000 },
      }),
      assistantEvent({
        seq: 2,
        time: now,
        turn: 2,
        provider: 'openai',
        model: 'gpt-6.1-sol',
        usage: { inputTokens: 200_000, outputTokens: 20_000, cacheReadTokens: 0 },
      }),
      {
        type: 'assistant/message',
        seq: 3,
        time: now,
        data: {
          turn: 3,
          step: 1,
          message: {
            role: 'assistant',
            source: { kind: 'model', provider: 'local', model: 'qwen-image' },
            content: [{ type: 'text', text: 'x' }],
          },
          stream: [],
          usage: { inputTokens: 10_000, outputTokens: 5_000 },
        },
      },
    ],
  })
}

function fixtureChild() {
  const now = Date.now()
  return fakeSession({
    id: 'session-child',
    cwd: 'C:\\Users\\test\\code\\demo',
    createdAt: now,
    parentSession: 'session-parent',
    events: [
      assistantEvent({
        seq: 0,
        time: now,
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        usage: { inputTokens: 100_000, outputTokens: 10_000 },
      }),
    ],
  })
}

/** Boot the plugin against the fake context; returns handles for assertions. */
async function boot(home, options = {}) {
  const parent = fixtureSession()
  const child = fixtureChild()
  const persistence = createFakePersistence([parent, child], options.persistenceOptions)
  const ctx = createFakeCtx({ persistence })
  const fetchImpl = fakeFetch()
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  ctx.__fetch = fetchImpl
  apply(
    {
      ...ctx,
      // apply() only reads these two; keep the fake surface explicit.
      get: ctx.get,
      effect: ctx.effect,
      on: ctx.on,
      logger: ctx.logger,
    },
    {
      home,
      ...(options.rateOverride === undefined ? {} : { rateOverride: options.rateOverride }),
      budgetHoldSeconds: options.budgetHoldSeconds ?? 5,
      ...(options.config ?? {}),
    },
  )
  // Restore global fetch once the services resolved (scans are backgrounded, so
  // keep it patched until dispose and restore there).
  const originalRestore = ctx.dispose.bind(ctx)
  ctx.dispose = async () => {
    await originalRestore()
    globalThis.fetch = originalFetch
  }
  return { ctx, persistence, fetchImpl, parent, child }
}

test('host boots, indexes sessions and answers the summary RPC', async () => {
  await withHome(async (home) => {
    const { ctx } = await boot(home)
    assert.equal(ctx.rpcRegistered(), true, 'the /token-diet channel is registered')
    // Services initialize asynchronously; wait for the background scan.
    const indexed = await waitFor(async () => {
      const result = await ctx.invokeRpc('indexStatus', {})
      return result.ok && result.value.progress.state === 'ready'
    }, 8000)
    assert.equal(indexed, true, 'the index finished scanning')

    const summary = await ctx.invokeRpc('summary', { range: 30, currency: 'CNY' })
    assert.equal(summary.ok, true, JSON.stringify(summary))
    const value = summary.value
    assert.equal(value.range, 30)
    assert.equal(value.currency, 'CNY')
    assert.equal(typeof value.rate, 'number')
    assert.ok(value.kpis.totalTokens > 0, 'tokens were folded from the fake sessions')
    assert.ok(Array.isArray(value.trend) && value.trend.length === 30)
    assert.ok(value.byModel.length >= 3)
    assert.ok(value.byWorkspace.length >= 1)
    assert.equal(value.byWorkspace[0].workspace, 'demo')

    // Every workspace row carries the cost of its priced usage (same units as
    // the KPI total). Unpriced models are excluded from both sides, so the rows
    // can never add up to more than the total — that is what keeps the block
    // from double counting.
    let workspaceCost = 0
    for (const entry of value.byWorkspace) {
      assert.equal(typeof entry.costUsd, 'number', `byWorkspace[${entry.workspace}] carries costUsd`)
      assert.ok(Number.isFinite(entry.costUsd) && entry.costUsd >= 0, 'the workspace cost is a non-negative number')
      assert.equal(typeof entry.costDisplay, 'number', 'the display alias is a number too')
      workspaceCost += entry.costUsd
    }
    assert.ok(workspaceCost > 0, 'the priced workspaces report a cost')
    assert.ok(
      workspaceCost <= value.kpis.costUsd + 0.01,
      `workspace costs (${workspaceCost}) must not exceed the total (${value.kpis.costUsd})`,
    )

    // A provider-less model is reported as missing and priced at zero.
    const missing = value.missing.map((entry) => entry.model)
    assert.ok(missing.includes('qwen-image'), `missing should list qwen-image, got ${missing}`)

    // magpie is aliased to deepseek, so its usage is priced, not missing.
    const flash = value.byModel.find((row) => row.model === 'workbuddy-ai/deepseek-v4.1-flash')
    assert.ok(flash !== undefined)
    assert.equal(flash.missing, false)
    assert.ok(flash.costUsd > 0)

    await ctx.dispose()
  })
})

test('unknown RPC endpoints fail with bad-request', async () => {
  await withHome(async (home) => {
    const { ctx } = await boot(home)
    const result = await ctx.invokeRpc('nope', {})
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'bad-request')
    await ctx.dispose()
  })
})

test('a session budget blocks the next step once reached', async () => {
  await withHome(async (home) => {
    const { ctx } = await boot(home, { budgetHoldSeconds: 1 })
    await waitFor(async () => (await ctx.invokeRpc('indexStatus', {})).value?.progress?.state === 'ready', 8000)

    // Spend is real: set an extremely small CNY limit so the parent is over budget.
    const set = await ctx.invokeRpc('setBudget', { sessionId: 'session-parent', limit: 0.0001, currency: 'CNY' })
    assert.equal(set.ok, true, JSON.stringify(set))
    assert.equal(set.value.reached, true, `expected reached, got ${JSON.stringify(set.value)}`)

    const started = Date.now()
    const decision = await ctx.preStep({
      agent: { id: 'session-parent' },
      messages: [],
      turn: 4,
      step: 1,
      signal: new AbortController().signal,
    })
    // The guard holds the step until the budget hold expires, then rejects.
    assert.equal(decision.kind, 'reject')
    assert.ok(Date.now() - started >= 500, 'the guard held the step before rejecting')

    // The reach marker is published for the popover.
    const cost = await ctx.invokeRpc('sessionCost', { sessionId: 'session-parent' })
    assert.equal(cost.value.reached, true)

    await ctx.dispose()
  })
})

test('raising the budget releases the held step without rejecting', async () => {
  await withHome(async (home) => {
    const { ctx } = await boot(home, { budgetHoldSeconds: 10 })
    await waitFor(async () => (await ctx.invokeRpc('indexStatus', {})).value?.progress?.state === 'ready', 8000)
    await ctx.invokeRpc('setBudget', { sessionId: 'session-parent', limit: 0.0001, currency: 'CNY' })

    const stepPromise = ctx.preStep({
      agent: { id: 'session-parent' },
      messages: [],
      turn: 5,
      step: 1,
      signal: new AbortController().signal,
    })
    // Give the guard time to enter the hold, then raise the limit.
    await new Promise((resolve) => setTimeout(resolve, 150))
    const raised = await ctx.invokeRpc('raiseBudgetAndContinue', {
      sessionId: 'session-parent',
      limit: 1000,
      currency: 'CNY',
    })
    assert.equal(raised.ok, true, JSON.stringify(raised))
    assert.equal(raised.value.continued, true)

    const decision = await stepPromise
    assert.equal(decision.kind, 'enter', 'the held step resumed instead of being rejected')
    await ctx.dispose()
  })
})

test('a sub-agent inherits the blocking decision of its root session', async () => {
  await withHome(async (home) => {
    const { ctx } = await boot(home, { budgetHoldSeconds: 1 })
    await waitFor(async () => (await ctx.invokeRpc('indexStatus', {})).value?.progress?.state === 'ready', 8000)
    await ctx.invokeRpc('setBudget', { sessionId: 'session-parent', limit: 0.0001, currency: 'CNY' })

    const decision = await ctx.preStep({
      agent: { id: 'session-child' },
      messages: [],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    })
    assert.equal(decision.kind, 'reject', 'the child resolves to the over-budget root')
    await ctx.dispose()
  })
})

test('dismissing the popover stops the step and records the reach', async () => {
  await withHome(async (home) => {
    const { ctx } = await boot(home, { budgetHoldSeconds: 10 })
    await waitFor(async () => (await ctx.invokeRpc('indexStatus', {})).value?.progress?.state === 'ready', 8000)
    await ctx.invokeRpc('setBudget', { sessionId: 'session-parent', limit: 0.0001, currency: 'CNY' })

    const stepPromise = ctx.preStep({
      agent: { id: 'session-parent' },
      messages: [],
      turn: 6,
      step: 1,
      signal: new AbortController().signal,
    })
    await new Promise((resolve) => setTimeout(resolve, 120))
    const dismissed = await ctx.invokeRpc('dismissBudget', { sessionId: 'session-parent' })
    assert.equal(dismissed.ok, true)
    const decision = await stepPromise
    assert.equal(decision.kind, 'reject')
    await ctx.dispose()
  })
})

test('prices, rate overrides and custom prices round-trip', async () => {
  await withHome(async (home) => {
    const { ctx } = await boot(home, { budgetHoldSeconds: 1 })
    await waitFor(async () => (await ctx.invokeRpc('indexStatus', {})).value?.progress?.state === 'ready', 8000)

    const prices = await ctx.invokeRpc('prices', {})
    assert.equal(prices.ok, true, JSON.stringify(prices))
    assert.ok(prices.value.rows.length >= 3)
    assert.equal(typeof prices.value.rate, 'number')
    assert.ok(prices.value.rateInfo !== undefined, 'rateInfo is present for the footer')

    const override = await ctx.invokeRpc('setRateOverride', { cnyPerUsd: 8 })
    assert.equal(override.ok, true)
    assert.equal(override.value.rate, 8)

    const custom = await ctx.invokeRpc('setCustomPrice', {
      provider: 'local',
      model: 'qwen-image',
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })
    assert.equal(custom.ok, true, JSON.stringify(custom))
    const priced = custom.value.rows.find((row) => row.model === 'qwen-image')
    assert.ok(priced.price !== null, 'the custom price resolved')
    assert.equal(priced.source, 'custom')

    const removed = await ctx.invokeRpc('removeCustomPrice', { provider: 'local', model: 'qwen-image' })
    assert.equal(removed.ok, true)

    const cleared = await ctx.invokeRpc('setRateOverride', { cnyPerUsd: null })
    assert.equal(cleared.ok, true)
    assert.notEqual(cleared.value.rate, 8, 'the override was cleared')

    await ctx.dispose()
  })
})

test('the RPC channel installs when the connection service arrives late', async () => {
  await withHome(async (home) => {
    // Boot without a connection service, mirroring a composition whose
    // client-connection row activates after this plugin entry.
    const parent = fixtureSession()
    const persistence = createFakePersistence([parent])
    const ctx = createFakeCtx({ persistence })
    // createFakeCtx always provides connection; remove it for this scenario.
    ctx.__unprovide('connection')
    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch()
    try {
      apply({ ...ctx }, { home, budgetHoldSeconds: 1 })
      assert.equal(ctx.rpcRegistered(), false, 'no channel before the service exists')
      assert.equal(ctx.__injections.length, 1, `one injection callback was registered, got ${ctx.__injections.length}`)
      assert.equal(ctx.__injections[0].applied, false)

      // Now the carrier activates.
      const handlers = new Map()
      ctx.__satisfy('connection', {
        rpc: {
          handle(channel, handler) {
            handlers.set(channel, handler)
            return () => handlers.delete(channel)
          },
        },
      })
      assert.equal(handlers.has('/token-diet'), true, 'the channel registered on arrival')

      // The handler was registered against the carrier that arrived late, so call
      // it directly rather than through the harness' pre-existing channel map.
      const result = await handlers.get('/token-diet')(
        'indexStatus',
        {},
        new AbortController().signal,
        { principal: { kind: 'owner' } },
      )
      assert.equal(result.ok, true, JSON.stringify(result))
    } finally {
      await ctx.dispose()
      globalThis.fetch = originalFetch
    }
  })
})

test('the webServer fallback carrier serves the same envelope and refuses untrusted hosts', async () => {
  await withHome(async (home) => {
    const parent = fixtureSession()
    const persistence = createFakePersistence([parent])
    const ctx = createFakeCtx({ persistence })
    ctx.__unprovide('connection')
    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch()
    try {
      apply({ ...ctx }, { home, budgetHoldSeconds: 1 })
      assert.equal(ctx.webRoutes.has('/token-diet'), true, 'the fallback route registered')

      // A well-formed loopback request reaches the endpoint table.
      const ok = await ctx.get('webServer').request('/token-diet/indexStatus', {
        body: { type: 'client-request', rpcId: 'r1', method: 'indexStatus', payload: {} },
      })
      assert.equal(ok.status, 200, ok.body)
      assert.equal(ok.json.type, 'server-response')
      assert.equal(ok.json.rpcId, 'r1')
      assert.equal(ok.json.result.ok, true, JSON.stringify(ok.json))

      // An unknown endpoint is a bad-request, not a crash.
      const unknown = await ctx.get('webServer').request('/token-diet/nope', {
        body: { type: 'client-request', rpcId: 'r2', method: 'nope', payload: {} },
      })
      assert.equal(unknown.status, 200)
      assert.equal(unknown.json.result.ok, false)
      assert.equal(unknown.json.result.error.code, 'bad-request')

      // A non-loopback Host is refused (DNS-rebinding defence).
      const foreign = await ctx.get('webServer').request('/token-diet/indexStatus', {
        headers: { host: 'evil.example.com:50963' },
        body: { type: 'client-request', rpcId: 'r3', method: 'indexStatus', payload: {} },
      })
      assert.equal(foreign.status, 403, 'a foreign Host is refused')

      // A cross-site fetch marker is refused.
      const crossSite = await ctx.get('webServer').request('/token-diet/indexStatus', {
        headers: { 'sec-fetch-site': 'cross-site' },
        body: { type: 'client-request', rpcId: 'r4', method: 'indexStatus', payload: {} },
      })
      assert.equal(crossSite.status, 403)

      // A mismatched Origin is refused.
      const badOrigin = await ctx.get('webServer').request('/token-diet/indexStatus', {
        headers: { origin: 'http://evil.example.com' },
        body: { type: 'client-request', rpcId: 'r5', method: 'indexStatus', payload: {} },
      })
      assert.equal(badOrigin.status, 403)

      // GET is not the RPC verb.
      const wrongVerb = await ctx.get('webServer').request('/token-diet/indexStatus', { method: 'GET' })
      assert.equal(wrongVerb.status, 405)

      // A non-JSON body is refused.
      const badBody = await ctx.get('webServer').request('/token-diet/indexStatus', {
        body: 'not json',
        headers: { 'content-type': 'text/plain' },
      })
      assert.equal(badBody.status, 415)
    } finally {
      await ctx.dispose()
      globalThis.fetch = originalFetch
    }
  })
})
