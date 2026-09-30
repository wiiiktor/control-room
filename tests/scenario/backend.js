/* A fake extension host for chat.html, loaded into the page before its own script.
 *
 * The webview answers the page's fetch('/api/...') through the extension; here the same routes are
 * answered in the page, from a small model of the room: which sessions exist, which are listening,
 * which are busy, what is in the log. Time is the page's own clock, so under Chrome's
 * --virtual-time-budget a minute of waiting runs in a moment.
 *
 * ⛔ THIS IS A MODEL OF extension.js, NOT A COPY. Every rule here names the function it stands for,
 * and a change to that function has to be made here too -- the unit tests check the real ones.
 */
(function () {
  const P = window.__CR_SCENARIO || {};
  const now = () => Date.now();
  const t0 = now();
  const S = {
    // id -> { label, mtime (ms), listening: bool, busy: bool, lastBeat }
    sessions: new Map(),
    log: [],
    seq: 0,
    timers: [],
    released: [],          // [ms since t0, id] -- what releaseOthers stopped, for the assertions
    started: [],           // ids started by /api/autostart
    calls: [],             // [ms since t0, route, body]
  };
  const at = (ms, fn) => S.timers.push({ due: now() + ms, fn });
  setInterval(() => {
    const due = S.timers.filter(t => t.due <= now());
    S.timers = S.timers.filter(t => t.due > now());
    due.forEach(t => t.fn());
    for (const s of S.sessions.values()) if (s.listening) s.lastBeat = now();
  }, 100);

  const iso = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
  function append(role, text, extra) {
    const m = Object.assign({ id: ++S.seq, role, text, ts: iso(now()) }, extra || {});
    S.log.push(m);
    if (m.session && S.sessions.has(m.session)) S.sessions.get(m.session).mtime = now();
    if (m.role === 'user' && m.to && S.sessions.has(m.to)) S.sessions.get(m.to).mtime = now();
    return m;
  }
  function addSession(id, o) {
    S.sessions.set(id, Object.assign({ label: id.slice(0, 8), mtime: now(), listening: false, busy: false, lastBeat: 0 }, o));
  }
  const label = (id) => (S.sessions.get(id) || {}).label || id.slice(0, 8);

  // sessions.js labels(): every conversation, newest transcript first
  function names() {
    const rows = [...S.sessions.entries()].sort((a, b) => b[1].mtime - a[1].mtime);
    return Object.fromEntries(rows.map(([id, s]) => [id, s.label]));
  }
  function lastAt() {
    return Object.fromEntries([...S.sessions.entries()].map(([id, s]) => [id, s.mtime]));
  }
  function watchers() {
    return [...S.sessions.entries()].filter(([, s]) => s.listening)
      .map(([id, s]) => ({ session: id, age: Math.round((now() - s.lastBeat) / 1000), label: s.label }));
  }
  // extension.js releaseOthers(dir, keep) + wake.toRelease(): every background listener other than keep,
  // busy or not, then a QUIET notice (Log.append quiet). P.missFirst: the first release does not see
  // one session (`claude agents` is not a complete list), so it goes only at the next release.
  let releases = 0;
  function releaseOthers(keep) {
    const n = ++releases;
    for (const [id, s] of S.sessions) {
      if (id === keep || !s.listening) continue;
      if (P.missFirst === id && n === 1) continue;
      // in the reader's room the second release came half a minute after the new session was up
      at(P.missFirst === id ? (P.lateMs || 12000) : (P.stopMs || 600), () => {
        s.listening = false; s.busy = false;
        S.released.push([now() - t0, id]);
        append('assistant', '::note ' + s.label + ' was let go — this room talks to one session at a time'
          + (keep ? ', and now that is ' + label(keep) : '') + '. Writing to ' + s.label + ' brings it back.',
          { about: id, quiet: !P.loudNotices });
      });
    }
  }
  function wake(id, then) {
    at(P.wakeMs || 6000, () => {
      const s = S.sessions.get(id);
      s.listening = true; s.lastBeat = now();
      releaseOthers(id);
      if (then) then();
    });
  }
  function answer(id, text) {
    const s = S.sessions.get(id);
    s.busy = true;
    at(P.replyMs || 3000, () => { s.busy = false; append('assistant', '::say ' + text, { session: id }); });
  }

  const routes = {
    '/api/messages': (q) => {
      const since = Number(new URLSearchParams(q).get('since') || 0);
      const msgs = S.log.filter(m => m.id > since);
      const w = watchers();
      return { messages: msgs, last: msgs.length ? msgs[msgs.length - 1].id : since, build: 'test',
               status: [], doing: S.log.length && S.log[S.log.length - 1].role === 'user' ? (P.doing || []) : [], watch: w.length ? Math.min(...w.map(x => x.age)) : null,
               hidden: [], watchers: w, elsewhere: {}, live: null, waking: {}, working: {} };
    },
    '/api/sessions': () => ({
      sessions: names(), lastAt: lastAt(), watchers: watchers(), elsewhere: {}, waking: {},
      // extension.js /api/sessions `here`: replies per session in this room
      here: S.log.reduce((n, m) => { if (m.role === 'assistant' && m.session) n[m.session] = (n[m.session] || 0) + 1; return n; }, {}),
      live: Object.fromEntries([...S.sessions.entries()].filter(([, s]) => s.listening)
        .map(([id, s]) => [id, { status: s.busy ? 'busy' : 'idle', kind: 'background', name: s.label }])),
    }),
    // extension.js /api/autostart -> startSessionInTerminal -> startHeadless; proveItStarted -> releaseOthers
    '/api/autostart': () => {
      const id = (P.newId || 'aaaaaaaa-0000-4000-8000-00000000000' + (S.started.length + 1));
      S.started.push(id);
      at(P.startMs || 8000, () => {
        addSession(id, { label: P.newLabel || 'control room monitoring', listening: true, lastBeat: now() });
        if (P.greeting !== false) at(P.greetMs || 1500, () => append('assistant', '::ok Watching this room. Write here and I\'ll answer here.', { session: id }));
        releaseOthers(id);
      });
      return { ok: true, how: 'terminal', mode: 'hidden' };
    },
    '/api/choose': (q, body) => { releaseOthers(body.session || ''); return { ok: true }; },
    '/api/send': (q, body) => {
      const m = append('user', body.text, body.to ? { to: body.to } : null);
      const to = body.to || watchers().map(w => w.session)[0];
      if (to && S.sessions.has(to)) {
        if (S.sessions.get(to).listening) answer(to, 'answer to: ' + body.text);
        else wake(to, () => answer(to, 'answer to: ' + body.text));
      }
      return m;
    },
    '/api/wake': (q, body) => { if (body.session) wake(body.session); return { ok: true }; },
  };

  window.CONTROL_ROOM_HOST = 'extension';
  window.fetch = async (url, opts) => {
    const [route, q] = String(url).split('?');
    let body = {};
    try { body = JSON.parse((opts && opts.body) || '{}'); } catch { /* not json */ }
    S.calls.push([now() - t0, route, body]);
    const fn = routes[route];
    const data = fn ? fn(q || '', body) : { error: 'not found' };
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)) };
  };

  // the scenario's starting room
  for (const s of P.sessions || []) addSession(s.id, Object.assign({}, s, { mtime: t0 - (s.agoMin || 0) * 60000 }));
  for (const m of P.history || []) {
    append(m.role, m.text, m.session ? { session: m.session } : m.to ? { to: m.to } : null);
  }
  // history must not bump the scenario's own idea of who spoke last
  for (const s of P.sessions || []) S.sessions.get(s.id).mtime = t0 - (s.agoMin || 0) * 60000;
  try { localStorage.clear(); } catch { /* blocked */ }
  window.__CR = { S, t0, label };
})();
