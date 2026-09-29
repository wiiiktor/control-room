#!/usr/bin/env bash
# Download the newest Control Room (Windows) from GitHub and install it. Run in Git Bash:
#
#   gh api repos/wiiiktor/control-room/contents/extension-win/get.sh \
#     -H 'Accept: application/vnd.github.raw' | bash
#
# The repository is PRIVATE, so everything goes through `gh` (logged in with `gh auth login`):
# a plain URL answers 404 for a private repo, which reads like a missing file, not a missing login.
set -euo pipefail
REPO=${CONTROL_ROOM_REPO:-wiiiktor/control-room}

command -v gh >/dev/null || { echo "gh is not installed: winget install GitHub.cli" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is installed but not logged in: run 'gh auth login'" >&2; exit 1; }
command -v code >/dev/null || { echo "no 'code' on the PATH -- reinstall VS Code with 'Add to PATH'" >&2; exit 1; }

# the newest by its version NUMBERS, so 0.34.10001 beats 0.34.9001
NAME=$(gh api "repos/$REPO/contents/extension-win" \
         --jq '.[] | select(.name|endswith(".vsix")) | .name' \
       | awk -F'[-.]' '{printf "%d %d %d %s\n", $4, $5, $6, $0}' \
       | sort -n -k1,1 -k2,2 -k3,3 | tail -1 | cut -d' ' -f4)
[ -n "$NAME" ] || { echo "no .vsix published in $REPO/extension-win" >&2; exit 1; }

OUT="${TEMP:-/tmp}/$NAME"
gh api "repos/$REPO/contents/extension-win/$NAME" -H "Accept: application/vnd.github.raw" > "$OUT"
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
