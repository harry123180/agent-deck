'use strict';
const assert = require('assert');
const { detect } = require('../src/renderer/status');
const k = (...l) => detect(l).kind;

assert.strictEqual(k('● Reading files', '✻ Cogitating… (12s · ↑ 1.2k tokens · esc to interrupt)', '❯ '), 'working');
assert.strictEqual(k('• Working (3s • esc to interrupt)'), 'working');
assert.strictEqual(k('Edit file src/a.js', 'Do you want to make this edit to a.js?', '❯ 1. Yes', '  2. Yes, allow all edits', '  3. No'), 'asking');
assert.strictEqual(k('Run command? (y/n)'), 'asking');
assert.strictEqual(k('  API Error: 529 overloaded_error', '', '❯ '), 'error');
assert.strictEqual(k("claude : The term 'claude' is not recognized as the name of a cmdlet"), 'error');
assert.strictEqual(k('Done. All tests pass.', '', '❯ '), null);
assert.strictEqual(k('', '   ', ''), null);
// ask wins over a stale spinner line; error only looked for near the bottom
assert.strictEqual(k('✻ Working… (3s)', 'Do you want to proceed?'), 'asking');
assert.strictEqual(k('API Error: x', 'a', 'b', 'c', 'd', 'e', 'f', 'g'), null);


console.log('status tests passed');
