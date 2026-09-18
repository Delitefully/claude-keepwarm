# keepwarm

A Claude Code plugin that keeps an idle session's prompt cache warm, so the next
message you type reads the conversation from cache instead of paying to write it
again.

Claude Code re-sends the whole conversation every turn, and the API caches it by
prefix. On a Claude subscription inside plan usage, the main conversation's cache
TTL is 1 hour; otherwise it is 5 minutes. Any request that hits the cache resets
the timer. Idle past the TTL and your next message pays a cache write instead of
a cache read: a 1h cache write bills at 2x base input, a cache read at about
0.1x.

keepwarm spends one read to avoid one write. After the session has been idle for
`KEEPWARM_INTERVAL_MIN` (default 50) it submits one line asking Claude for a
single period. That request re-reads the cached prefix and resets the TTL.
Measured in a real terminal session: the keepalive turn read 50,348 tokens from
cache, wrote 91, produced 3 output tokens, and Claude Code's status line went
back to `warm 59m27s (1h)`.

## Install

Clone it into your personal skills directory. Any folder there with a plugin
manifest loads on the next session, with no install step:

    git clone https://github.com/Delitefully/claude-keepwarm ~/.claude/skills/keepwarm

To try it in one session without installing:

    claude --plugin-dir /path/to/claude-keepwarm

The mod needs function hooks turned on. Add this to `~/.claude/settings.json`:

    { "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }

Without that flag the shell monitor does the same job.

Kill switch for every session at once: `touch ~/.claude/keepwarm-off`.
To stop loading it entirely: `claude plugin disable keepwarm@skills-dir`.

## Two implementations, one plugin

| | Mod (`hooks/keepwarm.ts`) | Shell monitor (`scripts/keepwarm.sh`) |
|---|---|---|
| Needs | `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` | nothing |
| Timer | `$.clock.every` | `sleep` loop |
| Ping | `$.prompt.submit` | monitor stdout |
| Size gate | `$.session.usage()` context tokens | transcript bytes |

The mod is a TypeScript function-hooks module. Function hooks are early access,
so that API can change between releases. The monitor works without the flag.
They interlock: when function hooks are on, the monitor stands down and the mod
drives.

## What each bump leaves on screen

The reply `.` is blanked. The ping row is not, and the reason is worth knowing
if you write hooks yourself: the engine skips a plugin's own `ui.render` hooks
for a row that plugin's own code raised. Running under `claude --debug` says so
outright:

    hooks module keepwarm ui.render skipped: re-entry
    (the plugin's own code raised it; origin keepwarm)

So the row is a real `UserMessage` render site, stamped
`origin: { kind: 'plugin', name: 'keepwarm' }`, and any other plugin could blank
it. keepwarm cannot blank its own. The hook is in `hooks/keepwarm.ts` anyway,
matched on that origin, because it costs nothing and re-entry is a rule about
who raised the event rather than about the row.

Each bump therefore leaves two lines:

    > The keepwarm plugin sent a message:
      [keepwarm] cache keepalive - reply with one period, nothing else.

## Why it stops after 8 bumps

A bump costs a cache read of the whole conversation every interval. That is a
good trade if you come back and a bad one if you do not, so keepwarm stops after
`KEEPWARM_MAX_BUMPS` (default 8, about 8 hours) and lets the cache go cold.

Both implementations also stop if a bump ever writes more than it reads. A
keepalive that writes is warming nothing and would rebill that write every
interval.

## Configure

The mod reads environment variables. The shell monitor reads
`~/.claude/keepwarm/config.env` instead, because a background session's monitor
does not inherit the launching shell's environment. See `config.env.example`.

| | default | |
|---|---|---|
| `KEEPWARM_INTERVAL_MIN` | 50 | idle minutes before a bump. Keep it under your TTL |
| `KEEPWARM_MAX_BUMPS` | 8 | bumps before it lets the cache go cold |
| `KEEPWARM_MIN_CONTEXT_TOKENS` | 20000 | mod only: do not warm a context smaller than this |
| `KEEPWARM_MIN_TRANSCRIPT_KB` | 150 | monitor only: the same gate, in transcript bytes |
| `KEEPWARM_DISABLE` | | monitor only: `1` turns it off |

The monitor logs each bump and its cache figures to
`~/.claude/keepwarm/keepwarm.log`. `/keepwarm` reports the last few.

## Why the keepalive has to happen inside the session

Warming from outside does not work. Running
`claude --resume <id> --fork-session -p` against a live interactive session
measured 0 tokens read and 54,300 created, a full write. The system prompt
carries session-unique text (the scratchpad path contains the session id), so
another process rebuilds the prefix rather than sharing it. Running the same
bump twice showed it is self-consistent (the second one read 54,300, created 0):
it warms its own cache entry, not the session's.

## A keepalive is a real turn

If the session has a `/goal` set, or a `Stop` hook that forces continuation,
the keepalive turn can do more than print a period.
