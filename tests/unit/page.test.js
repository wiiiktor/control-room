'use strict';
/** The panel page runs under a DOM shim with every entry point and clickable row exercised
 *  (tools/check_page.sh): one throw in the page reads to the reader as "no connection". */
const cp = require('child_process');
const path = require('path');
module.exports = {
  'chat.html runs, and its entry points and rows do not throw': (t) => {
    const out = String(cp.execFileSync('bash', [path.join(__dirname, '..', '..', 'tools', 'check_page.sh')], { timeout: 60000 }));
    t.ok(out.includes('ALL RAN with no throw'), out.slice(-400));
  },
  'notices from the machinery show whoever is chosen': (t) => {
    const html = require('fs').readFileSync(path.join(__dirname, '..', '..', 'extension', 'chat.html'), 'utf8');
    t.ok(/!m\.session \|\| m\.session === tlFilter/.test(html), 'belongs() keeps session-less notices');
  },
};
