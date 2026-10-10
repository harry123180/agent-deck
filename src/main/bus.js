'use strict';
// Agent Deck message bus — lets one agent (the central one) talk to the agents in every card, whatever the platform
// (Claude Code, Codex, OpenCode, agy, ...), and to Claude Code sessions running outside Agent Deck.
//
// Two delivery lanes:
//   native  Claude Code's own cross-session inbox (see ccmsg.js). Used for Claude cards and for Claude sessions
//           outside Agent Deck. Claude Code itself decides whether to queue the message or hold it for its user's
//           approval (sessions that bypass permission prompts hold messages from unattested senders).
//   paste   For every other CLI: when the target card is waiting for input, the message is pasted into its terminal
//           (bracketed paste) and submitted.
//
// Modelled on Claude Code's messaging: a live roster (≈ its session registry), a local endpoint guarded by a token
// (≈ its per-session pipe + key), an envelope carrying from= / hop-chain=, idle-gated delivery (≈ notify_when_idle)
// and message status lookups (≈ peer_message_status).
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_HOPS = 4;
// Only a plain "waiting for input" prompt receives pasted messages. An agent that is asking a question (permission
// prompt, y/n, picker) must not get text pasted into it: that could answer the question by accident.
const READY = new Set(['idle']);

function envelope(msg) {
  const hops = [...msg.hops, msg.from].join(' > ');
  return `[Agent Deck 訊息 from="${msg.from}" id=${msg.id} hop-chain="${hops}"]\n${msg.text}\n` +
    `[若要回覆，請用 agentdeck 的 send_to_agent 工具送給 "${msg.from}"，並帶 reply_to=${msg.id}]`;
}

// native: { sessionForCard(card) -> Promise<session|null>, externals() -> Promise<session[]>, send(session, text) -> Promise<{ok,error}> }
// claudeLane: () => 'native' | 'paste'
// peer: { address() } of Agent Deck's own inbox on the Claude network (for replies and receipts), or null
function createBus({ writeToCard, file, native = null, claudeLane = () => 'native', peer = null, centralName = '中控' }) {
  const token = crypto.randomBytes(24).toString('hex');
  let cards = [];                 // latest roster from the renderer
  const messages = new Map();     // id -> message
  const byNativeId = new Map();   // Claude msg_id -> message (to apply delivery receipts)
  const lastSender = new Map();   // Claude inbox address -> the card that last wrote to it (where its replies go)
  const inbox = [];               // messages from Claude sessions that could not be routed to a card
  let server = null;

  const norm = s => String(s || '').trim().toLowerCase();
  async function externals() {
    if (!native) return [];
    try { return await native.externals(); } catch { return []; }
  }
  // every reachable agent: cards first, then Claude sessions outside Agent Deck
  async function roster() {
    const ext = (await externals()).map(s => ({
      id: `ext:${s.pid}`, title: s.name ? `${s.name}` : `claude-${s.pid}`, project: '', agent: 'Claude Code（外部 session）', agentKey: 'claude',
      state: s.status === 'idle' ? 'idle' : s.status === 'busy' ? 'working' : (s.status || 'unknown'),
      stateLabel: s.status === 'idle' ? '待輸入' : s.status === 'busy' ? '工作中' : (s.status || '未知'), cwd: s.cwd, tail: '', external: s,
    }));
    const titles = new Set(cards.map(c => norm(c.title)));
    for (const e of ext) if (titles.has(norm(e.title))) e.title = `${e.title}（外部）`;
    return [...cards, ...ext];
  }
  const findIn = (list, key) => {
    const k = norm(key);
    return list.find(c => c.id === key) || list.find(c => norm(c.title) === k) ||
      list.find(c => k.length >= 2 && norm(c.title).includes(k));
  };

  async function deliver(msg) {
    if (msg.status !== 'queued') return;
    if (msg.lane === 'native') {
      msg.status = 'sending';
      let session = msg.externalSession || null;
      if (!session) {
        const card = cards.find(c => c.id === msg.toId);
        if (!card) { msg.status = 'failed'; msg.error = 'card no longer exists'; return; }
        try { session = await native.sessionForCard(card); } catch { session = null; }
      }
      if (!session) {
        // not falling back to pasting on purpose: that would sidestep Claude Code's own inbound-message policy
        msg.status = 'failed';
        msg.error = 'no Claude Code inbox found for that card (Claude not started yet, or a version without cross-session messaging)';
        return;
      }
      const from = peer && peer.address();
      const r = await native.send(session, envelope(msg), { from, fromName: 'agent-deck' });
      if (r.ok) {
        msg.status = 'delivered'; msg.deliveredAt = Date.now();
        msg.note = from ? 'in the Claude session inbox; its receipt will update this status' : 'in the Claude session inbox';
        if (r.msgId) { msg.nativeId = r.msgId; byNativeId.set(r.msgId, msg); }
        if (session.socket) lastSender.set(String(session.socket).toLowerCase(), msg.from);
      }
      else { msg.status = 'failed'; msg.error = r.error; }
      return;
    }
    const card = cards.find(c => c.id === msg.toId);
    if (!card) { msg.status = 'failed'; msg.error = 'card no longer exists'; return; }
    if (msg.when === 'idle' && !READY.has(card.state)) return;   // keep waiting
    const ok = writeToCard(card.id, `\x1b[200~${envelope(msg)}\x1b[201~`, '\r', card.agentKey);
    if (ok) { msg.status = 'delivered'; msg.deliveredAt = Date.now(); } else { msg.status = 'failed'; msg.error = 'card terminal is not running'; }
  }
  const pump = () => { for (const m of messages.values()) if (m.status === 'queued' && m.lane === 'paste') deliver(m); };
  const timer = setInterval(() => {
    pump();
    const now = Date.now();
    for (const [id, m] of messages) if (m.status !== 'queued' && m.status !== 'sending' && now - m.createdAt > 3600e3) messages.delete(id);
    for (const m of messages.values()) if (m.status === 'queued' && now - m.createdAt > m.timeoutMs) { m.status = 'expired'; m.error = 'target never became idle'; }
  }, 1000);
  timer.unref?.();

  async function send({ to, text, from = 'central', when = 'idle', hops = [], replyTo, timeoutS = 1800 }) {
    if (!text || !String(text).trim()) return { error: 'message is empty' };
    const target = findIn(await roster(), to);
    if (!target) return { error: `no agent named "${to}". Use list_agents to see the names.` };
    hops = Array.isArray(hops) ? hops.map(String).slice(0, 10) : [];
    // a reply carries the chain of the message it answers, so ping-pong between agents is bounded
    const orig = replyTo && messages.get(String(replyTo));
    if (orig) hops = [...orig.hops, orig.from];
    // Replying to whoever asked is normal; what must stop is an endless back-and-forth. Each reply extends the
    // chain by one, so a thread can go back and forth at most MAX_HOPS times.
    if (hops.length >= MAX_HOPS) return { error: `hop limit reached: this thread already went back and forth ${MAX_HOPS} times` };
    if (target.title === from) return { error: 'refused: an agent cannot send a message to itself' };
    const lane = target.external || (target.agentKey === 'claude' && native && claudeLane() === 'native') ? 'native' : 'paste';
    const msg = {
      id: crypto.randomUUID().slice(0, 8), from: String(from), toId: target.id, to: target.title, text: String(text).slice(0, 20000),
      when: when === 'now' ? 'now' : 'idle', hops, lane, externalSession: target.external || null,
      status: 'queued', createdAt: Date.now(), timeoutMs: Math.max(10, timeoutS) * 1000,
    };
    messages.set(msg.id, msg);
    await deliver(msg);
    return publicMsg(msg);
  }
  // Receipt from a Claude session (peer_message_status): held for its user's review, delivered, denied, ...
  function onReceipt({ origMsgId, status, reason }) {
    const m = byNativeId.get(origMsgId);
    if (!m || !status) return false;
    m.status = String(status); m.note = reason || m.note; m.receiptAt = Date.now();
    return true;
  }
  // A Claude session sent something to "agent-deck" with its built-in SendMessage: hand it to the card that last
  // wrote to that session (a reply), otherwise to the central card.
  async function receiveExternal({ from, fromName, text }) {
    const sender = fromName || from || 'unknown Claude session';
    const target = lastSender.get(String(from || '').replace(/^uds:/, '').toLowerCase()) || centralName;
    const list = await roster();
    const card = list.find(c => !c.external && c.title === target) || list.find(c => !c.external && c.title === centralName);
    if (!card) { inbox.push({ from: sender, text, at: Date.now() }); return { status: 'kept', note: 'no card to hand it to' }; }
    const lane = card.agentKey === 'claude' && native && claudeLane() === 'native' ? 'native' : 'paste';
    const msg = { id: crypto.randomUUID().slice(0, 8), from: sender, toId: card.id, to: card.title, text: String(text).slice(0, 20000), when: 'idle', hops: [],
      lane, externalSession: null, status: 'queued', createdAt: Date.now(), timeoutMs: 1800e3, external: true };
    messages.set(msg.id, msg);
    await deliver(msg);
    return publicMsg(msg);
  }
  const publicMsg = m => ({ id: m.id, to: m.to, from: m.from, status: m.status, lane: m.lane, when: m.when, error: m.error || undefined, note: m.note || undefined, deliveredAt: m.deliveredAt });

  // ---- HTTP API (127.0.0.1 only, bearer token) ----
  function handler(req, res) {
    const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'unauthorized' });
    const url = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      let data = {};
      try { data = body ? JSON.parse(body) : {}; } catch { return reply(400, { error: 'bad json' }); }
      try {
        if (req.method === 'GET' && url.pathname === '/agents') {
          const all = await roster();
          return reply(200, { agents: all.map(c => ({ name: c.title, project: c.project, platform: c.agent, state: c.state, stateLabel: c.stateLabel, folder: c.cwd, lane: c.external || c.agentKey === 'claude' ? (native && (c.external || claudeLane() === 'native') ? 'native' : 'paste') : 'paste', external: !!c.external })) });
        }
        if (req.method === 'GET' && url.pathname === '/read') {
          const card = findIn(await roster(), url.searchParams.get('agent'));
          if (!card) return reply(404, { error: 'no such agent' });
          if (card.external) return reply(200, { name: card.title, state: card.state, stateLabel: card.stateLabel, screen: '(這是 Agent Deck 以外的 Claude session，無法讀取它的畫面；可以用 send_to_agent 傳訊息給它)' });
          const n = Math.min(200, Math.max(1, Number(url.searchParams.get('lines')) || 40));
          return reply(200, { name: card.title, state: card.state, stateLabel: card.stateLabel, screen: (card.tail || '').split('\n').slice(-n).join('\n') });
        }
        if (req.method === 'POST' && url.pathname === '/send') return reply(200, await send(data));
        if (req.method === 'GET' && url.pathname === '/message') {
          const m = messages.get(url.searchParams.get('id'));
          return m ? reply(200, publicMsg(m)) : reply(404, { error: 'unknown message id' });
        }
        reply(404, { error: 'not found' });
      } catch (err) { reply(500, { error: String(err && err.message || err) }); }
    });
  }

  function start() {
    return new Promise((resolve, reject) => {
      server = http.createServer(handler);
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const info = { url: `http://127.0.0.1:${server.address().port}`, token, pid: process.pid, startedAt: Date.now() };
        if (file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(info, null, 2)); }
        resolve(info);
      });
    });
  }
  function stop() { clearInterval(timer); server?.close(); }
  function updateCards(list) { cards = Array.isArray(list) ? list.filter(c => c && c.id && c.title) : []; pump(); }

  return { start, stop, updateCards, send, roster, envelope, onReceipt, receiveExternal, inbox, _messages: messages };
}

module.exports = { createBus, envelope, MAX_HOPS };
