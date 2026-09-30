/* Plays a scenario against chat.html and records what the reader would see, every half second.
 *
 * Loaded after the page's own script, so it reads the page's state by name (`target`, `tlFilter`,
 * `aliveIds` are top-level bindings of a classic script). The record ends up in <pre id="__cr_result">,
 * which the runner reads back from Chrome's --dump-dom. */
(function () {
  const P = window.__CR_SCENARIO || {};
  const t0 = window.__CR.t0;
  const rec = { samples: [], steps: [], errors: [] };
  window.addEventListener('error', (e) => rec.errors.push(String(e.message)));

  const $ = (sel) => document.querySelector(sel);
  const text = (n) => (n ? (n.innerText || n.textContent || '') : '').replace(/\s+/g, ' ').trim();
  const splashRows = () => [...document.querySelectorAll('#splash-sess button')];
  const menuRows = () => [...document.querySelectorAll('.tl-list button')];
  // which session a row is for: the known id that appears in its text (rows run the id straight
  // into the name, "11111111uncommitted…", so a word-boundary match finds nothing)
  const rowId = (b) => {
    const t = text(b);
    const ids = [...window.__CR.S.sessions.keys()].map(id => id.slice(0, 8));
    return ids.map(id => [t.indexOf(id), id]).filter(x => x[0] >= 0).sort((a, b) => a[0] - b[0]).map(x => x[1])[0] || '';
  };

  const ACT = {
    clickSplashNew: () => {
      const b = splashRows().find(x => /new session/i.test(text(x)));
      if (!b) throw new Error('no "new session" row on the splash');
      b.click();
    },
    clickSplashRow: (s) => {
      const b = splashRows().find(x => rowId(x) === s.id.slice(0, 8));
      if (!b) throw new Error('no splash row for ' + s.id.slice(0, 8));
      b.click();
    },
    menuOpen: () => { document.getElementById('sess-btn').click(); },
    menuNew: () => {
      const b = menuRows().find(x => /new session/i.test(text(x)));
      if (!b) throw new Error('no "New session" in the S menu');
      b.click();
    },
    menuRow: (s) => {
      const b = menuRows().find(x => rowId(x) === s.id.slice(0, 8));
      if (!b) throw new Error('no S-menu row for ' + s.id.slice(0, 8));
      b.click();
    },
    send: (s) => {
      const input = document.getElementById('input');
      input.value = s.text;
      document.getElementById('form').requestSubmit();
    },
    busy: (s) => { window.__CR.S.sessions.get(s.id).busy = s.busy !== false; },
  };

  for (const step of P.steps || []) {
    setTimeout(() => {
      const r = { t: Date.now() - t0, do: step.do };
      try { ACT[step.do](step); } catch (e) { r.error = String(e.message || e); }
      rec.steps.push(r);
    }, step.at);
  }

  const sample = () => {
    const S = window.__CR.S;
    rec.samples.push({
      t: Date.now() - t0,
      splash: document.getElementById('splash').classList.contains('on'),
      screen: text(document.getElementById('screen')).slice(0, 300),
      to: text(document.getElementById('to-hint')).slice(0, 120),
      pill: document.getElementById('deaf').classList.contains('on') ? text(document.getElementById('deaf')) : '',
      target: typeof target === 'undefined' ? null : target,
      shown: typeof tlFilter === 'undefined' ? null : tlFilter,
      listening: [...S.sessions.entries()].filter(([, s]) => s.listening).map(([id]) => id),
      splashRows: splashRows().map(rowId).filter(Boolean),
      menuRows: menuRows().map(rowId).filter(Boolean),
      menuFirst: text(menuRows()[0]).slice(0, 60),
      menuText: menuRows().map(text),
    });
  };
  setInterval(sample, 500);

  setTimeout(() => {
    sample();
    rec.released = window.__CR.S.released;
    rec.calls = window.__CR.S.calls.filter(c => c[1] !== '/api/messages');
    const pre = document.createElement('pre');
    pre.id = '__cr_result';
    pre.textContent = JSON.stringify(rec);
    document.body.append(pre);
  }, P.endMs || 45000);
})();
