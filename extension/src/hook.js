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

/** The mirror hook, rooted at this workspace. It finds its own room per session. */
function mirrorSource(root) {
  return `#!/usr/bin/env python3
"""UserPromptSubmit + Stop hook: copy the editor conversation into the panel.

What you type in the Claude tab never reaches the panel, and what Claude says back only
arrives there if it was sent with reply.py -- so the panel shows half a conversation. This
copies both sides in, marked \`mirror\` so watch.py knows they are a record rather than a
request (answering one would answer it twice, and the answer would be mirrored in turn).

Installed by the Control Room extension; turn it off with controlRoom.mirrorEditorChat.
"""
import json
import os
import re
import sys
import time
from pathlib import Path

ROOT = Path(${JSON.stringify(root)})


def pick_room(rooms, sid):
    """Which of the workspace's rooms this session belongs to.

    Four questions, in order, and the order is the whole point:

    1. its own heartbeat -- a .watch.<id> file is proof, and it is proof in ONE room;
    2. a binding written the first time this session was placed, so every later hook
       agrees with the first one and a watch that has not started yet cannot change the
       answer;
    3. \u26d4 the room that ASKED for it. A session that has never run has no heartbeat,
       so this used to fall through to the first room by name -- and a fresh tab opened
       from any other panel attached itself to that one, wrote its turns there, and left
       the panel you started it from silent. A panel touches .expect when it opens a tab;
       the newest unclaimed one, within ninety seconds, is that request. It was fifteen
       minutes, and far too generous: every extension-host restart gives the Claude tab a
       NEW session id, and seven of them in twenty minutes claimed a request nobody had
       made for them;
    4. failing all of it, the plain room.
    """
    for d in rooms:
        if sid and (d / (".watch." + sid)).exists():
            return d
    for d in rooms:
        if sid and (d / (".session." + sid)).exists():
            return d
    best, when, now = None, 0.0, time.time()
    for d in rooms:
        try:
            m = (d / ".expect").stat().st_mtime
        except OSError:
            continue
        if now - m < 90 and m > when:
            best, when = d, m
    if best is not None and sid:
        # claim it, so the next hook for this session reads the binding instead of racing
        # the watch, and a second new session does not inherit the same request
        try:
            (best / (".session." + sid)).touch()
        except OSError:
            pass
        try:
            (best / ".expect").unlink()
        except OSError:
            pass
        return best
    return rooms[0]


def room_for(sid):
    """The room THIS session mirrors into.

    ⛔ This used to be one path baked in at install time -- the room whose panel
    happened to be open when the hook was written. Every session in the workspace then
    mirrored into that one room, so a second session's conversation appeared in the
    first one's panel, addressed to a session that panel has never seen listening.
    """
    rooms = sorted((d for d in ROOT.glob("control-room*")
                    if d.is_dir() and ((d / "reply.py").exists() or (d / "chat.jsonl").exists())),
                   key=lambda d: len(d.name))
    if not rooms:
        return None
    return pick_room(rooms, sid)


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


# \u26d4 NOT EVERY PROMPT IS A PERSON TYPING. Claude Code submits its own turns through
# this same hook: a background task finishing, a reminder, the output of a slash command.
# Mirrored, they arrive in the panel as things the reader supposedly said -- and the panel
# puts the newest one in the "you said" breadcrumb, so the screen quoted a task-notification
# back at them as their own question. A prompt that opens with one of these is machinery.
MACHINE = (
    "<task-notification>",
    "<system-reminder>",
    "<local-command-stdout>",
    "<local-command-stderr>",
    "<command-name>",
    "[SYSTEM NOTIFICATION",
    "[Artifact comment sent to Claude]",
    "Caveat: The messages below were generated",
)


def machine_typed(text):
    head = text.lstrip()
    return any(head.startswith(m) for m in MACHINE)


# Blocks the harness wraps around or appends to a prompt. The reader did not type these,
# and the panel shows the newest prompt as the "you said" breadcrumb -- so leaving them in
# quoted tag soup back at them as their own words. Paired tags are cut out whole; the
# pasted-content wrapper is unwrapped, because what is INSIDE it is exactly what the
# reader pasted.
CUT = ("system-reminder", "task-notification", "local-command-stdout",
       "local-command-stderr", "command-name", "command-message", "command-args")


def clean_prompt(text):
    for tag in CUT:
        text = re.sub("<" + tag + "[^>]*>.*?</" + tag + ">", "", text, flags=re.S)
        text = re.sub("<" + tag + "[^>]*>", "", text)
    text = re.sub("</?pasted_content[^>]*>", "", text)
    # whatever that left behind: no runs of blank lines, no leading or trailing space
    lines, out = text.splitlines(), []
    for line in lines:
        if not line.strip() and (not out or not out[-1]):
            continue
        out.append(line.rstrip())
    return "\\n".join(out).strip()


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

    room = room_for(sid)
    if room is None:
        return
    # chatlog reads this to decide WHICH log it writes; set it before the import, which
    # is where the module makes up its mind.
    os.environ["CONTROL_ROOM_DIR"] = str(room)
    sys.path.insert(0, str(room))
    from chatlog import append_message, LOG

    if event == "UserPromptSubmit":
        text = (data.get("prompt") or "").strip()
        if text and not machine_typed(text):
            text = clean_prompt(text)
            if text:
                append_message("user", text, to=sid or None, mirror=True)
        return

    if event == "Stop":
        if already_answered(LOG):
            return
        text = last_assistant_text(data.get("transcript_path") or "")
        if text:
            append_message("assistant", text[:4000], session=sid or None, mirror=True)


# \u26d4 A HOOK THAT RAISES IS A HOOK THAT VANISHES. A room holding an older chatlog.py
# made every mirrored line die in a TypeError that reached nobody: the panel just never
# heard what was typed, which is indistinguishable from the feature not existing. Write the
# reason down where the diagnosis can find it, and never let it become the user's problem.
try:
    main()
except Exception:
    import traceback
    try:
        for d in sorted(ROOT.glob("control-room*")):
            if d.is_dir() and (d / "chat.jsonl").exists():
                (d / ".mirror-error").write_text(traceback.format_exc(), encoding="utf-8")
                break
    except OSError:
        pass
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
import time
from pathlib import Path

ROOT = Path(${JSON.stringify(root)})


def pick_room(rooms, sid):
    """Which of the workspace's rooms this session belongs to.

    Four questions, in order, and the order is the whole point:

    1. its own heartbeat -- a .watch.<id> file is proof, and it is proof in ONE room;
    2. a binding written the first time this session was placed, so every later hook
       agrees with the first one and a watch that has not started yet cannot change the
       answer;
    3. \u26d4 the room that ASKED for it. A session that has never run has no heartbeat,
       so this used to fall through to the first room by name -- and a fresh tab opened
       from any other panel attached itself to that one, wrote its turns there, and left
       the panel you started it from silent. A panel touches .expect when it opens a tab;
       the newest unclaimed one, within ninety seconds, is that request. It was fifteen
       minutes, and far too generous: every extension-host restart gives the Claude tab a
       NEW session id, and seven of them in twenty minutes claimed a request nobody had
       made for them;
    4. failing all of it, the plain room.
    """
    for d in rooms:
        if sid and (d / (".watch." + sid)).exists():
            return d
    for d in rooms:
        if sid and (d / (".session." + sid)).exists():
            return d
    best, when, now = None, 0.0, time.time()
    for d in rooms:
        try:
            m = (d / ".expect").stat().st_mtime
        except OSError:
            continue
        if now - m < 90 and m > when:
            best, when = d, m
    if best is not None and sid:
        # claim it, so the next hook for this session reads the binding instead of racing
        # the watch, and a second new session does not inherit the same request
        try:
            (best / (".session." + sid)).touch()
        except OSError:
            pass
        try:
            (best / ".expect").unlink()
        except OSError:
            pass
        return best
    return rooms[0]


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

    mine = pick_room(rooms, sid)
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
    fs.writeFileSync(mirror, mirrorSource(root), { mode: 0o755 });
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
