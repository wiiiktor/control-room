# Control Room — VS Code extension

The same panel as the browser version, in an editor tab. No server, no port: the
extension host reads and writes `chat.jsonl` itself.

## Install in one command

On any machine, with no clone of this repository — anyone who can see the repo can run it:

```bash
gh api repos/wiiiktor/control-room/contents/extension/get.sh \
  -H 'Accept: application/vnd.github.raw' | bash
```

Add `-s <version>` to pin one: `| bash -s 0.9.0`. From a clone, `extension/get.sh` and
`extension/get.sh 0.9.0` do the same thing.

It needs `gh`, logged in. The repository is private, so everything goes through it rather
than a plain URL — `raw.githubusercontent.com` answers 404 for a private repo, which reads
like a missing file rather than a missing login. The installer picks whichever editor CLI
the machine has (`code`, `code-insiders`, `cursor`, `codium`, `windsurf`), or the one named
in `CONTROL_ROOM_CODE`.

## Install from a .vsix

Download `control-room-0.9.0.vsix` from the [releases](https://github.com/wiiiktor/control-room/releases), then either:

```bash
code --install-extension control-room-0.9.0.vsix
```

or, in the editor: **Extensions ▸ … ▸ Install from VSIX…**

Then run **Control Room: Open panel** from the command palette.

One command in the palette: **`Control Room: Open panel`**. It asks which **session**
you want to talk to, listing each live one under the name its transcript carries, and
opens the control room that session is listening to with the session already selected as
the recipient. If nothing is listening it says so, and says what to do about it.

Three more commands exist but are kept out of the palette, because the panel offers each
of them at the moment it matters: opening every instance at once, resuming a session in a
terminal, and installing the hook below.

The second one is what the browser version cannot do: a dormant session gets a real
window you can watch and type into, instead of a headless process answering in the log.

Cursor, Windsurf, VSCodium and other VS Code forks install the same file the same way
(`cursor --install-extension …`).

## Build it yourself

```bash
npm install -g @vscode/vsce
cd extension
vsce package        # -> control-room-0.9.0.vsix
```

## First open

The panel opens by itself when the workspace opens (`controlRoom.openOnStartup`, on by
default, for a workspace with a single control room). If nothing is reading the log yet
it says so and offers one button, **Start a Claude session for this room**, which opens a
terminal running `claude` with a first instruction — because a Claude session exists once
it has been given something to do, not when its tab is opened. That is the one step in
this whole setup that nobody guesses.

## Installing an update restarts the extension host

VS Code reloads every extension when one is installed, and the Claude Code extension is
one of them: its tab says *"Claude Code stopped responding in this tab…"* and its session
connection drops. That is the install working, not a fault — reopen the conversation from
the session list, or reload the window. It also ends the watch described below, so expect
to give the Claude tab one message afterwards.

## Keeping the panel alive

What reads the log is a watch running *inside* a Claude session, so it dies whenever that
session restarts — and nothing else can start it again. Until it is back, messages you
type sit in `chat.jsonl` unread, which looks exactly like the panel being broken.

When nothing is listening, the panel puts a splash over the screen — *start the Claude
extension and write anything in there, to start your working session* — with one button on
it. It offers **Open a Claude tab** — it runs the Claude
Code extension's own open command, so the session lands in an editor tab rather than a
terminal. A tab is not yet a session: Claude Code runs when it is given something to do,
so type anything in it, and that first message starts the session that arms the watch. If
the extension is not installed, the button falls back to a terminal.

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
