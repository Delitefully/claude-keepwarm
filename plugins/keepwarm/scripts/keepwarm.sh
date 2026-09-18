#!/usr/bin/env bash
# Emits one keepalive line to Claude when the session has been idle long enough
# that its prompt cache is about to expire. Claude answers with a single period;
# that request re-reads the cached prefix, which resets the cache TTL.
#
# Runs as a plugin monitor, so stdout reaches Claude as a notification and the
# process lives exactly as long as the session does.
set -uo pipefail

# A background session's monitor doesn't inherit the launching shell's variables,
# so the config file, not the environment, is the setting that works everywhere.
CONFIG="${KEEPWARM_CONFIG:-$HOME/.claude/keepwarm/config.env}"
# shellcheck source=/dev/null
[ -f "$CONFIG" ] && . "$CONFIG"

INTERVAL_MIN="${KEEPWARM_INTERVAL_MIN:-50}"
MAX_BUMPS="${KEEPWARM_MAX_BUMPS:-8}"
MIN_TRANSCRIPT_KB="${KEEPWARM_MIN_TRANSCRIPT_KB:-150}"
POLL_SEC="${KEEPWARM_POLL_SEC:-60}"
LOG="${KEEPWARM_LOG:-$HOME/.claude/keepwarm/keepwarm.log}"

mkdir -p "$(dirname "$LOG")" 2>/dev/null
log() { printf '%s [%s] %s\n' "$(date +%Y-%m-%dT%H:%M:%S)" "${CLAUDE_CODE_SESSION_ID:0:8}" "$*" >>"$LOG"; }

# Exiting makes Claude Code announce that the monitor ended, and that notification
# costs a turn. Staying alive and silent is cheaper than stopping loudly.
dormant() {
  log "$* — going dormant"
  while :; do
    sleep 300
    if [ -n "${CLAUDE_PID:-}" ] && ! kill -0 "$CLAUDE_PID" 2>/dev/null; then exit 0; fi
  done
}

[ "${KEEPWARM_DISABLE:-0}" = "1" ] && dormant "disabled by KEEPWARM_DISABLE"
# With function hooks on, the mod drives the keepalive and this monitor stands down.
[ "${CLAUDE_CODE_ENABLE_FUNCTION_HOOKS:-0}" = "1" ] && dormant "function hooks are on; the mod drives this"
[ -n "${CLAUDE_CODE_SESSION_ID:-}" ] || dormant "no CLAUDE_CODE_SESSION_ID"

TRANSCRIPT=""
for _ in 1 2 3 4 5 6; do
  TRANSCRIPT=$(find "$HOME/.claude/projects" -maxdepth 2 -name "${CLAUDE_CODE_SESSION_ID}.jsonl" 2>/dev/null | head -1)
  [ -n "$TRANSCRIPT" ] && break
  sleep 5
done
[ -n "$TRANSCRIPT" ] || dormant "transcript not found"

# The file's mtime is touched even when no turn happens, so idleness is measured
# from the last timestamped record inside the transcript instead. The same pass
# reports the newest turn's cache accounting.
state() {
  python3 - "$TRANSCRIPT" <<'PY' 2>/dev/null
import datetime, json, sys
last_ts = 0.0
read = created = -1
for line in open(sys.argv[1], errors="ignore"):
    try: o = json.loads(line)
    except Exception: continue
    ts = o.get("timestamp")
    if ts:
        try:
            last_ts = max(last_ts, datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp())
        except ValueError:
            pass
    if o.get("type") == "assistant":
        u = (o.get("message") or {}).get("usage") or {}
        if u:
            read = u.get("cache_read_input_tokens", 0)
            created = u.get("cache_creation_input_tokens", 0)
print(int(last_ts), read, created)
PY
}

size_kb() { echo $(( $(stat -f %z "$TRANSCRIPT" 2>/dev/null || stat -c %s "$TRANSCRIPT" 2>/dev/null) / 1024 )); }

log "started: interval=${INTERVAL_MIN}m max_bumps=${MAX_BUMPS} transcript=${TRANSCRIPT##*/}"
bumps=0
while :; do
  sleep "$POLL_SEC"

  if [ -n "${CLAUDE_PID:-}" ] && ! kill -0 "$CLAUDE_PID" 2>/dev/null; then
    log "session process gone; exiting after ${bumps} bump(s)"; exit 0
  fi
  [ -f "$HOME/.claude/keepwarm-off" ] && dormant "kill switch present"

  read -r last_ts _ _ <<<"$(state)"
  [ -n "${last_ts:-}" ] && [ "${last_ts:-0}" -gt 0 ] 2>/dev/null || continue
  idle=$(( $(date +%s) - last_ts ))
  (( idle < INTERVAL_MIN * 60 )) && continue

  kb=$(size_kb)
  if (( kb < MIN_TRANSCRIPT_KB )); then
    dormant "idle ${idle}s but transcript is only ${kb}KB; rebuilding that cache is cheaper than holding it"
  fi
  if (( bumps >= MAX_BUMPS )); then
    dormant "reached max_bumps=${MAX_BUMPS}; letting the cache go cold"
  fi

  echo "[keepwarm] cache keepalive - reply with one period, nothing else."
  bumps=$((bumps + 1))
  log "bump ${bumps} after $(( idle / 60 ))m idle"

  sleep 45
  read -r new_ts r c <<<"$(state)"
  if [ "${new_ts:-0}" -gt "$last_ts" ] 2>/dev/null; then
    log "  -> cache read=${r} created=${c}"
    # A keepalive that writes more than it reads is warming nothing, and would
    # bill that write again every interval.
    if (( c > r )); then
      dormant "  -> wrote more than it read; not repeating it"
    fi
  else
    dormant "  -> no turn recorded; the ping did not land"
  fi
done
