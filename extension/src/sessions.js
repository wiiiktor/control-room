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

async function labels(workspacePath) {
  const dir = projectDir(workspacePath);
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  } catch {
    return {};
  }
  files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  const out = {};
  for (const f of files) {
    const label = await firstLine(path.join(dir, f));
    out[f.replace(/\.jsonl$/, '')] = label.replace(/\s+/g, ' ').slice(0, 90) || '(empty)';
  }
  return out;
}

module.exports = { labels, projectDir };
