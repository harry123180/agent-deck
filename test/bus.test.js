'use strict';
// End-to-end: real bus (HTTP) + the real MCP server as a child process speaking JSON-RPC over stdio.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createBus } = require('../src/main/bus');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-bus-'));
const busFile = path.join(dir, 'bus.json');
const writes = [];                                   // what was typed into each card
const alive = new Set(['c-codex', 'c-claude', 'c-open']);
const bus = createBus({ file: busFile, writeToCard: (id, text, enter) => { if (!alive.has(id)) return false; writes.push({ id, text, enter }); return true; } });
const cards = state => [
  { id: 'c-claude', title: '中控', project: '', agent: 'Claude Code', state: 'idle', stateLabel: '待輸入', cwd: 'D:\\x', tail: '' },
  { id: 'c-codex', title: 'backend', project: 'Shop', agent: 'Codex', state, stateLabel: state, cwd: 'D:\\shop\\api', tail: 'line1\nline2\nall tests pass' },
  { id: 'c-open', title: 'docs', project: 'Shop', agent: 'OpenCode', state: 'idle', stateLabel: '待輸入', cwd: 'D:\\shop\\docs', tail: '' },
];

(async () => {
  await bus.start();
  bus.updateCards(cards('working'));
  assert.ok(JSON.parse(fs.readFileSync(busFile, 'utf8')).token.length >= 32, 'bus.json written with a token');

  // unauthorized requests are refused
  const info = JSON.parse(fs.readFileSync(busFile, 'utf8'));
  assert.strictEqual((await fetch(info.url + '/agents')).status, 401);
  assert.strictEqual((await fetch(info.url + '/agents', { headers: { authorization: 'Bearer nope' } })).status, 401);

  const mcp = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'bus', 'mcp-server.js')], {
    env: { ...process.env, AGENT_DECK_BUS: busFile, AGENT_DECK_CARD: '中控' }, stdio: ['pipe', 'pipe', 'inherit'],
  });
  let out = ''; const waiters = new Map(); let nextId = 1;
  mcp.stdout.setEncoding('utf8');
  mcp.stdout.on('data', d => { out += d; let i; while ((i = out.indexOf('\n')) >= 0) { const l = out.slice(0, i); out = out.slice(i + 1); const m = JSON.parse(l); waiters.get(m.id)?.(m); } });
  const rpc = (method, params) => new Promise(r => { const id = nextId++; waiters.set(id, r); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = async (name, args) => { const r = await rpc('tools/call', { name, arguments: args }); return { text: r.result.content[0].text, isError: !!r.result.isError }; };

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.strictEqual(init.result.serverInfo.name, 'agentdeck');
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = (await rpc('tools/list', {})).result.tools.map(t => t.name);
  assert.deepStrictEqual(tools, ['list_agents', 'read_agent', 'send_to_agent', 'message_status', 'wait_for_agent']);

  // roster across platforms
  let r = await call('list_agents', {});
  assert.ok(r.text.includes('You are "中控"') && r.text.includes('backend | Codex') && r.text.includes('docs | OpenCode'), r.text);

  // read another agent's screen
  r = await call('read_agent', { agent: 'backend', lines: 1 });
  assert.ok(r.text.includes('all tests pass') && !r.text.includes('line1'), r.text);

  // send to an idle OpenCode card: delivered at once, as a bracketed paste with sender header, then Enter
  r = await call('send_to_agent', { agent: 'docs', message: '請更新 README 的安裝步驟' });
  assert.ok(/: delivered/.test(r.text), r.text);
  const w = writes.at(-1);
  assert.strictEqual(w.id, 'c-open');
  assert.ok(w.text.startsWith('\x1b[200~') && w.text.endsWith('\x1b[201~') && w.enter === '\r');
  assert.ok(w.text.includes('from="中控"') && w.text.includes('請更新 README 的安裝步驟'));

  // send to a WORKING Codex card: queued, never typed into a busy agent ...
  r = await call('send_to_agent', { agent: 'backend', message: '完成後回報測試結果' });
  assert.ok(/: queued/.test(r.text), r.text);
  const qid = r.text.match(/message (\w+)/)[1];
  assert.ok(!writes.some(x => x.id === 'c-codex'), 'not delivered while working');
  // ... and delivered as soon as it becomes idle
  bus.updateCards(cards('idle'));
  assert.ok(writes.some(x => x.id === 'c-codex' && x.text.includes('完成後回報測試結果')), 'delivered when idle');
  r = await call('message_status', { id: qid });
  assert.ok(r.text.includes('delivered'), r.text);

  // when="now" goes in immediately even if busy
  bus.updateCards(cards('working'));
  r = await call('send_to_agent', { agent: 'backend', message: 'stop', when: 'now' });
  assert.ok(/: delivered/.test(r.text), r.text);

  // errors are reported as tool errors, not crashes
  r = await call('send_to_agent', { agent: 'nobody', message: 'hi' });
  assert.ok(r.isError && r.text.includes('no card named'), r.text);
  r = await call('send_to_agent', { agent: 'docs', message: '   ' });
  assert.ok(r.isError, r.text);

  // loop protection: a reply chain that bounces between agents is cut off
  // a reply to whoever asked is allowed ...
  const first = bus.send({ to: 'backend', text: 'q', from: '中控', when: 'now' });
  const back = bus.send({ to: '中控', text: 'a', from: 'backend', replyTo: first.id, when: 'now' });
  assert.ok(!back.error && back.status === 'delivered', 'a direct reply is delivered: ' + JSON.stringify(back));
  // ... but endless ping-pong stops after MAX_HOPS exchanges
  let prev = back, a2 = 'backend', b2 = '中控', n = 2;
  for (; n < 10; n++) { const r = bus.send({ to: a2, text: 'x', from: b2, replyTo: prev.id, when: 'now' }); if (r.error) { prev = r; break; } prev = r; [a2, b2] = [b2, a2]; }
  assert.ok(prev.error && prev.error.includes('hop limit') && n === 4, `ping-pong stopped at exchange ${n}: ${JSON.stringify(prev)}`);
  assert.ok(bus.send({ to: 'docs', text: 'x', from: 'docs', when: 'now' }).error, 'cannot message yourself');
  const tooLong = bus.send({ to: 'docs', text: 'x', from: 'e', hops: ['a', 'b', 'c', 'd'], when: 'now' });
  assert.ok(tooLong.error && tooLong.error.includes('hop limit'), JSON.stringify(tooLong));

  // a card whose terminal is not running -> failed, with a reason
  alive.delete('c-codex');
  const dead = bus.send({ to: 'backend', text: 'x', from: '中控', when: 'now' });
  assert.strictEqual(dead.status, 'failed');

  mcp.stdin.end(); bus.stop();
  console.log('bus tests passed');
})().catch(e => { console.error(e); process.exit(1); });
