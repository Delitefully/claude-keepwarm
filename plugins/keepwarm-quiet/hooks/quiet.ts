import type { Register } from 'claude-code'

// The engine skips a plugin's own ui.render hooks for a row that plugin's own
// code raised, so keepwarm cannot blank the prompt it submits. Re-entry is a
// rule about who raised the event, not about the row, so a second plugin can.

const DEFAULTS = ['keepwarm']

let quieted: string[] = DEFAULTS
// The reply is a bare period with nothing to tie it to the ping, so it is only
// blanked in a session where a ping was actually blanked.
let sawPing = false

const start = async ($: any): Promise<void> => {
  const raw = await $.env.get('KEEPWARM_QUIET_PLUGINS')
  const names = String(raw ?? '').split(',').map((n: string) => n.trim()).filter(Boolean)
  if (names.length > 0) quieted = names
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await start($)
    return next(e)
  })

  // ctrl+o is the view that shows everything, so the row passes through there.
  on(
    'ui.render',
    { component: 'UserMessage', props: { origin: { kind: 'plugin' } } },
    ($, e, next) => {
      if (e.props.isExpanded || !quieted.includes(e.props.origin.name)) return next(e)
      sawPing = true
      return next({ ...e, props: { ...e.props, text: '' } })
    },
  )

  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) =>
    sawPing && e.props.text.trim() === '.'
      ? next({ ...e, props: { ...e.props, text: '' } })
      : next(e),
  )
}
