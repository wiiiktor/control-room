#!/usr/bin/env python3
"""Answer panel messages addressed to ONE dormant Claude session, by resuming it.

    python3 resume.py 4dc633cc-dece-4292-b18b-30c73440d09b

Choosing a session in the panel routes your message to it, but a session that is not
running has nobody reading for it, so the message just waits. This picks those messages
up and runs `claude --resume <id> -p <text>`, which continues that very session — same
history, same context — and lets it answer through reply.py.

⚠️ EVERY answer is a real Claude run on your account. This is opt-in for that reason:
start it when you want to talk to a dormant session, stop it (Ctrl-C) when you are done.
"""
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOG = ROOT / "chat.jsonl"

PROMPT = """This message came from the Control Room panel, addressed to this session:

{text}

Reply in it with `python3 reply.py` from {root}, in the CTRL markup described in
MARKUP.md — one ::say, plus ::note lines if they earn their place. Keep it short.
You are continuing this session, so its earlier context applies."""


def messages():
    try:
        return [json.loads(l) for l in LOG.read_text(encoding="utf-8").splitlines() if l.strip()]
    except (OSError, json.JSONDecodeError):
        return []


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    sid = sys.argv[1]
    # --from lets a supervisor hand over the message that triggered the wake-up, which
    # would otherwise be skipped as "already in the log when I started"
    seen = max([m["id"] for m in messages()], default=0)
    if "--from" in sys.argv:
        seen = int(sys.argv[sys.argv.index("--from") + 1]) - 1
    print(f"[resume] watching for messages addressed to {sid[:8]} (from #{seen + 1})", flush=True)
    while True:
        time.sleep(5)
        for m in messages():
            if m["id"] <= seen:
                continue
            seen = m["id"]
            if m.get("role") != "user" or (m.get("to") or "") != sid:
                continue
            print(f"[resume] #{m['id']}: {m['text'][:70]}", flush=True)
            r = subprocess.run(
                ["claude", "--resume", sid, "-p", PROMPT.format(text=m["text"], root=ROOT),
                 "--permission-mode", "acceptEdits"],
                cwd=ROOT, capture_output=True, text=True, timeout=1800)
            if r.returncode:
                print(f"[resume] failed ({r.returncode}): {r.stderr[-300:]}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[resume] stopped", flush=True)
