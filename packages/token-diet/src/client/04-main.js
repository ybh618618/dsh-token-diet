/* Locale registration and slot wiring. This part runs inside apply(). */

TD.dicts = TD.dicts || { en: {}, zh: {} }

/** Stylesheet for chrome shared by the three composer/budget surfaces. */
TD.CHROME_CSS = [
  '.td-hidden{display:none}',
].join('\n')

/**
 * Flatten `TD.dicts` into the two dictionaries the locale service takes.
 * Keys are dotted; the locale service stores them verbatim.
 */
function buildDictionaries() {
  var en = {}
  var zh = {}
  var key
  for (key in TD.dicts.en) en[key] = TD.dicts.en[key]
  for (key in TD.dicts.zh) zh[key] = TD.dicts.zh[key]
  return { en: en, zh: zh }
}

TD.apply = function apply(ctx) {
  TD.ctx = ctx

  var NS = 'token-diet'
  var dictionaries = buildDictionaries()

  ctx.effect(function () {
    return ctx.locale.register(NS, dictionaries)
  }, 'token-diet: dictionaries')

  var t = ctx.locale.bind(NS)

  /* Each sheet gets its own key: a shared tag would swallow every later sheet. */
  ctx.effect(function () {
    return TD.util.installStyles(TD.CHROME_CSS, 'token-diet-chrome')
  }, 'token-diet: chrome styles')

  /* Sidebar global entry: the icon cell; the sidebar owns the row and the label. */
  ctx.slots.inject('sidebar.panellist', function () {
    return ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: 'token-diet',
        order: 20,
        label: function () {
          return t('nav.label')
        },
      },
      function SidebarTokenDietIcon(props) {
        var size = props && typeof props.size === 'number' ? props.size : 17
        return TD.util.ICONS.barChart(size, props && props.active)
      }
    )
  })

  /* The overview page itself. */
  ctx.slots.inject('main', function () {
    return ctx.slots.register(
      { name: 'main', key: 'token-diet' },
      function TokenDietPanel(props) {
        return h(TD.StatsPage, Object.assign({}, props, { t: t }))
      }
    )
  })

  /* Budget field beside the model selector. */
  ctx.slots.inject('conversation.input.right', function () {
    return ctx.slots.register(
      { name: 'conversation.input.right', id: 'token-diet-budget', order: -10 },
      function TokenDietBudgetField(props) {
        return h(TD.BudgetField, Object.assign({}, props, { t: t, connection: TD.util.connectionOf(ctx) }))
      }
    )
  })

  /* Budget-reached popover, anchored above the composer's budget field. */
  ctx.slots.inject('conversation.input.overlay', function () {
    return ctx.slots.register(
      { name: 'conversation.input.overlay', id: 'token-diet-budget-popover', order: 50 },
      function TokenDietBudgetPopover(props) {
        return h(TD.BudgetPopover, Object.assign({}, props, { t: t, connection: TD.util.connectionOf(ctx) }))
      }
    )
  })

  /* Ambient record of the stop, below the composer, so the reason stays visible
     after the popover is dismissed. */
  ctx.slots.inject('conversation.composer.dock', function () {
    return ctx.slots.register(
      { name: 'conversation.composer.dock', id: 'token-diet-budget-notice', order: 20 },
      function TokenDietBudgetNotice(props) {
        return h(TD.BudgetNotice, Object.assign({}, props, { t: t, connection: TD.util.connectionOf(ctx) }))
      }
    )
  })

  TD.t = t
}

TD.inject = ['slots', 'locale']
