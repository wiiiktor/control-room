# Worklog: sessions, switching, and the Claude window's "exited with code 1"

Temporary. This file tracks one long piece of work on the Mac (2026-09-28) and is folded into
the permanent docs, then deleted, when the work is done.

## 1. Problems reported (in the reader's words, grouped)

| # | Reported | Area |
|---|---|---|
| P1 | "the Claude tab extension error on the top" — "Claude Code process exited with code 1" over a page of debug | Claude window |
| P2 | "close tab … error persists"; "i closed the tab and opened again, and error is still there — i want it to be gone for good" | Claude window |
| P3 | "'uncommitted changes review' has error in claude extension again" — after writing to that session from the panel | Claude window ↔ room |
| P4 | "functionality of button 'stop others' does not work"; several sessions answering one room | sessions |
| P5 | "i want to connect to old sessions, too" / "picking old sessions still does not work" | sessions |
| P6 | "why this session is not picked up?" — the conversation open in the Claude window cannot be reached from the panel | sessions |
| P7 | "i don't know which session is 8ef64249" — the panel names sessions by id / first message, the Claude window by title | switching |
| P8 | Two conversations titled "uncommitted changes review" appeared | sessions |
| P9 | Messages sent in the ~90 s after a session died were not woken ("no connection") | liveness |
| P10 | `source .venv/bin/activate` typed into Claude terminals and mirrored as if the reader said it | terminals |

Fixed earlier and kept under regression test: mirror one turn late (0.14.10), "you said" reacting to other
sessions (0.14.11), trust prompt blocking hidden starts (0.14.6), Keychain false alarm (0.14.1), typed
command racing the venv activation (0.14.2), catch-up counting notices as replies (0.14.7).

## 2. Facts measured on the Mac (Claude Code 2.1.283, extension 2.1.283)

- F1. Resuming a conversation that a **background** session holds exits 1:
  `Session <id> is running as a background session (<short>)` — reproduced in the sandbox with
  `claude -p --resume <id>`, both `--resume <id>` and `--resume=<id>`. This is the Claude window's error.
- F2. The official extension has no handling for it (`session_held_by_background` is reported by the CLI;
  the extension shows the raw stderr).
- F3. `claude stop <first 8 of id>` stops a **background** session and nothing else: on an interactive
  session it answers "No job matching" and leaves it running. A resume straight after `stop` succeeds.
- F4. `claude --bg --resume <id>` on a conversation open in another process **starts a copy** under a new
  id ("session X is open in another Claude Code process, so this started a copy as Y"). This is where the
  second "uncommitted changes review" came from (95bddf97 is a copy of 7812e881).
- F5. The Claude extension launches its binary through `claudeCode.claudeProcessWrapper` when set:
  `wrapper <bundled-claude> <args…>` — for sessions and for probes such as `auth status`.
- F6. `claude-vscode.editor.open <sessionId>` opens (or reveals) a Claude tab on a given conversation.
  Its "Open"/`openLast` does NOT resume the newest conversation — that earlier theory was wrong.
- F7. A Claude tab is titled with the conversation's `aiTitle` (transcript entry `ai-title`), truncated
  with "…" (e.g. "uncommitted changes revi…").
- F8. `claude agents --json` returns in ~0.15 s and lists background AND interactive sessions
  (`kind`, `status`, `pid`, `sessionId`; `id` only for background ones).
- F9. A session started from inside another Claude session inherits `CLAUDE_CODE_CHILD_SESSION` and does
  not save a transcript or register — tests must launch `claude` with those variables removed.

## 3. Target behaviour (the contract)

- C1. **One conversation, one host.** A conversation runs either in the Claude window / a terminal
  (interactive) or in the room (background) — never both, never a copy.
- C2. **Opening it in the Claude window wins.** If the room holds it, the room releases it first, so the
  window never shows "exited with code 1" (wrapper, F5 + F3). The room says where it went.
- C3. **Writing to it from the panel wins too — but never destructively.** If it is idle in a Claude tab of
  this window, that tab is closed and the room takes it over; if it is busy, or hosted somewhere the room
  cannot close (a terminal), the panel says so and does not start a copy.
- C4. **A room is served by one session.** Waking another releases the previous room-held one.
- C5. **New sessions live in the room folder** (0.24.0), so they never appear in the Claude window's list.
- C6. **Only room-launched sessions watch** (0.24.1); sessions hosted by the Claude window never do.
- C7. **Liveness comes from `claude agents`, reading from the heartbeat.** A live session whose watch is
  re-arming is not woken again (that is what used to stop a busy session or make a copy).
- C8. **The panel names sessions the way the Claude window does** (`aiTitle`, then first message).

## 4. Tests

Unit (no Claude process, `node tests/run.js`):
- U1 wrapper argument parsing (`--resume X`, `--resume=X`, `-r X`, none) → which id is released.
- U2 extension resume decision table (fake `claude` + fake `vscode`): asleep → wake; bg holder re-arming →
  no wake, no stop; interactive idle in a Claude tab → close tab, then wake; interactive busy → refuse;
  interactive in a terminal → refuse; never `--bg --resume` a live id (no copy).
- U3 single holder: after waking B, the previous room-held session A is stopped, others untouched.
- U4 SessionStart gating: room cwd → instruct; workspace cwd → silent; `.expect` fresh → instruct;
  Claude-window host marker → silent.
- U5 mirror: reply taken from `last_assistant_message`; stale transcript never mirrored.
- U6 catch-up: notices and mirror lines do not count as answers.
- U7 page: `belongs()` shows extension notices whatever session is chosen.
- U8 labels: `aiTitle` preferred, read from the transcript tail.

Sandbox, real `claude` (cheap model, clean env, `tests/sandbox/`):
- S1 reproduce F1 without the wrapper → exit 1 + "running as a background session".
- S2 same through the wrapper → exit 0, background session gone, room notice written.
- S3 `--bg --resume` of a live interactive session makes a copy (F4) — the extension must never do it.
- S4 room round trip: a background session armed by the hooks answers a message written into a sandbox room.

End to end, isolated VS Code instance (`--user-data-dir`/`--extensions-dir` in the sandbox):
- E1 real Claude extension + wrapper: open a Claude tab on a conversation the room holds → no
  "Error spawning Claude" in its log, and the room's background copy is stopped.

## 5. Sandboxes

- `~/code/cr-sandbox/ws` — a throwaway workspace with its own room, trusted, never the reader's.
- `cleanenv` — runs a command with Claude Code's session variables removed (F9).
- `ptyrun.py` — hosts an interactive `claude` in a headless pty, typed into through a FIFO.
- An isolated VS Code (separate user data and extensions dirs) for E1.

## 6. Milestones

- M1 wrapper + install + S1/S2 (fixes P1–P3 at the root).
- M2 resume decisions (C3, C4, C7) + U2/U3 (fixes P4, P5, P6, P8, P9).
- M3 gating by host marker (C6) + U4; labels (C8) + U8 (P7).
- M4 page fixes (U7) and regression suite U5/U6.
- M5 E1 end to end; install on this Mac; clean up zombie copies.
- M6 fold this file into README/docs, delete it.

## 7. Log

- 2026-09-28 01:20 — research done; F1–F9 measured; plan written.
- 01:30 — M1: `handoff/claude-handoff` + `src/handoff.js` (install at a stable path, set the setting,
  opt-out, never overwrite a foreign wrapper). U1 13/13, S1+S2 11/11.
- 01:45 — E1 with the REAL Claude extension in an isolated VS Code: control (wrapper off) reproduces
  "running as a background session" → "Error spawning Claude"; with the wrapper: no error, conversation
  moves to the window (agents: interactive), room told. URL triggers need a click in VS Code, so rooms got
  a request inbox (`request.py`: open-in-claude, close-claude-tab) — also answers "close the tab for me".
- Labels: sessions named by `aiTitle` like the Claude window (cached; P7).
