<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-lockup-dark.png">
  <img src="assets/logo-lockup.png" alt="keepwarm" width="420">
</picture>

Two Claude Code plugins that keep an idle session's prompt cache warm, so the
next message you type reads the conversation from cache instead of paying to
write it again, and leave nothing on screen while they do it.

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

    claude plugin marketplace add Delitefully/claude-keepwarm
    claude plugin install keepwarm-bundle@keepwarm

`keepwarm-bundle` is a manifest with nothing but a dependency list, so installing
it pulls in both plugins:

| | |
|---|---|
| `keepwarm` | the keepalive itself |
| `keepwarm-quiet` | blanks the rows the keepalive leaves in the transcript |

Install `keepwarm` alone if you would rather see the rows.

The mod needs function hooks turned on. Add this to `~/.claude/settings.json`:

    { "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }

Without that flag `keepwarm` falls back to a shell monitor that does the same
job. `keepwarm-quiet` is a mod only, so it needs the flag.

Kill switch for every session at once: `touch ~/.claude/keepwarm-off`.
To stop loading them: `claude plugin disable keepwarm-bundle@keepwarm`.

## Two implementations of the keepalive

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

## Why blanking the row takes a second plugin

With both installed, a bump leaves nothing on screen. `keepwarm` cannot do that
on its own: the engine skips a plugin's own `ui.render` hooks for a row that
plugin's own code raised. Under `claude --debug` it says so outright:

    hooks module keepwarm ui.render skipped: re-entry
    (the plugin's own code raised it; origin keepwarm)

Re-entry is a rule about who raised the event, not about the row. The row is an
ordinary `UserMessage` render site stamped
`origin: { kind: 'plugin', name: 'keepwarm' }`, so any other plugin may rewrite
it, which is all `keepwarm-quiet` is. It blanks the ping and the `.` that answers
it, and passes both through while `isExpanded`, so ctrl+o still shows everything.

Blanking is display only. The transcript keeps both messages and the model still
read them, which is the point: the cached prefix has to stay exactly as it was.

By default it quiets `keepwarm`. Set `KEEPWARM_QUIET_PLUGINS` to a comma
separated list of plugin names to quiet others.

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

## The monitor stays alive after it stops bumping

When the shell monitor has nothing left to do, it goes dormant rather than
exiting, because a monitor that exits makes Claude Code announce it, and that
announcement costs a turn in the transcript. The cost of staying is that quitting
the session lists it under "Background work is running" as `prompt-cache
keepalive`. It stops with the session either way. A startup turn in every
transcript seemed the worse of the two.

## A keepalive is a real turn

If the session has a `/goal` set, or a `Stop` hook that forces continuation,
the keepalive turn can do more than print a period.
