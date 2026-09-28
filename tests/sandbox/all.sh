#!/bin/sh
# Every sandbox test, against the code in this repo. Builds the extension and installs it into the
# isolated VS Code first (plus the Claude extension, from the marketplace, if it is missing there).
#   tests/sandbox/all.sh            everything
#   tests/sandbox/all.sh --no-e2e   skip the isolated-VS-Code tests
. "$(dirname "$0")/lib.sh"
cd "$REPO/extension" || exit 1
if [ "${1:-}" != --no-e2e ]; then
  cp ../chatlog.py ../reply.py ../status.py ../watch.py ../request.py runtime/
  npm_config_cache=${npm_config_cache:-$HOME/.cache/cr-npm} npx --yes -p node@22 -p @vscode/vsce -- \
    vsce package --allow-missing-repository -o "$SB/cr-test.vsix" >/dev/null 2>&1 || { echo "build failed"; exit 1; }
  mkdir -p "$EXT"
  "$CODE" --extensions-dir "$EXT" --user-data-dir "$UD" --install-extension "$SB/cr-test.vsix" --force >/dev/null 2>&1
  ls "$EXT" | grep -q anthropic.claude-code || \
    "$CODE" --extensions-dir "$EXT" --user-data-dir "$UD" --install-extension anthropic.claude-code >/dev/null 2>&1
fi
total=0
T=$REPO/tests/sandbox
sh "$T/handoff.sh"; total=$((total + $?))
sh "$T/room-roundtrip.sh"; total=$((total + $?))
env PERMS=default sh "$T/room-roundtrip.sh"; total=$((total + $?))
if [ "${1:-}" != --no-e2e ]; then
  env HANDOFF=off sh "$T/e2e-claude-window.sh"; total=$((total + $?))
  env HANDOFF=on sh "$T/e2e-claude-window.sh"; total=$((total + $?))
  sh "$T/e2e-takeover.sh"; total=$((total + $?))
fi
echo; echo "sandbox: $total failure(s)"; exit $total
