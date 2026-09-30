'use strict';
/** The .vsix carries extension/LICENSE (vsce packages that folder); it must be the repository's. */
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..', '..');

module.exports = {
  'extension/LICENSE is the same text as the repository LICENSE': (t) => {
    t.eq(fs.readFileSync(path.join(R, 'extension', 'LICENSE'), 'utf8'), fs.readFileSync(path.join(R, 'LICENSE'), 'utf8'));
  },
  'package.json points at the license file': (t) => {
    t.eq(JSON.parse(fs.readFileSync(path.join(R, 'extension', 'package.json'), 'utf8')).license, 'SEE LICENSE IN LICENSE');
  },
};
