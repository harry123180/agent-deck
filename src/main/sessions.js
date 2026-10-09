'use strict';
// Find the real conversation (session) ids that already exist for a working folder,
// so a new card can resume "the last conversation of this path" instead of guessing.
//   claude   ~/.claude/projects/<encoded cwd>/<uuid>.jsonl
//   codex    ~/.codex/sessions/YYYY/MM/DD/rollout-*-<uuid>.jsonl   (first line = session_meta with cwd + id)
//   opencode `opencode session list --format json`                   (id + directory)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const norm = p => String(p || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();

function head(file, bytes = 256 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, bytes, 0));
  } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}
const cwdIn = text => { const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(text); try { return m ? JSON.parse(`"${m[1]}"`) : null; } catch { return null; } };

// ---- Claude Code ----
const claudeEncode = cwd => String(cwd).replace(/[^A-Za-z0-9]/g, '-');

// Time of the last user/assistant message inside a transcript. File mtime is not usable: resuming a
// conversation rewrites its file, which would make an old conversation look newest.
function lastMessageAt(file, bytes = 256 * 1024) {
  let fd;
  try {
    const st = fs.statSync(file);
    fd = fs.openSync(file, 'r');
    const len = Math.min(bytes, st.size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const l of lines) {
      if (!/"type":"(user|assistant)"/.test(l)) continue;
      const m = /"timestamp":"([^"]+)"/.exec(l);
      if (m) { const t = Date.parse(m[1]); if (t) return t; }
    }
  } catch { /* unreadable */ } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
  return 0;
}

function claudeDirFiles(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.jsonl') || !UUID.test(n.slice(0, -6))) continue;   // skips agent-*.jsonl sub-agent logs
    const full = path.join(dir, n);
    let st; try { st = fs.statSync(full); } catch { continue; }
    out.push({ id: n.slice(0, -6), file: full, lastActive: lastMessageAt(full) || st.mtimeMs });
  }
  return out.sort((a, b) => b.lastActive - a.lastActive);
}

function claudeSessions(cwd, { home = os.homedir() } = {}) {
  const root = path.join(home, '.claude', 'projects');
  let files = claudeDirFiles(path.join(root, claudeEncode(cwd)));
  if (!files.length) {   // folder names that do not encode predictably: look inside the newest file of every project
    let dirs = []; try { dirs = fs.readdirSync(root); } catch { /* none */ }
    for (const d of dirs) {
      const f = claudeDirFiles(path.join(root, d));
      if (f.length && norm(cwdIn(head(f[0].file))) === norm(cwd)) { files = f; break; }
    }
  }
  // a session file that never received a message cannot be resumed ("No conversation found")
  return files.filter(f => /"type":"(user|assistant)"/.test(head(f.file))).map(({ id, lastActive }) => ({ id, lastActive }));
}

// ---- Codex ----
function* codexFiles(root) {
  const sub = d => { try { return fs.readdirSync(d).sort().reverse(); } catch { return []; } };   // newest first (date-named dirs)
  for (const y of sub(root)) for (const m of sub(path.join(root, y))) for (const d of sub(path.join(root, y, m))) {
    for (const f of sub(path.join(root, y, m, d))) if (f.startsWith('rollout-') && f.endsWith('.jsonl')) yield path.join(root, y, m, d, f);
  }
}

function codexSessions(cwd, { home = os.homedir(), maxFiles = 800, limit = 10 } = {}) {
  const out = [];
  let scanned = 0;
  for (const file of codexFiles(path.join(home, '.codex', 'sessions'))) {
    if (++scanned > maxFiles || out.length >= limit) break;
    const text = head(file, 64 * 1024);
    const first = text.split('\n', 1)[0];
    const c = cwdIn(first);
    const id = /"id":"([0-9a-f-]{36})"/i.exec(first)?.[1];
    if (!c || !id || norm(c) !== norm(cwd)) continue;
    let st; try { st = fs.statSync(file); } catch { continue; }
    out.push({ id, lastActive: st.mtimeMs });
  }
  return out;
}

// ---- OpenCode ----
function parseOpencode(json, cwd) {
  let list; try { list = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.filter(s => s && s.id && norm(s.directory) === norm(cwd))
    .map(s => ({ id: s.id, title: s.title || '', lastActive: s.updated || s.created || 0 }))
    .sort((a, b) => b.lastActive - a.lastActive);
}

function opencodeSessions(cwd) {
  return new Promise(resolve => {
    // `opencode` is an npm .cmd shim on Windows, so it has to go through cmd.exe
    execFile(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'opencode session list --format json -n 300'],
      { timeout: 25000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
      (err, stdout) => resolve(err ? [] : parseOpencode(stdout.slice(stdout.indexOf('[')), cwd)));
  });
}

// ---- public ----
const RESUME = {
  claude: id => `claude --resume ${id}`,
  codex: id => `codex resume ${id}`,
  opencode: id => `opencode --session ${id}`,
};

async function list(agent, cwd, opts) {
  if (!cwd) return [];
  if (agent === 'claude') return claudeSessions(cwd, opts);
  if (agent === 'codex') return codexSessions(cwd, opts);
  if (agent === 'opencode') return opencodeSessions(cwd);
  return [];
}

module.exports = { list, RESUME, claudeSessions, codexSessions, parseOpencode, claudeEncode };
