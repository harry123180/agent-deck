'use strict';
// Token usage via ccusage, one run per Claude account (CLAUDE_CONFIG_DIR).
// ccusage re-reads the whole history of an account on every call (minutes for a large one), so: only run on
// demand, run accounts/queries in parallel, and keep the last result on disk.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SHELL = () => process.env.ComSpec || 'cmd.exe';
const envFor = configDir => (configDir ? { ...process.env, CLAUDE_CONFIG_DIR: configDir } : process.env);

// `ccusage` is an npm .cmd shim on Windows -> go through cmd.exe. Falls back to npx when it is not installed globally.
function run(args, { timeout = 600000, configDir = '' } = {}) {
  const attempt = cmdline => new Promise(resolve => {
    execFile(SHELL(), ['/d', '/s', '/c', cmdline], { timeout, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8', windowsHide: true, env: envFor(configDir) },
      (err, stdout, stderr) => {
        const text = String(stdout || '');
        const start = text.search(/[\[{]/);
        if (!err && start >= 0) { try { return resolve({ ok: true, data: JSON.parse(text.slice(start)) }); } catch { /* fall through */ } }
        resolve({ ok: false, error: String((err && err.message) || stderr || 'no output').slice(0, 400), notFound: /not recognized|not found/i.test(String(stderr || '') + String(err?.message || '')) });
      });
  });
  return attempt(`ccusage ${args}`).then(r => (r.ok || !r.notFound ? r : attempt(`npx --yes ccusage@latest ${args}`)));
}

// Prices come from the network. --offline would silently report $0 for models missing from the local price cache,
// so it is only a fallback when the online run fails.
async function runPriced(args, opts) {
  const online = await run(args, opts);
  if (online.ok) return { ...online, offline: false };
  const off = await run(args + ' --offline', opts);
  return off.ok ? { ...off, offline: true } : online;
}

function authStatus(configDir) {
  return new Promise(resolve => {
    execFile(SHELL(), ['/d', '/s', '/c', 'claude auth status'], { timeout: 20000, encoding: 'utf8', windowsHide: true, env: envFor(configDir) }, (err, stdout) => {
      try { const j = JSON.parse(stdout.slice(stdout.indexOf('{'))); resolve({ loggedIn: !!j.loggedIn, email: j.email || '', plan: j.subscriptionType || '', configDirectory: j.configDirectory || '' }); }
      catch { resolve(null); }
    });
  });
}

const ymd = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

// Older caches stored a single account at the top level.
function normalizeCache(c) {
  if (!c || typeof c !== 'object') return null;
  if (c.accounts && typeof c.accounts === 'object') return c;
  if (c.daily || c.blocks) return { fetchedAt: c.fetchedAt || 0, accounts: { default: c } };
  return null;
}

async function fetchAccount(acct, since) {
  const o = { configDir: acct.configDir || '' };
  const [daily, blocks, auth] = await Promise.all([
    runPriced(`daily --instances --json --since ${since}`, o),
    runPriced('blocks --active --token-limit max --json', o),
    authStatus(o.configDir),
  ]);
  return {
    fetchedAt: Date.now(), auth,
    daily: daily.ok ? daily.data : null, dailyError: daily.ok ? '' : daily.error,
    blocks: blocks.ok ? blocks.data : null, blocksError: blocks.ok ? '' : blocks.error,
    offline: !!(daily.offline || blocks.offline),
  };
}

let inflight = null;
function createUsage(cacheFile) {
  const load = () => { try { return normalizeCache(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))); } catch { return null; } };
  const save = data => { try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile + '.tmp', JSON.stringify(data)); fs.renameSync(cacheFile + '.tmp', cacheFile); } catch { /* cache is optional */ } };

  async function refresh(accounts) {
    if (inflight) return inflight;                       // never start two multi-minute scans at once
    const list = Array.isArray(accounts) && accounts.length ? accounts : [{ id: 'default', configDir: '' }];
    inflight = (async () => {
      const since = ymd(new Date(Date.now() - 35 * 864e5));
      const results = await Promise.all(list.map(a => fetchAccount(a, since).then(r => [a.id, r])));
      const prev = load();
      const out = { fetchedAt: Date.now(), accounts: { ...(prev?.accounts || {}) } };
      for (const [id, r] of results) {
        // a total failure must not overwrite a good earlier result for that account
        if (r.daily || r.blocks || !out.accounts[id]) out.accounts[id] = r; else out.accounts[id] = { ...out.accounts[id], dailyError: r.dailyError, blocksError: r.blocksError };
      }
      if (results.some(([, r]) => r.daily || r.blocks)) save(out);
      return out;
    })().finally(() => { inflight = null; });
    return inflight;
  }
  return { load, refresh, running: () => !!inflight };
}

module.exports = { createUsage, run, normalizeCache };
