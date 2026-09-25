# Control Room — VS Code extension

The same panel as the browser version, in an editor tab. No server, no port: the
extension host reads and writes `chat.jsonl` itself.

## Install from a .vsix

Download `control-room-0.5.0.vsix` from the [releases](https://github.com/wiiiktor/control-room/releases), then either:

```bash
code --install-extension control-room-0.5.0.vsix
```

or, in the editor: **Extensions ▸ … ▸ Install from VSIX…**

Then run **Control Room: Open panel** from the command palette.

Four commands:

| command | what it does |
|---|---|
| `Control Room: Open panel for a session` | pick a **session** by name; opens the control room it is listening to, already addressed to it |
| `Control Room: Open every control room in this workspace` | one tab per instance, in one go |
| `Control Room: Resume a Claude session in a terminal` | pick a session, and it opens a terminal running `claude --resume <id>` |
| `Control Room: Install the session-start watch hook` | writes the hook below, so Claude starts watching the panel by itself |

The second one is what the browser version cannot do: a dormant session gets a real
window you can watch and type into, instead of a headless process answering in the log.

Cursor, Windsurf, VSCodium and other VS Code forks install the same file the same way
(`cursor --install-extension …`).

## Build it yourself

```bash
npm install -g @vscode/vsce
cd extension
vsce package        # -> control-room-0.5.0.vsix
```

## Keeping the panel alive

What reads the log is a watch running *inside* a Claude session, so it dies whenever that
session restarts — and nothing else can start it again. Until it is back, messages you
type sit in `chat.jsonl` unread, which looks exactly like the panel being broken.

The extension can install a `SessionStart` hook that fixes this: it writes
`.claude/hooks/control-room-watch.py` and merges one entry into `.claude/settings.json`,
so every Claude session in the workspace is told at startup to arm the watch — on the
control room *that* session belongs to — and how many messages are waiting. Run
**Control Room: Install the session-start watch hook**, or say yes when the panel offers
it on first open. Existing settings are preserved and installing twice is a no-op.

## One panel per session

A workspace can hold several control rooms — one folder per Claude session, each with
its own `chat.jsonl`:

```
your-project/
  control-room/            # session A
  control-room-medicover/  # session B
```

Every `control-room*` folder with a log in it is offered as a separate panel, named
after its suffix (*Control Room · medicover*). You never have to think in folders,
though: the palette asks which **session** you want to talk to, listing each live one
under the name its transcript carries — the same name Claude Code's own session picker
shows — and opens the right control room with that session already selected as the
recipient. A room nobody is listening to is still listed, marked `no session listening`. Panels are independent: each polls only
its own log, so two sessions never answer into the same conversation. The picker says
which session is currently listening to each one, and a panel with no live watcher
says `(no watcher)` in its tab title rather than letting a message sit unanswered.

Setting `controlRoom.logPath` pins the extension to a single log and turns discovery
off. With no `control-room*` folder at all it falls back to `<workspace>/chat.jsonl`.

`reply.py`, `status.py` and `watch.py` work unchanged beside it — they are file-based,
and the extension keeps the same format, including the `.seq` high-water mark.
