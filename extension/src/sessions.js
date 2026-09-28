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

/** What a session is doing right now, the way the Claude window shows it: the steps of the turn in
 *  progress, newest last -- "Thinking…", "Read chat.html", a command's own description, the lines it
 *  writes between tools. Empty when no turn is running.
 *
 * ⭐ READ FROM THE TRANSCRIPT. Claude Code appends each tool call BEFORE running it (measured), so
 * the file is as current as the Claude window's own view, and nothing has to be installed in the
 * session for it -- a hook would only reach sessions started after it was. Only the tail is read. */
function stepLabel(b) {
  const i = b.input || {};
  const base = (f) => path.basename(String(f || ''));
  const cut = (t, n = 80) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  switch (b.name) {
    case 'Bash': return cut(i.description || i.command);
    case 'Read': return 'Read ' + base(i.file_path);
    case 'Edit': case 'MultiEdit': return 'Edit ' + base(i.file_path);
    case 'Write': return 'Write ' + base(i.file_path);
    case 'NotebookEdit': return 'Edit ' + base(i.notebook_path);
    case 'Grep': return cut('Search "' + (i.pattern || '') + '"');
    case 'Glob': return cut('Find ' + (i.pattern || ''));
    case 'WebFetch': try { return 'Fetch ' + new URL(i.url).host; } catch { return 'Fetch'; }
    case 'WebSearch': return cut('Search the web: ' + (i.query || ''));
    case 'Agent': case 'Task': return cut('Agent: ' + (i.description || ''));
    case 'Monitor': return cut('Watch: ' + (i.description || ''));
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': return 'Update tasks';
    case 'Skill': return cut('Skill: ' + (i.skill || ''));
    default: return String(b.name || 'Working').replace(/^mcp__[^_]+__/, '');
  }
}

/** The WHOLE thing behind the label, for the right pane: the command that ran, the text that was
 *  written, the pattern that was searched. The label is a line; this is what the line is about.
 *  Returned as plain text and rendered as a text node, never as markup. */
function stepDetail(b) {
  const i = b.input || {};
  const cap = (t) => { t = String(t == null ? '' : t); return t.length > 8000 ? t.slice(0, 8000) + '\n…' : t; };
  const pair = (...xs) => cap(xs.filter(Boolean).join('\n'));
  switch (b.name) {
    case 'Bash': return pair(i.command, i.description && i.description !== i.command ? '\n# ' + i.description : '');
    case 'Write': return pair(i.file_path, i.content && '\n' + i.content);
    case 'Edit': return pair(i.file_path, i.old_string && '\n--- was\n' + i.old_string,
                             i.new_string && '\n+++ now\n' + i.new_string);
    case 'Read': return pair(i.file_path, i.offset ? 'from line ' + i.offset : '', i.limit ? i.limit + ' lines' : '');
    case 'Grep': return pair('pattern: ' + (i.pattern || ''), i.path && 'in: ' + i.path, i.glob && 'glob: ' + i.glob);
    case 'Glob': return pair(i.pattern, i.path);
    case 'WebFetch': return pair(i.url, i.prompt);
    case 'WebSearch': return cap(i.query);
    case 'Agent': case 'Task': return pair(i.description, i.prompt && '\n' + i.prompt);
    case 'Monitor': return pair(i.description, i.command);
    case 'Skill': return pair(i.skill, i.args);
    default: {
      try { return cap(JSON.stringify(i, null, 2)); } catch { return ''; }
    }
  }
}

const doingCache = new Map();
function activity(file, keep = 100) {
  let st;
  try { st = fs.statSync(file); } catch { return []; }
  // a turn that ended without a closing message (interrupted, killed) must not read as running forever
  if (Date.now() - st.mtimeMs > 10 * 60 * 1000) return [];
  const key = st.size + ':' + st.mtimeMs;
  const hit = doingCache.get(file);
  if (hit && hit.key === key) return hit.steps;
  let steps = [];
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const len = Math.min(st.size, 262144);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    let running = false;
    for (const line of buf.toString('utf8').split('\n')) {
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      const m = d.message;
      if (!m || d.isSidechain) continue;
      const c = m.content;
      if (m.role === 'user') {
        const isResult = Array.isArray(c) && c.some(x => x && x.type === 'tool_result');
        if (!isResult && !d.isMeta) { steps = []; running = true; }   // a new prompt: a new turn
        continue;
      }
      if (m.role !== 'assistant' || !Array.isArray(c)) continue;
      running = true;
      for (const b of c) {
        // ⛔ NO 'Thinking…'. It was the one step that said nothing about what is happening, and it
        // crowded out the ones that do. Asked for twice.
        if (b.type === 'tool_use') steps.push({ t: stepLabel(b), d: stepDetail(b) });
        else if (b.type === 'text' && b.text && b.text.trim()) {
          const whole = b.text.trim();
          const t = whole.split('\n')[0].replace(/[*_`#>]/g, '').trim();
          if (t) steps.push({ t: t.length > 90 ? t.slice(0, 89) + '…' : t,
                              d: whole.length > t.length ? whole : '' });
        }
      }
      if (m.stop_reason === 'end_turn' || m.stop_reason === 'stop_sequence') running = false;
    }
    if (!running) steps = [];
    // every step of the turn stays (the page scrolls past five); one thought after another is one line
    steps = steps.slice(-keep);
  } catch { steps = []; } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ }
  }
  doingCache.set(file, { key, steps });
  return steps;
}

/** activity() for a session id, wherever its transcript is filed. */
function activityOf(sid, ...paths) {
  if (!/^[0-9a-f-]{36}$/.test(String(sid || ''))) return [];
  for (const p of paths.filter(Boolean)) {
    const f = path.join(projectDir(p), sid + '.jsonl');
    if (fs.existsSync(f)) return activity(f);
  }
  return [];
}

module.exports = { labels, projectDir, aiTitle, titleOf, labelMatchesTitle, activity, activityOf, stepLabel };
