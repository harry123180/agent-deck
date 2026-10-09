'use strict';
// "Token用量" panel. Nothing is loaded until the button is clicked; the last result is cached on disk.
// Shares the global scope with renderer.js ($, api, state, esc).
const U = { data: null, acct: 'default', tab: 'overview', mode: 'group', loading: false, t0: 0, timer: null, expanded: new Set(), error: '' };
const PALETTE = ['#6ea8fe', '#4cc38a', '#f0b429', '#a78bfa', '#f472b6', '#2dd4bf'];
const OTHER_COLOR = '#5b6274';
const STALE_MS = 15 * 60 * 1000;
const { money, compact } = UsageCalc;
const curData = () => U.data?.accounts?.[U.acct] || null;   // result for the account selected in the header
const hasData = d => !!(d && (d.daily || d.blocks));

function ago2(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return '剛剛';
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} 分鐘前` : m < 1440 ? `${Math.floor(m / 60)} 小時前` : `${Math.floor(m / 1440)} 天前`;
}
const hm = ms => { const m = Math.max(0, Math.round(ms / 60000)); return `${Math.floor(m / 60)} 小時 ${m % 60} 分`; };
const niceMax = v => { if (v <= 0) return 1; const e = 10 ** Math.floor(Math.log10(v)); const m = v / e; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * e; };

async function openUsage() {
  $('#usage').hidden = false;
  const { data, running } = await api.usageCached();
  U.data = data;
  renderUsage();
  if (!hasAny(data) || running || Date.now() - data.fetchedAt > STALE_MS) refreshUsage();   // cache is shown first, refresh behind it
}
const hasAny = data => !!data && Object.values(data.accounts || {}).some(hasData);
function closeUsage() { $('#usage').hidden = true; }

async function refreshUsage() {
  if (U.loading) return;
  U.loading = true; U.t0 = Date.now(); U.error = '';
  clearInterval(U.timer);
  U.timer = setInterval(tickUsage, 1000);
  renderUsage();
  try {
    const d = await api.usageRefresh(state.accounts.map(a => ({ id: a.id, configDir: a.configDir })));
    if (hasAny(d)) U.data = d;
    else U.error = Object.values(d?.accounts || {}).map(a => a.dailyError || a.blocksError).find(Boolean) || 'ccusage 沒有回傳資料';
  } catch (e) { U.error = String(e.message || e); }
  U.loading = false;
  clearInterval(U.timer); U.timer = null;
  renderUsage();
}

function tickUsage() {
  const st = $('#u-status');
  if (st && U.loading) st.textContent = `ccusage 掃描歷史紀錄中… 已 ${Math.floor((Date.now() - U.t0) / 1000)} 秒`;
  if (U.tab === 'quota' && !$('#usage').hidden) renderBody();
}

// ---------- rendering ----------
function renderUsage() {
  if (!state.accounts.some(a => a.id === U.acct)) U.acct = 'default';
  const d = curData();
  const acct = d?.auth;
  renderAcctPills();
  setText($('#u-acct'), acct?.email ? `${acct.email}${acct.plan ? ' · ' + acct.plan : ''}` : '');
  const st = $('#u-status');
  st.textContent = U.loading ? `ccusage 掃描歷史紀錄中… 已 ${Math.floor((Date.now() - U.t0) / 1000)} 秒` : U.data ? `更新於 ${ago2(U.data.fetchedAt)}` : '';
  $('#u-refresh').disabled = U.loading;
  document.addEventListener('click', e => { const c = e.target.closest?.('.u-cmp'); if (c && !$('#usage').hidden) { U.acct = c.dataset.acct; renderUsage(); } });
for (const b of document.querySelectorAll('#u-tabs button')) b.classList.toggle('on', b.dataset.t === U.tab);
  renderBody();
}

function summary() {
  return UsageCalc.summarize(curData()?.daily, { tabs: state.tabs, projects: state.projects, now: new Date() });
}

function renderBody() {
  const body = $('#u-body');
  const top = body.scrollTop;
  const d = curData();
  let html = '';
  if (!d && U.data && state.accounts.length > 1 && !U.loading) {
    html = `<div class="u-loading"><div>這個帳號還沒有用量資料</div><small>可能尚未登入，或按「⟳ 更新」重新讀取。</small></div>`;
  } else if (!d) {
    html = U.loading
      ? `<div class="u-loading"><div class="u-spin"></div><div>第一次載入要掃描全部歷史紀錄，約 1～2 分鐘。</div><small>之後會先顯示上次的結果，再在背景更新。</small></div>`
      : `<div class="u-loading"><div>無法取得用量資料</div><small>${esc(U.error || '請確認已安裝 ccusage（npm i -g ccusage）')}</small><button id="u-retry">重試</button></div>`;
  } else {
    if (d.offline) html += '<div class="u-warn">無法連線取得最新價格表，已改用離線快取：新模型的花費可能顯示為 $0，token 數量仍然準確。</div>';
    if (d.dailyError && !d.daily) html += `<div class="u-warn">每日用量讀取失敗：${esc(d.dailyError)}</div>`;
    if (U.error) html += `<div class="u-warn">更新失敗，顯示的是舊資料：${esc(U.error)}</div>`;
    html += U.tab === 'quota' ? compareHtml() + quotaHtml(d) : (d.daily ? (U.tab === 'projects' ? projectsHtml() : overviewHtml()) : '');
  }
  body.innerHTML = html;
  body.scrollTop = top;
  $('#u-retry')?.addEventListener('click', refreshUsage);
  for (const row of body.querySelectorAll('[data-group]')) row.addEventListener('click', () => {
    const k = row.dataset.group; U.expanded.has(k) ? U.expanded.delete(k) : U.expanded.add(k); renderBody();
  });
  for (const b of body.querySelectorAll('[data-mode]')) b.addEventListener('click', () => { U.mode = b.dataset.mode; renderBody(); });
}

function kpi(label, v) {
  return `<div class="u-kpi"><div class="u-kl">${label}</div><div class="u-kv">${money(v.cost)}</div><div class="u-ks">${compact(v.tokens)} tokens</div></div>`;
}

function overviewHtml() {
  const S = summary();
  const top = S.repos.slice(0, 5);
  const colorOf = new Map(top.map((r, i) => [r.key, PALETTE[i]]));
  const legend = top.map(r => `<span class="u-lg"><i style="background:${colorOf.get(r.key)}"></i>${esc(r.name)}</span>`).join('') +
    (S.repos.length > 5 ? `<span class="u-lg"><i style="background:${OTHER_COLOR}"></i>其他 ${S.repos.length - 5} 個資料夾</span>` : '');
  const modelTotal = S.models.reduce((a, m) => a + m.cost, 0) || 1;
  const mcolor = i => PALETTE[(i + 3) % PALETTE.length];
  return `<div class="u-kpis">${kpi('今天', S.totals.today)}${kpi('近 7 天', S.totals.week)}${kpi('近 30 天', S.totals.month)}</div>
    <h3>每日花費（近 30 天，依資料夾堆疊）</h3>
    ${barsSvg(S, colorOf)}
    <div class="u-legend">${legend}</div>
    <h3>模型佔比（近 30 天花費）</h3>
    <div class="u-stack">${S.models.map((m, i) => `<span style="flex:${Math.max(m.cost, modelTotal * 0.004)};background:${mcolor(i)}" title="${esc(m.name)} · ${money(m.cost)} · ${compact(m.tokens)} tokens"></span>`).join('')}</div>
    <div class="u-legend">${S.models.map((m, i) => `<span class="u-lg"><i style="background:${mcolor(i)}"></i>${esc(m.name)} <b>${money(m.cost)}</b> <em>${Math.round((m.cost / modelTotal) * 100)}%</em></span>`).join('')}</div>
    <div class="u-foot">金額是 ccusage 依 Anthropic API 公開價格換算的「等值費用」，訂閱方案（如 Max）實際收費是固定月費，不會等於這個數字；它適合用來比較各專案的相對用量。</div>`;
}

function barsSvg(S, colorOf) {
  const W = 760, H = 230, L = 46, R = 8, T = 10, B = 26;
  const pw = W - L - R, ph = H - T - B;
  const max = niceMax(Math.max(...S.days.map(d => d.cost), 0.01));
  const slot = pw / S.days.length, bw = slot * 0.68;
  let g = '';
  for (const f of [0, 0.5, 1]) {
    const y = T + ph - ph * f;
    g += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" class="u-grid"/><text x="${L - 6}" y="${y + 4}" class="u-ax" text-anchor="end">${money(max * f)}</text>`;
  }
  S.days.forEach((d, i) => {
    const x = L + i * slot + (slot - bw) / 2;
    let y = T + ph;
    const parts = [];
    let rest = d.cost;
    for (const [key, c] of Object.entries(d.byRepo).sort((a, b) => b[1] - a[1])) {
      if (!colorOf.has(key)) continue;
      const h = (c / max) * ph; y -= h; rest -= c;
      parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, 0.5).toFixed(1)}" fill="${colorOf.get(key)}"/>`);
    }
    if (rest > 0.0001) { const h = (rest / max) * ph; y -= h; parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, 0.5).toFixed(1)}" fill="${OTHER_COLOR}"/>`); }
    const tip = `${d.date} · ${money(d.cost)} · ${compact(d.tokens)} tokens` +
      Object.entries(d.byRepo).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, c]) => `\n${S.repos.find(r => r.key === k)?.name || k}  ${money(c)}`).join('');
    g += `<g><title>${esc(tip)}</title><rect x="${(L + i * slot).toFixed(1)}" y="${T}" width="${slot.toFixed(1)}" height="${ph}" fill="transparent"/>${parts.join('')}</g>`;
    if (i % 5 === 0 || i === S.days.length - 1) g += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 8}" class="u-ax" text-anchor="middle">${d.date.slice(5)}</text>`;
  });
  return `<svg class="u-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="每日花費長條圖">${g}</svg>`;
}

const sparkSvg = (daysArr, key) => sparkFromArray(daysArr.map(d => d.byRepo[key] || 0));

function projectsHtml() {
  const S = summary();
  const grand = S.totals.month.cost || 1;
  const row = (name, sub, cost, tokens, spark, extra = '', cls = '') =>
    `<div class="u-row ${cls}" ${extra}><div class="u-rn"><b>${esc(name)}</b><small>${esc(sub)}</small></div>${spark}` +
    `<div class="u-rb"><span style="width:${Math.max(1, (cost / grand) * 100).toFixed(1)}%"></span></div>` +
    `<div class="u-rc">${money(cost)}<small>${Math.round((cost / grand) * 100)}%</small></div><div class="u-rt">${compact(tokens)}</div></div>`;
  let rows = '';
  if (U.mode === 'group') {
    for (const g of S.groups) {
      const open = U.expanded.has(g.id || g.name);
      const gdays = S.days.map(d => g.repos.reduce((a, r) => a + (d.byRepo[r.key] || 0), 0));
      rows += row(`${open ? '▾' : '▸'} ${g.name}`, `${g.repos.length} 個資料夾`, g.cost, g.tokens, sparkFromArray(gdays), `data-group="${esc(g.id || g.name)}"`, 'group');
      if (open) for (const r of g.repos) rows += row(r.name, r.cwd || r.key, r.cost, r.tokens, sparkSvg(S.days, r.key), '', 'child');
    }
  } else {
    for (const r of S.repos) rows += row(r.name + (r.matched ? '' : '  (無卡片)'), r.cwd || r.key, r.cost, r.tokens, sparkSvg(S.days, r.key));
  }
  return `<div class="u-seg"><button data-mode="group" class="${U.mode === 'group' ? 'on' : ''}">依專案群組</button><button data-mode="repo" class="${U.mode === 'repo' ? 'on' : ''}">依資料夾</button>
    <span class="u-note">近 30 天 · 合計 ${money(S.totals.month.cost)} · ${compact(S.totals.month.tokens)} tokens</span></div>
    <div class="u-table"><div class="u-row head"><div class="u-rn">名稱</div><div class="u-spark-h">30 天</div><div class="u-rb"></div><div class="u-rc">花費</div><div class="u-rt">Tokens</div></div>${rows || '<div class="u-empty">近 30 天沒有用量</div>'}</div>`;
}
function sparkFromArray(vals) {
  const max = Math.max(...vals, 0.0001), w = 3, gap = 1;
  return `<svg class="u-spark" viewBox="0 0 ${vals.length * (w + gap)} 22">${vals.map((v, i) => {
    const h = v > 0 ? Math.max(1.5, (v / max) * 22) : 0;
    return h ? `<rect x="${i * (w + gap)}" y="${22 - h}" width="${w}" height="${h}" rx="0.6" fill="#6ea8fe"/>` : '';
  }).join('')}</svg>`;
}

function quotaHtml(d) {
  const acct = d.auth;
  const head = `<div class="u-acct"><b>${esc(acct?.email || '未知帳號')}</b>${acct?.plan ? `<span class="tag">${esc(acct.plan)}</span>` : ''}<small>${esc(acct?.configDirectory || '')}</small></div>`;
  const b = d.blocks?.blocks?.find(x => x.isActive);
  if (!b) {
    return head + `<div class="u-empty">${d.blocksError ? '讀取配額失敗：' + esc(d.blocksError) : '目前沒有進行中的 5 小時計費視窗。下一次對話開始時會自動開一個新的。'}</div>` + quotaNote();
  }
  const now = Date.now(), start = Date.parse(b.startTime), end = Date.parse(b.endTime);
  const left = end - now;
  const elapsedPct = Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100));
  const lim = b.tokenLimitStatus;
  const used = lim ? lim.percentUsed : 0, proj = lim ? (lim.projectedUsage / lim.limit) * 100 : 0;
  const tone = p => (p >= 90 ? 'bad' : p >= 70 ? 'warn' : 'ok');
  return head + `
    <div class="u-kpis">
      <div class="u-kpi"><div class="u-kl">視窗剩餘時間</div><div class="u-kv">${left > 0 ? hm(left) : '已結束'}</div><div class="u-ks">${new Date(start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} → ${new Date(end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div></div>
      <div class="u-kpi"><div class="u-kl">本視窗花費</div><div class="u-kv">${money(b.costUSD || 0)}</div><div class="u-ks">${compact(b.totalTokens)} tokens · ${b.entries} 次呼叫</div></div>
      <div class="u-kpi"><div class="u-kl">燒錢速度</div><div class="u-kv">${money(b.burnRate?.costPerHour || 0)}<small>/小時</small></div><div class="u-ks">${compact(b.burnRate?.tokensPerMinute || 0)} tokens/分</div></div>
    </div>
    <h3>目前 5 小時視窗</h3>
    <div class="u-meter"><div class="u-fill neutral" style="width:${elapsedPct.toFixed(1)}%"></div></div>
    <div class="u-cap"><span>已過 ${Math.round(elapsedPct)}%</span><span>${left > 0 ? '剩 ' + hm(left) : '已結束'}</span></div>
    ${lim ? `<h3>用量 vs 你歷史最高的單一視窗</h3>
    <div class="u-meter tall"><div class="u-fill ${tone(used)}" style="width:${Math.min(100, used).toFixed(1)}%"></div>${proj > used ? `<div class="u-proj" style="left:${Math.min(100, proj).toFixed(1)}%" title="依目前速度，視窗結束時預估達到"></div>` : ''}</div>
    <div class="u-cap"><span><b class="${tone(used)}">${used.toFixed(1)}%</b> · ${compact(b.totalTokens)} / ${compact(lim.limit)} tokens</span><span>預估結束時 <b class="${tone(proj)}">${proj.toFixed(0)}%</b>（${compact(lim.projectedUsage)}${b.projection ? ' · ' + money(b.projection.totalCost) : ''}）</span></div>` : ''}
    ${quotaNote()}`;
}
function quotaNote() {
  return `<div class="u-foot">這裡的「配額」是 ccusage 的推算：把目前 5 小時視窗的 token 用量，拿來跟<b>你自己歷史上用得最多的那一個視窗</b>比較，不是 Anthropic 官方的方案上限。要看官方剩餘額度，請在 Claude Code 內輸入 <code>/usage</code>。</div>`;
}

// ---------- accounts ----------
function renderAcctPills() {
  const box = $('#u-accts');
  box.hidden = state.accounts.length < 2;
  if (box.hidden) { box.innerHTML = ''; return; }
  box.innerHTML = state.accounts.map(a => `<button data-a="${esc(a.id)}" class="${a.id === U.acct ? 'on' : ''}" style="--ac:${esc(a.color)}"><i></i>${esc(a.name)}</button>`).join('');
  for (const b of box.querySelectorAll('button')) b.addEventListener('click', () => { U.acct = b.dataset.a; renderUsage(); });
}

// Side-by-side current 5-hour window of every account: which one still has headroom?
function compareHtml() {
  if (state.accounts.length < 2 || !U.data) return '';
  const now = Date.now();
  const rows = state.accounts.map(a => {
    const d = U.data.accounts?.[a.id];
    const b = d?.blocks?.blocks?.find(x => x.isActive);
    const lim = b?.tokenLimitStatus;
    const used = lim ? lim.percentUsed : 0;
    const tone = used >= 90 ? 'bad' : used >= 70 ? 'warn' : 'ok';
    const who = d?.auth?.email ? `${esc(d.auth.email)}${d.auth.plan ? ' · ' + esc(d.auth.plan) : ''}` : (d ? '未登入' : '尚無資料');
    const left = b ? hm(Date.parse(b.endTime) - now) : '';
    return `<div class="u-cmp ${a.id === U.acct ? 'cur' : ''}" data-acct="${esc(a.id)}" style="--ac:${esc(a.color)}">
      <div class="u-cn"><i></i><b>${esc(a.name)}</b><small>${who}</small></div>
      ${b ? `<div class="u-meter"><div class="u-fill ${tone}" style="width:${Math.min(100, used).toFixed(1)}%"></div></div>
      <div class="u-cv"><b class="${tone}">${used.toFixed(0)}%</b><small>剩 ${left} · ${money(b.costUSD || 0)}</small></div>`
        : `<div class="u-meter empty"></div><div class="u-cv"><small>${d ? '目前沒有進行中的視窗' : ''}</small></div>`}</div>`;
  }).join('');
  return `<h3>各帳號目前的 5 小時視窗</h3><div class="u-cmps">${rows}</div>`;
}

// ---------- wiring ----------
$('#btn-usage').addEventListener('click', openUsage);
$('#u-close').addEventListener('click', closeUsage);
$('#u-refresh').addEventListener('click', refreshUsage);
for (const b of document.querySelectorAll('#u-tabs button')) b.addEventListener('click', () => { U.tab = b.dataset.t; renderUsage(); });
window.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#usage').hidden && !document.querySelector('dialog[open]')) closeUsage(); });
