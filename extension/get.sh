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

# Two steps people get wrong: they reload the WINDOW (which is not enough to pick up a new
# extension build) and then look for the panel in a menu. Say both, and say them in bold --
# this scrolls past under vsce's own output otherwise. Colour only when a terminal is reading.
if [ -t 1 ]; then B=$(printf '\033[1m'); D=$(printf '\033[2m'); Y=$(printf '\033[1;33m'); R=$(printf '\033[0m')
else B=; D=; Y=; R=; fi
cat <<MSG

${Y}▸ ${NAME} installed${R}

  ${B}1.${R} Reload the extensions: ${B}Extensions${R} view ${D}(Ctrl+Shift+X)${R}, then ${B}Reload${R}
     ${D}— or Ctrl+Shift+P → Developer: Reload Window${R}
  ${B}2.${R} Open the panel: ${D}Ctrl+Shift+P${R} → ${B}Control Room${R}

MSG
