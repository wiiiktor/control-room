'use strict';
/**
 * "The bridge does not work" is four different faults wearing one face: no room, no
 * Python, no hook, or no session. This reports all four at once, in a document you can
 * read or paste to someone who cannot see your machine.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

function pythonReport() {
  for (const exe of ['python3', 'python']) {
    try {
      const out = cp.execFileSync(exe, ['-V'], { encoding: 'utf8', timeout: 5000 }).trim();
      const where = cp.execFileSync(process.platform === 'win32' ? 'where' : 'which',
        [exe], { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0];
      return `${exe}: ${out}  (${where})`;
    } catch { /* try the next name */ }
  }
  return 'python3: NOT FOUND — watch.py and reply.py cannot run';
}

function ageOf(file) {
  try {
    const s = Math.round((Date.now() - fs.statSync(file).mtimeMs) / 1000);
    // 90s is the panel's own threshold: past it the watch is gone, not slow
    return `${s}s ago${s > 90 ? '  ← STALE, that session is not listening' : ''}`;
  } catch {
    return 'never';
  }
}

/** @returns {string} the whole report */
function report({ version, root, rooms, runtimeFiles, hookInstalled, hookPath }) {
  const L = [];
  L.push('CONTROL ROOM — diagnostics', '='.repeat(26), '');
  L.push(`extension   ${version}`);
  L.push(`platform    ${process.platform}`);
  L.push(`workspace   ${root}`);
  L.push(`${pythonReport()}`);
  L.push('');
  L.push(`hook        ${hookInstalled ? 'installed' : 'NOT INSTALLED'}  (${hookPath})`);
  L.push('');
  for (const dir of rooms) {
    L.push(`room        ${dir}`);
    L.push(`  exists    ${fs.existsSync(dir)}`);
    for (const f of runtimeFiles.concat(['chat.jsonl'])) {
      L.push(`  ${f.padEnd(12)}${fs.existsSync(path.join(dir, f)) ? 'yes' : 'MISSING'}`);
    }
    let watchers = [];
    try {
      watchers = fs.readdirSync(dir).filter(n => n.startsWith('.watch.'));
    } catch { /* no room yet */ }
    L.push(`  watchers  ${watchers.length ? '' : 'NONE — no Claude session is reading this log'}`);
    for (const w of watchers) {
      L.push(`    ${w.slice('.watch.'.length, '.watch.'.length + 8)}  last beat ${ageOf(path.join(dir, w))}`);
    }
    // the tail says whether the panel is writing where the watch is reading
    try {
      const lines = fs.readFileSync(path.join(dir, 'chat.jsonl'), 'utf8').trim().split('\n');
      L.push(`  messages  ${lines.length}`);
      for (const line of lines.slice(-3)) {
        try {
          const m = JSON.parse(line);
          L.push(`    #${m.id} ${m.ts} ${m.role}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 60)}`);
        } catch { /* half-written line */ }
      }
    } catch {
      L.push('  messages  none yet');
    }
    L.push('');
  }
  L.push('What each failure looks like:');
  L.push('  reply.py MISSING      the panel works, nothing can answer in it');
  L.push('  hook NOT INSTALLED    a session will not arm the watch by itself');
  L.push('  watchers NONE         open a Claude tab in THIS window and send it any message');
  L.push('  messages in the wrong room   the panel is writing somewhere else; reopen the panel');
  return L.join('\n');
}

module.exports = { report };
