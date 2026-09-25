#!/usr/bin/env bash
# Download the extension from GitHub and install it.
#
#   ./get.sh          the .vsix that is published in extension/ right now
#   ./get.sh 0.9.0    that exact version
#
# The repository is PRIVATE, so this goes through `gh` (already logged in) rather than a
# plain URL -- raw.githubusercontent.com answers 404 for a private repo, which looks like
# a missing file rather than a missing login.
set -euo pipefail
REPO=${CONTROL_ROOM_REPO:-wiiiktor/control-room}

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
echo "downloaded $NAME ($(stat -c%s "$OUT") bytes)"
[ "${CONTROL_ROOM_NO_INSTALL:-}" = 1 ] && { echo "$OUT"; exit 0; }
code --install-extension "$OUT" --force
