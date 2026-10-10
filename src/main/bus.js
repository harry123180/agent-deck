'use strict';
// Agent Deck message bus — lets one agent (the central one) talk to the agents in every card, whatever the
// platform (Claude Code, Codex, OpenCode, agy, ...).
//
// Modelled on Claude Code's own cross-session messaging, but platform-neutral:
//   Claude Code                                  Agent Deck
//   ~/.claude/sessions/<pid>.json registry   ->  live card roster (name, platform, state, screen tail)
//   per-session pipe + .key                   ->  one local HTTP endpoint on 127.0.0.1 guarded by a random token
//   envelope from= / hop-chain=               ->  same fields; a message that already passed a card is refused
//   notify_when_idle / peer_message_status    ->  "when: idle" delivery + message status lookups
// Delivery into a card = typing into its terminal with bracketed paste, which every CLI agent accepts.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_HOPS = 4;
// Only a plain "waiting for input" prompt receives messages. An agent that is asking a question (permission prompt,
// y/n, picker) must not get text pasted into it: that could answer the question by accident.
const READY = new Set(['idle']);

function envelope(msg) {
  const hops = [...msg.hops, msg.from].join(' > ');
  return `[Agent Deck 訊息 from="${msg.from}" id=${msg.id} hop-chain="${hops}"]\n${msg.text}\n` +
    `[若要回覆，請用 agentdeck 的 send_to_agent 工具送給 "${msg.from}"]`;
}

function createBus({ writeToCard, file }) {
  const token = crypto.randomBytes(24).toString('hex');
  let cards = [];                 // latest roster from the renderer
  const messages = new Map();     // id -> message
  let server = null;

  const findCard = key => {
    const k = String(key || '').trim().toLowerCase();
    return cards.find(c => c.id === key) || cards.find(c => c.title.toLowerCase() === k) ||
      cards.find(c => c.title.toLowerCase().includes(k) && k.length >= 2);
  };

  function deliver(msg) {
    const card = cards.find(c => c.id === msg.toId);
    if (!card) { msg.status = 'failed'; msg.error = 'card no longer exists'; return; }
    if (msg.when === 'idle' && !READY.has(card.state)) return;   // keep waiting
    const ok = writeToCard(card.id, `\x1b[200~${envelope(msg)}\x1b[201~`, '\r');
    if (ok) { msg.status = 'delivered'; msg.deliveredAt = Date.now(); } else { msg.status = 'failed'; msg.error = 'card terminal is not running'; }
  }
  const pump = () => { for (const m of messages.values()) if (m.status === 'queued') deliver(m); };
  const timer = setInterval(() => {
    pump();
    const now = Date.now();   // forget old finished messages
    for (const [id, m] of messages) if (m.status !== 'queued' && now - m.createdAt > 3600e3) messages.delete(id);
    for (const m of messages.values()) if (m.status === 'queued' && now - m.createdAt > m.timeoutMs) { m.status = 'expired'; m.error = 'target never became idle'; }
  }, 1000);
  timer.unref?.();

  function send({ to, text, from = 'central', when = 'idle', hops = [], replyTo, timeoutS = 1800 }) {
    if (!text || !String(text).trim()) return { error: 'message is empty' };
    const card = findCard(to);
    if (!card) return { error: `no card named "${to}". Use list_agents to see the names.` };
    hops = Array.isArray(hops) ? hops.map(String).slice(0, 10) : [];
    // a reply carries the chain of the message it answers, so ping-pong between agents is bounded
    const orig = replyTo && messages.get(String(replyTo));
    if (orig) hops = [...orig.hops, orig.from];
    // Replying to whoever asked is normal; what must stop is an endless back-and-forth. Each reply extends the
    // chain by one, so a thread can go back and forth at most MAX_HOPS times.
    if (hops.length >= MAX_HOPS) return { error: `hop limit reached: this thread already went back and forth ${MAX_HOPS} times` };
    if (card.title === from) return { error: 'refused: an agent cannot send a message to itself' };
    const msg = {
      id: crypto.randomUUID().slice(0, 8), from: String(from), toId: card.id, to: card.title, text: String(text).slice(0, 20000),
      when: when === 'now' ? 'now' : 'idle', hops, status: 'queued', createdAt: Date.now(), timeoutMs: Math.max(10, timeoutS) * 1000,
    };
    messages.set(msg.id, msg);
    deliver(msg);
    return publicMsg(msg);
  }
  const publicMsg = m => ({ id: m.id, to: m.to, from: m.from, status: m.status, when: m.when, error: m.error || undefined, deliveredAt: m.deliveredAt });

  // ---- HTTP API (127.0.0.1 only, bearer token) ----
  function handler(req, res) {
    const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'unauthorized' });
    const url = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let data = {};
      try { data = body ? JSON.parse(body) : {}; } catch { return reply(400, { error: 'bad json' }); }
      if (req.method === 'GET' && url.pathname === '/agents') {
        return reply(200, { agents: cards.map(c => ({ name: c.title, project: c.project, platform: c.agent, state: c.state, stateLabel: c.stateLabel, folder: c.cwd })) });
      }
      if (req.method === 'GET' && url.pathname === '/read') {
        const card = findCard(url.searchParams.get('agent'));
        if (!card) return reply(404, { error: 'no such agent' });
        const n = Math.min(200, Math.max(1, Number(url.searchParams.get('lines')) || 40));
        return reply(200, { name: card.title, state: card.state, stateLabel: card.stateLabel, screen: (card.tail || '').split('\n').slice(-n).join('\n') });
      }
      if (req.method === 'POST' && url.pathname === '/send') return reply(200, send(data));
      if (req.method === 'GET' && url.pathname === '/message') {
        const m = messages.get(url.searchParams.get('id'));
        return m ? reply(200, publicMsg(m)) : reply(404, { error: 'unknown message id' });
      }
      reply(404, { error: 'not found' });
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

  return { start, stop, updateCards, send, envelope, _messages: messages };
}

module.exports = { createBus, envelope, MAX_HOPS };
