import type { Register, Timer } from 'claude-code'

// The keepalive turn. The engine frames a plugin's prompt before drawing it, so
// the marker, not the whole string, is what the render hook matches on.
const MARKER = '[keepwarm]'
const PING = `${MARKER} cache keepalive - reply with one period, nothing else.`

const DEFAULTS = {
  idleMinutes: 45,
  ttlMinutes: 60,
  maxBumps: 8,
  minContextTokens: 20_000,
  pollSeconds: 60,
}

let config = DEFAULTS
let lastActivityAt = 0
let bumps = 0
let awaitingReply = false
// Set when a tick found the cache already expired. The next real turn rebuilds
// the cache, so ticks resume after it rather than stopping for good.
let coldUntilNextTurn = false
// Set by /keepwarm pause. Unlike a stop it keeps the timer, so resume picks up
// where the idle clock is.
let paused = false
let stopped = false
let stopReason = ''
let timer: Timer | null = null

// $.env.get takes a literal name so a module's reads can be listed, which is
// why each setting is spelled out rather than looked up in a loop.
const number = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

// The status line is a separate process, so it reads the keepalive's state from
// a file named by the session id it gets on stdin. The id is read on every
// write because a /clear changes it without starting the module again.
const publish = async ($: any): Promise<void> => {
  try {
    const home = await $.env.get('HOME')
    if (!home) return
    const id = await $.session.id()
    const state = {
      state: stopped ? 'stopped' : paused ? 'paused' : 'active',
      cold: coldUntilNextTurn,
      bumps,
      maxBumps: config.maxBumps,
      nextBumpAt: Math.ceil((lastActivityAt + config.idleMinutes * 60_000) / 1000),
      reason: stopReason,
      updatedAt: Math.floor((await $.clock.now()) / 1000),
    }
    await $.fs.write(`${home}/.claude/keepwarm/sessions/${id}.json`, `${JSON.stringify(state)}\n`)
  } catch {
    // The status line going stale is not worth failing a tick over.
  }
}

const stop = async ($: any, why: string): Promise<void> => {
  stopped = true
  stopReason = why
  timer?.cancel()
  timer = null
  await $.ui.log(why)
  await publish($)
}

// The analyser only lets `$` reach functions declared at the top of the module,
// so the timer body lives here rather than inside register().
const tick = async ($: any): Promise<void> => {
  // A turn is running, or our own bump has not come back yet.
  if (stopped || paused || awaitingReply || coldUntilNextTurn) return

  const now = await $.clock.now()
  const idleMinutes = (now - lastActivityAt) / 60_000
  if (idleMinutes < config.idleMinutes) return

  // The timer does not run while the machine sleeps, and a draft in the prompt
  // box defers every tick, so a bump can arrive after the cache already expired.
  // Past the TTL a bump cannot touch anything; it would only rebuild the cache.
  if (idleMinutes >= config.ttlMinutes) {
    coldUntilNextTurn = true
    await $.ui.log(`idle ${Math.round(idleMinutes)}m, past the ${config.ttlMinutes}m cache TTL; the cache is already cold, not bumping until the next turn rebuilds it`)
    await publish($)
    return
  }

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
    ttlMinutes: number(await $.env.get('KEEPWARM_TTL_MIN'), DEFAULTS.ttlMinutes),
    maxBumps: number(await $.env.get('KEEPWARM_MAX_BUMPS'), DEFAULTS.maxBumps),
    minContextTokens: number(await $.env.get('KEEPWARM_MIN_CONTEXT_TOKENS'), DEFAULTS.minContextTokens),
    pollSeconds: number(await $.env.get('KEEPWARM_POLL_SEC'), DEFAULTS.pollSeconds),
  }
  lastActivityAt = await $.clock.now()
  timer = $.clock.every(config.pollSeconds * 1000, () => void tick($))
  await publish($)
  // Refused if another plugin already serves /keepwarm; the keepalive still runs.
  try {
    await $.command.register({
      name: 'keepwarm',
      description: 'Pause, resume or report the prompt-cache keepalive for this session',
      argumentHint: '[pause|resume|status]',
    })
  } catch (err) {
    await $.ui.log(`/keepwarm not registered: ${String(err)}`)
  }
}

const status = async ($: any): Promise<string> => {
  const made = `${bumps} of ${config.maxBumps} bumps made`
  if (stopped) return `stopped: ${stopReason}. ${made}.`
  if (paused) return `paused. ${made}. /keepwarm resume turns it back on.`
  if (coldUntilNextTurn) return `waiting: the cache went cold past the ${config.ttlMinutes}m TTL; bumps resume after your next turn. ${made}.`
  const left = Math.max(0, Math.ceil((lastActivityAt + config.idleMinutes * 60_000 - (await $.clock.now())) / 60_000))
  return `on, next bump in about ${left}m (after ${config.idleMinutes}m idle). ${made}.`
}

// Answering without next() runs no model turn, so the command costs nothing and
// leaves the idle clock alone.
const command = async ($: any, args: string): Promise<{ text: string }> => {
  const verb = args.trim().toLowerCase()
  if (verb === 'pause') {
    paused = true
    await publish($)
    return { text: 'paused for this session. /keepwarm resume turns it back on.' }
  }
  if (verb === 'resume') {
    if (stopped) return { text: `stopped (${stopReason}); it does not restart in this session.` }
    paused = false
    await publish($)
    return { text: await status($) }
  }
  if (verb === '' || verb === 'status') return { text: await status($) }
  return { text: 'usage: /keepwarm [pause|resume|status]' }
}

// Any completed turn restarts the idle clock. When the turn that ended was our
// own bump, its usage says whether the keepalive actually kept anything warm.
const settle = async ($: any, wasOurs: boolean, usage: any): Promise<void> => {
  lastActivityAt = await $.clock.now()
  awaitingReply = false
  coldUntilNextTurn = false
  if (wasOurs && usage) {
    const read = usage.cache_read_input_tokens ?? 0
    const created = usage.cache_creation_input_tokens ?? 0
    await $.ui.log(`bump ${bumps}: cache read ${read} tokens, cache created ${created} tokens`)
    // A keepalive that creates more cache than it reads found the cache cold and
    // rebuilt it, warming nothing; repeating it would bill that write every interval.
    if (created > read) {
      await stop($, `bump ${bumps} rebuilt the cache (read ${read}, created ${created} tokens) instead of touching it; stopping`)
      return
    }
  }
  await publish($)
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

  on('command.run', { command: 'keepwarm' }, ($, e) => command($, e.args))

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
