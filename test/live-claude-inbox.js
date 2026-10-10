// Live check against REAL Claude Code sessions (starts two Haiku sessions; uses tokens). Not part of the unit tests.
// Run: node test/live-claude-inbox.js
// Edge/error behaviour of Claude Code's cross-session inbox, against Claude sessions this test starts itself.
// The test process registers its own inbox (agent-deck-edgetest) to receive receipts and idle notices.
const path = require('path'); const fs = require('fs'); const os = require('os'); const net = require('net');
const pty = require('../node_modules/node-pty');
const ccmsg = require('../src/main/ccmsg');
const { createPeer } = require('../src/main/ccpeer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SESS = ccmsg.sessionsDir();
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/i.test(k)));
const plain = s => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
const results = [];
const rec = (name, pass, detail) => { results.push({ name, pass, detail }); console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : '')); };

async function startClaude(mode) {
  const p = pty.spawn(path.join(os.homedir(), '.local', 'bin', 'claude.exe'), ['--model', 'haiku', '--permission-mode', mode], { name: 'xterm-256color', cols: 140, rows: 45, cwd: 'D:\\AWORKSPACE\\Github\\ClaudeApp', env, useConpty: true });
  let screen = ''; p.onData(d => { screen += d; if (screen.length > 600000) screen = screen.slice(-300000); });
  let s; for (let i = 0; i < 40 && !s; i++) { await sleep(1000); s = ccmsg.listSessions().find(x => x.pid === p.pid); }
  for (let i = 0; i < 30; i++) { await sleep(1000); const e = ccmsg.listSessions().find(x => x.pid === p.pid); if (e && e.status === 'idle') break; }
  return { p, session: s, screen: () => plain(screen) };
}
// raw connection helper: write lines, report whether/when the server closed it
const raw = (sock, lines, waitMs = 6000) => new Promise(resolve => {
  const t0 = Date.now(); let closedAt = null;
  const c = net.connect(sock, () => { for (const l of lines) c.write(l + '\n'); });
  c.on('close', () => { closedAt = Date.now() - t0; });
  c.on('error', () => {});
  setTimeout(() => { const open = closedAt === null; try { c.destroy(); } catch {} resolve({ closedByServerMs: closedAt, stillOpen: open }); }, waitMs);
});

(async () => {
  const got = { status: [], idle: [] };
  const peer = createPeer({ name: 'agent-deck-edgetest', onStatus: r => got.status.push(r), onIdle: r => got.idle.push(r), onUser: () => {} });
  const me = await peer.start();
  const from = me.address;
  let def, byp;
  try {
    def = await startClaude('default');
    byp = await startClaude('bypassPermissions');
    const token = ccmsg.readToken(def.session);

    // E1: connect and send nothing -> the inbox closes the connection (first-line deadline)
    const e1 = await raw(def.session.socket, [], 40000);   // the first-line deadline is about 30 s
    rec('E1 silent connection is closed by the inbox', !e1.stillOpen, `closed after ${e1.closedByServerMs} ms`);
    // E2: wrong token, then a user frame -> refused, nothing reaches the session
    const before2 = def.screen().length;
    const e2 = await raw(def.session.socket, [JSON.stringify({ type: 'auth', token: '0'.repeat(32) }), JSON.stringify({ type: 'user', msgV: 1, msg_id: 'x', priority: 'next', message: { role: 'user', content: 'E2-WRONG-TOKEN-TEXT' } })], 4000);
    await sleep(3000);
    rec('E2 wrong token: connection closed and nothing delivered', !e2.stillOpen && !def.screen().slice(before2).includes('E2-WRONG-TOKEN-TEXT'), `closed after ${e2.closedByServerMs} ms`);
    // E3: malformed line after a valid auth, then a valid frame -> the bad line is ignored, the good one arrives
    const e3 = await raw(def.session.socket, [JSON.stringify({ type: 'auth', token }), '{this is not json', JSON.stringify({ type: 'user', msgV: 1, msg_id: 'e3-' + Date.now(), priority: 'next', message: { role: 'user', content: 'Reply with exactly: E3-OK-7781' } })], 4000);
    let e3ok = false; for (let i = 0; i < 40 && !e3ok; i++) { await sleep(1000); e3ok = /E3-OK-7781/.test(def.screen().split('Reply with exactly: E3-OK-7781').slice(1).join('')); }
    rec('E3 malformed line is skipped, the next valid frame is processed', e3ok, `connection ${e3.stillOpen ? 'kept open' : 'closed at ' + e3.closedByServerMs + ' ms'}`);
    // E4: user frame with our reply address to a default-mode session -> answered; which receipt comes back?
    await sleep(3000);
    const s4 = await ccmsg.sendToSession(def.session, 'What is 2000+3001? Reply with only the number.', { from, fromName: 'agent-deck-edgetest' });
    let e4 = false; for (let i = 0; i < 45 && !e4; i++) { await sleep(1000); e4 = /\b5001\b/.test(def.screen()); }
    const r4 = got.status.filter(r => r.origMsgId === s4.msgId).map(r => r.status);
    rec('E4 default-mode session queues and answers an identified peer message', e4, `receipts for it: ${r4.join(',') || 'none (no receipt is sent when it is simply queued)'}`);
    // E5: bypass-mode session holds it -> "held" receipt; the user denies -> "denied" receipt
    const s5 = await ccmsg.sendToSession(byp.session, 'E5 test message, please deny it.', { from, fromName: 'agent-deck-edgetest' });
    let held = false; for (let i = 0; i < 20 && !held; i++) { await sleep(1000); held = got.status.some(r => r.origMsgId === s5.msgId && r.status === 'held'); }
    rec('E5a bypass-mode session holds it and sends a "held" receipt', held, (got.status.find(r => r.origMsgId === s5.msgId) || {}).reason || '');
    for (let i = 0; i < 10 && !/Deny — drop it/.test(byp.screen()); i++) await sleep(1000);
    byp.p.write('\r');   // the review dialog's default option is Deny
    let denied = false; for (let i = 0; i < 20 && !denied; i++) { await sleep(1000); denied = got.status.some(r => r.origMsgId === s5.msgId && r.status === 'denied'); }
    rec('E5b the user denies it -> the sender gets a "denied" receipt', denied, got.status.filter(r => r.origMsgId === s5.msgId).map(r => r.status).join(' -> '));
    // E6: idle subscription WITHOUT attesting a mode, to a default-mode session -> one peer_idle_notice
    await sleep(2000);
    const s6 = await ccmsg.subscribeIdle(def.session, { from });
    await sleep(1500);
    await ccmsg.sendToSession(def.session, 'Reply with only: ok', { from, fromName: 'agent-deck-edgetest' });   // make it busy, then idle again
    let idle = false; for (let i = 0; i < 45 && !idle; i++) { await sleep(1000); idle = got.idle.some(n => n.origMsgId === s6.msgId); }
    rec('E6 notify_when_idle without a mode -> exactly one peer_idle_notice when it goes idle', idle && got.idle.filter(n => n.origMsgId === s6.msgId).length === 1, `${got.idle.filter(n => n.origMsgId === s6.msgId).length} notice(s)`);
    // E7: message to a pipe nobody listens on -> clean error on the sender side
    const e7 = await ccmsg.sendToSession({ ...def.session, socket: '\\\\.\\pipe\\LOCAL\\cc-msg-' + '0'.repeat(32) }, 'x');
    rec('E7 dead inbox -> sender reports an error instead of hanging', e7.ok === false, e7.error);
  } catch (e) { console.log('error', e.stack); }
  finally {
    try { def?.p.kill(); } catch {} try { byp?.p.kill(); } catch {}
    peer.stop();
    
    console.log('edgetest registration removed:', !fs.readdirSync(SESS).some(f => f.startsWith(process.pid + '.')));
    process.exit(0);
  }
})();
