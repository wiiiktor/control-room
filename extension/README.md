# Control Room — VS Code extension

The panel, as an editor tab. No server, no port: the extension host reads and writes
`chat.jsonl` itself, so `chat.html` serves this and nothing else has to be running.

Install, usage, permissions and the markup are all in the [repository README](../README.md).

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
