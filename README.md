# Control Room

![Control Room](docs/control-room.png)

A big-button control panel for driving [Claude Code](https://claude.com/claude-code),
as a VS Code extension.

You type in the panel; the message is appended to `chat.jsonl`. A Claude Code session
watches that file, does the work, and answers with `reply.py` in a small line-based markup
([MARKUP.md](MARKUP.md)) that the panel renders as headlines, stat tiles, status pills,
cards and choice buttons.

```
panel  ────────►  chat.jsonl  ──►  Claude Code session
  ▲                                       │
  └──────────  reply.py  ◄────────────────┘
```

The panel needs no server and no dependencies. Answering needs Python 3 (standard library
only) on the same machine as the session.

## Install

Needs [`gh`](https://cli.github.com), logged in (`gh auth login`). The repository is
private, so a plain URL will not do: `raw.githubusercontent.com` answers 404 for it, which
reads like a missing file rather than a missing login.

### Linux and macOS

```bash
gh api repos/wiiiktor/control-room/contents/extension/get.sh \
  -H 'Accept: application/vnd.github.raw' | bash
```

Pin a version with `| bash -s 0.10.1`. From a clone, `extension/get.sh` does the same. It
installs with whichever editor CLI the machine has — `code`, `code-insiders`, `cursor`,
`codium`, `windsurf` — or the one named in `CONTROL_ROOM_CODE`.

### Windows

Git for Windows ships Git Bash; in it, the command above works unchanged. Without it, in
`cmd.exe` (its redirection is byte-safe, unlike PowerShell's, which would corrupt the
archive):

```bat
gh api repos/wiiiktor/control-room/contents/extension --jq ".[].name" | findstr .vsix
cmd /c "gh api repos/wiiiktor/control-room/contents/extension/control-room-0.10.1.vsix -H "Accept: application/vnd.github.raw" > %TEMP%\cr.vsix"
code --install-extension %TEMP%\cr.vsix --force
```

Then, on every platform: reload the extensions (**Extensions** view, `Ctrl+Shift+X`, then
**Reload**), and **Ctrl+Shift+P → Control Room**.

## Using it

1. Open the Claude Code tab and send it **any** message. A session starts when it is given
   something to do, not when its tab is opened — this is the step everyone misses, which is
   why the panel opens on a splash that says exactly this.
2. Open the panel: **Ctrl+Shift+P → Control Room: Open panel**. It asks which session you
   want to talk to.
3. Write. The session answers in the panel.

A workspace can hold several rooms — one folder per session, each with its own
`chat.jsonl` — and every `control-room*` folder is offered as a separate panel.

## What runs where

| File | What it does | Needs |
|---|---|---|
| `extension/` | the panel: reads and writes `chat.jsonl` itself | VS Code 1.84+ |
| `watch.py` | prints each new message for the session to answer, and announces anything unanswered when it starts | Python 3 |
| `reply.py` | posts an assistant reply into the log | Python 3 |
| `status.py` | progress lines shown while a reply is being worked on | Python 3 |
| `chatlog.py` | the log format, shared by the three above | Python 3 |

Nothing here is Linux-specific: the paths come from the workspace, the timestamps are
local, and `fcntl` locking works on macOS. What is *not* portable is the conversation —
`chat.jsonl` is per machine and deliberately not in the repository, so a fresh clone gives
you the extension and an empty room.

## Keeping the panel alive

What reads the log is a watch running **inside** a Claude Code session, so it dies with
that session — and nothing else can start it again. Until it is back, messages you type sit
in `chat.jsonl` unread, which looks exactly like the panel being broken. The panel says so:
the corner pill goes **NOT WATCHING** and the tab title gains `(no watcher)`.

The extension can install a `SessionStart` hook that closes most of this gap: it writes
`.claude/hooks/control-room-watch.py` and merges one entry into `.claude/settings.json`, so
every Claude session in the workspace is told at startup to arm the watch — on the room
*that* session belongs to — and how many messages are waiting. Run **Control Room: Install
the session-start watch hook**, or say yes when the panel offers it on first open. Existing
settings are preserved and installing twice is a no-op.

## Permissions: letting Claude work without a prompt per action

The VS Code extension does **not** read `permissions.defaultMode` from
`~/.claude/settings.json`. It reads two of its own VS Code settings, and falls back to
prompting — silently — if only one of them is set:

```json
{
  "claudeCode.allowDangerouslySkipPermissions": true,
  "claudeCode.initialPermissionMode": "bypassPermissions"
}
```

The first is a gate, the second sets the starting mode; with only the second,
`getInitialPermissionMode()` returns `"default"` and nothing appears to happen.

Put them in your user settings file — *Preferences: Open User Settings (JSON)* opens the
right one on any platform, or edit it directly:

| | |
|---|---|
| Linux | `~/.config/Code/User/settings.json` |
| macOS | `~/Library/Application Support/Code/User/settings.json` |
| Windows | `%APPDATA%\Code\User\settings.json` |

...or let Claude do it — this prompt is also in the panel's splash, under *Info on how to
set required Permission Mode*:

> Set the two VS Code settings that let the Claude Code extension act without asking
> permission for every step: `claudeCode.allowDangerouslySkipPermissions = true` and
> `claudeCode.initialPermissionMode = "bypassPermissions"`. Put both in my VS Code user
> settings.json, keeping everything else in the file, then tell me to reload the window.

Reload the window afterwards. The confirmation is the words **bypass permissions** under
the Claude input box. As the name says, this skips the per-action confirmations — turn it
on for a workspace you trust, not by reflex.

## Installing an update restarts the extension host

VS Code reloads every extension when one is installed, and Claude Code is one of them: its
tab says *"Claude Code stopped responding in this tab…"* and its session connection drops.
That is the install working. The Control Room panel comes back on its own — it registers a
webview serializer and each panel records which room it belongs to — but the Claude tab
needs reopening from the session list, and the watch needs one message to start again.

## The markup

[MARKUP.md](MARKUP.md) is the whole language: `::ask ::say ::note ::kv ::ok ::warn ::err
::wait ::pick ::fill ::chart ::html ::card`. Replies also take `**bold**`, `` `code` `` and
`*italic*` inline.

![An example reply](docs/control-room-example.png)
