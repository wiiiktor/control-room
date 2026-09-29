---
name: install-control-room
description: Install or update the Control Room VS Code extension (github.com/wiiiktor/control-room) on this machine, and set up the bypass permissions it needs. Use when the user asks to install, update or set up Control Room.
---

# Install Control Room

Control Room is a VS Code panel for driving Claude Code (https://github.com/wiiiktor/control-room).
Follow these steps in order, on the user's machine. Run the commands yourself; the user only
approves. Keep your messages short. Say what you are doing in one line per step and report problems
exactly as they occurred.

## 0. Ask once, before changing anything

Tell the user what this will do and get a single yes:

1. Download the newest Control Room extension from GitHub and install it into VS Code.
2. Turn on **bypass permissions** for Claude Code: Claude then acts without asking before each step.
   Control Room needs this. Its sessions work in the background, where a permission question can't
   be answered, so a session would stop at its first one.
3. Reload the VS Code window.

If they decline bypass permissions, still do steps 1 and 3. Tell them the panel will work, but
background sessions will stop whenever they need a permission.

## 1. Find the platform and the tools

- **OS:** macOS, Linux, or Windows. On Windows, use Git Bash or PowerShell as available.
- **VS Code CLI:** `code` on the PATH. On macOS, if it is missing, use
  `"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"`. Also accept
  `code-insiders`, `cursor`, `codium`, `windsurf`. If none exists, stop and tell the user to install
  VS Code (on Windows, with *Add to PATH*).
- **Python 3:** `python3 --version` (Windows: `python --version`, or `py --version`). The panel opens
  without it, but no answer can come back. If it is missing, say so and how to install it
  (python.org, or `winget install Python.Python.3.12`). Continue anyway.

## 2. Download the newest build

The repository is public; no login is needed.

- macOS / Linux: folder `extension`, files `control-room-<x.y.z>.vsix`, extension id
  `wiiiktor.control-room`.
- Windows: folder `extension-win`, files `control-room-win-<x.y.z>.vsix`, extension id
  `wiiiktor.control-room-win`. **Never install the non-Windows build on Windows**: its panel opens
  but no reply ever comes back.

List the folder and take the `.vsix` with the highest version numbers. Compare the numbers, not the
text: `0.34.10` is newer than `0.34.9`.

```bash
curl -fsSL https://api.github.com/repos/wiiiktor/control-room/contents/<folder>
```

Download it with:

```bash
curl -fsSL -o "<temp dir>/<name>.vsix" https://raw.githubusercontent.com/wiiiktor/control-room/main/<folder>/<name>.vsix
```

Check the file is larger than 50 KB before installing.

## 3. Install

```bash
<code-cli> --install-extension "<temp dir>/<name>.vsix" --force
```

On Windows, if `wiiiktor.control-room` (the non-Windows one) is installed, remove it first:
`code --uninstall-extension wiiiktor.control-room`.

## 4. Bypass permissions (only with the user's yes)

Two places need it, because the Claude window and the background sessions read different settings.
Edit each file in place: keep everything else, and add or replace only these keys. VS Code's
settings file may contain comments, so do not rewrite it through a JSON parser that drops them. If
a file does not exist, create it containing just these keys.

1. **Claude Code**, `~/.claude/settings.json` (Windows: `%USERPROFILE%\.claude\settings.json`):
   ```json
   { "permissions": { "defaultMode": "bypassPermissions" }, "skipDangerousModePermissionPrompt": true }
   ```
   Merge into an existing `permissions` object; keep its `allow` and `deny` lists.
2. **The Claude extension in VS Code**, the user settings file:
   macOS `~/Library/Application Support/Code/User/settings.json`,
   Linux `~/.config/Code/User/settings.json`, Windows `%APPDATA%\Code\User\settings.json`:
   ```json
   "claudeCode.allowDangerouslySkipPermissions": true,
   "claudeCode.initialPermissionMode": "bypassPermissions"
   ```
   Both are needed. The first is a gate, and without it the second does nothing.

Validate both files afterwards. `settings.json` of Claude Code must parse as JSON. For VS Code's
file, check it still opens as JSON with comments.

## 5. Reload and open

```bash
<code-cli> --open-url "vscode://wiiiktor.control-room/reload"      # Windows: control-room-win
```

VS Code may ask the user to allow the link. Then tell the user, in this order:

1. If the window did not reload: **Cmd/Ctrl+Shift+P → Developer: Reload Window**.
2. Open the panel: **Cmd/Ctrl+Shift+P → Control Room** (it also opens by itself with a workspace).
3. Pick a session or *Start a new session*, and type.
4. After the reload, the words **bypass permissions** appear under the Claude input box.

## 6. Report

Finish with a short list: the version installed, the Python found (or missing), whether bypass
permissions were set, and anything the user still has to do. Nothing else.

## Updating later

"Update Control Room" means steps 1, 2, 3 and 5. Permissions are already set.
