#!/usr/bin/env bash
# Download the Control Room extension from GitHub and install it.
#
# On any machine, with no clone of this repository:
#
#   curl -fsSL https://raw.githubusercontent.com/wiiiktor/control-room/main/extension/get.sh | bash
#
# ...and `| bash -s 0.9.0` for one particular version. From a clone, ./get.sh works the
# same way. The repository is public, so nothing needs a login; `gh` is used only when it is
# installed and logged in (it has a higher API rate limit than an anonymous curl).
set -euo pipefail
REPO=${CONTROL_ROOM_REPO:-wiiiktor/control-room}

if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  list() { gh api "repos/$REPO/contents/$1" --jq '.[] | select(.name|endswith(".vsix")) | .name'; }
  fetch() { gh api "repos/$REPO/contents/$1" -H "Accept: application/vnd.github.raw"; }
else
  command -v curl >/dev/null || { echo "neither gh nor curl is installed" >&2; exit 1; }
  command -v python3 >/dev/null || { echo "python3 is needed (it also answers the panel)" >&2; exit 1; }
  list() { curl -fsSL "https://api.github.com/repos/$REPO/contents/$1" \
             | python3 -c 'import json,sys; [print(x["name"]) for x in json.load(sys.stdin) if x["name"].endswith(".vsix")]'; }
  fetch() { curl -fsSL "https://raw.githubusercontent.com/$REPO/main/$1"; }
fi

# whichever editor this machine has; a fork installs the same file the same way
EDITOR_CLI=${CONTROL_ROOM_CODE:-}
if [ -z "$EDITOR_CLI" ]; then
  for c in code code-insiders cursor codium windsurf; do
    command -v "$c" >/dev/null && { EDITOR_CLI=$c; break; }
  done
fi
# download-only needs no editor; macOS has no `code` on the PATH until it is installed from
# the palette, so try the app bundle before giving up
[ -n "$EDITOR_CLI" ] || { m="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"; [ -x "$m" ] && EDITOR_CLI=$m; }
[ -n "$EDITOR_CLI" ] || [ "${CONTROL_ROOM_NO_INSTALL:-}" = 1 ] || { echo "no editor CLI found (code / cursor / codium). Set CONTROL_ROOM_CODE." >&2; exit 1; }

if [ $# -ge 1 ]; then
  NAME="control-room-$1.vsix"
else
  # there is only ever one .vsix in extension/; sort -V so a 0.10.0 beats a 0.9.0
  # ⛔ no `sort -V`: macOS ships BSD sort, which does not have it. Sort by the version
  # numbers themselves so 0.10.0 beats 0.9.0 on every machine.
  NAME=$(list extension \
         | awk -F'[-.]' '{printf "%d %d %d %s\n", $3, $4, $5, $0}' \
         | sort -n -k1,1 -k2,2 -k3,3 | tail -1 | cut -d' ' -f4)
  [ -n "$NAME" ] || { echo "no .vsix published in $REPO/extension" >&2; exit 1; }
fi

OUT="$(mktemp -d)/$NAME"
fetch "extension/$NAME" > "$OUT"
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
