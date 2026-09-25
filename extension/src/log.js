'use strict';
/**
 * The log, exactly as chatlog.py keeps it.
 *
 * One JSON object per line in chat.jsonl; ids come from a high-water mark in .seq so
 * they never repeat, even after the log is truncated. reply.py writes the same file from
 * the session, so the two must agree on this format down to the field names.
 */
const fs = require('fs');
const path = require('path');

/** The log's timestamps are LOCAL, because chatlog.py writes them that way and the
 *  panel prints them as a wall clock. toISOString() is UTC, which stamped every message
 *  sent from the editor two hours behind the replies to it. */
function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
         `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

class Log {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'chat.jsonl');
    this.seq = path.join(dir, '.seq');
    this.status = path.join(dir, '.status');
    this.watch = path.join(dir, '.watch');
  }

  read(since = 0) {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;               // a half-written line during a concurrent append
      }
      if (typeof msg.id === 'number' && msg.id > since) out.push(msg);
    }
    return out;
  }

  append(role, text, to) {
    const existing = this.read();
    let high = 0;
    try {
      high = parseInt(fs.readFileSync(this.seq, 'utf8'), 10) || 0;
    } catch { /* no high-water mark yet */ }
    const last = existing.length ? existing[existing.length - 1].id : 0;
    const id = Math.max(high, last) + 1;
    fs.writeFileSync(this.seq, String(id));
    const msg = { id, role, text, ts: localStamp() };
    if (to) msg.to = to;
    fs.appendFileSync(this.file, JSON.stringify(msg) + '\n');
    this.clearStatus();
    return msg;
  }

  /** Progress notes written by status.py while a reply is being worked on. */
  readStatus() {
    try {
      return fs.readFileSync(this.status, 'utf8')
        .split('\n').map(l => l.trimEnd()).filter(Boolean).slice(-8);
    } catch {
      return [];
    }
  }

  clearStatus() {
    try { fs.unlinkSync(this.status); } catch { /* already gone */ }
  }

  /** Seconds since a watcher last checked in, or null if none ever has.
   *
   *  ⛔ ONE question, ONE answer. This used to read `.watch` alone while the panel's other
   *  indicators read the per-session `.watch.<id>` files, so the two could disagree about
   *  whether anybody was listening -- and they did: a room whose session was answering
   *  normally went on wearing the red "not watching" pill. Take the freshest beat of
   *  either kind. A session heartbeat is proof somebody is reading; so is the room one,
   *  which is all a watcher with no session id can write.
   */
  watchAge() {
    const ages = [];
    const age = (f) => {
      try {
        return Math.round((Date.now() - fs.statSync(f).mtimeMs) / 1000);
      } catch {
        return null;
      }
    };
    const room = age(this.watch);
    if (room !== null) ages.push(room);
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      names = [];
    }
    for (const n of names) {
      if (!n.startsWith('.watch.')) continue;
      const a = age(path.join(this.dir, n));
      if (a !== null) ages.push(a);
    }
    return ages.length ? Math.min(...ages) : null;
  }

  /** Sessions with a live watch: one .watch.<id> file each, touched every 30s. */
  watchers(labels) {
    const out = [];
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return out;
    }
    for (const n of names) {
      if (!n.startsWith('.watch.')) continue;
      const session = n.slice('.watch.'.length);
      let age;
      try {
        age = Math.round((Date.now() - fs.statSync(path.join(this.dir, n)).mtimeMs) / 1000);
      } catch {
        continue;
      }
      if (age > 90) continue;
      out.push({ session, age, label: (labels && labels[session]) || '(no transcript)' });
    }
    return out.sort((a, b) => a.age - b.age);
  }
}

module.exports = { Log };
