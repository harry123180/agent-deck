'use strict';
// Multiple Claude Code accounts = one CLAUDE_CONFIG_DIR per account (login state, settings and
// conversations all live inside that folder). Switching an account means: same folder structure, other dir.
// This module never reads or copies credentials.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { claudeSessions, claudeEncode } = require('./sessions');

const defaultDir = (env = process.env, home = os.homedir()) => env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
const resolveDir = (dir, opts) => (dir && String(dir).trim() ? String(dir).trim() : defaultDir(opts?.env, opts?.home));
const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

const SESSION_RE = /--(?:resume|session-id)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const sessionIdFromCommand = (...cmds) => { for (const c of cmds) { const m = SESSION_RE.exec(c || ''); if (m) return m[1].toLowerCase(); } return ''; };

// Copy ONE conversation from account A's config dir into account B's, so B can `claude --resume <id>`.
// Only conversation data is copied: projects/<folder>/<id>.jsonl (+ its sibling folder) and file-history/<id>.
function handoff({ cwd, sessionId = '', fromDir, toDir }, opts = {}) {
  const from = resolveDir(fromDir, opts), to = resolveDir(toDir, opts);
  if (sameDir(from, to)) return { ok: false, error: '來源與目標是同一個帳號資料夾' };
  const enc = claudeEncode(cwd);
  let id = sessionId;
  if (!id) id = claudeSessions(cwd, { configDir: from })[0]?.id || '';   // legacy cards (`--continue`): newest conversation of that folder
  if (!id) return { ok: false, error: '在原帳號找不到這個資料夾的對話，無法接續（會改開新對話）' };

  const src = path.join(from, 'projects', enc, id + '.jsonl');
  if (!fs.existsSync(src)) return { ok: false, error: `原帳號沒有這個對話檔：${src}` };
  const dst = path.join(to, 'projects', enc, id + '.jsonl');
  const copied = [];
  const srcTime = fs.statSync(src).mtimeMs;
  // newest wins: if the target already holds a later state of this conversation (e.g. switching back and forth), keep it
  const targetNewer = fs.existsSync(dst) && fs.statSync(dst).mtimeMs > srcTime + 1000;
  if (!targetNewer) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    fs.utimesSync(dst, new Date(), new Date(srcTime));
    copied.push(dst);
    const sub = path.join(from, 'projects', enc, id);                    // sub-agent logs / large tool results
    if (fs.existsSync(sub)) { fs.cpSync(sub, path.join(to, 'projects', enc, id), { recursive: true, force: true }); copied.push('projects/' + id + '/'); }
    const hist = path.join(from, 'file-history', id);                    // snapshots used by /rewind
    if (fs.existsSync(hist)) { fs.cpSync(hist, path.join(to, 'file-history', id), { recursive: true, force: true }); copied.push('file-history/' + id + '/'); }
  }
  return { ok: true, sessionId: id, keptNewerTarget: targetNewer, copied, from, to };
}

// `claude auth status` for one account. Only the non-secret fields are returned.
function status(configDir, opts = {}) {
  const dir = resolveDir(configDir, opts);
  return new Promise(resolve => {
    execFile(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'claude auth status'],
      { timeout: 25000, encoding: 'utf8', windowsHide: true, env: { ...process.env, CLAUDE_CONFIG_DIR: dir } }, (err, stdout) => {
        try {
          const j = JSON.parse(stdout.slice(stdout.indexOf('{')));
          resolve({ ok: true, loggedIn: !!j.loggedIn, email: j.email || '', plan: j.subscriptionType || '', configDirectory: j.configDirectory || dir });
        } catch { resolve({ ok: false, loggedIn: false, email: '', plan: '', configDirectory: dir, error: String(err?.message || 'claude not found').slice(0, 200) }); }
      });
  });
}

module.exports = { defaultDir, resolveDir, handoff, status, sessionIdFromCommand };
