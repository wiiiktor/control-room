'use strict';
/** U4 session-start gating, U5 mirror, U6 catch-up -- run against the real generated scripts. */
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const hook = require('../../extension/src/hook');
const REPO = path.join(__dirname, '..', '..');

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ws-'));
  const room = path.join(ws, 'control-room');
  fs.mkdirSync(room);
  for (const f of ['chatlog.py', 'reply.py', 'watch.py', 'status.py']) fs.copyFileSync(path.join(REPO, f), path.join(room, f));
  fs.writeFileSync(path.join(ws, 'watch-hook.py'), hook.hookSource(ws));
  fs.writeFileSync(path.join(ws, 'mirror-hook.py'), hook.mirrorSource(ws));
  return { ws, room };
}
function runHook(script, input, env = {}) {
  const r = cp.spawnSync('python3', [script], { input: JSON.stringify(input),
    env: Object.assign({}, process.env, { CONTROL_ROOM_HOST: '', CONTROL_ROOM_HOST_PID: '' }, env) });
  return String(r.stdout);
}
const SID = '11111111-2222-3333-4444-555555555555';
const told = (out) => out.includes('Arm it now with the Monitor tool');

module.exports = {
  'U4 a session running in the room is told to watch': (t) => {
    const { ws, room } = workspace();
    t.ok(told(runHook(path.join(ws, 'watch-hook.py'), { session_id: SID, cwd: room })));
  },
  "U4 the reader's own conversation in the workspace is not": (t) => {
    const { ws } = workspace();
    t.eq(runHook(path.join(ws, 'watch-hook.py'), { session_id: SID, cwd: ws }), '');
  },
  'U4 ... unless the room has just asked for a session (.expect)': (t) => {
    const { ws, room } = workspace();
    fs.writeFileSync(path.join(room, '.expect'), '');
    t.ok(told(runHook(path.join(ws, 'watch-hook.py'), { session_id: SID, cwd: ws })));
  },
  'U4 a Claude-window session is never told, even in the room or with .expect': (t) => {
    const { ws, room } = workspace();
    fs.writeFileSync(path.join(room, '.expect'), '');
    // the hook's parent is this node process: the wrapper's pid, as far as the hook can tell
    const out = runHook(path.join(ws, 'watch-hook.py'), { session_id: SID, cwd: room },
      { CONTROL_ROOM_HOST: 'claude-window', CONTROL_ROOM_HOST_PID: String(process.pid) });
    t.eq(out, '');
  },
  "U4 a marker inherited from the daemon (another process's pid) is ignored": (t) => {
    const { ws, room } = workspace();
    const out = runHook(path.join(ws, 'watch-hook.py'), { session_id: SID, cwd: room },
      { CONTROL_ROOM_HOST: 'claude-window', CONTROL_ROOM_HOST_PID: '1' });
    t.ok(told(out));
  },
  'U5 the mirror takes the reply from last_assistant_message': (t) => {
    const { ws, room } = workspace();
    fs.writeFileSync(path.join(room, '.watch.' + SID), '');
    const tr = path.join(ws, 't.jsonl');
    fs.writeFileSync(tr, JSON.stringify({ message: { role: 'user', content: 'q' } }) + '\n');   // reply not written yet
    runHook(path.join(ws, 'mirror-hook.py'), { hook_event_name: 'Stop', session_id: SID, transcript_path: tr,
      last_assistant_message: 'the fresh answer' });
    const last = fs.readFileSync(path.join(room, 'chat.jsonl'), 'utf8').trim().split('\n').pop();
    t.ok(last.includes('the fresh answer') && last.includes('"mirror": true'));
  },
  'U5 a stale transcript is never mirrored as the answer': (t) => {
    const { ws, room } = workspace();
    fs.writeFileSync(path.join(room, '.watch.' + SID), '');
    const tr = path.join(ws, 't.jsonl');
    fs.writeFileSync(tr, [{ message: { role: 'user', content: 'q1' } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'OLD ANSWER' }] } },
      { message: { role: 'user', content: 'q2' } }].map(JSON.stringify).join('\n') + '\n');
    const t0 = Date.now();
    runHook(path.join(ws, 'mirror-hook.py'), { hook_event_name: 'Stop', session_id: SID, transcript_path: tr });
    let log = ''; try { log = fs.readFileSync(path.join(room, 'chat.jsonl'), 'utf8'); } catch { /* none */ }
    t.ok(!log.includes('OLD ANSWER'), 'old answer not mirrored'); t.ok(Date.now() - t0 < 9000, 'gave up in time');
  },
  'U6 notices and mirrored lines do not count as answers (catch-up)': (t) => {
    const { room } = workspace();
    const lines = [{ id: 1, role: 'assistant', text: 'old', session: 'x' },
      { id: 2, role: 'user', text: 'the question', to: SID },
      { id: 3, role: 'assistant', text: '::err nobody answered' },                   // extension notice
      { id: 4, role: 'assistant', text: 'tab copy', session: 'y', mirror: true }];  // mirrored
    fs.writeFileSync(path.join(room, 'chat.jsonl'), lines.map(JSON.stringify).join('\n') + '\n');
    const out = String(cp.spawnSync('python3', [path.join(room, 'watch.py')], { cwd: room, input: '',
      env: Object.assign({}, process.env, { CLAUDE_CODE_SESSION_ID: SID }) }).stdout);
    t.ok(out.includes('#2') && out.includes('missed'), out);
  },
};
