'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const CLAUDE_DIR = () => path.join(os.homedir(), '.claude', 'projects');
const NOISE = /[\\/]\.(codex[\\/]plugins|claude[\\/](chrome|plugins))([\\/]|$)/i;
const norm = p => String(p || '').replace(/[\\/]+$/, '').toLowerCase();

// Newest Claude Code session per working directory, read from ~/.claude/projects/*/<sessionId>.jsonl
function claudeSessions({ days = 45, limit = 80 } = {}) {
  const root = CLAUDE_DIR();
  const cutoff = Date.now() - days * 864e5;
  const best = new Map(); // normalized cwd -> session
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return []; }
  for (const d of dirs) {
    let files;
    try { files = fs.readdirSync(path.join(root, d)).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const full = path.join(root, d, f);
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      const cwd = readCwd(full);
      if (!cwd) continue;
      const key = norm(cwd);
      const cur = best.get(key);
      if (!cur || st.mtimeMs > cur.lastActive) best.set(key, { cwd, sessionId: f.slice(0, -6), lastActive: st.mtimeMs });
    }
  }
  return [...best.values()].sort((a, b) => b.lastActive - a.lastActive).slice(0, limit);
}

function readCwd(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.toString('utf8', 0, n));
    return m ? JSON.parse(`"${m[1]}"`) : null;
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

function runningShells(excludePids) {
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'scan.ps1'), '-Exclude', excludePids.join(',')],
      { timeout: 30000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
        if (err) return resolve([]);
        try { resolve(JSON.parse(stdout.replace(/^﻿/, '').trim() || '[]')); } catch { resolve([]); }
      });
  });
}

// Merge running windows + Claude history into one candidate list.
async function scan(excludePids = []) {
  const [shells, history] = await Promise.all([runningShells(excludePids), Promise.resolve(claudeSessions())]);
  const histByCwd = new Map(history.map(h => [norm(h.cwd), h]));
  const out = [];
  const seen = new Set();
  for (const s of shells) {
    if (NOISE.test(s.cwd)) continue;
    const key = norm(s.cwd) + '|' + s.agent;
    if (seen.has(key)) continue;
    seen.add(key);
    const h = s.agent === 'claude' ? histByCwd.get(norm(s.cwd)) : null;
    out.push({ source: 'running', cwd: s.cwd, agent: s.agent, sessionId: h?.sessionId || '', lastActive: h?.lastActive || Date.now(), pid: s.pid });
  }
  for (const h of history) {
    if (seen.has(norm(h.cwd) + '|claude')) continue;
    out.push({ source: 'history', cwd: h.cwd, agent: 'claude', sessionId: h.sessionId, lastActive: h.lastActive });
  }
  const rank = c => (c.source === 'running' ? (c.agent === 'shell' ? 1 : 0) : 2);
  out.sort((a, b) => rank(a) - rank(b) || b.lastActive - a.lastActive);
  return out.filter(c => { try { return fs.existsSync(c.cwd); } catch { return false; } });
}

module.exports = { scan, claudeSessions };
