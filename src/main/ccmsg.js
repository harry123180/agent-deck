'use strict';
// Claude Code's own cross-session messaging ("uds-messaging"), reverse-engineered from the CLI and verified against a
// real Claude Code client in both directions. Agent Deck speaks it as an honest peer: its real pid and process start
// time, the name "agent-deck", and it never attests a permission mode it does not have.
//
//   registry   ~/.claude/sessions/<pid>.json
//                pid, sessionId, cwd, name, status, procStart (process start as Windows FILETIME), peerProtocol: 1,
//                peerFeatures (e.g. "notify_idle"), messagingSocketPath (the inbox)
//   inbox key  ~/.claude/sessions/<pid>.<sha256(lower-cased inbox path)>.key   { peerToken, procStartFt, pidDomain }
//   inbox      named pipe \\.\pipe\LOCAL\cc-msg-<32 hex> on Windows (unix socket elsewhere)
//   framing    one JSON object per line; the first line must be {"type":"auth","token":<peerToken of the target>}
//   frames     user    {msgV:1, msg_id, type:"user", priority:"next", from:"uds:<sender inbox>",
//                       message:{role:"user", content:'<cross-session-message from="uds:…" from-name="…">\n…\n</cross-session-message>'}}
//              control {type:"control", action:"notify_when_idle" | "peer_idle_notice" | "peer_message_status", …, from, msgV:1, msg_id}
//              receipts: peer_message_status {status: held|delivered|denied|expired|refused|dropped, reason, orig_msg_id}
//
// The receiving session decides what to do with a message. A session that bypasses permission prompts HOLDS messages
// from a sender that did not attest the same permission class, and asks its user (review dialog, default "Deny").
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

const sessionsDir = (home = os.homedir()) => path.join(home, '.claude', 'sessions');
const keyName = (pid, inbox) => `${pid}.${crypto.createHash('sha256').update(String(inbox).toLowerCase()).digest('hex')}.key`;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Live Claude Code sessions that accept peer messages (optionally excluding our own registration).
function listSessions({ home, excludePid } = {}) {
  const dir = sessionsDir(home);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of names) {
    if (!/^\d+\.json$/.test(f)) continue;
    let s; try { s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!s || !s.pid || !s.messagingSocketPath || !s.peerProtocol) continue;
    if (Number(s.pid) === excludePid || !alive(Number(s.pid))) continue;
    let keyFile = path.join(dir, keyName(s.pid, s.messagingSocketPath));
    if (!fs.existsSync(keyFile)) { const k = names.find(n => n.startsWith(`${s.pid}.`) && n.endsWith('.key')); keyFile = k ? path.join(dir, k) : ''; }
    out.push({
      pid: Number(s.pid), sessionId: s.sessionId || '', name: s.name || '', cwd: s.cwd || '', status: s.status || '',
      socket: s.messagingSocketPath, keyFile, features: Array.isArray(s.peerFeatures) ? s.peerFeatures : [], updatedAt: s.updatedAt || 0,
    });
  }
  return out;
}

function readToken(session) {
  if (!session.keyFile) return '';
  try { return JSON.parse(fs.readFileSync(session.keyFile, 'utf8')).peerToken || ''; } catch { return ''; }
}

const xmlAttr = s => String(s).replace(/["<>\r\n]/g, ' ');
// The envelope a Claude client puts around a message; `from` is the reply address, from-name a display name.
function wrap(text, { from, fromName }) {
  if (!from) return String(text);
  return `<cross-session-message from="${xmlAttr(from)}"${fromName ? ` from-name="${xmlAttr(fromName)}"` : ''}>\n${text}\n</cross-session-message>`;
}

// Write frames to a session's inbox (auth line first). Resolves { ok } or { ok:false, error }.
function writeFrames(session, frames, { timeoutMs = 4000 } = {}) {
  return new Promise(resolve => {
    const token = readToken(session);
    if (!token) return resolve({ ok: false, error: 'that Claude session has no published inbox key' });
    let done = false;
    const finish = r => { if (!done) { done = true; resolve(r); } };
    const c = net.connect(session.socket, () => {
      c.end([{ type: 'auth', token }, ...frames].map(f => JSON.stringify(f)).join('\n') + '\n', () => finish({ ok: true }));
    });
    c.on('error', err => finish({ ok: false, error: err.code === 'ENOENT' ? 'that Claude session is not listening anymore' : String(err.message || err) }));
    c.setTimeout(timeoutMs, () => { c.destroy(); finish({ ok: false, error: 'timed out connecting to the Claude session' }); });
  });
}

// Send one prompt into a session's inbox. With `from` (our own inbox address) the session can reply and send receipts.
async function sendToSession(session, text, { from, fromName } = {}) {
  const msgId = crypto.randomUUID();
  const frame = { msgV: 1, msg_id: msgId, type: 'user', priority: 'next', message: { role: 'user', content: wrap(text, { from, fromName }) } };
  if (from) frame.from = from;
  const r = await writeFrames(session, [frame]);
  return r.ok ? { ok: true, msgId } : r;
}

// Ask a session for ONE idle notice (answered with a peer_idle_notice carrying orig_msg_id = this msg_id).
async function subscribeIdle(session, { from }) {
  const msgId = crypto.randomUUID();
  const r = await writeFrames(session, [{ type: 'control', action: 'notify_when_idle', from, msgV: 1, msg_id: msgId }]);
  return r.ok ? { ok: true, msgId } : r;
}

// Parse the envelope of an incoming user frame: who sent it and the plain text.
function unwrap(content) {
  const m = /^<cross-session-message\b([^>]*)>\r?\n([\s\S]*?)\r?\n<\/cross-session-message>\s*$/.exec(String(content || ''));
  if (!m) return { text: String(content || ''), attrs: {} };
  const attrs = {};
  for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
  return { text: m[2], attrs };
}

module.exports = { listSessions, sendToSession, subscribeIdle, writeFrames, readToken, sessionsDir, keyName, wrap, unwrap };
