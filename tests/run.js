#!/usr/bin/env node
'use strict';
/**
 * Unit tests: `node tests/run.js` (or a filter: `node tests/run.js handoff`).
 * No dependencies, no Claude process, no VS Code: `vscode` is faked (unit/fake-vscode.js) and so is
 * `claude` where a test needs one. Each unit/*.test.js exports { name: async (t) => {...} }.
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

// every require('vscode') in the extension gets the fake
const fakeVscode = require('./unit/fake-vscode');
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return fakeVscode.current();
  return realLoad.call(this, request, ...rest);
};

const filter = process.argv[2] || '';
const files = fs.readdirSync(path.join(__dirname, 'unit')).filter(f => f.endsWith('.test.js') && f.includes(filter));
let pass = 0, fail = 0;
(async () => {
  for (const f of files) {
    const cases = require(path.join(__dirname, 'unit', f));
    for (const [name, fn] of Object.entries(cases)) {
      fakeVscode.reset();
      const t = {
        eq(a, b, what) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((what || 'eq') + ': got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b)); },
        ok(v, what) { if (!v) throw new Error((what || 'ok') + ': got ' + JSON.stringify(v)); },
      };
      try {
        await fn(t);
        pass++; console.log('  \x1b[32mPASS\x1b[0m ' + f.replace('.test.js', '') + ' · ' + name);
      } catch (err) {
        fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + f.replace('.test.js', '') + ' · ' + name + '\n       ' + (err && err.stack || err).split('\n').slice(0, 3).join('\n       '));
      }
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
