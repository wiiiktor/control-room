'use strict';
/**
 * The SessionStart hook, installed into the workspace by the extension.
 *
 * The watch that reads chat.jsonl lives inside a Claude session and dies with it, so
 * after every restart the panel is a dead letterbox until someone re-arms it -- and only
 * Claude can. A SessionStart hook is the one place that runs early enough to tell it.
 */
const fs = require('fs');
const path = require('path');

const SCRIPT = 'control-room-watch.py';
const MIRROR = 'control-room-mirror.py';

/** The mirror hook, rooted at this workspace and pointed at one room's chatlog. */
function mirrorSource(root, room) {
  return `#!/usr/bin/env python3
"""UserPromptSubmit + Stop hook: copy the editor conversation into the panel.

What you type in the Claude tab never reaches the panel, and what Claude says back only
arrives there if it was sent with reply.py -- so the panel shows half a conversation. This
copies both sides in, marked \`mirror\` so watch.py knows they are a record rather than a
request (answering one would answer it twice, and the answer would be mirrored in turn).

Installed by the Control Room extension; turn it off with controlRoom.mirrorEditorChat.
"""
import json
import sys
import time
from pathlib import Path

ROOT = Path(${JSON.stringify(root)})
ROOM = Path(${JSON.stringify(room)})
sys.path.insert(0, str(ROOM))


def last_assistant_text(transcript):
    """The reply Claude just finished, out of its own transcript."""
    try:
        lines = Path(transcript).read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    for line in reversed(lines):
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        m = d.get("message") or {}
        if m.get("role") != "assistant":
            continue
        c = m.get("content")
        if isinstance(c, str):
            return c.strip()
        if isinstance(c, list):
            out = " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
            if out.strip():
                return out.strip()
    return ""


def already_answered(log):
    """Did reply.py just write the same answer into the panel?

    When a panel message is answered properly, the reply is already there in markup. The
    tab's plain-text copy of it would be the same thing twice, so a very recent assistant
    line means this Stop has nothing to add.
    """
    try:
        lines = log.read_text(encoding="utf-8").splitlines()
    except OSError:
        return False
    for line in reversed(lines):
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        if d.get("role") != "assistant" or d.get("mirror"):
            return False
        try:
            when = time.mktime(time.strptime(d.get("ts", ""), "%Y-%m-%dT%H:%M:%S"))
        except ValueError:
            return False
        return (time.time() - when) < 120
    return False


def main():
    try:
        data = json.load(sys.stdin) or {}
    except (json.JSONDecodeError, ValueError):
        return
    event = data.get("hook_event_name") or ""
    sid = data.get("session_id") or ""

    from chatlog import append_message, LOG

    if event == "UserPromptSubmit":
        text = (data.get("prompt") or "").strip()
        if text:
            append_message("user", text, to=sid or None, mirror=True)
        return

    if event == "Stop":
        if already_answered(LOG):
            return
        text = last_assistant_text(data.get("transcript_path") or "")
        if text:
            append_message("assistant", text[:4000], session=sid or None, mirror=True)


main()
`;
}


/** The hook script, rooted at this workspace. It routes each session to the control room
 *  that session has watched before, so two sessions never answer each other's mail. */
function hookSource(root) {
  return `#!/usr/bin/env python3
"""SessionStart hook: tell Claude to arm the control-room watch.

Installed by the Control Room extension. The watch lives inside a Claude session and dies
with it; this runs early enough to have it started again, before anything else.
"""
import json
import sys
from pathlib import Path

ROOT = Path(${JSON.stringify(root)})


def unanswered(log):
    """Messages after the last reply: what is sitting there right now."""
    try:
        msgs = [json.loads(l) for l in log.read_text(encoding="utf-8").splitlines() if l.strip()]
    except (OSError, json.JSONDecodeError):
        return 0
    last = max((m.get("id", 0) for m in msgs if m.get("role") == "assistant"), default=0)
    return sum(1 for m in msgs if m.get("id", 0) > last and m.get("role") == "user")


def main():
    try:
        sid = (json.load(sys.stdin) or {}).get("session_id", "")
    except (json.JSONDecodeError, ValueError):
        sid = ""

    # ⛔ NOT "has a chat.jsonl": that file appears with the FIRST message, so a room
    # nobody had written in yet was invisible here, no session was ever told to watch
    # it, and the first message had nobody to reach. reply.py is what makes a room --
    # the same test the extension itself uses.
    rooms = sorted((d for d in ROOT.glob("control-room*")
                    if d.is_dir() and ((d / "reply.py").exists() or (d / "chat.jsonl").exists())),
                   key=lambda d: len(d.name))
    if not rooms:
        return

    # the instance this session has watched before wins; otherwise the plain one
    mine = next((d for d in rooms if sid and (d / (".watch." + sid)).exists()), rooms[0])
    waiting = unanswered(mine / "chat.jsonl")

    lines = [
        "Control room: the panel's watch does not survive a session restart, and only you "
        "can start it. Arm it now with the Monitor tool, before anything else:",
        f"  command: cd {mine} && tail -n0 -F chat.jsonl | python3 -u watch.py",
        "  timeout_ms: 1800000",
        "Re-arm it every time it expires. Answer the user IN THE PANEL with "
        f"\`python3 {mine}/reply.py\` -- a reply in the editor chat never reaches them there.",
    ]
    if waiting:
        lines.append(f"{waiting} message(s) are unanswered right now; watch.py announces them on startup.")

    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": "\\n".join(lines),
    }}))


main()
`;
}

/** Is the installed hook SCRIPT the one this version writes?
 *
 * ⛔ install() only ran when the hook was absent, so a workspace that had an older,
 * buggier script kept it for good -- and the bug that mattered (a room with no messages
 * yet was invisible to it) is exactly the one that leaves someone with a panel that never
 * connects. The script is ours; when it is out of date, it is replaced.
 */
function current(root) {
  try {
    return fs.readFileSync(path.join(root, '.claude', 'hooks', SCRIPT), 'utf8') === hookSource(root);
  } catch {
    return false;
  }
}

/** Is the hook already wired up in this workspace? */
function installed(root) {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
    const starts = (settings.hooks && settings.hooks.SessionStart) || [];
    return starts.some(g => (g.hooks || []).some(h => String(h.command || '').includes(SCRIPT)));
  } catch {
    return false;                      // no settings file, or not ours to read
  }
}

/** Write the scripts and merge the hooks into .claude/settings.json, preserving the rest.
 *
 * `room` is only needed for the mirror, which has to know which log to copy into; pass
 * null to install the watch hook alone. */
function install(root, room) {
  const claude = path.join(root, '.claude');
  const hooks = path.join(claude, 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  const script = path.join(hooks, SCRIPT);
  fs.writeFileSync(script, hookSource(root), { mode: 0o755 });

  const file = path.join(claude, 'settings.json');
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch { /* absent or empty; anything unparseable is reported below */ }
  settings.hooks = settings.hooks || {};
  const starts = settings.hooks.SessionStart = settings.hooks.SessionStart || [];
  const already = starts.some(g => (g.hooks || []).some(h => String(h.command || '').includes(SCRIPT)));
  if (!already) {
    starts.push({ hooks: [{ type: 'command', command: `python3 ${script}`, timeout: 10 }] });
  }

  // The two-way mirror: what you type in the editor, and what Claude answers there.
  // Both events point at the same script, which tells them apart by hook_event_name.
  if (room) {
    const mirror = path.join(hooks, MIRROR);
    fs.writeFileSync(mirror, mirrorSource(root, room), { mode: 0o755 });
    for (const event of ['UserPromptSubmit', 'Stop']) {
      const list = settings.hooks[event] = settings.hooks[event] || [];
      if (!list.some(g => (g.hooks || []).some(h => String(h.command || '').includes(MIRROR)))) {
        list.push({ hooks: [{ type: 'command', command: `python3 ${mirror}`, timeout: 10 }] });
      }
    }
  }

  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return { script, settings: file, already };
}

module.exports = { install, installed, current, hookSource, mirrorSource, SCRIPT, MIRROR };
