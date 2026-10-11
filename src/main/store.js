'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AGENTS } = require('./agents');

const VERSION = 1;
const defaults = () => ({
  version: VERSION,
  activeId: null,
  projects: [],
  view: { ids: [], layout: 'auto', cols: [], rows: [] },
  settings: { startup: 'all', staggerMs: 400, shell: 'auto', fontSize: 14 },
  tabs: [],
});

const validColor = c => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : '');
const baseName = p => p.split(/[\\/]+/).filter(Boolean).pop() || p;

function newTab(partial = {}) {
  const agent = AGENTS[partial.agent] ? partial.agent : 'shell';
  const preset = AGENTS[agent];
  return {
    id: partial.id || crypto.randomUUID(),
    title: partial.title || (partial.cwd ? baseName(partial.cwd) : 'untitled'),
    cwd: partial.cwd || '',
    agent,
    startCmd: partial.startCmd ?? preset.start,
    resumeCmd: partial.resumeCmd ?? preset.resume,
    autoRun: partial.autoRun !== false,
    color: validColor(partial.color),
    projectId: partial.projectId || '',
    fontSize: Number.isFinite(partial.fontSize) ? Math.min(40, Math.max(8, Math.round(partial.fontSize))) : 0, // 0 = default size
    launched: !!partial.launched,   // true once the start command has run at least once
    lastActive: partial.lastActive || 0,
    central: !!partial.central,     // the pinned central card (at most one)
  };
}

function normalize(raw) {
  const s = defaults();
  if (!raw || typeof raw !== 'object') return s;
  Object.assign(s.settings, raw.settings || {});
  s.projects = (Array.isArray(raw.projects) ? raw.projects : []).filter(p => p && p.id).map(p => ({
    id: String(p.id), name: String(p.name || '專案'), color: validColor(p.color), collapsed: !!p.collapsed,
  }));
  s.tabs = (Array.isArray(raw.tabs) ? raw.tabs : []).filter(t => t && t.cwd !== undefined).map(newTab);
  for (const t of s.tabs) if (t.projectId && !s.projects.some(p => p.id === t.projectId)) t.projectId = '';
  // one central card: older versions marked it only by its title
  let central = s.tabs.find(t => t.central) || s.tabs.find(t => t.title === '中控' && /--mcp-config/.test(t.resumeCmd));
  for (const t of s.tabs) t.central = t === central;
  if (central) central.projectId = '';
  s.activeId = s.tabs.some(t => t.id === raw.activeId) ? raw.activeId : (s.tabs[0]?.id ?? null);
  const layout = typeof raw.view?.layout === 'string' && /^[A-Za-z0-9-]{1,24}$/.test(raw.view.layout) ? raw.view.layout : 'auto';
  const fr = a => (Array.isArray(a) && a.length > 0 && a.length <= 12 && a.every(x => Number.isFinite(x) && x > 0) ? a : []);
  const ids = (Array.isArray(raw.view?.ids) ? raw.view.ids : []).filter(id => s.tabs.some(t => t.id === id)).slice(0, 9);
  if (!ids.includes(s.activeId) && s.activeId) ids.unshift(s.activeId);
  s.view = { ids: ids.slice(0, 9), layout, cols: fr(raw.view?.cols), rows: fr(raw.view?.rows) };
  return s;
}

function load(file) {
  for (const f of [file, file + '.bak']) {
    try { return normalize(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch { /* try next */ }
  }
  return defaults();
}

// Atomic write: a crash/power loss mid-save must never corrupt the workspace.
function save(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  try { fs.copyFileSync(file, file + '.bak'); } catch { /* first save */ }
  fs.renameSync(tmp, file);
}

module.exports = { defaults, newTab, normalize, load, save };
