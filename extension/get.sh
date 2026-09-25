#!/usr/bin/env bash
# Download the Control Room extension from GitHub and install it.
#
# On any machine, with no clone of this repository:
#
#   gh api repos/wiiiktor/control-room/contents/extension/get.sh \
#     -H 'Accept: application/vnd.github.raw' | bash
#
# ...and `| bash -s 0.9.0` for one particular version. From a clone, ./get.sh works the
# same way. The repository is PRIVATE, so everything goes through `gh` rather than a plain
# URL: raw.githubusercontent.com answers 404 for a private repo, which reads like a missing
# file rather than a missing login.
set -euo pipefail
REPO=${CONTROL_ROOM_REPO:-wiiiktor/control-room}

command -v gh >/dev/null || {
  echo "gh is not installed — see https://cli.github.com (the repo is private, so a URL will not do)" >&2
  exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is installed but not logged in: run 'gh auth login'" >&2; exit 1; }

# whichever editor this machine has; a fork installs the same file the same way
EDITOR_CLI=${CONTROL_ROOM_CODE:-}
if [ -z "$EDITOR_CLI" ]; then
  for c in code code-insiders cursor codium windsurf; do
    command -v "$c" >/dev/null && { EDITOR_CLI=$c; break; }
  done
fi
[ -n "$EDITOR_CLI" ] || { echo "no editor CLI found (code / cursor / codium). Set CONTROL_ROOM_CODE." >&2; exit 1; }

if [ $# -ge 1 ]; then
  NAME="control-room-$1.vsix"
else
  # there is only ever one .vsix in extension/; sort -V so a 0.10.0 beats a 0.9.0
  NAME=$(gh api "repos/$REPO/contents/extension" \
           --jq '.[] | select(.name|endswith(".vsix")) | .name' | sort -V | tail -1)
  [ -n "$NAME" ] || { echo "no .vsix published in $REPO/extension" >&2; exit 1; }
fi

OUT="$(mktemp -d)/$NAME"
gh api "repos/$REPO/contents/extension/$NAME" -H "Accept: application/vnd.github.raw" > "$OUT"
echo "downloaded $NAME ($(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT") bytes)"
[ "${CONTROL_ROOM_NO_INSTALL:-}" = 1 ] && { echo "$OUT"; exit 0; }
"$EDITOR_CLI" --install-extension "$OUT" --force
echo "installed with $EDITOR_CLI — reload the window, then close and reopen the Control Room tab"
