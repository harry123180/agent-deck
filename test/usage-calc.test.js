'use strict';
const assert = require('assert');
const U = require('../src/renderer/usage-calc');

const now = new Date(2026, 9, 9, 15, 0, 0);          // 2026-10-09
const row = (date, cost, tokens, model = 'claude-opus-5-5') => ({ date, totalCost: cost, totalTokens: tokens,
  modelBreakdowns: [{ modelName: model, inputTokens: tokens, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost }] });
const daily = { projects: {
  'D--Work-LMS': [row('2026-10-09', 10, 1000), row('2026-10-08', 5, 500), row('2026-10-02', 1, 100)],
  'D--Work-Docs': [row('2026-10-09', 2, 200, 'claude-sonnet-5-5')],
  'C--Users-user-scratch': [row('2026-10-07', 4, 400)],
  'D--Work-Old': [row('2026-08-01', 99, 9999)],         // outside the 30-day window
} };
const tabs = [
  { title: 'lms-main', cwd: String.raw`D:\Work\LMS`, projectId: 'P1' },
  { title: 'lms-2', cwd: String.raw`D:\Work\LMS`, projectId: 'P1' },      // same folder twice: counted once
  { title: 'docs', cwd: String.raw`D:\Work\Docs`, projectId: '' },
];
const projects = [{ id: 'P1', name: 'LMS 專案' }, { id: 'P2', name: '空專案' }];

assert.strictEqual(U.encode(String.raw`D:\Work\My Project`), 'D--Work-My-Project');
const days = U.lastDays(30, now);
assert.strictEqual(days.length, 30); assert.strictEqual(days.at(-1), '2026-10-09'); assert.strictEqual(days[0], '2026-09-10');
assert.strictEqual(U.lastDays(3, new Date(2026, 2, 1)).join(), '2026-02-27,2026-02-28,2026-03-01');   // month boundary

const s = U.summarize(daily, { tabs, projects, now });
assert.strictEqual(s.days.length, 30);
assert.strictEqual(s.days.at(-1).cost, 12);                            // today: LMS 10 + Docs 2
assert.deepStrictEqual(s.days.at(-1).byRepo, { 'D--Work-LMS': 10, 'D--Work-Docs': 2 });
assert.strictEqual(s.totals.today.cost, 12);
assert.strictEqual(s.totals.week.cost, 12 + 5 + 4);                    // 10-03..10-09 (the 10-02 entry is outside 7 days)
assert.strictEqual(s.totals.month.cost, 12 + 5 + 4 + 1);               // old August entry excluded
assert.strictEqual(s.totals.month.tokens, 1000 + 500 + 100 + 200 + 400);
assert.deepStrictEqual(s.repos.map(r => r.key), ['D--Work-LMS', 'C--Users-user-scratch', 'D--Work-Docs']);   // by cost desc
assert.strictEqual(s.repos[0].name, 'LMS'); assert.strictEqual(s.repos[0].matched, true);
assert.strictEqual(s.repos[1].matched, false);               // scratch folder has no card
// groups: card project / loose cards / folders with no card
const g = Object.fromEntries(s.groups.map(x => [x.name, x]));
assert.strictEqual(g['LMS 專案'].cost, 16); assert.strictEqual(g['LMS 專案'].repos.length, 1);
assert.strictEqual(g['未分組卡片'].cost, 2);
assert.strictEqual(g['其他資料夾（沒有對應卡片）'].cost, 4);
assert.ok(!g['空專案'], 'project without usage is not listed');
assert.strictEqual(s.groups.reduce((a, x) => a + x.cost, 0), s.totals.month.cost);   // groups add up to the total
// models
assert.deepStrictEqual(s.models.map(m => m.name), ['claude-opus-5-5', 'claude-sonnet-5-5']);
// empty / malformed input does not throw
assert.strictEqual(U.summarize(null, { now }).totals.month.cost, 0);
assert.strictEqual(U.summarize({ projects: { a: null } }, { now }).repos.length, 0);
// formatting
assert.strictEqual(U.money(5), '$5.00'); assert.strictEqual(U.money(1234.5), '$1,235');
assert.strictEqual(U.compact(423421395), '423.4M'); assert.strictEqual(U.compact(1500), '1.5K'); assert.strictEqual(U.compact(12), '12');
console.log('usage-calc tests passed');
