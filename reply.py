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

from chat_server import append_message


def session_id():
    """Which Claude Code session wrote this reply.

    CLAUDE_SESSION_ID if the harness exports it; otherwise the most recently written
    transcript for this project, which is the live session by definition. Returns None
    rather than guessing when neither is available — a wrong id is worse than no id.
    """
    env = (os.environ.get("CLAUDE_SESSION_ID") or "").strip()
    if env:
        return env
    d = Path.home() / ".claude" / "projects" / "-home-wii-Projects-certain"
    try:
        newest = max(d.glob("*.jsonl"), key=lambda p: p.stat().st_mtime)
    except (OSError, ValueError):
        return None
    return newest.stem

text = " ".join(sys.argv[1:]).strip() or sys.stdin.read().strip()
if not text:
    sys.exit("nothing to send")
msg = append_message("assistant", text, session=session_id())
print(f"sent #{msg['id']}")
