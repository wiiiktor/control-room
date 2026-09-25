#!/usr/bin/env python3
"""Say what is happening while a reply is being worked on:

    python3 status.py "reading the training log"

The line appears under "Working on it…" in the panel and is gone the moment the reply
lands. This is scaffolding, not conversation — it never enters chat.jsonl, so the
timeline and the log stay a clean record of what was actually said.

Several lines stack, newest last, capped at 8 by the server.
"""
import os
import sys
from pathlib import Path

# ⛔ A SYMLINKED COPY IMPORTS THE ORIGINAL. Python puts the script's RESOLVED directory on
# sys.path, so running this from an instance folder of symlinks imported chat_server from
# the ORIGINAL folder -- and replies went into the wrong panel's log. Pin the directory
# this script was invoked from before importing anything.
_HERE = Path(sys.argv[0]).absolute().parent
os.environ.setdefault("CONTROL_ROOM_DIR", str(_HERE))
sys.path.insert(0, str(_HERE))

from chat_server import add_status

text = " ".join(sys.argv[1:]).strip() or sys.stdin.read().strip()
if not text:
    sys.exit("nothing to say")
add_status(text)
