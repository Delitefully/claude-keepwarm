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
it pulls in the two plugins you want:

| | |
|---|---|
| `keepwarm` | the keepalive, as a function-hooks mod |
| `keepwarm-quiet` | blanks the rows the keepalive leaves in the transcript |

Both need function hooks. Add this to `~/.claude/settings.json`:

    { "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }

Kill switch for every session at once: `touch ~/.claude/keepwarm-off`.
To stop loading them: `claude plugin disable keepwarm-bundle@keepwarm`.

### If you cannot turn function hooks on

`keepwarm-shell` does the same job with a background monitor on a sleep loop, and
needs no flag:

    claude plugin install keepwarm-shell@keepwarm

It is a separate plugin because a monitor is a process that lives as long as the
session, so Claude Code counts it in the footer and lists it when you quit under
"Background work is running". The mod needs no process, so a session running
`keepwarm` shows nothing at all. Install one or the other. With both installed
and function hooks on, the monitor stands down and lets the mod drive.

`keepwarm-shell` reads `~/.claude/keepwarm/config.env` rather than the
environment, because a background session's monitor never sees your shell. It
logs each bump to `~/.claude/keepwarm/keepwarm.log`, and `/keepwarm` reports the
last few.

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

## The two mechanisms

| | `keepwarm` | `keepwarm-shell` |
|---|---|---|
| Needs | `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` | nothing |
| Background process | none | one, for the session's life |
| Timer | `$.clock.every` | `sleep` loop |
| Ping | `$.prompt.submit` | monitor stdout |
| Size gate | `$.session.usage()` context tokens | transcript bytes |
| Safety valve | stops if a bump writes more than it reads | same, read from the transcript |
| Kill switch | `~/.claude/keepwarm-off` | same |

`keepwarm` is a TypeScript function-hooks module. Function hooks are early
access, so that API can change between releases.

## Why it stops after 8 bumps

A bump costs a cache read of the whole conversation every interval. That is a
good trade if you come back and a bad one if you do not, so keepwarm stops after
`KEEPWARM_MAX_BUMPS` (default 8, about 8 hours) and lets the cache go cold.

Both mechanisms also stop if a bump ever writes more than it reads. A
keepalive that writes is warming nothing and would rebill that write every
interval.

## Configure

`keepwarm` reads environment variables, so set them in your shell or in the
`env` block of `~/.claude/settings.json`. `keepwarm-shell` reads
`~/.claude/keepwarm/config.env` instead, because a background session's monitor
does not inherit the launching shell's environment. See its `config.env.example`.

| | default | |
|---|---|---|
| `KEEPWARM_INTERVAL_MIN` | 50 | idle minutes before a bump. Keep it under your TTL |
| `KEEPWARM_MAX_BUMPS` | 8 | bumps before it lets the cache go cold |
| `KEEPWARM_MIN_CONTEXT_TOKENS` | 20000 | `keepwarm` only: do not warm a context smaller than this |
| `KEEPWARM_MIN_TRANSCRIPT_KB` | 150 | `keepwarm-shell` only: the same gate, in transcript bytes |
| `KEEPWARM_DISABLE` | | `keepwarm-shell` only: `1` turns it off |
| `KEEPWARM_QUIET_PLUGINS` | keepwarm | `keepwarm-quiet` only: which plugins' rows to blank |

## Why the keepalive has to happen inside the session

Warming from outside does not work. Running
`claude --resume <id> --fork-session -p` against a live interactive session
measured 0 tokens read and 54,300 created, a full write. The system prompt
carries session-unique text (the scratchpad path contains the session id), so
another process rebuilds the prefix rather than sharing it. Running the same
bump twice showed it is self-consistent (the second one read 54,300, created 0):
it warms its own cache entry, not the session's.

## keepwarm-shell's monitor stays alive after it stops bumping

When the monitor has nothing left to do it goes dormant rather than exiting,
because a monitor that exits makes Claude Code announce it, and that announcement
costs a turn in the transcript. The cost of staying is the footer count and the
line under "Background work is running" when you quit. Neither can be turned off,
which is the reason `keepwarm` does not ship a monitor at all.

## A keepalive is a real turn

If the session has a `/goal` set, or a `Stop` hook that forces continuation,
the keepalive turn can do more than print a period.
