/* Token 统计 page — the whole `main` panel. Owns its strings (page.*). */

TD.dicts = TD.dicts || { en: {}, zh: {} }

;(function () {
  /* ==================================================================== */
  /* pure helpers — exported on TD.page so the chart math is testable      */
  /* ==================================================================== */

  function num(value) {
    return typeof value === 'number' && isFinite(value) ? value : 0
  }

  function merge(base, patch) {
    var out = {}
    var key
    for (key in base || {}) {
      if (Object.prototype.hasOwnProperty.call(base, key)) out[key] = base[key]
    }
    for (key in patch || {}) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) out[key] = patch[key]
    }
    return out
  }

  /** Replace `{name}` placeholders; never throws on missing params. */
  function fill(template, params) {
    if (template === null || template === undefined) return ''
    var out = String(template)
    var table = params || {}
    Object.keys(table).forEach(function (key) {
      out = out.split('{' + key + '}').join(String(table[key]))
    })
    return out
  }

  /**
   * Relative change between two periods.
   * -> { dir: 'up'|'down'|'flat', ratio, hasPrev }
   */
  function deltaOf(previous, current) {
    var before = num(previous)
    var after = num(current)
    if (before <= 0) {
      return { dir: after === 0 ? 'flat' : 'up', ratio: null, hasPrev: false }
    }
    var ratio = (after - before) / before
    if (ratio > 0.0005) return { dir: 'up', ratio: ratio, hasPrev: true }
    if (ratio < -0.0005) return { dir: 'down', ratio: Math.abs(ratio), hasPrev: true }
    return { dir: 'flat', ratio: 0, hasPrev: true }
  }

  /** Normalize the `trend` payload into per-day rows with a token total. */
  function trendRows(trend) {
    if (!Array.isArray(trend)) return []
    return trend.map(function (day) {
      var cacheRead = num(day && day.cacheRead)
      var uncached = num(day && day.uncachedInput)
      var output = num(day && day.output)
      return {
        date: String((day && day.date) || ''),
        cacheRead: cacheRead,
        uncached: uncached,
        output: output,
        tokens: cacheRead + uncached + output,
        costUsd: num(day && day.costUsd),
      }
    })
  }

  /**
   * Chart geometry (all maths, no DOM):
   * `y(value)` maps a value to a pixel row, `barX(i)` the left edge of bar i,
   * `baseline` the pixel row of zero.
   */
  function chartGeometry(options) {
    var opts = options || {}
    var width = Math.max(320, num(opts.width) || 860)
    var height = num(opts.height) || 240
    var padding = opts.padding || { top: 10, right: 8, bottom: 26, left: 50 }
    var count = Math.max(1, num(opts.count) || 1)
    var rawMax = num(opts.max)
    var max = rawMax > 0 ? rawMax : 1
    var innerWidth = Math.max(1, width - padding.left - padding.right)
    var innerHeight = Math.max(1, height - padding.top - padding.bottom)
    var step = innerWidth / count
    var barWidth = Math.max(2, step * 0.64)
    function y(value) {
      var ratio = Math.max(0, Math.min(1, num(value) / max))
      return padding.top + innerHeight * (1 - ratio)
    }
    function barX(index) {
      return padding.left + num(index) * step + step * 0.18
    }
    return {
      width: width,
      height: height,
      padding: padding,
      count: count,
      max: max,
      step: step,
      barWidth: barWidth,
      innerWidth: innerWidth,
      innerHeight: innerHeight,
      baseline: height - padding.bottom,
      y: y,
      barX: barX,
    }
  }

  /** X label density: one label per N bars. */
  function tickStep(count) {
    var total = num(count)
    if (total > 30) return 15
    if (total > 7) return 5
    return 1
  }

  /** Stable sort of `byModel` rows: `calls` or `cost` (unpriced rows last). */
  function sortModels(rows, key) {
    var list = Array.isArray(rows) ? rows.slice() : []
    list.sort(function (a, b) {
      if (key === 'calls') return num(b && b.calls) - num(a && a.calls)
      return num(b && b.costUsd) - num(a && a.costUsd)
    })
    return list
  }

  TD.page = {
    fill: fill,
    merge: merge,
    deltaOf: deltaOf,
    trendRows: trendRows,
    chartGeometry: chartGeometry,
    tickStep: tickStep,
    sortModels: sortModels,
  }

  /* ==================================================================== */
  /* stylesheet                                                           */
  /* ==================================================================== */

  var CSS_LINES = [
    /* The scroll owner is our own root: the `main` panel cell in this harness
       computes its height from the grid, so a page that only grows is clipped
       with no scrollbar. `height:100%` resolves to the cell height when the cell
       has one and to `auto` (content height) when it does not, so both layouts
       scroll correctly. */
    '.td-scroll{height:100%;min-height:0;flex:1 1 auto;display:flex;flex-direction:column;overflow-y:auto;overflow-x:hidden}',
    /* Content column: capped for readability, centred so a wide window does not
       leave the card grid hugging the left edge. */
    '.td-page{width:100%;max-width:1180px;margin:0 auto;flex:0 0 auto;padding:28px 40px 64px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.5}',
    '.td-page *,.td-page *::before,.td-page *::after{box-sizing:border-box}',
    '.td-num{font-variant-numeric:tabular-nums}',
    '.td-muted{color:var(--dsw-alias-label-secondary)}',
    /* header */
    '.td-hdr{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:20px}',
    '.td-hdr h1{font-size:20px;margin:0;font-weight:600;letter-spacing:-.2px}',
    '.td-hdr p{margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px}',
    '.td-ctrls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
    '.td-seg{display:inline-flex;background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:3px}',
    '.td-seg button{border:0;background:none;padding:0 12px;min-height:28px;border-radius:6px;cursor:pointer;font:inherit;font-size:13px;color:var(--dsw-alias-label-secondary)}',
    '.td-seg button[aria-pressed="true"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent)}',
    '.td-seg button:hover{color:var(--dsw-alias-label-primary)}',
    '.td-seg button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
    /* Sub-page tabs live on their own row: the range selector stays in the
       header's control cluster, the page body below switches wholesale. */
    '.td-tabs{display:flex;align-items:center;margin:-6px 0 20px}',
    '.td-tabs .td-seg{padding:3px}',
    '.td-select{height:36px;min-width:96px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit;padding:0 8px;font:inherit;font-size:13px}',
    /* controls */
    '.td-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}',
    '.td-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
    '.td-btn:disabled{opacity:.55;cursor:default}',
    '.td-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);border-color:var(--dsw-alias-label-primary)}',
    '.td-btn-primary:hover{background:var(--dsw-alias-label-primary);opacity:.9}',
    '.td-btn-sm{height:28px;padding:0 10px;font-size:12.5px}',
    '.td-btn:focus-visible,.td-select:focus-visible,.td-inp:focus-visible,.td-link-btn:focus-visible,.td-th-btn:focus-visible,.td-check input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
    '.td-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px}',
    /* missing-price banner */
    '.td-warn{display:flex;gap:12px;align-items:center;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);border-radius:10px;padding:12px 14px;margin-bottom:20px}',
    '.td-warn-ic{width:32px;height:32px;border-radius:8px;background:var(--dsw-alias-bg-base);border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,var(--dsw-alias-border-l1));display:grid;place-items:center;flex:none;color:var(--dsw-alias-state-warn-primary)}',
    '.td-warn-tx{flex:1;min-width:0;font-size:13.5px}',
    '.td-warn-tx b{display:block;font-size:14px;font-weight:600}',
    '.td-warn-tx code{background:var(--dsw-alias-bg-base);border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,var(--dsw-alias-border-l1));border-radius:4px;padding:0 5px;font-family:ui-monospace,Consolas,Menlo,monospace;font-size:12.5px}',
    /* kpi */
    '.td-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}',
    '.td-kpi{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px 16px;background:var(--dsw-alias-bg-layer-1);min-width:0}',
    '.td-kpi-l{color:var(--dsw-alias-label-secondary);font-size:13px}',
    '.td-kpi-v{font-size:24px;font-weight:600;margin-top:2px;letter-spacing:-.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.td-kpi-d{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:2px}',
    '.td-up{color:var(--dsw-alias-state-error-primary)}',
    '.td-down{color:var(--dsw-alias-state-success-primary)}',
    /* sections */
    '.td-sec{font-size:14px;font-weight:600;margin:32px 0 12px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}',
    '.td-sec-more{font-weight:400;color:var(--dsw-alias-label-secondary);font-size:13px}',
    '.td-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:16px 18px;background:var(--dsw-alias-bg-layer-1)}',
    /* trend */
    '.td-legend{display:flex;gap:16px;font-size:12px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}',
    '.td-legend span{display:inline-flex;align-items:center;gap:6px}',
    '.td-legend i{width:10px;height:10px;border-radius:2px;display:block;background:var(--dsw-alias-brand-primary)}',
    '.td-legend i.td-swatch-cache{opacity:.45}',
    '.td-legend i.td-swatch-output{background:var(--dsw-alias-label-primary)}',
    '.td-chart{position:relative;margin-top:8px}',
    '.td-chart svg{display:block;width:100%;height:auto}',
    '.td-tip{position:absolute;pointer-events:none;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:12px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);white-space:nowrap;z-index:5;line-height:1.55;box-shadow:0 6px 20px color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent)}',
    '.td-tip b{font-weight:600}',
    /* table */
    '.td-tw{overflow-x:auto}',
    '.td-table{width:100%;border-collapse:collapse;font-size:13px}',
    '.td-table th,.td-table td{padding:10px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);text-align:right;white-space:nowrap}',
    '.td-table th{color:var(--dsw-alias-label-secondary);font-weight:500;font-size:12.5px}',
    '.td-table th:first-child,.td-table td:first-child{text-align:left}',
    '.td-table tbody tr:last-child td{border-bottom:0}',
    '.td-row-miss td{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 7%,transparent)}',
    '.td-model-name{font-weight:600}',
    /* The total-token column carries the number a user compares against their own
       sense of "how much did this model use", so it is emphasised over the split
       columns beside it. */
    '.td-num-strong{font-weight:600;color:var(--dsw-alias-label-primary)}',
    '.td-th-btn{border:0;background:none;color:inherit;font:inherit;font-size:12.5px;cursor:pointer;padding:0}',
    '.td-th-btn:hover{color:var(--dsw-alias-label-primary)}',
    '.td-bar{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;width:70px;display:inline-block;vertical-align:middle;margin-left:8px}',
    '.td-bar i{display:block;height:100%;background:var(--dsw-alias-brand-primary);border-radius:3px}',
    '.td-badge{font-size:11px;padding:1px 7px;border-radius:5px;font-weight:500;display:inline-block;line-height:1.6}',
    '.td-b-blue{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary)}',
    '.td-b-green{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:var(--dsw-alias-state-success-primary)}',
    '.td-b-orange{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 16%,transparent);color:var(--dsw-alias-state-warn-primary)}',
    '.td-b-gray{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',
    '.td-link-btn{border:0;background:none;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12.5px;cursor:pointer;padding:2px 4px;border-radius:4px}',
    '.td-link-btn:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}',
    '.td-badge-group{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}',
    /* workspace share */
    '.td-share{display:flex;flex-direction:column;gap:12px}',
    '.td-share-top{display:flex;justify-content:space-between;font-size:13.5px;gap:12px}',
    '.td-share-tr{height:6px;background:var(--dsw-alias-bg-layer-2);border-radius:3px;margin-top:5px;overflow:hidden}',
    '.td-share-tr i{display:block;height:100%;background:var(--dsw-alias-brand-primary);border-radius:3px}',
    /* price rows */
    '.td-rows{display:flex;flex-direction:column}',
    '.td-r{display:flex;gap:14px;align-items:center;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
    '.td-r:last-child{border-bottom:0}',
    '.td-tile{width:44px;height:44px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;display:grid;place-items:center;flex:none;background:var(--dsw-alias-bg-layer-2);font-weight:700;font-size:13px;color:var(--dsw-alias-brand-primary)}',
    '.td-tile-miss{color:var(--dsw-alias-state-warn-primary)}',
    '.td-r-main{flex:1;min-width:0}',
    '.td-r-title{font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.td-r-desc{color:var(--dsw-alias-label-secondary);font-size:13px}',
    '.td-price-foot{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px}',
    '.td-rate{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}',
    '.td-inp{width:96px;height:34px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 10px;text-align:right;font:inherit;font-size:13px}',
    /* states */
    '.td-state{border:1px dashed var(--dsw-alias-border-l1);border-radius:12px;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px;display:flex;flex-direction:column;gap:10px;align-items:center}',
    '.td-errorbar{display:flex;gap:12px;align-items:center;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:13px}',
    '.td-errorbar span{flex:1;min-width:0}',
    /* dialog */
    '.td-mask{position:fixed;inset:0;background:color-mix(in srgb,var(--dsw-alias-label-primary) 30%,transparent);display:flex;align-items:center;justify-content:center;z-index:20;padding:16px}',
    '.td-modal{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;width:440px;max-width:100%;padding:22px 24px;box-shadow:0 12px 40px color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent)}',
    '.td-modal h3{margin:0 0 4px;font-size:16px}',
    '.td-modal p{margin:0 0 16px;color:var(--dsw-alias-label-secondary);font-size:13px}',
    '.td-fg{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
    '.td-fd label{display:block;font-size:12.5px;color:var(--dsw-alias-label-secondary);margin-bottom:4px}',
    '.td-fd input,.td-fd select{width:100%;height:36px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:0 10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
    '.td-fd-full{grid-column:1/-1}',
    '.td-check{display:flex;align-items:center;gap:8px}',
    '.td-check label{display:inline;margin:0;color:var(--dsw-alias-label-primary);font-size:13px}',
    '.td-check input{width:16px;height:16px;flex:none}',
    '.td-suggest{grid-column:1/-1;display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-secondary);padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent);flex-wrap:wrap}',
    '.td-form-err{grid-column:1/-1;color:var(--dsw-alias-state-error-primary);font-size:12.5px}',
    '.td-mact{display:flex;justify-content:flex-end;gap:8px;margin-top:20px;flex-wrap:wrap}',
    '.td-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);padding:8px 16px;border-radius:8px;font-size:13px;z-index:30;box-shadow:0 8px 28px color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent)}',
    /* responsive */
    '@media (max-width:760px){.td-page{padding:20px 16px 48px}.td-kpis{grid-template-columns:repeat(2,1fr)}.td-fg{grid-template-columns:1fr}}',
    '@media (max-width:520px){.td-kpis{grid-template-columns:1fr}}',
    '@media (prefers-reduced-motion:reduce){.td-page *{transition:none!important;animation:none!important}}',
  ]

  var PAGE_CSS = CSS_LINES.join('\n')
  var STYLE_KEY = 'td-page-styles'
  var styleState = { tag: null, refs: 0 }

  /** Reference-counted page stylesheet; returns a disposer. */
  function acquireStyles() {
    if (typeof document === 'undefined' || !document.head) return function () {}
    if (styleState.tag === null) {
      var tag = document.createElement('style')
      tag.setAttribute('data-td-page', STYLE_KEY)
      tag.textContent = PAGE_CSS
      document.head.appendChild(tag)
      styleState.tag = tag
    }
    styleState.refs += 1
    var released = false
    return function () {
      if (released) return
      released = true
      styleState.refs -= 1
      if (styleState.refs > 0) return
      if (styleState.tag && styleState.tag.parentNode) {
        styleState.tag.parentNode.removeChild(styleState.tag)
      }
      styleState.tag = null
      styleState.refs = 0
    }
  }

  /* ==================================================================== */
  /* small presentational helpers                                         */
  /* ==================================================================== */

  function badge(className, text, title, key) {
    return h('span', { key: key, className: 'td-badge ' + className, title: title || undefined }, text)
  }

  function dateParts(dateKey) {
    var parts = String(dateKey || '').split('-')
    return { month: Number(parts[1]) || 0, day: Number(parts[2]) || 0 }
  }

  /** Stable identity for one (provider, model) pair; React keys and lookups. */
  function keyOf(provider, model) {
    return String(provider || '') + '\u001f' + String(model || '')
  }

  function initialsOf(model) {
    return String(model || '?').slice(0, 2).toUpperCase()
  }

  /* `TD.util.ICONS` has no refresh glyph yet and that file is not ours; keep the
     local one next to the other page-level presentational helpers. */
  function refreshIcon(size) {
    return h('svg', {
      viewBox: '0 0 24 24',
      width: size || 14,
      height: size || 14,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    },
      h('path', { d: 'M20 11.5a8 8 0 1 0-2.2 5.1' }),
      h('path', { d: 'M20 5.5v6h-6' }))
  }

  function findPriceRow(prices, provider, model) {
    var rows = prices && Array.isArray(prices.rows) ? prices.rows : []
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i]
      if (row && row.provider === provider && row.model === model) return row
    }
    return null
  }

  function normalizeSuggestion(raw) {
    if (!raw || !raw.model) return null
    return {
      provider: raw.provider || '',
      model: raw.model,
      confidence: raw.confidence || 'fuzzy',
      price: raw.price && raw.price.input !== undefined ? raw.price : null,
    }
  }

  function suggestionFor(provider, model, data, prices) {
    var missing = (data && Array.isArray(data.missing)) ? data.missing : []
    for (var i = 0; i < missing.length; i++) {
      var item = missing[i]
      if (item && item.provider === provider && item.model === model) {
        return normalizeSuggestion(item.suggestion)
      }
    }
    var row = findPriceRow(prices, provider, model)
    if (row && Array.isArray(row.suggestions) && row.suggestions.length > 0) {
      return normalizeSuggestion(row.suggestions[0])
    }
    return null
  }

  function isEmptyIndex(payload) {
    if (!payload) return true
    var kpis = payload.kpis || {}
    var models = Array.isArray(payload.byModel) ? payload.byModel : []
    if (num(kpis.totalTokens) > 0 || models.length > 0) return false
    var trend = Array.isArray(payload.trend) ? payload.trend : []
    for (var i = 0; i < trend.length; i++) {
      var day = trend[i] || {}
      if (num(day.uncachedInput) + num(day.cacheRead) + num(day.output) > 0) return false
    }
    return true
  }

  /**
   * `rate` is a plain number (CNY per USD) on every RPC response; `rateInfo`
   * carries `{ cnyPerUsd, source, fetchedAt, error }` for the price footer.
   */
  function rateFrom(data, prices) {
    var info = null
    var value = 0
    if (data && data.rateInfo && typeof data.rateInfo === 'object') info = data.rateInfo
    if (!info && prices && prices.rateInfo && typeof prices.rateInfo === 'object') info = prices.rateInfo
    if (data) {
      if (typeof data.rate === 'number') value = num(data.rate)
      else if (data.rate && typeof data.rate === 'object') value = num(data.rate.cnyPerUsd)
    }
    if (!value && prices && typeof prices.rate === 'number') value = num(prices.rate)
    if (!value && prices && prices.rate && typeof prices.rate === 'object') value = num(prices.rate.cnyPerUsd)
    if (!value && info) value = num(info.cnyPerUsd)
    return {
      value: value > 0 ? value : 7.2,
      source: info && info.source ? info.source : null,
      fetchedAt: info && info.fetchedAt ? info.fetchedAt : null,
    }
  }

  /* ==================================================================== */
  /* the page                                                             */
  /* ==================================================================== */

  TD.StatsPage = function StatsPage(props) {
    var input = props || {}
    var translate = typeof input.t === 'function' ? input.t : function (key) { return key }
    function t(key, params) {
      var text = translate(key)
      if (typeof text !== 'string' || text === '') text = key
      return params ? fill(text, params) : text
    }

    var ctx = input.ctx || TD.ctx
    var connection = React.useMemo(function () {
      if (input.connection) return input.connection
      if (!ctx) return undefined
      try {
        return TD.util.connectionOf(ctx)
      } catch (error) {
        return undefined
      }
    }, [input.connection, ctx])

    /* ---- state ---- */
    var rangeState = React.useState(30)
    var range = rangeState[0]
    var setRange = rangeState[1]

    var currencyState = React.useState('CNY')
    var currency = currencyState[0]
    var setCurrency = currencyState[1]

    /* Sub-page: `usage` (KPIs, trend, models, workspaces) or `prices` (the
       price table and its controls). `initialTab` only exists for tests and for
       embedding the page on a specific sub-page; production starts on usage. */
    var tabState = React.useState(input.initialTab === 'prices' ? 'prices' : 'usage')
    var tab = tabState[0]
    var setTab = tabState[1]

    var metricState = React.useState('tok')
    var metric = metricState[0]
    var setMetric = metricState[1]

    var sortState = React.useState('cost')
    var sortKey = sortState[0]
    var setSortKey = sortState[1]

    var loadingState = React.useState(true)
    var loading = loadingState[0]
    var setLoading = loadingState[1]

    var errorState = React.useState(null)
    var error = errorState[0]
    var setError = errorState[1]

    var dataState = React.useState(null)
    var data = dataState[0]
    var setData = dataState[1]

    var pricesState = React.useState(null)
    var prices = pricesState[0]
    var setPrices = pricesState[1]

    var pricesBusyState = React.useState(false)
    var pricesBusy = pricesBusyState[0]
    var setPricesBusy = pricesBusyState[1]

    var workspacesBusyState = React.useState(false)
    var workspacesBusy = workspacesBusyState[0]
    var setWorkspacesBusy = workspacesBusyState[1]

    var dialogState = React.useState(null)
    var dialog = dialogState[0]
    var setDialog = dialogState[1]

    var savingState = React.useState(false)
    var saving = savingState[0]
    var setSaving = savingState[1]

    var toastState = React.useState({ text: '', id: 0 })
    var toast = toastState[0]
    var setToast = toastState[1]

    var hoverState = React.useState(null)
    var hover = hoverState[0]
    var setHover = hoverState[1]

    var rateDraftState = React.useState('')
    var rateDraft = rateDraftState[0]
    var setRateDraft = rateDraftState[1]

    var rateManualState = React.useState(false)
    var rateManual = rateManualState[0]
    var setRateManual = rateManualState[1]

    var requestRef = React.useRef(0)
    var firstInputRef = React.useRef(null)
    var sizeHook = TD.util.useSize()
    var sizeRef = sizeHook[0]
    var size = sizeHook[1]

    /* ---- data loading ---- */
    var loadSummary = React.useCallback(function (silent) {
      var token = requestRef.current + 1
      requestRef.current = token
      if (!silent) setLoading(true)
      setError(null)
      return TD.util.rpc(connection, 'summary', { range: range, currency: currency })
        .then(function (value) {
          if (requestRef.current !== token) return
          setData(value || null)
          setLoading(false)
          setError(null)
        })
        .catch(function (failure) {
          if (requestRef.current !== token) return
          setLoading(false)
          setError(failure && failure.message ? failure.message : String(failure))
        })
    }, [connection, range, currency])

    var loadPrices = React.useCallback(function (refresh) {
      var method = refresh ? 'refreshPrices' : 'prices'
      setPricesBusy(true)
      return TD.util.rpc(connection, method, {})
        .then(function (value) {
          setPricesBusy(false)
          if (value) setPrices(value)
          return value
        })
        .catch(function (failure) {
          setPricesBusy(false)
          setError(failure && failure.message ? failure.message : String(failure))
          return null
        })
    }, [connection])

    /**
     * Re-fetch the by-workspace breakdown through the same `summary` path the
     * page already uses (and 重试 calls). No new endpoint: it refetches silently
     * so the page does not flash its loading state.
     */
    function refreshWorkspaces() {
      if (workspacesBusy) return
      setWorkspacesBusy(true)
      loadSummary(true).then(function () {
        setWorkspacesBusy(false)
      })
    }

    function showToast(text) {
      if (!text) return
      setToast({ text: text, id: toast.id + 1 })
    }

    React.useEffect(function () {
      var release = acquireStyles()
      return release
    }, [])

    React.useEffect(function () {
      loadSummary(false)
    }, [loadSummary])

    React.useEffect(function () {
      loadPrices(false)
    }, [loadPrices])

    var progress = (data && data.progress) || { state: 'idle', done: 0, total: 0 }

    React.useEffect(function () {
      if (!connection || progress.state !== 'scanning') return undefined
      var timer = setInterval(function () {
        TD.util.rpc(connection, 'indexStatus', {})
          .then(function (value) {
            if (!value || !value.progress) return
            setData(function (previous) {
              return previous ? merge(previous, { progress: value.progress }) : previous
            })
          })
          .catch(function () {})
      }, 2000)
      return function () {
        clearInterval(timer)
      }
    }, [connection, progress.state])

    React.useEffect(function () {
      if (!connection || progress.state === 'ready') return undefined
      var timer = setInterval(function () {
        loadSummary(true)
      }, 10000)
      return function () {
        clearInterval(timer)
      }
    }, [connection, progress.state, loadSummary])

    React.useEffect(function () {
      if (!toast.text) return undefined
      var timer = setTimeout(function () {
        setToast({ text: '', id: toast.id })
      }, 2400)
      return function () {
        clearTimeout(timer)
      }
    }, [toast.id, toast.text])

    React.useEffect(function () {
      if (!dialog || typeof document === 'undefined') return undefined
      function onKeyDown(event) {
        if (event.key === 'Escape') {
          event.stopPropagation()
          setDialog(null)
        }
      }
      document.addEventListener('keydown', onKeyDown)
      return function () {
        document.removeEventListener('keydown', onKeyDown)
      }
    }, [dialog])

    React.useEffect(function () {
      if (!dialog) return
      var node = firstInputRef.current
      if (node && typeof node.focus === 'function') node.focus()
    }, [dialog === null])

    /* ---- derived ---- */
    var rateInfo = rateFrom(data, prices)
    var rate = rateInfo.value
    var isManualRate = rateManual || rateInfo.source === 'manual'

    React.useEffect(function () {
      setRateDraft(rate > 0 ? rate.toFixed(2) : '')
    }, [rate])

    /**
     * `summary` money (`kpis.*`, `trend[].costUsd`, `byModel[].costUsd`) is
     * already converted by the host, so format with rate=1 and never double
     * convert. `prices.rows[].price.*` stays USD (models.dev unit) — see `rateIn`.
     */
    function money(amount) {
      return TD.util.fmtCost(amount, currency, 1)
    }

    /** One USD-per-1M rate from the price table, in the selected currency. */
    function perMillion(usdAmount) {
      return TD.util.fmtCost(usdAmount, currency, currency === 'CNY' ? rate : 1)
    }

    var kpis = (data && data.kpis) || {}
    var previous = kpis.prev || {}
    var missing = (data && Array.isArray(data.missing)) ? data.missing : []
    var pricesMeta = (data && data.pricesMeta) || (prices && prices.meta) || null
    var byWorkspace = (data && Array.isArray(data.byWorkspace)) ? data.byWorkspace : []
    var models = sortModels((data && data.byModel) || [], sortKey)
    var totalCost = 0
    models.forEach(function (row) {
      totalCost += num(row && row.costUsd)
    })

    var modelOptions = React.useMemo(function () {
      var list = []
      var seen = {}
      function push(provider, model) {
        if (!model) return
        var key = keyOf(provider, model)
        if (seen[key]) return
        seen[key] = true
        list.push({ provider: provider || '', model: model })
      }
      var priceRows = prices && Array.isArray(prices.rows) ? prices.rows : []
      priceRows.forEach(function (row) {
        if (row) push(row.provider, row.model)
      })
      var modelRows = (data && Array.isArray(data.byModel)) ? data.byModel : []
      modelRows.forEach(function (row) {
        if (row) push(row.provider, row.model)
      })
      return list
    }, [prices, data])

    var ids = React.useMemo(function () {
      var suffix = Math.random().toString(36).slice(2, 8)
      return {
        model: 'td-f-model-' + suffix,
        input: 'td-f-in-' + suffix,
        output: 'td-f-out-' + suffix,
        cacheRead: 'td-f-cr-' + suffix,
        cacheWrite: 'td-f-cw-' + suffix,
        free: 'td-f-free-' + suffix,
        rate: 'td-rate-' + suffix,
      }
    }, [])

    var trendList = trendRows(data && data.trend)
    var width = size && size.width > 0 ? Math.round(size.width) : 860
    var valueOf = function (bar) {
      return metric === 'cost' ? bar.costUsd : bar.tokens
    }
    var maxChart = 0
    trendList.forEach(function (bar) {
      var value = valueOf(bar)
      if (value > maxChart) maxChart = value
    })
    var geom = chartGeometry({
      width: width,
      height: 240,
      count: trendList.length || 1,
      max: maxChart > 0 ? maxChart * 1.1 : 1,
    })

    /* Y-axis tick label for the active metric. */
    function axisLabel(value) {
      return metric === 'cost' ? money(value) : TD.util.fmtTokens(value)
    }

    /* ---- dialog helpers ---- */

    /**
     * `prices.rows[].price.*` is USD per 1M tokens (the models.dev unit) and
     * `setCustomPrice` takes the same unit, so the dialog edits USD directly and
     * only the surrounding display converts. Nothing is converted on this path.
     */
    function priceText(amount) {
      var value = num(amount)
      if (value === 0) return '0'
      return String(Math.round(value * 10000) / 10000)
    }

    function dialogForModel(provider, model) {
      var row = findPriceRow(prices, provider, model)
      var customerPrice = row && row.source === 'custom' && row.price ? row.price : null
      var price = customerPrice
      var free = false
      if (price && num(price.input) === 0 && num(price.output) === 0) free = true
      return {
        provider: provider,
        model: model,
        custom: !!customerPrice,
        input: price ? priceText(price.input) : '',
        output: price ? priceText(price.output) : '',
        cacheRead: price && price.cacheRead !== undefined && price.cacheRead !== null ? priceText(price.cacheRead) : '',
        cacheWrite: price && price.cacheWrite !== undefined && price.cacheWrite !== null ? priceText(price.cacheWrite) : '',
        free: free,
        error: '',
        suggestion: suggestionFor(provider, model, data, prices),
      }
    }

    function openDialog(seed) {
      if (modelOptions.length === 0) return
      var target = seed && seed.model ? seed : modelOptions[0]
      var known = null
      for (var i = 0; i < modelOptions.length; i++) {
        if (modelOptions[i].model === target.model && modelOptions[i].provider === target.provider) {
          known = modelOptions[i]
          break
        }
      }
      var choice = known || modelOptions[0]
      setDialog(dialogForModel(choice.provider, choice.model))
    }

    function closeDialog() {
      setDialog(null)
    }

    function patchDialog(patch) {
      setDialog(function (previousDialog) {
        return previousDialog ? merge(previousDialog, patch) : previousDialog
      })
    }

    function savePrice() {
      if (!dialog) return
      var free = dialog.free
      var inputValue = parseFloat(dialog.input)
      var outputValue = parseFloat(dialog.output)
      var cacheReadValue = parseFloat(dialog.cacheRead)
      var cacheWriteValue = parseFloat(dialog.cacheWrite)
      if (!free) {
        var bad = !isFinite(inputValue) || !isFinite(outputValue) || inputValue < 0 || outputValue < 0
        if (bad) {
          patchDialog({ error: t('page.dialog.invalid') })
          return
        }
      }
      var payload = { provider: dialog.provider, model: dialog.model }
      if (free) {
        payload.input = 0
        payload.output = 0
        payload.cacheRead = 0
        payload.cacheWrite = 0
      } else {
        payload.input = inputValue
        payload.output = outputValue
        if (isFinite(cacheReadValue) && cacheReadValue >= 0) payload.cacheRead = cacheReadValue
        if (isFinite(cacheWriteValue) && cacheWriteValue >= 0) payload.cacheWrite = cacheWriteValue
      }
      setSaving(true)
      TD.util.rpc(connection, 'setCustomPrice', payload)
        .then(function (value) {
          setSaving(false)
          setDialog(null)
          if (value) setPrices(value)
          showToast(fill(t('page.dialog.saved'), { model: dialog.model }))
          loadSummary(true)
        })
        .catch(function (failure) {
          setSaving(false)
          patchDialog({ error: failure && failure.message ? failure.message : String(failure) })
        })
    }

    function removePrice() {
      if (!dialog) return
      setSaving(true)
      TD.util.rpc(connection, 'removeCustomPrice', { provider: dialog.provider, model: dialog.model })
        .then(function (value) {
          setSaving(false)
          setDialog(null)
          if (value) setPrices(value)
          showToast(fill(t('page.dialog.removed'), { model: dialog.model }))
          loadSummary(true)
        })
        .catch(function (failure) {
          setSaving(false)
          patchDialog({ error: failure && failure.message ? failure.message : String(failure) })
        })
    }

    function adoptSuggestion() {
      if (!dialog || !dialog.suggestion) return
      var suggestion = dialog.suggestion
      var price = suggestion.price
      if (!price) {
        var row = findPriceRow(prices, suggestion.provider, suggestion.model)
        if (row && row.price) price = row.price
      }
      if (!price) {
        /* The host's `suggestions` carry no price and the candidate model was
           never used here, so there is nothing to copy: point the user at the
           fields instead of silently doing nothing. */
        patchDialog({ error: t('page.dialog.noSuggestionPrice') })
        var node = firstInputRef.current
        if (node && typeof node.focus === 'function') node.focus()
        return
      }
      patchDialog({
        input: priceText(price.input),
        output: priceText(price.output),
        cacheRead: price.cacheRead !== undefined && price.cacheRead !== null ? priceText(price.cacheRead) : '',
        cacheWrite: price.cacheWrite !== undefined && price.cacheWrite !== null ? priceText(price.cacheWrite) : '',
        error: '',
      })
    }

    /* ---- rate ---- */
    function commitRate() {
      var value = parseFloat(rateDraft)
      if (!isFinite(value) || value <= 0) {
        setRateDraft(rate > 0 ? rate.toFixed(2) : '')
        return
      }
      if (Math.abs(value - rate) < 0.0001) return
      TD.util.rpc(connection, 'setRateOverride', { cnyPerUsd: value })
        .then(function (result) {
          setRateManual(true)
          if (result && result.rate) setData(merge(data || {}, { rate: result.rate }))
          loadSummary(true)
        })
        .catch(function (failure) {
          setRateDraft(rate > 0 ? rate.toFixed(2) : '')
          showToast(failure && failure.message ? failure.message : String(failure))
        })
    }

    function restoreRate() {
      TD.util.rpc(connection, 'setRateOverride', { cnyPerUsd: null })
        .then(function (result) {
          setRateManual(false)
          if (result && result.rate) setData(merge(data || {}, { rate: result.rate }))
          loadSummary(true)
        })
        .catch(function (failure) {
          showToast(failure && failure.message ? failure.message : String(failure))
        })
    }

    /* ================================================================ */
    /* render pieces                                                     */
    /* ================================================================ */

    function renderHeader() {
      var rangeButtons = [7, 30, 90].map(function (days) {
        return h('button', {
          key: 'range-' + days,
          type: 'button',
          'aria-pressed': range === days ? 'true' : 'false',
          onClick: function () { setRange(days) },
        }, t('page.range' + days))
      })
      return h('div', { className: 'td-hdr', key: 'hdr' },
        h('div', null,
          h('h1', null, t('page.title')),
          h('p', null, t('page.subtitle'))),
        h('div', { className: 'td-ctrls' },
          progress.state === 'scanning'
            ? h('span', { className: 'td-chip', key: 'progress' },
              fill(t('page.progress.scanning'), {
                done: TD.util.fmtNum(progress.done || 0),
                total: TD.util.fmtNum(progress.total || 0),
              }))
            : null,
          h('div', { className: 'td-seg', role: 'group', 'aria-label': t('page.rangeLabel'), key: 'range' }, rangeButtons),
          h('select', {
            key: 'currency',
            className: 'td-select',
            'aria-label': t('page.currencyLabel'),
            value: currency,
            onChange: function (event) { setCurrency(event.target.value === 'USD' ? 'USD' : 'CNY') },
          },
            h('option', { value: 'CNY' }, t('page.currencyCNY')),
            h('option', { value: 'USD' }, t('page.currencyUSD')))))
    }

    /**
     * Sub-page switcher. `.td-seg` keeps it native; `aria-pressed` and the
     * group label carry the same semantics as the metric/range toggles.
     */
    function renderTabs() {
      function tabButton(id, labelKey) {
        return h('button', {
          key: id,
          type: 'button',
          className: 'td-tab',
          'data-td-tab': id,
          'aria-pressed': tab === id ? 'true' : 'false',
          onClick: function () { setTab(id) },
        }, t(labelKey))
      }
      return h('div', { className: 'td-tabs', key: 'tabs' },
        h('div', { className: 'td-seg', role: 'group', 'aria-label': t('page.tab.label') },
          tabButton('usage', 'page.tab.usage'),
          tabButton('prices', 'page.tab.prices')))
    }

    function renderBanner() {
      if (missing.length === 0) return null
      var separator = t('page.missing.separator')
      var chips = []
      missing.forEach(function (item, index) {
        if (index > 0) chips.push(h('span', { key: 'sep-' + index }, separator))
        chips.push(h('code', {
          key: 'code-' + index,
          title: (item.provider ? item.provider + '/' : '') + item.model,
        }, item.model))
      })
      var unpriced = num(kpis.unpricedTokens)
      return h('div', { className: 'td-warn', role: 'status', key: 'banner' },
        h('div', { className: 'td-warn-ic', 'aria-hidden': true }, TD.util.ICONS.warning(18)),
        h('div', { className: 'td-warn-tx' },
          h('b', null, fill(t('page.missing.title'), { count: missing.length })),
          h('span', null, t('page.missing.bodyPrefix')),
          chips,
          h('span', null, fill(t('page.missing.bodySuffix'), { tokens: TD.util.fmtTokens(unpriced) }))),
        h('button', {
          type: 'button',
          className: 'td-btn td-btn-primary',
          onClick: function () { openDialog(missing[0]) },
        }, t('page.missing.add')))
    }

    function renderError() {
      if (!error) return null
      if (!data) {
        return h('div', { className: 'td-state', role: 'alert', key: 'error' },
          h('span', null, error),
          h('button', { type: 'button', className: 'td-btn', onClick: function () { loadSummary(false) } }, t('common.retry')))
      }
      return h('div', { className: 'td-errorbar', role: 'alert', key: 'errorbar' },
        h('span', null, error),
        h('button', { type: 'button', className: 'td-btn td-btn-sm', onClick: function () { loadSummary(true) } }, t('common.retry')))
    }

    /** Delta line for a KPI card; `goodWhenUp` flips the semantic colour. */
    function deltaNode(current, previousValue, goodWhenUp) {
      var delta = deltaOf(previousValue, current)
      if (!delta.hasPrev) {
        return h('span', { className: 'td-muted' }, t('page.kpi.noPrev'))
      }
      var arrow = delta.dir === 'up' ? '\u2191' : delta.dir === 'down' ? '\u2193' : '\u2014'
      var tone = delta.dir === 'flat' ? 'td-muted' : (delta.dir === 'up') === goodWhenUp ? 'td-down' : 'td-up'
      var percent = delta.dir === 'flat' ? '0%' : TD.util.fmtPct(delta.ratio)
      return h('span', null,
        h('span', { className: tone }, arrow + ' ' + percent),
        ' ' + t('page.kpi.vsPrev'))
    }

    function renderKpis() {
      var cards = []
      cards.push(h('div', { className: 'td-kpi', key: 'tokens' },
        h('div', { className: 'td-kpi-l' }, t('page.kpi.totalTokens')),
        h('div', { className: 'td-kpi-v td-num' }, TD.util.fmtTokens(kpis.totalTokens)),
        h('div', { className: 'td-kpi-d' }, deltaNode(kpis.totalTokens, previous.totalTokens, false))))

      var costDetail
      if (num(kpis.missingCount) > 0) {
        costDetail = h('span', { className: 'td-up' }, fill(t('page.kpi.unpriced'), { count: kpis.missingCount }))
      } else {
        costDetail = deltaNode(kpis.costUsd, previous.costUsd, false)
      }
      cards.push(h('div', { className: 'td-kpi', key: 'cost' },
        h('div', { className: 'td-kpi-l' }, t('page.kpi.cost')),
        h('div', { className: 'td-kpi-v td-num' }, money(kpis.costUsd)),
        h('div', { className: 'td-kpi-d' }, costDetail)))

      var hitNow = num(kpis.cacheHitRate)
      var hitBefore = num(previous.cacheHitRate)
      var points = (hitNow - hitBefore) * 100
      var hitDir = points > 0.05 ? 'up' : points < -0.05 ? 'down' : 'flat'
      var hitTone = hitDir === 'flat' ? 'td-muted' : hitDir === 'up' ? 'td-down' : 'td-up'
      var hitArrow = hitDir === 'up' ? '\u2191' : hitDir === 'down' ? '\u2193' : '\u2014'
      cards.push(h('div', { className: 'td-kpi', key: 'hit' },
        h('div', { className: 'td-kpi-l' }, t('page.kpi.cacheHit')),
        h('div', { className: 'td-kpi-v td-num' }, TD.util.fmtPct(hitNow)),
        h('div', { className: 'td-kpi-d' },
          h('span', { className: hitTone }, hitArrow + ' ' + fill(t('page.kpi.points'), { value: Math.abs(points).toFixed(1) })))))

      var daily = num(kpis.dailyCostUsd)
      if (daily === 0 && num(kpis.costUsd) > 0 && range > 0) daily = num(kpis.costUsd) / range
      cards.push(h('div', { className: 'td-kpi', key: 'daily' },
        h('div', { className: 'td-kpi-l' }, t('page.kpi.dailyCost')),
        h('div', { className: 'td-kpi-v td-num' }, money(daily)),
        h('div', { className: 'td-kpi-d' }, fill(t('page.kpi.calls'), { count: TD.util.fmtNum(kpis.calls) }))))

      return h('div', { className: 'td-kpis' }, cards)
    }

    function renderLegend() {
      if (metric === 'cost') {
        return h('div', { className: 'td-legend' },
          h('span', null, h('i', { 'aria-hidden': true }), t('page.metric.cost')))
      }
      return h('div', { className: 'td-legend' },
        h('span', null, h('i', { className: 'td-swatch-cache', 'aria-hidden': true }), t('page.trend.cache')),
        h('span', null, h('i', { 'aria-hidden': true }), t('page.trend.uncached')),
        h('span', null, h('i', { className: 'td-swatch-output', 'aria-hidden': true }), t('page.trend.output')))
    }

    function handleHover(index, event) {
      var node = sizeRef.current
      if (!node || typeof node.getBoundingClientRect !== 'function') {
        setHover({ index: index, left: 12, top: 12 })
        return
      }
      var rect = node.getBoundingClientRect()
      setHover({ index: index, left: event.clientX - rect.left, top: event.clientY - rect.top })
    }

    function renderChart() {
      var children = []
      var g
      /* 4 gridlines above the baseline + tick labels incl. 0 */
      for (g = 1; g <= 4; g++) {
        var gridValue = (geom.max * g) / 4
        children.push(h('line', {
          key: 'grid-' + g,
          x1: geom.padding.left,
          x2: geom.width - geom.padding.right,
          y1: geom.y(gridValue),
          y2: geom.y(gridValue),
          style: { stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1 },
        }))
      }
      children.push(h('line', {
        key: 'axis',
        x1: geom.padding.left,
        x2: geom.width - geom.padding.right,
        y1: geom.baseline,
        y2: geom.baseline,
        style: { stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 1 },
      }))
      for (g = 0; g <= 4; g++) {
        var tickValue = (geom.max * g) / 4
        children.push(h('text', {
          key: 'tick-' + g,
          x: geom.padding.left - 8,
          y: geom.y(tickValue) + 4,
          fontSize: 11,
          textAnchor: 'end',
          style: { fill: 'var(--dsw-alias-label-secondary)' },
        }, axisLabel(tickValue)))
      }

      var labelStep = tickStep(trendList.length)
      trendList.forEach(function (bar, index) {
        var x = geom.barX(index)
        var cursor = 0
        if (metric === 'cost') {
          var top = geom.y(bar.costUsd)
          children.push(h('rect', {
            key: 'bar-' + index,
            x: x,
            y: top,
            width: geom.barWidth,
            height: Math.max(0, geom.baseline - top),
            rx: 2,
            style: { fill: 'var(--dsw-alias-brand-primary)' },
          }))
        } else {
          var segments = [
            { key: 'cache', value: bar.cacheRead, opacity: 0.45, fill: 'var(--dsw-alias-brand-primary)' },
            { key: 'uncached', value: bar.uncached, opacity: 1, fill: 'var(--dsw-alias-brand-primary)' },
            { key: 'output', value: bar.output, opacity: 1, fill: 'currentColor' },
          ]
          var lastVisible = -1
          segments.forEach(function (segment, segmentIndex) {
            if (segment.value > 0) lastVisible = segmentIndex
          })
          segments.forEach(function (segment, segmentIndex) {
            var segmentTop = geom.y(cursor + segment.value)
            var height = Math.max(0, geom.y(cursor) - segmentTop)
            if (height > 0) {
              children.push(h('rect', {
                key: 'seg-' + index + '-' + segment.key,
                x: x,
                y: segmentTop,
                width: geom.barWidth,
                height: height,
                rx: segmentIndex === lastVisible ? 2 : 0,
                style: { fill: segment.fill, opacity: segment.opacity },
              }))
            }
            cursor += segment.value
          })
        }

        if (index % labelStep === 0 || index === trendList.length - 1) {
          children.push(h('text', {
            key: 'xlabel-' + index,
            x: x + geom.barWidth / 2,
            y: geom.height - 8,
            fontSize: 11,
            textAnchor: 'middle',
            style: { fill: 'var(--dsw-alias-label-secondary)' },
          }, TD.util.formatDate(bar.date)))
        }

        children.push(h('rect', {
          key: 'hover-' + index,
          x: geom.padding.left + index * geom.step,
          y: geom.padding.top,
          width: geom.step,
          height: geom.innerHeight,
          fill: 'transparent',
          onMouseEnter: function (event) { handleHover(index, event) },
          onMouseMove: function (event) { handleHover(index, event) },
          onMouseLeave: function () { setHover(null) },
        }))
      })

      var svg = h('svg', {
        viewBox: '0 0 ' + geom.width + ' ' + geom.height,
        role: 'img',
        'aria-label': t('page.trend.aria'),
        style: { color: 'var(--dsw-alias-label-primary)' },
      }, children)

      var tip = null
      var bar = hover ? trendList[hover.index] : null
      if (bar) {
        /* Always: date, total, then the three components — in both metrics. */
        var parts = dateParts(bar.date)
        var totalText = metric === 'cost' ? money(bar.costUsd) : TD.util.fmtTokens(bar.tokens)
        /* The three components are always token counts; only the total switches
           to money, so they keep the token formatter under the cost metric. */
        var partText = function (value) { return TD.util.fmtTokens(value) }
        var tipLines = [
          h('b', { key: 'date' }, fill(t('page.trend.dateLabel'), { month: parts.month, day: parts.day })),
          h('div', { key: 'total' }, t('page.trend.tipTotal') + ' ' + totalText),
          h('div', { key: 'cache' },
            t('page.trend.tipCache') + ' ' + partText(bar.cacheRead) +
            ' \u00b7 ' + t('page.trend.tipUncached') + ' ' + partText(bar.uncached)),
          h('div', { key: 'output' }, t('page.trend.tipOutput') + ' ' + partText(bar.output)),
        ]
        var maxLeft = Math.max(8, geom.width - 210)
        var left = Math.min(Math.max(8, hover.left + 14), maxLeft)
        var top = Math.max(4, hover.top - 12)
        tip = h('div', {
          className: 'td-tip',
          role: 'tooltip',
          style: { left: left + 'px', top: top + 'px' },
        }, tipLines)
      }

      return h('div', { className: 'td-chart', ref: sizeRef }, svg, tip)
    }

    function renderTrendSection() {
      if (trendList.length === 0) {
        return h('div', { className: 'td-sec', key: 'trend-sec' },
          h('div', null, t('page.section.trend')),
          renderMetricControl())
      }
      return h('div', { key: 'trend' },
        h('div', { className: 'td-sec' },
          h('div', null, t('page.section.trend')),
          renderMetricControl()),
        h('div', { className: 'td-card' }, renderLegend(), renderChart()))
    }

    function renderMetricControl() {
      return h('div', { className: 'td-seg', role: 'group', 'aria-label': t('page.metric.label') },
        h('button', {
          type: 'button',
          'aria-pressed': metric === 'tok' ? 'true' : 'false',
          onClick: function () { setMetric('tok') },
        }, t('page.metric.tok')),
        h('button', {
          type: 'button',
          'aria-pressed': metric === 'cost' ? 'true' : 'false',
          onClick: function () { setMetric('cost') },
        }, t('page.metric.cost')))
    }

    function confidenceBadge(row, key) {
      if (row.missing) {
        return badge('td-b-orange', t('page.badge.missing'), t('page.badge.missingTip'), key)
      }
      if (row.source === 'custom' || row.confidence === 'custom') {
        return badge('td-b-blue', t('page.badge.custom'), t('page.badge.customTip'), key)
      }
      if (row.confidence === 'fuzzy') {
        return badge('td-b-orange', t('page.badge.fuzzy'), t('page.badge.fuzzyTip'), key)
      }
      if (row.confidence === 'model-alias') {
        return badge('td-b-gray', t('page.badge.modelAlias'), t('page.badge.modelAliasTip'), key)
      }
      if (row.confidence === 'cross-provider') {
        return badge('td-b-gray', t('page.badge.crossProvider'), t('page.badge.crossProviderTip'), key)
      }
      if (row.confidence === 'alias') {
        return badge('td-b-gray', t('page.badge.alias'), t('page.badge.aliasTip'), key)
      }
      return badge('td-b-green', t('page.badge.modelsDev'), t('page.badge.modelsDevTip'), key)
    }

    function renderModelTable() {
      if (models.length === 0) {
        return h('div', { className: 'td-state', key: 'models-empty' }, t('page.models.empty'))
      }
      var head = h('thead', null, h('tr', null,
        h('th', null, t('page.col.model')),
        h('th', null, t('page.col.provider')),
        h('th', { 'aria-sort': sortKey === 'calls' ? 'descending' : 'none' },
          h('button', { type: 'button', className: 'td-th-btn', onClick: function () { setSortKey('calls') } }, t('page.col.calls'))),
        h('th', null, t('page.col.input')),
        h('th', null, t('page.col.cacheRead')),
        h('th', null, t('page.col.cacheHit')),
        h('th', null, t('page.col.output')),
        h('th', null, t('page.col.total')),
        h('th', { 'aria-sort': sortKey === 'cost' ? 'descending' : 'none' },
          h('button', { type: 'button', className: 'td-th-btn', onClick: function () { setSortKey('cost') } }, t('page.col.cost'))),
        h('th', null, t('page.col.priceSource'))))

      var body = h('tbody', null, models.map(function (row, index) {
        var key = keyOf(row.provider, row.model) + '-' + index
        var missingRow = !!row.missing
        var share = totalCost > 0 ? Math.max(0, Math.min(100, (num(row.costUsd) / totalCost) * 100)) : 0
        // The total is the number a user compares against "how much did this cost
        // me": most input is cache traffic, which the `input` column alone hides.
        var rowTotal = num(row.tokens)
        return h('tr', { key: key, className: missingRow ? 'td-row-miss' : undefined },
          h('td', null, h('div', { className: 'td-model-name' }, row.model)),
          h('td', { className: 'td-muted' }, row.provider),
          h('td', { className: 'td-num' }, TD.util.fmtNum(row.calls)),
          h('td', { className: 'td-num' }, TD.util.fmtTokens(row.input)),
          h('td', { className: 'td-num' }, TD.util.fmtTokens(row.cacheRead)),
          h('td', { className: 'td-num' }, TD.util.fmtPct(row.cacheHitRate)),
          h('td', { className: 'td-num' }, TD.util.fmtTokens(row.output)),
          h('td', { className: 'td-num td-num-strong' }, TD.util.fmtTokens(rowTotal)),
          h('td', { className: 'td-num' },
            missingRow
              ? h('span', { className: 'td-muted' }, TD.util.MISSING)
              : [money(row.costUsd),
                h('span', { key: 'bar', className: 'td-bar', 'aria-hidden': true },
                  h('i', { style: { width: share + '%' } }))]),
          h('td', null,
            h('span', { className: 'td-badge-group' },
              confidenceBadge(row, 'badge'),
              missingRow
                ? h('button', {
                  key: 'add',
                  type: 'button',
                  className: 'td-link-btn',
                  'aria-label': fill(t('page.model.addFor'), { model: row.model }),
                  onClick: function () { openDialog({ provider: row.provider, model: row.model }) },
                }, t('page.model.add'))
                : null)))
      }))

      return h('div', { className: 'td-tw', key: 'models' }, h('table', { className: 'td-table' }, head, body))
    }

    /** Section head shared by the populated and empty states. */
    function renderWorkspaceHead() {
      return h('div', { className: 'td-sec' },
        h('div', null, t('page.section.workspaces')),
        h('button', {
          type: 'button',
          className: 'td-btn td-btn-sm td-ws-refresh',
          'data-td-action': 'refresh-workspaces',
          disabled: workspacesBusy,
          'aria-busy': workspacesBusy ? 'true' : undefined,
          onClick: refreshWorkspaces,
        },
          refreshIcon(13),
          t('page.workspace.refresh')))
    }

    function renderWorkspaces() {
      if (byWorkspace.length === 0) {
        return h('div', { key: 'ws' },
          renderWorkspaceHead(),
          h('div', { className: 'td-state' }, t('page.workspaces.empty')))
      }
      var top = 0
      byWorkspace.forEach(function (row) {
        var share = num(row && row.share)
        if (share > top) top = share
      })
      if (top <= 0) top = 1
      return h('div', { key: 'ws' },
        renderWorkspaceHead(),
        h('div', { className: 'td-card' },
          h('div', { className: 'td-share' }, byWorkspace.map(function (row, index) {
            var share = num(row && row.share)
            /* tokens · share% · cost, one line. The cost is only appended when
               the Host sent one, so a pre-cost payload still renders. */
            var figures = TD.util.fmtTokens(row && row.tokens) + ' \u00b7 ' + TD.util.fmtPct(share)
            if (row && typeof row.costUsd === 'number' && isFinite(row.costUsd)) {
              figures += ' \u00b7 ' + money(row.costUsd)
            }
            return h('div', { key: 'ws-' + index },
              h('div', { className: 'td-share-top' },
                h('span', null, (row && row.workspace) || TD.util.MISSING),
                h('span', { className: 'td-num td-muted' }, figures)),
              h('div', { className: 'td-share-tr', 'aria-hidden': true },
                h('i', { style: { width: Math.max(0, Math.min(100, (share / top) * 100)) + '%' } })))
          }))))
    }

    function priceSourceLabel(meta) {
      if (!meta) return t('page.price.sourceNone')
      if (meta.source === 'models.dev') return 'models.dev'
      if (meta.source === 'cache') return t('page.price.sourceCache')
      return t('page.price.sourceNone')
    }

    /** Human label for one rate-source id from `rateInfo.source`. */
    function rateSourceLabel(source) {
      if (source === 'open.er-api.com') return 'open.er-api.com'
      if (source === 'frankfurter') return 'frankfurter'
      if (source === 'manual') return t('page.price.rateManual')
      if (source === 'builtin') return t('page.price.rateBuiltin')
      return t('page.price.sourceNone')
    }

    /** "自动 · open.er-api.com · 2026-10-23 10:20 更新" or "汇率未更新". */
    function rateSummaryText() {
      var source = rateInfo.source || null
      if (source === 'builtin' && !isManualRate) {
        return fill(t('page.price.rateStale'), { source: rateSourceLabel(source) })
      }
      var parts = [isManualRate ? t('page.price.rateManual') : t('page.price.rateAuto')]
      if (source && source !== 'manual') parts.push(rateSourceLabel(source))
      if (rateInfo.fetchedAt) {
        parts.push(fill(t('page.price.rateUpdated'), { time: TD.util.formatDateTime(rateInfo.fetchedAt) }))
      }
      return parts.join(' \u00b7 ')
    }

    function renderPriceSection() {
      var meta = pricesMeta
      var metaText
      if (pricesBusy || (meta && meta.refreshing === true)) {
        metaText = t('page.price.refreshing')
      } else if (meta && meta.error) {
        metaText = fill(t('page.price.error'), { message: meta.error })
      } else {
        metaText = fill(t('page.price.source'), {
          source: priceSourceLabel(meta),
          time: meta && meta.fetchedAt ? TD.util.formatDateTime(meta.fetchedAt) : TD.util.MISSING,
        })
      }

      var rows = prices && Array.isArray(prices.rows) ? prices.rows : null
      var body
      if (!rows) {
        body = pricesBusy
          ? h('div', { className: 'td-state' }, t('common.loading'))
          : h('div', { className: 'td-state' }, t('page.price.pricesEmpty'))
      } else if (rows.length === 0) {
        body = h('div', { className: 'td-state' }, t('page.price.pricesEmpty'))
      } else {
        body = h('div', { className: 'td-rows' }, rows.map(function (row, index) {
          var price = row.price
          var isCustom = row.source === 'custom' || row.confidence === 'custom'
          var missingPrice = !price
          var descriptor = price
            ? [
              t('page.price.input') + ' ' + perMillion(price.input) + ' \u00b7 ',
              t('page.price.cacheRead') + ' ' + perMillion(price.cacheRead === undefined || price.cacheRead === null ? price.input : price.cacheRead) + ' \u00b7 ',
              t('page.price.output') + ' ' + perMillion(price.output) + ' ',
              h('span', { key: 'unit', className: 'td-muted' }, t('page.price.perMillion')),
            ]
            : t('page.price.missingDesc')

          var action = missingPrice
            ? h('button', {
              type: 'button',
              className: 'td-btn td-btn-primary',
              onClick: function () { openDialog({ provider: row.provider, model: row.model }) },
            }, t('page.price.add'))
            : isCustom
              ? h('button', {
                type: 'button',
                className: 'td-btn',
                onClick: function () { openDialog({ provider: row.provider, model: row.model }) },
              }, t('page.price.edit'))
              : null

          return h('div', { className: 'td-r', key: keyOf(row.provider, row.model) + '-' + index },
            h('div', { className: 'td-tile' + (missingPrice ? ' td-tile-miss' : ''), 'aria-hidden': true }, initialsOf(row.model)),
            h('div', { className: 'td-r-main' },
              h('div', { className: 'td-r-title' },
                h('span', null, row.model),
                h('span', { className: 'td-muted' }, row.provider),
                missingPrice ? confidenceBadge({ missing: true }, 'badge') : confidenceBadge(row, 'badge')),
              h('div', { className: 'td-r-desc td-num' }, descriptor)),
            action)
        }))
      }

      return h('div', { key: 'prices' },
        h('div', { className: 'td-sec' },
          h('div', null, t('page.section.prices')),
          h('div', { className: 'td-sec-more' }, metaText)),
        body,
        h('div', { className: 'td-price-foot' },
          h('button', {
            type: 'button',
            className: 'td-btn',
            disabled: pricesBusy,
            onClick: function () {
              loadPrices(true).then(function (value) {
                if (value) {
                  showToast(t('page.price.refreshed'))
                  loadSummary(true)
                }
              })
            },
          }, t('page.price.refresh')),
          h('button', {
            type: 'button',
            className: 'td-btn',
            onClick: function () { openDialog(null) },
          }, t('page.price.addCustom')),
          h('div', { className: 'td-rate' },
            h('label', { htmlFor: ids.rate }, t('page.price.rateLabel')),
            h('input', {
              id: ids.rate,
              className: 'td-inp td-num',
              type: 'number',
              step: '0.01',
              min: '0',
              value: rateDraft,
              onChange: function (event) { setRateDraft(event.target.value) },
              onBlur: commitRate,
              onKeyDown: function (event) {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitRate()
                }
              },
            }),
            h('span', null, t('page.price.rateUnit')),
            h('span', { className: 'td-muted' }, rateSummaryText()),
            isManualRate
              ? h('button', { type: 'button', className: 'td-link-btn', onClick: restoreRate }, t('page.price.restoreAuto'))
              : null)))
    }

    function renderEmpty() {
      var hint = progress.state === 'ready' ? null : t('page.empty.hint')
      return h('div', { className: 'td-state', key: 'empty' },
        h('span', null, t('common.empty')),
        hint ? h('span', { className: 'td-muted' }, hint) : null,
        progress.state === 'ready'
          ? h('button', { type: 'button', className: 'td-btn td-btn-sm', onClick: function () { loadSummary(false) } }, t('common.retry'))
          : null)
    }

    function renderDialog() {
      if (!dialog) return null
      var options = modelOptions.slice()
      var hasCurrent = false
      for (var i = 0; i < options.length; i++) {
        if (options[i].provider === dialog.provider && options[i].model === dialog.model) hasCurrent = true
      }
      if (!hasCurrent && dialog.model) options.unshift({ provider: dialog.provider, model: dialog.model })

      var suggestion = dialog.suggestion
      /* Option values are plain indexes: provider/model ids may contain any
         character, so they are used as the visible label only. */
      var currentIndex = 0
      for (var oi = 0; oi < options.length; oi++) {
        if (options[oi].provider === dialog.provider && options[oi].model === dialog.model) {
          currentIndex = oi
          break
        }
      }
      return h('div', {
        className: 'td-mask',
        key: 'dialog',
        onMouseDown: function (event) {
          if (event.target === event.currentTarget) closeDialog()
        },
      },
        h('div', {
          className: 'td-modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'td-dialog-title',
          onMouseDown: function (event) { event.stopPropagation() },
        },
          h('h3', { id: 'td-dialog-title' }, t('page.dialog.title')),
          h('p', null, t('page.dialog.desc')),
          h('div', { className: 'td-fg' },
            h('div', { className: 'td-fd td-fd-full' },
              h('label', { htmlFor: ids.model }, t('page.dialog.model')),
              h('select', {
                id: ids.model,
                value: String(currentIndex),
                onChange: function (event) {
                  var picked = options[Number(event.target.value)]
                  if (picked) setDialog(dialogForModel(picked.provider, picked.model))
                },
              }, options.map(function (option, optionIndex) {
                return h('option', { key: 'opt-' + optionIndex, value: String(optionIndex) },
                  (option.provider ? option.provider + '/' : '') + option.model)
              }))),
            h('div', { className: 'td-fd' },
              h('label', { htmlFor: ids.input }, t('page.dialog.input')),
              h('input', {
                id: ids.input,
                ref: firstInputRef,
                type: 'number',
                step: '0.01',
                min: '0',
                inputMode: 'decimal',
                placeholder: '0.00',
                value: dialog.input,
                onChange: function (event) { patchDialog({ input: event.target.value }) },
              })),
            h('div', { className: 'td-fd' },
              h('label', { htmlFor: ids.output }, t('page.dialog.output')),
              h('input', {
                id: ids.output,
                type: 'number',
                step: '0.01',
                min: '0',
                inputMode: 'decimal',
                placeholder: '0.00',
                value: dialog.output,
                onChange: function (event) { patchDialog({ output: event.target.value }) },
              })),
            h('div', { className: 'td-fd' },
              h('label', { htmlFor: ids.cacheRead }, t('page.dialog.cacheRead')),
              h('input', {
                id: ids.cacheRead,
                type: 'number',
                step: '0.01',
                min: '0',
                inputMode: 'decimal',
                placeholder: t('page.dialog.cacheDefault'),
                value: dialog.cacheRead,
                onChange: function (event) { patchDialog({ cacheRead: event.target.value }) },
              })),
            h('div', { className: 'td-fd' },
              h('label', { htmlFor: ids.cacheWrite }, t('page.dialog.cacheWrite')),
              h('input', {
                id: ids.cacheWrite,
                type: 'number',
                step: '0.01',
                min: '0',
                inputMode: 'decimal',
                placeholder: t('page.dialog.cacheDefault'),
                value: dialog.cacheWrite,
                onChange: function (event) { patchDialog({ cacheWrite: event.target.value }) },
              })),
            h('div', { className: 'td-fd-full td-check' },
              h('input', {
                id: ids.free,
                type: 'checkbox',
                checked: dialog.free,
                onChange: function (event) { patchDialog({ free: event.target.checked }) },
              }),
              h('label', { htmlFor: ids.free }, t('page.dialog.free'))),
            suggestion
              ? h('div', { className: 'td-suggest' },
                h('span', null,
                  suggestion.confidence === 'fuzzy'
                    ? fill(t('page.dialog.suggestionFuzzy'), { provider: suggestion.provider, model: suggestion.model })
                    : fill(t('page.dialog.suggestion'), { provider: suggestion.provider, model: suggestion.model })),
                h('button', { type: 'button', className: 'td-link-btn', onClick: adoptSuggestion }, t('page.dialog.adopt')))
              : null,
            dialog.error ? h('div', { className: 'td-form-err', role: 'alert' }, dialog.error) : null),
          h('div', { className: 'td-mact' },
            dialog.custom
              ? h('button', { type: 'button', className: 'td-btn', disabled: saving, onClick: removePrice }, t('page.dialog.remove'))
              : null,
            h('button', { type: 'button', className: 'td-btn', disabled: saving, onClick: closeDialog }, t('common.cancel')),
            h('button', { type: 'button', className: 'td-btn td-btn-primary', disabled: saving, onClick: savePrice }, t('common.save')))))
    }

    /* ---- assemble ---- */
    var content
    if (!data && loading) {
      content = h('div', { className: 'td-state', key: 'loading', role: 'status' }, t('common.loading'))
    } else if (!data && error) {
      content = renderError()
    } else if (!data || isEmptyIndex(data)) {
      content = renderEmpty()
    } else {
      content = h('div', { key: 'sections' },
        renderKpis(),
        renderTrendSection(),
        h('div', { className: 'td-sec' },
          h('div', null, t('page.section.models')),
          h('div', { className: 'td-sec-more' }, t('page.section.sortHint'))),
        renderModelTable(),
        renderWorkspaces())
    }

    /* Appending the price section when the index is empty used to keep the price
       table reachable; the 价格 tab is that escape hatch now. */
    var bodyChildren = [renderHeader(), renderTabs()]
    if (tab === 'usage') {
      if (data && error) bodyChildren.push(renderError())
      bodyChildren.push(renderBanner())
      bodyChildren.push(content)
    } else {
      if (error) bodyChildren.push(renderError())
      bodyChildren.push(renderPriceSection())
    }

    return h('div', { className: 'td-scroll', 'aria-busy': loading ? 'true' : undefined },
      h('div', { className: 'td-page' },
        bodyChildren,
        renderDialog()),
      toast.text ? h('div', { className: 'td-toast', role: 'status', 'aria-live': 'polite' }, toast.text) : null)
  }

  /* ==================================================================== */
  /* dictionaries                                                        */
  /* ==================================================================== */

  var EN = TD.dicts.en
  var ZH = TD.dicts.zh

  function words(key, en, zh) {
    EN[key] = en
    ZH[key] = zh
  }

  /* header */
  words('page.title', 'Token Usage', 'Token 统计')
  words('page.subtitle', 'Model usage across every session, sub-agent run and scheduled task · from local session logs', '所有会话、子智能体和自动化任务的模型用量 · 数据来自本地会话日志')
  words('page.rangeLabel', 'Time range', '时间范围')
  words('page.range7', '7 days', '7 天')
  words('page.range30', '30 days', '30 天')
  words('page.range90', '90 days', '90 天')
  words('page.currencyLabel', 'Currency', '货币')
  words('page.currencyCNY', 'CNY ¥', 'CNY ¥')
  words('page.currencyUSD', 'USD $', 'USD $')
  words('page.progress.scanning', 'Indexing local sessions {done}/{total}', '正在扫描本地会话 {done}/{total}')

  /* sub-page tabs */
  words('page.tab.label', 'View', '视图')
  words('page.tab.usage', 'Usage', '用量')
  words('page.tab.prices', 'Prices', '价格')

  /* missing price banner */
  words('page.missing.title', '{count} used models have no price', '有 {count} 个使用过的模型没有价格')
  words('page.missing.bodyPrefix', 'models.dev has no entry for ', 'models.dev 里找不到 ')
  words('page.missing.bodySuffix', '; their {tokens} tokens are not counted in the cost yet.', '，它们的 {tokens} token 暂未计入成本。')
  words('page.missing.separator', ', ', '、')
  words('page.missing.add', 'Add price', '添加价格')

  /* kpi */
  words('page.kpi.totalTokens', 'Total tokens', '总 Token')
  words('page.kpi.cost', 'Estimated cost', '估算成本')
  words('page.kpi.cacheHit', 'Cache hit rate', '缓存命中率')
  words('page.kpi.dailyCost', 'Daily cost', '日均成本')
  words('page.kpi.vsPrev', 'vs previous period', '对比上一周期')
  words('page.kpi.noPrev', 'No data for the previous period', '无上一周期数据')
  words('page.kpi.unpriced', 'Excludes {count} unpriced models', '不含 {count} 个未定价模型')
  words('page.kpi.points', '{value} percentage points', '{value} 个百分点')
  words('page.kpi.calls', '{count} model calls', '共 {count} 次模型调用')

  /* trend */
  words('page.section.trend', 'Usage trend', '用量趋势')
  words('page.metric.label', 'Metric', '指标')
  words('page.metric.tok', 'Token', 'Token')
  words('page.metric.cost', 'Cost', '成本')
  words('page.trend.cache', 'Input · cache hit', '输入 · 命中缓存')
  words('page.trend.uncached', 'Input · uncached', '输入 · 未命中')
  words('page.trend.output', 'Output', '输出')
  words('page.trend.aria', 'Daily usage bar chart', '每日用量柱状图')
  words('page.trend.tipTotal', 'Total', '合计')
  words('page.trend.tipCache', 'Cache hit', '命中缓存')
  words('page.trend.tipUncached', 'Uncached', '未命中')
  words('page.trend.tipOutput', 'Output', '输出')
  words('page.trend.dateLabel', '{month}/{day}', '{month}月{day}日')

  /* models table */
  words('page.section.models', 'By model', '按模型')
  words('page.section.sortHint', 'Click a column header to sort', '点表头可排序')
  words('page.col.model', 'Model', '模型')
  words('page.col.provider', 'Provider', '供应商')
  words('page.col.calls', 'Calls', '调用')
  words('page.col.input', 'Input · uncached', '输入 · 未命中')
  words('page.col.cacheRead', 'Input · cache hit', '输入 · 命中缓存')
  words('page.col.cacheHit', 'Cache hit rate', '缓存命中率')
  words('page.col.output', 'Output', '输出')
  words('page.col.total', 'Total tokens', 'Token 合计')
  words('page.col.cost', 'Cost', '成本')
  words('page.col.priceSource', 'Price source', '价格来源')
  words('page.model.add', 'Add', '添加')
  words('page.model.addFor', 'Add a price for {model}', '为 {model} 添加价格')
  words('page.models.empty', 'No model usage yet', '暂无模型用量')

  /* price source badges */
  words('page.badge.custom', 'Custom', '自定义')
  words('page.badge.customTip', 'The price you entered by hand', '你手动填写的价格')
  words('page.badge.modelsDev', 'models.dev', 'models.dev')
  words('page.badge.modelsDevTip', 'Price from models.dev', '来自 models.dev 的价格')
  words('page.badge.missing', 'No price', '缺少价格')
  words('page.badge.missingTip', 'This model has no price yet', '这个模型还没有价格')
  words('page.badge.alias', 'Provider alias', '供应商映射')
  words('page.badge.aliasTip', 'Matched through the provider alias table', '通过供应商别名表匹配到的价格')
  words('page.badge.modelAlias', 'Model mapping', '模型映射')
  words(
    'page.badge.modelAliasTip',
    'This model id is mapped to a canonical model, so the price comes from that model',
    '这个模型名被映射到了标准模型，价格按标准模型计算',
  )
  words('page.badge.crossProvider', 'Same model name', '同名模型')
  words('page.badge.crossProviderTip', 'Price of the same model id under another provider', '同名模型在其他供应商下的价格')
  words('page.badge.fuzzy', 'Fuzzy match', '模糊匹配')
  words('page.badge.fuzzyTip', 'Inexact fuzzy match', '不精确的模糊匹配')

  /* workspaces */
  words('page.section.workspaces', 'By workspace', '按工作区')
  words('page.workspace.refresh', 'Refresh', '刷新')
  words('page.workspaces.empty', 'No workspace data yet', '暂无工作区数据')

  /* prices */
  words('page.section.prices', 'Model prices', '模型价格')
  words('page.price.source', 'Source: {source} · updated {time} · refreshes every 24 hours', '来源：{source} · {time} 更新 · 每 24 小时自动刷新')
  words('page.price.sourceCache', 'local cache', '本地缓存')
  words('page.price.sourceNone', 'not fetched yet', '尚未获取')
  words('page.price.refreshing', 'Refreshing prices from models.dev…', '正在从 models.dev 拉取价格…')
  words('page.price.error', 'Price refresh failed: {message}', '价格刷新失败：{message}')
  words('page.price.refreshed', 'Prices refreshed', '价格已刷新')
  words('page.price.refresh', 'Refresh from models.dev', '从 models.dev 刷新')
  words('page.price.addCustom', '＋ Custom price', '＋ 自定义价格')
  words('page.price.add', 'Add price', '添加价格')
  words('page.price.edit', 'Edit', '编辑')
  words('page.price.input', 'Input', '输入')
  words('page.price.cacheRead', 'Cache read', '缓存读取')
  words('page.price.output', 'Output', '输出')
  words('page.price.perMillion', '/ 1M tokens', '/ 百万 token')
  words('page.price.missingDesc', 'models.dev has no entry for this model; usage is counted but its cost is unknown', 'models.dev 中没有这个模型，用量已统计，成本暂按未知处理')
  words('page.price.pricesEmpty', 'No price data yet', '暂无价格数据')
  words('page.price.rateLabel', 'Rate 1 USD =', '汇率 1 USD =')
  words('page.price.rateUnit', 'CNY', 'CNY')
  words('page.price.rateAuto', 'automatic', '自动')
  words('page.price.rateManual', 'manual', '手动')
  words('page.price.rateBuiltin', 'built-in fallback rate', '内置兜底汇率')
  words('page.price.rateStale', 'Exchange rate not updated ({source})', '汇率未更新（{source}）')
  words('page.price.rateUpdated', '{time} updated', '{time} 更新')
  words('page.price.restoreAuto', 'Use automatic rate', '恢复自动汇率')

  /* dialog */
  words('page.dialog.title', 'Add model price', '添加模型价格')
  words('page.dialog.desc', 'models.dev has no price for this model. USD per 1M tokens; saving recalculates historical usage.', 'models.dev 里找不到这个模型。单位：美元 / 百万 token，保存后历史用量会按这个价格重新计算。')
  words('page.dialog.model', 'Model', '模型')
  words('page.dialog.input', 'Input (uncached)', '输入（未命中缓存）')
  words('page.dialog.output', 'Output', '输出')
  words('page.dialog.cacheRead', 'Cache read (optional)', '缓存读取（可选）')
  words('page.dialog.cacheWrite', 'Cache write (optional)', '缓存写入（可选）')
  words('page.dialog.cacheDefault', 'Defaults to input', '默认同输入')
  words('page.dialog.free', 'Local model, not billed (counted as 0)', '本地模型，不计费（按 0 计算）')
  words('page.dialog.suggestion', 'Maybe {provider}/{model}?', '可能是 {provider}/{model}？')
  words('page.dialog.suggestionFuzzy', 'Maybe {provider}/{model}? (inexact fuzzy match)', '可能是 {provider}/{model}？（不精确的模糊匹配）')
  words('page.dialog.adopt', 'Use it', '采用')
  words('page.dialog.noSuggestionPrice', 'The suggested model has no saved price; enter one below', '这个候选模型还没有已知价格，请在下面填写')
  words('page.dialog.invalid', 'Please fill in both the input and the output price', '请填写输入和输出价格')
  words('page.dialog.saved', 'Saved the price for {model}; historical cost recalculated', '已保存 {model} 的价格，历史成本已重新计算')
  words('page.dialog.remove', 'Remove custom price', '移除自定义价格')
  words('page.dialog.removed', 'Removed the custom price for {model}', '已移除 {model} 的自定义价格')

  /* empty */
  words('page.empty.hint', 'The session index is still being built; this view updates automatically.', '索引仍在扫描，稍后会自动更新。')
})()
