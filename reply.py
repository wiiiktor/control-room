#!/usr/bin/env python3
"""Post a reply into the browser chat: python3 reply.py "your text"

Reads from stdin when no argument is given, so multi-line replies work:
    python3 reply.py <<'EOF'
    line one
    line two
    EOF
"""
import os
import sys
from pathlib import Path

# ⛔ A SYMLINKED COPY IMPORTS THE ORIGINAL. Python puts the script's RESOLVED directory on
# sys.path, so running this from an instance folder of symlinks imported chatlog from
# the ORIGINAL folder -- and replies went into the wrong panel's log. Pin the directory
# this script was invoked from before importing anything.
_HERE = Path(sys.argv[0]).absolute().parent
os.environ.setdefault("CONTROL_ROOM_DIR", str(_HERE))
sys.path.insert(0, str(_HERE))

from chatlog import append_message


def session_id():
    """Which Claude Code session wrote this reply.

    CLAUDE_SESSION_ID if the harness exports it; otherwise the most recently written
    transcript for this project, which is the live session by definition. Returns None
    rather than guessing when neither is available — a wrong id is worse than no id.
    """
    # ⭐ Claude Code exports its own id. Read it: the "newest transcript" fallback below
    # is WRONG whenever another session is active -- a resumed session writing to its
    # transcript made this watcher believe it WAS that session, so it answered mail
    # addressed to it.
    for key in ("CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID"):
        env = (os.environ.get(key) or "").strip()
        if env:
            return env
    d = Path.home() / ".claude" / "projects" / "-home-wii-Projects-certain"
    root = Path(__file__).resolve().parent
    try:
        cand = sorted(d.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        return None
    for p in cand:
        if not (root / (".resume." + p.stem)).exists():
            return p.stem
    return cand[0].stem if cand else None

text = " ".join(sys.argv[1:]).strip() or sys.stdin.read().strip()
if not text:
    sys.exit("nothing to send")
msg = append_message("assistant", text, session=session_id())
print(f"sent #{msg['id']}")
