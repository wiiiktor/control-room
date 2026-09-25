#!/usr/bin/env python3
"""The log, and nothing else.

`chat.jsonl` is one JSON object per line, shared by three writers: the VS Code extension
(in JavaScript), `reply.py`, and `status.py`. They agree on this format down to the field
names, so it lives in one file rather than in whichever of them happened to need it first.

Extracted from the old `chat_server.py` when the browser front end was retired.
"""
import fcntl
import json
import os
import threading
from datetime import datetime
from pathlib import Path

# ⛔ absolute(), NOT resolve(): a SYMLINKED copy of a script must belong to the directory
# it was invoked from. Resolving made a second instance share the first one's log, and
# replies went into the wrong panel.
ROOT = Path(os.environ.get("CONTROL_ROOM_DIR") or Path(__file__).absolute().parent)
LOG = ROOT / "chat.jsonl"
SEQ = ROOT / ".seq"
STATUS = ROOT / ".status"
LOCK = threading.Lock()


def read_messages(since=0):
    if not LOG.exists():
        return []
    out = []
    with LOG.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue                      # a half-written line during a concurrent append
            if msg.get("id", 0) > since:
                out.append(msg)
    return out


def append_message(role, text, session=None, to=None, mirror=False):
    # LOCK guards threads inside this process; flock guards the other processes writing
    # the same log (the extension host and reply.py).
    with LOCK, LOG.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        existing = read_messages()
        # High-water mark survives truncation of chat.jsonl, so ids never repeat and a
        # panel that is already open keeps polling correctly after a wipe.
        try:
            high = int(SEQ.read_text())
        except (OSError, ValueError):
            high = 0
        next_id = max(high, existing[-1]["id"] if existing else 0) + 1
        SEQ.write_text(str(next_id))
        msg = {
            "id": next_id,
            "role": role,
            "text": text,
            # LOCAL time: the panel prints a wall clock, and UTC put every message two
            # hours behind the replies to it.
            "ts": datetime.now().isoformat(timespec="seconds"),
        }
        if session:                           # which Claude session produced this reply
            msg["session"] = session
        if to:                                # addressed to ONE watcher; absent = anyone
            msg["to"] = to
        # copied from the editor conversation rather than written here. watch.py ignores
        # these: they are a record, not a request, and answering them would loop.
        if mirror:
            msg["mirror"] = True
        handle.write(json.dumps(msg, ensure_ascii=False) + "\n")
        handle.flush()
        fcntl.flock(handle, fcntl.LOCK_UN)
    # a new message ends whatever the last one was waiting for
    clear_status()
    return msg


def read_status():
    """Progress lines written by status.py while a reply is being worked on.

    They live in their own file, not in chat.jsonl: they are scaffolding, not messages,
    and they are cleared the moment the reply lands. Newest last, capped at 8.
    """
    try:
        lines = [l.rstrip("\n") for l in STATUS.read_text(encoding="utf-8").splitlines() if l.strip()]
    except OSError:
        return []
    return lines[-8:]


def clear_status():
    try:
        STATUS.unlink()
    except OSError:
        pass


def add_status(line):
    with LOCK, STATUS.open("a", encoding="utf-8") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        fh.write(line.strip() + "\n")
