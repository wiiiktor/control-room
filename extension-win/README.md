# Control Room — Windows build

**Generated, not forked.** `extension/` is the one source of truth; `make.py` copies it, applies the
Windows patches and packages that. Change the panel once and both builds get it.

## Install (Windows, in Git Bash)

```bash
curl -fsSL https://raw.githubusercontent.com/wiiiktor/control-room/main/extension-win/get.sh | bash
```

Needs VS Code, Python and Git for Windows; no login (the repository is public). Or give Claude the
one-prompt install from the [main README](../README.md). Reload a running window with
`code --open-url "vscode://wiiiktor.control-room-win/reload"`.

## Build

```bash
./build.sh          # -> extension-win/control-room-win-<version>.vsix, the only one kept
```

Commit `version.json` and the new `.vsix` together.

**Versions never collide with the posix extension.** posix `X.Y.Z` builds as Windows
`X.Y.(Z*1000 + n)`: 0.34.6 gives 0.34.6001, 0.34.6002, … and 0.34.7 starts again at 0.34.7001. The
posix version stays readable inside the number, and a posix patch number would have to reach 1000
to meet a Windows one (make.py refuses that). The extension IDs differ too: `control-room` and
`control-room-win`.

⛔ **Every patch asserts that it applied.** If the shared source moves under one, the build fails and
names the patch. A fork would have gone stale silently — fourteen builds of `chat.html` shipped in a
single day while this was being written.

⛔ **It never writes to `extension/`.** The posix extension is not touched, imported or re-exported.
That is the zero-risk guarantee, and it is structural rather than a promise.

## What differs, and why

| | |
|---|---|
| `chatlog.py` imported `fcntl` | there is none in Windows Python, so `reply.py`, `status.py` and the mirror hook died on the import line. Replaced with `msvcrt.locking` on `nt`, byte-range on offset 0 — the conventional stand-in for `flock`. The posix branch keeps the exact `fcntl` calls. |
| hooks said `python3 <script>` | Windows ships `python` and `py`. The extension now resolves an interpreter that exists, once, and uses it in every hook command and every permission rule. |
| the watch was `tail -n0 -F chat.jsonl \| python3 -u watch.py` | there is no `tail` in PowerShell or cmd. `watch.py --follow chat.jsonl` now tails the file itself. |

## The follower, and the one thing to know about it

It reads by byte offset and re-reads from zero whenever the file **shrinks**, which is how a
rotation looks. The `SEEN` high-water guard that already existed is what stops that replaying
history — without it a rotation would deliver every old question again, and one of them was once
"delete ~/medicover-monitor/profile".

Tested on Linux, where it can be tested: a message before the watch started arrived as *missed*, one
during arrived live, and one written after the file was truncated and rewritten arrived exactly once
with no replay of the two before it.

## What has NOT been tested

**Windows.** There is no Windows machine here. The three changes above were each measured against the
code they replace, the generated build syntax-checks as Python and as JavaScript, and the follower is
exercised on Linux — but nothing in this directory has run on Windows.

First run there, check in this order:

1. The panel opens and renders. (This already worked; it is the control.)
2. A reply from Claude reaches the panel — that is `fcntl` fixed.
3. `.claude/settings.json` gets hooks whose command names a python that exists, and the SessionStart
   hook actually fires — that is the interpreter fixed.
4. The watch stays alive and the connection lamp stops saying "not watching" — that is `tail` fixed.
5. Session labels in the picker: expected to be **missing**, because they come from a directory named
   after the workspace path and a Windows path starts `C:`. Cosmetic, not fixed here.
