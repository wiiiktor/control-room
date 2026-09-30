#!/bin/sh
# E5: "New session" through the real extension, in an isolated VS Code, with real Claude sessions.
#   Y is the room's session (background, listening) and BUSY with a long turn -- "older sessions can be
#   killed", so it must go anyway. Asking for a new session (request.py new-session: the same two
#   calls the panel's button makes) must: stop Y at once, start exactly one new session in the
#   background from the room folder, have it listening in seconds, and say so quietly -- no second
#   session, no terminal, no "could not start", no loud notice.
. "$(dirname "$0")/lib.sh"
state=$SB/state-e2e; rm -rf "$state"; mkdir -p "$state"
LIMIT=${LIMIT:-45}
echo "e2e new session"
setup_ws
node -e "const h=require('$REPO/extension/src/hook.js'); h.install('$WS', '$ROOM'); h.linkRoom('$ROOM', '$WS', true);"
before_log=$(wc -l < "$ROOM/chat.jsonl" 2>/dev/null || echo 0)

# Y: the room's current session, as the panel starts one
: > "$ROOM/.expect"
y_out=$(cd "$ROOM" && clean "$CLAUDE" --bg --model "$MODEL" "Watch this control room and answer me in the panel." 2>&1)
y_short=$(printf '%s' "$y_out" | grep -oE 'backgrounded[^0-9a-f]*[0-9a-f]{6,}' | grep -oE '[0-9a-f]{6,}$')
y=""; wait_for 'y=$(agent_field "$y_short" sessionId); [ -n "$y" ]' 20
check "Y listens in the room" 'wait_for "[ -e \"$ROOM/.watch.$y\" ]" 90'
wait_for '[ "$(agent_field "$y" status)" = idle ]' 60
# ...and give it something long to do, so it is busy when the new session is asked for
python3 -c "
import sys, os; sys.path.insert(0, '$ROOM'); os.environ['CONTROL_ROOM_DIR']='$ROOM'
import chatlog; chatlog.append_message('user', 'Run the shell command: sleep 120 -- then reply done in the panel.', to='$y')"
wait_for '[ "$(agent_field "$y" status)" = busy ]' 40
check "Y is busy" '[ "$(agent_field "$y" status)" = busy ]'

vs_start true || { bad "isolated window came up"; exit 1; }
t0=$(python3 -c 'import time; print(time.time())')
secs() { python3 -c "import time; print(round(time.time() - $t0))"; }
ans=$(request new-session)
check "the extension took the request" 'printf "%s" "$ans" | grep -q "\"ok\": *true"'

check "Y (busy) was stopped within 15 s" 'wait_for "[ -z \"\$(agent_field $y kind)\" ]" 15'
n=""
wait_for 'n=$(clean "$CLAUDE" agents --json | python3 -c "
import json, sys
for r in json.load(sys.stdin):
    if r.get(\"cwd\") == \"$ROOM\" and r.get(\"kind\") == \"background\" and r.get(\"sessionId\") != \"$y\" and r.get(\"startedAt\", 0) / 1000 > $t0:
        print(r[\"sessionId\"]); break"); [ -n "$n" ]' 30
check "a new session started in the background, from the room folder" '[ -n "$n" ]'
listening=""
wait_for '[ -e "$ROOM/.watch.$n" ] && listening=$(secs)' "$LIMIT"
check "it listens within ${LIMIT} s (took ${listening:-never} s)" '[ -n "$listening" ]'
sleep 5
clean "$CLAUDE" agents --json > "$SB/agents.json"
extra=$(python3 -c "
import json
rows=[r for r in json.load(open('$SB/agents.json')) if r.get('cwd') == '$ROOM' and r.get('sessionId') != '$n']
for r in rows: print('   other:', r.get('sessionId','')[:8], r.get('kind'), r.get('status'), r.get('name'), flush=True)
print(len(rows))" | tee /dev/stderr | tail -1)
check "exactly one session runs for the room" '[ "$extra" -eq 0 ]'
live=$(ls "$ROOM"/.watch.* 2>/dev/null | python3 -c "
import sys, os, time
print(sum(1 for l in sys.stdin if time.time() - os.path.getmtime(l.strip()) < 90))")
check "exactly one fresh heartbeat in the room" '[ "$live" -eq 1 ]'
news=$(tail -n +"$((before_log + 1))" "$ROOM/chat.jsonl")
check "no 'could not start' in the room" '! printf "%s" "$news" | grep -q "Could not start a session"'
check "the let-go notice is quiet" 'printf "%s" "$news" | grep "was let go" | grep -q "\"quiet\": *true"'
check "no terminal: the session is a background one" '[ "$(agent_field "$n" kind)" = background ]'

vs_stop
for s in "$n" "$y"; do [ -n "$s" ] && [ "$(agent_field "$s" kind)" = background ] && clean "$CLAUDE" stop "$(printf %s "$s" | cut -c1-8)" >/dev/null 2>&1; done
echo "e2e new session: $fails failure(s)"; exit $fails
