#!/usr/bin/env python3
"""Ask the Control Room extension to do something only VS Code can do.

    python3 request.py open-in-claude <session-id>    open that conversation in the Claude window
    python3 request.py close-claude-tab [<session-id>] close the Claude tab(s) -- one conversation's, or all

A session in the room cannot reach VS Code; the extension can, and it checks every room for a
request once a second. The request is a file, written whole and renamed into place, so the
extension never reads half of one. Waits up to 10 s for the answer and prints it.
"""
import json
import os
import sys
import time
from pathlib import Path

_HERE = Path(sys.argv[0]).absolute().parent
ROOM = Path(os.environ.get("CONTROL_ROOM_DIR") or _HERE)
ACTIONS = {"open-in-claude", "close-claude-tab"}


def main(argv):
    if len(argv) < 2 or argv[1] not in ACTIONS:
        sys.exit("usage: request.py {%s} [session-id]" % "|".join(sorted(ACTIONS)))
    req = {"action": argv[1], "session": argv[2] if len(argv) > 2 else "", "id": "%d-%d" % (time.time() * 1000, os.getpid())}
    tmp = ROOM / (".request.%s.tmp" % req["id"])
    tmp.write_text(json.dumps(req))
    tmp.rename(ROOM / (".request.%s" % req["id"]))
    done = ROOM / (".request.%s.done" % req["id"])
    for _ in range(100):
        if done.exists():
            print(done.read_text().strip())
            done.unlink()
            return 0
        time.sleep(0.1)
    print("no answer: is the Control Room extension running in a VS Code window on this workspace?")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
