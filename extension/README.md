# Control Room — VS Code extension

The same panel as the browser version, in an editor tab. No server, no port: the
extension host reads and writes `chat.jsonl` itself.

## Install from a .vsix

Download `control-room-0.1.0.vsix` from the [releases](https://github.com/wiiiktor/control-room/releases), then either:

```bash
code --install-extension control-room-0.1.0.vsix
```

or, in the editor: **Extensions ▸ … ▸ Install from VSIX…**

Then run **Control Room: Open panel** from the command palette.

Cursor, Windsurf, VSCodium and other VS Code forks install the same file the same way
(`cursor --install-extension …`).

## Build it yourself

```bash
npm install -g @vscode/vsce
cd extension
vsce package        # -> control-room-0.1.0.vsix
```

## Where it looks for the log

`<workspace>/control-room/chat.jsonl` if that folder holds a `chat.html`, otherwise
`<workspace>/chat.jsonl`. Override with the `controlRoom.logPath` setting.

`reply.py`, `status.py` and `watch.py` work unchanged beside it — they are file-based,
and the extension keeps the same format, including the `.seq` high-water mark.
