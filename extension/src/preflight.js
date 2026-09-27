'use strict';
/**
 * Why a hidden terminal is allowed to be hidden.
 *
 * ⛔ THE FAILURE MODE THIS EXISTS FOR. `claude` started with `hideFromUser` runs where nobody can
 * see it -- so anything it stops to ASK goes unanswered and unseen, and the panel shows the same
 * patient nothing it shows while a healthy session is thinking. Observed and likely prompts:
 *
 *   "Do you trust the files in this folder?"   a directory Claude Code has not been run in before
 *   "/login"                                    no credentials, or the refresh token has expired
 *   the theme / onboarding questions            a machine where Claude Code has never been set up
 *   "command not found: claude"                 not installed, or not on the PATH the terminal got
 *
 * Every one of them is knowable BEFORE the terminal is created, from files this extension can
 * read. So the rule is: a terminal may only be hidden when the things that would make it ask a
 * question have already been checked. Otherwise it opens where it can be seen and answered.
 *
 * This is deliberately a read-only check. It never writes to ~/.claude.json, never accepts a
 * trust dialog on the reader's behalf, and never touches credentials -- it only reports.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Is `claude` runnable, and where from? PATH as this process sees it is the closest thing we
 *  have to the PATH the terminal will get; VS Code inherits the login shell's environment. */
function findClaude() {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  // ~/.local/bin is where the installer puts it and is missing from some minimal PATHs
  dirs.push(path.join(os.homedir(), '.local', 'bin'));
  for (const d of dirs) {
    const p = path.join(d, 'claude');
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* not here */ }
  }
  return null;
}

/** Credentials present and not expired. The file is chmod 600 and may be unreadable to us even
 *  when it is perfectly good, so "cannot read" is NOT reported as "not logged in". */
function credentials() {
  const f = path.join(os.homedir(), '.claude', '.credentials.json');
  let raw;
  try {
    raw = fs.readFileSync(f, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, why: 'no credentials file — Claude Code has never been logged in on this machine' };
    return { ok: true, unverified: 'credentials exist but could not be read (' + err.code + ')' };
  }
  let d;
  try { d = JSON.parse(raw); } catch { return { ok: true, unverified: 'credentials file is not JSON we recognise' }; }
  const o = d.claudeAiOauth || {};
  if (!o.expiresAt) return { ok: true, unverified: 'credentials carry no expiry we recognise' };
  const left = Math.round((o.expiresAt - Date.now()) / 60000);
  if (left <= 0) {
    // a refresh token that is still good means the CLI renews silently; only both expired is fatal
    const rLeft = o.refreshTokenExpiresAt ? o.refreshTokenExpiresAt - Date.now() : 0;
    if (rLeft > 0) return { ok: true, note: 'access token expired ' + (-left) + ' min ago; the refresh token is still valid' };
    return { ok: false, why: 'the login has expired — a hidden session would stop at /login' };
  }
  return { ok: true, note: 'login valid for ' + left + ' min' };
}

/** Has the trust dialog already been answered for this directory?
 *
 *  ⛔ This is the one that bites a fresh room. Claude Code asks "Do you trust the files in this
 *  folder?" the first time it runs in a directory, and records the answer under that exact path.
 *  A room whose folder has never been used answers nothing and waits forever. */
function trusted(cwd) {
  const f = path.join(os.homedir(), '.claude.json');
  let d;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {
    return { ok: true, unverified: 'could not read ~/.claude.json, so trust is unknown' };
  }
  const projects = d.projects || {};
  const entry = projects[cwd];
  if (!entry) return { ok: false, why: 'Claude Code has never run in ' + cwd + ' — it will ask whether you trust this folder' };
  if (entry.hasTrustDialogAccepted !== true) {
    return { ok: false, why: 'the trust question for ' + cwd + ' has not been answered yes' };
  }
  if (d.hasCompletedOnboarding !== true) {
    return { ok: false, why: 'Claude Code onboarding is unfinished — it will ask about the theme first' };
  }
  return { ok: true };
}

/** Everything, in one call. `ok` false means: do not hide the terminal. */
function check(cwd) {
  const problems = [];
  const notes = [];
  const bin = findClaude();
  if (!bin) problems.push('the `claude` command is not on the PATH this extension can see');
  else notes.push('claude at ' + bin);

  const c = credentials();
  if (!c.ok) problems.push(c.why);
  if (c.note) notes.push(c.note);
  if (c.unverified) notes.push(c.unverified);

  const t = trusted(cwd);
  if (!t.ok) problems.push(t.why);
  if (t.unverified) notes.push(t.unverified);

  return { ok: problems.length === 0, problems, notes, bin };
}

module.exports = { check, findClaude, credentials, trusted };
