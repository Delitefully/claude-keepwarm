import type { Register, Timer } from 'claude-code'

// The keepalive request. $.model.fork re-sends the main thread's last request
// with this one message after it, so the API serves everything before it from
// the session's own cache entry. Nothing is appended to the transcript.
const PING = '[keepwarm] cache keepalive - reply with one period, nothing else.'

const DEFAULTS = {
  idleMinutes: 45,
  ttlMinutes: 60,
  maxBumps: 8,
  minContextTokens: 20_000,
  pollSeconds: 60,
}

// Consecutive bumps that came back with an API error before it gives up.
const MAX_ERRORS = 3

let config = DEFAULTS
let lastActivityAt = 0
let bumps = 0
let errors = 0
let lastBumpAt = 0
// A main-thread turn is running, so the cache is in use without us.
let busy = false
let bumping = false
// Set when a tick found the cache already expired, or when the last request
// the fork would replay no longer matches the conversation (a compaction).
// The next real turn sends a fresh request, so ticks resume after it.
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
      lastBumpAt: Math.floor(lastBumpAt / 1000),
      reason: stopReason,
      updatedAt: Math.floor((await $.clock.now()) / 1000),
    }
    await $.fs.write(`${home}/.claude/keepwarm/sessions/${id}.json`, `${JSON.stringify(state)}\n`)
  } catch {
    // The status line going stale is not worth failing a tick over.
  }
}

// Every line goes to the debug log, not the transcript: the status line and
// /keepwarm are where the keepalive shows itself.
const note = async ($: any, line: string): Promise<void> => {
  await $.ui.log(line, { to: 'debug' })
}

const stop = async ($: any, why: string): Promise<void> => {
  stopped = true
  stopReason = why
  timer?.cancel()
  timer = null
  await note($, why)
  await publish($)
}

// The engine gives a fork the 5m cache TTL whatever the main thread uses,
// because forks are not on its 1h list. A fork still reads the 1h entry, but
// whether a 5m read extends a 1h entry by an hour is the API's business, and
// any tail it writes would live 5m. The subagent TTL variable is read per
// request, so it is set for this one request and put back after.
const fork = async ($: any): Promise<any> => {
  if (config.ttlMinutes < 60) return $.model.fork({ prompt: PING })
  const before = await $.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL')
  await $.env.set('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', '1h')
  try {
    return await $.model.fork({ prompt: PING })
  } finally {
    await $.env.set('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', before)
  }
}

const bump = async ($: any): Promise<void> => {
  bumping = true
  try {
    const r = await fork($)
    if (!('usage' in r)) {
      // nothing-to-fork: no main-thread request since a /clear or a resume.
      coldUntilNextTurn = true
      await note($, `nothing to fork (${r.reason}); waiting for the next turn`)
      await publish($)
      return
    }
    const read = r.usage.cache_read_input_tokens ?? 0
    const created = r.usage.cache_creation_input_tokens ?? 0
    if (!r.isAnswered && r.reason === 'api-error') {
      errors += 1
      await note($, `bump failed: API error ${r.status ?? 'no status'} (${r.error})`)
      if (errors >= MAX_ERRORS) await stop($, `${errors} bumps in a row failed with an API error; stopping`)
      return
    }
    // An empty reply or an abort still sent the prefix, so it counts.
    errors = 0
    bumps += 1
    lastBumpAt = await $.clock.now()
    lastActivityAt = lastBumpAt
    await note($, `bump ${bumps}: cache read ${read} tokens, cache created ${created} tokens`)
    // A keepalive that creates more cache than it reads found the cache cold and
    // rebuilt it, warming nothing; repeating it would bill that write every interval.
    if (created > read) {
      await stop($, `bump ${bumps} rebuilt the cache (read ${read}, created ${created} tokens) instead of touching it; stopping`)
      return
    }
    await publish($)
  } finally {
    bumping = false
  }
}

// The analyser only lets `$` reach functions declared at the top of the module,
// so the timer body lives here rather than inside register().
const tick = async ($: any): Promise<void> => {
  if (stopped || paused || busy || bumping || coldUntilNextTurn) return

  const now = await $.clock.now()
  const idleMinutes = (now - lastActivityAt) / 60_000
  if (idleMinutes < config.idleMinutes) return

  // The timer does not run while the machine sleeps, so a bump can come due
  // after the cache already expired. Past the TTL a bump cannot touch anything;
  // it would only rebuild the cache.
  if (idleMinutes >= config.ttlMinutes) {
    coldUntilNextTurn = true
    await note($, `idle ${Math.round(idleMinutes)}m, past the ${config.ttlMinutes}m cache TTL; the cache is already cold, not bumping until the next turn rebuilds it`)
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

  // Rebuilding a small cache costs less than paying a read every interval to
  // hold it. The context only grows, so this waits for the next turn rather
  // than stopping, which also covers a new session idle before its first turn.
  const usage = await $.session.usage()
  const tokens = usage.context.tokens ?? 0
  if (tokens < config.minContextTokens) {
    coldUntilNextTurn = true
    await note($, `context is only ${tokens} tokens; not worth warming until it grows`)
    await publish($)
    return
  }

  await bump($)
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
  timer = $.clock.every(config.pollSeconds * 1000, () => void tick($).catch((err: unknown) => note($, `tick failed: ${String(err)}`)))
  await publish($)
  // Refused if another plugin already serves /keepwarm; the keepalive still runs.
  try {
    await $.command.register({
      name: 'keepwarm',
      description: 'Pause, resume or report the prompt-cache keepalive for this session',
      argumentHint: '[pause|resume|status]',
    })
  } catch (err) {
    await note($, `/keepwarm not registered: ${String(err)}`)
  }
}

const status = async ($: any): Promise<string> => {
  const made = `${bumps} of ${config.maxBumps} bumps made`
  if (stopped) return `stopped: ${stopReason}. ${made}.`
  if (paused) return `paused. ${made}. /keepwarm resume turns it back on.`
  if (coldUntilNextTurn) return `waiting for your next turn: the cache is cold, too small to hold, or out of date. ${made}.`
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

// A real main-thread turn restarts the idle clock and gives the fork a fresh
// request to replay. A subagent's turns use their own cache, not the session's.
const settle = async ($: any): Promise<void> => {
  busy = false
  lastActivityAt = await $.clock.now()
  coldUntilNextTurn = false
  await publish($)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await start($)
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    busy = true
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) void settle($)
    return next(e)
  })

  // The fork replays the last request the main thread sent, which after a
  // compaction is the conversation from before it. Warming that would write the
  // old prefix, so bumps wait for the first real turn on the compacted one.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      coldUntilNextTurn = true
      await publish($)
    }
    return result
  })

  on('command.run', { command: 'keepwarm' }, ($, e) => command($, e.args))
}
