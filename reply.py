#!/usr/bin/env python3
"""Post a reply into the browser chat: python3 reply.py "your text"

Reads from stdin when no argument is given, so multi-line replies work:
    python3 reply.py <<'EOF'
    line one
    line two
    EOF
"""
import sys

from chat_server import append_message

text = " ".join(sys.argv[1:]).strip() or sys.stdin.read().strip()
if not text:
    sys.exit("nothing to send")
msg = append_message("assistant", text)
print(f"sent #{msg['id']}")
