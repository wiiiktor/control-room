#!/usr/bin/env python3
"""Wake a dormant session when you write to it from the panel.

Choosing a session in the timeline addresses your message at it. If that session is not
running, nothing reads the message and it just waits. This watches for exactly that case
and starts `resume.py <id>` for the session, which continues it with `claude --resume`
and lets it answer in the panel.

  * one resume.py per session, started on demand and left running;
  * never for a session that already has a live watcher (`.watch.<id>` fresh);
  * never for an untargeted message -- those belong to whoever is listening.

⚠️ Each answer is a real Claude run billed to the account. Stop everything with
`systemctl --user stop control-room-autoresume`, or kill one session's helper by pid
from the log this prints.
"""
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOG = ROOT / "chat.jsonl"
POLL = 5


def messages():
    try:
        return [json.loads(l) for l in LOG.read_text(encoding="utf-8").splitlines() if l.strip()]
    except (OSError, json.JSONDecodeError):
        return []


def alive(sid):
    """A session with a fresh heartbeat is already reading for itself."""
    f = ROOT / (".watch." + sid)
    try:
        return (time.time() - f.stat().st_mtime) < 90
    except OSError:
        return False


def main():
    running = {}
    seen = max([m["id"] for m in messages()], default=0)
    print(f"[auto] watching from #{seen + 1}", flush=True)
    while True:
        time.sleep(POLL)
        for m in messages():
            if m["id"] <= seen:
                continue
            seen = m["id"]
            sid = (m.get("to") or "").strip()
            if m.get("role") != "user" or not sid:
                continue
            if len(sid) != 36 or sid.count("-") != 4:
                continue                       # not a session id; someone is listening
            if alive(sid):
                continue                       # it can hear you already
            p = running.get(sid)
            if p and p.poll() is None:
                continue                       # its helper is already up
            p = subprocess.Popen(
                [sys.executable, str(ROOT / "resume.py"), sid, "--from", str(m["id"])],
                cwd=ROOT)
            running[sid] = p
            print(f"[auto] woke {sid[:8]} for #{m['id']} (pid {p.pid})", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
