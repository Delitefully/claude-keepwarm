---
description: Report prompt-cache keepalive status for this session
allowed-tools: Bash(tail:*)
---

!`tail -25 "$HOME/.claude/keepwarm/keepwarm.log" 2>/dev/null || echo "(no keepwarm log yet)"`

From the log above, report in at most three lines: whether a keepalive is running for this session, how many bumps it has made, and the cache read/created figures from the most recent bump. Then stop — take no other action.
