#!/usr/bin/env python3
"""List this project's Claude Code sessions: id, when, size, and what it opened with.

    python3 sessions.py            # newest first
    python3 sessions.py --all      # every session, not just the last 20

⚠️ Claude Code does NOT give a session a name. What looks like a title in the VS Code
picker is the opening message, so that is what this prints. A `summary` line exists in
some transcripts (written when a session is compacted) and is preferred when present.
"""
import argparse
import json
import time
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--all", action="store_true")
ap.add_argument("--project", default="-home-wii-Projects-certain")
ap.add_argument("--json", action="store_true")
A = ap.parse_args()

D = Path.home() / ".claude" / "projects" / A.project
rows = []
for p in sorted(D.glob("*.jsonl"), key=lambda q: q.stat().st_mtime, reverse=True):
    first = summary = None
    n = 0
    with p.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            n += 1
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            if summary is None and d.get("type") == "summary":
                summary = d.get("summary")
            if first is None and d.get("message", {}).get("role") == "user":
                c = d["message"].get("content")
                first = c if isinstance(c, str) else (
                    c[0].get("text", "") if isinstance(c, list) and c else "")
    rows.append({
        "id": p.stem,
        "modified": time.strftime("%Y-%m-%d %H:%M", time.localtime(p.stat().st_mtime)),
        "lines": n,
        "mb": round(p.stat().st_size / 1e6, 1),
        "opened_with": " ".join((summary or first or "").split())[:120] or "(empty)",
    })

if not A.all:
    rows = rows[:20]
if A.json:
    print(json.dumps(rows, indent=1))
else:
    for r in rows:
        print(f"{r['id'][:8]}  {r['modified']}  {r['lines']:>7,} lines  {r['mb']:>6.1f} MB  {r['opened_with']}")
