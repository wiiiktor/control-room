#!/usr/bin/env python3
"""Filter for `tail -F chat.jsonl`: print one line per new user message.

It also touches `.watch` every 30 seconds while it runs. That file is the ONLY evidence
the panel has that a session is actually reading the log -- the connection lamp says the
server is up, which is a different thing. The heartbeat lives in this process on purpose:
a detached shell loop would outlive the watch it claims to represent, and the panel would
go on saying someone is listening when nobody is.
"""
import json
import os
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WATCH = ROOT / ".watch"


def session_id():
    """Which session this watcher belongs to, so messages can be addressed to it."""
    env = (os.environ.get("CLAUDE_SESSION_ID") or "").strip()
    if env:
        return env
    for i, a in enumerate(sys.argv):
        if a == "--session" and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    d = Path.home() / ".claude" / "projects" / "-home-wii-Projects-certain"
    try:
        return max(d.glob("*.jsonl"), key=lambda p: p.stat().st_mtime).stem
    except (OSError, ValueError):
        return ""


SID = session_id()
MINE = ROOT / (".watch." + SID) if SID else None


def _beat():
    while True:
        for f in (WATCH, MINE):
            try:
                if f is not None:
                    f.touch()
            except OSError:
                pass
        time.sleep(30)


threading.Thread(target=_beat, daemon=True).start()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        continue
    if msg.get("role") != "user":
        continue
    # addressed mail: a message sent "to" another session is not ours to answer, and
    # printing it would notify BOTH sessions -- the exact thing the selector prevents
    to = (msg.get("to") or "").strip()
    # ⚠️ only skip a message addressed to ANOTHER REAL session. A target that is not a
    # session id at all (a stray label, a typo) would otherwise be dropped by every
    # watcher at once and the message would vanish -- which is exactly what happened
    # with an <option> whose value defaulted to its own text.
    looks_like_session = len(to) == 36 and to.count("-") == 4
    if to and SID and looks_like_session and to != SID:
        continue
    text = " ".join(msg.get("text", "").split())
    print(f"[web chat #{msg.get('id')}]{' (to me)' if to else ''} {text}", flush=True)
