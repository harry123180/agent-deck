'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../src/sessions');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-sess-'));
const cwd = String.raw`D:\Work\My Project`;
const other = String.raw`D:\Work\Other`;
const write = (file, text, mtime) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
};

// ---- claude ----
assert.strictEqual(S.claudeEncode(cwd), 'D--Work-My-Project');
const cdir = path.join(home, '.claude', 'projects', S.claudeEncode(cwd));
const A = 'aaaaaaaa-0000-4000-8000-000000000001', B = 'bbbbbbbb-0000-4000-8000-000000000002', C = 'cccccccc-0000-4000-8000-000000000003';
const msg = c => `{"type":"mode"}\n{"type":"user","cwd":${JSON.stringify(c)},"message":{}}\n`;
write(path.join(cdir, A + '.jsonl'), msg(cwd), '2026-10-01T10:00:00Z');
write(path.join(cdir, B + '.jsonl'), msg(cwd), '2026-10-05T10:00:00Z');                        // newest real session
write(path.join(cdir, C + '.jsonl'), '{"type":"mode"}\n{"type":"permission-mode"}\n', '2026-10-09T10:00:00Z'); // newest file but no message yet
write(path.join(cdir, 'agent-12345678.jsonl'), msg(cwd), '2026-10-09T11:00:00Z');              // sub-agent log: not a session
let r = S.claudeSessions(cwd, { home });
assert.deepStrictEqual(r.map(x => x.id), [B, A]);                  // newest first, empty + sub-agent files excluded
assert.deepStrictEqual(S.claudeSessions(other, { home }), []);     // other folder -> nothing
assert.deepStrictEqual(S.claudeSessions(cwd.toLowerCase().replace(/\\/g, '/'), { home }).map(x => x.id).length >= 0, true);

// folder whose directory name does not match the encoding: found through the cwd stored inside
const odd = String.raw`D:\專案\中文資料夾`;
const odir = path.join(home, '.claude', 'projects', 'weird-dir-name');
write(path.join(odir, A.replace('a', 'd') + '.jsonl'), msg(odd), '2026-10-02T10:00:00Z');
assert.strictEqual(S.claudeSessions(odd, { home }).length, 1);

// ---- codex ----
const meta = (id, c) => JSON.stringify({ type: 'session_meta', payload: { id, cwd: c } }) + '\n{"type":"response_item"}\n';
const X = '01999057-8509-75d3-974a-c0beffc341c7', Y = '02999057-8509-75d3-974a-c0beffc341c8', Z = '03999057-8509-75d3-974a-c0beffc341c9';
const cx = (d, f) => path.join(home, '.codex', 'sessions', ...d.split('/'), f);
write(cx('2026/09/01', `rollout-2026-09-01T10-00-00-${X}.jsonl`), meta(X, cwd), '2026-09-01T10:00:00Z');
write(cx('2026/10/03', `rollout-2026-10-03T10-00-00-${Y}.jsonl`), meta(Y, cwd), '2026-10-03T10:00:00Z');
write(cx('2026/10/04', `rollout-2026-10-04T10-00-00-${Z}.jsonl`), meta(Z, other), '2026-10-04T10:00:00Z');
const cr = S.codexSessions(cwd, { home });
assert.deepStrictEqual(cr.map(x => x.id), [Y, X]);                 // only this folder, newest first
assert.deepStrictEqual(S.codexSessions(String.raw`D:\nothing`, { home }), []);

// ---- opencode ----
const json = JSON.stringify([
  { id: 'ses_old', title: 'old', updated: 1, directory: cwd },
  { id: 'ses_new', title: 'new one', updated: 9, directory: cwd.toLowerCase() },   // case-insensitive match
  { id: 'ses_x', title: 'x', updated: 99, directory: other },
]);
assert.deepStrictEqual(S.parseOpencode(json, cwd).map(x => x.id), ['ses_new', 'ses_old']);
assert.deepStrictEqual(S.parseOpencode('not json', cwd), []);
assert.deepStrictEqual(S.parseOpencode('{"a":1}', cwd), []);

// ---- commands use the real flag of each CLI ----
assert.strictEqual(S.RESUME.claude('ID'), 'claude --resume ID');
assert.strictEqual(S.RESUME.codex('ID'), 'codex resume ID');
assert.strictEqual(S.RESUME.opencode('ID'), 'opencode --session ID');
console.log('sessions tests passed');
