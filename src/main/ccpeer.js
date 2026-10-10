'use strict';
// Agent Deck's own inbox on Claude Code's cross-session network (see ccmsg.js for the protocol).
// Registering lets every Claude Code session on this machine find "agent-deck" with its built-in ListAgents and
// SendMessage, reply to messages Agent Deck sent, and send back delivery receipts and idle notices.
//
// The registration is honest: this process's own pid and real start time, version/entrypoint "agent-deck", and no
// permission mode is attested. Removed again when Agent Deck quits.
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { sessionsDir, keyName, unwrap } = require('./ccmsg');

// process start time as Windows FILETIME (what Claude Code stores as procStart and checks against the live process)
function processStartFiletime(pid) {
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`], { timeout: 15000, windowsHide: true, encoding: 'utf8' },
      (err, out) => resolve(err ? '' : String(out).trim()));
  });
}

function createPeer({ name = 'agent-deck', cwd = process.cwd(), version = 'agent-deck', home, onUser, onStatus, onIdle, log = () => {} } = {}) {
  const dir = sessionsDir(home);
  const pipe = `\\\\.\\pipe\\LOCAL\\cc-msg-${crypto.randomBytes(16).toString('hex')}`;
  const token = crypto.randomBytes(16).toString('hex');
  const regFile = path.join(dir, `${process.pid}.json`);
  const keyFile = path.join(dir, keyName(process.pid, pipe));
  let server = null, heartbeat = null, reg = null;

  function handleFrame(f) {
    if (!f || typeof f !== 'object') return;
    if (f.type === 'user' && f.message) {
      const { text, attrs } = unwrap(f.message.content);
      onUser?.({ msgId: f.msg_id, from: f.from || attrs.from || '', fromName: attrs['from-name'] || '', fromMode: attrs['from-mode'] || '', text });
    } else if (f.type === 'control' && f.action === 'peer_message_status') {
      onStatus?.({
        origMsgId: f.orig_msg_id, status: f.status, reason: f.reason || f.status_detail || '', from: f.from || '',
        detail: f.status_detail || '', dropReason: f.drop_reason || '', droppedIds: Array.isArray(f.dropped_msg_ids) ? f.dropped_msg_ids : [], frame: f,
      });
    } else if (f.type === 'control' && f.action === 'peer_idle_notice') {
      onIdle?.({ origMsgId: f.orig_msg_id, from: f.from || '' });
    } else {
      log(`ccpeer: ignored frame ${f.type}/${f.action || ''}`);
    }
  }

  // An Agent Deck that was killed could not remove its registration. Clear those (ours only: entrypoint "agent-deck"
  // and a pid that is no longer running); Claude sessions' own entries are never touched.
  function clearStale() {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return 0; }
    let n = 0;
    for (const f of names) {
      if (!/^\d+\.json$/.test(f)) continue;
      let r; try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      if (!r || r.entrypoint !== 'agent-deck' || Number(r.pid) === process.pid) continue;
      let running = true; try { process.kill(Number(r.pid), 0); } catch (e) { running = e.code === 'EPERM'; }
      if (running) continue;
      for (const g of names) if (g === f || (g.startsWith(`${r.pid}.`) && g.endsWith('.key'))) { try { fs.unlinkSync(path.join(dir, g)); n++; } catch { /* ignore */ } }
    }
    return n;
  }

  async function start() {
    clearStale();
    const procStart = await processStartFiletime(process.pid);
    await new Promise((resolve, reject) => {
      server = net.createServer(c => {
        let buf = '', authed = false;
        c.setEncoding('utf8');
        const deadline = setTimeout(() => { if (!authed) c.destroy(); }, 3000);   // the first line must arrive quickly
        c.on('data', d => {
          buf += d; if (buf.length > 4e6) return c.destroy();
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            let f; try { f = JSON.parse(line); } catch { continue; }
            if (!authed) {
              authed = f && f.type === 'auth' && typeof f.token === 'string' && f.token.length === token.length &&
                crypto.timingSafeEqual(Buffer.from(f.token), Buffer.from(token));
              clearTimeout(deadline);
              if (!authed) { c.destroy(); return; }
              continue;
            }
            try { handleFrame(f); } catch (err) { log('ccpeer: frame error ' + err.message); }
          }
        });
        c.on('error', () => {});
      });
      server.on('error', reject);
      server.listen(pipe, resolve);
    });
    const now = Date.now();
    reg = {
      pid: process.pid, sessionId: crypto.randomUUID(), cwd, startedAt: now, procStart, version, peerProtocol: 1, peerFeatures: [],
      kind: 'interactive', entrypoint: 'agent-deck', pidDomain: 'win32:msi', messagingSocketPath: pipe,
      name, nameSource: 'user', nameSince: now, updatedAt: now, status: 'idle', statusUpdatedAt: now,
    };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(regFile, JSON.stringify(reg));
    fs.writeFileSync(keyFile, JSON.stringify({ peerToken: token, procStartFt: procStart, pidDomain: 'win32:msi' }));
    heartbeat = setInterval(() => { try { reg.updatedAt = Date.now(); fs.writeFileSync(regFile, JSON.stringify(reg)); } catch { /* ignore */ } }, 60000);
    heartbeat.unref?.();
    return { address: 'uds:' + pipe, pipe, name };
  }

  function stop() {
    clearInterval(heartbeat);
    try { server?.close(); } catch { /* ignore */ }
    for (const f of [regFile, keyFile]) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
  }

  return { start, stop, address: () => 'uds:' + pipe, pipe };
}

module.exports = { createPeer, processStartFiletime };
