#!/usr/bin/env python3
"""Clear the two stale session references that make the Claude extension exit 1 on open.

⛔ RUN THIS WITH VS CODE CLOSED. state.vscdb is SQLite that VS Code holds open and rewrites from its
own memory, so an edit made underneath a running window is either discarded or corrupts the file.
The script refuses to run while a VS Code process is alive, and writes a backup first.

What it clears, and why each one breaks the extension:
  Anthropic.claude-code -> panelTabSessions
      an editor tab remembering a session that now runs as a BACKGROUND session; a tab cannot
      attach to one, so the process it starts exits 1.
  memento/webviewView.claudeVSCodeSidebarSecondary -> sessionID
      the sidebar remembering a session whose transcript has been deleted; same exit.

Neither holds any conversation: the transcripts live in ~/.claude/projects and are untouched.
"""
import json, os, shutil, sqlite3, subprocess, sys, glob

KEYS = {
    "Anthropic.claude-code": "panelTabSessions",
    "memento/webviewView.claudeVSCodeSidebarSecondary": "sessionID",
}

def vscode_running():
    # ⛔ macOS pgrep has no -a, so the Linux check below found nothing on a Mac and reported VS
    # Code as closed while it was open -- the one condition this script must never get wrong.
    if sys.platform == "darwin":
        r = subprocess.run(["pgrep", "-f", "Visual Studio Code.app/Contents/MacOS/"],
                           capture_output=True, text=True)
        return r.returncode == 0
    try:
        out = subprocess.run(["pgrep", "-af", "code"], capture_output=True, text=True).stdout
    except Exception:
        return False
    for line in out.splitlines():
        if ("/usr/share/code/code" in line or line.endswith("/code") or " --type=renderer" in line
                or "Visual Studio Code.app/Contents/MacOS/" in line):
            return True
    return False

def main():
    # macOS keeps VS Code's state under Application Support; Linux under ~/.config
    base = ("~/Library/Application Support/Code" if sys.platform == "darwin" else "~/.config/Code")
    dbs = sorted(glob.glob(os.path.expanduser(base + "/User/workspaceStorage/*/state.vscdb")))
    if not dbs:
        print("no workspaceStorage databases found"); return 1
    if vscode_running() and "--force" not in sys.argv:
        print("VS Code is running. Close it and run this again, or pass --force if you are sure.")
        return 2
    touched = 0
    for db in dbs:
        con = sqlite3.connect(db)
        rows = dict(con.execute("select key, value from ItemTable").fetchall())
        changes = {}
        for key, field in KEYS.items():
            raw = rows.get(key)
            if raw is None or field not in str(raw):
                continue
            try:
                d = json.loads(raw)
            except Exception:
                continue
            if key == "Anthropic.claude-code":
                if d.get("panelTabSessions"):
                    print(db.split("/")[-2], "panelTabSessions ->",
                          [s.get("sessionId", "")[:8] for s in d["panelTabSessions"]], "cleared")
                    d["panelTabSessions"] = []
                    changes[key] = json.dumps(d)
            else:
                ws = d.get("webviewState")
                if isinstance(ws, str) and "sessionID" in ws:
                    try:
                        inner = json.loads(ws)
                    except Exception:
                        inner = None
                    if inner and inner.get("sessionID"):
                        print(db.split("/")[-2], "sidebar sessionID ->",
                              inner["sessionID"][:8], "cleared")
                        inner.pop("sessionID", None)
                        inner.pop("sessionUpdatedAt", None)
                        d["webviewState"] = json.dumps(inner)
                        changes[key] = json.dumps(d)
        if changes:
            shutil.copy2(db, db + ".before-clear")
            for k, v in changes.items():
                con.execute("update ItemTable set value = ? where key = ?", (v, k))
            con.commit()
            touched += 1
        con.close()
    print("databases changed:", touched,
          "\nbackups written next to each as .before-clear" if touched else "\nnothing to clear")
    return 0

if __name__ == "__main__":
    sys.exit(main())
