'use strict';
/** U7 what a session is doing, read from its transcript the way the Claude window shows it. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { activity } = require('../../extension/src/sessions');

function transcript(entries) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-tr-')), 's.jsonl');
  fs.writeFileSync(f, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return f;
}
const prompt = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const said = (content, stop = 'tool_use') => ({ type: 'assistant', message: { role: 'assistant', content, stop_reason: stop } });
const tool = (name, input) => said([{ type: 'tool_use', id: name, name, input }]);
const result = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });

module.exports = {
  'U7 a running turn lists its steps, labelled as the Claude window labels them': (t) => {
    const f = transcript([
      prompt('old question'), said([{ type: 'text', text: 'old answer' }], 'end_turn'),
      prompt('fix it'),
      said([{ type: 'thinking', thinking: '...' }]),
      tool('Read', { file_path: '/a/b/chat.html' }), result(),
      said([{ type: 'text', text: '**Found it.** More below\nsecond line' }]),
      tool('Bash', { command: 'node tests/run.js', description: 'Run unit tests' }), result(),
      tool('Grep', { pattern: 'typing' }),
    ]);
    t.eq(activity(f).map(x => x.t), ['Read chat.html', 'Found it. More below', 'Run unit tests', 'Search "typing"']);
    // each step carries what was behind it, for the right pane: the command itself, the path
    t.eq(activity(f)[2].d.split('\n')[0], 'node tests/run.js');
  },
  'U7 a finished turn shows nothing; a thought is not a step': (t) => {
    t.eq(activity(transcript([prompt('q'), tool('Read', { file_path: 'x' }), result(),
      said([{ type: 'text', text: 'done' }], 'end_turn')])).length, 0);
    t.eq(activity(transcript([prompt('q'), said([{ type: 'thinking', thinking: '' }])])).length, 0);   // "Thinking…" is never a step
  },
};
