#!/usr/bin/env python3
"""Filter for `tail -F chat.jsonl`: print one line per new user message."""
import json
import sys

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
