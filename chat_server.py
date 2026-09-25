#!/usr/bin/env python3
"""Tiny chat bridge: browser page <-> chat.jsonl <-> Claude Code.

GET  /                       -> chat.html
GET  /api/messages?since=N   -> {"messages": [...], "last": N}
POST /api/send  {"text":...} -> appends a user message to chat.jsonl
"""
import fcntl
import json
import os
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(os.environ.get("CONTROL_ROOM_DIR")
            or Path(__file__).absolute().parent)   # absolute(), NOT resolve():
# a symlinked copy of this file must belong to the directory it was invoked from
LOG = ROOT / "chat.jsonl"
PAGE = ROOT / "chat.html"
ACCESS = ROOT / "access.log"
SEQ = ROOT / ".seq"
STATUS = ROOT / ".status"
WATCH = ROOT / ".watch"      # touched by the watcher; its age says whether anyone is listening
LOCK = threading.Lock()


def build_id():
    """Version of the page currently on disk; an open page reloads when it changes."""
    try:
        return str(int(PAGE.stat().st_mtime))
    except OSError:
        return "0"


SESSIONS = Path.home() / ".claude" / "projects" / "-home-wii-Projects-certain"


def session_labels():
    """id -> what the session opened with, which is all Claude Code gives us as a name.

    Only the head of each transcript is read: the opening user message is in the first
    few lines, and one of these files is 450 MB.
    """
    out = {}
    try:
        files = sorted(SESSIONS.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        return out
    for p in files:
        label = ""
        try:
            with p.open(encoding="utf-8", errors="replace") as fh:
                for i, line in enumerate(fh):
                    if i > 40:
                        break
                    try:
                        d = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if d.get("type") == "summary" and d.get("summary"):
                        label = d["summary"]
                        break
                    m = d.get("message", {})
                    if m.get("role") == "user" and not label:
                        c = m.get("content")
                        label = c if isinstance(c, str) else (
                            c[0].get("text", "") if isinstance(c, list) and c else "")
                        break
        except OSError:
            pass
        out[p.stem] = " ".join((label or "").split())[:90] or "(empty)"
    return out


def read_status():
    """Progress lines written by `status.py` while a reply is being worked on.

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


def watchers():
    """Sessions with a LIVE watch: one .watch.<id> file each, touched every 30s.

    This is what the composer's "to:" list is built from. A session that has gone is
    simply a stale file, which is why the age is reported rather than a boolean.
    """
    labels = session_labels()
    out = []
    for f in ROOT.glob(".watch.*"):
        sid = f.name[len(".watch."):]
        try:
            age = round(time.time() - f.stat().st_mtime)
        except OSError:
            continue
        if age > 90:
            continue
        out.append({"session": sid, "age": age, "label": labels.get(sid, "(no transcript)")})
    return sorted(out, key=lambda r: r["age"])


def watch_age():
    """Seconds since the watcher last said it was alive, or None if it never has.

    Claude watches chat.jsonl from a terminal. That watch dies with the session, and
    nothing in this server would know — a message would simply sit unanswered. The
    watcher touches .watch every 30s, so the page can say so instead.
    """
    try:
        return round(time.time() - WATCH.stat().st_mtime)
    except OSError:
        return None


def access(line):
    """Record every request so we can tell whether the browser is talking to us."""
    stamp = datetime.now().strftime("%H:%M:%S")
    with ACCESS.open("a", encoding="utf-8") as fh:
        fh.write(f"{stamp} {line}\n")


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
                continue
            if msg.get("id", 0) > since:
                out.append(msg)
    return out


def append_message(role, text, session=None, to=None):
    # LOCK guards threads inside this process; flock guards the other processes
    # writing the same log (the web server and reply.py).
    with LOCK, LOG.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        existing = read_messages()
        # High-water mark survives truncation of chat.jsonl, so ids never repeat
        # and a page that is already open keeps polling correctly after a wipe.
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
            "ts": datetime.now().isoformat(timespec="seconds"),
        }
        # which Claude session produced this reply; absent on user messages and on
        # anything written before 2026-09-25, so the page must tolerate it missing
        if session:
            msg["session"] = session
        # addressed to ONE session's watcher; absent means "whoever is listening"
        if to:
            msg["to"] = to
        handle.write(json.dumps(msg, ensure_ascii=False) + "\n")
        handle.flush()
        fcntl.flock(handle, fcntl.LOCK_UN)
    # a new message ends whatever the last one was waiting for: the reply supersedes its
    # own progress notes, and a new question's notes have not been written yet
    clear_status()
    return msg


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        access(f"{self.client_address[0]} {fmt % args}")

    def _send(self, code, body, ctype):
        payload = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False), "application/json; charset=utf-8")

    def do_GET(self):
        url = urlparse(self.path)
        if url.path in ("/", "/index.html", "/chat.html"):
            if not PAGE.exists():
                return self._send(404, "chat.html is missing", "text/plain; charset=utf-8")
            html = PAGE.read_text(encoding="utf-8").replace("__BUILD__", build_id())
            return self._send(200, html, "text/html; charset=utf-8")
        if url.path == "/api/sessions":
            return self._json(200, {"sessions": session_labels(), "watchers": watchers()})
        if url.path == "/api/messages":
            try:
                since = int(parse_qs(url.query).get("since", ["0"])[0])
            except ValueError:
                since = 0
            msgs = read_messages(since)
            last = msgs[-1]["id"] if msgs else since
            return self._json(200, {"messages": msgs, "last": last, "build": build_id(),
                                    "status": read_status(), "watch": watch_age(),
                                    "watchers": watchers()})
        return self._send(404, "not found", "text/plain; charset=utf-8")

    def do_POST(self):
        if urlparse(self.path).path != "/api/send":
            return self._send(404, "not found", "text/plain; charset=utf-8")
        length = int(self.headers.get("Content-Length") or 0)
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._json(400, {"error": "bad json"})
        text = (data.get("text") or "").strip()
        if not text:
            return self._json(400, {"error": "empty message"})
        to = (data.get("to") or "").strip()
        return self._json(200, append_message("user", text, to=to or None))


if __name__ == "__main__":
    LOG.touch(exist_ok=True)
    # 8000 is everybody's default; this panel is long-lived, so it sits out of the way.
    port = int(os.environ.get("CONTROL_ROOM_PORT", "8111"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"chat bridge on http://localhost:{port}  ->", LOG)
    server.serve_forever()
