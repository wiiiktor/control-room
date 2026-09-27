#!/bin/sh
# S1 + S2: the Claude window's "exited with code 1", reproduced and then prevented by the wrapper.
#
# The Claude extension resumes a conversation by running `claude --resume=<id> ...`. If the room
# holds that conversation as a BACKGROUND session, claude refuses and exits 1 (S1). Through
# claude-handoff it is released first and the resume succeeds (S2).
. "$(dirname "$0")/lib.sh"
echo "handoff (sandbox $WS)"
setup_ws
state=$SB/state; rm -rf "$state"; mkdir -p "$state"

sid=$(start_bg) || exit 1
wait_idle "$sid" || bad "background session went idle"
touch "$ROOM/.watch.$sid"                      # the room holds it, as a watching session would

# S1 -- exactly what the Claude window runs, without the wrapper
(cd "$WS" && clean "$CLAUDE" -p --model "$MODEL" --resume="$sid" "Reply with the single word: again") \
  > "$SB/s1.out" 2> "$SB/s1.err"; code=$?
check "S1 resume of a room-held session exits non-zero" '[ "$code" -ne 0 ]'
check "S1 ... because it is running as a background session" 'grep -q "running as a background session" "$SB/s1.err"'
check "S1 the room still holds it" '[ "$(agent_field "$sid" kind)" = "background" ]'

# S2 -- the same launch through the wrapper, the way claudeProcessWrapper makes the extension run it
(cd "$WS" && CONTROL_ROOM_STATE=$state clean "$REPO/extension/handoff/claude-handoff" "$CLAUDE" \
   -p --model "$MODEL" --resume="$sid" "Reply with the single word: again") > "$SB/s2.out" 2> "$SB/s2.err"; code=$?
check "S2 resume through the wrapper exits 0" '[ "$code" -eq 0 ]'
check "S2 ... and the conversation answers" 'grep -qi "again" "$SB/s2.out"'
check "S2 no background session holds it any more" '[ "$(agent_field "$sid" kind)" != "background" ]'
check "S2 the handoff is logged" 'grep -q "released $sid" "$state/handoff.log"'
check "S2 the room is told, about that session" 'tail -n 3 "$ROOM/chat.jsonl" | grep -q "\"about\": \"$sid\""'
check "S2 the room forgets its heartbeat at once" '[ ! -e "$ROOM/.watch.$sid" ]'

# pass-through: every other launch is untouched (the extension also runs probes through the wrapper)
v1=$(clean "$CLAUDE" --version 2>&1); v2=$(clean "$REPO/extension/handoff/claude-handoff" "$CLAUDE" --version 2>&1)
check "pass-through: --version identical" '[ "$v1" = "$v2" ]'
(cd "$WS" && clean "$REPO/extension/handoff/claude-handoff" "$CLAUDE" --resume 2>/dev/null </dev/null >/dev/null & sleep 2; kill $! 2>/dev/null)
check "pass-through: bare --resume (picker) releases nothing" '[ "$(grep -c released "$state/handoff.log")" -eq 1 ]'

echo "handoff: $fails failure(s)"; exit $fails
