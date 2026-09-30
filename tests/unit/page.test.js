'use strict';
/** The panel page runs under a DOM shim with every entry point and clickable row exercised
 *  (tools/check_page.sh): one throw in the page reads to the reader as "no connection". */
const cp = require('child_process');
const path = require('path');

// one run, read by every case below: the harness starts a node process and builds the whole page
let ran = null;
function page() {
  if (ran === null) {
    ran = String(cp.execFileSync('bash', [path.join(__dirname, '..', '..', 'tools', 'check_page.sh')], { timeout: 60000 }));
  }
  return ran;
}

module.exports = {
  'chat.html runs, and its entry points and rows do not throw': (t) => {
    const out = page();
    t.ok(out.includes('ALL RAN with no throw'), out.slice(-400));
  },
  // ⛔ THE SESSIONS MENU SAID "no control room log available" ON EVERY ROW, including the session
  // that had just answered. Its count came from tlRows, which only refreshTimeline filled -- and
  // that runs when the TIMELINE is opened, which the reader need never do. The harness never opens
  // it either, so this reads the menu in exactly the state the reader first meets it in.
  'the SESSIONS menu counts replies before the timeline is ever opened': (t) => {
    const line = (page().split('\n').find(l => l.startsWith('MENU COUNTS:')) || '');
    t.ok(line, 'the harness printed no MENU COUNTS line');
    const cells = line.replace('MENU COUNTS:', '').split('|').map(s => s.trim()).filter(Boolean);
    t.ok(cells.length >= 2, 'expected a row per fixture session, got: ' + line);
    t.ok(cells.every(c => /^\d+ here$/.test(c)),
         'a session with replies in the room must show its count, not "no control room log available": ' + line);
  },
  'notices from the machinery show whoever is chosen': (t) => {
    const html = require('fs').readFileSync(path.join(__dirname, '..', '..', 'extension', 'chat.html'), 'utf8');
    t.ok(/!m\.session \|\| m\.session === tlFilter/.test(html), 'belongs() keeps session-less notices');
  },
};
