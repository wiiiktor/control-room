'use strict';
/**
 * What writing to a session from the panel does -- decided from facts, not guessed.
 *
 * ⛔ THE RULE: ONE CONVERSATION, ONE PROCESS. `claude --bg --resume <id>` on a conversation that is
 * open anywhere else does not join it: it starts a COPY under a new id (measured: "session X is open in
 * another Claude Code process, so this started a copy as Y"). That is where the second "uncommitted
 * changes review" came from. And `claude stop` reaches background sessions only -- on a conversation open
 * in a Claude window or a terminal it answers "No job matching" and does nothing. So the only moves are:
 *
 *   not running anywhere               -> wake it here (background)
 *   listening in this room             -> nothing to do, it reads the message itself
 *   background, bound to this room,
 *     watch lapsed (re-arming, busy)   -> nothing: the watch catches the message up when it re-arms.
 *                                         Waking again is what used to stop a busy session mid-step.
 *   background elsewhere, idle         -> stop it, wake it here
 *   background elsewhere, busy         -> refuse: stopping it would kill what it is doing
 *   in a Claude tab of this window,
 *     idle                             -> close that tab (its process ends with it), wake it here
 *     busy                             -> refuse: closing the tab would kill the step it is on
 *   interactive with no tab we can see
 *     (a terminal, another window)     -> refuse: nothing here can end it
 */

/**
 * @param {object} f
 * @param {object|null} f.row       its `claude agents --json` row, or null when it is not running
 * @param {boolean} f.listeningHere its heartbeat in this room is fresh
 * @param {boolean} f.boundHere     it has watched this room before (heartbeat or binding file), or
 *                                  runs from this room's folder
 * @param {boolean} f.tabFound      a Claude tab in this window carries its title
 * @param {boolean} [f.known]     false when `claude agents` could not be asked
 * @returns {{do: 'none'|'wake'|'stop-then-wake'|'close-tab-then-wake'|'refuse', how?: string, why?: string}}
 */
function plan({ row, listeningHere, boundHere, tabFound, known = true }) {
  // `known` is false when `claude agents` could not be asked: then the heartbeat is all there is
  if (!known) return listeningHere ? { do: 'none', how: 'listening' } : { do: 'wake', how: 'woken' };
  // \u26d4 NOT RUNNING BEATS A FRESH HEARTBEAT. The file keeps its time for up to 90 s after its session
  // is gone (a reload, a stop), and a message written in that window was never woken: the panel saw
  // "listening" and waited for nobody. `claude agents` is the authority on whether it runs at all.
  if (!row) return { do: 'wake', how: 'woken' };
  if (listeningHere) return { do: 'none', how: 'listening' };
  if (row.kind === 'background') {
    if (boundHere) return { do: 'none', how: 'rearming' };
    if (row.status === 'busy') return { do: 'refuse', why: 'busy-background' };
    return { do: 'stop-then-wake', how: 'taken-from-background' };
  }
  if (row.status === 'busy') return { do: 'refuse', why: tabFound ? 'busy-window' : 'busy-elsewhere' };
  if (tabFound) return { do: 'close-tab-then-wake', how: 'taken-from-window' };
  return { do: 'refuse', why: 'open-elsewhere' };
}

/** The room's words for a refusal, so the reader knows what to do next. */
function refusalScreen(why, name, row) {
  const n = String(name || 'That session').slice(0, 48);
  const where = row && row.pid ? ' (process ' + row.pid + ')' : '';
  const said = {
    'busy-background': ['::warn ' + n + ' is busy in the background, in another room or task',
      '::say Taking it over now would stop it in the middle of what it is doing. Your message is written '
        + 'down; write again when it has finished, or start a new session for this room.'],
    'busy-window': ['::warn ' + n + ' is busy in the Claude window',
      '::say It is in the middle of a step there, and moving it here would end that step. Your message is '
        + 'written down: continue in the Claude window, or write again here when it has finished.'],
    'busy-elsewhere': ['::warn ' + n + ' is busy in another window or terminal' + where,
      '::say Nothing here can move it without ending what it is doing. Your message is written down.'],
    'open-elsewhere': ['::warn ' + n + ' is open in a terminal or another VS Code window' + where,
      '::say A conversation runs in one place at a time, and this room cannot close that one. Close it '
        + 'there (or type /exit in it), then write again here — your message is already written down.'],
  }[why] || ['::warn ' + n + ' could not be woken', '::say ' + why];
  return said.join('\n');
}

/**
 * Which other sessions to let go once `keep` is serving the room: everything else listening here
 * that runs in the background. A session in a Claude window or a terminal is never stopped by this --
 * it cannot be (`claude stop` does not reach it), and it is somebody's window.
 */
function toRelease(listening, rows, keep) {
  return listening.filter((sid) => sid !== keep
    && rows.some((r) => r.sessionId === sid && r.kind === 'background'));
}

module.exports = { plan, refusalScreen, toRelease };
