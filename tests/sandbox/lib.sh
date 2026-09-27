# Shared helpers for the sandbox tests. Sourced, not run.
#
# The sandbox is a throwaway workspace (default ~/code/cr-sandbox/ws) with its own room. Tests start
# REAL claude sessions there on a cheap model, so they cost a little and take seconds, and never touch
# the reader's own rooms or conversations.
set -u
REPO=$(cd "$(dirname "$0")/../.." && pwd)
SB=${CR_SANDBOX:-$HOME/code/cr-sandbox}
WS=$SB/ws
ROOM=$WS/control-room
MODEL=${CR_MODEL:-haiku}
CLAUDE=$(command -v claude)
fails=0

# ⛔ A claude started from inside another Claude session inherits its markers
# (CLAUDE_CODE_CHILD_SESSION and friends): it saves no transcript and does not register with
# `claude agents`. Every test launch goes through this, like a fresh terminal would.
clean() {
  env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_ENTRYPOINT \
      -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_PID \
      -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_CODE_EXECPATH -u CLAUDE_AGENT_SDK_VERSION -u AI_AGENT \
      -u CLAUDE_EFFORT -u CLAUDE_CODE_ENABLE_TASKS -u CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING \
      -u CONTROL_ROOM_HOST "$@"
}

ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fails=$((fails + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# A fresh sandbox workspace with a room, trusted the way the extension trusts it.
setup_ws() {
  mkdir -p "$ROOM"
  cp "$REPO"/chatlog.py "$REPO"/reply.py "$REPO"/status.py "$REPO"/watch.py "$REPO"/request.py "$ROOM"/
  node -e "const p=require('$REPO/extension/src/preflight.js'); p.grantTrust('$WS'); p.grantTrust('$ROOM')"
}

# agents row field for a session: agent_field <sessionId-or-short> <field>
agent_field() {
  clean "$CLAUDE" agents --json 2>/dev/null | python3 -c "
import sys, json
key, field = sys.argv[1], sys.argv[2]
for r in json.load(sys.stdin):
    if r.get('sessionId') == key or r.get('id') == key or (r.get('sessionId') or '').startswith(key):
        print(r.get(field) or ''); break" "$1" "$2"
}

# Start a background session in the sandbox; prints its full session id.
start_bg() {
  out=$(cd "${2:-$WS}" && clean "$CLAUDE" --bg --model "$MODEL" "${1:-Reply with the single word: ready}" 2>&1)
  short=$(printf '%s' "$out" | grep -oE 'backgrounded[^0-9a-f]*[0-9a-f]{6,}' | grep -oE '[0-9a-f]{6,}$')
  [ -n "$short" ] || { echo "start_bg failed: $out" >&2; return 1; }
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sid=$(agent_field "$short" sessionId)
    [ -n "$sid" ] && { printf '%s\n' "$sid"; return 0; }
    sleep 1
  done
  echo "start_bg: $short never appeared in claude agents" >&2; return 1
}

# Wait until a background session has finished its turn (status idle).
wait_idle() {
  for _ in $(seq 1 60); do
    [ "$(agent_field "$1" status)" = "idle" ] && return 0
    sleep 1
  done
  return 1
}
