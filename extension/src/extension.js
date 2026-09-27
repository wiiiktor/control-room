'use strict';
/**
 * Control Room as a VS Code webview.
 *
 * The browser version talks to a small Python server over localhost. Here there is no
 * server: the page's `fetch` calls are intercepted in the webview and answered by the
 * extension host, which reads and writes chat.jsonl directly. chat.html is loaded
 * unchanged, so one file serves both front ends.
 *
 * One workspace can hold SEVERAL instances -- a folder per Claude session, each with its
 * own chat.jsonl -- so the panel is per instance, not per window: opening a second one
 * does not steal the first one's log.
 */
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { Log, setFloor } = require('./log');
const { labels } = require('./sessions');
const hook = require('./hook');
const runtime = require('./runtime');
const diagnose = require('./diagnose');
const preflight = require('./preflight');

/** "control-room-medicover" -> "Control Room · medicover"; the plain one keeps its name. */
function instanceName(folder) {
  const suffix = folder.replace(/^control-room-?/, '');
  return suffix ? 'Control Room · ' + suffix : 'Control Room';
}

/** Every instance in this workspace: a folder of its own with a log in it.
 *
 * The setting, when set, names exactly one and nothing is discovered. Otherwise every
 * `control-room*` folder under the workspace root counts, so a second session's panel
 * is one command away rather than a settings edit. */
function instances() {
  const configured = vscode.workspace.getConfiguration('controlRoom').get('logPath');
  if (configured) return [{ dir: path.dirname(configured), name: 'Control Room' }];
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) return [{ dir: process.cwd(), name: 'Control Room' }];
  const root = folders[0].uri.fsPath;
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch { /* unreadable workspace root */ }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('control-room')) continue;
    const dir = path.join(root, entry.name);
    // ⛔ A FRESH CLONE HAS NO LOG. chat.jsonl is per machine and gitignored, and chat.html
    // moved into extension/ -- so looking only for those made a just-cloned room invisible,
    // the panel fell back to the workspace root, and it wrote its log next to the folder
    // holding the watch.py that was supposed to read it. reply.py is what makes a folder
    // a room; the log is what a room accumulates.
    const isRoom = ['chat.jsonl', 'chat.html', 'reply.py'].some(f => fs.existsSync(path.join(dir, f)));
    if (!isRoom) continue;
    out.push({ dir, name: instanceName(entry.name) });
  }
  // Nothing here yet: name the folder the room WILL live in. Writing the log at the
  // workspace root instead scatters chat.jsonl and four .py files over someone's project.
  if (!out.length) return [{ dir: path.join(root, 'control-room'), name: 'Control Room' }];
  return out.sort((a, b) => a.dir.length - b.dir.length);
}

/** The transcript folder is a property of the WORKSPACE, not of the instance. */
function workspaceRoot(fallback) {
  return (vscode.workspace.workspaceFolders || [])[0]?.uri.fsPath || fallback;
}

/** The page, with a shim that turns fetch('/api/...') into a postMessage round trip.
 *
 * The extension ships its own chat.html so it works in any workspace; a copy sitting
 * beside the log wins, because that is the one being edited while developing. */
function pageHtml(extensionPath, dir, session, build) {
  const local = path.join(dir, 'chat.html');
  const bundled = path.join(extensionPath, 'chat.html');
  let html = fs.readFileSync(fs.existsSync(local) ? local : bundled, 'utf8');
  // ⛔ NOBODY WAS STAMPING THIS. The page compares its own build with the one the host
  // reports and reloads when they differ -- but the placeholder was never replaced, so
  // the comparison guarded itself out and the reload never fired. An updated extension
  // could go on serving yesterday's page, which reads as the update not working.
  html = html.replace('"__BUILD__"', JSON.stringify(String(build || '0')));
  const shim = `
<script>
  // The session was chosen in the command palette, before the page existed. The page
  // reads this key on load, so writing it here is the whole handover.
  try {
    const picked = ${JSON.stringify(session || '')};
    if (picked) localStorage.setItem('ctrl-to', picked);
  } catch (e) { /* storage can be blocked; the page then asks in its own selector */ }
</script>
<script>
  // The webview has no server to talk to, so /api/* is answered by the extension host.
  // Anything else (a real URL) is left to the browser's own fetch.
  (function () {
    const vscodeApi = acquireVsCodeApi();
    // VS Code restarts its extension host whenever an extension is installed. This is
    // what lets the panel come back by itself afterwards instead of dying orphaned.
    try { vscodeApi.setState({ dir: ${JSON.stringify(dir)} }); } catch (e) {}
    const pending = new Map();
    let seq = 0;
    const realFetch = window.fetch ? window.fetch.bind(window) : null;
    window.fetch = function (url, opts) {
      const u = String(url);
      if (!u.startsWith('/api/')) return realFetch ? realFetch(url, opts) : Promise.reject(new Error('no fetch'));
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        vscodeApi.postMessage({ id, url: u, method: (opts && opts.method) || 'GET', body: opts && opts.body });
        // a host that never answers must not leave the page waiting forever
        setTimeout(() => {
          if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')); }
        }, 8000);
      });
    };
    window.addEventListener('message', function (e) {
      const m = e.data;
      // the palette can re-point an already-open panel at another session
      if (m && m.setTarget && window.CONTROL_ROOM_SET_TARGET) return window.CONTROL_ROOM_SET_TARGET(m.setTarget);
      if (!m || typeof m.id !== 'number' || !pending.has(m.id)) return;
      const p = pending.get(m.id);
      pending.delete(m.id);
      p.resolve({ ok: true, status: 200, json: async () => m.data });
    });
  })();
</script>`;
  // before the page's own scripts, so the very first poll already goes through it
  return html.replace('<script>', shim + '\n<script>', 1);
}

const trustSaid = new Set();   // rooms already told to trust their folder
let lastTerm = null;                     // a hidden terminal is still produced on demand
let lastBg = null;                       // the short id of the last background session we started
// which room each terminal we made belongs to, so a terminal that DIES can say where to report it
const ourTerms = new Map();

/** Where a terminal this extension opens should go.
 *
 * ⛔ THE SETTING HAS TO COVER EVERY TERMINAL, not just the one it was added for. "I do not
 * want to see this terminal in the bottom panel" is about terminals; a setting that fixed one
 * of three paths looked like no change at all, because the other two are the ones most often
 * pressed.
 *
 * Two kinds, and they cannot share a default:
 *   FIRE-AND-FORGET  starting a session with a first message -- nothing to watch, so `hidden`
 *                    is safe and is the default.
 *   INTERACTIVE      resuming a session, or the last-resort terminal when the Claude extension
 *                    is not installed -- you have to be able to type in it, so `hidden` would
 *                    strand it invisibly. Those get an editor TAB instead: still out of the
 *                    bottom panel, which is what was actually asked for.
 */
/** Carry VS Code's workspace trust over to Claude Code, so a hidden start has no trust question.
 *
 * \u26d4 THE READER ASKED FOR THIS TO BE AUTOMATIC, and the question it answers has already been
 * answered once, in VS Code: a workspace VS Code does not trust runs no extension code that could
 * reach here. So when VS Code trusts it and Claude has not been told, the extension tells it --
 * the same flag answering Yes would write. Off with controlRoom.autoTrust. */
function carryTrust(cwd) {
  if (vscode.workspace.getConfiguration('controlRoom').get('autoTrust') === false) return false;
  if (vscode.workspace.isTrusted === false) return false;
  try {
    if (preflight.trusted(cwd).ok) return false;
    return preflight.grantTrust(cwd);
  } catch { return false; }
}

function termOpts(name, cwd, interactive) {
  const mode = vscode.workspace.getConfiguration('controlRoom').get('startTerminal') || 'hidden';
  const o = { name, cwd };
  if (mode === 'panel') return { opts: o, reveal: true, pre: null };
  if (interactive || mode === 'tab') {
    o.location = vscode.TerminalLocation.Editor;
    return { opts: o, reveal: true, pre: null };
  }
  // \u26d4 A TERMINAL MAY ONLY BE HIDDEN WHEN NOTHING IS GOING TO ASK IT A QUESTION.
  // `claude` stops and waits for an answer on a folder it has not been trusted in, on an expired
  // login, and on an unfinished onboarding -- and hidden, that wait is indistinguishable from a
  // session thinking. Every one of those is knowable from files before the terminal exists, so
  // the check runs first and a failed check opens the terminal where it can be answered.
  carryTrust(cwd);
  const pre = preflight.check(cwd);
  if (!pre.ok) {
    o.location = vscode.TerminalLocation.Editor;
    return { opts: o, reveal: true, pre };
  }
  o.hideFromUser = true;
  return { opts: o, reveal: false, pre };
}

/** A terminal whose PROCESS is `claude`, not a shell that is typed into afterwards.
 *
 * \u26d4 TYPING INTO A FRESH SHELL IS A RACE, AND ON A MAC IT LOST. The text reaches the pty
 * before zsh has finished its rc files, and the Python extension types its own
 * `source .venv/bin/activate` into every new terminal in a folder with a venv. The two
 * interleaved: the command was cut at its opening quote, the activation ran instead, and
 * `claude` never started -- a terminal showing a prompt and a room that never answered.
 * Launching the binary directly leaves no shell to race and nothing to type into before it;
 * when claude exits the terminal closes and onDidCloseTerminal reports the code. Only when
 * the binary cannot be found does it fall back to typing into a shell. */
/** Start a session with NO TERMINAL AT ALL.
 *
 * ⭐ MEASURED, 2026-09-27, before this was written: from the workspace root,
 * `claude --bg "Watch this control room..."` started a session in 1 s, the SessionStart hook bound
 * it to the room holding `.expect`, the watch heartbeat appeared within 10 s, and a message written
 * into that room was answered in 20 s. No pty, no shell, no window.
 *
 * ⛔ WHY THIS REPLACES THE HIDDEN TERMINAL. `hideFromUser` hides the failure with the success: a
 * terminal sitting on a question, a `claude` that is not on the PATH, a crash on the first line --
 * all of them look identical from the panel, which is patient nothing. There is nothing to hide
 * here: the process either prints `backgrounded · <id>` or it exits with a code and a message on
 * stderr, and both go straight into the room. `claude attach <id>` is the way in if one is wanted.
 *
 * The visible modes (`startTerminal: tab | panel`) still get a real terminal -- someone who asked
 * to watch it should see it.
 */
function startHeadless(dir, args, what, done) {
  const bin = preflight.findClaude();
  if (!bin) { done({ ok: false, why: 'the `claude` command is not on the PATH this extension can see' }); return; }
  const cp = require('child_process');
  let out = '', err = '';
  let p;
  try {
    p = cp.spawn(bin, ['--bg'].concat(args), { cwd: workspaceRoot(dir), env: process.env });
  } catch (e) {
    done({ ok: false, why: 'could not run claude — ' + (e && e.message || e) });
    return;
  }
  p.stdout.on('data', d => { out += String(d); });
  p.stderr.on('data', d => { err += String(d); });
  p.on('error', e => done({ ok: false, why: 'could not run claude — ' + (e && e.message || e) }));
  p.on('close', (code) => {
    // `backgrounded · 16b59ea7` -- the short id `claude attach|logs|stop` take
    const m = /backgrounded\s*\W*\s*([0-9a-f]{6,})/i.exec(out);
    // \u26a0 A RESUME OF A SESSION THAT IS ALREADY RUNNING BECOMES A COPY under a NEW id -- the CLI
    // says so in its own output. The room has to report that, because the reader picked one session
    // and a different one is about to answer. \u26d4 UNVERIFIED WORDING: I have not made the CLI
    // print this, so the match is deliberately loose and the flag is advisory, never a failure.
    const copied = /\bcopy\b|already running/i.test(out);
    if (code === 0 && m) { done({ ok: true, id: m[1], out, copied }); return; }
    done({ ok: false, code, out, err,
           why: 'claude exited ' + code + (err.trim() ? ' — ' + err.trim().split('\n')[0] : '') });
  });
}

/** The room says what happened, with the process's own words. No guessing, no spinner. */
function headlessFailed(dir, r, what) {
  announce(dir, [
    '::err Could not start a session in the background',
    '::say ' + what,
    '::note ' + (r.why || 'no reason reported'),
    r.err && r.err.trim() ? '::note ' + r.err.trim().split('\n').slice(0, 2).join(' ').slice(0, 300) : '',
    '::note Control Room: Diagnose the bridge lists what a hidden start needs.',
  ].filter(Boolean).join('\n'));
}

function claudeTerminal(opts, args) {
  const bin = preflight.findClaude();
  if (bin) {
    return vscode.window.createTerminal(Object.assign({}, opts, { shellPath: bin, shellArgs: args }));
  }
  const term = vscode.window.createTerminal(opts);
  term.sendText(['claude'].concat(args.map(a => /^[\w.\/-]+$/.test(a) ? a : JSON.stringify(a))).join(' '));
  return term;
}

/** Say something in the room itself. Not a reply and not a message to the session: a line from
 *  the extension, which is the only voice that can report a terminal nobody can see. */
function announce(dir, markup) {
  try { new Log(dir).append('assistant', markup); } catch { /* read-only room */ }
}

/** A started session must PROVE it started.
 *
 *  \u26d4 The old net was a 25-second timer in the page that then offered a button to press. That
 *  is still a silence the reader has to notice and act on, and it only existed on one of the two
 *  start paths. This watches for the thing that actually proves life -- a watcher heartbeat in
 *  the room -- and when it does not appear, it surfaces the terminal ITSELF and says why in the
 *  log. No button, no guessing, and the same net on every path that starts a session. */
function proveItStarted(dir, term, what) {
  const log = new Log(dir);
  const before = new Set(log.watchers({}).map(w => w.session));
  const t0 = Date.now();
  const tick = setInterval(() => {
    let live = [];
    try { live = log.watchers({}); } catch { /* room went away */ }
    if (live.some(w => !before.has(w.session))) { clearInterval(tick); return; }
    if (Date.now() - t0 < 60000) return;
    clearInterval(tick);
    // \u26d4 A BACKGROUND SESSION HAS NO TERMINAL TO SHOW, and pretending otherwise was the point
    // of this whole exercise. It has something better: an id, and a command that prints what it
    // actually did. Say the id.
    if (!term) {
      announce(dir, [
        '::err The session I started has not answered in 60 seconds',
        '::say ' + what + (lastBg ? ' It is running in the background as ' + lastBg + '.' : ''),
        lastBg ? '::note See what it is doing: `claude logs ' + lastBg + '` — or take it over with '
          + '`claude attach ' + lastBg + '`. Nothing you wrote is lost; it is on record in this room.'
          : '::note Nothing you wrote is lost; it is on record in this room.',
        '::pick Open it in a terminal => __reveal_terminal',
      ].join('\n'));
      return;
    }
    try { term.show(false); } catch { /* terminal already gone */ }
    announce(dir, [
      '::err The session I started has not answered in 60 seconds',
      '::say I opened the terminal so you can see what it is doing. ' + what,
      '::note A hidden terminal cannot ask you anything. If it is sitting on a question — trusting '
        + 'this folder, logging in, choosing a theme — answer it there and the bridge comes up.',
    ].join('\n'));
  }, 3000);
  // never leave a timer running for a room nobody is looking at
  setTimeout(() => clearInterval(tick), 120000);
}

/** The first prompt every session this extension starts is handed. It has to be a turn, not a
 *  greeting: taking a turn is what runs the SessionStart instructions and arms the watch. */
const WAKE = 'Watch this control room and answer me in the panel.';

/** Resume a session in a terminal rooted at the instance it answers for. */
function resumeIn(dir, sid) {
  // ⛔ NOT the room folder. Claude Code files a session under the directory it was
  // started in, and every session this panel lists was read out of the WORKSPACE's
  // project folder -- so `--resume` run from control-room/ looks for the id somewhere it
  // was never written, and finds nothing. The room is still where the log is; the
  // session-start hook finds it by heartbeat, not by cwd.
  // ⛔ NOT interactive any more. Resume used to mean "give me a terminal to type in", so it
  // got an editor tab. It now means "wake the session I just wrote to", and the writing
  // happens in the room -- so there is nothing to type in the terminal and no reason to look
  // at it. Fire-and-forget, hidden under the default setting, and kept in lastTerm so the
  // room can produce it when the session fails to answer.
  try { fs.writeFileSync(path.join(dir, '.expect'), ''); } catch { /* read-only room */ }
  // \u2b50 NO TERMINAL WHEN NONE IS WANTED. `--bg --resume <id>` continues that session in the
  // background under the same id, which is exactly "wake the session I just wrote to" with nothing
  // appearing anywhere. Falls back to the terminal only if the process refuses to start.
  if (headlessWanted()) {
    carryTrust(workspaceRoot(dir));
    startHeadless(dir, ['--resume', sid, WAKE], 'Waking session ' + sid.slice(0, 8) + '.', (r) => {
      if (r.ok) {
        lastBg = r.id;
        if (r.copied && r.id.slice(0, 8) !== sid.slice(0, 8)) {
          announce(dir, [
            '::warn ' + sid.slice(0, 8) + ' is already running, so a copy of it answers instead',
            '::say A session that is live somewhere else cannot be woken from here — nothing can '
              + 'reach into it. Claude started a copy carrying the same history, as ' + r.id + '.',
            '::note The copy answers this room. The original is untouched and keeps whatever it was '
              + 'doing. If the original is the Claude session in this editor, that is why: reloading '
              + 'the window restarts it, and until it takes a turn it is not reading this room.',
          ].join('\n'));
        }
        proveItStarted(dir, null, 'Session ' + sid.slice(0, 8) + ' was asked to wake up.');
        return;
      }
      headlessFailed(dir, r, 'Waking session ' + sid.slice(0, 8) + '.');
      resumeInTerminal(dir, sid);
    });
    return;
  }
  resumeInTerminal(dir, sid);
}

/** True when the reader has not asked to watch a terminal. */
function headlessWanted() {
  const mode = vscode.workspace.getConfiguration('controlRoom').get('startTerminal') || 'hidden';
  return mode === 'hidden';
}

/** The old path, kept for `tab`/`panel` and as the fallback when the background start fails. */
function resumeInTerminal(dir, sid) {
  const { opts, reveal, pre } = termOpts('claude · ' + sid.slice(0, 8), workspaceRoot(dir), false);
  const term = claudeTerminal(opts, ['--resume', sid, WAKE]);
  if (reveal) term.show(true);
  if (pre && !pre.ok) announce(dir, preflightSays(pre, 'waking that session'));
  // ⛔ AND IT MUST BE GIVEN SOMETHING TO DO. `claude --resume <id>` with no prompt starts an
  // INTERACTIVE session and then sits at its input waiting for a human. The SessionStart hook
  // fires, but a hook only injects context -- nothing makes Claude take a turn, so the watch is
  // never armed, the message sitting in the log is never read, and from the panel this looks
  // exactly like "the terminal never opened". `claude [options] [prompt]` takes a first prompt
  // on the command line: that is the turn, and the turn is what arms the watch.
  lastTerm = term;
  ourTerms.set(term, dir);
  proveItStarted(dir, term, 'It was asked to resume session ' + sid.slice(0, 8) + '.');
}

/** Open the Claude Code extension in an editor tab.
 *
 * Its commands are not API and it may not be installed, so each is tried in turn and a
 * terminal is the last resort. Opening a tab does NOT start a session: Claude Code runs
 * when it is given something to do, so the caller has to say "now type in it".
 */
/** Is a Claude Code tab already open in this window?
 *
 *  It cannot say WHICH session that tab holds -- the extension publishes no such thing --
 *  only that one exists. That is still worth knowing: a tab already open is a tab to bring
 *  forward rather than a reason to make another.
 */
function claudeTabOpen() {
  try {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const view = tab.input && (tab.input.viewType || tab.input.notebookType);
        if (view && /claude/i.test(String(view))) return true;
        if (/^claude\b/i.test(String(tab.label || ''))) return true;
      }
    }
  } catch { /* an older VS Code without the tab API */ }
  return false;
}

async function openClaudeTab(dir) {
  // ⛔ ORDER MATTERS, AND IT WAS BACKWARDS. `claude-vscode.editor.open` is called "Open in
  // New Tab" and does exactly that -- so pressing the button with a Claude tab already
  // sitting there made a SECOND one, every time. `editor.openLast` is the plain "Open": it
  // brings back the conversation that is already there. Reuse first, create only if there
  // is nothing to reuse.
  const existing = claudeTabOpen();
  const order = existing
    ? ['claude-vscode.editor.openLast', 'claude-vscode.editor.open', 'claude-vscode.newConversation']
    : ['claude-vscode.editor.open', 'claude-vscode.editor.openLast', 'claude-vscode.newConversation'];
  for (const cmd of order) {
    try {
      await vscode.commands.executeCommand(cmd);
      try { await vscode.commands.executeCommand('claude-vscode.focus'); } catch { /* optional */ }
      return existing ? 'existing' : 'tab';
    } catch { /* not this one; try the next */ }
  }
  // no extension to talk to -- a terminal session at least reads the same log
  const { opts, reveal } = termOpts('claude · control room', dir, true);
  const term = claudeTerminal(opts, ['watch this control room and answer me in the panel']);
  if (reveal) term.show(true);
  return 'terminal';
}

/** Start a session WITHOUT the reader typing anything, and without anything appearing.
 *
 * ⛔ THIS WAS TAKEN OUT OF THE TAB VERSION ONCE, for a reason that no longer holds: "a
 * terminal appearing by itself is in the way of the code". It was `show()`n then. Under
 * `hideFromUser` nothing is surfaced at all -- the process runs, there is no terminal in the
 * panel, none in the terminal list -- so the objection is gone and the tab version can have
 * the one thing that removes its opening ritual.
 *
 * The Claude tab itself still cannot be driven: it is another extension's webview, none of its
 * commands takes a prompt, and `type` does not reach a webview. A terminal can, because
 * `claude [prompt]` starts an interactive session with that first message.
 */
function startSessionInTerminal(dir, first) {
  // ⛔ cwd is the WORKSPACE, not the room: Claude files a session under the directory it
  // started in, and the hooks live in the workspace's .claude/. The room is found by the
  // .expect marker instead -- the same mechanism the "open a tab" button uses.
  try { fs.writeFileSync(path.join(dir, '.expect'), ''); } catch { /* read-only room */ }
  if (headlessWanted()) {
    carryTrust(workspaceRoot(dir));
    startHeadless(dir, [first], 'Starting a session for this room.', (r) => {
      if (r.ok) {
        lastBg = r.id;
        proveItStarted(dir, null, 'A new session was started for this room.');
        return;
      }
      headlessFailed(dir, r, 'Starting a session for this room.');
      startInTerminal(dir, first);
    });
    return null;
  }
  return startInTerminal(dir, first);
}

/** The terminal path, for `tab`/`panel` and as the fallback. */
function startInTerminal(dir, first) {
  const { opts, reveal, pre } = termOpts('claude · ' + path.basename(dir), workspaceRoot(dir), false);
  const term = claudeTerminal(opts, [first]);
  if (reveal) term.show(true);
  if (pre && !pre.ok) announce(dir, preflightSays(pre, 'starting a session'));
  lastTerm = term;
  ourTerms.set(term, dir);
  proveItStarted(dir, term, 'It was asked to start a new session here.');
  return term;
}

/** The check, in the reader's words. Named problems beat a spinner. */
function preflightSays(pre, doing) {
  // \u26d4 THE TRUST QUESTION GETS ITS OWN SCREEN. As one ::note among others it read like a
  // diagnostic, and the one thing to do -- answer Yes, once -- was nowhere on the screen.
  // Trust belongs to the FOLDER, not to a session: one Yes lets every session there start
  // hidden, a resumed old one as much as a new one, so the screen says that too.
  if (pre.untrusted) {
    const out = [
      '::ask Trust this folder first',
      '::say Claude Code has never been allowed to work in ' + (pre.cwd || 'this folder')
        + '. Before it runs here it asks "Do you trust the files in this folder?" -- and a hidden'
        + ' terminal cannot show you that question, so the session would wait forever.',
      doing === 'this room'
        ? '::li Press the button below: a terminal tab opens with that question. Answer Yes there.'
        : '::li I opened the terminal as a tab instead. Answer Yes there, now.',
      '::li You only do this once. Trust belongs to the folder, not to a session: afterwards every'
        + ' session here starts hidden, new ones and resumed old ones alike.',
    ];
    if (doing !== 'this room') out.push('::li If the tab is not in front, press the button below.');
    for (const p of pre.problems) if (!/trust/i.test(p)) out.push('::li ! ' + p);
    out.push(doing === 'this room'
      ? '::pick Open the terminal and answer it => __trust_terminal'
      : '::pick Show me the terminal => __reveal_terminal');
    return out.join('\n');
  }
  const out = ['::warn I did not hide the terminal for ' + doing];
  out.push('::say Something in it is going to ask a question, so it opened as a tab where you can answer.');
  for (const p of pre.problems) out.push('::note ' + p);
  return out.join('\n');
}

/** Said whenever a panel is opened with nothing reading it: the one step people miss. */
const NO_SESSION = 'Control Room: no Claude session is watching this panel yet. Open the Claude tab and send it any message — that starts the session that reads what you write here. Your messages are kept until then.';

function activate(context) {
  // \u26d4 EVERY HEARTBEAT OLDER THAN THIS MOMENT BELONGS TO A SESSION THAT IS GONE. Reloading the
  // window kills the Claude session the editor hosts -- which is the session this panel is usually
  // talking to -- and `.watch.<id>` keeps the mtime of its last beat for another 90 seconds. That is
  // the exact window in which the reader reloads to pick up a new build and tries again, so the room
  // told them somebody was listening when nobody was, and the message was appended and never woken.
  // A session that survived beats again in seconds and comes straight back.
  setFloor(Date.now());
  // one panel per instance folder: a second panel must not take over the first one's log
  const panels = new Map();
  // the page reloads itself when this changes; in a webview the html is fixed for the
  // life of the panel, so a constant is honest and a stat() of a moving file is not
  const BUILD = String(context.extension ? context.extension.packageJSON.version : '0');

  const open = (inst, session) => {
    const existing = panels.get(inst.dir);
    if (existing) {
      // already open: point it at the session just picked rather than opening a second
      // panel on the same log, which would be two views of one conversation
      if (session) existing.webview.postMessage({ setTarget: session });
      existing.reveal(vscode.ViewColumn.Active);
      return;
    }
    wire(vscode.window.createWebviewPanel(
      'controlRoom', inst.name, vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }), inst.dir, inst.name, session);
  };

  /** Everything a panel needs to work, whether it was just created or restored by VS Code
   *  after an extension-host restart. Split out for exactly that second case. */
  const wire = (panel, dir, name, session) => {
    const log = new Log(dir);
    panels.set(dir, panel);
    panel.onDidDispose(() => { panels.delete(dir); }, null, context.subscriptions);

    // \u26d4 SAY IT WHEN THE ROOM OPENS, NOT ONLY WHEN A START FAILS. The trust screen used to be
    // written only by a terminal start, so a reader who opened the room and wrote to a session
    // that was merely restarting never saw it -- and every later hidden start would still have
    // hung. Once per room per extension host: a reload says it again, a re-reveal does not.
    if (!trustSaid.has(dir)) {
      trustSaid.add(dir);
      try {
        carryTrust(workspaceRoot(dir));
        const pre = preflight.check(workspaceRoot(dir));
        // and not twice: a restored panel and a startup open can both wire the same room
        const last = log.read().filter(m => m.role === 'assistant').pop();
        const already = last && /^::ask Trust this folder first/.test(last.text || '');
        if (pre.untrusted && !already) announce(dir, preflightSays(pre, 'this room'));
      } catch { /* a check that cannot run is not a reason to break the panel */ }
    }

    // a panel nobody is watching looks identical to a working one until a message is
    // ignored, so the tab itself says so
    let title = name;
    const retitle = (watchers) => {
      // The version is BACK in the tab title, asked for again: with a build a few minutes old at
      // any time, "which one am I looking at" is a question the tab should answer without being
      // opened. The splash stamps it too.
      const want = name + ' ' + BUILD + (watchers.length ? '' : ' (no watcher)');
      if (want !== title) { title = want; panel.title = want; }
    };

    /** Sessions with a live watch in some OTHER room of this workspace.
     *
     *  ⛔ A session listens to ONE room. The menu here lists every session that has ever
     *  written in this log -- including one the mirror put there by mistake -- so a
     *  session belonging to another room could be chosen as the recipient, and every
     *  message addressed to it was skipped by the only watcher present. The panel could
     *  not say so, because it only ever knew who was in its own room. Now it knows where
     *  the others are, and can offer the one thing that helps: that room. */
    const elsewhere = (names, here) => {
      const out = {};
      for (const inst of instances()) {
        if (inst.dir === dir) continue;
        for (const w of new Log(inst.dir).watchers(names)) {
          if (!here.some(h => h.session === w.session)) out[w.session] = inst.name;
        }
      }
      return out;
    };

    /** Ids the reader has taken out of the strip. A missing or unreadable file means none. */
    const hiddenIds = () => {
      try {
        return fs.readFileSync(path.join(dir, '.hidden'), 'utf8')
          .split('\n').map(n => parseInt(n, 10)).filter(Number.isFinite);
      } catch {
        return [];
      }
    };

    panel.webview.onDidReceiveMessage(async (req) => {
      const reply = (data) => panels.get(dir) && panel.webview.postMessage({ id: req.id, data });
      try {
        const [route, query] = String(req.url).split('?');
        if (route === '/api/messages') {
          const since = parseInt(new URLSearchParams(query || '').get('since') || '0', 10) || 0;
          const messages = log.read(since);
          const names = await labels(workspaceRoot(dir));
          const watchers = log.watchers(names);
          retitle(watchers);
          return reply({
            messages,
            last: messages.length ? messages[messages.length - 1].id : since,
            build: BUILD,
            status: log.readStatus(),
            watch: log.watchAge(),
            hidden: hiddenIds(),
            watchers,
            elsewhere: elsewhere(names, watchers),
          });
        }
        if (route === '/api/sessions') {
          const names = await labels(workspaceRoot(dir));
          const here = log.watchers(names);
          return reply({ sessions: names, watchers: here, elsewhere: elsewhere(names, here) });
        }
        if (route === '/api/resume') {
          // Only the editor can do this: give a dormant session a REAL window by
          // resuming it in a terminal you can watch and type into.
          const body = JSON.parse(req.body || '{}');
          const sid = (body.session || '').trim();
          if (!/^[0-9a-f-]{36}$/.test(sid)) return reply({ error: 'not a session id' });
          resumeIn(dir, sid);
          return reply({ ok: true });
        }
        // Hide one reply from the timeline strip.
        //
        // ⛔ APPEND, NEVER REWRITE. Removing the line from chat.jsonl is the obvious reading of
        // "delete", and it is the one thing this project has already been burned by: `tail -F`
        // re-reads a truncated file from the top, so rewriting the log replays every message
        // into whatever watch is running. The log stays append-only and a separate list says
        // what not to draw. Delete a line from `.hidden` to bring a thumbnail back.
        if (route === '/api/hide') {
          const id = parseInt(JSON.parse(req.body || '{}').id, 10);
          if (!Number.isFinite(id)) return reply({ error: 'not an id' });
          try {
            fs.appendFileSync(path.join(dir, '.hidden'), id + '\n');
          } catch {
            return reply({ error: 'could not write .hidden' });
          }
          return reply({ ok: true, id });
        }
        // Open the room a session IS listening to, addressed to it. The panel cannot
        // reach it from here; this is the move that works.
        if (route === '/api/open_room') {
          const sid = (JSON.parse(req.body || '{}').session || '').trim();
          if (!/^[0-9a-f-]{36}$/.test(sid)) return reply({ error: 'not a session id' });
          const names = await labels(workspaceRoot(dir));
          for (const inst of instances()) {
            if (inst.dir === dir) continue;
            if (new Log(inst.dir).watchers(names).some(w => w.session === sid)) {
              open(inst, sid);
              // ⛔ ...and CLOSE THIS ONE. Leaving it behind is how you end up with two
              // control room tabs after asking to change session -- which nobody asked
              // for. Switching rooms should feel like switching, not like accumulating.
              // Answered first: the page is told where it went before its host vanishes.
              reply({ ok: true, room: inst.name, replaced: true });
              setTimeout(() => { try { panel.dispose(); } catch { /* already gone */ } }, 150);
              return;
            }
          }
          return reply({ error: 'no room is listening for that session' });
        }
        // Start a session on the reader's behalf, in the background. See
        // startSessionInTerminal for why it is a terminal and not the tab.
        if (route === '/api/autostart') {
          const first = WAKE;
          startSessionInTerminal(dir, first);
          panel.reveal(panel.viewColumn, false);   // and put the room back in front
          const mode = vscode.workspace.getConfiguration('controlRoom').get('startTerminal') || 'hidden';
          return reply({ ok: true, how: 'terminal', mode, sent: first });
        }
        // `hideFromUser` hides the failure as well as the success, so the terminal is kept and
        // this produces it -- offered by the panel when a started session never appears.
        if (route === '/api/reveal_terminal') {
          // \u2b50 A background session becomes visible by being ATTACHED, not by un-hiding a
          // terminal it never had. This is the one place a terminal is wanted on purpose, so it
          // gets an editor tab you can type in.
          if (!lastTerm && lastBg) {
            const bin = preflight.findClaude() || 'claude';
            const term = vscode.window.createTerminal({
              name: 'claude · ' + lastBg, cwd: workspaceRoot(dir),
              location: vscode.TerminalLocation.Editor,
              shellPath: bin, shellArgs: ['attach', lastBg],
            });
            term.show(true);
            lastTerm = term;
            ourTerms.set(term, dir);
            return reply({ ok: true, how: 'attached', id: lastBg });
          }
          if (!lastTerm) return reply({ error: 'no session was started from here' });
          lastTerm.show(false);
          return reply({ ok: true, how: 'terminal' });
        }
        if (route === '/api/start') {
          // ⛔ ASK FIRST. The button opened a tab whatever the state was -- including when
          // the session you had just chosen was already running and reading this very log.
          // Nothing needed opening; the answer was "it is already there, write here".
          const want = (JSON.parse(req.body || '{}').session || '').trim();
          if (want) {
            const names = await labels(workspaceRoot(dir));
            if (log.watchers(names).some(w => w.session === want)) {
              try { await vscode.commands.executeCommand('claude-vscode.focus'); } catch { /* optional */ }
              return reply({ ok: true, how: 'already' });
            }
          }
          // ⛔ SAY WHICH ROOM ASKED. A session that has never run has no heartbeat, so the
          // hooks fall back to the first room by name -- and a fresh tab opened from any
          // other panel attached itself to that one instead, wrote its turns there, and
          // left the panel you started it from silent. This file is the request: the newest
          // one still unclaimed wins, and only for a few minutes.
          try { fs.writeFileSync(path.join(dir, '.expect'), ''); } catch { /* read-only room */ }
          // A TAB, not a terminal: the terminal session is a different animal from the one
          // the editor keeps, and it is not where anyone wants to carry on the conversation.
          const how = await openClaudeTab(dir);
          return reply({ ok: true, how });
        }
        if (route === '/api/send') {
          const body = JSON.parse(req.body || '{}');
          const text = (body.text || '').trim();
          if (!text) return reply({ error: 'empty message' });
          return reply(log.append('user', text, (body.to || '').trim() || null));
        }
        reply({ error: 'not found' });
      } catch (err) {
        reply({ error: String(err && err.message || err) });
      }
    }, null, context.subscriptions);

    // ⛔ ORDER MATTERS. Everything below can fail on someone else's disk, and a throw here
    // used to skip the handler registration entirely -- leaving a panel that renders and
    // silently swallows every message, which is indistinguishable from a dead bridge.
    // The handler is registered first; the rest is best effort.
    panel.webview.html = pageHtml(context.extensionPath, dir, session, BUILD);
    try {
      // A panel with nothing watching it is the failure people report as "I write and
      // nothing happens", and both halves of the cure are things only this extension can
      // do. They are done, not offered: a question at this moment is about machinery the
      // reader has not met yet.
      const added = runtime.install(context.extensionPath, dir);
      let hooked = false;
      const hookRoot = workspaceRoot(dir);
      // the mirror copies the editor conversation into this room, so the panel is the
      // whole exchange rather than half of it; one setting turns it off
      const mirror = vscode.workspace.getConfiguration('controlRoom').get('mirrorEditorChat') !== false;
      if (!hook.installed(hookRoot) || !hook.current(hookRoot) || mirror) {
        const out = hook.install(hookRoot, mirror ? dir : null);
        hooked = !out.already;                // a refreshed script is not news
      }
      if (added.length || hooked) {
        const said = [];
        if (added.length) said.push('wrote ' + added.join(', ') + ' into ' + path.basename(dir));
        if (hooked) said.push('installed the session-start hook');
        vscode.window.showInformationMessage(
          'Control Room ' + said.join(' and ') + '. Open a Claude tab and send it any message to connect.');
      }
    } catch (err) {
      vscode.window.showWarningMessage('Control Room: could not finish setting up this room — '
        + (err && err.message || err) + '. The panel still works.');
    }
  };

  /** Ask which SESSION, the way Claude Code's own picker asks: by what the session
   *  opened with. A control room is a folder on disk, which is not what anyone has in
   *  mind when they open this -- they want to talk to a particular Claude. Each live
   *  session is listed under the name its transcript carries, and picking one opens the
   *  control room that session is listening to, already addressed to it. */
  const pickSession = async (placeHolder) => {
    const found = instances();
    const names = await labels(workspaceRoot(found[0].dir));
    const items = [];
    let live = 0;
    for (const inst of found) {
      const watching = new Log(inst.dir).watchers(names);
      live += watching.length;
      for (const w of watching) {
        items.push({
          label: (names[w.session] || w.label || w.session).slice(0, 70),
          description: inst.name,
          detail: w.session.slice(0, 8) + ' · listening, last seen ' + w.age + 's ago',
          inst,
          session: w.session,
        });
      }
      // a room nobody is listening to is still worth opening -- to read it, or to
      // resume the session from inside it -- but it must not look like a live one
      if (!watching.length) {
        items.push({
          label: inst.name,
          description: 'no session is listening',
          detail: 'Open the Claude tab and send it any message — that starts the session that reads this panel.',
          inst,
          session: '',
        });
      }
    }
    if (items.length === 1) {
      if (!live) vscode.window.showInformationMessage(NO_SESSION);
      return items[0];
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: live ? placeHolder : 'No Claude session is listening yet — open the Claude tab and send it a message',
      matchOnDescription: true,
    });
    if (picked && !picked.session) vscode.window.showInformationMessage(NO_SESSION);
    return picked || null;
  };

  // ⛔ this called an installHook() that no longer existed -- it was removed when the
  // hook stopped being offered and started being installed. The command threw.
  context.subscriptions.push(vscode.commands.registerCommand('controlRoom.installHook', () => {
    const root = workspaceRoot(instances()[0].dir);
    try {
      const out = hook.install(root);
      vscode.window.showInformationMessage(out.already
        ? 'Control Room: the session-start hook was already installed; its script was refreshed.'
        : 'Control Room: session-start hook installed. It takes effect the next time a Claude session starts here.');
    } catch (err) {
      vscode.window.showErrorMessage('Control Room: could not install the hook — ' + (err && err.message || err));
    }
  }));

  // \u26d4 A HIDDEN TERMINAL THAT DIES IS THE QUIETEST FAILURE OF ALL. There is no window to
  // close, no error, nothing in the terminal list -- the room simply never gets an answer. VS Code
  // does tell us, with the exit code, so the room can say it out loud.
  if (vscode.window.onDidCloseTerminal) {
    context.subscriptions.push(vscode.window.onDidCloseTerminal((term) => {
      const room = ourTerms.get(term);
      if (!room) return;
      ourTerms.delete(term);
      const code = term.exitStatus ? term.exitStatus.code : undefined;
      if (code === 0 || code === undefined) return;      // a clean end is not news
      announce(room, [
        '::err The terminal I started for this room has exited (code ' + code + ')',
        '::say Nothing is reading the room from it now. The usual causes are `claude` not being on '
          + 'the PATH the terminal got, a login that has expired, or the folder never having been '
          + 'trusted.',
        '::note Control Room: Diagnose the bridge names which one.',
      ].join('\n'));
    }));
  }

  // Opening the workspace is enough: the panel is the point of installing this, and a
  // panel nobody opened helps nobody. Off with one setting for people who want it quiet.
  if (vscode.workspace.getConfiguration('controlRoom').get('openOnStartup') !== false) {
    // ⛔ NOT "only when there is exactly one room". That guard was the whole reason the panel
    // had to be summoned from the palette at all: this workspace holds two rooms, so nothing
    // opened by itself and every visit began with Ctrl+Shift+P -- a choice made before
    // anything was on screen, on top of the choice made inside the room. `instances()` sorts
    // the plain room first, so opening it is right nearly always, and the room itself is
    // where switching belongs. "Open every control room" is still there for the rest.
    open(instances()[0], '');
  }

  // ⛔ Installing ANY extension restarts VS Code's extension host, and a webview whose
  // host has gone is dead -- which made every update end with "control room has no
  // connection" and a tab to close by hand. VS Code will hand the panel back instead, if
  // the extension says it can rebuild one. The dir comes from the state the page stored.
  if (vscode.window.registerWebviewPanelSerializer) {
    context.subscriptions.push(vscode.window.registerWebviewPanelSerializer('controlRoom', {
      async deserializeWebviewPanel(panel, state) {
        const dir = (state && state.dir) || instances()[0].dir;
        if (panels.has(dir)) { panel.dispose(); return; }   // a fresh one already won
        wire(panel, dir, instanceName(path.basename(dir)), '');
      },
    }));
  }

  // A window already running keeps the extension it started with, and nothing on the
  // command line can reload it -- but a URI can, because opening one activates this
  // extension and hands it the path. `code --open-url vscode://wiiiktor.control-room/reload`
  // is then the terminal command for a menu step that otherwise has to be clicked.
  if (vscode.window.registerUriHandler) {
    context.subscriptions.push(vscode.window.registerUriHandler({
      handleUri(uri) {
        if (uri.path === '/reload') return vscode.commands.executeCommand('workbench.action.reloadWindow');
        if (uri.path === '/open') return vscode.commands.executeCommand('controlRoom.open');
        if (uri.path === '/diagnose') return vscode.commands.executeCommand('controlRoom.diagnose');
      },
    }));
  }

  // "the bridge does not work" is four faults wearing one face; this names which
  context.subscriptions.push(vscode.commands.registerCommand('controlRoom.diagnose', async () => {
    const found = instances();
    const root = workspaceRoot(found[0].dir);
    const text = diagnose.report({
      version: context.extension ? context.extension.packageJSON.version : '?',
      root,
      rooms: found.map(i => i.dir),
      runtimeFiles: runtime.FILES,
      hookInstalled: hook.installed(root),
      hookPath: path.join(root, '.claude', 'settings.json'),
      preflight: preflight.check(root),
    });
    const doc = await vscode.workspace.openTextDocument({ content: text, language: 'plaintext' });
    await vscode.window.showTextDocument(doc, { preview: false });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('controlRoom.open', async () => {
    // ⛔ NO QUESTION HERE ANY MORE. This used to ask which session before the room existed --
    // a decision demanded before anything was on screen, about a list whose entries mostly
    // ended days ago, and it handed over a target that then went stale. The room opens; the
    // sessions are offered inside it, where you can see what each one last said.
    // ⚠️ And no handover: a target chosen out here is the one that made messages go to a
    // session that could not see them.
    // ⛔ AND NO LIST AT ALL. Not sessions, not rooms: every choice belongs inside the room,
    // where you can see what you are choosing between. `instances()` returns rooms sorted with
    // the plain one first, so this opens the one you meant in the overwhelming majority of
    // cases -- and "Control Room: open every room" is still there for the rest.
    open(instances()[0]);
  }));

  // every instance at once, for the two-session case this was built for
  context.subscriptions.push(vscode.commands.registerCommand('controlRoom.openAll', () => {
    for (const inst of instances()) open(inst);
  }));

  // the same thing from the palette, for when the panel is not the place you are looking
  context.subscriptions.push(vscode.commands.registerCommand('controlRoom.resume', async () => {
    const found = instances();
    const root = workspaceRoot(found[0].dir);
    const names = await labels(root);
    const picked = await vscode.window.showQuickPick(
      Object.entries(names).map(([id, label]) => ({ label: label.slice(0, 80), description: id.slice(0, 8), id })),
      { placeHolder: 'Which session should be resumed in a terminal?' });
    if (!picked) return;
    const room = await pickSession('Which control room should it answer?');
    resumeIn((room && room.inst.dir) || found[0].dir, picked.id);
  }));
}

function deactivate() {}

module.exports = { activate, deactivate };
