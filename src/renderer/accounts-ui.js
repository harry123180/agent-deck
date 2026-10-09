'use strict';
// Multiple Claude accounts: per-card account, one-click switch that continues the SAME conversation,
// and a banner when the plan limit is hit. Shares the global scope with renderer.js ($, api, state, terms, esc ...).
// An account = a CLAUDE_CONFIG_DIR. Empty configDir = the default account (~/.claude).

const limitAt = {};                      // accountId -> when a card on it last hit the limit (in-memory)
const RECENT_LIMIT_MS = 10 * 60 * 1000;
const AUTO_COOLDOWN_MS = 2 * 60 * 1000;
const SESSION_IN_CMD = /--(?:resume|session-id)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

const acctById = id => state.accounts.find(a => a.id === id) || state.accounts[0];
const multiAccount = () => state.accounts.length > 1;
const acctLetter = a => (a.name.match(/[A-Za-z0-9]$/)?.[0] || a.name.slice(0, 1)).toUpperCase();
const sessionIdOf = tab => (SESSION_IN_CMD.exec(tab.resumeCmd || '') || SESSION_IN_CMD.exec(tab.startCmd || '') || [])[1] || '';
const sepChar = String.fromCharCode(92);

// env handed to the pty: only set for non-default accounts
function accountEnv(tab) {
  const a = acctById(tab.accountId);
  return a && a.configDir ? { CLAUDE_CONFIG_DIR: a.configDir } : {};
}

// ---------- badges + limit banner (called from updateCard on every tick) ----------
function accountsUiUpdate(t, r, card) {
  const a = acctById(t.accountId);
  const show = multiAccount() && t.agent === 'claude';
  for (const el of [card.querySelector('.acct-badge'), r?.pane.querySelector('.acct-badge')]) {
    if (!el) continue;
    if (el.hidden === show) el.hidden = !show;
    if (!show) continue;
    setText(el, acctLetter(a));
    el.style.setProperty('--ac', a.color);
    el.title = `帳號：${a.name}${a.configDir ? '（' + a.configDir + '）' : '（預設 ~/.claude）'}`;
  }
  if (r) updateLimitBanner(t, r);
}

function updateLimitBanner(t, r) {
  const b = r.pane.querySelector('.limit-banner');
  if (!r.limitHit) { r.limitDismissed = false; r.bannerKey = ''; if (!b.hidden) b.hidden = true; return; }
  if (r.limitDismissed || t.agent !== 'claude') { if (!b.hidden) b.hidden = true; return; }
  const cur = acctById(t.accountId);
  const others = state.accounts.filter(a => a.id !== cur.id);
  const now = Date.now();
  const key = JSON.stringify([cur.id, others.map(a => [a.id, a.name, !!(limitAt[a.id] && now - limitAt[a.id] < RECENT_LIMIT_MS)]), r.switching || '', r.bannerError || '']);
  if (key === r.bannerKey && !b.hidden) return;                // do not rebuild (and swallow clicks) every tick
  r.bannerKey = key;
  b.innerHTML = '';
  const msg = document.createElement('span');
  msg.className = 'lb-msg';
  b.appendChild(msg);
  const btn = (label, fn, cls = '') => { const x = document.createElement('button'); x.className = cls; x.textContent = label; x.addEventListener('click', e => { e.stopPropagation(); fn(); }); b.appendChild(x); return x; };

  if (r.switching) {
    msg.textContent = `切換到「${acctById(r.switching).name}」中…`;
  } else if (!others.length) {
    msg.textContent = `⚠ 「${cur.name}」已達用量上限。加入第二個帳號就能一鍵切換並接續同一個對話。`;
    btn('設定帳號', openAccountDialog, 'primary');
  } else {
    msg.textContent = `⚠ 「${cur.name}」已達用量上限`;
    for (const o of others) {
      const recent = limitAt[o.id] && now - limitAt[o.id] < RECENT_LIMIT_MS;
      btn(`切換到「${o.name}」並接續對話${recent ? '（剛達上限）' : ''}`, () => switchAccount(t, o.id), recent ? '' : 'primary');
    }
    if (r.bannerError) {
      const err = document.createElement('div'); err.className = 'lb-err'; err.textContent = r.bannerError; b.appendChild(err);
      for (const o of others) btn(`改用「${o.name}」開新對話`, () => switchAccount(t, o.id, { fresh: true }));
    }
  }
  btn('略過', () => { r.limitDismissed = true; b.hidden = true; });
  b.hidden = false;
}

// ---------- switching ----------
function flash(tab, text) {
  const r = terms.get(tab.id); if (!r) return;
  const toast = r.pane.querySelector('.zoom-toast');
  toast.textContent = text; toast.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => toast.classList.remove('on'), 3500);
}

async function switchAccount(tab, toId, { fresh = false, auto = false } = {}) {
  const r = terms.get(tab.id);
  const to = acctById(toId), from = acctById(tab.accountId);
  if (!r || !to || to.id === from.id || r.switching) return;
  r.switching = to.id; r.bannerError = ''; r.bannerKey = '';
  updateLimitBanner(tab, r);
  try {
    if (fresh) {
      tab.startCmd = 'claude'; tab.resumeCmd = 'claude --continue';   // new conversation under the other account
    } else {
      const res = await api.accountHandoff({ cwd: tab.cwd, sessionId: sessionIdOf(tab), fromDir: from.configDir, toDir: to.configDir });
      if (!res.ok) { r.bannerError = res.error; return; }
      tab.startCmd = tab.resumeCmd = `claude --resume ${res.sessionId}`;
    }
    tab.accountId = to.id; tab.launched = true; tab.autoRun = true;
    r.limitHit = false; r.limitDismissed = false; r.bannerKey = '';
    saveSoon();
    restartTab(tab);                                                   // kill + respawn with the other account's CLAUDE_CONFIG_DIR
    flash(tab, `${auto ? '已自動' : '已'}切換到「${to.name}」${fresh ? '（新對話）' : '，接續同一個對話'}`);
  } catch (e) {
    r.bannerError = String(e.message || e);
  } finally {
    r.switching = '';
    r.bannerKey = '';
    renderTabs();
  }
}

function autoSwitchCheck(t, r, now) {
  if (!state.settings.autoSwitch || !r.limitHit || r.switching || t.agent !== 'claude' || !multiAccount()) return;
  if (now - (r.lastAutoSwitch || 0) < AUTO_COOLDOWN_MS) return;
  const target = state.accounts.find(a => a.id !== t.accountId && !(limitAt[a.id] && now - limitAt[a.id] < RECENT_LIMIT_MS));
  if (!target) return;                                                 // every other account was limited a moment ago: don't ping-pong
  r.lastAutoSwitch = now;
  switchAccount(t, target.id, { auto: true });
}

function accountMenuItems(tab) {
  if (tab.agent !== 'claude' || !multiAccount()) return [];
  const cur = acctById(tab.accountId);
  const items = state.accounts.filter(a => a.id !== cur.id).map(a => [`切換到「${a.name}」並接續對話`, () => switchAccount(tab, a.id)]);
  items.push(['帳號設定…', openAccountDialog]);
  return items;
}

// ---------- new-card dialog helpers ----------
function defaultAccountFor(pid) {
  const count = new Map();
  for (const t of tabsOf(pid || '')) count.set(t.accountId, (count.get(t.accountId) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'default';
}
function fillAccountSelect(selected) {
  const row = $('#f-account-row');
  row.hidden = !multiAccount();
  $('#f-account').innerHTML = state.accounts.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
  $('#f-account').value = state.accounts.some(a => a.id === selected) ? selected : 'default';
}
const dialogAccountDir = () => acctById($('#f-account').value || 'default').configDir || '';

// ---------- account dialog ----------
let homeDir = '';
async function openAccountDialog() {
  if (!homeDir) homeDir = (await api.accountDefaults()).home;
  renderAccountDialog();
  if (!$('#dlg-acct').open) $('#dlg-acct').showModal();
}

function renderAccountDialog() {
  const list = $('#acct-list');
  list.innerHTML = '';
  state.accounts.forEach(a => {
    const row = document.createElement('div');
    row.className = 'acct-row';
    row.innerHTML = `<input type="color" class="ac-color" value="${esc(a.color)}" title="帳號顏色">
      <div class="ac-main">
        <div class="ac-line"><input class="ac-name" value="${esc(a.name)}" maxlength="40"><span class="ac-status">檢查中…</span></div>
        <div class="ac-line"><input class="ac-dir" value="${esc(a.configDir)}" placeholder="預設帳號：~/.claude" ${a.id === 'default' ? 'readonly' : ''} spellcheck="false">
          <input class="ac-email" value="${esc(a.email)}" placeholder="登入用 email（選填）" spellcheck="false"></div>
      </div>
      <div class="ac-btns"><button type="button" class="ac-verify" title="重新檢查登入狀態">驗證</button><button type="button" class="ac-login primary" title="開一個終端機，用此帳號執行 claude auth login">登入</button>${a.id === 'default' ? '' : '<button type="button" class="ac-del">刪除</button>'}</div>`;
    const status = row.querySelector('.ac-status');
    const check = async () => {
      status.className = 'ac-status'; status.textContent = '檢查中…';
      const s = await api.accountStatus(a.configDir);
      if (!status.isConnected) return;
      if (s.loggedIn) { status.className = 'ac-status ok'; status.textContent = `${s.email}${s.plan ? ' · ' + s.plan : ''}`; }
      else { status.className = 'ac-status bad'; status.textContent = s.ok ? '尚未登入 → 按「登入」' : '無法執行 claude'; }
    };
    check();
    row.querySelector('.ac-name').addEventListener('input', e => { a.name = e.target.value.trim() || a.name; saveSoon(); renderTabs(); });
    row.querySelector('.ac-color').addEventListener('input', e => { a.color = e.target.value; saveSoon(); renderTabs(); });
    row.querySelector('.ac-email').addEventListener('input', e => { a.email = e.target.value.trim(); saveSoon(); });
    row.querySelector('.ac-dir').addEventListener('change', e => { a.configDir = e.target.value.trim(); saveSoon(); check(); });
    row.querySelector('.ac-verify').addEventListener('click', check);
    row.querySelector('.ac-login').addEventListener('click', () => loginCard(a));
    row.querySelector('.ac-del')?.addEventListener('click', () => {
      if (!confirm(`刪除帳號「${a.name}」？\n使用它的卡片會改回「${state.accounts[0].name}」。\n（不會刪除該帳號的登入資料夾）`)) return;
      state.accounts.splice(state.accounts.indexOf(a), 1);
      for (const t of state.tabs) if (t.accountId === a.id) t.accountId = 'default';
      saveSoon(); renderTabs(); renderAccountDialog();
    });
    list.appendChild(row);
  });
  $('#acct-auto').checked = !!state.settings.autoSwitch;
}

// A throw-away terminal card that runs `claude auth login` inside the chosen account's config dir.
function loginCard(a) {
  const email = a.email ? ` --email ${a.email}` : '';
  const tab = {
    id: crypto.randomUUID(), title: `登入 ${a.name}`, cwd: homeDir, agent: 'custom',
    startCmd: `claude auth login${email}`, resumeCmd: '', autoRun: true, launched: false, color: a.color,
    projectId: '', accountId: a.id, fontSize: 0, lastActive: Date.now(),
  };
  state.tabs.push(tab);
  $('#dlg-acct').close();
  activate(tab.id);
  startTab(tab);
}

$('#btn-acct').addEventListener('click', openAccountDialog);
$('#acct-close').addEventListener('click', () => $('#dlg-acct').close());
$('#acct-add').addEventListener('click', async () => {
  if (!homeDir) homeDir = (await api.accountDefaults()).home;
  const letter = String.fromCharCode(65 + state.accounts.length);                    // A, B, C ...
  const palette = ['#6ea8fe', '#f59e42', '#4cc38a', '#f472b6', '#a78bfa'];
  state.accounts.push({
    id: 'acct-' + crypto.randomUUID().slice(0, 8), name: `帳號 ${letter}`,
    configDir: `${homeDir}${sepChar}.claude-${letter.toLowerCase()}`, email: '', color: palette[state.accounts.length % palette.length],
  });
  saveSoon(); renderAccountDialog(); renderTabs();
});
$('#acct-auto').addEventListener('change', e => { state.settings.autoSwitch = e.target.checked; saveSoon(); });
$('#f-account').addEventListener('change', () => { if (!editing) detectSession(); });
