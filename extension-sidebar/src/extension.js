'use strict';
/**
 * Control Room as a VS Code SIDEBAR view.
 *
 * ⛔ THIS IS A SEPARATE CODEBASE FROM ../extension, ON PURPOSE. The two front ends are the
 * same idea in two shapes and they drifted into one file fighting itself: an editor tab is
 * created, revealed, titled, disposed and serialised, and a sidebar view is none of those
 * -- VS Code owns it, hands it over when the reader clicks the activity bar, and there is
 * exactly ONE of it per window. Nothing is shared between the two folders but the
 * repository they sit in; a fix wanted in both is applied twice, deliberately.
 *
 * What the shape costs, and what it buys:
 *  - ONE view, not one panel per room. A workspace with several control rooms switches the
 *    view between them instead of opening a second (see `showRoom`), and the room it was
 *    last pointed at is remembered so a reload comes back where it was.
 *  - No serialiser. VS Code does not restore a webview view, it re-resolves it through the
 *    provider, which is why the current room lives in globalState rather than in page state.
 *  - The view keeps its place while the editor gets on with code, which is the whole reason
 *    this variant exists.
 *
 * As in the tab version there is no server: the page's `fetch('/api/...')` calls are
 * intercepted in the webview and answered here, against chat.jsonl on disk.
 */
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { Log } = require('./log');
const { labels } = require('./sessions');
const hook = require('./hook');
const runtime = require('./runtime');
const diagnose = require('./diagnose');

const VIEW_ID = 'controlRoomSidebar.room';
const CONFIG = 'controlRoomSidebar';
const LAST_ROOM = 'controlRoomSidebar.lastRoom';

/** "control-room-medicover" -> "Control Room · medicover"; the plain one keeps its name. */
function instanceName(folder) {
  const suffix = folder.replace(/^control-room-?/, '');
  return suffix ? 'Control Room · ' + suffix : 'Control Room';
}

/** Every instance in this workspace: a folder of its own with a log in it.
 *
 * The setting, when set, names exactly one and nothing is discovered. Otherwise every
 * `control-room*` folder under the workspace root counts, so a second session's room is one
 * switch away rather than a settings edit. */
function instances() {
  const configured = vscode.workspace.getConfiguration(CONFIG).get('logPath');
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
    // lives inside the extension -- so looking only for those made a just-cloned room
    // invisible. reply.py is what makes a folder a room; the log is what a room accumulates.
    const isRoom = ['chat.jsonl', 'chat.html', 'reply.py'].some(f => fs.existsSync(path.join(dir, f)));
    if (!isRoom) continue;
    out.push({ dir, name: instanceName(entry.name) });
  }
  // Nothing here yet: name the folder the room WILL live in, rather than scattering a log
  // and four .py files over someone's project root.
  if (!out.length) return [{ dir: path.join(root, 'control-room'), name: 'Control Room' }];
  return out.sort((a, b) => a.dir.length - b.dir.length);
}

/** The transcript folder is a property of the WORKSPACE, not of the instance. */
function workspaceRoot(fallback) {
  return (vscode.workspace.workspaceFolders || [])[0]?.uri.fsPath || fallback;
}

/** The page, with a shim that turns fetch('/api/...') into a postMessage round trip.
 *
 * The extension ships its own chat.html so it works in any workspace; a copy sitting beside
 * the log wins, because that is the one being edited while developing. */
function pageHtml(extensionPath, dir, session, build) {
  const local = path.join(dir, 'chat.html');
  const bundled = path.join(extensionPath, 'chat.html');
  let html = fs.readFileSync(fs.existsSync(local) ? local : bundled, 'utf8');
  // the page compares its own build with the one the host reports and reloads when they
  // differ; an unreplaced placeholder guards that comparison out and serves a stale page
  html = html.replace('"__BUILD__"', JSON.stringify(String(build || '0')));
  const shim = `
<script>
  // The session may have been chosen in the palette, before the page existed. The page
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
      // the palette, or a room switch, can re-point the page at another session
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

/** Resume a session in a terminal rooted at the instance it answers for. */
function resumeIn(dir, sid) {
  // ⛔ NOT the room folder. Claude Code files a session under the directory it was started
  // in, and every session this view lists was read out of the WORKSPACE's project folder --
  // so `--resume` run from control-room/ looks for the id somewhere it was never written.
  // The room is still where the log is; the session-start hook finds it by heartbeat.
  const term = vscode.window.createTerminal({
    name: 'claude · ' + sid.slice(0, 8),
    cwd: workspaceRoot(dir),
  });
  term.show(true);
  term.sendText('claude --resume ' + sid);
}

/** Is a Claude Code tab already open in this window?
 *
 *  It cannot say WHICH session that tab holds -- the extension publishes no such thing --
 *  only that one exists. That is still worth knowing: a tab already open is a tab to bring
 *  forward rather than a reason to make another. */
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

/** Open the Claude Code extension in an editor tab.
 *
 * Its commands are not API and it may not be installed, so each is tried in turn and a
 * terminal is the last resort. Opening a tab does NOT start a session: Claude Code runs when
 * it is given something to do. */
async function openClaudeTab(dir) {
  // ⛔ ORDER MATTERS. `claude-vscode.editor.open` is "Open in New Tab" and does exactly
  // that, so pressing the button with a Claude tab already there made a SECOND one.
  // `editor.openLast` is the plain "Open": reuse first, create only if there is nothing to
  // reuse.
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
  const term = vscode.window.createTerminal({ name: 'claude · control room', cwd: dir });
  term.show(true);
  term.sendText("claude 'watch this control room and answer me in the panel'");
  return 'terminal';
}

/** Start a session WITHOUT the reader typing anything.
 *
 * ⛔ THIS IS THE SIDEBAR VARIANT'S OWN FEATURE, and it was taken back out of the tab
 * version at the reader's request: there, a terminal appearing by itself is in the way of
 * the code. Here the view has no editor group to be pushed out of, so the terminal is the
 * one thing that can actually start a session -- the native Claude tab is another
 * extension's webview, no command takes a prompt, and `type` does not reach a webview.
 *
 * The terminal is shown but NOT focused, on purpose. Hiding it would hide "you are not
 * logged in" too, and that is the one failure this path has.
 */
function startSessionInTerminal(dir, first) {
  // ⛔ cwd is the WORKSPACE, not the room: Claude files a session under the directory it
  // started in, and the hooks live in the workspace's .claude/. The room is found by the
  // .expect marker instead -- the same mechanism the "open a tab" button uses.
  try { fs.writeFileSync(path.join(dir, '.expect'), ''); } catch { /* read-only room */ }
  const term = vscode.window.createTerminal({
    name: 'claude · ' + path.basename(dir),
    cwd: workspaceRoot(dir),
  });
  term.show(true);                       // true = preserve focus, so the view keeps it
  term.sendText('claude ' + JSON.stringify(first));
  return term;
}

/** Said whenever the room is opened with nothing reading it: the one step people miss. */
const NO_SESSION = 'Control Room: no Claude session is watching this room yet. Open the Claude tab and send it any message — that starts the session that reads what you write here. Your messages are kept until then.';

function activate(context) {
  // the page reloads itself when this changes; in a webview the html is fixed for the life
  // of the view, so a constant is honest and a stat() of a moving file is not
  const BUILD = String(context.extension ? context.extension.packageJSON.version : '0');

  // ⛔ ONE view, so ONE mutable current room -- and every handler must read it through this
  // object rather than close over a dir. Capturing the dir at resolve time is how switching
  // rooms leaves a view drawing room B while answering for room A.
  const here = {
    view: null,
    dir: '',
    name: '',
    session: '',
    log: null,
    title: '',
  };

  const remembered = () => {
    const saved = context.globalState.get(LAST_ROOM);
    const found = instances();
    return found.find(i => i.dir === saved) || found[0];
  };

  /** Point the one view at a room. Same room: just re-address it, because reloading the
   *  page would throw away the conversation on screen for nothing. */
  const showRoom = (inst, session) => {
    context.globalState.update(LAST_ROOM, inst.dir);
    if (here.view && here.dir === inst.dir) {
      if (session) {
        here.session = session;
        here.view.webview.postMessage({ setTarget: session });
      }
      here.view.show(true);
      return;
    }
    here.dir = inst.dir;
    here.name = inst.name;
    here.session = session || '';
    here.log = new Log(inst.dir);
    if (here.view) {
      here.title = '';
      here.view.webview.html = pageHtml(context.extensionPath, here.dir, here.session, BUILD);
      here.view.show(true);
      setup(here.dir);
    }
  };

  /** A room nobody is watching looks identical to a working one until a message is ignored,
   *  so the view's own title says so. */
  const retitle = (watchers) => {
    if (!here.view) return;
    const want = here.name + (watchers.length ? '' : ' (no watcher)');
    if (want !== here.title) { here.title = want; here.view.title = want; }
  };

  /** Sessions with a live watch in some OTHER room of this workspace.
   *
   *  ⛔ A session listens to ONE room. The recipient menu lists every session that has ever
   *  written in this log -- including one the mirror put there by mistake -- so a session
   *  belonging to another room could be chosen, and every message addressed to it was
   *  skipped by the only watcher present. Knowing where the others are lets the page offer
   *  the one thing that helps: that room. */
  const elsewhere = (names, watching) => {
    const out = {};
    for (const inst of instances()) {
      if (inst.dir === here.dir) continue;
      for (const w of new Log(inst.dir).watchers(names)) {
        if (!watching.some(h => h.session === w.session)) out[w.session] = inst.name;
      }
    }
    return out;
  };

  /** Ids the reader has taken out of the strip. A missing or unreadable file means none. */
  const hiddenIds = () => {
    try {
      return fs.readFileSync(path.join(here.dir, '.hidden'), 'utf8')
        .split('\n').map(n => parseInt(n, 10)).filter(Number.isFinite);
    } catch {
      return [];
    }
  };

  /** The two things only this extension can do for a room, done rather than offered: the
   *  Python the watch needs, and the session-start hook that finds this room. */
  const setup = (dir) => {
    try {
      const added = runtime.install(context.extensionPath, dir);
      let hooked = false;
      const hookRoot = workspaceRoot(dir);
      const mirror = vscode.workspace.getConfiguration(CONFIG).get('mirrorEditorChat') !== false;
      if (!hook.installed(hookRoot) || !hook.current(hookRoot) || mirror) {
        hooked = !hook.install(hookRoot, mirror ? dir : null).already;   // a refresh is not news
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
        + (err && err.message || err) + '. The view still works.');
    }
  };

  const provider = {
    resolveWebviewView(view) {
      here.view = view;
      if (!here.dir) {
        const inst = remembered();
        here.dir = inst.dir;
        here.name = inst.name;
        here.log = new Log(inst.dir);
      }
      here.title = '';
      view.webview.options = { enableScripts: true };
      view.onDidDispose(() => { if (here.view === view) here.view = null; }, null, context.subscriptions);

      // ⛔ REGISTER THE HANDLER BEFORE ANYTHING THAT CAN FAIL. Everything in setup() touches
      // someone else's disk, and a throw there used to skip the registration entirely --
      // leaving a view that renders and silently swallows every message, which is
      // indistinguishable from a dead bridge.
      view.webview.onDidReceiveMessage(async (req) => {
        const reply = (data) => here.view === view && view.webview.postMessage({ id: req.id, data });
        try {
          const [route, query] = String(req.url).split('?');
          if (route === '/api/messages') {
            const since = parseInt(new URLSearchParams(query || '').get('since') || '0', 10) || 0;
            const messages = here.log.read(since);
            const names = await labels(workspaceRoot(here.dir));
            const watchers = here.log.watchers(names);
            retitle(watchers);
            return reply({
              messages,
              last: messages.length ? messages[messages.length - 1].id : since,
              build: BUILD,
              status: here.log.readStatus(),
              watch: here.log.watchAge(),
              hidden: hiddenIds(),
              watchers,
              elsewhere: elsewhere(names, watchers),
              room: here.name,
            });
          }
          if (route === '/api/sessions') {
            const names = await labels(workspaceRoot(here.dir));
            const watching = here.log.watchers(names);
            return reply({ sessions: names, watchers: watching, elsewhere: elsewhere(names, watching) });
          }
          if (route === '/api/resume') {
            // Only the editor can do this: give a dormant session a REAL window by resuming
            // it in a terminal you can watch and type into.
            const sid = (JSON.parse(req.body || '{}').session || '').trim();
            if (!/^[0-9a-f-]{36}$/.test(sid)) return reply({ error: 'not a session id' });
            resumeIn(here.dir, sid);
            return reply({ ok: true });
          }
          // Hide one reply from the timeline strip.
          //
          // ⛔ APPEND, NEVER REWRITE. Removing the line from chat.jsonl is the obvious
          // reading of "delete", and it is the one thing this project has already been burned
          // by: `tail -F` re-reads a truncated file from the top, so rewriting the log
          // replays every message into whatever watch is running. Delete a line from
          // `.hidden` to bring a thumbnail back.
          if (route === '/api/hide') {
            const id = parseInt(JSON.parse(req.body || '{}').id, 10);
            if (!Number.isFinite(id)) return reply({ error: 'not an id' });
            try {
              fs.appendFileSync(path.join(here.dir, '.hidden'), id + '\n');
            } catch {
              return reply({ error: 'could not write .hidden' });
            }
            return reply({ ok: true, id });
          }
          // Go to the room a session IS listening to, addressed to it.
          //
          // ⛔ THE SIDEBAR SWITCHES, IT DOES NOT OPEN. There is one view, so the tab
          // version's "open the other room and dispose of this panel" has nothing to
          // dispose: the same view is re-pointed instead, which is also what the reader
          // means by switching.
          if (route === '/api/open_room') {
            const sid = (JSON.parse(req.body || '{}').session || '').trim();
            if (!/^[0-9a-f-]{36}$/.test(sid)) return reply({ error: 'not a session id' });
            const names = await labels(workspaceRoot(here.dir));
            for (const inst of instances()) {
              if (inst.dir === here.dir) continue;
              if (new Log(inst.dir).watchers(names).some(w => w.session === sid)) {
                // answered BEFORE the switch: the page is told where it went while it can
                // still hear the answer, because the switch replaces it
                reply({ ok: true, room: inst.name, replaced: true });
                setTimeout(() => showRoom(inst, sid), 150);
                return;
              }
            }
            return reply({ error: 'no room is listening for that session' });
          }
          // Start a session on the reader's behalf. A terminal, because the Claude tab
          // cannot be typed into. Sidebar only -- see startSessionInTerminal.
          if (route === '/api/autostart') {
            const first = 'Watch this control room and answer me in the panel.';
            startSessionInTerminal(here.dir, first);
            view.show(true);                     // and put the room back in front
            return reply({ ok: true, how: 'terminal', sent: first });
          }
          if (route === '/api/start') {
            // ⛔ ASK FIRST. The button opened a tab whatever the state was -- including when
            // the session just chosen was already running and reading this very log. Nothing
            // needed opening; the answer was "it is already there, write here".
            const want = (JSON.parse(req.body || '{}').session || '').trim();
            if (want) {
              const names = await labels(workspaceRoot(here.dir));
              if (here.log.watchers(names).some(w => w.session === want)) {
                try { await vscode.commands.executeCommand('claude-vscode.focus'); } catch { /* optional */ }
                return reply({ ok: true, how: 'already' });
              }
            }
            // ⛔ SAY WHICH ROOM ASKED. A session that has never run has no heartbeat, so the
            // hooks fall back to the first room by name -- and a fresh tab attached itself to
            // that one instead, wrote its turns there, and left this room silent. This file
            // is the request: the newest one still unclaimed wins, and only for a few minutes.
            try { fs.writeFileSync(path.join(here.dir, '.expect'), ''); } catch { /* read-only room */ }
            return reply({ ok: true, how: await openClaudeTab(here.dir) });
          }
          if (route === '/api/send') {
            const body = JSON.parse(req.body || '{}');
            const text = (body.text || '').trim();
            if (!text) return reply({ error: 'empty message' });
            return reply(here.log.append('user', text, (body.to || '').trim() || null));
          }
          reply({ error: 'not found' });
        } catch (err) {
          reply({ error: String(err && err.message || err) });
        }
      }, null, context.subscriptions);

      view.webview.html = pageHtml(context.extensionPath, here.dir, here.session, BUILD);
      setup(here.dir);
    },
  };

  context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
    // ⛔ the view is hidden every time the reader looks at another sidebar, and without this
    // the page is torn down and rebuilt each time -- losing the reply on screen, the open
    // card and the half-typed message.
    webviewOptions: { retainContextWhenHidden: true },
  }));

  /** Ask which SESSION, the way Claude Code's own picker asks: by what the session opened
   *  with. A control room is a folder on disk, which is not what anyone has in mind when
   *  they open this -- they want to talk to a particular Claude. */
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
      // a room nobody is listening to is still worth reading, and the session can be resumed
      // from inside it -- but it must not look like a live one
      if (!watching.length) {
        items.push({
          label: inst.name,
          description: 'no session is listening',
          detail: 'Open the Claude tab and send it any message — that starts the session that reads this room.',
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

  // Bring the view forward. `<viewId>.focus` is contributed by VS Code itself; this one is
  // the palette entry that reads as an answer to "where did it go".
  context.subscriptions.push(vscode.commands.registerCommand('controlRoomSidebar.show', async () => {
    await vscode.commands.executeCommand(VIEW_ID + '.focus');
    if (here.view) here.view.show(true);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('controlRoomSidebar.pickSession', async () => {
    const picked = await pickSession('Which session do you want to talk to?');
    if (!picked) return;
    await vscode.commands.executeCommand(VIEW_ID + '.focus');
    showRoom(picked.inst, picked.session);
  }));

  // ⛔ this called an installHook() that no longer existed -- it was removed when the hook
  // stopped being offered and started being installed. The command threw.
  context.subscriptions.push(vscode.commands.registerCommand('controlRoomSidebar.installHook', () => {
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

  // "the bridge does not work" is four faults wearing one face; this names which
  context.subscriptions.push(vscode.commands.registerCommand('controlRoomSidebar.diagnose', async () => {
    const found = instances();
    const root = workspaceRoot(found[0].dir);
    const text = diagnose.report({
      version: context.extension ? context.extension.packageJSON.version : '?',
      root,
      rooms: found.map(i => i.dir),
      runtimeFiles: runtime.FILES,
      hookInstalled: hook.installed(root),
      hookPath: path.join(root, '.claude', 'settings.json'),
    });
    const doc = await vscode.workspace.openTextDocument({ content: text, language: 'plaintext' });
    await vscode.window.showTextDocument(doc, { preview: false });
  }));

  // the same thing the page offers, for when the view is not where you are looking
  context.subscriptions.push(vscode.commands.registerCommand('controlRoomSidebar.resume', async () => {
    const found = instances();
    const names = await labels(workspaceRoot(found[0].dir));
    const picked = await vscode.window.showQuickPick(
      Object.entries(names).map(([id, label]) => ({ label: label.slice(0, 80), description: id.slice(0, 8), id })),
      { placeHolder: 'Which session should be resumed in a terminal?' });
    if (!picked) return;
    const room = await pickSession('Which control room should it answer?');
    resumeIn((room && room.inst.dir) || found[0].dir, picked.id);
  }));

  // A window already running keeps the extension it started with, and nothing on the command
  // line can reload it -- but a URI can, because opening one activates this extension.
  // `code --open-url vscode://wiiiktor.control-room-sidebar/reload` is then the terminal
  // command for a menu step that otherwise has to be clicked.
  if (vscode.window.registerUriHandler) {
    context.subscriptions.push(vscode.window.registerUriHandler({
      handleUri(uri) {
        if (uri.path === '/reload') return vscode.commands.executeCommand('workbench.action.reloadWindow');
        if (uri.path === '/open') return vscode.commands.executeCommand('controlRoomSidebar.show');
        if (uri.path === '/diagnose') return vscode.commands.executeCommand('controlRoomSidebar.diagnose');
      },
    }));
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
