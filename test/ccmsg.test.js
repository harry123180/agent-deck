'use strict';
// Speaks the reverse-engineered protocol against a fake inbox: registry entry + key file + a pipe/socket server that
// checks the auth line exactly like a Claude session would.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { listSessions, sendToSession } = require('../src/main/ccmsg');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-cc-'));
const dir = path.join(home, '.claude', 'sessions');
fs.mkdirSync(dir, { recursive: true });
const sock = process.platform === 'win32' ? `\\\\.\\pipe\\LOCAL\\cc-msg-test${Date.now().toString(16)}` : path.join(home, 's.sock');
const token = 'a'.repeat(32);
const pid = process.pid;   // a live pid, so the entry counts as running
fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: 's1', cwd: 'D:\\x', name: 'worker', status: 'idle', messagingSocketPath: sock, peerProtocol: 1 }));
fs.writeFileSync(path.join(dir, `${pid}.${'f'.repeat(64)}.key`), JSON.stringify({ peerToken: token, procStartFt: '1', pidDomain: 'win32:msi' }));
fs.writeFileSync(path.join(dir, '999999.json'), JSON.stringify({ pid: 999999, messagingSocketPath: 'x', peerProtocol: 1 }));   // dead process
fs.writeFileSync(path.join(dir, `${pid + 1}.json`), '{not json');

const received = [];
const server = net.createServer(c => {
  let buf = '', authed = false;
  c.setEncoding('utf8');
  c.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (!authed) { authed = line.type === 'auth' && line.token === token; if (!authed) c.destroy(); continue; }
      received.push(line);
    }
  });
});

(async () => {
  await new Promise(r => server.listen(sock, r));
  const list = listSessions({ home });
  assert.strictEqual(list.length, 1, 'only the live, well-formed session is listed');
  assert.strictEqual(list[0].name, 'worker');
  assert.ok(list[0].keyFile.endsWith('.key'));

  const r = await sendToSession(list[0], 'hello from Agent Deck');
  assert.ok(r.ok && r.msgId, JSON.stringify(r));
  await new Promise(res => setTimeout(res, 200));
  assert.strictEqual(received.length, 1, 'one user frame after a valid auth line');
  assert.strictEqual(received[0].type, 'user');
  assert.deepStrictEqual(received[0].message, { role: 'user', content: 'hello from Agent Deck' });
  assert.strictEqual(received[0].msg_id, r.msgId);

  // wrong key -> the inbox drops the connection, nothing is queued
  fs.writeFileSync(list[0].keyFile, JSON.stringify({ peerToken: 'b'.repeat(32) }));
  await sendToSession(list[0], 'should not arrive');
  await new Promise(res => setTimeout(res, 200));
  assert.strictEqual(received.length, 1, 'unauthenticated text is not accepted');

  // no key / nobody listening -> clear errors
  assert.strictEqual((await sendToSession({ ...list[0], keyFile: '' }, 'x')).ok, false);
  server.close();
  const gone = await sendToSession({ ...list[0], keyFile: list[0].keyFile }, 'x');
  assert.strictEqual(gone.ok, false);
  console.log('ccmsg tests passed');
})().catch(e => { console.error(e); process.exit(1); });
