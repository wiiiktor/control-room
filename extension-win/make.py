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

What differs on Windows, all of it measured on a Windows 11 machine rather than assumed:

  chatlog.py imports fcntl        no fcntl in Windows Python -> reply.py, status.py and the
                                  mirror hook all die on the import line
  msvcrt locks are MANDATORY      locking byte 0 made the lock-holder's own read of chat.jsonl
                                  fail with PermissionError; the lock now sits past EOF
  stdio is cp1250/cp1252          a ⛔ or an emoji killed reply.py and watch.py; Polish text
                                  piped in arrived as mojibake; hook stdin JSON likewise
  hooks say `python3 <script>`    Windows ships `python` and `py`, not `python3`
  hook paths lose backslashes     Claude Code runs hooks through Git Bash: `python C:\\Users\\..`
                                  became `python C:Users..`; paths are quoted, forward-slashed
  the watch is `tail -F | ...`    there is no tail in PowerShell or cmd
  `claude` is claude.exe/.cmd     the extensionless `claude` beside claude.cmd is an sh script
                                  Windows cannot start; spawn and shellPath need the real .exe
  trust keys are `C:/Users/..`    VS Code says `c:\\Users\\..`; the preflight never matched and
                                  grantTrust wrote a key Claude Code never reads
  project slugs drop the colon    `C:\\Users\\HP` is `C--Users-HP`; `:` was kept, so session
                                  labels and the watch's session fallback found nothing

  python make.py [--out build]
"""
import argparse, json, os, re, shutil, sys
from pathlib import Path

HERE = Path(__file__).absolute().parent
SRC = HERE.parent / "extension"
ROOM = HERE.parent


# ⛔ EXPLICIT UTF-8, EXPLICIT \n. Path.read_text() on a Polish Windows is cp1250, and the first ⛔
# in the source killed the generator before it built anything. newline="" keeps LF endings: the
# default text mode would have rewritten every generated file as CRLF.
#
# ⛔ AND LF ON THE WAY IN. Git for Windows checks out with core.autocrlf=true, so the source arrives
# CRLF, and every patch spanning a line break "found 0" and refused. The build is LF throughout.
def rd(p):
    with open(p, encoding="utf-8", newline="") as fh:
        return fh.read().replace("\r\n", "\n")


def wr(p, text):
    with open(p, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


class Patch:
    def __init__(self):
        self.applied = []

    def sub(self, path, old, new, count=1, why=""):
        """Replace `old` with `new` exactly `count` times, or fail loudly."""
        t = rd(path)
        n = t.count(old)
        if n != count:
            sys.exit(f"⛔ PATCH MISSED in {path.name}: expected {count} occurrence(s) of\n"
                     f"    {old[:110]!r}\n  found {n}. The shared source has moved; update make.py.\n"
                     f"  (patch: {why})")
        wr(path, t.replace(old, new))
        self.applied.append(f"{path.name}: {why}")


LOCK_SHIM = '''import os as _os

# ⛔ WINDOWS HAS NO fcntl. This shim is the whole reason the Windows build exists: `import fcntl`
# is the first line reply.py, status.py and the mirror hook all reach, and it raises before any of
# them can do anything.
#
# ⛔ AND msvcrt LOCKS ARE MANDATORY, NOT ADVISORY. Locking byte 0 -- the conventional flock
# stand-in -- stopped every OTHER handle from reading that byte, and append_message reads the log
# through a second handle while it holds the lock: reply.py died with PermissionError on its own
# lock. The lock is taken on one byte far past EOF instead, where no reader ever goes. Writes are
# unaffected: the handle is in append mode, so the OS puts every write at the real end.
if _os.name == "nt":
    import msvcrt
    import time as _t

    _LOCK_AT = 0x7FFFFFF0

    def _lock_ex(fh):
        fh.flush()
        while True:
            _os.lseek(fh.fileno(), _LOCK_AT, 0)
            try:
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
                return
            except OSError:
                _t.sleep(0.05)              # another writer holds it; they are milliseconds

    def _unlock(fh):
        try:
            fh.flush()
            _os.lseek(fh.fileno(), _LOCK_AT, 0)
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

STDIO = '''from pathlib import Path

# ⛔ WINDOWS STDIO IS THE ANSI CODE PAGE, NOT UTF-8. cp1250 on a Polish machine: the first ⛔ this
# script printed, or the first emoji in a message it relayed, raised UnicodeEncodeError and killed
# it -- and a reply piped in through a heredoc arrived as mojibake. Every stream is UTF-8 here.
# stdin as utf-8-SIG: PowerShell pipes open with a byte-order mark, and a reply sent that way
# reached the panel starting with an invisible U+FEFF.
for _s, _enc in ((sys.stdin, "utf-8-sig"), (sys.stdout, "utf-8"), (sys.stderr, "utf-8")):
    try:
        _s.reconfigure(encoding=_enc, errors="replace")
    except (AttributeError, ValueError):
        pass
'''

FOLLOW = '''

def _follow(path):
    """Tail a file by byte offset, in place of `tail -F` -- which Windows does not have.

    ⛔ IT MUST SURVIVE A ROTATION, and it must not replay history when it does. The file is re-read
    from zero whenever it SHRINKS (truncated or replaced), and the SEEN high-water guard below is
    what stops that turning eleven old questions into eleven new ones. That guard already existed
    for exactly this case under `tail -F`; here it is load-bearing.

    ⛔ BYTES, NOT TEXT. A text-mode read that ends inside a multi-byte character (ą, ł, an emoji)
    decodes half of it as garbage. Only whole lines are decoded, and a line is whole at a newline byte.
    The file is opened per poll and closed again, so a rename or delete by the extension is never
    blocked by this process holding it open -- on Windows an open handle would have.
    """
    p = Path(path)
    try:
        off = p.stat().st_size                        # start at the END, like `tail -n0`
    except OSError:
        off = 0
    buf = b""
    while True:
        try:
            size = p.stat().st_size
        except OSError:
            size = 0
        if size < off:                                # rotated or truncated
            off, buf = 0, b""
        if size > off:
            try:
                with open(p, "rb") as fh:
                    fh.seek(off)
                    chunk = fh.read()
                    off = fh.tell()
            except OSError:
                chunk = b""
            buf += chunk
            while b"\\n" in buf:
                line, buf = buf.split(b"\\n", 1)
                yield line.decode("utf-8", errors="replace")
        time.sleep(0.4)
'''

# resolved once in hook.js, and used by everything it writes into settings.json
HOOK_HEAD = r"""const path = require('path');
// ⛔ WINDOWS SHIPS `python` AND `py`, NOT `python3` -- and `python3` may be the Microsoft Store
// alias, which exists and does nothing. Everything this module writes into settings.json -- hook
// commands and permission rules alike -- has to name an interpreter that runs, or the hooks never
// run and the rules never match.
const PY = (() => {
  const cp = require('child_process');
  for (const exe of ['python', 'py', 'python3']) {
    try { cp.execFileSync(exe, ['-c', 'pass'], { stdio: 'ignore', timeout: 5000 }); return exe; }
    catch { /* next */ }
  }
  return 'python';
})();
// ⛔ CLAUDE CODE RUNS HOOK COMMANDS THROUGH GIT BASH ON WINDOWS. An unquoted C:\Users\... lost every
// backslash to the shell and the hook ran `python C:Users...` -- which does not exist, silently.
// Forward slashes and double quotes work in bash and in cmd alike.
const fwd = p => String(p).replace(/\\/g, '/');
const Q = p => JSON.stringify(fwd(p));
/** Rewrite every command that runs one of OUR scripts into the form that works here -- including
 *  entries an earlier build wrote, which the "already installed" checks would otherwise keep. */
function fixCmds(settings) {
  for (const list of Object.values(settings.hooks || {})) {
    for (const g of (Array.isArray(list) ? list : [])) {
      for (const h of (g.hooks || [])) {
        const c = String(h.command || '');
        if (!c.includes('control-room-watch.py') && !c.includes('control-room-mirror.py')) continue;
        const script = c.replace(/^\s*\S+\s+/, '').trim().replace(/^["']|["']$/g, '');
        h.command = `${PY} ${Q(script)}`;
      }
    }
  }
}"""

BRIDGE_RULES_OLD = r"""  const rules = ['Bash(tail -n0 -F chat.jsonl)', 'Bash(python3 -u watch.py)', 'Bash(python3 watch.py)'];
  for (const f of ['reply.py', 'status.py', 'request.py']) {
    for (const u of ['', '-u ']) {
      rules.push(`Bash(python3 ${u}${f}:*)`, `Bash(python3 ${u}${path.join(room, f)}:*)`);
    }
  }"""

BRIDGE_RULES_NEW = r"""  // the watch as the SessionStart hook tells Claude to run it, and the scripts in every spelling a
  // session types on Windows: bare, native backslashes, forward slashes, and either kind of quotes
  const rules = [`Bash(${PY} -u watch.py:*)`, `Bash(${PY} watch.py:*)`];
  for (const f of ['reply.py', 'status.py', 'request.py']) {
    const p = path.join(room, f);
    for (const u of ['', '-u ']) {
      for (const s of [f, p, fwd(p), `'${fwd(p)}'`, `"${fwd(p)}"`]) {
        rules.push(`Bash(${PY} ${u}${s}:*)`);
      }
    }
  }"""

FIND_CLAUDE_OLD = """    const p = path.join(d, 'claude');
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* not here */ }"""

FIND_CLAUDE_NEW = """    // ⛔ ON WINDOWS `claude` IS NOT THE PROGRAM. An npm install puts an extensionless sh script
    // named `claude` beside claude.cmd; X_OK means nothing here, so that script was "found", and
    // spawn() and shellPath both failed on it. The real binary is claude.exe -- on the PATH for the
    // native installer, and behind the npm shim for an npm install. A .cmd is never returned:
    // spawn() refuses to start one without a shell.
    for (const p of [path.join(d, 'claude.exe'),
                     path.join(d, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')]) {
      try {
        fs.accessSync(p, fs.constants.F_OK);
        return p;
      } catch { /* not here */ }
    }"""

TRUST_KEY = """// ⛔ CLAUDE CODE KEYS TRUST BY `C:/Users/HP`, and VS Code hands us `c:\\\\Users\\\\HP`. Compared as they
// came, no folder was ever trusted, and grantTrust wrote a key Claude Code never reads -- so the
// hidden terminal it had just cleared stopped on the trust question anyway.
const tkey = p => String(p).replace(/\\\\/g, '/').replace(/^[a-z]:/, m => m.toUpperCase());

function trusted(cwd) {"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(HERE / "build"))
    A = ap.parse_args()
    out = Path(A.out)

    if not SRC.is_dir():
        sys.exit(f"⛔ {SRC} is not there — run this from the repo")
    # ⛔ EMPTY IT, DO NOT DELETE IT. Windows refuses to remove a folder that is any process's
    # working directory -- a terminal left in build/ failed the whole build with WinError 32.
    if out.exists():
        for p in out.iterdir():
            shutil.rmtree(p) if p.is_dir() else p.unlink()
    shutil.copytree(SRC, out, ignore=shutil.ignore_patterns("*.vsix", "node_modules", "build"),
                    dirs_exist_ok=True)
    # the room's python, copied in exactly as extension/build.sh does it
    (out / "runtime").mkdir(exist_ok=True)
    for f in ("chatlog.py", "reply.py", "status.py", "watch.py", "request.py"):
        shutil.copy(ROOM / f, out / "runtime" / f)
    for p in out.rglob("*"):
        if p.is_file() and p.suffix in (".py", ".js", ".html", ".json", ".md", ".sh", ""):
            try:
                wr(p, rd(p))
            except UnicodeDecodeError:
                pass                                  # binary without an extension: leave it

    P = Patch()
    rt = out / "runtime"

    # ---- 1. locking ------------------------------------------------------------------------
    cl = rt / "chatlog.py"
    # ⛔ CALL SITES FIRST, SHIM LAST. The shim itself contains `fcntl.flock(fh, fcntl.LOCK_EX)` --
    # inserting it before the call-site patches made that patch find TWO occurrences and refuse,
    # which is the assertion doing its job on the generator rather than on the source.
    P.sub(cl, "fcntl.flock(handle, fcntl.LOCK_EX)", "_lock_ex(handle)",
          why="append_message takes the lock through the shim")
    P.sub(cl, "fcntl.flock(handle, fcntl.LOCK_UN)", "_unlock(handle)",
          why="append_message releases through the shim")
    P.sub(cl, "        fcntl.flock(fh, fcntl.LOCK_EX)\n        fh.write(line.strip() + \"\\n\")",
          "        _lock_ex(fh)\n        fh.write(line.strip() + \"\\n\")\n        _unlock(fh)",
          why="add_status locks through the shim, and lets go")
    P.sub(cl, "import fcntl\n", LOCK_SHIM, why="fcntl -> msvcrt, locked past EOF")

    # ---- 2. utf-8 stdio in every script a session runs ---------------------------------------
    for f in ("reply.py", "status.py", "watch.py", "request.py"):
        P.sub(rt / f, "from pathlib import Path\n", STDIO, why="stdio is UTF-8, not the ANSI code page")
    P.sub(rt / "request.py", "tmp.write_text(json.dumps(req))", "tmp.write_text(json.dumps(req), encoding=\"utf-8\")",
          why="request file written as UTF-8")
    P.sub(rt / "request.py", "print(done.read_text().strip())", "print(done.read_text(encoding=\"utf-8\").strip())",
          why="answer read as UTF-8")

    # ---- 3. project slugs: every non-alphanumeric is a dash, the drive colon included ----------
    P.sub(rt / "watch.py", '    slug = str(ROOT.parent).replace("/", "-").replace("\\\\", "-")\n',
          '    slug = "".join(c if c.isascii() and c.isalnum() else "-" for c in str(ROOT.parent))\n',
          why="C:\\Users\\HP is C--Users-HP")
    P.sub(rt / "reply.py", '    d = Path.home() / ".claude" / "projects" / "-home-wii-Projects-certain"\n',
          '    d = Path.home() / ".claude" / "projects" / "".join(\n'
          '        c if c.isascii() and c.isalnum() else "-" for c in str(_HERE.parent))\n',
          why="session fallback looks in THIS workspace's transcripts, not the author's")
    P.sub(out / "src" / "sessions.js", "  const slug = workspacePath.replace(/[/\\\\]/g, '-');",
          "  // \u26d4 EVERY non-alphanumeric, not just separators: `C:\\\\Users\\\\HP` is `C--Users-HP`, and\n"
          "  // keeping the colon found no folder -- the session picker had no labels at all\n"
          "  const slug = workspacePath.replace(/[^a-zA-Z0-9]/g, '-');",
          why="session labels: the drive colon is a dash too")

    # ---- 4. the watch follows the file itself -----------------------------------------------
    w = rt / "watch.py"
    P.sub(w, "catch_up()\n\nfor line in sys.stdin:",
          FOLLOW + "\n\ncatch_up()\n\n_src = None\nfor i, a in enumerate(sys.argv):\n"
                   "    if a == \"--follow\" and i + 1 < len(sys.argv):\n"
                   "        _src = sys.argv[i + 1]\n"
                   "for line in (_follow(_src) if _src else sys.stdin):",
          why="--follow <file> replaces the tail -F pipe")

    # ---- 5. hook.js: interpreter, quoting, stdin ---------------------------------------------
    h = out / "src" / "hook.js"
    P.sub(h, "const path = require('path');", HOOK_HEAD, why="PY resolved once; fwd/Q/fixCmds")
    P.sub(h, BRIDGE_RULES_OLD, BRIDGE_RULES_NEW, why="permission rules: resolved interpreter, every path spelling, no tail")
    P.sub(h, 'f"  command: cd {mine} && tail -n0 -F chat.jsonl | python3 -u watch.py",',
          "f\"  command: cd '{mine.as_posix()}' && ${PY} -u watch.py --follow chat.jsonl\",",
          why="the watch command Claude is told to run: quoted, forward slashes, no tail")
    P.sub(h, 'f"\\`python3 {mine}/reply.py\\` -- a reply in the editor chat never reaches them there.",',
          "f\"\\`${PY} '{mine.as_posix()}/reply.py'\\` -- a reply in the editor chat never reaches them there.\",",
          why="the reply command Claude is told to run")
    P.sub(h, "command: `python3 ${script}`", "command: `${PY} ${Q(script)}`", count=2,
          why="SessionStart hook command, quoted")
    P.sub(h, "command: `python3 ${mirror}`", "command: `${PY} ${Q(mirror)}`",
          why="mirror hook command, quoted")
    P.sub(h, "  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\\n');",
          "  fixCmds(settings);\n  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\\n');",
          count=2, why="old hook entries are rewritten, not kept")
    # the hooks read Claude Code's JSON from stdin, which is UTF-8 whatever the code page says
    P.sub(h, "        data = json.load(sys.stdin) or {}",
          "        data = json.loads(sys.stdin.buffer.read().decode(\"utf-8\", \"replace\") or \"{}\") or {}",
          count=2, why="hook stdin decoded as UTF-8")

    # ---- 6. finding claude, and trusting a folder -------------------------------------------
    pf = out / "src" / "preflight.js"
    P.sub(pf, FIND_CLAUDE_OLD, FIND_CLAUDE_NEW, why="claude.exe, directly or behind the npm shim")
    P.sub(pf, "function trusted(cwd) {", TRUST_KEY, why="trust keys in Claude Code's own spelling")
    P.sub(pf, "    if (projects[dir] && projects[dir].hasTrustDialogAccepted === true) { accepted = true; break; }",
          "    const e = projects[tkey(dir)];\n"
          "    if (e && e.hasTrustDialogAccepted === true) { accepted = true; break; }",
          why="trust lookup by normalised key")
    P.sub(pf, "    return { ok: false, why: projects[cwd]", "    return { ok: false, why: projects[tkey(cwd)]",
          why="trust message by normalised key")
    P.sub(pf, "  const entry = d.projects[cwd] || {};", "  const entry = d.projects[tkey(cwd)] || {};",
          why="grantTrust reads the normalised key")
    P.sub(pf, "  d.projects[cwd] = Object.assign(", "  d.projects[tkey(cwd)] = Object.assign(",
          why="grantTrust writes the normalised key")

    # ---- 7. a window with no folder is the home folder --------------------------------------
    # ⛔ A WINDOW WITH NO FOLDER PUT THE ROOM IN VS CODE'S OWN INSTALL DIRECTORY. process.cwd() of
    # the extension host is wherever Code.exe lives, so chat.jsonl, the .py files and a .claude/
    # landed in Program Files -- while the Claude tab of that same window runs in the HOME folder,
    # never read those hooks, and the hooks could not find a control-room* folder under their own
    # root anyway. Measured: the woken session was never told to watch and went looking for a
    # claude.ai artifact instead. The home folder is what Claude Code itself uses, so the room goes
    # there.
    ex = out / "src" / "extension.js"
    P.sub(ex, "  if (!folders.length) return [{ dir: process.cwd(), name: 'Control Room' }];\n"
              "  const root = folders[0].uri.fsPath;",
          "  // ⛔ no folder open: the HOME folder, where the Claude tab of this window runs --\n"
          "  // not process.cwd(), which is VS Code's own install directory\n"
          "  const root = folders.length ? folders[0].uri.fsPath : require('os').homedir();",
          why="no folder open: the room lives under the home folder")
    P.sub(ex, "  return (vscode.workspace.workspaceFolders || [])[0]?.uri.fsPath || fallback;",
          "  return (vscode.workspace.workspaceFolders || [])[0]?.uri.fsPath || require('os').homedir();",
          why="no folder open: the workspace root is the home folder")

    # ⛔ AND IN THE HOME FOLDER, .claude/settings.json IS THE USER'S GLOBAL SETTINGS. Hooks written
    # there run for every session on the machine, in every folder: the mirror would copy all of
    # them into this panel, and the allow rules would widen permissions everywhere. Measured on
    # Windows: hooks in ~/.claude/settings.local.json fire for a session started in the home folder
    # and NOT for one started in Documents -- the scope a room needs, so that is where they go.
    P.sub(h, "function fixCmds(settings) {",
          "const SETTINGS = root => (path.resolve(root).toLowerCase() === path.resolve(require('os').homedir()).toLowerCase()\n"
          "  ? 'settings.local.json' : 'settings.json');\n"
          "function fixCmds(settings) {",
          why="home folder: hooks go into settings.local.json, not the global settings")
    P.sub(h, "readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8')",
          "readFileSync(path.join(root, '.claude', SETTINGS(root)), 'utf8')",
          why="installed() reads the file install() writes")
    P.sub(h, "  const file = path.join(claude, 'settings.json');",
          "  const file = path.join(claude, SETTINGS(root));",
          why="install() writes the scoped file")

    P.sub(out / "src" / "diagnose.js", "for (const exe of ['python3', 'python'])",
          "for (const exe of ['python', 'py', 'python3'])", why="probe the names Windows has, first")

    # ---- 7. identity -------------------------------------------------------------------------
    pj = json.loads(rd(out / "package.json"))
    pj["name"] = "control-room-win"
    pj["displayName"] = "Control Room (Windows)"
    pj["description"] = ((pj.get("description") or "") + " Windows build, generated from the "
                         "posix extension by extension-win/make.py.").strip()
    wr(out / "package.json", json.dumps(pj, indent=2, ensure_ascii=False) + "\n")

    print(f"built {out}  ({len(P.applied)} patches)")
    for a in P.applied:
        print("  •", a)
    print("\nnow:  cd", out, "&& npx --yes @vscode/vsce package --allow-missing-repository")


if __name__ == "__main__":
    main()
