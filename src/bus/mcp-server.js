#!/usr/bin/env node
'use strict';
// Agent Deck MCP server (stdio). Any MCP-capable agent CLI — Claude Code, Codex, OpenCode, agy — can load it and
// then see and message the agents running in Agent Deck's cards.
//
// It is a thin client of the Agent Deck bus (src/main/bus.js): the bus address + token are read from
// AGENT_DECK_BUS (path of bus.json) or the default location. The caller's own card name comes from
// AGENT_DECK_CARD, which Agent Deck puts into every card's terminal environment.
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROTOCOL = '2025-06-18';
const busFile = () => process.env.AGENT_DECK_BUS ||
  path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'agent-deck', 'bus.json');
const me = () => process.env.AGENT_DECK_CARD || 'central';

async function bus(method, route, body) {
  let info;
  try { info = JSON.parse(fs.readFileSync(busFile(), 'utf8')); } catch { throw new Error('Agent Deck is not running (bus.json not found)'); }
  const res = await fetch(info.url + route, {
    method, headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => { throw new Error('cannot reach Agent Deck (is the app open?)'); });
  const data = await res.json();
  if (data && data.error) throw new Error(data.error);
  return data;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TOOLS = [
  {
    name: 'list_agents',
    description: 'List every agent card in Agent Deck with its platform (Claude Code, Codex, OpenCode, ...), project and live state ' +
      '(working / idle = waiting for input / asking = needs a decision / error / asleep = not started).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_agent',
    description: "Read the last lines currently shown in an agent card's terminal (its latest output), plus its state.",
    inputSchema: { type: 'object', properties: { agent: { type: 'string', description: 'card name (from list_agents)' }, lines: { type: 'integer', minimum: 1, maximum: 200, default: 40 } }, required: ['agent'] },
  },
  {
    name: 'send_to_agent',
    description: "Send a message to another agent card. It is typed into that agent's prompt with a header saying who sent it. " +
      'when="idle" (default) waits until the target is waiting for input so it is never interrupted mid-task; when="now" sends immediately. ' +
      'Pass reply_to with the id shown in a message you received when you answer it.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'target card name' },
        message: { type: 'string' },
        when: { type: 'string', enum: ['idle', 'now'], default: 'idle' },
        reply_to: { type: 'string', description: 'id of the message you are answering (optional)' },
      },
      required: ['agent', 'message'],
    },
  },
  {
    name: 'message_status',
    description: 'Check whether a message sent with send_to_agent is still queued, delivered, expired or failed.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'wait_for_agent',
    description: 'Wait until an agent card finishes working (becomes idle or asks for a decision), then return its latest screen. ' +
      'Use after send_to_agent to collect the answer.',
    inputSchema: { type: 'object', properties: { agent: { type: 'string' }, timeout_s: { type: 'integer', minimum: 5, maximum: 1800, default: 300 }, lines: { type: 'integer', default: 60 } }, required: ['agent'] },
  },
];

async function callTool(name, a = {}) {
  if (name === 'list_agents') {
    const { agents } = await bus('GET', '/agents');
    if (!agents.length) return 'Agent Deck has no cards.';
    return `You are "${me()}".\n` + agents.map(x => `- ${x.name} | ${x.platform} | ${x.stateLabel || x.state} | project: ${x.project || '-'} | ${x.folder}` +
      ` | via ${x.lane === 'native' ? 'Claude Code cross-session inbox' : 'its terminal'}${x.external ? ' | outside Agent Deck' : ''}`).join('\n') +
      '\nNote: a Claude session that bypasses permission prompts holds incoming messages until its user approves them.';
  }
  if (name === 'read_agent') {
    const r = await bus('GET', `/read?agent=${encodeURIComponent(a.agent)}&lines=${a.lines || 40}`);
    return `${r.name} (${r.stateLabel || r.state})\n---\n${r.screen || '(no output yet)'}`;
  }
  if (name === 'send_to_agent') {
    const r = await bus('POST', '/send', { to: a.agent, text: a.message, from: me(), when: a.when, replyTo: a.reply_to });
    return `message ${r.id} to ${r.to}: ${r.status}${r.status === 'queued' ? ' (will be delivered when it is waiting for input)' : ''}`;
  }
  if (name === 'message_status') {
    const r = await bus('GET', `/message?id=${encodeURIComponent(a.id)}`);
    return `message ${r.id} to ${r.to}: ${r.status}${r.error ? ' — ' + r.error : ''}`;
  }
  if (name === 'wait_for_agent') {
    const until = Date.now() + (a.timeout_s || 300) * 1000;
    // give a just-delivered message time to start the agent working before checking for "done"
    await sleep(4000);
    let r;
    do {
      r = await bus('GET', `/read?agent=${encodeURIComponent(a.agent)}&lines=${a.lines || 60}`);
      if (r.state === 'idle' || r.state === 'asking' || r.state === 'error') break;
      await sleep(2000);
    } while (Date.now() < until);
    return `${r.name} is ${r.stateLabel || r.state}${Date.now() >= until ? ' (timed out waiting)' : ''}\n---\n${r.screen || ''}`;
  }
  throw new Error(`unknown tool ${name}`);
}

// ---- minimal MCP over stdio: newline-delimited JSON-RPC 2.0 ----
const send = obj => process.stdout.write(JSON.stringify(obj) + '\n');
async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return;                       // notifications need no answer
  try {
    if (method === 'initialize') {
      return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'agentdeck', version: '0.1.0' } } });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      try {
        const text = await callTool(params?.name, params?.arguments || {});
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
      } catch (err) {
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true } });
      }
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (err) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(err.message || err) } });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));

module.exports = { TOOLS, callTool };
