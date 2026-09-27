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

/** Put the helpers in `dir`, and REFRESH one the extension has outgrown.
 *
 * ⛔ "never overwrite: a clone's copy wins" was too absolute. A second room got its copy
 * of chatlog.py from an older extension, the hook shipped later called append_message with
 * a `mirror` argument that copy has never heard of, and every mirrored line for that room
 * died in a TypeError nobody could see: the room simply never heard what you typed. A
 * file this extension wrote is a file it has to be able to update.
 *
 * Two things are protected. A SYMLINK is somebody pointing deliberately at their own copy,
 * and is never touched. And a file NEWER than the shipped one is somebody's edit -- the
 * develop-in-place case this rule was written for -- so only an older, differing copy is
 * replaced. Returns the names written.
 */
function install(extensionPath, dir) {
  const from = path.join(extensionPath, 'runtime');
  const written = [];
  fs.mkdirSync(dir, { recursive: true });
  for (const name of FILES) {
    const dest = path.join(dir, name);
    const src = path.join(from, name);
    try {
      const there = fs.lstatSync(dest);         // lstat: do not follow a symlink
      if (there.isSymbolicLink()) continue;     // theirs on purpose
      const mine = fs.statSync(src);
      if (there.mtimeMs >= mine.mtimeMs) continue;            // same age or edited here
      if (fs.readFileSync(dest).equals(fs.readFileSync(src))) continue;
    } catch (e) {
      // ENOENT on dest is the ordinary first-time case; anything wrong with src is caught
      // by the copy below
      if (e && e.code !== 'ENOENT') continue;
    }
    try {
      fs.copyFileSync(src, dest);
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
