# Sessions, the room, and the Claude window

How Control Room decides which Claude Code session answers a room, how a conversation moves between
the room and the Claude window, and why the Claude window no longer fails with *"Claude Code process
exited with code 1"*. Everything here was measured on Claude Code 2.1.283 (CLI and VS Code extension),
on macOS and Linux; the tests that check it are in [tests/README.md](../tests/README.md).

## The rule: one conversation, one process

A conversation (a session id) runs in exactly one place at a time:

- **in the Claude window** — a Claude tab, or a terminal: `claude agents --json` calls these
  `interactive`;
- **in the room** — a background session (`claude --bg`), started or woken by the panel.

Never both, and never as a copy. Every rule below exists because one of these three facts bit:

| Measured | Consequence |
|---|---|
| `claude --resume <id>` on a conversation a **background** session holds exits 1: *"Session … is running as a background session"*. The Claude extension does not handle it and prints the stderr. | This is the Claude window's "exited with code 1". |
| `claude --bg --resume <id>` on a conversation open **anywhere else** does not join it: it starts a **copy** under a new id (*"…so this started a copy as Y"*). | Two conversations with the same title; two sessions answering one room. |
| `claude stop <id>` stops **background** sessions only. On a Claude tab or a terminal it answers *"No job matching"* and does nothing. A resume straight after a stop succeeds. | The room can let go of its own sessions, but cannot end a window's. |

## Opening a conversation in the Claude window

The Claude extension launches `claude` through the setting `claudeCode.claudeProcessWrapper` when it
is set, as `wrapper <bundled claude> <arguments…>`. Control Room installs a small wrapper,
`~/.claude/control-room/bin/claude-handoff`, and sets it there (a stable path, because the versioned
extension folder is deleted by an update while the setting lives on).

Before any `--resume <id>` the wrapper runs `claude stop <first 8 of id>`. If the room held the
conversation in the background, it is released and the window's resume succeeds; otherwise the stop
finds nothing and changes nothing. Then it `exec`s claude with the arguments untouched — every other
launch, including the extension's own probes, passes straight through. When it does release one, it:

- appends `released <id> for the Claude window` to `~/.claude/control-room/handoff.log`;
- removes the room's heartbeat and binding for it (`.watch.<id>`, `.session.<id>`);
- writes a notice into the room: *"<title> moved to the Claude window"*.

A step the room's session was in the middle of ends with it — opening the conversation in the window
is the reader choosing where it runs.

**Settings.** `controlRoom.claudeWindowHandoff` (default on). Turning it off removes the wrapper
setting, but only if it is Control Room's. A wrapper you configured yourself is never replaced —
Diagnose says so, and the Claude window will then fail on a conversation the room holds. The Claude
extension skips its own update check while any wrapper is configured. Windows: not available (the
wrapper is a shell script).

## Writing to a conversation from the panel

Every message to a known session goes through one check (`src/wake.js`, ~0.15 s for `claude agents`):

| The conversation is… | The room… |
|---|---|
| listening in this room | does nothing — it reads the message itself |
| not running anywhere | wakes it here in the background (`claude --bg --resume`) |
| this room's background session, busy, or its watch lapsed < 1 min ago | waits — the watch catches the message up when it re-arms |
| this room's background session, idle, watch silent > 1 min | stops and wakes it again (it had stopped listening; idle, it loses nothing) |
| another room's / another task's background session, idle | stops it and wakes it here |
| … busy | refuses — taking it would end what it is doing |
| idle in a Claude tab of this window | closes that tab (its process ends with it), then wakes it here |
| busy in a Claude tab | refuses — continue there, or write again when it is done |
| open in a terminal or another window, or its title matches two tabs | refuses, and says what to close |

No row wakes a running conversation without ending it first — that is what prevents copies, and a
unit test checks every combination. A heartbeat file never outvotes `claude agents`: a session that is
not running is woken even in the 90 s its file stays fresh after it died. If `claude agents` cannot be
read, the heartbeat alone decides, so a failed check never wakes a listener.

**One session per room.** Once a newly woken or started session is listening, the room lets its other
background listeners go (`claude stop`) and says so. Sessions in a Claude tab or a terminal are never
stopped by this. "Stop the others" in the panel does the same by hand, and lists any it could not stop
with the reason.

**Where new sessions live.** A session the room *starts* runs from the room folder, so Claude files it
under the room's own project and it never appears in the Claude window's session list. A session the
room *wakes* keeps its original folder (resume works from anywhere, and the transcript stays where it
was). The room folder gets its own `.claude/settings.json` pointing at the workspace's hook scripts,
because Claude Code reads project hooks from the folder a session starts in.

**Which sessions watch.** The session-start hook tells a session to arm the watch only if the room
launched it: it runs from the room folder, or the room asked for a session seconds ago (`.expect`, or
that session's `.session.<id>` binding). A session hosted by the Claude window is never told, whatever
the files say: the wrapper marks it with its own process id (`CONTROL_ROOM_HOST_PID`), and the hook
honours the mark only from its parent — because a background session inherits the environment of the
long-lived daemon, not of whoever launched it, a bare marker could otherwise end up on room sessions.

## Names

Sessions are named the way the Claude window names them: the transcript's latest `aiTitle` (read from
its tail), falling back to the first message typed by hand. A Claude tab is matched to its conversation
by that title; the tab shows it cut with "…" when long.

## Asking the extension to act: `request.py`

A session in the room cannot reach VS Code. `request.py`, shipped into every room, leaves a request
file that the extension picks up within a second and answers:

```bash
python3 request.py open-in-claude <session-id>      # open (move) that conversation in the Claude window
python3 request.py close-claude-tab [<session-id>]   # close one conversation's Claude tab, or all of them
python3 request.py wake <session-id>                 # bring a conversation to this room, as writing to it does
```

Requests older than 30 s are refused, so a leftover file cannot fire when VS Code starts later.

## Looking at what happened

```bash
claude agents --json                       # what runs where: kind interactive|background, status idle|busy
cat ~/.claude/control-room/handoff.log     # every conversation the wrapper handed to the Claude window
ls <room>/.watch.*                         # who is listening (a file touched every 30 s)
```

**Control Room: Diagnose the bridge** reports the wrapper's state alongside the room, Python and hooks.
The Claude extension's own log shows each launch (`launch_claude … "resume":"<id>"`) and each failure
(`Error spawning Claude`):

| | |
|---|---|
| macOS | `~/Library/Application Support/Code/logs/<latest>/window1/exthost/Anthropic.claude-code/Claude VSCode.log` |
| Linux | `~/.config/Code/logs/<latest>/window1/exthost/Anthropic.claude-code/Claude VSCode.log` |
