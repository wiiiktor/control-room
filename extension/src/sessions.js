'use strict';
/**
 * Claude Code session labels.
 *
 * Claude Code does not name a session: what its picker shows as a title is the message
 * the session opened with, so that is what this reads. Only the head of each transcript
 * is parsed — one of them is 450 MB.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

function projectDir(workspacePath) {
  // Claude Code encodes the project path by replacing every separator with a dash
  const slug = workspacePath.replace(/[/\\]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', slug);
}

// \u26d4 THE OPENING MESSAGE IS NOT ALWAYS A MESSAGE. Since the panel started sessions by
// handing `claude` a first prompt, every session it woke opens with the SAME machine sentence --
// so the picker filled up with identical rows and named none of them. A prompt the reader did
// not type is skipped and the scan goes on; it is only used as a label when the transcript holds
// nothing else, because a row with no name at all is worse.
const NOT_A_NAME = [
  'Watch this control room and answer me in the panel.',
  '<task-notification>',
  '<system-reminder>',
  '<local-command-stdout>',
  '<command-name>',
  '[SYSTEM NOTIFICATION',
  'Caveat: The messages below were generated',
  'Another Claude session sent a message:',
];

function typedByHand(text) {
  const head = text.trimStart();
  return !NOT_A_NAME.some(m => head.startsWith(m));
}

async function firstLine(file) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let i = 0;
  let machine = '';          // the best we have if nothing was typed by hand
  try {
    for await (const line of rl) {
      if (++i > 40) break;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      if (d.type === 'summary' && d.summary) return d.summary;
      const m = d.message || {};
      if (m.role === 'user') {
        const c = m.content;
        const text = typeof c === 'string' ? c : (Array.isArray(c) && c.length ? (c[0].text || '') : '');
        if (!text) continue;
        if (typedByHand(text)) return text;
        if (!machine) machine = text;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  // Nothing in it was typed by hand: it was woken by the panel, or driven by another session.
  // Saying so beats quoting the machinery back as a name -- and the row already carries the
  // session's short id, which is what tells two of these apart.
  return machine ? '(nothing was typed in this session)' : '';
}

/** The title the Claude window gives a conversation: its latest `ai-title` entry, from the tail.
 *
 * \u2b50 NAME SESSIONS THE WAY THE CLAUDE WINDOW DOES. "I don't know which session is 8ef64249": the
 * panel named a session by its id or first message, the Claude window by an `aiTitle` ("uncommitted
 * changes review") -- two names for one thing. The title is rewritten as the conversation goes on, so
 * the newest one is at the END of the transcript; only the last 256 KB is read. */
function aiTitle(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 262144);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"ai-title"')) continue;
      try {
        const d = JSON.parse(lines[i]);
        if (d.type === 'ai-title' && d.aiTitle) return String(d.aiTitle);
      } catch { /* a line cut by the window */ }
    }
  } catch { /* unreadable */ } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ }
  }
  return '';
}

// \u26d4 THE PAGE ASKS EVERY SECOND. Reading every transcript's head and tail on each poll is what
// a label must not cost, so one is worked out once per version of the file (size + mtime).
const labelCache = new Map();
async function labelOf(file, st) {
  const key = st.size + ':' + st.mtimeMs;
  const hit = labelCache.get(file);
  if (hit && hit.key === key) return hit.label;
  const label = (aiTitle(file) || await firstLine(file)).replace(/\s+/g, ' ').slice(0, 90) || '(empty)';
  labelCache.set(file, { key, label });
  return label;
}

/** Session labels for the workspace AND any extra folders -- the rooms, where new room sessions
 *  are filed so they never appear in the Claude window's own list. Newest first overall. */
async function labels(workspacePath, ...extra) {
  const all = [];
  for (const p of [workspacePath].concat(extra.filter(Boolean))) {
    const dir = projectDir(p);
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      try {
        const file = path.join(dir, f);
        all.push({ file, id: f.replace(/\.jsonl$/, ''), st: fs.statSync(file) });
      } catch { /* vanished */ }
    }
  }
  all.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const out = {};
  for (const e of all) {
    if (e.id in out) continue;
    out[e.id] = await labelOf(e.file, e.st);
  }
  return out;
}

/** The Claude window's title for one conversation, wherever its transcript is filed. */
function titleOf(sid, ...paths) {
  for (const p of paths.filter(Boolean)) {
    const t = aiTitle(path.join(projectDir(p), sid + '.jsonl'));
    if (t) return t;
  }
  return '';
}

/** Does a Claude tab's label name this conversation? VS Code keeps the tab title the Claude
 *  extension set -- the aiTitle, cut with "…" when long ("uncommitted changes revi…"). */
function labelMatchesTitle(label, title) {
  const l = String(label || '').replace(/\u2026$/, '').replace(/\.\.\.$/, '').trim();
  const t = String(title || '').trim();
  if (!l || !t || l.length < 4) return false;
  return t === l || t.startsWith(l) || l.startsWith(t);
}

module.exports = { labels, projectDir, aiTitle, titleOf, labelMatchesTitle };
