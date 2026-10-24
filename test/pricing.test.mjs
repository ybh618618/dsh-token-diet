import test from 'node:test'
import assert from 'node:assert/strict'

import { createPricingService } from '../packages/token-diet/lib/host/pricing.js'

/** A models.dev-shaped payload modelled on the real one this profile produced. */
const TABLE = {
  deepseek: {
    name: 'DeepSeek',
    models: {
      // The official DeepSeek Flash entry every spelling is canonicalised onto.
      'deepseek-flash': { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } },
      'deepseek-v4-flash': { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } },
      // A distinct price so a test can prove which entry was used.
      'deepseek-v4.1-flash': { cost: { input: 0.165, output: 0.66, cache_read: 0.0033 } },
      'deepseek-v4-pro': { cost: { input: 0.66, output: 1.98, cache_read: 0.022 } },
    },
  },
  openai: {
    name: 'OpenAI',
    models: {
      'gpt-6.1-sol': { cost: { input: 2, output: 10, cache_read: 0.1 } },
      'gpt-6-astra': { cost: { input: 10, output: 50, cache_read: 1 } },
    },
  },
  fastprobe: {
    name: 'FastProbe',
    models: {
      echo: { cost: { input: 0.1, output: 0.2 } },
      probe: { cost: { input: 0.3, output: 0.4 } },
    },
  },
  above: {
    name: 'Above',
    models: {
      'deepseek-v4.1-flash': { cost: { input: 0.165, output: 0.66, cache_read: 0.0033 } },
      'space-bunny-free': { cost: { input: 0.01, output: 0.02 } },
    },
  },
}

function service() {
  const fetchImpl = async () => {
    const body = JSON.stringify(TABLE)
    return { ok: true, status: 200, text: async () => body, json: async () => TABLE }
  }
  return createPricingService({ home: null, logger: {}, config: { refreshMs: 1 }, fetchImpl })
}

const svc = service()
await svc.init()
// init() refreshes in the background; wait for the table.
for (let attempt = 0; attempt < 50 && svc.resolve('deepseek', 'deepseek-v4-pro') === null; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

test('exact provider + model resolves with confidence exact', () => {
  const found = svc.resolve('deepseek', 'deepseek-v4-pro')
  assert.ok(found !== null)
  assert.equal(found.confidence, 'exact')
  assert.equal(found.matchedProvider, 'deepseek')
  assert.equal(found.price.input, 0.66)
})

test('a provider alias resolves with confidence alias', () => {
  const found = svc.resolve('magpie', 'deepseek-v4-pro')
  assert.ok(found !== null)
  assert.equal(found.confidence, 'alias')
  assert.equal(found.matchedModel, 'deepseek-v4-pro')
})

test('the same model id under another vendor resolves as cross-provider', () => {
  const found = svc.resolve('owlapi', 'gpt-6.1-sol')
  assert.ok(found !== null)
  assert.equal(found.confidence, 'alias')
  const other = svc.resolve('hejuapi', 'gpt-6.1-sol')
  assert.ok(other !== null)
  assert.ok(other.confidence === 'cross-provider' || other.confidence === 'fuzzy')
  assert.equal(other.matchedModel, 'gpt-6.1-sol')
})

test('every DeepSeek Flash spelling maps to the official deepseek-flash price', () => {
  // The requirement: any model named `deepseek-v4.1-flash` or `deepseek-flash`,
  // whatever route reports it, prices as the official `deepseek/deepseek-flash`.
  const cases = [
    ['magpie', 'workbuddy-ai/deepseek-v4.1-flash'],
    ['magpie', 'workbuddy/deepseek-v4.1-flash'],
    ['cmdc', 'deepseek/deepseek-v4.1-flash'],
    ['cmdc', 'deepseek-v4.1-flash'],
    ['qwen-token-plan-cn', 'deepseek-v4.1-flash'],
    ['workbuddy', 'deepseek_v4.1_flash'],
    ['deepseek-account', 'deepseek-flash'],
    ['deepseek-official', 'deepseek-flash'],
    ['some-reseller', 'deepseek-flash:free'],
  ]
  for (const [provider, model] of cases) {
    const found = svc.resolve(provider, model)
    assert.ok(found !== null, `${provider}/${model} must resolve`)
    assert.equal(found.confidence, 'model-alias', `${provider}/${model} must use the model mapping`)
    assert.equal(found.matchedProvider, 'deepseek', `${provider}/${model} provider`)
    assert.equal(found.matchedModel, 'deepseek-flash', `${provider}/${model} model`)
    // The official rate, not the neighbouring `deepseek-v4.1-flash` entry.
    assert.equal(found.price.input, 0.15, `${provider}/${model} input rate`)
    assert.equal(found.price.output, 0.6, `${provider}/${model} output rate`)
    assert.equal(found.price.cacheRead, 0.003, `${provider}/${model} cache-read rate`)
  }
})

test('the model mapping does not swallow a different DeepSeek model', () => {
  // `deepseek-v4-pro` is a different model at a different price and must not be
  // canonicalised onto deepseek-flash.
  const pro = svc.resolve('magpie', 'deepseek-v4-pro')
  assert.ok(pro !== null)
  assert.notEqual(pro.matchedModel, 'deepseek-flash')
  assert.equal(pro.price.input, 0.66)
  assert.equal(pro.confidence, 'alias')

  // `deepseek-v4-flash` (no `.1`) is its own models.dev id and stays exact.
  const v4 = svc.resolve('deepseek', 'deepseek-v4-flash')
  assert.ok(v4 !== null)
  assert.equal(v4.confidence, 'exact')
  assert.equal(v4.matchedModel, 'deepseek-v4-flash')
})

test('a custom price still wins over the model mapping', async () => {
  await svc.setCustom('magpie', 'workbuddy-ai/deepseek-v4.1-flash', { input: 9, output: 9 })
  const custom = svc.resolve('magpie', 'workbuddy-ai/deepseek-v4.1-flash')
  assert.equal(custom.source, 'custom')
  assert.equal(custom.price.input, 9)
  await svc.setCustom('magpie', 'workbuddy-ai/deepseek-v4.1-flash', null)
  assert.equal(svc.resolve('magpie', 'workbuddy-ai/deepseek-v4.1-flash').confidence, 'model-alias')
})

test('a model mapping whose canonical target is absent falls through instead of guessing', async () => {
  // A table without the official DeepSeek Flash entry: the mapping must not report
  // a price it cannot justify, and the generic matching must take over.
  const fetchImpl = async () => {
    const body = JSON.stringify({ openai: { name: 'OpenAI', models: { 'gpt-6.1-sol': { cost: { input: 2, output: 10 } } } } })
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) }
  }
  const service = createPricingService({ home: null, logger: {}, config: { refreshMs: 1 }, fetchImpl })
  await service.init()
  for (let attempt = 0; attempt < 50 && service.resolve('openai', 'gpt-6.1-sol') === null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(service.resolve('magpie', 'deepseek-v4.1-flash'), null, 'no fabricated price')
})

test('config.modelAliases extends the built-in model mapping', async () => {
  const fetchImpl = async () => {
    const body = JSON.stringify(TABLE)
    return { ok: true, status: 200, text: async () => body, json: async () => TABLE }
  }
  const service = createPricingService({
    home: null,
    logger: {},
    config: { refreshMs: 1, modelAliases: { 'qwen-image': 'deepseek/deepseek-flash' } },
    fetchImpl,
  })
  await service.init()
  for (let attempt = 0; attempt < 50 && service.resolve('deepseek', 'deepseek-v4-pro') === null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const found = service.resolve('local', 'qwen-image')
  assert.ok(found !== null, 'the configured mapping resolved')
  assert.equal(found.matchedModel, 'deepseek-flash')
  assert.equal(found.confidence, 'model-alias')
})

test('a spelling outside the mapping still uses the ordinary matching tiers', () => {
  // `-sg` is a region variant, not one of the two mapped ids: it keeps resolving
  // through the fuzzy tier (badged as an inexact match in the UI).
  const region = svc.resolve('magpie', 'workbuddy-ai/deepseek-v4.1-flash-sg')
  assert.ok(region !== null)
  assert.equal(region.confidence, 'fuzzy')

  // A model nobody lists stays unpriced rather than receiving a guess.
  assert.equal(svc.resolve('magpie', 'totally-made-up-model'), null)

  // And a variant tag still separates models that share a stem.
  assert.equal(svc.resolve('fastprobe', 'echo-supported'), null)
})

test('a region suffix still matches (flash-sg -> flash)', () => {
  const found = svc.resolve('magpie', 'workbuddy-ai/deepseek-v4.1-flash-sg')
  assert.ok(found !== null)
  assert.equal(found.confidence, 'fuzzy')
  assert.ok(found.matchedModel.startsWith('deepseek-v4'))
})

test('a shared stem is NOT treated as the same model', () => {
  // `echo-supported` contains `echo` but they are different probes; pricing it as
  // `echo` would silently report a fabricated cost.
  assert.equal(svc.resolve('fastprobe', 'echo-supported'), null)
  assert.equal(svc.resolve('fastprobe', 'echo-unsupported'), null)
  assert.equal(svc.resolve('fastprobe-cc', 'echo-cc'), null)
  // A genuinely unknown family has no candidate at all.
  assert.equal(svc.resolve('local', 'qwen-image'), null)
  assert.equal(svc.resolve('x', 'space-bunny-alpha'), null)
})

test('a model that is not in any table returns null, never a guess', () => {
  assert.equal(svc.resolve('nobody', 'totally-made-up-model'), null)
  assert.equal(svc.resolve('', ''), null)
})

test('suggestions prefer exact ids, then fuzzy ones, and never offer the stem match', () => {
  const forUnknown = svc.suggestions('local', 'qwen-image', 3)
  assert.ok(Array.isArray(forUnknown))
  assert.equal(forUnknown.length, 0, 'nothing plausible to suggest')

  const forModel = svc.suggestions('magpie', 'workbuddy-ai/deepseek-v4.1-flash', 3)
  assert.ok(forModel.length >= 1)
  assert.equal(forModel[0].model, 'deepseek-v4.1-flash')
  assert.equal(forModel[0].confidence, 'fuzzy')

  const forStem = svc.suggestions('fastprobe', 'echo-supported', 3)
  assert.equal(forStem.length, 0, 'a shared stem is not a suggestion')
})

test('a custom price overrides models.dev and can be removed', async () => {
  await svc.setCustom('local', 'qwen-image', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  const custom = svc.resolve('local', 'qwen-image')
  assert.ok(custom !== null)
  assert.equal(custom.source, 'custom')
  assert.equal(custom.confidence, 'custom')
  assert.equal(custom.price.input, 0)

  await svc.setCustom('local', 'qwen-image', null)
  assert.equal(svc.resolve('local', 'qwen-image'), null)
})

test('a custom price beats an exact models.dev entry', async () => {
  await svc.setCustom('deepseek', 'deepseek-v4-pro', { input: 1, output: 2 })
  const found = svc.resolve('deepseek', 'deepseek-v4-pro')
  assert.equal(found.source, 'custom')
  assert.equal(found.price.input, 1)
  // Cache rates default to the input rate when omitted.
  assert.equal(found.price.cacheRead, 1)
  await svc.setCustom('deepseek', 'deepseek-v4-pro', null)
  assert.equal(svc.resolve('deepseek', 'deepseek-v4-pro').confidence, 'exact')
})
