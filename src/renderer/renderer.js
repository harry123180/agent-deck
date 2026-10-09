'use strict';
const $ = s => document.querySelector(s);
const api = window.deck;

let AGENTS = {};
let state = { tabs: [], projects: [], view: { ids: [], layout: 'auto', cols: [], rows: [] }, activeId: null, settings: {} };
// id -> { term, fit, pane, el, opened, status, state, attn, since, workStart, startedAt, lastOut, lastInput, ackErr, lastErrLine, overlay }
const terms = new Map();

const COLORS = ['', '#ef5b5b', '#f0b429', '#4cc38a', '#2dd4bf', '#6ea8fe', '#a78bfa', '#f472b6'];
const BASE_FONT = () => state.settings.fontSize || 14;
const STATE_LABEL = { working: '工作中', idle: '待輸入', asking: '需決策', error: '出錯', asleep: '未啟動' };
const URGENCY = ['asking', 'error', 'working', 'idle', 'asleep'];

// ---------- helpers ----------
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const baseName = p => p.split(/[\\/]+/).filter(Boolean).pop() || p;
const trimPath = p => p.replace(/[\\/]+$/, '').toLowerCase();
const tabById = id => state.tabs.find(t => t.id === id);
const projById = id => state.projects.find(p => p.id === id);
const tabsOf = pid => state.tabs.filter(t => (t.projectId || '') === pid);
const mmss = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const ago = ts => {
  if (!ts) return '';
  const m = Math.floor((Date.now() - ts) / 60000);
  return m < 1 ? '剛剛' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};
function setText(el, v) { if (el.textContent !== v) el.textContent = v; }
const grid9 = () => '<span class="ind">' + '<i></i>'.repeat(9) + '</span>';
// same order as the sidebar: project cards first, then loose cards
const orderedTabs = () => [...state.projects.flatMap(p => tabsOf(p.id)), ...tabsOf('')];
const launchCommand = t => {
  if (t.autoRun === false) return '';
  return ((t.launched ? (t.resumeCmd || t.startCmd) : t.startCmd) || '').trim();
};

// ---------- persistence ----------
let saveTimer = null;
const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 300); };
const saveNow = () => api.saveState(JSON.parse(JSON.stringify(state)));
window.addEventListener('beforeunload', saveNow);

// ---------- terminals ----------
function ensureTerm(tab) {
  let r = terms.get(tab.id);
  if (r) return r;
  const term = new Terminal({
    fontFamily: '"Cascadia Mono", Consolas, "Microsoft JhengHei UI", monospace',
    fontSize: tab.fontSize || BASE_FONT(), scrollback: 10000, cursorBlink: true, allowProposedApi: true,
    theme: { background: '#12141a', foreground: '#d7dae0', cursor: '#6ea8fe', selectionBackground: '#33416b' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);

  const pane = document.createElement('div');
  pane.className = 'pane';
  pane.style.display = 'none';
  pane.innerHTML = `<div class="pane-head" draggable="true">${grid9()}<span class="pt"></span><span class="acct-badge" hidden></span><span class="pp"></span>` +
    '<span class="pstat"><b></b><span></span></span><button class="pclose" title="從分割畫面移除">✕</button></div><div class="term"></div><div class="zoom-toast"></div>';
  const el = pane.querySelector('.term');
  $('#terms').appendChild(pane);

  r = { term, fit, pane, el, opened: false, status: 'asleep', state: 'asleep', attn: false, since: 0, workStart: 0,
    startedAt: 0, lastOut: tab.lastActive || 0, lastInput: 0, ackErr: '', lastErrLine: '', overlay: null, calm: 0 };
  terms.set(tab.id, r);
  const id = tab.id;

  term.onData(d => { r.lastInput = Date.now(); r.ackErr = r.lastErrLine; api.write(id, d); });
  term.onResize(({ cols, rows }) => api.resize(id, cols, rows));
  term.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && !e.shiftKey && e.key === 'c' && term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); return false; }
    if (e.ctrlKey && e.shiftKey && e.key === 'C') { navigator.clipboard.writeText(term.getSelection()); return false; }
    // xterm would send a raw Ctrl+V to the shell and swallow the browser paste, so read the clipboard here
    if (e.ctrlKey && !e.altKey && (e.key === 'v' || e.key === 'V')) {
      navigator.clipboard.readText().then(text => { if (text) term.paste(text); }).catch(() => { /* clipboard blocked */ });
      return false;
    }
    return true;
  });
  new ResizeObserver(() => fitOne(id)).observe(el);

  pane.addEventListener('mousedown', () => { if (state.activeId !== id) focusPane(id); }, true);
  pane.querySelector('.pclose').addEventListener('click', e => { e.stopPropagation(); removeFromView(id); });
  // Ctrl + wheel = zoom this terminal's font
  pane.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault(); e.stopPropagation();
    zoomTab(tabById(id), e.deltaY < 0 ? 1 : -1);
  }, { passive: false, capture: true });
  // drag a pane header onto another pane to swap their positions
  const head = pane.querySelector('.pane-head');
  head.addEventListener('dragstart', e => { paneDrag = id; e.dataTransfer.setData('text/plain', id); });
  pane.addEventListener('dragover', e => { if (paneDrag && paneDrag !== id) { e.preventDefault(); pane.classList.add('swap-over'); } });
  pane.addEventListener('dragleave', () => pane.classList.remove('swap-over'));
  pane.addEventListener('drop', e => {
    pane.classList.remove('swap-over');
    if (!paneDrag || paneDrag === id) return;
    e.preventDefault();
    const ids = state.view.ids, a = ids.indexOf(paneDrag), b = ids.indexOf(id);
    if (a >= 0 && b >= 0) { [ids[a], ids[b]] = [ids[b], ids[a]]; applyView(); saveSoon(); }
    paneDrag = null;
  });
  head.addEventListener('dragend', () => { paneDrag = null; });
  return r;
}
let paneDrag = null;

function setOverlay(tab, html, onClick) {
  const r = terms.get(tab.id);
  r.overlay?.remove(); r.overlay = null;
  if (!html) return;
  const o = document.createElement('div');
  o.className = 'overlay';
  o.innerHTML = html;
  o.querySelector('button')?.addEventListener('click', onClick);
  r.el.appendChild(o);
  r.overlay = o;
}

async function startTab(tab, { fresh = false } = {}) {
  const r = ensureTerm(tab);
  if (r.status === 'running') return;
  setOverlay(tab, '');
  if (fresh) r.term.reset();
  const command = launchCommand(tab);
  const res = await api.spawn({ id: tab.id, cwd: tab.cwd, cols: r.term.cols, rows: r.term.rows, command, shell: state.settings.shell });
  if (!res.ok) {
    r.status = 'dead';
    setOverlay(tab, `<div>無法啟動 shell</div><small>${esc(res.error)}</small><button>重試</button>`, () => startTab(tab));
    return renderTabs();
  }
  r.status = 'running'; r.startedAt = Date.now(); r.attn = false;
  // conpty clears the screen on startup, so show the warning after that
  if (res.warn) setTimeout(() => r.term.write(`\x1b[33m[agent-deck] ${res.warn}\x1b[0m\r\n`), 1500);
  if (command && !tab.launched) { tab.launched = true; saveSoon(); }
  renderTabs();
}

function restartTab(tab) {
  const r = terms.get(tab.id);
  if (r) { api.kill(tab.id); r.status = 'asleep'; }
  startTab(tab, { fresh: true });
}

api.onData((id, data) => {
  const r = terms.get(id); if (!r) return;
  r.term.write(data);
  r.lastOut = Date.now();
});
api.onExit((id, code) => {
  const r = terms.get(id), tab = tabById(id); if (!r || !tab) return;
  r.status = 'dead';
  setOverlay(tab, `<div>Shell 已結束 (code ${code})</div><button>重新啟動</button>`, () => restartTab(tab));
  renderTabs();
});

// ---------- font zoom ----------
function zoomTab(tab, step, reset) {
  if (!tab) return;
  const r = ensureTerm(tab);
  const cur = tab.fontSize || BASE_FONT();
  const next = reset ? 0 : Math.min(40, Math.max(8, cur + step));
  tab.fontSize = next === BASE_FONT() ? 0 : next;
  r.term.options.fontSize = tab.fontSize || BASE_FONT();
  fitOne(tab.id);
  const toast = r.pane.querySelector('.zoom-toast');
  toast.textContent = `${Math.round(((tab.fontSize || BASE_FONT()) / BASE_FONT()) * 100)}%`;
  toast.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => toast.classList.remove('on'), 900);
  saveSoon();
}

// ---------- fitting ----------
function fitOne(id) {
  const r = terms.get(id);
  if (!r || !r.opened || !r.el.offsetWidth || !r.el.offsetHeight) return;
  try { r.fit.fit(); api.resize(id, r.term.cols, r.term.rows); } catch { /* not laid out yet */ }
}
const fitAll = () => state.view.ids.forEach(fitOne);

// ---------- view (single / split) ----------
function currentTemplate() {
  return Layouts.resolve(Math.max(1, state.view.ids.length), state.view.layout);
}

function applyView() {
  const v = state.view;
  v.ids = v.ids.filter(tabById).slice(0, 9);
  if (!v.ids.length && tabById(state.activeId)) v.ids = [state.activeId];
  if (!v.ids.includes(state.activeId)) state.activeId = v.ids[0] || null;
  const multi = v.ids.length > 1;
  const box = $('#terms');
  box.classList.toggle('multi', multi);

  const tpl = currentTemplate();
  const cols = Layouts.tracks(v.cols, tpl.cols), rows = Layouts.tracks(v.rows, tpl.rows);
  box.style.gridTemplateAreas = tpl.areas.map(r => `"${r.join(' ')}"`).join(' ');
  box.style.gridTemplateColumns = cols.map(f => `minmax(0, ${f}fr)`).join(' ');
  box.style.gridTemplateRows = rows.map(f => `minmax(0, ${f}fr)`).join(' ');

  for (const [id, r] of terms) {
    const i = v.ids.indexOf(id);
    r.pane.style.display = i < 0 ? 'none' : '';
    if (i >= 0) r.pane.style.gridArea = 'p' + (i + 1);
  }
  for (const id of v.ids) {
    const tab = tabById(id), r = ensureTerm(tab);
    if (!r.opened) { r.term.open(r.el); r.opened = true; }
    r.attn = false;
    if (r.status === 'asleep' && !r.overlay) {
      setOverlay(tab, `<div>${esc(tab.title)}</div><small>${esc(tab.cwd)}</small><button>▶ 啟動</button>`, () => startTab(tab));
    }
  }
  $('#empty').style.display = state.tabs.length ? 'none' : 'flex';
  buildGutters(tpl);
  renderViewbar();
  renderTabs();
  requestAnimationFrame(() => { fitAll(); if (!renamingId) terms.get(state.activeId)?.term.focus(); });
}

// plain click: show only this card (unless it is already part of the current split)
function activate(id, { toggle = false } = {}) {
  const tab = tabById(id);
  if (!tab) { state.activeId = null; state.view.ids = []; applyView(); saveSoon(); return; }
  const v = state.view;
  if (toggle) {
    if (v.ids.includes(id)) { if (v.ids.length > 1) v.ids = v.ids.filter(x => x !== id); }
    else if (v.ids.length < 9) { v.ids.push(id); v.layout = 'auto'; v.cols = []; v.rows = []; }
  } else if (!v.ids.includes(id)) {
    v.ids = [id]; v.layout = 'auto'; v.cols = []; v.rows = [];
  }
  state.activeId = v.ids.includes(id) ? id : v.ids[0];
  tab.lastActive = Date.now();
  applyView(); saveSoon();
}

function focusPane(id) {
  state.activeId = id;
  const r = terms.get(id);
  if (r) { r.attn = false; if (!renamingId) r.term.focus(); }
  renderTabs(); saveSoon();
}

function removeFromView(id) {
  const v = state.view;
  if (v.ids.length <= 1) return;
  v.ids = v.ids.filter(x => x !== id);
  v.layout = 'auto'; v.cols = []; v.rows = [];
  if (state.activeId === id) state.activeId = v.ids[0];
  applyView(); saveSoon();
}

function splitProject(p) {
  const tabs = tabsOf(p.id).slice(0, 9);
  if (!tabs.length) return;
  state.view = { ids: tabs.map(t => t.id), layout: 'auto', cols: [], rows: [] };
  state.activeId = tabs[0].id;
  applyView(); saveSoon();
  for (const t of tabs) if ((terms.get(t.id)?.status || 'asleep') === 'asleep') startTab(t);
}

function setLayout(id) {
  state.view.layout = id; state.view.cols = []; state.view.rows = [];
  applyView(); saveSoon();
}

function renderViewbar() {
  const bar = $('#viewbar');
  const n = state.view.ids.length;
  bar.hidden = n < 2;
  if (n < 2) return;
  const list = Layouts.templatesFor(n);
  const cur = currentTemplate();
  bar.innerHTML = `<span class="vb-label">分割畫面 · ${n} 個窗格</span><span class="vb-tpls"></span><span class="vb-hint">拖曳分隔線調整大小 · 拖曳窗格標題互換位置 · 雙擊分隔線還原</span><button id="vb-end">結束分割</button>`;
  const holder = bar.querySelector('.vb-tpls');
  for (const t of list) {
    const b = document.createElement('button');
    b.className = 'tpl' + (t.id === cur.id ? ' on' : '');
    b.title = t.label;
    const th = document.createElement('span');
    th.className = 'tpl-thumb';
    th.style.gridTemplateAreas = t.areas.map(r => `"${r.join(' ')}"`).join(' ');
    th.style.gridTemplateColumns = t.cols.map(f => `${f}fr`).join(' ');
    th.style.gridTemplateRows = t.rows.map(f => `${f}fr`).join(' ');
    for (const nm of [...new Set(t.areas.flat())]) { const c = document.createElement('i'); c.style.gridArea = nm; th.appendChild(c); }
    b.appendChild(th);
    b.addEventListener('click', () => setLayout(t.id));
    holder.appendChild(b);
  }
  bar.querySelector('#vb-end').addEventListener('click', () => {
    state.view = { ids: [state.activeId], layout: 'auto', cols: [], rows: [] };
    applyView(); saveSoon();
  });
}

// ---------- draggable dividers ----------
let gutterEls = [];
function buildGutters(tpl) {
  gutterEls.forEach(g => g.el.remove());
  gutterEls = [];
  if (state.view.ids.length < 2) return;
  for (const g of Layouts.gutters(tpl)) {
    const el = document.createElement('div');
    el.className = 'gutter ' + (g.axis === 'col' ? 'gv' : 'gh');
    $('#terms').appendChild(el);
    const rec = { ...g, el };
    gutterEls.push(rec);
    el.addEventListener('pointerdown', e => startGutterDrag(e, rec, tpl));
    el.addEventListener('dblclick', () => { state.view.cols = []; state.view.rows = []; applyView(); saveSoon(); });
  }
  placeGutters(tpl);
}

function trackSizes(tpl) {
  return { cols: Layouts.tracks(state.view.cols, tpl.cols), rows: Layouts.tracks(state.view.rows, tpl.rows) };
}

function placeGutters(tpl) {
  const { cols, rows } = trackSizes(tpl);
  const sum = a => a.reduce((x, y) => x + y, 0);
  const cum = (a, i) => (sum(a.slice(0, i)) / sum(a)) * 100;
  for (const g of gutterEls) {
    const s = g.el.style;
    if (g.axis === 'col') {
      s.left = `calc(${cum(cols, g.index + 1)}% - 3px)`; s.width = '6px';
      s.top = cum(rows, g.from) + '%'; s.height = (cum(rows, g.to) - cum(rows, g.from)) + '%';
    } else {
      s.top = `calc(${cum(rows, g.index + 1)}% - 3px)`; s.height = '6px';
      s.left = cum(cols, g.from) + '%'; s.width = (cum(cols, g.to) - cum(cols, g.from)) + '%';
    }
  }
}

function startGutterDrag(e, g, tpl) {
  e.preventDefault();
  const box = $('#terms').getBoundingClientRect();
  const isCol = g.axis === 'col';
  const start = trackSizes(tpl)[isCol ? 'cols' : 'rows'];
  const total = start.reduce((a, b) => a + b, 0);
  const origin = isCol ? e.clientX : e.clientY;
  const px = isCol ? box.width : box.height;
  g.el.setPointerCapture(e.pointerId);
  g.el.classList.add('drag');
  const move = ev => {
    const delta = (((isCol ? ev.clientX : ev.clientY) - origin) / px) * total;
    const next = Layouts.drag(start, g.index, delta);
    if (isCol) state.view.cols = next; else state.view.rows = next;
    const { cols, rows } = trackSizes(tpl);
    const box2 = $('#terms');
    box2.style.gridTemplateColumns = cols.map(f => `minmax(0, ${f}fr)`).join(' ');
    box2.style.gridTemplateRows = rows.map(f => `minmax(0, ${f}fr)`).join(' ');
    placeGutters(tpl);
  };
  const up = () => {
    g.el.classList.remove('drag');
    g.el.removeEventListener('pointermove', move); g.el.removeEventListener('pointerup', up);
    fitAll(); saveSoon();
  };
  g.el.addEventListener('pointermove', move);
  g.el.addEventListener('pointerup', up);
}

// ---------- sidebar: projects + cards (persistent elements so CSS animations keep running) ----------
let dragRef = null; // { kind: 'tab' | 'proj', id }
let renamingId = null;
const cardEls = new Map();
const headEls = new Map();
let looseEl = null;

function cardFor(t) {
  let d = cardEls.get(t.id);
  if (d) return d;
  d = document.createElement('div');
  d.draggable = true;
  d.innerHTML = grid9() + '<div class="meta"><div class="name"></div><div class="sub"></div></div><span class="acct-badge" hidden></span><div class="stat"><b></b><span></span></div>';
  const id = t.id;
  d.addEventListener('click', e => activate(id, { toggle: e.ctrlKey || e.shiftKey || e.metaKey }));
  d.addEventListener('dblclick', e => { e.preventDefault(); renameTab(tabById(id)); });
  d.addEventListener('contextmenu', e => { e.preventDefault(); showCardMenu(e.clientX, e.clientY, tabById(id)); });
  d.addEventListener('dragstart', () => { dragRef = { kind: 'tab', id }; });
  d.addEventListener('dragend', () => { dragRef = null; });
  d.addEventListener('dragover', e => { if (dragRef?.kind === 'tab') { e.preventDefault(); d.classList.add('drag-over'); } });
  d.addEventListener('dragleave', () => d.classList.remove('drag-over'));
  d.addEventListener('drop', e => {
    d.classList.remove('drag-over');
    if (dragRef?.kind !== 'tab' || dragRef.id === id) return;
    e.preventDefault();
    const moved = tabById(dragRef.id), target = tabById(id);
    state.tabs.splice(state.tabs.indexOf(moved), 1);
    state.tabs.splice(state.tabs.indexOf(target), 0, moved);
    moved.projectId = target.projectId || '';
    dragRef = null; renderTabs(); saveSoon();
  });
  cardEls.set(id, d);
  return d;
}

function headFor(p) {
  let h = headEls.get(p.id);
  if (h) return h;
  h = document.createElement('div');
  h.draggable = true;
  // one persistent chip per state (pixel light + count); hidden when that state has no cards
  const chips = URGENCY.map(st => `<span class="chip s-${st}" data-st="${st}" title="${STATE_LABEL[st]}" hidden>${grid9()}<b></b></span>`).join('');
  h.innerHTML = '<span class="chev">▾</span><div class="pname"></div><span class="pcount"></span>' +
    `<span class="psum">${chips}</span><button class="pbtn p-split" title="分割顯示此專案的全部卡片">⊞</button><button class="pbtn p-add" title="在此專案新增卡片">＋</button>`;
  const id = p.id;
  h.addEventListener('click', e => {
    if (e.target.closest('.pbtn') || e.target.closest('.rename')) return;
    const pr = projById(id); pr.collapsed = !pr.collapsed; renderTabs(); saveSoon();
  });
  h.querySelector('.p-split').addEventListener('click', () => splitProject(projById(id)));
  h.querySelector('.p-add').addEventListener('click', () => openDialog(null, id));
  h.addEventListener('dblclick', e => { if (!e.target.closest('.pbtn')) renameProject(projById(id)); });
  h.addEventListener('contextmenu', e => { e.preventDefault(); showProjectMenu(e.clientX, e.clientY, projById(id)); });
  h.addEventListener('dragstart', () => { dragRef = { kind: 'proj', id }; });
  h.addEventListener('dragend', () => { dragRef = null; });
  h.addEventListener('dragover', e => { if (dragRef) { e.preventDefault(); h.classList.add('drag-over'); } });
  h.addEventListener('dragleave', () => h.classList.remove('drag-over'));
  h.addEventListener('drop', e => {
    h.classList.remove('drag-over');
    if (!dragRef) return;
    e.preventDefault();
    if (dragRef.kind === 'tab') {
      const t = tabById(dragRef.id);
      state.tabs.splice(state.tabs.indexOf(t), 1); state.tabs.push(t);   // end of that project
      t.projectId = id; projById(id).collapsed = false;
    } else if (dragRef.id !== id) {
      const from = state.projects.findIndex(x => x.id === dragRef.id);
      const [m] = state.projects.splice(from, 1);
      state.projects.splice(state.projects.findIndex(x => x.id === id), 0, m);
    }
    dragRef = null; renderTabs(); saveSoon();
  });
  headEls.set(id, h);
  return h;
}

function looseLabel() {
  if (looseEl) return looseEl;
  looseEl = document.createElement('div');
  looseEl.className = 'loose-label';
  looseEl.textContent = '未分組';
  looseEl.addEventListener('dragover', e => { if (dragRef?.kind === 'tab') { e.preventDefault(); looseEl.classList.add('drag-over'); } });
  looseEl.addEventListener('dragleave', () => looseEl.classList.remove('drag-over'));
  looseEl.addEventListener('drop', e => {
    looseEl.classList.remove('drag-over');
    if (dragRef?.kind !== 'tab') return;
    e.preventDefault();
    tabById(dragRef.id).projectId = ''; dragRef = null; renderTabs(); saveSoon();
  });
  return looseEl;
}

function updateCard(t, now) {
  const d = cardFor(t);
  const r = terms.get(t.id);
  const st = r?.state || 'asleep';
  const visible = state.view.ids.includes(t.id);
  const cls = `tab s-${st}${t.id === state.activeId ? ' active' : ''}${visible ? ' in-view' : ''}${r?.attn ? ' attn' : ''}${t.color ? ' colored' : ''}${t.projectId ? ' in-proj' : ''}`;
  if (d.className !== cls && !d.classList.contains('drag-over')) d.className = cls;
  if (t.color) d.style.setProperty('--c', t.color); else d.style.removeProperty('--c');
  if (renamingId !== t.id) setText(d.querySelector('.name'), t.title);
  setText(d.querySelector('.sub'), `${AGENTS[t.agent]?.label || t.agent} · ${t.cwd}`);
  const label = STATE_LABEL[st];
  const time = st === 'working' ? mmss(now - (r.workStart || now)) : (st === 'asleep' ? '' : ago(r?.since || t.lastActive));
  setText(d.querySelector('.stat b'), label);
  setText(d.querySelector('.stat span'), time);
  d.title = t.cwd;

  if (r) { // pane header mirrors the card
    const p = r.pane;
    const pcls = `pane s-${st}${t.id === state.activeId ? ' focus' : ''}${t.color ? ' colored' : ''}`;
    if (p.className !== pcls && !p.classList.contains('swap-over')) p.className = pcls;
    if (t.color) p.style.setProperty('--c', t.color); else p.style.removeProperty('--c');
    setText(p.querySelector('.pt'), t.title);
    setText(p.querySelector('.pp'), projById(t.projectId)?.name || '');
    setText(p.querySelector('.pstat b'), label);
    setText(p.querySelector('.pstat span'), time);
  }
}

function updateHead(p, tabs, now) {
  const h = headFor(p);
  const states = tabs.map(t => terms.get(t.id)?.state || 'asleep');
  const top = URGENCY.find(s => states.includes(s)) || 'asleep';
  const attn = tabs.some(t => terms.get(t.id)?.attn);
  const hasActive = tabs.some(t => t.id === state.activeId);
  const cls = `proj t-${top}${p.collapsed ? ' collapsed' : ''}${attn ? ' attn' : ''}${p.color ? ' colored' : ''}${hasActive ? ' has-active' : ''}`;
  if (h.className !== cls && !h.classList.contains('drag-over')) h.className = cls;
  if (p.color) h.style.setProperty('--c', p.color); else h.style.removeProperty('--c');
  if (renamingId !== p.id) setText(h.querySelector('.pname'), p.name);
  setText(h.querySelector('.chev'), p.collapsed ? '▸' : '▾');
  setText(h.querySelector('.pcount'), String(tabs.length));
  for (const chip of h.querySelectorAll('.chip')) {
    const n = states.filter(s => s === chip.dataset.st).length;
    if (chip.hidden !== (n === 0)) chip.hidden = n === 0;
    setText(chip.querySelector('b'), n ? String(n) : '');
  }
}

let revealedId = null;
const projOfActive = () => { const t = tabById(state.activeId); return t?.projectId ? projById(t.projectId) : null; };
function revealActive() {
  if (state.activeId === revealedId) return;
  revealedId = state.activeId;
  const el = cardEls.get(state.activeId) || headEls.get(projOfActive()?.id);
  el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------- collapsible sidebar ----------
function setSide(collapsed) {
  document.body.classList.toggle('side-collapsed', collapsed);
  state.settings.sideCollapsed = collapsed;
  renderRail();
  saveSoon();
  requestAnimationFrame(fitAll);            // the terminal area changed width
}
const toggleSide = () => setSide(!document.body.classList.contains('side-collapsed'));
$('#btn-side').addEventListener('click', () => toggleSide());
$('#rail-open').addEventListener('click', () => toggleSide());

// one dot per card in the rail, same order as the sidebar; click = switch to that card
function renderRail() {
  const list = $('#rail-list');
  if (!list) return;
  const sig = orderedTabs().map(t => `${t.id}:${terms.get(t.id)?.state || 'asleep'}:${t.id === state.activeId ? 1 : 0}:${state.view.ids.includes(t.id) ? 1 : 0}`).join('|');
  if (list.dataset.sig === sig) return;
  list.dataset.sig = sig;
  list.innerHTML = '';
  let lastProj = null;
  for (const t of orderedTabs()) {
    if ((t.projectId || '') !== lastProj) { lastProj = t.projectId || ''; if (list.children.length) { const sep = document.createElement('div'); sep.className = 'rail-sep'; list.appendChild(sep); } }
    const b = document.createElement('button');
    const st = terms.get(t.id)?.state || 'asleep';
    b.className = `rail-dot s-${st}${t.id === state.activeId ? ' active' : ''}`;
    b.title = `${t.title} · ${STATE_LABEL[st]}`;
    b.addEventListener('click', () => activate(t.id));
    list.appendChild(b);
  }
}

function renderTabs() {
  const box = $('#tabs');
  const now = Date.now();
  renderRail();
  state.tabs.forEach(t => updateCard(t, now));
  const desired = [];
  for (const p of state.projects) {
    const tabs = tabsOf(p.id);
    updateHead(p, tabs, now);
    desired.push(headFor(p));
    if (!p.collapsed) tabs.forEach(t => desired.push(cardFor(t)));
  }
  const loose = tabsOf('');
  if (state.projects.length && loose.length) desired.push(looseLabel());
  loose.forEach(t => desired.push(cardFor(t)));
  // the glide highlight lives in #tabs too: never count it as a row
  const rows = () => [...box.children].filter(c => c.id !== 'glide');
  desired.forEach((el, i) => { const cur = rows(); if (cur[i] !== el) box.insertBefore(el, cur[i] || null); });
  while (rows().length > desired.length) rows().pop().remove();
  renderSummary();
  for (const [id, d] of cardEls) if (!tabById(id)) { d.remove(); cardEls.delete(id); }
  for (const [id, h] of headEls) if (!projById(id)) { h.remove(); headEls.delete(id); }
  revealActive();
  $('#side-empty').hidden = state.tabs.length > 0 || state.projects.length > 0;
}

// ---------- inline rename ----------
function inlineRename(id, nameEl, dragEl, current, commit) {
  if (renamingId) return;
  renamingId = id;
  dragEl.draggable = false;
  const inp = document.createElement('input');
  inp.className = 'rename'; inp.value = current;
  nameEl.replaceChildren(inp); inp.focus(); inp.select();
  const born = Date.now();
  const done = ok => {
    if (renamingId !== id) return;
    renamingId = null; dragEl.draggable = true;
    if (ok && inp.value.trim()) commit(inp.value.trim());
    renderTabs(); saveSoon();
  };
  inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); });
  for (const ev of ['click', 'dblclick', 'mousedown']) inp.addEventListener(ev, e => e.stopPropagation());
  inp.addEventListener('blur', () => {
    // focus stolen right after opening (e.g. by the click that preceded the double-click) -> take it back
    if (renamingId === id && Date.now() - born < 400) { setTimeout(() => { if (renamingId === id) { inp.focus(); inp.select(); } }, 0); return; }
    done(true);
  });
}
function renameTab(tab) {
  const d = cardEls.get(tab?.id); if (!d) return;
  inlineRename(tab.id, d.querySelector('.name'), d, tab.title, v => { tab.title = v; });
}
function renameProject(p) {
  const h = headEls.get(p?.id); if (!h) return;
  inlineRename(p.id, h.querySelector('.pname'), h, p.name, v => { p.name = v; });
}

function newProject() {
  const p = { id: crypto.randomUUID(), name: '新專案', color: '', collapsed: false };
  state.projects.push(p);
  renderTabs(); saveSoon();
  renameProject(p);
}

function closeTab(tab, { ask = true } = {}) {
  if (ask && !confirm(`關閉「${tab.title}」？\n（只會移除 tab，不會刪除專案資料夾）`)) return;
  api.kill(tab.id);
  const r = terms.get(tab.id);
  if (r) { r.term.dispose(); r.pane.remove(); terms.delete(tab.id); }
  const i = state.tabs.findIndex(t => t.id === tab.id);
  state.tabs.splice(i, 1);
  state.view.ids = state.view.ids.filter(x => x !== tab.id);
  if (state.activeId === tab.id) state.activeId = state.view.ids[0] || null;
  if (!state.view.ids.length) {
    const next = state.tabs[i] || state.tabs[i - 1];
    if (next) { state.view = { ids: [next.id], layout: 'auto', cols: [], rows: [] }; state.activeId = next.id; }
  } else { state.view.layout = 'auto'; state.view.cols = []; state.view.rows = []; }
  applyView(); saveSoon();
}

// ---------- context menus ----------
function buildMenu(x, y, items, colorTarget) {
  const m = $('#menu');
  m.innerHTML = '';
  for (const [label, fn, cls] of items) {
    const d = document.createElement('div'); d.textContent = label; if (cls) d.className = cls;
    d.addEventListener('click', () => { m.hidden = true; fn(); });
    m.appendChild(d);
  }
  if (colorTarget) {
    const sw = document.createElement('div');
    sw.className = 'swatches';
    sw.addEventListener('click', e => e.stopPropagation());
    const setColor = c => { colorTarget.color = c; $('#menu').hidden = true; renderTabs(); saveSoon(); };
    for (const c of COLORS) {
      const b = document.createElement('button');
      b.className = 'swatch' + ((colorTarget.color || '') === c ? ' on' : '');
      b.title = c || '無顏色';
      if (c) b.style.background = c; else b.classList.add('none');
      b.addEventListener('click', () => setColor(c));
      sw.appendChild(b);
    }
    const custom = document.createElement('input');
    custom.type = 'color'; custom.className = 'swatch custom'; custom.title = '自訂顏色';
    custom.value = /^#[0-9a-f]{6}$/i.test(colorTarget.color || '') ? colorTarget.color : '#6ea8fe';
    custom.addEventListener('input', () => { colorTarget.color = custom.value; renderTabs(); saveSoon(); });
    custom.addEventListener('change', () => { $('#menu').hidden = true; });
    sw.appendChild(custom);
    const lbl = document.createElement('div'); lbl.className = 'menu-label'; lbl.textContent = '顏色';
    m.append(lbl, sw);
  }
  m.hidden = false;
  m.style.left = Math.max(4, Math.min(x, innerWidth - m.offsetWidth - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - m.offsetHeight - 4)) + 'px';
}

function showCardMenu(x, y, tab) {
  const inView = state.view.ids.includes(tab.id);
  const items = [
    ['重新命名  (F2 / 雙擊)', () => { activate(tab.id); renameTab(tab); }],
    [inView && state.view.ids.length > 1 ? '從分割畫面移除' : '加入分割畫面  (Ctrl+點擊)', () => activate(tab.id, { toggle: true })],
    ['重新啟動（resume）', () => restartTab(tab)],
    ['編輯…', () => openDialog(tab)],
  ];
  for (const p of state.projects) if (p.id !== tab.projectId) items.push([`移到專案：${p.name}`, () => { tab.projectId = p.id; p.collapsed = false; renderTabs(); saveSoon(); }]);
  if (tab.projectId) items.push(['移出專案', () => { tab.projectId = ''; renderTabs(); saveSoon(); }]);
  items.push(
    ['複製此 tab', () => { const c = { ...tab, id: crypto.randomUUID(), title: tab.title + ' (2)' }; state.tabs.splice(state.tabs.indexOf(tab) + 1, 0, c); activate(c.id); startTab(c); }],
    ['關閉 tab', () => closeTab(tab), 'danger'],
  );
  buildMenu(x, y, items, tab);
}

function showProjectMenu(x, y, p) {
  buildMenu(x, y, [
    ['重新命名  (雙擊)', () => renameProject(p)],
    ['⊞ 分割顯示全部卡片', () => splitProject(p)],
    ['▶ 啟動全部卡片', () => tabsOf(p.id).forEach(t => startTab(t))],
    ['＋ 新增卡片', () => openDialog(null, p.id)],
    ['解散專案（保留卡片）', () => { tabsOf(p.id).forEach(t => { t.projectId = ''; }); state.projects.splice(state.projects.indexOf(p), 1); renderTabs(); saveSoon(); }],
    ['關閉專案與所有卡片', () => {
      const tabs = tabsOf(p.id);
      if (!confirm(`關閉專案「${p.name}」與其中 ${tabs.length} 張卡片？\n（不會刪除任何資料夾）`)) return;
      tabs.forEach(t => closeTab(t, { ask: false }));
      state.projects.splice(state.projects.indexOf(p), 1); renderTabs(); saveSoon();
    }, 'danger'],
  ], p);
}
document.addEventListener('click', () => { $('#menu').hidden = true; });

// ---------- agent state machine ----------
function bottomLines(term, n) {
  const b = term.buffer.active, out = [];
  for (let i = Math.max(0, b.length - 60); i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) || '');
  return out.filter(l => l.trim()).slice(-n);
}

function computeState(r) {
  if (r.status === 'asleep') return 'asleep';
  if (r.status === 'dead') return 'error';
  const now = Date.now();
  const det = Status.detect(bottomLines(r.term, 40));
  if (det.kind === 'error') r.lastErrLine = det.line;
  if (det.kind === 'asking') return 'asking';
  if (det.kind === 'working') return 'working';
  // output that is not just the echo of what you typed => busy
  if (now - r.lastOut < 1500 && r.lastOut - r.lastInput > 600) return 'working';
  if (det.kind === 'error' && det.line !== r.ackErr) return 'error';
  return 'idle';
}

function tickStates() {
  const now = Date.now();
  for (const t of state.tabs) {
    const r = terms.get(t.id); if (!r) continue;
    const prev = r.state;
    let next = computeState(r);
    // hysteresis: leave "working" only after ~2s of calm, so the light doesn't flicker between spinner frames
    if (prev === 'working' && next !== 'working' && next !== 'asking' && next !== 'asleep') {
      r.calm = (r.calm || 0) + 1;
      if (r.calm < 3) next = 'working';
    } else r.calm = 0;
    if (next === prev) continue;
    r.state = next; r.since = now;
    if (next === 'working') r.workStart = now;
    // only "needs a decision" / "error" pulse on a background card; a finished (idle) agent stays still
    const settled = prev === 'working' && (next === 'asking' || next === 'error');
    const hidden = !state.view.ids.includes(t.id);
    if ((settled || ((next === 'asking' || next === 'error') && prev !== 'asleep')) && hidden && now - r.startedAt > 10000) r.attn = true;
  }
  renderTabs();
}
setInterval(tickStates, 700);

// ---------- add / edit dialog ----------
let editing = null;
let cwdAuto = false;      // true while the path field holds an auto-filled value (safe to replace)
let dialogSession = '';   // pre-assigned Claude session id for the card being created

// Folder used by a project's cards (the most common one), so new cards default to it.
function projectCwd(pid) {
  if (!pid) return '';
  const count = new Map();
  for (const t of tabsOf(pid)) count.set(t.cwd, (count.get(t.cwd) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}
// Same folder twice in one project -> "name 2", "name 3" ...
function autoTitle(cwd, pid) {
  const base = baseName(cwd);
  const n = state.tabs.filter(t => t !== editing && (t.projectId || '') === (pid || '') && t.cwd === cwd).length;
  return n ? `${base} ${n + 1}` : base;
}
// Fallback when the folder has no conversation to continue: a Claude card gets its own fresh session id,
// so several cards can share one folder and each still resumes ITS conversation.
function presetCmds(agent) {
  if (agent === 'claude') {
    return {
      start: `claude --session-id ${dialogSession}`,
      // a card that never got a message has no saved conversation yet -> fall back to starting it with that id
      resume: `claude --resume ${dialogSession}; if ($LASTEXITCODE -ne 0) { claude --session-id ${dialogSession} }`,
    };
  }
  return { start: AGENTS[agent].start, resume: AGENTS[agent].resume };
}
function refreshTitlePlaceholder() {
  const cwd = $('#f-cwd').value.trim();
  $('#f-title').placeholder = cwd ? autoTitle(cwd.replace(/^"|"$/g, ''), $('#f-project').value) : '預設為資料夾名稱';
}

// ---- resume id: read the real last conversation of the folder instead of guessing ----
const agoText = ts => { const a = ago(ts); return a === '剛剛' ? a : `${a} 前`; };
const DETECTABLE = ['claude', 'codex', 'opencode'];
let cmdDirty = false;      // the user typed in the command fields -> automatic detection must not overwrite them
let detectToken = 0, detectTimer = null;
const claimedBy = id => state.tabs.find(t => t !== editing && `${t.startCmd} ${t.resumeCmd}`.includes(id));

async function detectSession({ force = false } = {}) {
  const hint = $('#f-hint');
  const agent = $('#f-agent').value;
  const cwd = $('#f-cwd').value.trim().replace(/^"|"$/g, '');
  const token = ++detectToken;
  if (!DETECTABLE.includes(agent) || !cwd) {
    hint.textContent = DETECTABLE.includes(agent) ? '' : '此 agent 沒有可讀取的對話 id，使用 CLI 的「最近一次」指令';
    return;
  }
  hint.textContent = '偵測此資料夾的對話…';
  const list = await api.listSessions(agent, cwd);
  if (token !== detectToken) return;                     // path/agent changed while waiting
  const write = (start, resume) => {
    if (!cmdDirty || force) { $('#f-start').value = start; $('#f-resume').value = resume; cmdDirty = false; }
  };
  const free = list.find(x => !claimedBy(x.id));         // newest conversation no other card already resumes
  if (!free) {
    const fresh = presetCmds(agent);
    write(fresh.start, fresh.resume);
    hint.textContent = list.length ? `此資料夾的 ${list.length} 個對話都已被其他卡片使用，將開新對話` : '此資料夾還沒有對話，將開新對話';
    return;
  }
  const kept = cmdDirty && !force;
  write(free.command, free.command);
  hint.textContent = `${kept ? '偵測到' : '已帶入'}此資料夾最近的對話 ${free.id.slice(0, 8)} · ${agoText(free.lastActive)}` +
    (free.title ? ` · ${free.title}` : '') + (kept ? '（你已手動改過指令，未覆蓋；按右側按鈕可套用）' : '');
}
const detectLater = () => { clearTimeout(detectTimer); detectTimer = setTimeout(() => { if (!editing) detectSession(); }, 450); };

function openDialog(tab, projectId = '') {
  editing = tab || null;
  dialogSession = crypto.randomUUID();
  cmdDirty = false; detectToken++;
  $('#dlg-title').textContent = tab ? '編輯專案' : '新增專案';
  $('#f-title').value = tab?.title || '';
  $('#f-agent').value = tab?.agent || 'claude';
  const pre = presetCmds('claude');
  $('#f-start').value = tab ? tab.startCmd : pre.start;
  $('#f-resume').value = tab ? tab.resumeCmd : pre.resume;
  $('#f-hint').textContent = '';
  // new card inside a project: default to the project's folder
  const inherited = tab ? '' : projectCwd(projectId);
  $('#f-cwd').value = tab ? tab.cwd : inherited;
  cwdAuto = !!inherited;
  $('#f-auto').checked = tab ? tab.autoRun !== false : true;
  $('#f-project').innerHTML = '<option value="">（不分組）</option>' + state.projects.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  $('#f-project').value = tab ? (tab.projectId || '') : projectId;
  refreshTitlePlaceholder();
  $('#dlg').showModal();
  $('#f-cwd').focus();
  if (!tab && inherited) detectSession();
}
$('#btn-add').addEventListener('click', () => openDialog());
$('#btn-proj').addEventListener('click', newProject);
$('#f-cancel').addEventListener('click', () => $('#dlg').close());
$('#f-browse').addEventListener('click', async () => {
  // open the picker where the path field already points (or at the project's folder)
  const p = await api.pickFolder($('#f-cwd').value.trim() || projectCwd($('#f-project').value));
  if (p) { $('#f-cwd').value = p; cwdAuto = false; refreshTitlePlaceholder(); if (!editing) detectSession(); }
});
$('#f-cwd').addEventListener('input', () => { cwdAuto = false; refreshTitlePlaceholder(); detectLater(); });
$('#f-project').addEventListener('change', () => {
  if (!editing && (cwdAuto || !$('#f-cwd').value.trim())) {
    const c = projectCwd($('#f-project').value);
    $('#f-cwd').value = c; cwdAuto = !!c;
    if (c) detectSession();
  }
  refreshTitlePlaceholder();
});
$('#f-agent').addEventListener('change', e => {
  const a = presetCmds(e.target.value);
  $('#f-start').value = a.start; $('#f-resume').value = a.resume;
  cmdDirty = false;                                      // choosing another agent is an explicit reset
  detectSession();
});
for (const id of ['#f-start', '#f-resume']) $(id).addEventListener('input', () => { cmdDirty = true; });
$('#f-detect').addEventListener('click', () => detectSession({ force: true }));
$('#dlg-form').addEventListener('submit', () => {
  const cwd = $('#f-cwd').value.trim().replace(/^"|"$/g, '');
  const data = {
    cwd, title: $('#f-title').value.trim() || autoTitle(cwd, $('#f-project').value), agent: $('#f-agent').value,
    startCmd: $('#f-start').value.trim(), resumeCmd: $('#f-resume').value.trim(), autoRun: $('#f-auto').checked,
    projectId: $('#f-project').value,
  };
  if (editing) { Object.assign(editing, data); renderTabs(); saveSoon(); return; }
  const tab = { id: crypto.randomUUID(), launched: false, lastActive: Date.now(), color: '', fontSize: 0, ...data };
  state.tabs.push(tab);
  const p = projById(tab.projectId); if (p) p.collapsed = false;
  activate(tab.id);
  startTab(tab);
});

// ---------- import existing sessions ----------
let candidates = [];
$('#btn-import').addEventListener('click', async () => {
  $('#imp-list').innerHTML = ''; $('#imp-hint').textContent = '掃描現有的 cmd / PowerShell 視窗與 Claude 歷史 session…（約 2~5 秒）';
  $('#dlg-import').showModal();
  candidates = await api.scanImport();
  const have = new Set(state.tabs.map(t => trimPath(t.cwd)));
  const groups = [['running', '正在執行的視窗'], ['history', 'Claude 歷史 session（近 45 天，每個資料夾取最新一筆）']];
  let html = '';
  candidates.forEach((c, i) => { c.exists = have.has(trimPath(c.cwd)); c.i = i; });
  for (const [src, label] of groups) {
    const rows = candidates.filter(c => c.source === src);
    if (!rows.length) continue;
    html += `<h4>${label} (${rows.length})</h4>` + rows.map(c =>
      `<label><input type="checkbox" data-i="${c.i}" ${c.exists ? '' : (src === 'running' && c.agent !== 'shell' ? 'checked' : '')}>` +
      `<span class="t"><b>${esc(baseName(c.cwd))}</b> <span class="tag">${esc(AGENTS[c.agent]?.label || c.agent)}</span>` +
      (c.exists ? ' <span class="tag have">已在清單</span>' : '') + `<div>${esc(c.cwd)}${c.sessionId ? ' · ' + c.sessionId.slice(0, 8) : ''}</div></span>` +
      `<span class="ago">${ago(c.lastActive)}</span></label>`).join('');
  }
  $('#imp-list').innerHTML = html || '<h4>沒有找到可匯入的項目</h4>';
  $('#imp-hint').textContent = `找到 ${candidates.length} 項。已預先勾選正在跑 agent 的視窗；匯入後請關掉舊視窗，避免同一個 session 被兩邊同時操作。`;
});
$('#imp-cancel').addEventListener('click', () => $('#dlg-import').close());
$('#imp-all').addEventListener('click', () => {
  const boxes = [...document.querySelectorAll('#imp-list input')];
  const on = boxes.some(b => !b.checked);
  boxes.forEach(b => { b.checked = on; });
});
$('#imp-ok').addEventListener('click', () => {
  const picked = [...document.querySelectorAll('#imp-list input:checked')].map(b => candidates[+b.dataset.i]);
  const added = [];
  for (const c of picked) {
    const preset = AGENTS[c.agent] || AGENTS.shell;
    const tab = {
      id: crypto.randomUUID(), title: baseName(c.cwd), cwd: c.cwd, agent: c.agent in AGENTS ? c.agent : 'shell',
      startCmd: preset.start, resumeCmd: preset.resume, autoRun: true, color: '', projectId: '', fontSize: 0,
      launched: c.agent !== 'shell',            // these sessions already exist -> go straight to resume
      lastActive: c.lastActive,
    };
    if (c.agent === 'claude' && c.sessionId) tab.resumeCmd = `claude --resume ${c.sessionId}`;
    state.tabs.push(tab); added.push(tab);
  }
  $('#dlg-import').close();
  if (!added.length) return;
  activate(added[0].id);
  (async () => { for (const t of added) { startTab(t); await new Promise(r => setTimeout(r, state.settings.staggerMs ?? 400)); } })();
});

// ---------- shortcuts ----------
window.addEventListener('keydown', e => {
  const order = orderedTabs().map(t => t.id);
  const inView = state.view.ids.length > 1;
  const cycle = inView ? state.view.ids : order;
  const cur = cycle.indexOf(state.activeId);
  let handled = true;
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 't') openDialog();
  else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'w') { const t = tabById(state.activeId); if (t) closeTab(t); }
  else if (e.ctrlKey && e.key === 'Tab' && cycle.length) {
    const next = cycle[(cur + (e.shiftKey ? -1 : 1) + cycle.length) % cycle.length];
    if (inView) focusPane(next); else activate(next);
  }
  else if (e.ctrlKey && !e.altKey && (e.key === '=' || e.key === '+')) zoomTab(tabById(state.activeId), 1);
  else if (e.ctrlKey && !e.altKey && (e.key === '-' || e.key === '_')) zoomTab(tabById(state.activeId), -1);
  else if (e.ctrlKey && !e.altKey && e.key === '0') zoomTab(tabById(state.activeId), 0, true);
  else if (e.ctrlKey && !e.shiftKey && e.key === 'b') toggleSide();
  else if (e.key === 'F2' && state.activeId) renameTab(tabById(state.activeId));
  else if (e.altKey && /^[1-9]$/.test(e.key) && order[+e.key - 1]) activate(order[+e.key - 1]);
  else handled = false;
  if (handled) { e.preventDefault(); e.stopPropagation(); }
}, true);

// ---------- boot ----------
$('#btn-all').addEventListener('click', () => startAll(0));
async function startAll(stagger) {
  // visible tabs first so you can start typing immediately, the rest are staggered to avoid a CPU/IO spike
  const vis = id => (state.view.ids.includes(id) ? 0 : 1);
  const order = [...state.tabs].sort((a, b) => vis(a.id) - vis(b.id));
  for (const t of order) {
    if (terms.get(t.id)?.status === 'running') continue;
    ensureTerm(t);
    startTab(t);
    if (stagger) await new Promise(r => setTimeout(r, stagger));
  }
}

(async function boot() {
  AGENTS = await api.getAgents();
  $('#f-agent').innerHTML = Object.entries(AGENTS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
  state = await api.loadState();
  // every launch starts at 100%: zoom is per session, so a size saved earlier never sticks
  for (const t of state.tabs) t.fontSize = 0;
  const auto = $('#autostart');
  auto.checked = await api.getAutostart();
  auto.addEventListener('change', async () => { auto.checked = await api.setAutostart(auto.checked); });
  for (const t of state.tabs) ensureTerm(t);
  applyView();
  document.body.classList.toggle('side-collapsed', !!state.settings.sideCollapsed);
  renderRail();
  if (state.settings.startup !== 'lazy') startAll(state.settings.staggerMs ?? 400);
})();

// ---------- sidebar nav: gliding hover highlight + summary line ----------
const glideEl = () => $('#glide');
function moveGlide(row) {
  const g = glideEl(); if (!g) return;
  if (!row) { g.classList.remove('on'); return; }
  // measured against the scrolling list itself, so it stays correct while the list is scrolled
  const box = $('#tabs'), top = row.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
  g.style.transform = `translateY(${top}px)`;
  g.style.height = `${row.getBoundingClientRect().height}px`;
  g.classList.add('on');
}
$('#tabs').addEventListener('pointerover', e => {
  const row = e.target.closest('#tabs > .tab, #tabs > .proj');
  if (row) moveGlide(row);
});
$('#tabs').addEventListener('mouseleave', () => moveGlide(null));

function renderSummary() {
  const el = $('#side-sum'); if (!el) return;
  const all = state.tabs.length;
  const need = state.tabs.filter(t => ['asking', 'error'].includes(terms.get(t.id)?.state)).length;
  const working = state.tabs.filter(t => terms.get(t.id)?.state === 'working').length;
  el.innerHTML = `<span><b>${all}</b> 張卡片</span>` +
    (working ? `<span><b>${working}</b> 工作中</span>` : '') +
    (need ? `<span class="need">${need} 需要你</span>` : '');
}
