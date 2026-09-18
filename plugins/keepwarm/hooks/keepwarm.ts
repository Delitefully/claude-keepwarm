import type { Register, Timer } from 'claude-code'

// The keepalive turn. The engine frames a plugin's prompt before drawing it, so
// the marker, not the whole string, is what the render hook matches on.
const MARKER = '[keepwarm]'
const PING = `${MARKER} cache keepalive - reply with one period, nothing else.`

const DEFAULTS = {
  idleMinutes: 50,
  maxBumps: 8,
  minContextTokens: 20_000,
  pollSeconds: 60,
}

let config = DEFAULTS
let lastActivityAt = 0
let bumps = 0
let awaitingReply = false
let stopped = false
let timer: Timer | null = null

// $.env.get takes a literal name so a module's reads can be listed, which is
// why each setting is spelled out rather than looked up in a loop.
const number = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const stop = async ($: any, why: string): Promise<void> => {
  stopped = true
  timer?.cancel()
  timer = null
  await $.ui.log(why)
}

// The analyser only lets `$` reach functions declared at the top of the module,
// so the timer body lives here rather than inside register().
const tick = async ($: any): Promise<void> => {
  // A turn is running, or our own bump has not come back yet.
  if (stopped || awaitingReply) return

  const now = await $.clock.now()
  if (now - lastActivityAt < config.idleMinutes * 60_000) return

  if (bumps >= config.maxBumps) {
    await stop($, `reached ${config.maxBumps} bumps; letting the cache go cold`)
    return
  }

  const home = await $.env.get('HOME')
  if (home && (await $.fs.exists(`${home}/.claude/keepwarm-off`).catch(() => false))) {
    await stop($, 'kill switch present')
    return
  }

  // Submitting while a draft sits in the prompt box would send it as the turn.
  const box = await $.prompt.read()
  if (box.text !== '') return

  // Rebuilding a small cache costs less than paying a read every interval to hold it.
  const usage = await $.session.usage()
  const tokens = usage.context.tokens ?? 0
  if (tokens < config.minContextTokens) {
    await stop($, `context is only ${tokens} tokens; not worth warming`)
    return
  }

  awaitingReply = true
  bumps += 1
  await $.prompt.submit({ text: PING })
}

const start = async ($: any): Promise<void> => {
  config = {
    idleMinutes: number(await $.env.get('KEEPWARM_INTERVAL_MIN'), DEFAULTS.idleMinutes),
    maxBumps: number(await $.env.get('KEEPWARM_MAX_BUMPS'), DEFAULTS.maxBumps),
    minContextTokens: number(await $.env.get('KEEPWARM_MIN_CONTEXT_TOKENS'), DEFAULTS.minContextTokens),
    pollSeconds: number(await $.env.get('KEEPWARM_POLL_SEC'), DEFAULTS.pollSeconds),
  }
  lastActivityAt = await $.clock.now()
  timer = $.clock.every(config.pollSeconds * 1000, () => void tick($))
}

// Any completed turn restarts the idle clock. When the turn that ended was our
// own bump, its usage says whether the keepalive actually kept anything warm.
const settle = async ($: any, wasOurs: boolean, usage: any): Promise<void> => {
  lastActivityAt = await $.clock.now()
  awaitingReply = false
  if (!wasOurs || !usage) return
  const read = usage.cache_read_input_tokens ?? 0
  const created = usage.cache_creation_input_tokens ?? 0
  await $.ui.log(`bump ${bumps} read ${read}, created ${created}`)
  // A keepalive that writes more than it reads is warming nothing, and would
  // bill that write again every interval.
  if (created > read) await stop($, 'a bump wrote more than it read; not repeating it')
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await start($)
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    void settle($, awaitingReply, e.usage)
    return next(e)
  })

  // Draw the keepalive exchange as empty rows. The rewrite is display-only: the
  // stored messages, and what the model reads, are untouched. Both hooks match on
  // what the row itself carries, so a redraw or a scroll hides it again.
  //
  // ctrl+o is the view that shows everything, so the row passes through there.
  on(
    'ui.render',
    { component: 'UserMessage', props: { origin: { kind: 'plugin', name: 'keepwarm' } } },
    ($, e, next) =>
      e.props.isExpanded ? next(e) : next({ ...e, props: { ...e.props, text: '' } }),
  )

  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) =>
    bumps > 0 && e.props.text.trim() === '.'
      ? next({ ...e, props: { ...e.props, text: '' } })
      : next(e),
  )
}
