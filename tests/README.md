# Tests

Three layers. The first costs nothing; the other two start real Claude sessions on a cheap model
(`CR_MODEL`, default `haiku`) in a throwaway workspace and take a few minutes.

```bash
node tests/run.js               # unit: no Claude process, no VS Code (a filter works: node tests/run.js wake)
sh tests/sandbox/all.sh         # sandbox + end to end, against the code in this repo
sh tests/sandbox/all.sh --no-e2e
```

## Unit — `tests/run.js`

`vscode` is faked (`unit/fake-vscode.js`) and so is `claude` where a test needs one.

| File | Checks |
|---|---|
| `handoff.test.js` | the wrapper releases exactly the conversation being resumed, in every argument form, and only a background one; the setting is set, updated, cleared — never overwritten when it is someone else's |
| `wake.test.js` | the decision table in [docs/SESSIONS.md](../docs/SESSIONS.md), and the property that no outcome resumes a running conversation without ending it first (no copies) |
| `hooks.test.js` | the generated hook scripts: who is told to watch (room folder, `.expect`, a Claude-window session never, an inherited marker ignored), the mirror (reply from `last_assistant_message`, a stale transcript never mirrored, the venv line dropped), catch-up (notices are not answers) |
| `page.test.js` | the panel page runs under a DOM shim with every entry point and clickable row exercised (`tools/check_page.sh`) |

## Sandbox — `tests/sandbox/`

The sandbox is `~/code/cr-sandbox` (`CR_SANDBOX` to move it): a workspace `ws` with a room, trusted
the way the extension trusts one. It never touches your rooms or conversations.

| Script | Checks |
|---|---|
| `handoff.sh` | S1: resuming a room-held conversation exits 1, "running as a background session" — the Claude window's error, reproduced. S2: through the wrapper the same launch exits 0, the conversation answers, the room is told |
| `room-roundtrip.sh` | a session started the way the panel starts one is told by the real hooks to watch, arms the watch, and answers a message in the room as itself. `PERMS=default` runs it without bypass permissions: the room's allow rules must be enough |
| `e2e-claude-window.sh` | the **real Claude extension** in an isolated VS Code opens a conversation the room holds. `HANDOFF=off`: fails exactly as reported. `HANDOFF=on`: no error, the conversation runs in the window, the room is told |
| `e2e-takeover.sh` | a conversation idle in a Claude tab is written to from the room: its tab closes, it runs in the room under the same id and listens, the previous room session is let go, no copy, no error |

The end-to-end tests run a second VS Code instance with its own user-data and extensions folders under
the sandbox (`--user-data-dir`, `--extensions-dir`): a window appears while they run and is closed
after. `all.sh` builds the extension and installs it there first, plus the Claude extension from the
marketplace if it is missing.

Two things every sandbox launch needs, both in `lib.sh`:

- **A clean environment.** A `claude` started from inside another Claude session inherits its markers
  (`CLAUDE_CODE_CHILD_SESSION` and others): it saves no transcript and does not register with `claude
  agents`. `clean` removes them, as a fresh terminal would.
- **Triggers VS Code will not refuse.** An external `vscode://` URL waits for a click, so the tests drive
  the extension through the room's request inbox (`request.py`), as a session in the room would.

`ptyrun.py` hosts an interactive `claude` in a headless pseudo-terminal, typed into through a FIFO — the
same kind of session (`interactive`) a Claude tab or a terminal hosts.
