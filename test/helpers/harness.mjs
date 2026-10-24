/**
 * End-to-end host harness: boots `apply()` from lib/index.js against a fake Cordis
 * context and a fake SessionPersistence, so the index, the pricing/rate/预算
 * services, the RPC table and the budget guard can be exercised without DSH.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Build one fake session-persistence snapshot plus its events. */
export function fakeSession({ id, cwd, createdAt = Date.now(), parentSession, events }) {
  const header = {
    version: 4,
    id,
    createdAt,
    cwd,
    isSeeded: parentSession !== undefined,
    ...(parentSession === undefined ? {} : { parentSession }),
  }
  return {
    header,
    snapshot: { header, revision: `${id}:1`, eventCount: events.length, sizeBytes: 1024 },
    events,
  }
}

/** One `assistant/message` event carrying provider usage. */
export function assistantEvent({ seq, time, turn = 1, step = 1, provider, model, usage }) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn,
      step,
      message: {
        role: 'assistant',
        source: { kind: 'model', provider, model },
        content: [{ type: 'text', text: 'ok' }],
      },
      stream: [],
      usage,
    },
  }
}

/** A fake `ctx` with the cordis members lib/index.js touches. */
export function createFakeCtx({ sessions, persistence, logger } = {}) {
  const listeners = new Map()
  const disposers = []
  const rpcHandlers = new Map()
  const services = new Map()
  const log = []
  const fakeLogger = logger ?? {
    debug: (...args) => log.push(['debug', ...args]),
    info: (...args) => log.push(['info', ...args]),
    warn: (...args) => log.push(['warn', ...args]),
    error: (...args) => log.push(['error', ...args]),
  }

  const eventSink = (name) => {
    const list = listeners.get(name) ?? []
    listeners.set(name, list)
    return list
  }

  /** Run one injection callback with a scope whose effects are tracked. */
  function settle(record) {
    record.applied = true
    const scopeDisposers = []
    const scope = {
      get: (name) => services.get(name),
      on: (...args) => ctx.on(...args),
      effect: (fn) => {
        const disposer = typeof fn === 'function' ? fn() : undefined
        if (typeof disposer === 'function') scopeDisposers.push(disposer)
        return () => {}
      },
      dispose: () => {
        for (const disposer of scopeDisposers.reverse()) {
          try {
            disposer()
          } catch {
            /* best effort */
          }
        }
      },
    }
    record.scope = scope
    try {
      record.callback(scope)
    } catch {
      /* a failing injection is the caller's problem; tests assert on the result */
    }
  }

  const injections = []

  const ctx = {
    logger: fakeLogger,
    get: (name) => services.get(name),
    provide: (name, value) => {
      services.set(name, value)
      return () => services.delete(name)
    },
    /**
     * Mirror Cordis' `ctx.inject(deps, callback)`: run the callback immediately
     * when every dependency is already present, otherwise keep it for
     * `__satisfy()`.
     */
    inject(deps, callback) {
      const ready = deps.every((dep) => services.has(dep))
      const record = { deps, callback, scope: null, applied: false }
      injections.push(record)
      if (ready) settle(record)
      return () => {
        record.applied = false
        record.scope?.dispose?.()
      }
    },
    /** Provide a service and re-run the injection callbacks it unblocks. */
    __satisfy(name, value) {
      services.set(name, value)
      for (const record of injections) {
        if (record.applied) continue
        if (record.deps.every((dep) => services.has(dep))) settle(record)
      }
    },
    /** Remove a service, as a disposing provider would. */
    __unprovide(name) {
      services.delete(name)
    },
    __injections: injections,
    effect: (fn) => {
      const disposer = typeof fn === 'function' ? fn() : undefined
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    on: (name, listener) => {
      const list = eventSink(name)
      list.push(listener)
      return () => {
        const index = list.indexOf(listener)
        if (index >= 0) list.splice(index, 1)
      }
    },
    emit: (name, ...args) => {
      for (const listener of listeners.get(name) ?? []) listener(...args)
    },
    /** Invoke the registered `agent/pre-step` waterfall; resolves to its decision. */
    async preStep(payload) {
      let terminal = { kind: 'enter', messages: [] }
      const chain = [...(listeners.get('agent/pre-step') ?? [])]
      let index = 0
      const next = async () => {
        if (index >= chain.length) return terminal
        const listener = chain[index]
        index += 1
        return listener(payload, next)
      }
      const outer = async () => next()
      const result = await outer()
      if (result !== undefined) terminal = result
      return result
    },
    invokeRpc: async (endpoint, payload) => {
      const handler = rpcHandlers.get('/token-diet')
      if (handler === undefined) throw new Error('no /token-diet channel registered')
      return handler(endpoint, payload, new AbortController().signal, { principal: { kind: 'owner' } })
    },
    /** Invoke one endpoint on an arbitrary registered channel. */
    invokeChannel: async (channel, endpoint, payload) => {
      const handler = rpcHandlers.get(channel)
      if (handler === undefined) throw new Error(`no ${channel} channel registered`)
      return handler(endpoint, payload, new AbortController().signal, { principal: { kind: 'owner' } })
    },
    channels: () => [...rpcHandlers.keys()],
    rpcRegistered: () => rpcHandlers.has('/token-diet'),
    logs: log,
    async dispose() {
      for (const disposer of disposers.reverse()) {
        try {
          await disposer()
        } catch {
          /* dispose is best effort */
        }
      }
    },
  }

  // A connection service standing in for dsh-client-connection's host half.
  ctx.provide('connection', {
    rpc: {
      handle: (channel, handler) => {
        rpcHandlers.set(channel, handler)
        return () => rpcHandlers.delete(channel)
      },
    },
  })

  // A web server double, used by the fallback carrier.
  const webRoutes = new Map()
  ctx.provide('webServer', {
    host: '127.0.0.1',
    register(route) {
      webRoutes.set(route.path, route)
      return () => webRoutes.delete(route.path)
    },
    /** Invoke a registered prefix route with a synthetic request/response. */
    async request(pathname, { method = 'POST', body, headers = {} } = {}) {
      const route = webRoutes.get('/token-diet')
      if (route === undefined) throw new Error('no /token-diet web route registered')
      const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body ?? {}))
      const request = {
        method,
        url: pathname,
        headers: { host: '127.0.0.1:50963', 'content-type': 'application/json', ...headers },
        async *[Symbol.asyncIterator]() {
          yield payload
        },
      }
      const captured = { status: 0, headers: {}, body: '' }
      const response = {
        headersSent: false,
        writeHead(status, responseHeaders) {
          captured.status = status
          captured.headers = responseHeaders ?? {}
          this.headersSent = true
        },
        end(text) {
          captured.body = text ?? ''
        },
      }
      await route.handler(request, response)
      let json
      try {
        json = JSON.parse(captured.body)
      } catch {
        json = undefined
      }
      return { ...captured, json }
    },
    routes: webRoutes,
  })

  ctx.webRoutes = webRoutes

  if (persistence !== undefined) ctx.provide('sessionPersistence', persistence)
  if (sessions !== undefined) ctx.provide('agents', sessions)

  return ctx
}

/** A SessionPersistence double over an array of fake sessions. */
export function createFakePersistence(entries, options = {}) {
  const byId = new Map(entries.map((entry) => [entry.header.id, entry]))
  return {
    list: async () => [...byId.values()].map((entry) => entry.snapshot),
    async stat(id) {
      return byId.get(id)?.snapshot
    },
    async open(id, access) {
      const entry = byId.get(id)
      if (entry === undefined) throw new Error(`no session ${id}`)
      return {
        id,
        header: entry.header,
        inheritedEventCount: options.inheritedEventCount?.[id] ?? 0,
        access,
        read: async () => ({ eventState: 'detached', events: entry.events }),
        append: async () => {},
        flush: async () => {},
        close: async () => {},
      }
    },
  }
}

/** A temporary DSH home for one test. */
export async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), 'token-diet-test-'))
  try {
    return await run(home)
  } finally {
    // Background scans may still hold a write handle; retry a few times so a
    // transient ENOTEMPTY does not fail an otherwise passing test.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  }
}

/** Wait until `predicate()` is truthy or the timeout elapses. */
export async function waitFor(predicate, timeoutMs = 3000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  return false
}
