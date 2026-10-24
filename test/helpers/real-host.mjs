/**
 * Boot the real Host half against this machine's real caches, inside a
 * throw-away Harness home.
 *
 * The "real data" tests want to render the client against the exact payloads
 * the Host produces from real session logs. Rather than re-implementing the
 * endpoint table, this boots `apply()` from `lib/index.js` with its four real
 * services and answers through the registered `/token-diet` channel — so the
 * payloads, including the pricing match and the budget guard, come from shipped
 * code.
 *
 * The real home is never written to: the cache files are copied into a temp
 * home first, and the refresh TTLs are pushed out so nothing reaches the network.
 */

import { copyFile, mkdir, mkdtemp, readFile, rm, access } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeCtx, waitFor } from './harness.mjs'

const CACHE_FILES = ['index.v1.json', 'prices.v1.json', 'rate.v1.json']

/** Resolve the live Harness home the same way the plugin does. */
export function realHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** True when this machine has an index cache worth testing against. */
export async function hasRealCaches(home = realHome()) {
  try {
    await access(join(home, 'token-diet', 'index.v1.json'))
    return true
  } catch {
    return false
  }
}

/**
 * Copy the live caches into a temp home and boot the plugin against it.
 *
 * @param {{ home?: string }} [options]
 * @returns {Promise<{
 *   call: (channel: string, method: string, payload?: object) => Promise<any>,
 *   progress: () => object,
 *   home: string,
 *   dispose: () => Promise<void>,
 * } | null>} `null` when this machine has no cache.
 */
export async function bootRealHost(options = {}) {
  const source = options.home ?? realHome()
  if (!(await hasRealCaches(source))) return null

  const home = await mkdtemp(join(tmpdir(), 'token-diet-real-'))
  await mkdir(join(home, 'token-diet'), { recursive: true })
  for (const file of CACHE_FILES) {
    try {
      await copyFile(join(source, 'token-diet', file), join(home, 'token-diet', file))
    } catch {
      /* an optional cache may be missing; the services degrade on their own */
    }
  }

  const ctx = createFakeCtx()
  const { apply } = await import('../../packages/token-diet/lib/index.js')
  apply(ctx, {
    home,
    // Never refresh over the network during a test.
    priceRefreshHours: 24 * 365 * 10,
    rateRefreshHours: 24 * 365 * 10,
  })

  const ready = await waitFor(async () => {
    try {
      const summary = await ctx.invokeRpc('summary', { range: 30 })
      return (summary?.value?.kpis?.totalTokens ?? 0) > 0 || summary?.value?.progress?.state === 'ready'
    } catch {
      return false
    }
  }, 15_000)

  if (!ready) {
    await ctx.dispose().catch(() => {})
    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {})
    return null
  }

  // The copied index, for tests that need a real session id to drive the budget
  // field with.
  let index = { sessions: {} }
  try {
    index = JSON.parse(await readFile(join(home, 'token-diet', 'index.v1.json'), 'utf8'))
  } catch {
    /* the RPC payloads are enough for most assertions */
  }

  return {
    home,
    index,
    /** Call one endpoint exactly as `connection.rpc.call` does. */
    call(channel, method, payload) {
      if (channel !== '/token-diet') {
        return Promise.resolve({
          ok: false,
          error: { code: 'bad-request', message: `unknown channel ${channel}`, details: {} },
        })
      }
      return ctx.invokeRpc(method, payload ?? {})
    },
    progress: () => ctx.invokeRpc('indexStatus', {}),
    async dispose() {
      await ctx.dispose().catch(() => {})
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => {})
    },
  }
}