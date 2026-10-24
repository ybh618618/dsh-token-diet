import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createUsageIndex } from '../packages/token-diet/lib/host/index-store.js'

/**
 * Usage-accounting regressions found against real session logs:
 *
 * 1. a retried step logs `assistant/attempt` plus one `assistant/message`, and the
 *    fold billed both, inflating the call count;
 * 2. the live `session/event` fold never advanced the entry's `eventCount`, so a
 *    later scan could treat a growing session as unchanged and keep a stale total.
 */

const HEADER = { version: 4, id: 'session-a', createdAt: 1_700_000_000_000, cwd: 'C:/x/demo', isSeeded: false }

function message({ seq, turn, step, input, output, cacheRead = 0, provider = 'deepseek', model = 'deepseek-v4-pro' }) {
  return {
    type: 'assistant/message',
    seq,
    time: 1_700_000_000_000 + seq,
    data: {
      turn,
      step,
      message: { role: 'assistant', source: { kind: 'model', provider, model }, content: [] },
      stream: [],
      usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead },
    },
  }
}

function attempt({ seq, turn, step, input, output, cacheRead = 0 }) {
  return {
    type: 'assistant/attempt',
    seq,
    time: 1_700_000_000_000 + seq,
    data: {
      turn,
      step,
      stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead } } }],
    },
  }
}

/** A persistence double over one mutable event list. */
function persistenceFor(header, events) {
  const snapshot = { header, revision: 'rev-1', eventCount: events.length }
  return {
    snapshot,
    events,
    list: async () => [snapshot],
    stat: async () => snapshot,
    async open() {
      return {
        id: header.id,
        header,
        inheritedEventCount: 0,
        // Read the mutating array at call time so a test can append events.
        async read() {
          return { eventState: 'detached', events: events.slice() }
        },
        async close() {},
      }
    },
  }
}

function totalOf(index, sessionId) {
  return (index.sessionUsage(sessionId)?.buckets ?? []).reduce(
    (acc, cell) => acc + cell.uncachedInput + cell.cacheRead + cell.cacheWrite + cell.output,
    0,
  )
}

function callsOf(index, sessionId) {
  return (index.sessionUsage(sessionId)?.buckets ?? []).reduce((acc, cell) => acc + cell.calls, 0)
}

test('a retried step is billed once, using its settlement', async () => {
  const header = { ...HEADER, id: 'session-retry' }
  const events = [
    { type: 'step/start', seq: 0, time: 1_700_000_000_000, data: { turn: 1, step: 1 } },
    // First try failed after reporting usage.
    attempt({ seq: 1, turn: 1, step: 1, input: 1000, output: 10, cacheRead: 500 }),
    // Retry succeeded and settled the step.
    message({ seq: 2, turn: 1, step: 1, input: 1200, output: 20, cacheRead: 600 }),
    { type: 'step/end', seq: 3, time: 1_700_000_000_003, data: { turn: 1, step: 1 } },
    // A second, independent step billed normally.
    message({ seq: 4, turn: 1, step: 2, input: 300, output: 30 }),
  ]
  const persistence = persistenceFor(header, events)
  const index = createUsageIndex({ home: null, logger: {}, sessionPersistence: persistence })
  await index.init()
  await index.scan(true)

  assert.equal(callsOf(index, 'session-retry'), 2, 'two steps are two calls, not three')
  // 1200+600+20 (settlement) + 300+30 (second step) = 2150
  assert.equal(totalOf(index, 'session-retry'), 2150, 'the settlement supersedes the attempt, no double billing')
})

test('an unsettled retried step still counts once', async () => {
  const header = { ...HEADER, id: 'session-killed' }
  const events = [
    attempt({ seq: 0, turn: 1, step: 1, input: 100, output: 10 }),
    attempt({ seq: 1, turn: 1, step: 1, input: 200, output: 20 }),
  ]
  const persistence = persistenceFor(header, events)
  const index = createUsageIndex({ home: null, logger: {}, sessionPersistence: persistence })
  await index.init()
  await index.scan(true)

  assert.equal(callsOf(index, 'session-killed'), 1, 'one step is one call even without a settlement')
  assert.equal(totalOf(index, 'session-killed'), 220, 'the newest attempt wins')
})

test('sessions without any usage contribute nothing', async () => {
  const header = { ...HEADER, id: 'session-empty' }
  const events = [
    { type: 'turn/start', seq: 0, time: 1_700_000_000_000, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 1_700_000_000_001, data: { role: 'user', content: [] } },
  ]
  const persistence = persistenceFor(header, events)
  const index = createUsageIndex({ home: null, logger: {}, sessionPersistence: persistence })
  await index.init()
  await index.scan(true)
  assert.equal(callsOf(index, 'session-empty'), 0)
  assert.equal(totalOf(index, 'session-empty'), 0)
})

test('the live fold advances eventCount so a scan cannot treat the session as unchanged', async () => {
  const header = { ...HEADER, id: 'session-live' }
  const events = [message({ seq: 0, turn: 1, step: 1, input: 100, output: 10 })]
  const persistence = persistenceFor(header, events)
  const index = createUsageIndex({ home: null, logger: {}, sessionPersistence: persistence })
  await index.init()
  await index.scan(true)
  assert.equal(totalOf(index, 'session-live'), 110)

  // A live event arrives with a much larger seq, then the log catches up.
  const live = message({ seq: 500, turn: 1, step: 2, input: 200, output: 20 })
  index.onEvent({ id: 'session-live', header }, live)
  assert.equal(totalOf(index, 'session-live'), 330, 'the live event is visible immediately')

  // The authoritative log now contains both events plus one more.
  persistence.events.push(live, message({ seq: 501, turn: 1, step: 3, input: 300, output: 30 }))
  persistence.snapshot.eventCount = persistence.events.length
  persistence.snapshot.revision = 'rev-2'
  await index.scan()

  const expected = 110 + 220 + 330
  assert.equal(totalOf(index, 'session-live'), expected, 'the rescan replaces the provisional rows, no double count')
  assert.equal(callsOf(index, 'session-live'), 3)
})

test('a live settlement blocks a later attempt for the same step', async () => {
  const header = { ...HEADER, id: 'session-live-order' }
  const events = []
  const persistence = persistenceFor(header, events)
  const index = createUsageIndex({ home: null, logger: {}, sessionPersistence: persistence })
  await index.init()
  await index.scan(true)

  const settled = message({ seq: 0, turn: 2, step: 1, input: 100, output: 10 })
  index.onEvent({ id: 'session-live-order', header }, settled)
  // A late attempt for the same step must be ignored.
  index.onEvent({ id: 'session-live-order', header }, attempt({ seq: 1, turn: 2, step: 1, input: 999, output: 999 }))

  assert.equal(totalOf(index, 'session-live-order'), 110, 'the settled step is billed once')
  assert.equal(callsOf(index, 'session-live-order'), 1)
})

test('usage is attributed to the provider and model of the settled call', async () => {
  const header = { ...HEADER, id: 'session-models' }
  const events = [
    message({ seq: 0, turn: 1, step: 1, input: 100, output: 10, provider: 'magpie', model: 'workbuddy-ai/deepseek-v4.1-flash' }),
    message({ seq: 1, turn: 1, step: 2, input: 200, output: 20, provider: 'owlapi', model: 'gpt-6.1-sol' }),
  ]
  const persistence = persistenceFor(header, events)
  const index = createUsageIndex({ home: null, logger: {}, sessionPersistence: persistence })
  await index.init()
  await index.scan(true)

  const buckets = index.sessionUsage('session-models').buckets
  const flash = buckets.find((cell) => cell.model === 'workbuddy-ai/deepseek-v4.1-flash')
  const sol = buckets.find((cell) => cell.model === 'gpt-6.1-sol')
  assert.equal(flash.provider, 'magpie')
  assert.equal(flash.uncachedInput, 100)
  assert.equal(sol.provider, 'owlapi')
  assert.equal(sol.uncachedInput, 200)
})

test('a read that raced the cache load does not pin an empty index', async () => {
  // The Web client asks for `summary` the moment the page mounts, which can land
  // while `init()` is still reading index.v1.json. `rows()` memoizes whatever it
  // computed, so an un-invalidated cache load left the page reporting zero usage
  // long after the data had arrived.
  const home = await mkdtemp(join(tmpdir(), 'token-diet-cache-'))
  try {
    const cache = {
      version: 1,
      sessions: {
        'session-cached': {
          revision: 'r1',
          eventCount: 2,
          header: { createdAt: 1, cwd: 'C:\demo' },
          rows: [
            { date: '2026-10-20', provider: 'deepseek', model: 'deepseek-flash', workspace: 'code', calls: 1, uncachedInput: 1000, cacheRead: 0, cacheWrite: 0, output: 100 },
          ],
        },
      },
    }
    await mkdir(join(home, 'token-diet'), { recursive: true })
    await writeFile(join(home, 'token-diet', 'index.v1.json'), JSON.stringify(cache), 'utf8')

    const index = createUsageIndex({ home, logger: {} })
    // Race: read before the cache is loaded.
    assert.deepEqual(index.rows(), [], 'nothing is indexed yet')
    await index.init()
    assert.equal(index.rows().length, 1, 'the loaded cache reaches the memoized view')
    assert.equal(index.rows()[0].uncachedInput, 1000)
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 40 }).catch(() => {})
  }
})
