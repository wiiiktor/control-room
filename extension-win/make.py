#!/usr/bin/env python3
"""Build the Windows extension FROM the posix one, by patching a copy.

⛔ A FORK WOULD ROT. Fourteen builds of chat.html shipped in one day; a hand-copied Windows
extension would have missed every one of them and the two panels would drift until nobody could
say which behaviour belonged to which. So this is a GENERATOR: `extension/` stays the one source
of truth, and the Windows build is derived from it every time.

⛔ EVERY PATCH ASSERTS THAT IT APPLIED. When the shared source moves under a patch, this fails at
build time and names the patch — which is the entire reason a generator beats a fork. A silent
miss would produce a Windows build that looks fine and is stale in one specific place.

⛔ AND IT NEVER WRITES TO extension/. The posix extension is not touched, not imported, not
re-exported. That is the zero-risk guarantee, and it is structural rather than a promise.

What differs on Windows, all of it measured against the code rather than assumed:

  chatlog.py imports fcntl        no fcntl in Windows Python -> reply.py, status.py and the
                                  mirror hook all die on the import line
  hooks say `python3 <script>`    Windows ships `python` and `py`, not `python3`
  the watch is `tail -F | ...`    there is no tail in PowerShell or cmd

  python3 make.py [--out build]
"""
import argparse, json, os, re, shutil, sys
from pathlib import Path

HERE = Path(__file__).absolute().parent
SRC = HERE.parent / "extension"
ROOM = HERE.parent


class Patch:
    def __init__(self):
        self.applied = []

    def sub(self, path, old, new, count=1, why=""):
        """Replace `old` with `new` exactly `count` times, or fail loudly."""
        t = path.read_text()
        n = t.count(old)
        if n != count:
            sys.exit(f"⛔ PATCH MISSED in {path.name}: expected {count} occurrence(s) of\n"
                     f"    {old[:110]!r}\n  found {n}. The shared source has moved; update make.py.\n"
                     f"  (patch: {why})")
        path.write_text(t.replace(old, new))
        self.applied.append(f"{path.name}: {why}")


LOCK_SHIM = '''import os as _os

# ⛔ WINDOWS HAS NO fcntl. This shim is the whole reason the Windows build exists: `import fcntl`
# is the first line reply.py, status.py and the mirror hook all reach, and it raises before any of
# them can do anything. msvcrt.locking is the Windows equivalent -- byte-range rather than
# whole-file, so it locks one byte at offset 0, which is the conventional stand-in for flock.
if _os.name == "nt":
    import msvcrt

    def _lock_ex(fh):
        fh.seek(0)
        while True:
            try:
                msvcrt.locking(fh.fileno(), msvcrt.LK_LOCK, 1)
                return
            except OSError:
                # LK_LOCK already retries for ten seconds; past that, wait rather than lose a write
                import time as _t
                _t.sleep(0.1)

    def _unlock(fh):
        fh.seek(0)
        try:
            msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
else:
    import fcntl

    def _lock_ex(fh):
        fcntl.flock(fh, fcntl.LOCK_EX)

    def _unlock(fh):
        fcntl.flock(fh, fcntl.LOCK_UN)
'''

FOLLOW = '''

def _follow(path):
    """Tail a file by byte offset, in place of `tail -F` -- which Windows does not have.

    ⛔ IT MUST SURVIVE A ROTATION, and it must not replay history when it does. The file is re-read
    from zero whenever it SHRINKS (truncated or replaced), and the SEEN high-water guard below is
    what stops that turning eleven old questions into eleven new ones. That guard already existed
    for exactly this case under `tail -F`; here it is load-bearing.
    """
    import io
    p = Path(path)
    off = p.stat().st_size if p.exists() else 0      # start at the END, like `tail -n0`
    buf = ""
    while True:
        try:
            size = p.stat().st_size if p.exists() else 0
        except OSError:
            size = 0
        if size < off:                                # rotated or truncated
            off, buf = 0, ""
        if size > off:
            with io.open(p, "r", encoding="utf-8", errors="replace") as fh:
                fh.seek(off)
                chunk = fh.read()
                off = fh.tell()
            buf += chunk
            while "\\n" in buf:
                line, buf = buf.split("\\n", 1)
                yield line
        time.sleep(0.4)
'''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(HERE / "build"))
    A = ap.parse_args()
    out = Path(A.out)

    if not SRC.is_dir():
        sys.exit(f"⛔ {SRC} is not there — run this from the repo")
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(SRC, out, ignore=shutil.ignore_patterns("*.vsix", "node_modules", "build"))
    # the room's python, copied in exactly as extension/build.sh does it
    (out / "runtime").mkdir(exist_ok=True)
    for f in ("chatlog.py", "reply.py", "status.py", "watch.py", "request.py"):
        shutil.copy(ROOM / f, out / "runtime" / f)

    P = Patch()

    # ---- 1. locking ------------------------------------------------------------------------
    cl = out / "runtime" / "chatlog.py"
    # ⛔ CALL SITES FIRST, SHIM LAST. The shim itself contains `fcntl.flock(fh, fcntl.LOCK_EX)` --
    # inserting it before the call-site patches made that patch find TWO occurrences and refuse,
    # which is the assertion doing its job on the generator rather than on the source.
    P.sub(cl, "fcntl.flock(handle, fcntl.LOCK_EX)", "_lock_ex(handle)",
          why="append_message takes the lock through the shim")
    P.sub(cl, "fcntl.flock(handle, fcntl.LOCK_UN)", "_unlock(handle)",
          why="append_message releases through the shim")
    P.sub(cl, "fcntl.flock(fh, fcntl.LOCK_EX)", "_lock_ex(fh)",
          why="add_status takes the lock through the shim")
    P.sub(cl, "import fcntl\n", LOCK_SHIM, why="fcntl -> msvcrt on Windows")

    # ---- 2. the watch follows the file itself -----------------------------------------------
    w = out / "runtime" / "watch.py"
    P.sub(w, "catch_up()\n\nfor line in sys.stdin:",
          FOLLOW + "\n\ncatch_up()\n\n_src = None\nfor i, a in enumerate(sys.argv):\n"
                   "    if a == \"--follow\" and i + 1 < len(sys.argv):\n"
                   "        _src = sys.argv[i + 1]\n"
                   "for line in (_follow(_src) if _src else sys.stdin):",
          why="--follow <file> replaces the tail -F pipe")

    # ---- 3. the interpreter ------------------------------------------------------------------
    h = out / "src" / "hook.js"
    P.sub(h, "const rules = ['Bash(tail -n0 -F chat.jsonl)', 'Bash(python3 -u watch.py)', 'Bash(python3 watch.py)'];",
          "const rules = [`Bash(${PY} -u watch.py:*)`, `Bash(${PY} watch.py:*)`];",
          why="permission rules follow the resolved interpreter, and no tail")
    P.sub(h, 'f"  command: cd {mine} && tail -n0 -F chat.jsonl | python3 -u watch.py",',
          'f"  command: cd {mine} && PYEXE -u watch.py --follow chat.jsonl",',
          why="the watch command Claude is told to run")
    for i, (old, new, why) in enumerate((
        ("`python3 ${script}`", "`${PY} ${script}`", "SessionStart hook command"),
        ("`python3 ${mirror}`", "`${PY} ${mirror}`", "mirror hook command"),
        ("`Bash(python3 ${u}${f}:*)`, `Bash(python3 ${u}${path.join(room, f)}:*)`",
         "`Bash(${PY} ${u}${f}:*)`, `Bash(${PY} ${u}${path.join(room, f)}:*)`",
         "per-script permission rules"),
    )):
        P.sub(h, old, new, count=(2 if "${script}" in old else 1), why=why)
    # PY is resolved once, at the top of the module
    P.sub(h, "const path = require('path');",
          "const path = require('path');\n"
          "// ⛔ WINDOWS SHIPS `python` AND `py`, NOT `python3`. Everything this module writes into\n"
          "// settings.json -- hook commands and permission rules alike -- has to name an\n"
          "// interpreter that exists, or the hooks never run and the rules never match.\n"
          "const PY = (() => {\n"
          "  const cp = require('child_process');\n"
          "  for (const exe of ['python', 'py', 'python3']) {\n"
          "    try { cp.execFileSync(exe, ['-c', 'pass'], { stdio: 'ignore' }); return exe; }\n"
          "    catch { /* next */ }\n"
          "  }\n"
          "  return 'python';\n"
          "})();",
          why="resolve the interpreter once")
    # the python heredoc in hook.js prints the watch line; PYEXE is substituted there
    P.sub(h, 'f"  command: cd {mine} && PYEXE -u watch.py --follow chat.jsonl",',
          'f"  command: cd {mine} && " + PYEXE + " -u watch.py --follow chat.jsonl",',
          why="PYEXE is a python name in the generated script, not an f-string field")
    # ⚠️ AFTER the shebang, not before it. A shebang only counts on line 1, and putting the
    # assignment first left every generated script with a decorative comment where its interpreter
    # line used to be. sys.executable is the full path of the python actually running the hook,
    # which is precisely the one Claude should be told to use.
    P.sub(h, "return `#!/usr/bin/env python3\n",
          "return `#!/usr/bin/env python3\nPYEXE = __import__('sys').executable\n",
          count=2, why="the generated hook scripts learn their own interpreter")

    # ---- 4. identity -------------------------------------------------------------------------
    pj = json.loads((out / "package.json").read_text())
    pj["name"] = "control-room-win"
    pj["displayName"] = "Control Room (Windows)"
    pj["description"] = ((pj.get("description") or "") + " Windows build, generated from the "
                         "posix extension by extension-win/make.py.").strip()
    (out / "package.json").write_text(json.dumps(pj, indent=2) + "\n")

    print(f"built {out}  ({len(P.applied)} patches)")
    for a in P.applied:
        print("  •", a)
    print("\nnow:  cd", out, "&& vsce package --allow-missing-repository")


if __name__ == "__main__":
    main()
