#!/usr/bin/env python3
"""Answer panel messages when no live Claude session is watching.

A terminal session's watch on chat.jsonl dies with the session, and until someone
notices, messages simply sit there. This is the fallback: it waits for a new user
message, gives the live session GRACE seconds to take it, and only then runs a
headless `claude -p` to answer.

It is deliberately timid:
  * it never speaks unless the newest message is from the user and unanswered;
  * it waits GRACE seconds first, so it stays out of a live session's way;
  * it answers ONE message at a time and never chains;
  * the prompt tells it to be brief and to hand real work back to the main session.

Run it as a service (control-room-answer.service). Stop it and nothing else changes.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOG = ROOT / "chat.jsonl"
WATCH = ROOT / ".watch"
GRACE = int(os.environ.get("ANSWER_GRACE", "180"))      # seconds to let the live session answer
POLL = int(os.environ.get("ANSWER_POLL", "20"))
MODEL = os.environ.get("ANSWER_MODEL", "claude-sonnet-5")

PROMPT = """A message arrived in the Control Room panel while no live Claude session was
watching it. You are the fallback.

The message: {text}

Answer it with `python3 reply.py` in CTRL markup (see MARKUP.md), from the control-room
directory. Rules:
  * Be brief. One ::say, plus ::note lines if they earn their place.
  * Say plainly that the main session was not watching and you are the fallback.
  * If the request needs real work -- training, evaluation, editing the project, anything
    that spends money or changes files outside control-room -- do NOT do it. Say it is
    queued for the main session.
  * Answer questions you can answer from the repo, the docs and memory.
  * Do not start long-running jobs. Do not touch the GPU."""


def messages():
    try:
        return [json.loads(l) for l in LOG.read_text(encoding="utf-8").splitlines() if l.strip()]
    except (OSError, json.JSONDecodeError):
        return []


def live_watch():
    """True if a session's watcher touched .watch recently — then this agent stays quiet."""
    try:
        return (time.time() - WATCH.stat().st_mtime) < 90
    except OSError:
        return False


def answer(msg):
    print(f"[agent] answering #{msg['id']}: {msg['text'][:70]}", flush=True)
    r = subprocess.run(
        ["claude", "-p", PROMPT.format(text=msg["text"]),
         "--model", MODEL, "--permission-mode", "acceptEdits"],
        cwd=ROOT, capture_output=True, text=True, timeout=900)
    if r.returncode != 0:
        print(f"[agent] claude failed ({r.returncode}): {r.stderr[-400:]}", flush=True)
    return r.returncode == 0


def main():
    print(f"[agent] up: grace {GRACE}s, poll {POLL}s, model {MODEL}", flush=True)
    handled = 0
    while True:
        time.sleep(POLL)
        msgs = messages()
        if not msgs:
            continue
        last = msgs[-1]
        if last["role"] != "user" or last["id"] == handled:
            continue
        age = time.time() - time.mktime(time.strptime(last["ts"], "%Y-%m-%dT%H:%M:%S"))
        if age < GRACE or live_watch():
            continue                       # the live session has it, or still might
        handled = last["id"]
        answer(last)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
