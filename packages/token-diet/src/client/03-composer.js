/* Budget field (conversation.input.right), budget-reached popover
 * (conversation.input.overlay) and the ambient notice (composer dock style).
 *
 * Runs inside the shared client factory closure: `React`, `h` and `TD` exist.
 * Everything below is wrapped in an IIFE so the concatenated bundle cannot
 * collide with the top-level names declared by the other client parts.
 */

;(function () {
  TD.dicts = TD.dicts || { en: {}, zh: {} }

  /* ------------------------------------------------------------------ copy */

  TD.dicts.zh['budget.field.title'] = '本会话预算上限（含子智能体），达到后自动停止任务'
  TD.dicts.zh['budget.field.titleOver'] = '本会话已用 ¥{spent}，上限 ¥{limit}（含子智能体）'
  TD.dicts.zh['budget.field.titleUnlimited'] = '本会话未设预算上限'
  TD.dicts.zh['budget.field.placeholder'] = '不限'
  TD.dicts.zh['budget.field.aria'] = '本会话预算上限（元）'
  TD.dicts.zh['budget.field.ariaUsd'] = '本会话预算上限（美元）'
  TD.dicts.zh['budget.field.unpriced'] = '（{count} 个模型未定价，按 0 计算）'

  TD.dicts.zh['budget.popover.title'] = '已达到预算上限，任务已停止'
  TD.dicts.zh['budget.popover.body'] =
    '本会话已用 {spent}，达到你设置的上限 {limit}（含子智能体）。正在进行的回复已保存，没有发出新的模型请求。'
  TD.dicts.zh['budget.popover.limitLabel'] = '新的预算上限（元）'
  TD.dicts.zh['budget.popover.limitLabelUsd'] = '新的预算上限（美元）'
  TD.dicts.zh['budget.popover.dismiss'] = '知道了'
  TD.dicts.zh['budget.popover.raise'] = '提高预算并继续'
  TD.dicts.zh['budget.popover.validation'] = '新的上限需要高于已用金额 {spent}'

  TD.dicts.zh['budget.notice.reached'] = '已达到本会话预算 {limit}，任务已停止'

  TD.dicts.en['budget.field.title'] =
    'Session budget (sub-agents included); the task stops automatically when it is reached'
  TD.dicts.en['budget.field.titleOver'] =
    'Used ¥{spent} this session, limit ¥{limit} (sub-agents included)'
  TD.dicts.en['budget.field.titleUnlimited'] = 'No budget limit for this session'
  TD.dicts.en['budget.field.placeholder'] = 'None'
  TD.dicts.en['budget.field.aria'] = 'Session budget limit (yuan)'
  TD.dicts.en['budget.field.ariaUsd'] = 'Session budget limit (US dollars)'
  TD.dicts.en['budget.field.unpriced'] = ' ({count} unpriced model(s) counted as 0)'

  TD.dicts.en['budget.popover.title'] = 'Budget limit reached — the task stopped'
  TD.dicts.en['budget.popover.body'] =
    'This session used {spent}, reaching the limit you set at {limit} (sub-agents included). ' +
    'The reply in progress was saved; no new model request was sent.'
  TD.dicts.en['budget.popover.limitLabel'] = 'New budget limit (yuan)'
  TD.dicts.en['budget.popover.limitLabelUsd'] = 'New budget limit (US dollars)'
  TD.dicts.en['budget.popover.dismiss'] = 'Got it'
  TD.dicts.en['budget.popover.raise'] = 'Raise budget and continue'
  TD.dicts.en['budget.popover.validation'] =
    'The new limit must be higher than the amount already used ({spent})'

  TD.dicts.en['budget.notice.reached'] = 'This session reached its budget of {limit}; the task stopped'

  /* --------------------------------------------------------------- helpers */

  var YUAN = '\u00a5'
  var DOLLAR = '$'
  var POLL_MS = 1500
  var FALLBACK_RATE = 7.2
  var DEFAULT_BUDGET_CURRENCY = 'CNY'

  function symbolOf(currency) {
    return currency === 'USD' ? DOLLAR : YUAN
  }

  function currencyOf(value) {
    return value === 'USD' ? 'USD' : 'CNY'
  }

  function isNumber(value) {
    return typeof value === 'number' && isFinite(value)
  }

  function numOr(value, fallback) {
    return isNumber(value) ? value : fallback
  }

  function rateOf(value) {
    var rate = numOr(value, 0)
    return rate > 0 ? rate : FALLBACK_RATE
  }

  /** Convert an amount between the two display currencies through one rate. */
  function convert(amount, from, to, rate) {
    var value = numOr(amount, 0)
    if (from === to) return value
    var r = rateOf(rate)
    return from === 'USD' ? value * r : value / r
  }

  /**
   * `TD.util.money` trims trailing zeros (¥1, $2.4) and keeps three decimals
   * for sub-unit amounts. Budget copy is always two decimals (¥1.00, ¥0.62), so
   * normalise the helper's output instead of formatting money by hand.
   */
  function twoDecimals(text) {
    var match = /^([^\d-]*)(-?[\d,]+(?:\.\d+)?)$/.exec(text)
    if (!match) return text
    var value = Number(match[2].replace(/,/g, ''))
    if (!isFinite(value) || Math.abs(value) >= 1000) return text
    return match[1] + value.toFixed(2)
  }

  /** Money text for a USD amount, in `currency` — delegates to TD.util.money. */
  function moneyText(usd, currency, rate) {
    return twoDecimals(TD.util.money({ currency: currency, rate: rate }, numOr(usd, 0)))
  }

  /** The same money text without its leading currency symbol. */
  function bareMoney(usd, currency, rate) {
    var text = moneyText(usd, currency, rate)
    var head = text.charAt(0)
    return head === YUAN || head === DOLLAR ? text.slice(1) : text
  }

  /**
   * The prototype hard-codes the yuan mark inside its copy. Keep the copy
   * verbatim and swap the mark for the currency actually being displayed.
   */
  function currencyMark(text, currency) {
    if (currency === 'CNY') return String(text)
    return String(text).split(YUAN).join(symbolOf(currency))
  }

  /** Text shown inside the limit input: '' means unlimited. */
  function formatLimit(limit) {
    if (!isNumber(limit)) return ''
    var rounded = Math.round(limit * 100) / 100
    return Math.abs(limit - rounded) < 1e-9 ? rounded.toFixed(2) : String(limit)
  }

  /**
   * Parse the limit input. Empty means "no limit"; anything that is not a
   * finite number >= 0 is rejected so the caller can restore the old value.
   */
  function parseLimit(text) {
    if (typeof text !== 'string') return { ok: false }
    var cleaned = text.replace(/[\s,\u00a5$]/g, '')
    if (cleaned === '') return { ok: true, value: null }
    if (!/^[0-9]*\.?[0-9]+$/.test(cleaned)) return { ok: false }
    var value = Number(cleaned)
    if (!isFinite(value) || value < 0) return { ok: false }
    return { ok: true, value: value }
  }

  /** `limit + 1` rounded up to the next 0.5, or `spent + 1` when unlimited. */
  function suggestionFor(spentInBudget, limit) {
    var base = isNumber(limit) ? limit : numOr(spentInBudget, 0)
    return Math.max(0.5, Math.ceil((base + 1) * 2) / 2)
  }

  function interpolate(text, vars) {
    if (!vars || typeof text !== 'string') return text
    return text.replace(/\{([a-zA-Z0-9_]+)\}/g, function (match, name) {
      var value = vars[name]
      return value == null ? match : String(value)
    })
  }

  /** Resolve the locale binder `t` from props / the wiring, with a dictionary fallback. */
  function useT(props) {
    var bound = props && typeof props.t === 'function' ? props.t : null
    if (!bound && typeof TD.t === 'function') bound = TD.t
    return function t(key, vars) {
      var text = null
      if (bound) {
        try {
          text = bound(key, vars)
        } catch (error) {
          text = null
        }
      }
      if (text == null || text === '' || text === key) {
        text = TD.dicts.zh[key]
        if (text == null) text = TD.dicts.en[key]
      }
      if (text == null) text = key
      return interpolate(String(text), vars)
    }
  }

  function connectionFor(props) {
    if (props && props.connection) return props.connection
    return TD.util.connectionOf(TD.ctx)
  }

  /** Always returns a promise: a missing transport must not throw at render time. */
  function callRpc(connection, method, payload) {
    try {
      return Promise.resolve(TD.util.rpc(connection, method, payload))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  function errorText(error) {
    return error && error.message ? String(error.message) : 'rpc failed'
  }

  /* ------------------------------------------------------------------ css */

  var BUDGET_CSS = [
    '.td-bud-field{display:inline-flex;align-items:center;gap:2px;box-sizing:border-box;',
    'height:28px;padding:0 4px 0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;',
    'background:transparent;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1;',
    'white-space:nowrap;cursor:text;',
    'transition:border-color .15s ease,background-color .15s ease,box-shadow .15s ease}',
    '.td-bud-field:focus-within{border-color:var(--dsw-alias-brand-primary);',
    'box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}',
    '.td-bud-field[data-state="warn"]{',
    'border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,var(--dsw-alias-border-l1));',
    'background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent)}',
    '.td-bud-field[data-state="warn"] .td-bud-used{color:var(--dsw-alias-state-warn-primary);font-weight:600}',
    '.td-bud-field[data-state="over"]{',
    'border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 50%,var(--dsw-alias-border-l1));',
    'background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}',
    '.td-bud-field[data-state="over"] .td-bud-used{color:var(--dsw-alias-state-error-primary);font-weight:600}',
    '.td-bud-used{font-variant-numeric:tabular-nums;color:inherit}',
    '.td-bud-sep{color:var(--dsw-alias-label-tertiary);margin:0 2px}',
    '.td-bud-sym{color:var(--dsw-alias-label-tertiary)}',
    '.td-bud-input{width:54px;min-width:0;height:22px;margin:0;padding:0 2px;border:0;outline:none;',
    'background:transparent;font:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary);',
    'font-variant-numeric:tabular-nums;appearance:textfield;-moz-appearance:textfield}',
    '.td-bud-input::placeholder{color:var(--dsw-alias-label-tertiary)}',
    '.td-bud-input::-webkit-outer-spin-button,.td-bud-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}',

    '.td-bud-pop{--td-bud-pop-bg:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-l1,var(--dsw-alias-bg-base)));',
    /* Placed from measured viewport coordinates (see usePopoverPlacement): the
     * `conversation.input.overlay` slot renders in the composer's normal flow, so
     * an absolutely positioned card anchored to it landed inside the composer
     * instead of floating above it. `left`/`top` are written inline per open. */
    'position:fixed;left:0;top:0;z-index:60;box-sizing:border-box;',
    'width:420px;max-width:calc(100vw - 32px);',
    'padding:16px 18px 14px;',
    'background:var(--td-bud-pop-bg);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;',
    'box-shadow:0 12px 32px var(--dsw-alias-bg-mask-2,color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent)),',
    '0 2px 8px var(--dsw-alias-bg-mask-1,color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent));',
    'color:var(--dsw-alias-label-primary);font-size:13px;',
    'transform-origin:var(--td-bud-arrow-x,85%) 100%;',
    'animation:td-bud-pop-in .16s ease-out}',
    '@keyframes td-bud-pop-in{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}',
    '.td-bud-pop::after{content:"";position:absolute;left:var(--td-bud-arrow-x,48px);bottom:-7px;width:12px;height:12px;',
    'background:var(--td-bud-pop-bg);border-right:1px solid var(--dsw-alias-border-l1);',
    'border-bottom:1px solid var(--dsw-alias-border-l1);transform:rotate(45deg)}',
    '.td-bud-pop[data-anchor="below"]::after{bottom:auto;top:-7px;transform:rotate(225deg)}',
    '.td-bud-pop-head{display:flex;gap:14px;align-items:flex-start}',
    '.td-bud-pop-tile{width:40px;height:40px;flex:none;display:grid;place-items:center;border-radius:10px;',
    'background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);',
    'color:var(--dsw-alias-state-error-primary)}',
    '.td-bud-pop-main{flex:1;min-width:0}',
    '.td-bud-pop-title{margin:0 0 4px;font-size:14.5px;font-weight:600;line-height:1.35;',
    'color:var(--dsw-alias-label-primary)}',
    '.td-bud-pop-body{margin:0 0 12px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.55}',
    '.td-bud-pop-label{display:block;margin-bottom:5px;font-size:12.5px;color:var(--dsw-alias-label-secondary)}',
    '.td-bud-pop-input{width:100%;box-sizing:border-box;height:36px;padding:0 10px;border-radius:8px;',
    'border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base,transparent);',
    'color:var(--dsw-alias-label-primary);font:inherit;font-size:13.5px;font-variant-numeric:tabular-nums;outline:none}',
    '.td-bud-pop-input:focus{border-color:var(--dsw-alias-brand-primary);',
    'box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}',
    '.td-bud-validation{margin:6px 0 0;font-size:12.5px;line-height:1.45;',
    'color:var(--dsw-alias-state-error-primary)}',
    '.td-bud-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}',
    '.td-bud-btn{height:32px;padding:0 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);',
    'background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;',
    'transition:background-color .15s ease,opacity .15s ease}',
    '.td-bud-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
    '.td-bud-btn[data-variant="primary"]{background:var(--dsw-alias-button-primary-fill);',
    'border-color:var(--dsw-alias-button-primary-fill);',
    'color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-bg-base))}',
    '.td-bud-btn[data-variant="primary"]:hover{background:var(--dsw-alias-button-primary-hover);',
    'border-color:var(--dsw-alias-button-primary-hover)}',
    '.td-bud-btn:disabled{opacity:.55;cursor:default}',
    '.td-bud-btn:focus-visible,.td-bud-pop-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);',
    'outline-offset:2px}',

    '.td-bud-notice{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;min-width:0;',
    'margin:6px 0 0;padding:8px 12px;border-radius:8px;',
    'font-size:12.5px;line-height:1.45;color:var(--dsw-alias-state-error-primary);',
    'background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);',
    'border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 28%,transparent)}',
    '.td-bud-notice>span:last-child{min-width:0;overflow-wrap:anywhere}',
    '.td-bud-notice-icon{display:inline-flex;flex:none}',

    '@media (prefers-reduced-motion:reduce){.td-bud-pop{animation:none}}',
  ].join('\n')

  /* One shared <style> element, ref-counted so an unmounting component cannot
   * remove the sheet while a sibling still needs it. */
  var styleUsers = 0
  var styleDisposer = null

  function useBudgetStyles() {
    React.useEffect(function () {
      styleUsers += 1
      if (styleUsers === 1) styleDisposer = TD.util.installStyles(BUDGET_CSS, 'token-diet-budget')
      return function () {
        styleUsers -= 1
        if (styleUsers > 0) return
        styleUsers = 0
        if (styleDisposer) {
          styleDisposer()
          styleDisposer = null
        }
      }
    }, [])
  }

  /* ------------------------------------------------------- shared data path */

  /* Both slots poll on their own, but a mutation should reach the sibling
   * immediately instead of waiting for its next 1500 ms tick. */
  var budgetListeners = []

  function publishBudget(sessionId, value) {
    if (!sessionId || !value || typeof value !== 'object') return
    var listeners = budgetListeners.slice()
    for (var i = 0; i < listeners.length; i += 1) {
      try {
        listeners[i](sessionId, value)
      } catch (error) {
        /* a listener must never break the publisher */
      }
    }
  }

  function subscribeBudget(listener) {
    budgetListeners.push(listener)
    return function () {
      var index = budgetListeners.indexOf(listener)
      if (index >= 0) budgetListeners.splice(index, 1)
    }
  }

  function useAlive() {
    var ref = React.useRef(true)
    React.useEffect(function () {
      ref.current = true
      return function () {
        ref.current = false
      }
    }, [])
    return ref
  }

  /**
   * Poll `sessionCost` every 1500 ms while mounted, refresh on session change,
   * and ignore out-of-order responses plus writes after unmount.
   */
  function useSessionCost(props) {
    var sessionId =
      props && typeof props.sessionId === 'string' && props.sessionId ? props.sessionId : null
    var connection = connectionFor(props)
    var alive = useAlive()

    useBudgetStyles()

    var payloadState = React.useState(null)
    var payload = payloadState[0]
    var setPayload = payloadState[1]
    var errorState = React.useState(null)
    var error = errorState[0]
    var setError = errorState[1]
    var seqRef = React.useRef(0)

    var refresh = React.useCallback(
      function () {
        if (!sessionId) return Promise.resolve(null)
        seqRef.current += 1
        var seq = seqRef.current
        return callRpc(connection, 'sessionCost', { sessionId: sessionId }).then(
          function (value) {
            if (!alive.current || seq !== seqRef.current) return null
            setPayload(value && typeof value === 'object' ? value : null)
            setError(null)
            return value
          },
          function (failure) {
            if (!alive.current || seq !== seqRef.current) return null
            setError(errorText(failure))
            return null
          }
        )
      },
      [sessionId, connection]
    )

    var refreshRef = React.useRef(refresh)
    refreshRef.current = refresh
    var previousSessionRef = React.useRef(null)

    /* Session change: drop stale data and refetch right away. The initial mount
     * is left to usePolling's own immediate tick, so mount costs one request. */
    React.useEffect(
      function () {
        seqRef.current += 1
        var first = previousSessionRef.current === null
        previousSessionRef.current = sessionId
        setPayload(null)
        setError(null)
        if (sessionId && !first) refreshRef.current()
        return function () {
          /* invalidate anything still in flight for the old session */
          seqRef.current += 1
        }
      },
      [sessionId]
    )

    /* Mutations performed by the sibling component land here immediately. */
    React.useEffect(
      function () {
        if (!sessionId) return undefined
        return subscribeBudget(function (changedSession, value) {
          if (changedSession !== sessionId || !alive.current) return
          seqRef.current += 1
          setPayload(value && typeof value === 'object' ? value : null)
          setError(null)
        })
      },
      [sessionId]
    )

    TD.util.usePolling(
      function () {
        refreshRef.current()
      },
      POLL_MS,
      Boolean(sessionId)
    )

    return {
      sessionId: sessionId,
      payload: payload,
      error: error,
      refresh: refresh,
      alive: alive,
    }
  }

  /** Normalise one `sessionCost` payload into everything the UI needs. */
  function budgetView(payload) {
    var displayCurrency = currencyOf(payload && payload.currency)
    var budgetCurrency = currencyOf(
      payload && payload.budgetCurrency ? payload.budgetCurrency : DEFAULT_BUDGET_CURRENCY
    )
    var rate = rateOf(payload && payload.rate)

    /*
     * `spent` arrives ALREADY converted into `currency` (the host returns CNY for
     * a CNY session), so it must never be multiplied by `rate` again — doing that
     * inflated the field by the exchange rate (~6.7x). Prefer the explicit USD
     * figure and fall back to converting `spent` back from the display currency,
     * which works with either host shape.
     */
    var spentShownAmount = numOr(payload && payload.spent, 0)
    var spent = isNumber(payload && payload.spentUsd)
      ? numOr(payload.spentUsd, 0) /* USD */
      : convert(spentShownAmount, displayCurrency, 'USD', rate)
    var limit = isNumber(payload && payload.limit) ? payload.limit : null /* budgetCurrency */

    var spentShown = convert(spent, 'USD', displayCurrency, rate)
    var limitShown = limit == null ? null : convert(limit, budgetCurrency, displayCurrency, rate)
    var spentInBudget = convert(spentShown, displayCurrency, budgetCurrency, rate)

    var ratio = limitShown != null && limitShown > 0 ? spentShown / limitShown : 0
    var reached = Boolean(payload && payload.reached)
    var over = reached || (limitShown != null && limitShown > 0 && spentShown >= limitShown)
    var warn = !over && limitShown != null && limitShown > 0 && ratio >= 0.8
    var unpriced = numOr(payload && payload.unpriced, 0)

    return {
      payload: payload,
      displayCurrency: displayCurrency,
      budgetCurrency: budgetCurrency,
      rate: rate,
      spent: spent,
      limit: limit,
      spentShown: spentShown,
      limitShown: limitShown,
      spentInBudget: spentInBudget,
      ratio: ratio,
      reached: reached,
      over: over,
      warn: warn,
      unpriced: unpriced,
      level: over ? 'over' : warn ? 'warn' : 'ok',
      usedText: moneyText(spent, displayCurrency, rate),
      limitText:
        limit == null
          ? TD.util.MISSING
          : moneyText(convert(limit, budgetCurrency, 'USD', rate), displayCurrency, rate),
    }
  }

  /* -------------------------------------------------------- budget field */

  TD.BudgetField = function BudgetField(inputProps) {
    var props = inputProps || {}
    var t = useT(props)
    var cost = useSessionCost(props)
    var alive = cost.alive
    var view = budgetView(cost.payload)

    var draftState = React.useState('')
    var draft = draftState[0]
    var setDraft = draftState[1]
    var failureState = React.useState(null)
    var failure = failureState[0]
    var setFailure = failureState[1]
    var dirtyRef = React.useRef(false)
    var busyRef = React.useRef(false)

    /* Follow the persisted limit unless the user is mid-edit. */
    var limitKey = (view.limit == null ? '' : String(view.limit)) + '|' + view.budgetCurrency
    React.useEffect(
      function () {
        if (dirtyRef.current) return
        setDraft(formatLimit(view.limit))
      },
      [limitKey]
    )

    function commit(text) {
      if (busyRef.current || !cost.sessionId) return
      var previous = formatLimit(view.limit)
      var parsed = parseLimit(text)
      dirtyRef.current = false
      if (!parsed.ok) {
        setDraft(previous)
        return
      }
      var value = parsed.value
      var unchanged =
        value == null
          ? view.limit == null
          : view.limit != null && Math.abs(value - view.limit) < 1e-9
      setDraft(formatLimit(value))
      setFailure(null)
      if (unchanged) return
      busyRef.current = true
      callRpc(connectionFor(props), 'setBudget', {
        sessionId: cost.sessionId,
        limit: value,
        currency: view.budgetCurrency,
      }).then(
        function (result) {
          busyRef.current = false
          if (!alive.current) return
          /* Publish first so the popover updates without waiting, then refresh
           * to pick up anything the host recomputed (spent/rate). */
          publishBudget(cost.sessionId, result)
          cost.refresh()
        },
        function (error) {
          busyRef.current = false
          if (!alive.current) return
          dirtyRef.current = false
          setDraft(previous)
          setFailure(errorText(error))
        }
      )
    }

    function titleText() {
      if (failure) return failure
      if (view.limit == null) return t('budget.field.titleUnlimited')
      var text
      if (view.over) {
        text = currencyMark(
          t('budget.field.titleOver', {
            spent: bareMoney(view.spent, view.displayCurrency, view.rate),
            limit: bareMoney(
              convert(view.limit, view.budgetCurrency, 'USD', view.rate),
              view.displayCurrency,
              view.rate
            ),
          }),
          view.displayCurrency
        )
      } else {
        text = t('budget.field.title')
      }
      if (view.unpriced > 0) text = text + t('budget.field.unpriced', { count: view.unpriced })
      return text
    }

    var field = h(
      'label',
      {
        className: 'td-bud-field',
        'data-state': view.level,
        title: titleText(),
      },
      h('span', { className: 'td-bud-used' }, view.usedText),
      h('span', { className: 'td-bud-sep', 'aria-hidden': true }, '/'),
      h('span', { className: 'td-bud-sym', 'aria-hidden': true }, symbolOf(view.budgetCurrency)),
      h('input', {
        className: 'td-bud-input',
        type: 'text',
        inputMode: 'decimal',
        autoComplete: 'off',
        spellCheck: false,
        'aria-label':
          view.budgetCurrency === 'USD' ? t('budget.field.ariaUsd') : t('budget.field.aria'),
        'aria-invalid': view.over ? 'true' : undefined,
        placeholder: t('budget.field.placeholder'),
        value: draft,
        onChange: function (event) {
          dirtyRef.current = true
          setDraft(event && event.target ? String(event.target.value) : '')
        },
        onBlur: function (event) {
          commit(event && event.target ? String(event.target.value) : draft)
        },
        onKeyDown: function (event) {
          if (!event) return
          if (event.key === 'Enter') {
            if (event.preventDefault) event.preventDefault()
            commit(draft)
          } else if (event.key === 'Escape') {
            if (event.preventDefault) event.preventDefault()
            if (event.stopPropagation) event.stopPropagation()
            dirtyRef.current = false
            setFailure(null)
            setDraft(formatLimit(view.limit))
          }
        },
      })
    )

    return cost.sessionId ? field : null
  }

  /* ------------------------------------------------------ budget popover */

  /**
   * Anchor geometry for the reached-budget card.
   *
   * The card is a real floating dialog: it sits above the budget field, right
   * edges aligned, with its arrow pointing at the field's centre. Two things
   * make that reliable:
   *
   * 1. it is placed from the field's measured viewport rect, so it does not
   *    depend on the overlay slot being positioned (the slot renders in the
   *    composer's normal flow, which used to put the card inside the composer);
   * 2. it is clamped into the viewport, and the arrow tracks the field's centre.
   *
   * A container that hosts the slot inside a transformed subtree can still turn
   * `position:fixed` into a local containing block; the promo stage mounts this
   * component into a body-level host for exactly that reason.
   */
  var POPOVER_GAP = 14
  var POPOVER_MARGIN = 16

  function budgetFieldElement() {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null
    var node = document.querySelector('.td-bud-field')
    return node && typeof node.getBoundingClientRect === 'function' ? node : null
  }

  function usePopoverPlacement(open, cardRef) {
    var state = React.useState(null)
    var placement = state[0]
    var setPlacement = state[1]

    var measure = React.useCallback(
      function () {
        if (!open) return
        var card = cardRef.current
        var anchor = budgetFieldElement()
        if (!card || !anchor) return
        var box = anchor.getBoundingClientRect()
        if (!box || !box.width) return
        var viewportWidth =
          typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1280
        var viewportHeight =
          typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 800
        var width = card.offsetWidth || 420
        var height = card.offsetHeight || 240
        var left = Math.round(box.right - width)
        left = Math.max(POPOVER_MARGIN, Math.min(left, viewportWidth - width - POPOVER_MARGIN))
        var top = Math.round(box.top - POPOVER_GAP - height)
        var side = 'above'
        if (top < POPOVER_MARGIN) {
          side = 'below'
          top = Math.round(box.bottom + POPOVER_GAP)
          top = Math.max(POPOVER_MARGIN, Math.min(top, viewportHeight - height - POPOVER_MARGIN))
        }
        var arrow = Math.round(box.left + box.width / 2 - left - 6)
        arrow = Math.max(14, Math.min(arrow, width - 28))
        setPlacement({ left: left, top: top, arrow: arrow, side: side, mode: 'fixed' })
      },
      [open]
    )

    React.useLayoutEffect(
      function () {
        if (!open) {
          setPlacement(null)
          return
        }
        measure()
      },
      [open, measure]
    )

    React.useEffect(
      function () {
        if (!open || typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
          return undefined
        }
        var onChange = function () {
          measure()
        }
        window.addEventListener('resize', onChange)
        window.addEventListener('scroll', onChange, true)
        return function () {
          window.removeEventListener('resize', onChange)
          window.removeEventListener('scroll', onChange, true)
        }
      },
      [open, measure]
    )

    return placement
  }

  TD.BudgetPopover = function BudgetPopover(inputProps) {
    var props = inputProps || {}
    var t = useT(props)
    var cost = useSessionCost(props)
    var alive = cost.alive
    var view = budgetView(cost.payload)

    var dismissedState = React.useState(false)
    var dismissed = dismissedState[0]
    var setDismissed = dismissedState[1]
    var busyState = React.useState(false)
    var busy = busyState[0]
    var setBusy = busyState[1]
    var draftState = React.useState('')
    var draft = draftState[0]
    var setDraft = draftState[1]
    var validationState = React.useState(null)
    var validation = validationState[0]
    var setValidation = validationState[1]
    var inputRef = React.useRef(null)
    var cardRef = React.useRef(null)

    var suggestion = suggestionFor(view.spentInBudget, view.limit)
    var suggestionRef = React.useRef(suggestion)
    suggestionRef.current = suggestion

    var open = Boolean(view.reached && !dismissed)
    var placement = usePopoverPlacement(open, cardRef)

    /* Re-arm once the host reports the session is inside its budget again. */
    React.useEffect(
      function () {
        if (!view.reached && dismissed) setDismissed(false)
      },
      [view.reached]
    )

    /* On open: prefill a sensible new limit and take focus. */
    React.useEffect(
      function () {
        if (!open) return
        setDraft(formatLimit(suggestionRef.current))
        setValidation(null)
        var node = inputRef.current
        if (node && typeof node.focus === 'function') node.focus()
      },
      [open]
    )

    function dismiss() {
      if (busy || !cost.sessionId) return
      setDismissed(true)
      setValidation(null)
      callRpc(connectionFor(props), 'dismissBudget', { sessionId: cost.sessionId }).then(
        function () {
          if (alive.current) cost.refresh()
        },
        function (error) {
          if (alive.current) setValidation(errorText(error))
        }
      )
    }

    function raise() {
      if (busy || !cost.sessionId) return
      var parsed = parseLimit(draft)
      if (!parsed.ok || parsed.value == null) {
        setValidation(t('budget.popover.validation', { spent: view.usedText }))
        return
      }
      var typedShown = convert(parsed.value, view.budgetCurrency, view.displayCurrency, view.rate)
      if (!(typedShown > view.spentShown)) {
        setValidation(t('budget.popover.validation', { spent: view.usedText }))
        return
      }
      setBusy(true)
      setValidation(null)
      callRpc(connectionFor(props), 'raiseBudgetAndContinue', {
        sessionId: cost.sessionId,
        limit: parsed.value,
        currency: view.budgetCurrency,
      }).then(
        function (result) {
          setBusy(false)
          if (!alive.current) return
          /* The guard already resumed the step: hide, push the new state to the
           * sibling field, and re-read the host so nothing is stale. */
          setDismissed(true)
          publishBudget(cost.sessionId, result)
          cost.refresh()
        },
        function (error) {
          setBusy(false)
          if (!alive.current) return
          setValidation(errorText(error))
        }
      )
    }

    if (!cost.sessionId || !open) return null

    /* Until the field has been measured the card is laid out but invisible:
     * `offsetWidth`/`offsetHeight` are needed to place it, and rendering it in
     * flow for one frame would flash it inside the composer. */
    var cardStyle =
      placement === null
        ? { position: 'fixed', left: '-9999px', top: '0px', visibility: 'hidden' }
        : {
            position: placement.mode,
            left: placement.left + 'px',
            top: placement.top + 'px',
            '--td-bud-arrow-x': placement.arrow + 'px',
          }

    return h(
      'div',
      {
        ref: cardRef,
        className: 'td-bud-pop',
        style: cardStyle,
        'data-anchor': placement === null ? undefined : placement.side,
        role: 'alertdialog',
        'aria-modal': 'true',
        'aria-labelledby': 'td-bud-pop-title',
        'aria-describedby': 'td-bud-pop-body',
        onKeyDown: function (event) {
          if (event && event.key === 'Escape') {
            if (event.preventDefault) event.preventDefault()
            if (event.stopPropagation) event.stopPropagation()
            dismiss()
          }
        },
      },
      h(
        'div',
        { className: 'td-bud-pop-head' },
        h('div', { className: 'td-bud-pop-tile', 'aria-hidden': true }, TD.util.ICONS.stop(16)),
        h(
          'div',
          { className: 'td-bud-pop-main' },
          h(
            'h3',
            { className: 'td-bud-pop-title', id: 'td-bud-pop-title' },
            t('budget.popover.title')
          ),
          h(
            'p',
            { className: 'td-bud-pop-body', id: 'td-bud-pop-body' },
            t('budget.popover.body', { spent: view.usedText, limit: view.limitText })
          ),
          h(
            'label',
            { className: 'td-bud-pop-label', htmlFor: 'td-bud-pop-input' },
            view.budgetCurrency === 'USD'
              ? t('budget.popover.limitLabelUsd')
              : t('budget.popover.limitLabel')
          ),
          h('input', {
            className: 'td-bud-pop-input',
            id: 'td-bud-pop-input',
            ref: inputRef,
            type: 'text',
            inputMode: 'decimal',
            autoComplete: 'off',
            spellCheck: false,
            'aria-label':
              view.budgetCurrency === 'USD'
                ? t('budget.popover.limitLabelUsd')
                : t('budget.popover.limitLabel'),
            value: draft,
            onChange: function (event) {
              setDraft(event && event.target ? String(event.target.value) : '')
            },
            onKeyDown: function (event) {
              if (event && event.key === 'Enter') {
                if (event.preventDefault) event.preventDefault()
                raise()
              }
            },
          }),
          validation ? h('p', { className: 'td-bud-validation', role: 'alert' }, validation) : null
        )
      ),
      h(
        'div',
        { className: 'td-bud-actions' },
        h(
          'button',
          { type: 'button', className: 'td-bud-btn', onClick: dismiss },
          t('budget.popover.dismiss')
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'td-bud-btn',
            'data-variant': 'primary',
            'aria-busy': busy ? 'true' : undefined,
            disabled: busy,
            onClick: raise,
          },
          t('budget.popover.raise')
        )
      )
    )
  }

  /* ------------------------------------------------------- budget notice */

  TD.BudgetNotice = function BudgetNotice(inputProps) {
    var props = inputProps || {}
    var t = useT(props)
    var cost = useSessionCost(props)
    var view = budgetView(cost.payload)

    if (!cost.sessionId || !view.reached) return null

    return h(
      'div',
      { className: 'td-bud-notice', role: 'status' },
      h('span', { className: 'td-bud-notice-icon', 'aria-hidden': true }, TD.util.ICONS.stop(12)),
      h('span', null, t('budget.notice.reached', { limit: view.limitText }))
    )
  }
})()
