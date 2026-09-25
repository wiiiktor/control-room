#!/usr/bin/env python3
"""Filter for `tail -F chat.jsonl`: print one line per new user message.

It also touches `.watch` every 30 seconds while it runs. That file is the ONLY evidence
the panel has that a session is actually reading the log -- the connection lamp says the
server is up, which is a different thing. The heartbeat lives in this process on purpose:
a detached shell loop would outlive the watch it claims to represent, and the panel would
go on saying someone is listening when nobody is.
"""
import json
import sys
import threading
import time
from pathlib import Path

WATCH = Path(__file__).resolve().parent / ".watch"


def _beat():
    while True:
        try:
            WATCH.touch()
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
    if msg.get("role") == "user":
        text = " ".join(msg.get("text", "").split())
        print(f"[web chat #{msg.get('id')}] {text}", flush=True)
