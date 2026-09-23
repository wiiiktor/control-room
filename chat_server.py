#!/usr/bin/env python3
"""Tiny chat bridge: browser page <-> chat.jsonl <-> Claude Code.

GET  /                       -> chat.html
GET  /api/messages?since=N   -> {"messages": [...], "last": N}
POST /api/send  {"text":...} -> appends a user message to chat.jsonl
"""
import fcntl
import json
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent
LOG = ROOT / "chat.jsonl"
PAGE = ROOT / "chat.html"
ACCESS = ROOT / "access.log"
SEQ = ROOT / ".seq"
LOCK = threading.Lock()


def build_id():
    """Version of the page currently on disk; an open page reloads when it changes."""
    try:
        return str(int(PAGE.stat().st_mtime))
    except OSError:
        return "0"


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


def append_message(role, text):
    # LOCK guards threads inside this process; flock guards the other processes
    # writing the same log (the web server, reply.py and the Telegram bot).
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
        handle.write(json.dumps(msg, ensure_ascii=False) + "\n")
        handle.flush()
        fcntl.flock(handle, fcntl.LOCK_UN)
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
        if url.path == "/api/messages":
            try:
                since = int(parse_qs(url.query).get("since", ["0"])[0])
            except ValueError:
                since = 0
            msgs = read_messages(since)
            last = msgs[-1]["id"] if msgs else since
            return self._json(200, {"messages": msgs, "last": last, "build": build_id()})
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
        return self._json(200, append_message("user", text))


if __name__ == "__main__":
    LOG.touch(exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 8000), Handler)
    print("chat bridge on http://localhost:8000  ->", LOG)
    server.serve_forever()
