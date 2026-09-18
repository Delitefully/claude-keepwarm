# keepwarm

Keeps an idle Claude Code session's prompt cache warm, so the next message you
type reads the conversation from cache instead of paying to write it again.

On a Claude subscription inside plan usage, the main conversation's cache TTL is
one hour, and **every request that hits the cache resets that timer**. Leave a
session alone for longer and the next thing you type re-processes the whole
conversation: a one-hour cache write bills at 2× base input, against a cache read
at roughly 0.1×. keepwarm spends one read to avoid one write.

Measured in a real terminal session: a keepalive turn read **50,348 tokens from
cache, wrote 91, and produced 3 output tokens**, and Claude Code's own status
line went back to `warm 59m27s (1h)`.

## What it does

Once the session has been idle for `KEEPWARM_INTERVAL_MIN` (default 50, under
the one-hour TTL), it submits one line asking for a single period, and Claude
answers `.`. That request re-reads the cached prefix, which resets the TTL.

It stops on its own after `KEEPWARM_MAX_BUMPS` (default 8, about eight hours)
and lets the cache go cold, rather than billing a read every hour against a
session you have walked away from for good.

## Two implementations, one plugin

| | Mod (`hooks/keepwarm.ts`) | Shell monitor (`scripts/keepwarm.sh`) |
|---|---|---|
| Needs | `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` | nothing |
| Timer | `$.clock.every` | `sleep` loop |
| Idle clock | `turn.complete` | last timestamp in the transcript |
| Size gate | `$.session.usage()` context tokens | transcript bytes |
| Safety valve | stops if a bump writes more than it reads | same, read from the transcript |
| Kill switch | `~/.claude/keepwarm-off` | same |

The mod is the better one: it reads the real context size, and it submits a
prompt rather than a task notification, so nothing announces a background task.
The monitor is the fallback that works without the flag. **They interlock** —
with function hooks on, the monitor stands down and lets the mod drive.

### How quiet it actually is

The keepalive reply is blanked by the bundled `MessageDisplay` hook. The *ping*
row is not: measured against 2.1.275, Claude Code draws a plugin-submitted
prompt with framing of its own that no `ui.render` hook is offered — hooks fire
for `AssistantMessage` but no render event carries that row at all. The ping is
therefore kept to one short line, and an idle session shows two lines per bump:

    > The keepwarm plugin sent a message:
      [keepwarm] cache keepalive — reply with one period, nothing else.

If a later release routes that row through `ui.render`, the `UserMessage` hook
already in `hooks/keepwarm.ts` will blank it with no other change.

Function hooks are early access and the API may change between releases;
regenerate the types with `/plugin-types` after a Claude Code update.

## Install

    claude --plugin-dir ~/Developer/claude-keepwarm

To enable the mod as well, add to `~/.claude/settings.json`:

    { "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }

## Configure

The mod reads environment variables. The shell monitor reads
`~/.claude/keepwarm/config.env` instead, because a background session's monitor
never sees the launching shell's environment. See `config.env.example`.

| | default | |
|---|---|---|
| `KEEPWARM_INTERVAL_MIN` | 50 | idle minutes before a bump. Keep under the TTL: 1h on a subscription inside plan usage, 5m otherwise |
| `KEEPWARM_MAX_BUMPS` | 8 | bumps before it gives up and lets the cache expire |
| `KEEPWARM_MIN_CONTEXT_TOKENS` | 20000 | mod only: don't warm a session this small |
| `KEEPWARM_MIN_TRANSCRIPT_KB` | 150 | monitor only: the same gate, measured in transcript bytes |
| `KEEPWARM_DISABLE` | | `1` turns the monitor off |

Kill switch for every session at once: `touch ~/.claude/keepwarm-off`.
The monitor logs each bump and its cache figures to `~/.claude/keepwarm/keepwarm.log`;
`/keepwarm` reports the last few.

## Why it is not an out-of-band process

The obvious design — a daemon that runs `claude --resume <id> --fork-session -p`
on a timer, touching nothing in your session — does not work, and the failure is
silent and expensive. The system prompt carries session-unique text (the
scratchpad path contains the session id), so another process rebuilds the prefix
from that point on rather than sharing it. Measured against a live session:

| bump | read | created |
|---|---|---|
| `-p --resume` of an interactive session | 0 | 54,300 |
| the same bump again | 54,300 | 0 |

It is perfectly self-consistent — it just warms its own cache entry, not the one
your session will read. That is why the keepalive has to happen **inside** the
session, where the prefix is identical by construction. Both implementations
here check the figures and stand down if a bump ever writes more than it reads.

## Caveats

- The ping row is visible; only the reply is blanked. See above.
- A keepalive is a real turn. If the session has a `/goal` set, or a `Stop` hook
  that forces continuation, that turn can do more than print a period.
- Each bump leaves about 60 tokens in the conversation permanently. Blanking the
  rows is display-only; the transcript keeps them.
- Cheap is not free. A bump costs a cache read of the whole conversation — worth
  it against a 20× cache write if you come back, wasted if you don't. That is
  what `KEEPWARM_MAX_BUMPS` is for.
