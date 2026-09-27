'use strict';
/** U1: the wrapper releases exactly the conversation being resumed, and only a background one;
 *  handoff.decide/configure never overwrite a wrapper the reader set themselves. */
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fake = require('./fake-vscode');
const handoff = require('../../extension/src/handoff');
const WRAPPER = path.join(__dirname, '..', '..', 'extension', 'handoff', 'claude-handoff');

// a fake `claude`: `stop <short>` succeeds only for ids in FAKE_BG (background sessions); any other
// call prints what it was run with, so the test can see the exec happened untouched
function fakeClaude(dir) {
  const f = path.join(dir, 'claude');
  fs.writeFileSync(f, '#!/bin/sh\nif [ "$1" = stop ]; then case " $FAKE_BG " in *" $2 "*) exit 0;; esac; ' +
    'echo "No job matching $2" >&2; exit 1; fi\necho "EXEC $* HOST=$CONTROL_ROOM_HOST"\n', { mode: 0o755 });
  return f;
}
function run(args, bg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-handoff-'));
  const claude = fakeClaude(dir);
  const out = cp.execFileSync(WRAPPER, [claude, ...args],
    { cwd: dir, env: Object.assign({}, process.env, { FAKE_BG: bg || '', CONTROL_ROOM_STATE: dir }) }).toString();
  let log = '';
  try { log = fs.readFileSync(path.join(dir, 'handoff.log'), 'utf8'); } catch { /* none */ }
  return { out, log };
}
const SID = '0619e261-68ca-4805-b0f9-a5aa65fdc496';

module.exports = {
  'releases a background session resumed as --resume <id>': (t) => {
    const r = run(['--resume', SID, '-p', 'hi'], '0619e261');
    t.ok(r.log.includes('released ' + SID), 'logged'); t.ok(r.out.includes('EXEC --resume ' + SID + ' -p hi'), 'exec untouched');
  },
  'releases on --resume=<id> (the form the Claude extension uses)': (t) => {
    t.ok(run(['--output-format', 'stream-json', '--resume=' + SID], '0619e261').log.includes('released'));
  },
  'releases on -r <id>': (t) => { t.ok(run(['-r', SID], '0619e261').log.includes('released')); },
  'does nothing for a conversation no background session holds': (t) => {
    const r = run(['--resume', SID], ''); t.eq(r.log, '', 'no release'); t.ok(r.out.includes('EXEC --resume ' + SID));
  },
  'does nothing for a bare --resume (the picker) followed by a flag': (t) => {
    t.eq(run(['--resume', '-p', 'x'], '0619e261').log, '');
  },
  'does nothing without --resume': (t) => { t.eq(run(['auth', 'status', '--json'], '0619e261').log, ''); },
  'marks the session as hosted by the Claude window': (t) => { t.ok(run(['--version']).out.includes('HOST=claude-window')); },
  'decide: sets the wrapper when none is configured': (t) => {
    t.eq(handoff.decide({ enabled: true, current: '', ours: '/h/claude-handoff', platform: 'darwin' }).action, 'set');
  },
  'decide: never replaces a wrapper the reader set': (t) => {
    t.eq(handoff.decide({ enabled: true, current: '/usr/local/bin/corp-launcher', ours: '/h/claude-handoff', platform: 'darwin' }).action, 'foreign');
  },
  'decide: turning it off clears only our own': (t) => {
    t.eq(handoff.decide({ enabled: false, current: '/h/claude-handoff', ours: '/h/claude-handoff', platform: 'darwin' }).action, 'clear');
    t.eq(handoff.decide({ enabled: false, current: '/x/corp', ours: '/h/claude-handoff', platform: 'darwin' }).action, 'keep');
  },
  'decide: an older copy of ours at another path is updated': (t) => {
    t.eq(handoff.decide({ enabled: true, current: '/old/place/claude-handoff', ours: '/h/claude-handoff', platform: 'darwin' }).action, 'set');
  },
  'installWrapper copies to a stable path, executable, idempotent': (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-bin-'));
    const ext = path.join(__dirname, '..', '..', 'extension');
    const p1 = handoff.installWrapper(ext, dir), m1 = fs.statSync(p1).mtimeMs;
    const p2 = handoff.installWrapper(ext, dir);
    t.eq(p1, p2); t.eq(fs.statSync(p2).mtimeMs, m1, 'not rewritten when identical');
    t.ok(fs.statSync(p1).mode & 0o100, 'executable');
  },
  'configure writes claudeCode.claudeProcessWrapper globally': async (t) => {
    process.env.CONTROL_ROOM_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-state-'));
    const vscode = fake.current();
    const r = await handoff.configure(vscode, path.join(__dirname, '..', '..', 'extension'));
    t.eq(r.action, 'set');
    t.eq(fake.state.updates[0].key, 'claudeCode.claudeProcessWrapper'); t.eq(fake.state.updates[0].target, 1);
    t.ok(fs.existsSync(fake.state.updates[0].value), 'points at an existing file');
    t.ok(fake.state.updates[0].value.startsWith(process.env.CONTROL_ROOM_STATE), 'inside the state dir');
    delete process.env.CONTROL_ROOM_STATE;
  },
};
