#!/usr/bin/env bash
# Execute chat.html's page script under a DOM shim, so a null element or a dead reference is caught
# here instead of reaching the reader as "the control room has no connection" -- one throw kills the
# whole script, and from outside that is indistinguishable from a broken bridge.
#
# ⛔ SELF-CONTAINED ON PURPOSE. The first version of this read its shim out of a session scratchpad,
# which was deleted between sessions and took the harness with it. Everything it needs is in the repo.
set -e
cd "$(dirname "$0")/../extension"
SHIM=../tools/dom_shim.js
# the ids the page really has, so a missing element is a failure and not a false alarm
IDS=$(grep -o 'id="[a-z-]*"' chat.html | sed 's/id="//;s/"//' | sort -u | sed "s/^/'/;s/$/'/" | paste -sd, -)
A=$(grep -n '^<script>' chat.html | tail -1 | cut -d: -f1)
B=$(grep -n '^</script>' chat.html | tail -1 | cut -d: -f1)
OUT=$(mktemp /tmp/cr_page_XXXX.js)
{ sed "1,3s/^const IDS = \[[^]]*\]/const IDS = [$IDS]/" "$SHIM"
  sed -n "$((A+1)),$((B-1))p" chat.html
  printf '\n  console.log("SCRIPT RAN TO THE END with no throw");\n} catch (e) {\n'
  printf '  console.log("THROWS:", e && e.message);\n'
  printf '  console.log(String((e && e.stack) || "").split("\\n").slice(1, 4).join("\\n"));\n}\n'
} > "$OUT"
node "$OUT"; rm -f "$OUT"
