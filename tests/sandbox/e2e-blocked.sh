#!/bin/sh
# E3: a room session blocked on a permission question is reported in the room, with the two ways to
# answer it. The session runs WITHOUT bypass permissions and is asked for something the bridge rules do
# not cover (writing a file), so it stops at "may I?" -- `claude agents` status `waiting`.
. "$(dirname "$0")/lib.sh"
state=$SB/state-e2e; rm -rf "$state"; mkdir -p "$state"
echo "e2e blocked session"
setup_ws
node -e "const h=require('$REPO/extension/src/hook.js'); h.install('$WS', '$ROOM', '$ROOM'); h.linkRoom('$ROOM', '$WS', true);"
vs_start true || { bad "isolated window came up"; exit 1; }

: > "$ROOM/.expect"
out=$(cd "$ROOM" && clean "$CLAUDE" --bg --permission-mode default --model "$MODEL" "Watch this control room and answer me in the panel." 2>&1)
short=$(printf '%s' "$out" | grep -oE 'backgrounded[^0-9a-f]*[0-9a-f]{6,}' | grep -oE '[0-9a-f]{6,}$')
sid=""; wait_for 'sid=$(agent_field "$short" sessionId); [ -n "$sid" ]' 20
check "it listens (the bridge needs no bypass)" 'wait_for "[ -e \"$ROOM/.watch.$sid\" ]" 90'

python3 -c "
import sys, os; sys.path.insert(0, '$ROOM'); os.environ['CONTROL_ROOM_DIR'] = '$ROOM'
import chatlog; chatlog.append_message('user', 'Use the Write tool to create the file $WS/probe.txt containing the word hello, then tell me in the panel.', to='$sid')"
check "it stops at the permission question" 'wait_for "[ \"\$(agent_field $sid status)\" = waiting ]" 90'
check "the room says it is waiting for permission" 'wait_for "grep -q \"is waiting for your permission\" \"$ROOM/chat.jsonl\"" 90'
check "... and offers the terminal and the Claude window" 'grep -q "__attach:$sid" "$ROOM/chat.jsonl" && grep -q "__open_in_claude:$sid" "$ROOM/chat.jsonl"'
check "said once, not every 20 s" 'sleep 45; [ "$(grep -c "is waiting for your permission" "$ROOM/chat.jsonl")" -eq 1 ]'

vs_stop
[ -n "$short" ] && clean "$CLAUDE" stop "$short" >/dev/null 2>&1
echo "e2e blocked: $fails failure(s)"; exit $fails
