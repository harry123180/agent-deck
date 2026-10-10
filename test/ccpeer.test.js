'use strict';
// Agent Deck's inbox: registers like a Claude session (key file name rule included), accepts only authenticated
// frames, and decodes user messages, receipts and idle notices.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createPeer } = require('../src/main/ccpeer');
const ccmsg = require('../src/main/ccmsg');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-peer-'));
const got = { user: [], status: [], idle: [] };
const peer = createPeer({ home, name: 'agent-deck-test', onUser: m => got.user.push(m), onStatus: r => got.status.push(r), onIdle: r => got.idle.push(r) });
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // stale registrations: a dead Agent Deck's entry is removed, a dead Claude session's entry is left alone
  const sd = path.join(home, '.claude', 'sessions'); fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, '999991.json'), JSON.stringify({ pid: 999991, entrypoint: 'agent-deck' }));
  fs.writeFileSync(path.join(sd, '999991.' + 'a'.repeat(64) + '.key'), '{}');
  fs.writeFileSync(path.join(sd, '999992.json'), JSON.stringify({ pid: 999992, entrypoint: 'cli' }));
  const me = await peer.start();
  assert.ok(!fs.existsSync(path.join(sd, '999991.json')) && !fs.existsSync(path.join(sd, '999991.' + 'a'.repeat(64) + '.key')), 'stale Agent Deck registration cleared');
  assert.ok(fs.existsSync(path.join(sd, '999992.json')), 'a Claude session entry is never touched');
  const dir = path.join(home, '.claude', 'sessions');
  const reg = JSON.parse(fs.readFileSync(path.join(dir, `${process.pid}.json`), 'utf8'));
  assert.strictEqual(reg.name, 'agent-deck-test');
  assert.strictEqual(reg.peerProtocol, 1);
  assert.ok(/^\d{17,19}$/.test(reg.procStart), 'procStart is the real process start as FILETIME: ' + reg.procStart);
  assert.strictEqual(reg.messagingSocketPath, me.pipe);
  const keyFile = path.join(dir, `${process.pid}.${crypto.createHash('sha256').update(me.pipe.toLowerCase()).digest('hex')}.key`);
  assert.ok(fs.existsSync(keyFile), 'key file named <pid>.<sha256(lower(pipe))>.key');

  // a client using the same discovery a Claude session uses finds and authenticates to it
  const target = { pid: process.pid, socket: me.pipe, keyFile };
  let r = await ccmsg.sendToSession(target, 'hello deck', { from: 'uds:\\\\.\\pipe\\LOCAL\\cc-msg-abc', fromName: 'some-session' });
  assert.ok(r.ok);
  await ccmsg.writeFrames(target, [
    { type: 'control', action: 'peer_message_status', status: 'held', reason: 'permission-mode parity', orig_msg_id: 'm-1', from: 'uds:x', msgV: 1, msg_id: 'r1' },
    { type: 'control', action: 'peer_idle_notice', orig_msg_id: 'sub-1', from: 'uds:x', msgV: 1, msg_id: 'r2' },
  ]);
  await sleep(300);
  assert.deepStrictEqual(got.user.map(u => [u.text, u.fromName, u.from]), [['hello deck', 'some-session', 'uds:\\\\.\\pipe\\LOCAL\\cc-msg-abc']]);
  assert.deepStrictEqual(got.status.map(s => [s.origMsgId, s.status]), [['m-1', 'held']]);
  assert.deepStrictEqual(got.idle.map(s => s.origMsgId), ['sub-1']);

  // wrong token: nothing is accepted
  const bad = path.join(home, 'bad.key'); fs.writeFileSync(bad, JSON.stringify({ peerToken: 'x'.repeat(32) }));
  await ccmsg.sendToSession({ ...target, keyFile: bad }, 'intruder');
  await sleep(300);
  assert.strictEqual(got.user.length, 1, 'unauthenticated frames are dropped');

  // envelope round trip
  const w = ccmsg.wrap('line1\nline2', { from: 'uds:p', fromName: 'n' });
  assert.deepStrictEqual(ccmsg.unwrap(w), { text: 'line1\nline2', attrs: { from: 'uds:p', 'from-name': 'n' } });
  assert.strictEqual(ccmsg.unwrap('plain').text, 'plain');

  peer.stop();
  assert.ok(!fs.existsSync(path.join(dir, `${process.pid}.json`)) && !fs.existsSync(keyFile), 'registration removed on stop');
  console.log('ccpeer tests passed');
})().catch(e => { console.error(e); process.exit(1); });
