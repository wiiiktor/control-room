#!/bin/sh
# T1: how long a NEW room session takes to become usable, stage by stage -- the wait the reader sees
# after "New session". Started exactly the way the extension starts one (`claude --bg` from the room
# folder, the panel's first prompt, the real hooks). Prints one line per stage, seconds from the click.
#
#   sh tests/sandbox/new-session-timing.sh                  # the reader's own model (what the panel uses)
#   CR_MODEL=haiku sh tests/sandbox/new-session-timing.sh   # cheaper
#
# PASS when the session is listening within LIMIT seconds (default 60).
. "$(dirname "$0")/lib.sh"
LIMIT=${LIMIT:-60}
MODEL=${CR_MODEL:-default}
echo "new session timing (sandbox $WS, model $MODEL)"
setup_ws
node -e "
const h=require('$REPO/extension/src/hook.js');
h.install('$WS', '$ROOM', '$ROOM'); h.linkRoom('$ROOM', '$WS', true);"

WAKE='Watch this control room and answer me in the panel.'
: > "$ROOM/.expect"
now() { python3 -c 'import time; print(time.time())'; }
t0=$(now)
since() { python3 -c "print(f'{$(now) - $t0:5.1f} s')"; }
modelarg=""; [ "$MODEL" != default ] && modelarg="--model $MODEL"
out=$(cd "$ROOM" && clean "$CLAUDE" --bg $modelarg "$WAKE" 2>&1)
short=$(printf '%s' "$out" | grep -oE 'backgrounded[^0-9a-f]*[0-9a-f]{6,}' | grep -oE '[0-9a-f]{6,}$')
echo "  $(since)  claude --bg returned ($short)"
sid=""; for _ in $(seq 1 60); do sid=$(agent_field "$short" sessionId); [ -n "$sid" ] && break; sleep 0.5; done
echo "  $(since)  listed by claude agents"
t=""; for _ in $(seq 1 120); do t=$(ls "$HOME"/.claude/projects/*/"$sid".jsonl 2>/dev/null | head -1); [ -n "$t" ] && break; sleep 0.5; done
echo "  $(since)  transcript exists"
for _ in $(seq 1 240); do grep -q '"Monitor"' "$t" 2>/dev/null && break; sleep 0.5; done
echo "  $(since)  Monitor call written to the transcript"
beat=""; for _ in $(seq 1 240); do [ -e "$ROOM/.watch.$sid" ] && { beat=1; break; }; sleep 0.5; done
el=$(python3 -c "print(round($(now) - $t0))")
echo "  $(since)  heartbeat: listening"
for _ in $(seq 1 120); do [ "$(agent_field "$short" status)" = idle ] && break; sleep 1; done
echo "  $(since)  first turn over (idle)"
python3 - "$t" <<'EOF'
import json, sys
tools = []
for l in open(sys.argv[1]):
    try: d = json.loads(l)
    except Exception: continue
    for b in (d.get('message') or {}).get('content') or []:
        if isinstance(b, dict) and b.get('type') == 'tool_use':
            tools.append(b['name'])
print('  tools in the first turn:', ', '.join(tools) or '(none)')
EOF
check "listening within ${LIMIT} s (took ${el} s)" '[ -n "$beat" ] && [ "$el" -le "$LIMIT" ]'
[ -n "$short" ] && clean "$CLAUDE" stop "$short" >/dev/null 2>&1
echo "new session timing: $fails failure(s)"; exit $fails
