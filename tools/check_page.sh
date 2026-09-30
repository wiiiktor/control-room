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
  # \u26d4 RUNNING TO THE END IS NOT ENOUGH. The harness used to stop there, so a function that
  # throws the first time it is CALLED passed -- a const read before its declaration, a null element
  # touched only on a click. One throw in a handler kills the whole script, which reaches the reader
  # as "the control room has no connection". So the entry points a reader touches are called here.
  printf '\n  const EXERCISE = {\n'
  printf '    sessionMenu: () => sessionMenu(),\n'
  printf '    prefill: () => prefill("TEST"),\n'
  printf '    drawTarget: () => drawTarget(),\n'
  printf '    showSessionLatest: () => showSessionLatest(""),\n'
  printf '    closeSessionMenu: () => closeSessionMenu(),\n'
  printf '    drawTimeline: () => drawTimeline(),\n'
  printf '    drawWatchers: () => drawWatchers([], {}),\n'
  printf '  };\n'
  printf '  let bad = 0;\n'
  printf '  const note = (where, e) => { bad++; console.log("THROWS in " + where + ":", e && e.message); };\n'
  printf '  for (const k in EXERCISE) {\n'
  printf '    try { const r = EXERCISE[k](); if (r && r.catch) r.catch(e => note(k, e)); }\n'
  printf '    catch (e) { note(k, e); }\n'
  printf '  }\n'
  # \u26d4 AND THE HANDLERS THEMSELVES. A const in the temporal dead zone, or a null element, only
  # throws when the row is CLICKED -- proved by breaking it on purpose and watching this harness pass.
  # An async handler turns that into a REJECTED PROMISE, not a sync throw, so both are caught.
  printf '  const clickAll = (host, where) => {\n'
  printf '    const kids = (host && host.children) || [];\n'
  printf '    for (const b of kids) {\n'
  printf '      if (typeof b.onclick !== "function") continue;\n'
  printf '      try { const r = b.onclick(); if (r && r.catch) r.catch(e => note(where, e)); }\n'
  printf '      catch (e) { note(where, e); }\n'
  printf '    }\n'
  printf '  };\n'
  printf '  (async () => {\n'
  # \u26d4 THE PAGE IS STILL LOADING WHEN THE SCRIPT ENDS. Its last lines are
  # `loadSessions().then(poll)`, so the session names, the splash rows and `sessLoaded` all arrive on
  # a later tick. Exercising immediately found an empty list every time and passed vacuously.
  printf '    const wait = (ms) => new Promise(r => require("timers").setTimeout(r, ms));\n'
  printf '    await wait(60);\n'
  printf '    try { sessionMenu(); } catch (e) { note("session list", e); }\n'
  # \u26d4 AND WHAT THE ROWS SAY, NOT ONLY THAT THEY BUILT. The third cell is "N here" or
  # "no control room log available", and it was the SECOND for every session in the room until the
  # timeline had been opened once -- the menu counted an array only the timeline filled. Reading it
  # here is the only place that regression can be caught: the rows exist either way.
  printf '    console.log("MENU COUNTS: " + [...((menuList && menuList.children) || [])]\n'
  printf '      .map(b => ((b.children || [])[2] || {}).textContent || "").join(" | "));\n'
  printf '    try { clickAll(menuList, "session row"); } catch (e) { note("session row", e); }\n'
  printf '    try { await loadSplashSessions(); clickAll(sessBox, "splash row"); } catch (e) { note("splash list", e); }\n'
  printf '    if (!menuList || !menuList.children.length) { bad++; console.log("HARNESS BLIND: the session list built no rows -- the fixtures are not reaching the page"); }\n'
  printf '    await wait(80);\n'
  printf '    console.log(bad ? bad + " PROBLEM(S) FOUND" : "ENTRY POINTS AND ROWS ALL RAN with no throw");\n'
  printf '  })();\n'
  printf '} catch (e) {\n'
  printf '  console.log("THROWS:", e && e.message);\n'
  printf '  console.log(String((e && e.stack) || "").split("\\n").slice(1, 4).join("\\n"));\n}\n'
} > "$OUT"
node "$OUT"; rm -f "$OUT"
