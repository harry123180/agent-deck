'use strict';
// Client for Claude Code's own cross-session messaging ("uds-messaging"), reverse-engineered from the CLI:
//
//   registry   ~/.claude/sessions/<pid>.json      pid, sessionId, cwd, name, status, procStart, messagingSocketPath, peerProtocol
//   inbox key  ~/.claude/sessions/<pid>.<hash>.key  { peerToken, procStartFt, pidDomain }  (published by the session)
//   inbox      a named pipe (Windows: \\.\pipe\LOCAL\cc-msg-<32 hex>) / unix socket elsewhere
//   protocol   newline-delimited JSON; the first line must arrive quickly and be {"type":"auth","token":<peerToken>}
//              then {"type":"user","message":{"role":"user","content":"..."}} lines are queued as user prompts.
//
// Claude Code decides what happens to an inbound message, and this client respects that: a session that bypasses
// permission prompts HOLDS messages from senders that did not attest a permission mode, and shows its user a review
// dialog (default: Deny). This client never forges an identity or a mode to get around that.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

const sessionsDir = (home = os.homedir()) => path.join(home, '.claude', 'sessions');

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Live Claude Code sessions that accept peer messages.
function listSessions({ home } = {}) {
  const dir = sessionsDir(home);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of names) {
    if (!/^\d+\.json$/.test(f)) continue;
    let s; try { s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!s || !s.pid || !s.messagingSocketPath || !s.peerProtocol) continue;
    if (!alive(Number(s.pid))) continue;
    const key = names.find(k => k.startsWith(`${s.pid}.`) && k.endsWith('.key'));
    out.push({
      pid: Number(s.pid), sessionId: s.sessionId || '', name: s.name || '', cwd: s.cwd || '', status: s.status || '',
      socket: s.messagingSocketPath, keyFile: key ? path.join(dir, key) : '', updatedAt: s.updatedAt || 0,
    });
  }
  return out;
}

function readToken(session) {
  if (!session.keyFile) return '';
  try { return JSON.parse(fs.readFileSync(session.keyFile, 'utf8')).peerToken || ''; } catch { return ''; }
}

// Send one prompt into a session's inbox. Resolves { ok, msgId } or { ok:false, error }.
function sendToSession(session, text, { timeoutMs = 4000 } = {}) {
  return new Promise(resolve => {
    const token = readToken(session);
    if (!token) return resolve({ ok: false, error: 'that Claude session has no published inbox key' });
    const msgId = crypto.randomUUID();
    let done = false;
    const finish = r => { if (!done) { done = true; resolve(r); } };
    const c = net.connect(session.socket, () => {
      const lines = JSON.stringify({ type: 'auth', token }) + '\n' +
        JSON.stringify({ type: 'user', msg_id: msgId, message: { role: 'user', content: String(text) } }) + '\n';
      c.end(lines, () => finish({ ok: true, msgId }));
    });
    c.on('error', err => finish({ ok: false, error: err.code === 'ENOENT' ? 'that Claude session is not listening anymore' : String(err.message || err) }));
    c.setTimeout(timeoutMs, () => { c.destroy(); finish({ ok: false, error: 'timed out connecting to the Claude session' }); });
  });
}

module.exports = { listSessions, sendToSession, readToken, sessionsDir };
