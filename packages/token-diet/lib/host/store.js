/**
 * A tiny durable JSON file store.
 *
 * Every persisted artifact of this plugin (`prices.v1.json`, `rate.v1.json`,
 * `index.v1.json`, `budgets.v1.json`) is a *derived cache*: deleting it must be
 * safe, and a corrupt file must never take the plugin down. This module is the
 * single place that knows how to read and atomically replace such a file.
 *
 * Guarantees:
 *
 * - `load()` never throws. A missing, unreadable or unparsable file yields
 *   `defaults()` and a warning; the parsed value is memoized so repeat reads are
 *   free.
 * - `save()` never throws. It writes `<file>.tmp-<random>` in the same directory
 *   and renames it over the target, so a crash mid-write cannot truncate the
 *   previous good file, and it creates the parent directory first.
 * - `update(fn)` serializes read-modify-write cycles through a promise chain, so
 *   two concurrent updates cannot lose each other's changes.
 * - `file === null | undefined` makes the store memory-only: it still answers
 *   `load` / `save` / `update` from an in-memory value.
 *
 * Only `node:*` builtins are imported, matching the plugin's hard constraint
 * that no `@deepseek-ai/*` runtime dependency exists.
 *
 * @module dsh-token-diet/lib/host/store
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * Create a JSON-file-backed store.
 *
 * @param {object} options Store options.
 * @param {string | null | undefined} options.file Absolute path of the JSON file,
 *   or `null`/`undefined` for a memory-only store.
 * @param {{ warn?: (...args: any[]) => void, error?: (...args: any[]) => void }} [options.logger]
 *   Optional logger; failures are reported through it and never thrown.
 * @param {() => any} [options.defaults] Factory for the value used when the file is
 *   absent or unreadable. Defaults to `() => null`.
 * @returns {{ load: () => Promise<any>, save: (value: any) => Promise<void>, update: (fn: (current: any) => any) => Promise<any> }}
 *   The store. Methods never reject.
 */
export function createJsonStore({ file, logger, defaults = () => null } = {}) {
  const path = typeof file === 'string' && file.length > 0 ? file : null
  const fallback = typeof defaults === 'function' ? defaults : () => null

  /** Memoized parsed value; `undefined` until the first successful load. */
  let cached
  /** In-memory value for a memory-only store. */
  let memory = fallback()
  /** Serializes `update()` calls; never rejects. */
  let chain = Promise.resolve()

  /**
   * Read and parse the file, logging and returning `undefined` on any failure.
   *
   * @returns {Promise<any | undefined>} The parsed value, or `undefined` when the
   *   file is missing, unreadable or not valid JSON.
   */
  async function readFileValue() {
    if (path === null) return memory
    try {
      const text = await readFile(path, 'utf8')
      const parsed = JSON.parse(text)
      return parsed
    } catch (error) {
      // ENOENT is the normal first-run state; everything else is worth a warning.
      if (error?.code === 'ENOENT') return undefined
      warn(`[token-diet] cannot read ${path}: ${describe(error)}`)
      return undefined
    }
  }

  /**
   * Atomically replace the file with `value`.
   *
   * @param {any} value JSON-serializable value to persist.
   * @returns {Promise<void>} Resolves after the rename (or immediately for a
   *   memory-only store); failures are logged, not thrown.
   */
  async function writeFileValue(value) {
    if (path === null) {
      memory = value
      return
    }
    const directory = dirname(path)
    const temporary = join(directory, `${basename(path)}.tmp-${randomBytes(6).toString('hex')}`)
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await rename(temporary, path)
    } catch (error) {
      warn(`[token-diet] cannot write ${path}: ${describe(error)}`)
      // Best-effort cleanup so a failed write does not litter the directory.
      await unlink(temporary).catch(() => {})
    }
  }

  /** Report one failure through the optional logger, tolerating a throwing logger. */
  function warn(message) {
    try {
      logger?.warn?.(message)
    } catch {
      /* logging must never break the store */
    }
  }

  /**
   * Load the persisted value, memoized after the first call.
   *
   * @returns {Promise<any>} The stored value, or `defaults()` when absent/corrupt.
   */
  async function load() {
    if (cached !== undefined) return cached
    const value = await readFileValue()
    // A `null` file body is indistinguishable from "no value yet" here, so both
    // fall back to `defaults()`; every caller in this plugin expects an object.
    cached = value === undefined || value === null ? fallback() : value
    return cached
  }

  /**
   * Persist a value and refresh the memoized copy.
   *
   * @param {any} value The complete new value (not a patch).
   * @returns {Promise<void>} Resolves when the write settled.
   */
  async function save(value) {
    await writeFileValue(value)
    cached = value
    if (path === null) memory = value
  }

  /**
   * Read-modify-write in one serialized step.
   *
   * Concurrent callers run one after another, so each sees the previous caller's
   * result. A throwing `fn` is logged and leaves the value untouched.
   *
   * @param {(current: any) => any} fn Receives the current value, returns the next
   *   value. Returning `undefined` keeps the current value (useful for read-only
   *   visits).
   * @returns {Promise<any>} The value now stored.
   */
  function update(fn) {
    const run = chain.then(async () => {
      const current = await load()
      let next
      try {
        next = fn(current)
      } catch (error) {
        warn(`[token-diet] store update for ${path ?? 'memory'} failed: ${describe(error)}`)
        return current
      }
      if (next === undefined) return current
      await writeFileValue(next)
      cached = next
      if (path === null) memory = next
      return next
    })
    // Keep the chain alive even if `fn` or a write rejects unexpectedly.
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  return { load, save, update }
}

/** A compact one-line description of an unknown error value. */
function describe(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
