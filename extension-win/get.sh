#!/usr/bin/env bash
# Download the newest Control Room (Windows) from GitHub and install it. Run in Git Bash:
#
#   curl -fsSL https://raw.githubusercontent.com/wiiiktor/control-room/main/extension-win/get.sh | bash
#
# The repository is public, so no login is needed; `gh` is used when it is installed and logged in.
set -euo pipefail
REPO=${CONTROL_ROOM_REPO:-wiiiktor/control-room}

if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  list() { gh api "repos/$REPO/contents/$1" --jq '.[] | select(.name|endswith(".vsix")) | .name'; }
  fetch() { gh api "repos/$REPO/contents/$1" -H "Accept: application/vnd.github.raw"; }
else
  PY=$(command -v python || command -v py || command -v python3 || true)
  [ -n "$PY" ] || { echo "Python is needed: winget install Python.Python.3.12 (it also answers the panel)" >&2; exit 1; }
  list() { curl -fsSL "https://api.github.com/repos/$REPO/contents/$1" \
             | "$PY" -c 'import json,sys; [print(x["name"]) for x in json.load(sys.stdin) if x["name"].endswith(".vsix")]'; }
  fetch() { curl -fsSL "https://raw.githubusercontent.com/$REPO/main/$1"; }
fi
command -v code >/dev/null || { echo "no 'code' on the PATH -- reinstall VS Code with 'Add to PATH'" >&2; exit 1; }

# the newest by its version NUMBERS, so 0.34.10001 beats 0.34.9001
NAME=$(list extension-win \
       | awk -F'[-.]' '{printf "%d %d %d %s\n", $4, $5, $6, $0}' \
       | sort -n -k1,1 -k2,2 -k3,3 | tail -1 | cut -d' ' -f4)
[ -n "$NAME" ] || { echo "no .vsix published in $REPO/extension-win" >&2; exit 1; }

OUT="${TEMP:-/tmp}/$NAME"
fetch "extension-win/$NAME" > "$OUT"
code --install-extension "$OUT" --force
# a running window keeps the extension it started with: ask it to reload, then open the panel
code --open-url "vscode://wiiiktor.control-room-win/reload" >/dev/null 2>&1 || true
sleep 8
code --open-url "vscode://wiiiktor.control-room-win/open" >/dev/null 2>&1 || true

cat <<MSG

  $NAME installed.

  If the window did not reload by itself:  Ctrl+Shift+P -> Developer: Reload Window
  Then open the panel:                     Ctrl+Shift+P -> Control Room
  Python must be on the PATH (python --version) -- the panel needs it to receive replies.

MSG
