'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../src/store');
const { launchCommand } = require('../src/agents');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-'));
const file = path.join(dir, 'state.json');

// new tab -> start cmd, after launch -> resume cmd
const t = store.newTab({ cwd: String.raw`D:\proj\foo`, agent: 'claude' });
assert.strictEqual(t.title, 'foo');
assert.strictEqual(launchCommand(t), 'claude');
t.launched = true;
assert.strictEqual(launchCommand(t), 'claude --continue');
assert.strictEqual(launchCommand({ ...t, autoRun: false }), '');
assert.strictEqual(launchCommand(store.newTab({ cwd: 'x', agent: 'shell' })), '');
// custom agent with only a start command falls back to it on resume
const c = store.newTab({ cwd: 'x', agent: 'custom', startCmd: 'dsh', launched: true });
assert.strictEqual(launchCommand(c), 'dsh');

// round trip + corruption fallback to .bak
const st = store.normalize({ tabs: [t, c], activeId: c.id });
store.save(file, st);
store.save(file, st);              // second save creates .bak
fs.writeFileSync(file, '{broken');
const back = store.load(file);
assert.strictEqual(back.tabs.length, 2);
assert.strictEqual(back.activeId, c.id);
// garbage input -> defaults
assert.strictEqual(store.load(path.join(dir, 'nope.json')).tabs.length, 0);
assert.strictEqual(store.normalize({ tabs: [{ cwd: 'a' }], activeId: 'zzz' }).activeId !== 'zzz', true);
// projects + split view
const a = store.newTab({ id: 'a', cwd: 'x', projectId: 'p1' }), b = store.newTab({ id: 'b', cwd: 'y', projectId: 'ghost' });
const pv = store.normalize({ projects: [{ id: 'p1', name: 'P', color: '#ff0000', collapsed: true }, { name: 'no id' }], tabs: [a, b],
  activeId: 'b', view: { ids: ['a', 'zzz'], layout: 'cols' } });
assert.strictEqual(pv.projects.length, 1);
assert.strictEqual(pv.projects[0].collapsed, true);
assert.strictEqual(pv.tabs[0].projectId, 'p1');
assert.strictEqual(pv.tabs[1].projectId, '');          // dangling project reference cleared
assert.deepStrictEqual(pv.view.ids, ['b', 'a']);       // active tab is always part of the view, unknown ids dropped
assert.strictEqual(pv.view.layout, 'cols');
assert.strictEqual(store.normalize({ view: { layout: 'bad layout!' } }).view.layout, 'auto');
assert.deepStrictEqual(store.normalize({ view: { cols: [2, 1], rows: [1, -1] } }).view.cols, [2, 1]);
assert.deepStrictEqual(store.normalize({ view: { rows: [1, -1] } }).view.rows, []);   // invalid fractions dropped
assert.strictEqual(store.newTab({ cwd: 'x', fontSize: 99 }).fontSize, 40);
assert.strictEqual(store.newTab({ cwd: 'x' }).fontSize, 0);
// resume commands must be real flags of each CLI (verified against --help)
const { AGENTS } = require('../src/agents');
assert.strictEqual(AGENTS.gemini.resume, 'gemini --resume latest');   // bare --resume needs a value
assert.strictEqual(AGENTS.agy.resume, 'agy --continue');
assert.strictEqual(AGENTS.codex.resume, 'codex resume --last');
assert.strictEqual(AGENTS.opencode.resume, 'opencode --continue');

// ---- multiple Claude accounts ----
const d0 = store.normalize({});
assert.strictEqual(d0.accounts.length, 1);                              // the default account always exists
assert.strictEqual(d0.accounts[0].id, 'default'); assert.strictEqual(d0.accounts[0].configDir, '');
assert.strictEqual(d0.settings.autoSwitch, false);                       // auto switching is opt-in
const withB = store.normalize({
  accounts: [{ id: 'acct-b', name: 'Work', configDir: ' C:/x/b ', color: '#f59e42' }, { id: 'default', name: 'Main', configDir: 'EVIL' }, { name: 'no id' }, null],
  tabs: [{ cwd: 'a', accountId: 'acct-b' }, { cwd: 'b', accountId: 'deleted' }, { cwd: 'c' }],
});
assert.deepStrictEqual(withB.accounts.map(a => a.id), ['default', 'acct-b']);            // default first, junk dropped
assert.strictEqual(withB.accounts[0].name, 'Main');                                       // default may be renamed ...
assert.strictEqual(withB.accounts[0].configDir, '');                                      // ... but always stays ~/.claude
assert.strictEqual(withB.accounts[1].configDir, 'C:/x/b');
assert.deepStrictEqual(withB.tabs.map(t => t.accountId), ['acct-b', 'default', 'default']);   // dangling / missing -> default
assert.strictEqual(store.normalize({ accounts: [{ id: 'z', name: 'Z' }] }).accounts[1].color.startsWith('#'), true);
console.log('store tests passed');
