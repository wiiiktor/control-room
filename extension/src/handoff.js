'use strict';
/**
 * The handoff wrapper: installed at a stable path and set as the Claude extension's
 * `claudeCode.claudeProcessWrapper`, so a conversation the room holds in the background is released
 * before the Claude window resumes it -- instead of the window failing with "exited with code 1".
 * The wrapper itself (handoff/claude-handoff) says why in detail.
 *
 * ⛔ A STABLE PATH, NOT THE EXTENSION'S OWN FOLDER. That folder is named after the version and is
 * deleted after an update, and the setting lives on in the reader's settings.json -- pointing at it
 * would leave every Claude window failing to start after the next update.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME = 'claude-handoff';

function stableDir() {
  // CONTROL_ROOM_STATE is what the wrapper itself uses for its log; tests point both at a temp dir
  return path.join(process.env.CONTROL_ROOM_STATE || path.join(os.homedir(), '.claude', 'control-room'), 'bin');
}

/** Copy the shipped wrapper to the stable path when it differs. Returns that path. */
function installWrapper(extensionPath, dir = stableDir()) {
  const src = path.join(extensionPath, 'handoff', NAME);
  const dest = path.join(dir, NAME);
  const body = fs.readFileSync(src);
  let same = false;
  try { same = fs.readFileSync(dest).equals(body); } catch { /* not there yet */ }
  if (!same) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = dest + '.' + process.pid;
    fs.writeFileSync(tmp, body, { mode: 0o755 });
    fs.renameSync(tmp, dest);                  // never a half-written wrapper for claude to exec
  }
  fs.chmodSync(dest, 0o755);
  return dest;
}

/** What to do with the setting, decided without touching anything -- the part worth testing.
 *  @returns {{action: 'set'|'clear'|'keep'|'foreign'|'unsupported', path?: string}} */
function decide({ enabled, current, ours, platform }) {
  const isOurs = !!current && (current === ours || path.basename(current) === NAME);
  if (platform === 'win32') return { action: isOurs ? 'clear' : 'unsupported' };   // it is a sh script
  if (!enabled) return { action: isOurs ? 'clear' : 'keep' };
  if (current && !isOurs) return { action: 'foreign', path: current };            // never overwrite theirs
  return { action: current === ours ? 'keep' : 'set', path: ours };
}

/** Install and configure. `vscode` is passed in so this can be exercised with a fake. */
async function configure(vscode, extensionPath) {
  const enabled = vscode.workspace.getConfiguration('controlRoom').get('claudeWindowHandoff') !== false;
  const cfg = vscode.workspace.getConfiguration('claudeCode');
  const current = cfg.get('claudeProcessWrapper') || '';
  let ours = path.join(stableDir(), NAME);
  if (enabled && process.platform !== 'win32') {
    try { ours = installWrapper(extensionPath); } catch (err) { return { action: 'error', why: String(err && err.message || err) }; }
  }
  const d = decide({ enabled, current, ours, platform: process.platform });
  if (d.action === 'set') await cfg.update('claudeProcessWrapper', ours, vscode.ConfigurationTarget.Global);
  if (d.action === 'clear') await cfg.update('claudeProcessWrapper', undefined, vscode.ConfigurationTarget.Global);
  return d;
}

module.exports = { configure, decide, installWrapper, stableDir, NAME };
