# dsh-token-diet — implementation contract

This file is the single source of truth for module boundaries. Every teammate writes only the files
listed under "Ownership" for their task, and must match the interfaces below exactly.

Docs: [README](../README.md) · [架构与模块契约](ARCHITECTURE.md) · [安装与自检](INSTALL.md) · [开发](DEVELOPMENT.md)

## Product

A DeepSeek Harness (DSH) plugin, package name **`dsh-token-diet`**, that

1. adds a **Token 统计** page (sidebar global entry + `main` panel) aggregating token usage and cost
   across every session, sub-agent run and scheduled session, with per-model / per-workspace
   breakdowns, models.dev pricing, CNY/USD display and an exchange rate;
2. adds a **per-session budget field** next to the composer's model selector, a **budget-reached
   popover**, and a **budget guard** that stops the agent's next model request when the session
   (including its sub-agents) reaches the limit.

UI reference: the Chinese copy in `packages/token-diet/locale/*.json` and `TD.dicts` inside
`src/client/*.js` is authoritative; screenshots and the demo GIF live in `docs/media/`. dsh component
look-and-feel must be reused via `--dsw-alias-*` theme tokens only; never import `@deepseek-ai/*`
packages from the client bundle.

The promo video project (`promo/` and a private `token-diet-showcase` package) is author-private and
neither is part of the published plugin.

## Repository layout

```
dsh-token-diet/
├─ package.json                     workspace root (private)
├─ scripts/build-client.mjs         concatenates src/client/*.js -> lib/client.js
├─ docs/ARCHITECTURE.md             this contract
├─ packages/token-diet/             the installable bundle (package name dsh-token-diet)
│  ├─ package.json                  exports + dsh.bundle.patch + dsh.client
│  ├─ cordis.patch.yml
│  ├─ icon.svg
│  ├─ locale/en.json  locale/zh.json      display metadata (meta.title/meta.description)
│  ├─ src/client/01-util.js         shared client helpers            (Lead)
│  ├─ src/client/02-page.js         Token 统计 page                  (teammate: client-page)
│  ├─ src/client/03-composer.js     budget field + popover + notice  (teammate: client-composer)
│  ├─ src/client/04-main.js         locale + slot wiring             (Lead)
│  ├─ lib/client.js                 BUILD OUTPUT — do not edit by hand
│  ├─ lib/index.js                  host entry (Lead)
│  ├─ lib/shared/billing.js         pure billing/aggregation         (Lead)
│  ├─ lib/host/store.js             JSON file store                  (teammate: host-data)
│  ├─ lib/host/rates.js             exchange rate                    (teammate: host-data)
│  ├─ lib/host/pricing.js           models.dev + custom + fuzzy      (teammate: host-data)
│  ├─ lib/host/index-store.js       session scan + live fold         (teammate: host-data)
│  ├─ lib/host/budget.js            budget persistence + guard       (teammate: host-budget)
│  ├─ lib/host/rpc.js               RPC channel endpoint table       (teammate: host-budget)
├─ test/*.test.mjs                  node:test suites
├─ docs/                            architecture, install, development, media/
└─ README.md
```

`lib/client.js` is generated: `node scripts/build-client.mjs`.

## Hard constraints (verified against this DSH build)

- **No `@deepseek-ai/*` runtime imports.** Host modules import only `node:*` builtins and each
  other (relative). The client bundle requires only `react`. This keeps the plugin independent of
  DSH internals; every DSH surface is reached through `ctx`.
- **Never append a new session event type.** `KNOWN_SESSION_EVENT_TYPES` is a closed set; a log
  carrying an unknown type is refused on reopen unless the event is `ignorable`, and live
  `Session.append()` cannot set that marker. Budget state therefore lives in our own JSON store.
- **Client half is one plain-JS bundle** in the `window.__ModuleLoader__.load({ id, factory(require) })`
  format (id must equal the package name). No JSX, no TS, no relative `require`.
- **Client → host transport** is the generic Connection RPC channel:
  - host: `ctx.connection.rpc.handle('/token-diet', handler)`
  - client: `ctx.connection.rpc.call('/token-diet', endpoint, payload)` →
    `{ ok: true, value } | { ok: false, error: { code, message, details } }`
  Fall back to a raw `fetch('token-diet/' + endpoint, { method:'POST', headers:{'content-type':'application/json'},
  body: JSON.stringify({ type:'client-request', rpcId, method: endpoint, payload }) })` only when
  the `connection` service is unavailable. The channel path is `token-diet` (no leading slash on
  the client side; the client helper strips it).
- Optional host services must be resolved with `ctx.get(name)` + undefined checks so the plugin
  stays inert in a composition without them.
- All persisted files live in `<DSH_HOME>/token-diet/`:
  `prices.v1.json`, `rate.v1.json`, `index.v1.json`, `budgets.v1.json`. Files are derived caches;
  deleting any of them must be safe.

## Shared data shapes

```ts
type Bucket = {                        // one (day, provider, model, workspace) cell
  date: string                         // local date YYYY-MM-DD, from event.time
  provider: string; model: string; workspace: string
  calls: number                        // assistant messages with a provider usage sample
  uncachedInput: number; cacheRead: number; cacheWrite: number; output: number
}
type Price = {                         // USD per 1M tokens
  input: number; output: number; cacheRead: number; cacheWrite: number
}
type PriceResolution = {
  price: Price
  source: 'models.dev' | 'custom'
  confidence: 'exact' | 'model-alias' | 'alias' | 'cross-provider' | 'fuzzy' | 'custom'
  matchedProvider: string; matchedModel: string
}
type RateSnapshot = {
  cnyPerUsd: number
  source: 'open.er-api.com' | 'frankfurter' | 'builtin' | 'manual'
  fetchedAt: string                    // ISO
  error?: string                       // last refresh failure message
}
type SessionBudget = { limit: number; currency: 'CNY' | 'USD'; setAt: string }
type BudgetReach = { spent: number; limit: number; currency: 'CNY'|'USD'; at: string }
```

Cost (USD) of one bucket:
`(uncachedInput*input + cacheRead*cacheRead + cacheWrite*cacheWrite + output*output) / 1e6`.
Display cost = `usd * rate` when currency is CNY.

Usage semantics: `TokenUsage.inputTokens` is the **uncached** prompt input; cache traffic is
reported separately in `cacheReadTokens` / `cacheWriteTokens` (confirmed in token-meter's
`usage-projection.ts`). Buckets come from `assistant/message` events that carry `data.usage` (or an
`assistant/attempt` carrying a `usage` stream chunk), with `message.source.provider` /
`message.source.model`.

## Host module interfaces

### `lib/shared/billing.js` (Lead)

Pure functions, no I/O, imported by host modules and by tests.

```js
export const ZERO_BUCKETS = { uncachedInput:0, cacheRead:0, cacheWrite:0, output:0 }
export function tokensOf(buckets)                  // -> total tokens of one bucket/cell
export function normalizePrice(p)                  // cacheRead/cacheWrite default to input
export function costUsd(buckets, price)            // -> number
export function dayOf(epochMs, timeZoneOffsetMin)  // -> 'YYYY-MM-DD' local date
export function aggregate(rows)                    // -> { totals, byDay:[], byModel:[], byWorkspace:[] }
export function localDateKey(ms)                   // local date for a timestamp
```

### `lib/host/store.js` (host-data)

```js
export function createJsonStore({ file, logger, defaults = () => null })
// -> { async load(): Promise<any>, async save(value): Promise<void>, async update(fn): Promise<any> }
```
Atomic write (tmp file + rename), creates the parent directory, swallowed-and-logged failures,
`undefined`/`null` `file` means memory-only.

### `lib/host/rates.js` (host-data)

```js
export function createRateService({ home, logger, config, fetchImpl })
// -> {
//   async init(): Promise<void>                     // load cache, refresh when stale
//   current(): RateSnapshot                         // never throws; builtin 7.20 fallback
//   async refresh(force?: boolean): Promise<RateSnapshot>
//   async setOverride(cnyPerUsd: number | null): Promise<RateSnapshot>
//   config: { refreshMs: number, overridden: number | null }
// }
```
Primary `https://open.er-api.com/v6/latest/USD` (`rates.CNY`), fallback
`https://api.frankfurter.app/latest?from=USD&to=CNY` (`rates.CNY`), accept only `5 <= value <= 10`,
otherwise treat as failure. 12 h TTL, manual override wins and persists.

### `lib/host/pricing.js` (host-data)

```js
export function createPricingService({ home, logger, config, fetchImpl })
// -> {
//   async init(): Promise<void>
//   meta(): { source: 'models.dev'|'cache'|'none', fetchedAt: string|null, refreshing: boolean, error?: string }
//   async refresh(force?: boolean): Promise<meta>
//   resolve(provider, model): PriceResolution | null   // synchronous, uses the loaded table
//   suggestions(provider, model, limit?): Array<{provider, model, score}>  // for the add-price dialog
//   async setCustom(provider, model, price | null): Promise<void>   // null removes
//   custom(): Array<{provider, model, price}>
// }
```
`https://models.dev/api.json` → `{ [providerId]: { name, models: { [modelId]: { cost: {input, output, cache_read, cache_write} } } } }`.
24 h TTL. Match order: **custom → model-name alias → exact provider+model → provider alias table → exact model id in any
provider (`cross-provider`) → normalized fuzzy match (`fuzzy`)**. Fuzzy normalization lowercases,
strips a `<vendor>/` prefix, drops `-latest|:free` style suffixes, and collapses `[._-]`; accept only
when the best candidate is unambiguous (single best score, distance below the configured threshold).
The client must show a *不精确的模糊匹配 / inexact fuzzy match* badge for `fuzzy`, and word the
add-price dialog for `cross-provider` and `fuzzy` differently.
Provider aliases (extend as needed): `magpie -> deepseek` (it fronts DeepSeek models),
`owlapi`, `cmdc`, `openai-codex`, `deepseek-*` → `deepseek`.

**Model-name aliases** (confidence `model-alias`, badged *模型映射 / Model mapping*) canonicalise
spellings of one model and outrank every models.dev lookup, so a reseller listing the same model under
its own id or rate cannot change what it costs. Keys are normalized like the fuzzy path, so a vendor
prefix, separator style or packaging suffix all reach one key. Built-ins:

```js
'deepseek-v4.1-flash' → deepseek/deepseek-flash   // also reached by workbuddy-ai/…, cmdc/…, etc.
'deepseek-flash'      → deepseek/deepseek-flash
```

An alias whose target is absent from the current table falls through to the generic tiers instead of
reporting a price it cannot justify; a custom price still wins over an alias. Extend with
`config.modelAliases` (`{ '<model id or spelling>': '<provider>/<model>' }`).

### `lib/host/index-store.js` (host-data)

```js
export function createUsageIndex({ home, logger, config, sessionPersistence, agents, getRate })
// -> {
//   async init(): Promise<void>                  // load cache then background-scan changed sessions
//   progress(): { state:'idle'|'scanning'|'ready', done:number, total:number }
//   async scan(force?: boolean): Promise<void>   // list/stat/open; batches of ~8 with setImmediate yields
//   onEvent(session, event): void                // live fold from the session/event listener
//   rows(): Bucket[]                             // full index (already deduplicated by fork offset)
//   sessionUsage(sessionId): { buckets: Bucket[] } | undefined
//   headers(): Map<string, {cwd?:string, parentSession?:string, origin?:string, createdAt:number}>
//   resolveRoot(sessionId): string               // walk parentSession chain
// }
```
Scan: `sessionPersistence.list()` → snapshot `{header, revision, eventCount, sizeBytes}`; reuse the
cached entry when `revision` is unchanged; otherwise `open(id,'read')` + `handle.read()` and fold.
Only events with `seq > inheritedEventCount` count (forks dedupe), and only
`assistant/message`/`assistant/attempt` with usage do. Workspace label = `basename(cwd)` or
`默认工作区` when absent.

### `lib/host/budget.js` (host-budget)

```js
export function createBudgetService({ home, logger })
// -> {
//   async init(): Promise<void>
//   get(sessionId): SessionBudget | null
//   async set(sessionId, limit: number | null, currency: 'CNY'|'USD'): Promise<void>
//   reach(sessionId): BudgetReach | null
//   async markReached(sessionId, reach): Promise<void>
//   async clearReached(sessionId): Promise<void>
//   async inherit(parentId, childId): Promise<void>       // fork copies the parent's budget
//   pending(sessionId): Promise<'raised'|'dismissed'|'timeout'> | null  // see guard below
// }
```

### `lib/host/rpc.js` (host-budget)

```js
export function installRpc({ ctx, services })
// services = { index, pricing, rates, budgets, guard, config }
// -> () => void
```
Registers `ctx.connection.rpc.handle('/token-diet', handler)` and returns the disposer. The handler
receives `(endpoint, payload, signal, peer)` and returns `{ ok:true, value }` or
`{ ok:false, error:{ code:'bad-request'|'internal'|'unsupported', message, details:{} } }`.

| endpoint | payload | value |
|---|---|---|
| `summary` | `{ range:7\|30\|90, currency:'CNY'\|'USD' }` | `{ range, currency, rate, kpis, trend, byModel, byWorkspace, missing, progress, pricesMeta }` |
| `prices` | `{}` | `{ rows, meta, rate }` |
| `refreshPrices` | `{}` | same as `prices` |
| `setCustomPrice` | `{ provider, model, input, output, cacheRead?, cacheWrite? }` | `{ rows, meta, rate }` |
| `removeCustomPrice` | `{ provider, model }` | `{ rows, meta, rate }` |
| `rate` | `{}` | `{ rate }` |
| `refreshRate` | `{}` | `{ rate }` |
| `setRateOverride` | `{ cnyPerUsd: number \| null }` | `{ rate }` |
| `sessionCost` | `{ sessionId }` | `{ spent, limit, currency, reached, unpriced, rate }` |
| `setBudget` | `{ sessionId, limit: number\|null, currency }` | same as `sessionCost` |
| `raiseBudgetAndContinue` | `{ sessionId, limit, currency }` | `{ ...sessionCost, continued: boolean }` |
| `dismissBudget` | `{ sessionId }` | `{ ok: true }` |
| `indexStatus` | `{}` | `{ progress }` |

`kpis` = `{ totalTokens, costUsd, costDisplay, cacheHitRate, dailyCostUsd, dailyCostDisplay, prev:{...}, calls, missingCount, unpricedTokens }`.
`trend` = `[{ date, uncachedInput, cacheRead, output, costUsd }]` for every day of the range.
`byModel` = `[{ provider, model, calls, input, cacheRead, output, cacheHitRate, costUsd, source, confidence, missing }]`.
`byWorkspace` = `[{ workspace, tokens, share, costUsd, costDisplay }]`.
`missing` = `[{ provider, model, tokens, suggestion }]` where `suggestion` is a
`{ provider, model, confidence }` candidate or `null`.
Counts and money in these payloads are rounded to keep the wire small; `costUsd` keeps 6 decimals.

## Client module contract

`lib/client.js` is generated from `src/client/*.js`. All parts run inside **one factory closure** and
share a namespace object `TD` (`const TD = {}`), plus `React` and `h = React.createElement`.

Each part appends to `TD.dicts`, shaped `{ en: { 'kebab.key': 'text' }, zh: { ... } }`.

- `01-util.js` (Lead): `TD.util = { fmtTokens, fmtCost, fmtPct, fmtNum, cn, rpc(ctx, method, payload), formatDate, colorFor }`, `TD.dicts` base keys (`page.title`, `page.subtitle`, `common.*`).
- `02-page.js` (client-page): `TD.StatsPage = function StatsPage(props) {...}` — the whole `main` panel. Owns its strings; adds them to `TD.dicts`.
- `03-composer.js` (client-composer): `TD.BudgetField`, `TD.BudgetPopover`, `TD.BudgetNotice` components; owns its strings.
- `04-main.js` (Lead): registers locale dicts and the four slots, wires RPC polling, exports `{ inject, apply }`.

Slot registrations (all under `ctx.slots.inject(key, () => ctx.slots.register(options, Component))`):

| slot | id/key | component |
|---|---|---|
| `sidebar.panellist` | `id: 'token-diet'`, `order: 20`, `label: () => t('nav.label')` | bar-chart icon, props `{ size, active }` |
| `main` | `key: 'token-diet'` | `TD.StatsPage` |
| `conversation.input.right` | `id: 'token-diet-budget'`, `order: -10` | `TD.BudgetField` |
| `conversation.input.overlay` | `id: 'token-diet-budget-popover'`, `order: 50` | `TD.BudgetPopover` |

The budget field and popover both receive `sessionId` and the slot's standard props
(`useSession`, `useProjection`, `useProjection('tokenUsage')` etc.). Poll
`sessionCost({sessionId})` every **1500 ms** while mounted (cheap local RPC) and immediately after
any of: mount, session id change, `tokenUsage` projection change, budget submit, popover open/close.
The stats page polls `summary` on mount, on range/currency change, and every 10 s while indexing is
not `ready`.

Styling: only `--dsw-alias-*` tokens (see the Theme inspect provider); no literal colors except in
inline SVG artwork. Namespaced class names, injected once via a `<style>` element created inside
`apply` with `ctx.effect(() => cleanup)`.

## Budget guard semantics

`ctx.on('agent/pre-step', async (payload, next) => ...)`:

1. `root = services.index.resolveRoot(payload.agent.id)`; `budget = budgets.get(root)`.
2. If no budget or `spent < limit` → `return next()`.
3. Otherwise `budgets.markReached(root, {spent, limit, currency, at})`, publish the state to the
   client (the client polls `sessionCost`, so no push channel is needed), then **hold** the step:
   await a promise that settles on `setBudget`/`raiseBudgetAndContinue` (`'raised'`),
   `dismissBudget` (`'dismissed'`), `payload.signal.aborted` (`'aborted'`) or the configured hold
   timeout (`config.budgetHoldMs`, default 300000 ms).
   - `'raised'` → `return next()` so the same step proceeds with no new model-visible message.
   - anything else → `return { kind: 'reject' }`; the turn ends without issuing the request.
4. `raiseBudgetAndContinue` raises the limit, clears the reach marker and resolves the hold with
   `'raised'`; the popover then closes.

When the agent is idle (the turn already ended because the user dismissed the popover), the user's
next message hits step 3 again and is blocked before any request leaves the machine — that is the
"超预算时再发消息" behaviour.

## Files each owner may write

| owner | files |
|---|---|
| Lead | `package.json`, `scripts/build-client.mjs`, `docs/ARCHITECTURE.md`, `README.md`, `packages/token-diet/{package.json,cordis.patch.yml,icon.svg,lib/index.js,src/client/01-util.js,src/client/04-main.js}`, `packages/token-diet/lib/shared/billing.js` |
| host-data | `packages/token-diet/{lib/host/store.js,lib/host/rates.js,lib/host/pricing.js,lib/host/index-store.js}` |
| host-budget | `packages/token-diet/{lib/host/budget.js,lib/host/rpc.js}` |
| client-page | `packages/token-diet/src/client/02-page.js` |
| client-composer | `packages/token-diet/src/client/03-composer.js` |
| qa-docs | `packages/token-diet/locale/{en,zh}.json`, `test/**`, `README.md` (Lead reviews) |

Nobody else edits `lib/client.js` (generated), and nobody edits another owner's files; report a
contract mismatch instead.
