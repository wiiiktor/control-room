#!/usr/bin/env python3
"""Post a reply into the browser chat: python3 reply.py "your text"

Reads from stdin when no argument is given, so multi-line replies work:
    python3 reply.py <<'EOF'
    line one
    line two
    EOF
"""
import os
import re
import sys
from pathlib import Path

# ⛔ A SYMLINKED COPY IMPORTS THE ORIGINAL. Python puts the script's RESOLVED directory on
# sys.path, so running this from an instance folder of symlinks imported chatlog from
# the ORIGINAL folder -- and replies went into the wrong panel's log. Pin the directory
# this script was invoked from before importing anything.
_HERE = Path(sys.argv[0]).absolute().parent
os.environ.setdefault("CONTROL_ROOM_DIR", str(_HERE))
sys.path.insert(0, str(_HERE))

from chatlog import append_message


def session_id():
    """Which Claude Code session wrote this reply.

    CLAUDE_SESSION_ID if the harness exports it; otherwise the most recently written
    transcript for this project, which is the live session by definition. Returns None
    rather than guessing when neither is available — a wrong id is worse than no id.
    """
    # ⭐ Claude Code exports its own id. Read it: the "newest transcript" fallback below
    # is WRONG whenever another session is active -- a resumed session writing to its
    # transcript made this watcher believe it WAS that session, so it answered mail
    # addressed to it.
    for key in ("CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID"):
        env = (os.environ.get(key) or "").strip()
        if env:
            return env
    d = Path.home() / ".claude" / "projects" / "-home-wii-Projects-certain"
    root = Path(__file__).resolve().parent
    try:
        cand = sorted(d.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        return None
    for p in cand:
        if not (root / (".resume." + p.stem)).exists():
            return p.stem
    return cand[0].stem if cand else None

DIRECTIVES = ("ask", "say", "note", "kv", "ok", "warn", "err", "wait", "pick",
              "fill", "chart", "html", "endhtml", "card", "endcard")

REMINDER = """\
\033[1;31m⛔ REFUSED: this reply is not written in CTRL markup.\033[0m

The panel is not a Markdown chat. A reply with no `::` line renders as a wall of
plain text: no headline, no stat boxes, no buttons, and `#`/`-`/`|` land literally.

  ::say   the one-sentence answer        ::ok / ::warn / ::err   coloured pill
  ::ask   the question to decide         ::kv <key> = <value>    stat box
  ::note  the small grey detail          ::pick <label>          button
  ::card <title> … ::endcard             ::html … ::endhtml      escape hatch

Full spec: %s

Rewrite it with directives, or -- if plain text really is what you want --
re-run with \033[1m--plain\033[0m (or CTRL_PLAIN=1).
"""

def check_markup(text):
    """A reply with no directive is almost always Markdown written out of habit.

    ⛔ THIS GUARD EXISTS BECAUSE THE HABIT IS STRONGER THAN THE MEMORY. Every session
    reads MARKUP.md and then answers in Markdown anyway, because Markdown is what a
    chat looks like. A rule nobody is stopped by is not a rule -- so the send itself
    refuses, and the refusal carries the cheat sheet.
    """
    lines = [l for l in text.splitlines() if l.strip()]
    if any(l.lstrip().startswith("::") for l in lines):
        return                                     # markup is present; nothing to say
    md = [l for l in lines if re.match(r"^\s*([-*+]\s|\d+[.)]\s|#{1,6}\s|>\s|\|)", l)]
    sys.stderr.write(REMINDER % (_HERE / "MARKUP.md"))
    if md:
        sys.stderr.write("\nMarkdown seen on %d line(s), e.g.: %s\n"
                         % (len(md), md[0].strip()[:70]))
    sys.exit(3)

argv = [a for a in sys.argv[1:] if a not in ("--plain", "-p")]
plain = len(argv) != len(sys.argv[1:]) or os.environ.get("CTRL_PLAIN") == "1"

text = " ".join(argv).strip() or sys.stdin.read().strip()
if not text:
    sys.exit("nothing to send")
if not plain:
    check_markup(text)
msg = append_message("assistant", text, session=session_id())
print(f"sent #{msg['id']}")
