'use strict';
/* What "a smooth new session, and switching" means, as checks on what the reader sees.
 *
 * Each case is a room (sessions, who listens, who is busy, the log), a few clicks at fixed times, and
 * checks over the half-second samples the driver records. Times are the page's clock, in ms. */

const OLD = '11111111-1111-4111-8111-111111111111';    // listening, and in the middle of a turn
const NAP = '22222222-2222-4222-8222-222222222222';    // asleep, talked to ten minutes ago
const ANCIENT = '33333333-3333-4333-8333-333333333333'; // asleep, talked to two days ago
const MID = '44444444-4444-4444-8444-444444444444';     // asleep, an hour ago
const NEW = 'aaaaaaaa-0000-4000-8000-000000000001';

const room = {
  // listed here in the WRONG order on purpose: nothing may depend on insertion order
  sessions: [
    { id: ANCIENT, label: 'polish moe history quiz', agoMin: 2 * 24 * 60 },
    { id: OLD, label: 'uncommitted changes review', agoMin: 1, listening: true, busy: true },
    { id: MID, label: 'website analysis script', agoMin: 60 },
    { id: NAP, label: 'control room panel monitoring', agoMin: 10 },
  ],
  // the room log: ANCIENT spoke here first, OLD last -- first-appearance order is NOT recency order
  history: [
    { role: 'user', text: 'which moe fits 8 gb', to: ANCIENT },
    { role: 'assistant', text: '::say Qwen3-30B-A3B at Q4.', session: ANCIENT },
    { role: 'user', text: 'is it listening', to: NAP },
    { role: 'assistant', text: '::say Yes.', session: NAP },
    { role: 'user', text: 'review the diff', to: OLD },
    { role: 'assistant', text: '::say Reviewing.', session: OLD },
  ],
};
const BY_RECENCY = [OLD, NAP, MID, ANCIENT].map(s => s.slice(0, 8));

const after = (rec, ms) => rec.samples.filter(s => s.t >= ms);
const first = (rec, ms, pred) => after(rec, ms).find(pred);
const stepAt = (rec, name) => (rec.steps.find(s => s.do === name) || {}).t;
const rel = (rec, id) => (rec.released.find(r => r[1] === id) || [])[0];
const sameOrder = (got, want) => JSON.stringify(got.filter(x => want.includes(x))) === JSON.stringify(want);

function newSessionChecks(rec, click, P) {
  const out = [];
  const c = rec.steps.find(s => s.do === click) || {};
  out.push(['the click found its button', !c.error, c.error || '']);
  const t = c.t || 0;
  const closed = first(rec, t, s => !s.splash);
  out.push(['the splash is gone within 1 s of the click', closed && closed.t - t <= 1000,
    closed ? (closed.t - t) + ' ms' : 'never']);
  const back = rec.samples.find(s => s.t > t + 1000 && s.splash);
  out.push(['...and does not come back (the old session leaving is expected)', !back,
    back ? 'back at ' + (back.t - t) + ' ms' : '']);
  const shown = first(rec, t, s => /starting/i.test(s.screen));
  out.push(['"starting…" is on the main screen within 1 s', shown && shown.t - t <= 1000,
    shown ? (shown.t - t) + ' ms' : 'never: ' + (after(rec, t + 1000)[0] || {}).screen]);
  const ready = first(rec, t, s => s.target === NEW && s.shown === NEW);
  out.push(['the new session is chosen (target and screen) within start + 3 s',
    ready && ready.t - t <= (P.startMs || 8000) + 3000, ready ? (ready.t - t) + ' ms' : 'never']);
  const gap = rec.samples.filter(s => s.t > t + 1000 && (!ready || s.t < ready.t) && !/starting/i.test(s.screen));
  out.push(['the wait stays on screen until it is ready (nothing else replaces it)', !gap.length,
    gap.length ? gap[0].t - t + ' ms: ' + gap[0].screen.slice(0, 120) : '']);
  const named = ready && first(rec, ready.t, s => /control room monitoring/.test(s.screen));
  out.push(['the ready screen names the new session', !!named && named.t - ready.t <= 2000,
    ready ? (first(rec, ready.t, () => true) || {}).screen : '']);
  const hijack = ready && rec.samples.filter(s => s.t >= ready.t && s.t < ready.t + 10000 && /was let go/.test(s.screen));
  out.push(['no "was let go" notice takes over the screen after it is ready', ready && !hijack.length,
    hijack && hijack.length ? hijack[0].screen.slice(0, 120) : '']);
  const alarm = rec.samples.find(s => s.t > t && /not watching/i.test(s.pill));
  out.push(['no red NOT WATCHING while it switches', !alarm, alarm ? 'at ' + (alarm.t - t) + ' ms' : '']);
  const r = rel(rec, OLD);
  out.push(['the older session (busy) is stopped within 3 s of the click', r !== undefined && r - t <= 3000,
    r !== undefined ? (r - t) + ' ms' : 'never stopped']);
  const end = rec.samples[rec.samples.length - 1];
  out.push(['in the end only the new session listens', JSON.stringify(end.listening) === JSON.stringify([NEW]),
    JSON.stringify(end.listening)]);
  out.push(['the "to:" line names the new session', /control room monitoring/.test(end.to), end.to]);
  const menu = end.menuRows;
  out.push(['the S menu lists the new session first', menu[0] === NEW.slice(0, 8), menu.join(' ')]);
  return out;
}

module.exports = [
  {
    name: 'new session from the splash',
    P: Object.assign({ startMs: 8000, endMs: 40000,
      steps: [{ at: 3000, do: 'clickSplashNew' }] }, room),
    checks: (rec, P) => newSessionChecks(rec, 'clickSplashNew', P),
  },
  {
    name: 'new session from the S menu',
    P: Object.assign({ startMs: 8000, endMs: 40000,
      steps: [{ at: 3000, do: 'clickSplashRow', id: OLD }, { at: 5000, do: 'menuNew' }] }, room),
    checks: (rec, P) => newSessionChecks(rec, 'menuNew', P),
  },
  {
    name: 'a slow start (40 s) still reads as progress',
    P: Object.assign({ startMs: 40000, endMs: 70000,
      steps: [{ at: 3000, do: 'clickSplashNew' }] }, room),
    checks: (rec, P) => {
      const t = stepAt(rec, 'clickSplashNew');
      const counting = rec.samples.filter(s => s.t > t + 1000 && s.t < t + 38000);
      const stuck = counting.filter(s => !/starting/i.test(s.screen));
      const secs = new Set(counting.map(s => (/(\d+)\s*s\b/.exec(s.screen) || [])[1]).filter(Boolean));
      return [
        ['the wait is on screen for the whole 40 s', !stuck.length, stuck.length ? stuck[0].screen.slice(0, 120) : ''],
        ['it counts the seconds', secs.size >= 20, secs.size + ' distinct counts'],
      ].concat(newSessionChecks(rec, 'clickSplashNew', P).filter(c => /chosen|only the new/.test(c[0])));
    },
  },
  {
    name: 'a session the first release missed goes later, quietly',
    P: Object.assign({ startMs: 8000, missFirst: OLD, endMs: 40000,
      steps: [{ at: 3000, do: 'clickSplashNew' }] }, room),
    checks: (rec) => {
      const t = stepAt(rec, 'clickSplashNew');
      const ready = first(rec, t, s => s.target === NEW && s.shown === NEW);
      const r = rel(rec, OLD);
      const hijack = ready && rec.samples.filter(s => s.t >= ready.t && /was let go/.test(s.screen));
      const end = rec.samples[rec.samples.length - 1];
      return [
        ['it is stopped once the new session is up', r !== undefined && ready && r >= ready.t - 1000,
          r !== undefined ? (r - t) + ' ms after the click' : 'never'],
        ['its notice does not replace the ready screen', ready && !hijack.length,
          hijack && hijack.length ? hijack[0].screen.slice(0, 120) : ''],
        ['in the end only the new session listens', JSON.stringify(end.listening) === JSON.stringify([NEW]), JSON.stringify(end.listening)],
      ];
    },
  },
  {
    name: 'while it works, the steps are named, never [object Object]',
    P: Object.assign({ replyMs: 20000, endMs: 15000,
      doing: [{ t: 'Read chat.html', d: '/x/chat.html' }, { t: '', d: '' }, 'Thinking…', { t: 'Run the unit tests', d: 'node tests/run.js' }],
      steps: [{ at: 3000, do: 'clickSplashRow', id: OLD }, { at: 5000, do: 'send', text: 'status?' }] }, room),
    checks: (rec) => {
      const during = rec.samples.filter(s => s.t > 7000);
      const bad = during.find(s => /object Object/.test(s.screen));
      const named = during.find(s => /Read chat\.html/.test(s.screen) && /Run the unit tests/.test(s.screen));
      return [
        ['no "[object Object]" on screen', !bad, bad ? bad.screen.slice(0, 160) : ''],
        ['the steps are listed by name', !!named, (during[0] || {}).screen],
      ];
    },
  },
  {
    name: 'sessions are listed by last conversation, newest first, the same everywhere',
    P: Object.assign({ endMs: 8000, steps: [] }, room),
    checks: (rec) => {
      const end = rec.samples[rec.samples.length - 1];
      return [
        ['splash rows by recency', sameOrder(end.splashRows, BY_RECENCY), end.splashRows.join(' ')],
        ['S menu rows by recency', sameOrder(end.menuRows, BY_RECENCY), end.menuRows.join(' ')],
        // before the timeline was ever opened: the counts come from the extension
        ['S menu counts replies in this room without the timeline',
          end.menuText.some(t => t.includes(OLD.slice(0, 8)) && /1 here/.test(t))
            && !end.menuText.some(t => /no control room log/.test(t)),
          end.menuText.slice(1, 3).join(' | ')],
      ];
    },
  },
  {
    name: 'switching to a sleeping session from the S menu',
    P: Object.assign({ wakeMs: 6000, replyMs: 3000, endMs: 30000,
      steps: [{ at: 3000, do: 'clickSplashRow', id: OLD }, { at: 5000, do: 'menuRow', id: NAP },
              { at: 7000, do: 'send', text: 'hello again' }] }, room),
    checks: (rec) => {
      const t = stepAt(rec, 'menuRow');
      const chosen = first(rec, t, s => s.target === NAP && s.shown === NAP);
      const r = rel(rec, OLD);
      const got = first(rec, t, s => /answer to: hello again/.test(s.screen));
      const hijack = got && rec.samples.filter(s => s.t > got.t && /was let go/.test(s.screen));
      const end = rec.samples[rec.samples.length - 1];
      return [
        ['it is chosen at once', chosen && chosen.t - t <= 1000, chosen ? (chosen.t - t) + ' ms' : 'never'],
        ['the splash stays away while it wakes', !rec.samples.some(x => x.t > stepAt(rec, 'clickSplashRow') + 1000 && x.splash),
          (rec.samples.find(x => x.t > stepAt(rec, 'clickSplashRow') + 1000 && x.splash) || {}).t || ''],
        ['the older (busy) session is stopped at once', r !== undefined && r - t <= 3000,
          r !== undefined ? (r - t) + ' ms' : 'never stopped'],
        ['the answer arrives on screen', !!got, got ? (got.t - t) + ' ms' : (end.screen || '').slice(0, 120)],
        ['no "was let go" notice replaces the answer', got && !hijack.length, hijack && hijack.length ? hijack[0].screen.slice(0, 100) : ''],
        ['S menu now lists it first', end.menuRows[0] === NAP.slice(0, 8), end.menuRows.join(' ')],
      ];
    },
  },
];
