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

async function firstLine(file) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let i = 0;
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
        if (text) return text;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return '';
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
