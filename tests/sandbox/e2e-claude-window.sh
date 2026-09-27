#!/bin/sh
# E1: the real Claude extension, in an ISOLATED VS Code (its own user-data and extensions dirs in the
# sandbox), opens a Claude tab on a conversation the room holds in the background.
#
#   HANDOFF=off  control run: the window must fail exactly as the reader saw ("Error spawning Claude")
#   HANDOFF=on   the fix: no error, the room's background session released, the room told
#
# Needs: both extensions installed in $SB/vscode/ext (see tests/README), `code` app on macOS.
. "$(dirname "$0")/lib.sh"
HANDOFF=${HANDOFF:-on}
CODE=${CODE:-"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"}
UD=$SB/vscode/ud; EXT=$SB/vscode/ext; state=$SB/state-e2e
echo "e2e claude window (handoff $HANDOFF)"
setup_ws; rm -rf "$state"; mkdir -p "$state" "$UD/User"
pkill -f "$UD" 2>/dev/null; sleep 2

on=true; [ "$HANDOFF" = on ] || on=false
cat > "$UD/User/settings.json" <<JSON
{ "security.workspace.trust.enabled": false, "claudeCode.hideOnboarding": true,
  "claudeCode.preferredLocation": "panel", "controlRoom.claudeWindowHandoff": $on,
  "workbench.startupEditor": "none", "extensions.autoUpdate": false }
JSON

sid=$(start_bg) || exit 1
wait_idle "$sid" || bad "background session went idle"
touch "$ROOM/.watch.$sid"

old_logs=$(ls "$UD"/logs 2>/dev/null)
CONTROL_ROOM_STATE=$state clean "$CODE" --user-data-dir "$UD" --extensions-dir "$EXT" --new-window "$WS" >/dev/null 2>&1 &
# wait for THIS window's log -- an older run's log already exists and must not be read
log=""
for _ in $(seq 1 60); do
  for d in $(ls "$UD"/logs 2>/dev/null); do
    printf '%s\n' "$old_logs" | grep -qx "$d" && continue
    f="$UD/logs/$d/window1/exthost/Anthropic.claude-code/Claude VSCode.log"
    [ -f "$f" ] && log=$f
  done
  [ -n "$log" ] && break; sleep 1
done
check "isolated window came up" '[ -n "$log" ]'
sleep 8                                                    # both extensions activated
mark=$(wc -l < "$log")
# the trigger: the room asks the extension, as a session in the room would (request.py)
ans=$(cd "$ROOM" && python3 request.py open-in-claude "$sid")
check "the extension took the request" 'printf "%s" "$ans" | grep -q "\"ok\": *true"'

launched=""; errored=""
for _ in $(seq 1 45); do
  new=$(tail -n +"$((mark + 1))" "$log")
  launched=$(printf '%s\n' "$new" | grep -o '"resume":"'"$sid"'"' | head -1)
  errored=$(printf '%s\n' "$new" | grep -c "Error spawning Claude")
  [ -n "$launched" ] && [ "$errored" -gt 0 ] && break
  [ -n "$launched" ] && sleep 1 && continue
  sleep 1
done
sleep 10; new=$(tail -n +"$((mark + 1))" "$log"); errored=$(printf '%s\n' "$new" | grep -c "Error spawning Claude")
check "the Claude window launched a resume of $sid" '[ -n "$launched" ]'
if [ "$HANDOFF" = on ]; then
  check "no 'Error spawning Claude'" '[ "$errored" -eq 0 ]'
  check "the room released it (logged)" 'grep -q "released $sid" "$state/handoff.log"'
  check "the conversation now runs in the window, not the room" '[ "$(agent_field "$sid" kind)" = "interactive" ]'
  check "the room was told" 'tail -n 3 "$ROOM/chat.jsonl" | grep -q "moved to the Claude window"'
else
  check "control: the window fails as reported" '[ "$errored" -gt 0 ]'
  check "control: ... because a background session holds it" 'printf "%s" "$new" | grep -q "running as a background session"'
fi

pkill -f "$UD" 2>/dev/null; sleep 2
[ "$(agent_field "$sid" kind)" = background ] && clean "$CLAUDE" stop "$(printf %s "$sid" | cut -c1-8)" >/dev/null 2>&1
echo "e2e ($HANDOFF): $fails failure(s)"; exit $fails
