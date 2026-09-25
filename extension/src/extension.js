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
const runtime = require('./runtime');
const diagnose = require('./diagnose');

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

/** Resume a session in a terminal rooted at the instance it answers for. */
function resumeIn(dir, sid) {
  const term = vscode.window.createTerminal({ name: 'claude · ' + sid.slice(0, 8), cwd: dir });
  term.show(true);
  term.sendText('claude --resume ' + sid);
}

/** Open the Claude Code extension in an editor tab.
 *
 * Its commands are not API and it may not be installed, so each is tried in turn and a
 * terminal is the last resort. Opening a tab does NOT start a session: Claude Code runs
 * when it is given something to do, so the caller has to say "now type in it".
 */
async function openClaudeTab(dir) {
  for (const cmd of ['claude-vscode.editor.open', 'claude-vscode.editor.openLast',
                     'claude-vscode.newConversation']) {
    try {
      await vscode.commands.executeCommand(cmd);
      try { await vscode.commands.executeCommand('claude-vscode.focus'); } catch { /* optional */ }
      return 'tab';
    } catch { /* not this one; try the next */ }
  }
  // no extension to talk to -- a terminal session at least reads the same log
  const term = vscode.window.createTerminal({ name: 'claude · control room', cwd: dir });
  term.show(true);
  term.sendText("claude 'watch this control room and answer me in the panel'");
  return 'terminal';
}

/** Said whenever a panel is opened with nothing reading it: the one step people miss. */
const NO_SESSION = 'Control Room: no Claude session is watching this panel yet. Open the Claude tab and send it any message — that starts the session that reads what you write here. Your messages are kept until then.';

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

    // a panel nobody is watching looks identical to a working one until a message is
    // ignored, so the tab itself says so
    let title = name;
    const retitle = (watchers) => {
      const want = name + (watchers.length ? '' : ' (no watcher)');
      if (want !== title) { title = want; panel.title = want; }
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
        if (route === '/api/start') {
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
    panel.webview.html = pageHtml(context.extensionPath, dir, session);
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

  // Opening the workspace is enough: the panel is the point of installing this, and a
  // panel nobody opened helps nobody. Off with one setting for people who want it quiet.
  if (vscode.workspace.getConfiguration('controlRoom').get('openOnStartup') !== false) {
    const found = instances();
    if (found.length === 1) open(found[0], '');
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
    });
    const doc = await vscode.workspace.openTextDocument({ content: text, language: 'plaintext' });
    await vscode.window.showTextDocument(doc, { preview: false });
  }));

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
