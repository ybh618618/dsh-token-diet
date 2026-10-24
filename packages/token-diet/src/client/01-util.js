/* Shared client helpers: formatting, RPC, styling primitives. */

TD.dicts = TD.dicts || { en: {}, zh: {} }

TD.util = (function () {
  var MISSING = '\u2014'
  var RPC_CHANNEL = '/token-diet'

  function num(value) {
    return typeof value === 'number' && isFinite(value) ? value : 0
  }

  function fmtTokens(value) {
    var v = num(value)
    var abs = Math.abs(v)
    if (abs >= 1e9) return trim(v / 1e9, 2) + 'B'
    if (abs >= 1e6) return trim(v / 1e6, 2) + 'M'
    if (abs >= 1e3) return trim(v / 1e3, 1) + 'k'
    return String(Math.round(v))
  }

  function trim(value, digits) {
    var text = value.toFixed(digits)
    return text.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
  }

  function fmtNum(value) {
    var v = num(value)
    return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  }

  function fmtPct(ratio) {
    var v = num(ratio)
    return Math.round(v * 100) + '%'
  }

  function fmtCost(usd, currency, rate) {
    var amount = currency === 'CNY' ? num(usd) * num(rate) : num(usd)
    var symbol = currency === 'CNY' ? '\u00a5' : '$'
    var abs = Math.abs(amount)
    if (abs >= 1000) return symbol + trim(amount, 0)
    if (abs >= 1) return symbol + trim(amount, 2)
    if (abs === 0) return symbol + '0.00'
    return symbol + trim(amount, 3)
  }

  /** One formatted money value from a USD amount. */
  function money(ctx, usd) {
    var currency = ctx.currency || 'CNY'
    var rate = ctx.rate || 7.2
    return fmtCost(usd, currency, rate)
  }

  function pad(value) {
    return value < 10 ? '0' + value : String(value)
  }

  function formatDate(dateKey) {
    var parts = String(dateKey || '').split('-')
    if (parts.length !== 3) return String(dateKey || '')
    return Number(parts[1]) + '/' + Number(parts[2])
  }

  function formatDateTime(iso) {
    if (!iso) return MISSING
    var date = new Date(iso)
    if (isNaN(date.getTime())) return MISSING
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
  }

  /**
   * Call one host endpoint. Resolves to the decoded `value` and rejects with an
   * Error carrying `.code`, so callers can render a specific message.
   */
  function rpc(connection, method, payload) {
    if (connection && connection.rpc && typeof connection.rpc.call === 'function') {
      return Promise.resolve(connection.rpc.call(RPC_CHANNEL, method, payload || {}, undefined))
        .then(unwrap)
    }
    return rawRpc(method, payload)
  }

  function unwrap(result) {
    if (!result || result.ok !== true) {
      var failure = result && result.error ? result.error : { code: 'internal', message: 'no result' }
      var error = new Error(failure.message || failure.code || 'rpc failed')
      error.code = failure.code || 'internal'
      error.details = failure.details || {}
      throw error
    }
    return result.value
  }

  function rawRpc(method, payload) {
    var rpcId = 'token-diet-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    return fetch('token-diet/' + method, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: rpcId, method: method, payload: payload || {} }),
    })
      .then(function (response) {
        if (!response.ok) throw new Error('transport failure: HTTP ' + response.status)
        return response.json()
      })
      .then(function (body) {
        if (!body || body.type !== 'server-response') throw new Error('bad response envelope')
        return unwrap(body.result)
      })
  }

  /** Resolve the client Connection service without a hard dependency. */
  function connectionOf(ctx) {
    try {
      var found = ctx.get('connection')
      if (found && found.rpc && typeof found.rpc.call === 'function') return found
    } catch (error) {
      /* composition without the browser carrier */
    }
    return undefined
  }

  var CSS_TAG = 'dsh-token-diet/styles'

  /** Stable 32-bit content hash, so a sheet is identified by what it contains. */
  function cssHash(css) {
    var hash = 5381
    for (var i = 0; i < css.length; i += 1) hash = ((hash << 5) + hash + css.charCodeAt(i)) | 0
    return (hash >>> 0).toString(36)
  }

  /**
   * Insert one stylesheet; returns a disposer.
   *
   * Each sheet needs its own `<style>` element. A single shared tag silently
   * dropped every later sheet: the chrome sheet is installed from `apply()`, so
   * the budget sheet mounted minutes later found a tag that already existed,
   * returned early, and the budget field, popover and notice rendered with no
   * CSS at all. `key` names the sheet explicitly; without one the content hash
   * names it, which also keeps two different sheets from colliding.
   */
  function installStyles(css, key) {
    if (typeof document === 'undefined') return function () {}
    var id = typeof key === 'string' && key.length > 0 ? key : 'css-' + cssHash(css)
    var existing = document.querySelector('style[data-dsh-token-diet="' + id + '"]')
    if (existing !== null && existing !== undefined) return function () {}
    var tag = document.createElement('style')
    tag.dataset.dshTokenDiet = id
    tag.textContent = css
    document.head.appendChild(tag)
    return function () {
      if (tag.parentNode) tag.parentNode.removeChild(tag)
    }
  }

  /** Poll `fn` on an interval, pausing while the document is hidden. */
  function usePolling(fn, intervalMs, enabled) {
    React.useEffect(function () {
      if (enabled === false) return undefined
      var timer = null
      var stopped = false
      var tick = function () {
        if (stopped) return
        fn()
      }
      tick()
      timer = setInterval(tick, intervalMs)
      return function () {
        stopped = true
        if (timer !== null) clearInterval(timer)
      }
    }, [enabled === false, intervalMs])
  }

  /** Observe one ref element's size; returns `[ref, size]`. */
  function useSize() {
    var ref = React.useRef(null)
    var state = React.useState({ width: 0, height: 0 })
    var size = state[0]
    var setSize = state[1]
    React.useEffect(function () {
      var node = ref.current
      if (!node || typeof ResizeObserver === 'undefined') return undefined
      var observer = new ResizeObserver(function (entries) {
        var entry = entries[0]
        if (!entry) return
        setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
      })
      observer.observe(node)
      return function () {
        observer.disconnect()
      }
    }, [])
    return [ref, size]
  }

  var ICONS = {
    barChart: function (size, active) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size || 17, height: size || 17, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M4 20V10' }), h('path', { d: 'M10 20V4' }),
        h('path', { d: 'M16 20v-7' }), h('path', { d: 'M22 20H2' }))
    },
    chevron: function (size) {
      return h('svg', {
        viewBox: '0 0 12 12', width: size || 10, height: size || 10, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true,
      }, h('path', { d: 'M3 4.5l3 3 3-3' }))
    },
    warning: function (size) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size || 18, height: size || 18, fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': true,
      }, h('path', { d: 'M12 3l10 18H2z' }), h('path', { d: 'M12 10v5M12 18v.5' }))
    },
    stop: function (size) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size || 14, height: size || 14, fill: 'currentColor',
        'aria-hidden': true,
      }, h('rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }))
    },
    spark: function (size) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size || 18, height: size || 18, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true,
      }, h('path', { d: 'M12 3l2.5 4.5L19 9l-3 4 .5 5L12 16l-4.5 2 .5-5-3-4 4.5-1.5z' }))
    },
  }

  /** 24-hour clock hour of one ISO timestamp, or `null`. */
  function hourOf(iso) {
    if (!iso) return null
    var date = new Date(iso)
    return isNaN(date.getTime()) ? null : date.getHours()
  }

  return {
    MISSING: MISSING,
    num: num,
    fmtTokens: fmtTokens,
    fmtNum: fmtNum,
    fmtPct: fmtPct,
    fmtCost: fmtCost,
    money: money,
    formatDate: formatDate,
    formatDateTime: formatDateTime,
    rpc: rpc,
    connectionOf: connectionOf,
    installStyles: installStyles,
    usePolling: usePolling,
    useSize: useSize,
    hourOf: hourOf,
    ICONS: ICONS,
  }
})()

TD.dicts.en['nav.label'] = 'Token Usage'
TD.dicts.zh['nav.label'] = 'Token 统计'
TD.dicts.en['common.retry'] = 'Retry'
TD.dicts.zh['common.retry'] = '重试'
TD.dicts.en['common.cancel'] = 'Cancel'
TD.dicts.zh['common.cancel'] = '取消'
TD.dicts.en['common.save'] = 'Save'
TD.dicts.zh['common.save'] = '保存'
TD.dicts.en['common.loading'] = 'Loading…'
TD.dicts.zh['common.loading'] = '加载中…'
TD.dicts.en['common.empty'] = 'No data yet'
TD.dicts.zh['common.empty'] = '暂无数据'
