#!/bin/sh
# S4: a room session, the way the extension starts one -- `claude --bg` from the room folder with the
# first prompt the panel gives it -- is told by the SessionStart hook to watch, arms the watch
# (heartbeat), and answers a message written into the room, in the room.
. "$(dirname "$0")/lib.sh"
# PERMS=default runs the session WITHOUT bypass permissions: the bridge must work on its own rules
PERMS=${PERMS:-}
echo "room round trip (sandbox $WS)${PERMS:+, permission mode $PERMS}"
setup_ws
node -e "
const h=require('$REPO/extension/src/hook.js');
h.install('$WS', '$ROOM', '$ROOM'); h.linkRoom('$ROOM', '$WS', true);"
check "hooks installed for the workspace and the room" '[ -f "$WS/.claude/settings.json" ] && [ -f "$ROOM/.claude/settings.json" ]'
check "the bridge commands are allowed in the room" 'grep -q "python3 -u reply.py" "$ROOM/.claude/settings.json"'

WAKE='Watch this control room and answer me in the panel.'
: > "$ROOM/.expect"
out=$(cd "$ROOM" && clean "$CLAUDE" --bg ${PERMS:+--permission-mode "$PERMS"} --model "$MODEL" "$WAKE" 2>&1)
short=$(printf '%s' "$out" | grep -oE 'backgrounded[^0-9a-f]*[0-9a-f]{6,}' | grep -oE '[0-9a-f]{6,}$')
check "started in the background" '[ -n "$short" ]'
sid=""; for _ in $(seq 1 15); do sid=$(agent_field "$short" sessionId); [ -n "$sid" ] && break; sleep 1; done
beat=""
for _ in $(seq 1 90); do [ -e "$ROOM/.watch.$sid" ] && { beat=1; break; }; sleep 1; done
t=$(ls "$HOME"/.claude/projects/*/"$sid".jsonl 2>/dev/null | head -1)
check "the SessionStart hook told it to watch" 'grep -q "Arm it now with the Monitor tool" "$t"'
check "it armed the watch (heartbeat in the room)" '[ -n "$beat" ]'

python3 -c "
import sys; sys.path.insert(0, '$ROOM')
import os; os.environ['CONTROL_ROOM_DIR']='$ROOM'
import chatlog; chatlog.append_message('user', 'Reply in the panel with exactly the word: pineapple', to='$sid')"
got=""
for _ in $(seq 1 120); do
  got=$(python3 -c "
import json
for l in open('$ROOM/chat.jsonl'):
    m=json.loads(l)
    if m.get('role')=='assistant' and m.get('session')=='$sid' and 'pineapple' in m.get('text','').lower(): print('yes')" | head -1)
  [ -n "$got" ] && break; sleep 1
done
check "it answered in the room, as itself" '[ -n "$got" ]'

[ -n "$short" ] && clean "$CLAUDE" stop "$short" >/dev/null 2>&1
echo "room round trip: $fails failure(s)"; exit $fails
