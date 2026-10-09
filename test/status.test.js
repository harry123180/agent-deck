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

// ---- plan limit (wording from the Claude Code binary) ----
assert.strictEqual(k('  ⎿  Usage limit reached', '', '> '), 'limit');
assert.strictEqual(k('Usage limit reached again', 'continuing automatically  esc to cancel'), 'limit');   // wins over the "esc to cancel" prompt
assert.strictEqual(k("You've hit your session limit · resets 3pm (Asia/Taipei)"), 'limit');
assert.strictEqual(k('5-hour limit reached ∙ resets 3pm'), 'limit');
assert.strictEqual(k('Weekly limit reached - resets Mon 9am'), 'limit');
assert.strictEqual(k('Opus limit reached'), 'limit');
assert.strictEqual(k("You're out of usage credits. Run /usage-credits to keep using"), 'limit');
assert.strictEqual(k('API Error: 429 rate_limit_error'), 'error');                  // a plain rate-limit hiccup is not an exhausted plan
assert.strictEqual(k("You've used 80% of your session limit"), null);               // warning only, nothing to switch yet
assert.strictEqual(k('Concurrent subagent limit reached. You can run 3 subagents at once.'), null);   // unrelated "limit reached"
assert.strictEqual(k('Context limit reached', '> '), null);
assert.strictEqual(k('Usage limit reached', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'), null);           // old scrollback far above the prompt is ignored
console.log('status tests passed');
