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

    rooms = sorted((d for d in ROOT.glob("control-room*")
                    if d.is_dir() and (d / "chat.jsonl").exists()),
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

/** Write the script and merge the hook into .claude/settings.json, preserving the rest. */
function install(root) {
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
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return { script, settings: file, already };
}

module.exports = { install, installed, hookSource, SCRIPT };
