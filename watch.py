#!/usr/bin/env python3
"""Filter for `tail -F chat.jsonl`: print one line per new user message.

On startup it first announces anything left unanswered, so a message that arrived while
no watch was running is not lost between one watch and the next.

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

ROOT = Path(os.environ.get("CONTROL_ROOM_DIR")
            or Path(__file__).absolute().parent)   # absolute(), NOT resolve():
# a symlinked copy of this file must belong to the directory it was invoked from
WATCH = ROOT / ".watch"


def session_id():
    """Which session this watcher belongs to, so messages can be addressed to it."""
    # ⭐ Claude Code exports its own id. Read it: the "newest transcript" fallback below
    # is WRONG whenever another session is active -- a resumed session writing to its
    # transcript made this watcher believe it WAS that session, so it answered mail
    # addressed to it.
    for key in ("CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID"):
        env = (os.environ.get(key) or "").strip()
        if env:
            return env
    for i, a in enumerate(sys.argv):
        if a == "--session" and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    # fallback: the newest transcript that is NOT being driven by resume.py
    d = Path.home() / ".claude" / "projects" / "-home-wii-Projects-certain"
    root = Path(__file__).resolve().parent
    try:
        cand = sorted(d.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        return ""
    for p in cand:
        if not (root / (".resume." + p.stem)).exists():
            return p.stem
    return cand[0].stem if cand else ""


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

def mine(msg):
    """Is this a user message this session should answer?"""
    if msg.get("role") != "user":
        return False
    # addressed mail: a message sent "to" another session is not ours to answer, and
    # printing it would notify BOTH sessions -- the exact thing the selector prevents
    to = (msg.get("to") or "").strip()
    # ⚠️ only skip a message addressed to ANOTHER REAL session. A target that is not a
    # session id at all (a stray label, a typo) would otherwise be dropped by every
    # watcher at once and the message would vanish -- which is exactly what happened
    # with an <option> whose value defaulted to its own text.
    looks_like_session = len(to) == 36 and to.count("-") == 4
    if to and SID and looks_like_session and to != SID:
        return False
    return True


def emit(msg, missed=False):
    text = " ".join(msg.get("text", "").split())
    tag = " (missed)" if missed else (" (to me)" if (msg.get("to") or "").strip() else "")
    print(f"[web chat #{msg.get('id')}]{tag} {text}", flush=True)


def catch_up():
    """Announce anything still unanswered when the watch starts.

    A watch only ever sees lines that arrive AFTER it -- so a message sent while the
    session was between watches (a monitor expiring, a restart, a re-arm) sat in the log
    forever and looked to the sender like it had been ignored. Everything after the last
    assistant reply is, by definition, not yet answered.
    """
    try:
        lines = (ROOT / "chat.jsonl").read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    msgs = []
    for line in lines:
        try:
            msgs.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    last_reply = max((m.get("id", 0) for m in msgs if m.get("role") == "assistant"), default=0)
    for m in msgs:
        if m.get("id", 0) > last_reply and mine(m):
            emit(m, missed=True)


catch_up()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        continue
    if mine(msg):
        emit(msg)
