# Control Room — tab extension

The panel, as an **editor tab**, one per room. No server, no port: the extension host reads
and writes `chat.jsonl` itself, so `chat.html` serves this and nothing else has to be running.

Its sibling in [`../extension-sidebar`](../extension-sidebar) is the same room as a sidebar
view, and it is a **separate codebase** — separate extension id, separate settings, separate
`.vsix`. Two things follow: a fix made here is not made there, and **starting a session in a
terminal belongs to the sidebar only**. This version reaches a session through the Claude tab,
and opens a terminal for one purpose alone: resuming a session you asked it to bring back.

Install, usage, permissions and the markup are all in the [guide](../docs/GUIDE.md).

## Build it yourself

```bash
npm install -g @vscode/vsce
cd extension
./build.sh          # -> control-room-<version>.vsix
```

## Commands

One is in the palette: **`Control Room: Open panel`**. It asks which session you want to
talk to and opens the room that session is listening to, with the session already selected
as the recipient. Three more are registered but hidden, because the panel offers each at
the moment it matters: opening every room at once, resuming a session in a terminal, and
installing the session-start hook.

## Where the log lives

`<workspace>/control-room*/chat.jsonl` — every such folder is a separate panel, named after
its suffix (*Control Room · medicover*). `controlRoom.logPath` pins it to one log and turns
discovery off.
