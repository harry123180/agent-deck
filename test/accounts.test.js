'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../src/accounts');
const { claudeEncode } = require('../src/sessions');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-acct-'));
const dirA = path.join(root, '.claude'), dirB = path.join(root, '.claude-b');
const cwd = String.raw`D:\Work\LMS`;
const enc = claudeEncode(cwd);
const ID1 = 'aaaaaaaa-0000-4000-8000-000000000001', ID2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const put = (file, text, mtime) => {
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  if (mtime) fs.utimesSync(file, new Date(mtime), new Date(mtime));
};
const conv = text => `{"type":"user","cwd":${JSON.stringify(cwd)},"message":"${text}"}\n`;

// account A has two conversations + sidecar data + secrets that must NEVER be copied
put(path.join(dirA, 'projects', enc, ID1 + '.jsonl'), conv('old'), '2026-10-01T10:00:00Z');
put(path.join(dirA, 'projects', enc, ID2 + '.jsonl'), conv('newest'), '2026-10-09T10:00:00Z');
put(path.join(dirA, 'projects', enc, ID2, 'subagents', 'agent-1.jsonl'), 'sub');
put(path.join(dirA, 'file-history', ID2, 'snap1'), 'snapshot');
put(path.join(dirA, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"SECRET-A"}}');
put(path.join(dirA, '.claude.json'), '{"oauthAccount":{"emailAddress":"a@example.com"}}');
put(path.join(dirA, 'settings.json'), '{}');

const walk = d => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];

// 1. explicit session id
let r = A.handoff({ cwd, sessionId: ID2, fromDir: dirA, toDir: dirB });
assert.strictEqual(r.ok, true); assert.strictEqual(r.sessionId, ID2);
assert.strictEqual(fs.readFileSync(path.join(dirB, 'projects', enc, ID2 + '.jsonl'), 'utf8'), conv('newest'));
assert.ok(fs.existsSync(path.join(dirB, 'projects', enc, ID2, 'subagents', 'agent-1.jsonl')));
assert.ok(fs.existsSync(path.join(dirB, 'file-history', ID2, 'snap1')));
assert.ok(!fs.existsSync(path.join(dirB, 'projects', enc, ID1 + '.jsonl')), 'only the requested conversation is copied');
// SECURITY: nothing but conversation data lands in B; credentials / account info / settings stay put
const landed = walk(dirB).map(f => path.relative(dirB, f).split(path.sep).join('/'));
assert.ok(landed.every(f => f.startsWith('projects/') || f.startsWith('file-history/')), landed.join());
assert.ok(!landed.some(f => /credentials|\.claude\.json|settings/i.test(f)));
assert.ok(!walk(dirB).some(f => fs.readFileSync(f, 'utf8').includes('SECRET-A')));
// the copy keeps the original timestamp so "newest" stays meaningful
assert.ok(Math.abs(fs.statSync(path.join(dirB, 'projects', enc, ID2 + '.jsonl')).mtimeMs - Date.parse('2026-10-09T10:00:00Z')) < 2000);

// 2. legacy card without an id (`claude --continue`) -> newest conversation of that folder in the source account
fs.rmSync(dirB, { recursive: true, force: true });
r = A.handoff({ cwd, sessionId: '', fromDir: dirA, toDir: dirB });
assert.strictEqual(r.ok, true); assert.strictEqual(r.sessionId, ID2);

// 3. switching back: the target already has a LATER state -> keep it, don't overwrite with older data
put(path.join(dirB, 'projects', enc, ID2 + '.jsonl'), conv('continued in B'), new Date(Date.now() + 60000));
r = A.handoff({ cwd, sessionId: ID2, fromDir: dirA, toDir: dirB });
assert.strictEqual(r.ok, true); assert.strictEqual(r.keptNewerTarget, true);
assert.strictEqual(fs.readFileSync(path.join(dirB, 'projects', enc, ID2 + '.jsonl'), 'utf8'), conv('continued in B'));
r = A.handoff({ cwd, sessionId: ID2, fromDir: dirB, toDir: dirA });                 // B -> A carries B's newer state back
assert.strictEqual(r.ok, true); assert.strictEqual(fs.readFileSync(path.join(dirA, 'projects', enc, ID2 + '.jsonl'), 'utf8'), conv('continued in B'));

// 4. failures are explicit, nothing is half-copied
assert.strictEqual(A.handoff({ cwd, sessionId: ID1, fromDir: dirA, toDir: dirA }).ok, false);                  // same account
assert.strictEqual(A.handoff({ cwd: String.raw`D:\Nope`, sessionId: '', fromDir: dirA, toDir: dirB }).ok, false); // no conversation there
assert.strictEqual(A.handoff({ cwd, sessionId: 'cccccccc-0000-4000-8000-000000000003', fromDir: dirA, toDir: dirB }).ok, false);

// 5. ids are read from the command a card stores
assert.strictEqual(A.sessionIdFromCommand(`claude --resume ${ID1}`), ID1);
assert.strictEqual(A.sessionIdFromCommand('claude --continue', `claude --session-id ${ID2.toUpperCase()}`), ID2);
assert.strictEqual(A.sessionIdFromCommand('claude --continue', 'claude'), '');
assert.strictEqual(A.sessionIdFromCommand(undefined, null), '');

// 6. dir resolution: empty = default account (~/.claude, or CLAUDE_CONFIG_DIR when set)
assert.strictEqual(A.resolveDir('', { home: 'H' }), path.join('H', '.claude'));
assert.strictEqual(A.resolveDir('', { home: 'H', env: { CLAUDE_CONFIG_DIR: 'E' } }), 'E');
assert.strictEqual(A.resolveDir('  X ', { home: 'H' }), 'X');
console.log('accounts tests passed');
