'use strict';
/**
 * The room's Python side, shipped inside the extension.
 *
 * The panel is self-contained, but what ANSWERS in it is not: a Claude session reads the
 * log with watch.py and writes to it with reply.py. Those lived only in a clone of this
 * repository, so on a machine without one the panel worked and nothing ever replied.
 * They travel in the .vsix now and are written into the room the first time it opens.
 */
const fs = require('fs');
const path = require('path');

const FILES = ['chatlog.py', 'reply.py', 'status.py', 'watch.py'];

/** Copy any missing helper into `dir`. Returns the names actually written. */
function install(extensionPath, dir) {
  const from = path.join(extensionPath, 'runtime');
  const written = [];
  fs.mkdirSync(dir, { recursive: true });
  for (const name of FILES) {
    const dest = path.join(dir, name);
    if (fs.existsSync(dest)) continue;          // never overwrite: a clone's copy wins
    try {
      fs.copyFileSync(path.join(from, name), dest);
      written.push(name);
    } catch { /* a packaging without runtime/, or a read-only folder */ }
  }
  return written;
}

/** Does this folder have what a session needs to answer in it? */
function ready(dir) {
  return FILES.every(n => fs.existsSync(path.join(dir, n)));
}

module.exports = { install, ready, FILES };
