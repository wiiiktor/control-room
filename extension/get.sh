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
  # ⛔ no `sort -V`: macOS ships BSD sort, which does not have it. Sort by the version
  # numbers themselves so 0.10.0 beats 0.9.0 on every machine.
  NAME=$(gh api "repos/$REPO/contents/extension" \
           --jq '.[] | select(.name|endswith(".vsix")) | .name' \
         | awk -F'[-.]' '{printf "%d %d %d %s\n", $3, $4, $5, $0}' \
         | sort -n -k1,1 -k2,2 -k3,3 | tail -1 | cut -d' ' -f4)
  [ -n "$NAME" ] || { echo "no .vsix published in $REPO/extension" >&2; exit 1; }
fi

OUT="$(mktemp -d)/$NAME"
gh api "repos/$REPO/contents/extension/$NAME" -H "Accept: application/vnd.github.raw" > "$OUT"
echo "downloaded $NAME ($(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT") bytes)"
[ "${CONTROL_ROOM_NO_INSTALL:-}" = 1 ] && { echo "$OUT"; exit 0; }
"$EDITOR_CLI" --install-extension "$OUT" --force

# A window that is already open keeps the extension it started with. This asks the running
# window to reload itself; it works from the version that registers the handler onwards, so
# the step below is still printed for the first update and for a window that ignores it.
"$EDITOR_CLI" --open-url "vscode://wiiiktor.control-room/reload" >/dev/null 2>&1 || true

# Two steps people get wrong: they reload the WINDOW (which is not enough to pick up a new
# extension build) and then look for the panel in a menu. Say both, and say them in bold --
# this scrolls past under vsce's own output otherwise. Colour only when a terminal is reading.
if [ -t 1 ]; then B=$(printf '\033[1m'); D=$(printf '\033[2m'); Y=$(printf '\033[1;33m'); R=$(printf '\033[0m')
else B=; D=; Y=; R=; fi

# The panel itself needs no Python -- the extension host reads and writes the log. ANSWERING
# needs it, so a machine without python3 gets a panel that accepts messages and can never be
# replied to. That is indistinguishable from a broken bridge, so say it here, at install time,
# rather than leaving it to be discovered as silence.
PY_NOTE=""
if PY_V=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null); then
  PY_NOTE="  ${D}python3 ${PY_V} found — replies will work${R}"
else
  PY_NOTE="  ${Y}⚠ no python3 on PATH${R}${D} — the panel will accept messages and nothing can answer them.
     Install Python 3 (macOS: ${R}${B}brew install python3${R}${D}, Debian/Ubuntu: ${R}${B}sudo apt install python3${R}${D}).${R}"
fi

cat <<MSG

${Y}▸ ${NAME} installed${R}

${PY_NOTE}

  ${B}1.${R} A reload was requested automatically. If the window did not reload:
     ${D}Ctrl+Shift+P → Developer: Reload Window${R}
  ${B}2.${R} Start a Claude Code tab and send it any message — that is what opens the
     two-way link; a tab with no session is not listening.
  ${B}3.${R} Open the panel: ${D}Ctrl+Shift+P${R} → ${B}Control Room${R}

MSG
