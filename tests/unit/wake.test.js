'use strict';
/** U2 + U3: what writing to a session from the panel does, and whom a room lets go. */
const wake = require('../../extension/src/wake');
const bg = (status) => ({ kind: 'background', status });
const ia = (status) => ({ kind: 'interactive', status, pid: 4242 });
const P = (row, o = {}) => wake.plan(Object.assign({ row, listeningHere: false, boundHere: false, tabFound: false }, o));

module.exports = {
  'listening here and running: nothing to do': (t) => {
    t.eq(P(bg('busy'), { listeningHere: true }).do, 'none');
    t.eq(P(ia('idle'), { listeningHere: true }).do, 'none');
  },
  'a fresh heartbeat of a session that is not running is woken (P9)': (t) => {
    t.eq(P(null, { listeningHere: true }).do, 'wake');
  },
  'without claude agents, the heartbeat decides (never a blind wake of a listener)': (t) => {
    t.eq(P(null, { listeningHere: true, known: false }).do, 'none');
    t.eq(P(null, { listeningHere: false, known: false }).do, 'wake');
  },
  'not running anywhere: wake it': (t) => { t.eq(P(null), { do: 'wake', how: 'woken' }); },
  "this room's background session between watches: never stopped, never copied": (t) => {
    t.eq(P(bg('busy'), { boundHere: true }), { do: 'none', how: 'rearming' });
    t.eq(P(bg('idle'), { boundHere: true }), { do: 'none', how: 'rearming' });
  },
  'background elsewhere, idle: take it over': (t) => { t.eq(P(bg('idle')).do, 'stop-then-wake'); },
  'background elsewhere, busy: refuse (it would be killed mid-step)': (t) => {
    t.eq(P(bg('busy')), { do: 'refuse', why: 'busy-background' });
  },
  'idle in a Claude tab here: close the tab, then wake': (t) => {
    t.eq(P(ia('idle'), { tabFound: true }), { do: 'close-tab-then-wake', how: 'taken-from-window' });
  },
  'busy in a Claude tab: refuse': (t) => { t.eq(P(ia('busy'), { tabFound: true }).why, 'busy-window'); },
  'interactive with no tab here (terminal, other window): refuse, never a copy': (t) => {
    t.eq(P(ia('idle')).why, 'open-elsewhere'); t.eq(P(ia('busy')).why, 'busy-elsewhere');
  },
  'no outcome ever resumes a live session without ending it first': (t) => {
    // the property behind "no copies": whenever a row exists, the plan either leaves it alone,
    // refuses, or ends it (stop / close tab) before waking
    for (const row of [bg('idle'), bg('busy'), ia('idle'), ia('busy')]) {
      for (const listeningHere of [false, true]) for (const boundHere of [false, true]) for (const tabFound of [false, true]) {
        const p = wake.plan({ row, listeningHere, boundHere, tabFound });
        t.ok(p.do !== 'wake', JSON.stringify({ row, listeningHere, boundHere, tabFound }) + ' -> plain wake of a live session');
      }
    }
  },
  'refusal screens say what to do': (t) => {
    t.ok(wake.refusalScreen('open-elsewhere', 'x', ia('idle')).includes('process 4242'));
    t.ok(wake.refusalScreen('busy-window', 'x').includes('Claude window'));
  },
  'a room lets go of other background listeners only': (t) => {
    const rows = [{ sessionId: 'a', kind: 'background' }, { sessionId: 'b', kind: 'background' },
                  { sessionId: 'c', kind: 'interactive' }];
    t.eq(wake.toRelease(['a', 'b', 'c', 'd'], rows, 'b'), ['a'], 'keeps b, never c (a window), d is not running');
  },
};
