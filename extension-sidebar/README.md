# Control Room — sidebar extension

The panel as a **sidebar view**: an icon in the activity bar, and the room stays put while
you work in the editor. Its sibling in [`../extension`](../extension) is the same room on a
different surface — an editor tab — and the two are **separate codebases on purpose**, so a
change to one cannot break the other.

| | tab (`../extension`) | sidebar (here) |
|---|---|---|
| extension id | `wiiiktor.control-room` | `wiiiktor.control-room-sidebar` |
| surface | one editor tab **per room** | one view, which **switches** room |
| settings | `controlRoom.*` | `controlRoomSidebar.*` |
| starts a session in a terminal | no — removed | **yes**, the splash's own button |
| survives being hidden | tab stays open | `retainContextWhenHidden` |

Both can be installed at once: different name, different ids, different `.vsix`. They read
and write the same `control-room*/chat.jsonl`, so a session answering one answers the other.

## Build it yourself

```bash
npm install -g @vscode/vsce
cd extension-sidebar
./build.sh          # -> control-room-sidebar-<version>.vsix
```

## Commands

**`Control Room (sidebar): Show the room`** reveals the view, and
**`… Choose which session to talk to`** picks the session and switches to the room that
session is listening to. Three more are registered but hidden, because the page offers each
at the moment it matters: resuming a session in a terminal, installing the session-start
hook, and diagnosing the bridge.

## Where the log lives

`<workspace>/control-room*/chat.jsonl` — every such folder is a room the view can switch to,
named after its suffix (*Control Room · medicover*). `controlRoomSidebar.logPath` pins it to
one log and turns discovery off. The room being shown is remembered across windows.
