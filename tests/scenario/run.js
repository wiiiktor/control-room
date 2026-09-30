#!/usr/bin/env node
'use strict';
/* Scenario tests: chat.html in a real headless Chrome, driven through the moments the reader lives
 * through -- "New session", choosing another session, waiting -- against a model of the extension
 * (backend.js), on Chrome's virtual clock so a minute of waiting runs in a few seconds.
 *
 *   node tests/scenario/run.js                 # every case
 *   node tests/scenario/run.js splash          # cases whose name contains "splash"
 *   node tests/scenario/run.js splash --shots  # and a screenshot every 2 s, into tests/scenario/shots/
 *   node tests/scenario/run.js --dump          # print every sample, for looking at what happened
 */
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HERE = __dirname;
// CR_PAGE: another chat.html (an installed one); CR_CASES: another cases file
const PAGE = process.env.CR_PAGE || path.join(HERE, '..', '..', 'extension', 'chat.html');
const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(p => fs.existsSync(p));

const args = process.argv.slice(2);
const filter = args.find(a => !a.startsWith('--')) || '';
const shots = args.includes('--shots');
const dump = args.includes('--dump');

function build(P, tmp) {
  const html = fs.readFileSync(PAGE, 'utf8');
  const inject = '<script>window.__CR_SCENARIO = ' + JSON.stringify(P) + ';</script>\n<script>'
    + fs.readFileSync(path.join(HERE, 'backend.js'), 'utf8') + '</script>\n';
  const i = html.indexOf('<script>');
  const j = html.lastIndexOf('</body>');
  const out = html.slice(0, i) + inject + html.slice(i, j)
    + '<script>' + fs.readFileSync(path.join(HERE, 'driver.js'), 'utf8') + '</script>\n' + html.slice(j);
  const file = path.join(tmp, 'page.html');
  fs.writeFileSync(file, out);
  return file;
}

// ⛔ Chrome prints the page for --dump-dom and then does not exit (headless=new, a page with
// timers). So the output is read as it comes and Chrome is stopped once it is complete.
function chrome(file, budget, extra, tmp) {
  const done = extra.includes('--dump-dom') ? (s) => s.includes('</html>')
    : () => fs.existsSync(extra[0].slice('--screenshot='.length));
  return new Promise((resolve) => {
    const p = cp.spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
      '--no-default-browser-check', '--user-data-dir=' + path.join(tmp, 'ud'),
      '--window-size=1400,900', '--virtual-time-budget=' + budget].concat(extra, ['file://' + file]),
    { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const finish = () => { clearInterval(iv); clearTimeout(kill); try { p.kill('SIGKILL'); } catch {} resolve(out); };
    p.stdout.on('data', d => { out += d; });
    const iv = setInterval(() => { if (done(out)) finish(); }, 200);
    const kill = setTimeout(finish, 180000);
    p.on('close', finish);
  });
}

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

if (!CHROME) { console.log('SKIP: no Chrome found (set CHROME=)'); process.exit(0); }
(async () => {
let failed = 0;
for (const c of require(process.env.CR_CASES || './cases')) {
  if (filter && !c.name.includes(filter)) continue;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-scn-'));
  const file = build(c.P, tmp);
  // the LAST one: the record is appended at the end of <body>.
  // \u26d4 Once in a few dozen runs Chrome prints the page without it (seen 2026-09-30, a different
  // case each time, never twice in a row): one retry, so a flake does not read as a regression.
  const record = async () => [...(await chrome(file, c.P.endMs + 2000, ['--dump-dom'], tmp))
    .matchAll(/<pre id="__cr_result">(\{[\s\S]*?)<\/pre>/g)].pop();
  const m = (await record()) || (await record());
  console.log('\n' + c.name);
  if (!m) { console.log('  \x1b[31mFAIL\x1b[0m the page produced no record'); failed++; continue; }
  const rec = JSON.parse(unescape(m[1]));
  if (rec.errors.length) { console.log('  \x1b[31mFAIL\x1b[0m page errors: ' + rec.errors.join(' | ')); failed++; }
  for (const [name, pass, detail] of c.checks(rec, c.P)) {
    if (!pass) failed++;
    console.log('  ' + (pass ? '\x1b[32mPASS\x1b[0m ' : '\x1b[31mFAIL\x1b[0m ') + name + (detail ? '  \x1b[2m' + detail + '\x1b[0m' : ''));
  }
  if (dump) for (const s of rec.samples) console.log('   ', s.t, s.splash ? 'SPLASH' : '      ', (s.target || '').slice(0, 8), '|', s.screen.slice(0, 100), '| menu:', s.menuRows.join(','), '| first:', s.menuFirst);
  if (shots) {
    const dir = path.join(HERE, 'shots', c.name.replace(/\W+/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    for (let t = 2000; t <= c.P.endMs; t += 2000) {
      await chrome(file, t, ['--screenshot=' + path.join(dir, String(t / 1000).padStart(3, '0') + 's.png')], tmp);
    }
    console.log('  screenshots: ' + dir);
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Chrome still letting go of it */ }
}
console.log('\n' + (failed ? failed + ' check(s) failed' : 'all checks passed'));
process.exit(failed ? 1 : 0);
})();
