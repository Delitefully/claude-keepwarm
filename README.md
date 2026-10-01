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
`KEEPWARM_INTERVAL_MIN` (default 45) it re-sends the main thread's last request
with one line after it asking for a single period (`$.model.fork`). That request
re-reads the cached prefix and resets the TTL, and it is not a turn: nothing is
added to the transcript, so nothing shows on screen and the model never sees it.
Measured in a real terminal session: the keepalive read 53,922 tokens from
cache, wrote 0, and produced 3 output tokens. With the TTL forced to 5m to see
it expire in minutes, a bump at 4m03s read 54,049 tokens and wrote 0, and a real
turn at 8m34s, past the TTL, still read 54,049 and wrote 37.

## Install

    claude plugin marketplace add Delitefully/claude-keepwarm
    claude plugin install keepwarm@keepwarm

It needs function hooks. Add this to `~/.claude/settings.json`:

    { "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }

To pause it in one session: `/keepwarm pause`, and `/keepwarm resume` to turn it
back on. Kill switch for every session at once: `touch ~/.claude/keepwarm-off`.
To stop loading it: `claude plugin disable keepwarm@keepwarm`.

Earlier versions said to install `keepwarm-bundle`, which pulled in `keepwarm`
and `keepwarm-quiet`, a second plugin that blanked the rows a bump left. Since
0.5 a bump leaves none, so `keepwarm-quiet` is gone and the bundle now pulls in
`keepwarm` alone; an existing bundle install keeps working. The copy of
`keepwarm-quiet` it installed stays until you remove it:
`claude plugin uninstall keepwarm-quiet@keepwarm`.

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

## Pausing it, and your status line

`keepwarm` registers `/keepwarm`:

| | |
|---|---|
| `/keepwarm` | whether it is on, paused, waiting or stopped, and when the next bump is due |
| `/keepwarm pause` | no bumps in this session until you resume |
| `/keepwarm resume` | back on, from the same idle clock |

The command answers locally, so it runs no model turn and does not reset the
idle clock. A pause lasts for the session. It is not the kill switch: a pause
keeps the timer and the bump count, and resuming cannot restart a keepalive
that has already stopped.

A status line runs as its own process and cannot ask the plugin anything, so
`keepwarm` writes its state to `~/.claude/keepwarm/sessions/<session id>.json`
whenever it changes:

    {"state":"active","cold":false,"bumps":2,"maxBumps":8,"nextBumpAt":1790150371,"lastBumpAt":1790147672,"reason":"","updatedAt":1790147672}

`state` is `active`, `paused` or `stopped`, `cold` means it is waiting for your
next turn to rebuild the cache, `nextBumpAt` is epoch seconds, and `reason` says
why it stopped. A status line command gets `session_id` on stdin, so it can pick
out its own session's file:

    sid=$(printf '%s' "$input" | jq -r '.session_id // empty')
    f="$HOME/.claude/keepwarm/sessions/$sid.json"
    [ -n "$sid" ] && [ -f "$f" ] && jq -r --argjson now "$(date +%s)" '
      if .state == "active" then
        "kw \(.bumps)/\(.maxBumps) " + (if .cold then "waiting"
          else ((.nextBumpAt - $now) as $s | if $s <= 0 then "due" else "next \((($s + 59) / 60) | floor)m" end) end)
      elif .state == "paused" then "kw paused" else "kw off" end' "$f"

That prints `kw 2/8 next 31m`, `kw paused` or `kw off`. The status line only
redraws on its own schedule, so set `refreshInterval` in `statusLine` if you
want a pause to show within the minute rather than at the next turn. The files
are not removed when a session ends; each is one line.

## Why a bump leaves nothing on screen

keepwarm 0.4 and earlier bumped with `$.prompt.submit`, a real turn. Each one
left a row for the ping, a `.` reply, a `Worked for 4s` line and a log line, and
because the ping was a user message it also re-armed Claude Code's recap: a new
`※ recap` is written once two user messages have arrived since the last one, so
every second bump added one, generated by a model call of its own.

0.5 bumps with `$.model.fork` instead. It re-sends the main thread's last request
as it was sent, with the ping after it and every tool denied, and nothing it
does is stored. The prefix is byte-for-byte the one the main thread cached, so it
is read rather than written, and it touches the same entry your next message
will read.

One detail makes that true. Claude Code gives the 1h TTL only to request sources
on a list, and a plugin's fork is not on it, so its cache markers ask for 5m. A
5m request still reads the 1h entry, but whether that read extends a 1h entry
by the hour is the API's call, and any tail it writes would live 5 minutes. So
keepwarm sets `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h` for the one request
and puts the old value back after, which makes its markers match the main
thread's. For those few seconds a subagent request starting elsewhere in the
session would also get the 1h TTL. Set `KEEPWARM_TTL_MIN` below 60 and it
leaves the variable alone.

There is one case where the prefix is not read whole: early in a session, when
the main thread's last cache marker sits on the system-role message that
carries the session-start context. A request that extends that one, with the
same bytes before it, read 29,405 of 53,130 tokens and wrote the rest. That is
not the fork's doing: Claude Code's own prompt-suggestion fork, and in one run
the main thread's own second turn, measured the same miss. Once the marker sits
on one of your messages the fork reads all of it. When a bump does land in that
case, the entry it writes (1h, as above) is the one your next message reads, and
later bumps read it whole.

What a fork replays is the last request the main thread sent. After a
`/compact` that request is the conversation from before it, so bumps wait for
your first turn on the compacted one. After `/clear` there is nothing to fork
until you send something.

Claude Code's own prompt-cache tracking counts the fork, so a status line that
shows `prompt_cache.expires_at` restarts its countdown at each bump. The sessions
file also records `lastBumpAt`.

## The two mechanisms

| | `keepwarm` | `keepwarm-shell` |
|---|---|---|
| Needs | `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` | nothing |
| Background process | none | one, for the session's life |
| Timer | `$.clock.every` | `sleep` loop |
| Ping | `$.model.fork`, no transcript row | monitor stdout, a real turn |
| Size gate | `$.session.usage()` context tokens | transcript bytes |
| Safety valve | skips a bump past `KEEPWARM_TTL_MIN`; stops if a bump still creates more cache than it reads | same, read from the transcript |
| Kill switch | `~/.claude/keepwarm-off` | same |
| Pause | `/keepwarm pause` for one session | none; `KEEPWARM_DISABLE=1` or the kill switch |
| Status line | `~/.claude/keepwarm/sessions/<id>.json` | none; `/keepwarm` reads the log |

`keepwarm` is a TypeScript function-hooks module. Function hooks are early
access, so that API can change between releases.

## Why it stops after 8 bumps

A bump costs a cache read of the whole conversation every interval. That is a
good trade if you come back and a bad one if you do not, so keepwarm stops after
`KEEPWARM_MAX_BUMPS` (default 8, about 8 hours) and lets the cache go cold.

Both mechanisms also stop if a bump ever creates more cache than it reads
(`cache_creation_input_tokens` above `cache_read_input_tokens` on the reply).
That means the cache was already cold and the bump rebuilt it, warming nothing;
repeating it would rebill that write every interval.

A bump can be late. The timer does not run while the machine sleeps, and in
`keepwarm-shell` a draft sitting in the prompt box defers every tick, so a bump
due at 45 minutes can land after the hour. (`keepwarm`'s fork never touches the
prompt box, so a draft does not hold it up.) Past `KEEPWARM_TTL_MIN` the cache is already cold and a
bump can only write, so both mechanisms skip it instead of paying for the
rebuild, and resume once your next message has rebuilt the cache. The 15 minute gap between the default interval and the TTL is the
slack for those deferrals.

## Configure

`keepwarm` reads environment variables, so set them in your shell or in the
`env` block of `~/.claude/settings.json`. `keepwarm-shell` reads
`~/.claude/keepwarm/config.env` instead, because a background session's monitor
does not inherit the launching shell's environment. See its `config.env.example`.

| | default | |
|---|---|---|
| `KEEPWARM_INTERVAL_MIN` | 45 | idle minutes before a bump. Keep it under your TTL, with room for a late tick |
| `KEEPWARM_TTL_MIN` | 60 | your prompt-cache TTL. A bump this late is skipped, since the cache is already cold |
| `KEEPWARM_MAX_BUMPS` | 8 | bumps before it lets the cache go cold |
| `KEEPWARM_MIN_CONTEXT_TOKENS` | 20000 | `keepwarm` only: do not warm a context smaller than this |
| `KEEPWARM_MIN_TRANSCRIPT_KB` | 150 | `keepwarm-shell` only: the same gate, in transcript bytes |
| `KEEPWARM_DISABLE` | | `keepwarm-shell` only: `1` turns it off |

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

## keepwarm-shell's keepalive is a real turn

If the session has a `/goal` set, or a `Stop` hook that forces continuation,
`keepwarm-shell`'s keepalive turn can do more than print a period. `keepwarm`'s
fork is not a turn of the session and every tool is denied to it, but it is run
as a forked agent, so `SubagentStop` settings hooks fire when it ends.
