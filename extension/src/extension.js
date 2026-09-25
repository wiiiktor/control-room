'use strict';
/**
 * Control Room as a VS Code webview.
 *
 * The browser version talks to a small Python server over localhost. Here there is no
 * server: the page's `fetch` calls are intercepted in the webview and answered by the
 * extension host, which reads and writes chat.jsonl directly. chat.html is loaded
 * unchanged, so one file serves both front ends.
 */
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { Log } = require('./log');
const { labels } = require('./sessions');

/** Where the log lives: the setting, else <workspace>/control-room, else <workspace>. */
function logDir() {
  const configured = vscode.workspace.getConfiguration('controlRoom').get('logPath');
  if (configured) return path.dirname(configured);
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) return process.cwd();
  const root = folders[0].uri.fsPath;
  const nested = path.join(root, 'control-room');
  return fs.existsSync(path.join(nested, 'chat.html')) ? nested : root;
}

/** The page, with a shim that turns fetch('/api/...') into a postMessage round trip.
 *
 * The extension ships its own chat.html so it works in any workspace; a copy sitting
 * beside the log wins, because that is the one being edited while developing. */
function pageHtml(extensionPath, dir) {
  const local = path.join(dir, 'chat.html');
  const bundled = path.join(extensionPath, 'chat.html');
  let html = fs.readFileSync(fs.existsSync(local) ? local : bundled, 'utf8');
  const shim = `
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

function activate(context) {
  let panel = null;
  // the page reloads itself when this changes; in a webview the html is fixed for the
  // life of the panel, so a constant is honest and a stat() of a moving file is not
  const BUILD = String(context.extension ? context.extension.packageJSON.version : '0');

  const open = () => {
    if (panel) { panel.reveal(vscode.ViewColumn.Active); return; }
    const dir = logDir();
    const log = new Log(dir);
    panel = vscode.window.createWebviewPanel(
      'controlRoom', 'Control Room', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    panel.webview.html = pageHtml(context.extensionPath, dir);
    panel.onDidDispose(() => { panel = null; }, null, context.subscriptions);

    panel.webview.onDidReceiveMessage(async (req) => {
      const reply = (data) => panel && panel.webview.postMessage({ id: req.id, data });
      try {
        const [route, query] = String(req.url).split('?');
        if (route === '/api/messages') {
          const since = parseInt(new URLSearchParams(query || '').get('since') || '0', 10) || 0;
          const messages = log.read(since);
          const names = await labels((vscode.workspace.workspaceFolders || [])[0]?.uri.fsPath || dir);
          return reply({
            messages,
            last: messages.length ? messages[messages.length - 1].id : since,
            build: BUILD,
            status: log.readStatus(),
            watch: log.watchAge(),
            watchers: log.watchers(names),
          });
        }
        if (route === '/api/sessions') {
          const names = await labels((vscode.workspace.workspaceFolders || [])[0]?.uri.fsPath || dir);
          return reply({ sessions: names, watchers: log.watchers(names) });
        }
        if (route === '/api/resume') {
          // Only the editor can do this: give a dormant session a REAL window by
          // resuming it in a terminal you can watch and type into.
          const body = JSON.parse(req.body || '{}');
          const sid = (body.session || '').trim();
          if (!/^[0-9a-f-]{36}$/.test(sid)) return reply({ error: 'not a session id' });
          const term = vscode.window.createTerminal({ name: 'claude · ' + sid.slice(0, 8), cwd: dir });
          term.show(true);
          term.sendText('claude --resume ' + sid);
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

  context.subscriptions.push(vscode.commands.registerCommand('controlRoom.open', open));

  // the same thing from the palette, for when the panel is not the place you are looking
  context.subscriptions.push(vscode.commands.registerCommand('controlRoom.resume', async () => {
    const dir = logDir();
    const root = (vscode.workspace.workspaceFolders || [])[0]?.uri.fsPath || dir;
    const names = await labels(root);
    const picked = await vscode.window.showQuickPick(
      Object.entries(names).map(([id, label]) => ({ label: label.slice(0, 80), description: id.slice(0, 8), id })),
      { placeHolder: 'Which session should be resumed in a terminal?' });
    if (!picked) return;
    const term = vscode.window.createTerminal({ name: 'claude · ' + picked.id.slice(0, 8), cwd: dir });
    term.show(true);
    term.sendText('claude --resume ' + picked.id);
  }));
}

function deactivate() {}

module.exports = { activate, deactivate };
