#!/usr/bin/env bash
# Execute chat.html's page script under a DOM shim, so a null element or a dead reference
# is caught here instead of appearing to the reader as "the control room has no connection".
set -e
cd /home/wii/Projects/certain/control-room/extension
D=/tmp/claude-1000/-home-wii-Projects-certain/38224dad-54cb-41d6-aa55-fa29ffea2b18/scratchpad
IDS=$(grep -o 'id="[a-z-]*"' chat.html | sed 's/id="//;s/"//' | sort -u | sed "s/^/'/;s/$/'/" | paste -sd, -)
A=$(grep -n '^<script>' chat.html | tail -1 | cut -d: -f1)
B=$(grep -n '^</script>' chat.html | tail -1 | cut -d: -f1)
{ head -45 $D/run2.js | sed "1,3s/^const IDS = \[[^]]*\]/const IDS = [$IDS]/"
  sed -n "$((A+1)),$((B-1))p" chat.html
  cat $D/foot.js
} > $D/run3.js
node $D/run3.js
