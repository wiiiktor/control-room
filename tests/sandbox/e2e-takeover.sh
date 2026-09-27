#!/bin/sh
# E2: writing to a conversation from the room while it is open in a Claude tab.
#   Y is the room's session (background, listening). X is open and idle in a Claude tab.
#   Waking X for the room must: close X's tab (its process ends with it), run X in the room
#   (background, same id -- no copy), let Y go, and leave no error in the Claude window.
. "$(dirname "$0")/lib.sh"
state=$SB/state-e2e; rm -rf "$state"; mkdir -p "$state"
echo "e2e take-over from the Claude window"
setup_ws
node -e "const h=require('$REPO/extension/src/hook.js'); h.install('$WS', '$ROOM'); h.linkRoom('$ROOM', '$WS', true);"

# Y: the room's current session, as the panel starts one
: > "$ROOM/.expect"
y_out=$(cd "$ROOM" && clean "$CLAUDE" --bg --model "$MODEL" "Watch this control room and answer me in the panel." 2>&1)
y_short=$(printf '%s' "$y_out" | grep -oE 'backgrounded[^0-9a-f]*[0-9a-f]{6,}' | grep -oE '[0-9a-f]{6,}$')
y=""; wait_for 'y=$(agent_field "$y_short" sessionId); [ -n "$y" ]' 20
check "Y listens in the room" 'wait_for "[ -e \"$ROOM/.watch.$y\" ]" 90'

# X: an older conversation with its own title, not running
x=$(start_bg "Reply with the single word: kiwi") || exit 1
wait_idle "$x"; clean "$CLAUDE" stop "$(printf %s "$x" | cut -c1-8)" >/dev/null 2>&1

vs_start true || { bad "isolated window came up"; exit 1; }
ans=$(request open-in-claude "$x")
check "X opened in a Claude tab" 'wait_for "[ \"\$(agent_field $x kind)\" = interactive ]" 40'
wait_for '[ "$(agent_field "$x" status)" = idle ]' 30
mark=$(wc -l < "$CLOG")

ans=$(request wake "$x")
check "the room took the request: taken from the window" 'printf "%s" "$ans" | grep -q "taken-from-window"'
check "X now runs in the room (background, same id)" 'wait_for "[ \"\$(agent_field $x kind)\" = background ]" 40'
check "X listens in the room" 'wait_for "[ -e \"$ROOM/.watch.$x\" ]" 120'
check "Y was let go" 'wait_for "[ -z \"\$(agent_field $y kind)\" ]" 40'
check "the room says so" 'grep -q "was let go" "$ROOM/chat.jsonl" && grep -q "moved here from the Claude window" "$ROOM/chat.jsonl"'
# a copy would be ANOTHER background session carrying X's history (a new id); the Claude window may
# have opened a fresh interactive conversation of its own after its tab closed, which is not a copy
clean "$CLAUDE" agents --json > "$SB/agents.json"
others=$(python3 -c "
import json
rows=[r for r in json.load(open('$SB/agents.json')) if '$SB' in (r.get('cwd') or '') and r.get('sessionId') != '$x']
for r in rows: print('   other:', r.get('sessionId','')[:8], r.get('kind'), r.get('status'), r.get('name'), flush=True)
print(sum(1 for r in rows if r.get('kind') == 'background'))" | tee /dev/stderr | tail -1)
check "no copy: no other background session in the sandbox" '[ "$others" -eq 0 ]'
check "no error in the Claude window" '[ "$(vs_log_since "$mark" | grep -c "Error spawning Claude")" -eq 0 ]'

vs_stop
for s in "$x" "$y"; do [ "$(agent_field "$s" kind)" = background ] && clean "$CLAUDE" stop "$(printf %s "$s" | cut -c1-8)" >/dev/null 2>&1; done
echo "e2e take-over: $fails failure(s)"; exit $fails
