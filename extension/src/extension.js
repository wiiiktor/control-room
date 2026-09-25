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
const { Log } = require('./log');
const { labels } = require('./sessions');
const hook = require('./hook');

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
    // a chat.html may be a symlink to the original; a chat.jsonl never is
    if (!fs.existsSync(path.join(dir, 'chat.jsonl')) && !fs.existsSync(path.join(dir, 'chat.html'))) continue;
    out.push({ dir, name: instanceName(entry.name) });
  }
  if (!out.length) return [{ dir: root, name: 'Control Room' }];
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
function pageHtml(extensionPath, dir, session) {
  const local = path.join(dir, 'chat.html');
  const bundled = path.join(extensionPath, 'chat.html');
  let html = fs.readFileSync(fs.existsSync(local) ? local : bundled, 'utf8');
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
    // the page uses this to offer things only the editor can do, like opening a terminal
    window.CONTROL_ROOM_HOST = 'extension';
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

/** Resume a session in a terminal rooted at the instance it answers for. */
function resumeIn(dir, sid) {
  const term = vscode.window.createTerminal({ name: 'claude · ' + sid.slice(0, 8), cwd: dir });
  term.show(true);
  term.sendText('claude --resume ' + sid);
}

function activate(context) {
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
    const dir = inst.dir;
    const log = new Log(dir);
    const panel = vscode.window.createWebviewPanel(
      'controlRoom', inst.name, vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    panels.set(dir, panel);
    panel.webview.html = pageHtml(context.extensionPath, dir, session);
    panel.onDidDispose(() => { panels.delete(dir); }, null, context.subscriptions);

    // a panel nobody is watching looks identical to a working one until a message is
    // ignored, so the tab itself says so
    let title = inst.name;
    const retitle = (watchers) => {
      const want = inst.name + (watchers.length ? '' : ' (no watcher)');
      if (want !== title) { title = want; panel.title = want; }
    };

    // asked once per workspace: a panel with nothing watching it is the failure people
    // report as "I write and nothing happens"
    if (!hook.installed(workspaceRoot(dir)) && !context.globalState.get('hookOffered:' + dir)) {
      context.globalState.update('hookOffered:' + dir, true);
      vscode.window.showInformationMessage(
        'Control Room: install a session-start hook so Claude starts watching this panel by itself?',
        'Install', 'Not now',
      ).then(choice => { if (choice === 'Install') installHook(false); });
    }

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
            watchers,
          });
        }
        if (route === '/api/sessions') {
          const names = await labels(workspaceRoot(dir));
          return reply({ sessions: names, watchers: log.watchers(names) });
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
    for (const inst of found) {
      const live = new Log(inst.dir).watchers(names);
      for (const w of live) {
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
      if (!live.length) {
        items.push({
          label: inst.name,
          description: 'no session listening',
          detail: inst.dir,
          inst,
          session: '',
        });
      }
    }
    if (items.length === 1) return items[0];
    const picked = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true });
    return picked || null;
  };

  /** Write the SessionStart hook that re-arms the watch. Without it the panel goes
   *  quiet after every Claude restart and only a human notices. */
  const installHook = async (quiet) => {
    const root = workspaceRoot(instances()[0].dir);
    try {
      const out = hook.install(root);
      vscode.window.showInformationMessage(out.already
        ? 'Control Room: the session-start hook was already installed; its script was refreshed.'
        : 'Control Room: session-start hook installed. It takes effect the next time a Claude session starts in this workspace.');
      return out;
    } catch (err) {
      if (!quiet) vscode.window.showErrorMessage('Control Room: could not install the hook — ' + (err && err.message || err));
      return null;
    }
  };

  context.subscriptions.push(vscode.commands.registerCommand('controlRoom.installHook', () => installHook(false)));

  context.subscriptions.push(vscode.commands.registerCommand('controlRoom.open', async () => {
    const picked = await pickSession('Which session do you want to talk to?');
    if (picked) open(picked.inst, picked.session);
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
