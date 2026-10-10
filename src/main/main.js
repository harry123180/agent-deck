'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync, execFile } = require('child_process');
const pty = require('node-pty');
const store = require('./store');
const importer = require('./importer');
const sessions = require('./sessions');
const { nearestExisting } = require('./paths');
const { AGENTS } = require('./agents');
const { createBus } = require('./bus');
const ccmsg = require('./ccmsg');
const { wireCommand, opencodeEnv, launcherScript } = require('./wire');

const STATE_FILE = () => path.join(app.getPath('userData'), 'state.json');
const ptys = new Map(); // tab id -> IPty
let win = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function findShell(pref) {
  if (pref && pref !== 'auto') return pref;
  for (const exe of ['pwsh.exe', 'powershell.exe']) {
    try { execFileSync('where', [exe], { stdio: 'ignore' }); return exe; } catch { /* next */ }
  }
  return process.env.ComSpec || 'cmd.exe';
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, backgroundColor: '#12141a', title: 'Agent Deck', icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.on('before-input-event', (e, i) => {
    if (i.type === 'keyDown' && i.control && i.shift && i.key.toUpperCase() === 'I') win.webContents.toggleDevTools();
  });
  win.on('closed', () => { win = null; });
}

ipcMain.handle('import:scan', () => importer.scan([...ptys.values()].map(p => p.pid)));
ipcMain.handle('sessions:list', async (_e, agent, cwd) => {
  const list = await sessions.list(agent, cwd);
  const cmd = sessions.RESUME[agent];
  return list.map(s => ({ ...s, command: cmd ? cmd(s.id) : '' }));
});
ipcMain.handle('agents:get', () => AGENTS);

// What to paste into a terminal card: text (Electron), or — for files copied in Explorer and screenshots —
// Windows PowerShell reads the clipboard (this Electron build cannot read those formats). Screenshots are saved to a temp PNG.
const quotePath = p => (/[\s'"&()]/.test(p) ? `"${p.replace(/"/g, '')}"` : p);
function clipboardNonText(dir) {
  return new Promise(resolve => {
    const script = [
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
      '$files = Get-Clipboard -Format FileDropList',
      'if ($files) { $files | ForEach-Object { $_.FullName }; exit 0 }',
      'if ([System.Windows.Forms.Clipboard]::ContainsImage()) {',
      `  New-Item -ItemType Directory -Force -Path '${dir.replace(/'/g, "''")}' | Out-Null`,
      `  $p = Join-Path '${dir.replace(/'/g, "''")}' ('paste-' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss-fff') + '.png')`,
      '  [System.Windows.Forms.Clipboard]::GetImage().Save($p, [System.Drawing.Imaging.ImageFormat]::Png)',
      '  $p',
      '}',
    ].join('; ');
    execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { timeout: 8000, encoding: 'utf8', windowsHide: true },
      (err, stdout) => resolve(err ? [] : String(stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean)));
  });
}
ipcMain.handle('clipboard:paste', async () => {
  try {
    const text = await clipboard.readText();
    if (typeof text === 'string' && text) return { text };
    const items = await clipboardNonText(path.join(os.tmpdir(), 'agent-deck', 'paste'));
    if (items.length) return { text: items.map(quotePath).join(' ') };
  } catch (err) {
    console.error('clipboard paste failed:', err && err.message);
  }
  return { text: '' };
});

ipcMain.handle('state:load', () => store.load(STATE_FILE()));
// Central status board: every few seconds the renderer sends a snapshot of all cards; it is written to a
// Markdown file (and JSON) that the central agent reads.
const CENTRAL_DIR = () => path.join(app.getPath('userData'), 'central');
const BUS_FILE = () => path.join(app.getPath('userData'), 'bus.json');
const MCP_SERVER = path.join(__dirname, '..', 'bus', 'mcp-server.js');
const LAUNCHER = () => path.join(CENTRAL_DIR(), 'agentdeck-mcp.cmd');
// MCP config any agent CLI can load to reach the bus. Runs on Electron's own Node, so no separate Node install is needed.
function mcpServerSpec() {
  return { command: process.execPath, args: [MCP_SERVER], env: { ELECTRON_RUN_AS_NODE: '1', AGENT_DECK_BUS: BUS_FILE() } };
}
function writeMcpConfig() {
  const dir = CENTRAL_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { agentdeck: mcpServerSpec() } }, null, 2));
  fs.writeFileSync(LAUNCHER(), launcherScript({ electron: process.execPath, server: MCP_SERVER, busFile: BUS_FILE() }));
  return file;
}
// Which process started which: needed to tell which Claude session belongs to which card (the session's claude.exe
// runs under the card's shell). Cached briefly; one CIM query covers all processes.
let treeCache = { at: 0, parent: new Map() };
function processParents() {
  if (Date.now() - treeCache.at < 3000) return Promise.resolve(treeCache.parent);
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'],
      { timeout: 10000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
        const parent = new Map();
        if (!err) for (const line of String(stdout).split(/\r?\n/)) { const [a, b] = line.trim().split(/\s+/).map(Number); if (a) parent.set(a, b); }
        treeCache = { at: Date.now(), parent };
        resolve(parent);
      });
  });
}
const descends = (pid, ancestor, parent) => { for (let i = 0, p = pid; i < 8 && p; i++) { p = parent.get(p); if (p === ancestor) return true; } return false; };
const nativeLane = {
  async sessionForCard(card) {
    const shell = ptys.get(card.id)?.pid;
    if (!shell) return null;
    const parent = await processParents();
    return ccmsg.listSessions().find(s => descends(s.pid, shell, parent)) || null;
  },
  async externals() {
    const parent = await processParents();
    const shells = [...ptys.values()].map(p => p.pid);
    return ccmsg.listSessions().filter(s => !shells.some(sh => descends(s.pid, sh, parent)));
  },
  send: (session, text) => ccmsg.sendToSession(session, text),
};
let claudeLaneSetting = 'native';
const bus = createBus({
  native: nativeLane,
  claudeLane: () => claudeLaneSetting,
  file: null,   // written once the app is ready (userData path)
  writeToCard: (id, text, enter) => {
    const p = ptys.get(id);
    if (!p) return false;
    p.write(text);
    setTimeout(() => { if (ptys.get(id) === p) p.write(enter); }, 150);   // let the TUI take the paste before Enter
    return true;
  },
});
ipcMain.on('status:publish', (_e, cards, opts) => {
  if (opts && (opts.claudeLane === 'paste' || opts.claudeLane === 'native')) claudeLaneSetting = opts.claudeLane;
  bus.updateCards(Array.isArray(cards) ? cards : []);
  try {
    const dir = CENTRAL_DIR();
    fs.mkdirSync(dir, { recursive: true });
    const list = Array.isArray(cards) ? cards.slice(0, 200) : [];
    const stamp = new Date().toLocaleString();
    const md = [
      '# Agent Deck 狀態看板',
      `更新時間：${stamp}（每 3 秒自動更新）`,
      '',
      '| 卡片 | 專案 | 狀態 | Agent | 資料夾 |',
      '|---|---|---|---|---|',
      ...list.map(c => `| ${c.title} | ${c.project || '—'} | ${c.stateLabel} | ${c.agent} | ${c.cwd} |`),
      '',
      ...list.flatMap(c => [
        `## ${c.title}（${c.stateLabel}）`,
        '```',
        (c.tail || '').split('\n').slice(-15).join('\n').trimEnd() || '(沒有輸出)',
        '```',
        '',
      ]),
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'status.md'), md, 'utf8');
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ updatedAt: stamp, cards: list }, null, 2), 'utf8');
  } catch (err) { console.error('status publish failed', err && err.message); }
});
ipcMain.handle('central:dir', () => CENTRAL_DIR());
ipcMain.handle('bus:mcpConfig', () => writeMcpConfig());
ipcMain.handle('bus:serverSpec', () => mcpServerSpec());

ipcMain.on('state:save', (_e, state) => { try { store.save(STATE_FILE(), state); } catch (err) { console.error('save failed', err); } });
ipcMain.handle('dialog:folder', async (_e, start) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: nearestExisting(start) });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('autostart:get', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('autostart:set', (_e, on) => { app.setLoginItemSettings({ openAtLogin: !!on }); return app.getLoginItemSettings().openAtLogin; });

ipcMain.handle('pty:spawn', (_e, { id, cwd, cols, rows, command, shell, title, agent, central }) => {
  // every card's agent gets the agentdeck tools (bus); only the central card has them pre-approved
  command = wireCommand(command, { agent, title, central: !!central, mcpConfigFile: path.join(CENTRAL_DIR(), 'mcp.json'), launcher: LAUNCHER() });
  const spec = mcpServerSpec();
  const ocEnv = opencodeEnv(process.env.OPENCODE_CONFIG_CONTENT, { ...spec, title: title || id });
  if (ptys.has(id)) return { ok: true, reused: true };
  let warn = '';
  let dir = cwd;
  if (!dir || !fs.existsSync(dir)) { warn = `Path not found: ${cwd || '(empty)'} — opened in home folder instead.`; dir = os.homedir(); }
  const exe = findShell(shell);
  const args = /powershell|pwsh/i.test(exe) ? ['-NoLogo'] : [];
  let p;
  try {
    p = pty.spawn(exe, args, {
      name: 'xterm-256color', cols: cols || 120, rows: rows || 30, cwd: dir,
      // AGENT_DECK_CARD / AGENT_DECK_BUS let an agent in this card that loads the agentdeck MCP server know who it is
      env: { ...process.env, COLORTERM: 'truecolor', TERM_PROGRAM: 'agent-deck', AGENT_DECK_CARD: String(title || id), AGENT_DECK_BUS: BUS_FILE(), OPENCODE_CONFIG_CONTENT: ocEnv }, useConpty: true,
    });
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
  ptys.set(id, p);
  // a pty that was killed and replaced (restart) must not feed its old output or exit into the new one
  p.onData(d => { p.lastOutAt = Date.now(); if (ptys.get(id) === p && win && !win.isDestroyed()) win.webContents.send('pty:data', id, d); });
  p.onExit(({ exitCode }) => {
    const current = ptys.get(id) === p;
    if (current) ptys.delete(id);
    if (current && win && !win.isDestroyed()) win.webContents.send('pty:exit', id, exitCode);
  });
  if (command) setTimeout(() => { if (ptys.get(id) === p) p.write(command + '\r'); }, 500);
  return { ok: true, warn };
});
ipcMain.on('pty:write', (_e, id, data) => ptys.get(id)?.write(data));
ipcMain.on('pty:resize', (_e, id, cols, rows) => { try { ptys.get(id)?.resize(Math.max(2, cols), Math.max(1, rows)); } catch { /* pty gone */ } });
ipcMain.on('pty:kill', (_e, id) => { const p = ptys.get(id); ptys.delete(id); try { p?.kill(); } catch { /* already dead */ } });

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  try {
    const info = await bus.start();
    fs.writeFileSync(BUS_FILE(), JSON.stringify(info, null, 2));
    writeMcpConfig();
  } catch (err) { console.error('agent bus failed to start', err && err.message); }
  createWindow();
});
app.on('will-quit', () => { bus.stop(); try { fs.unlinkSync(BUS_FILE()); } catch { /* already gone */ } });
// Closing mid-conversation used to kill every shell outright, so Claude Code never flushed the transcript and the
// next resume found nothing. Ask each agent to exit normally first (Ctrl+C twice), give it time to save, then kill.
let quitting = false;
app.on('before-quit', e => {
  if (quitting || ptys.size === 0) return;
  e.preventDefault();
  quitting = true;
  const live = [...ptys.values()];
  // wait until the agents stop printing (a reply still being written would be cut off), but never longer than 8s
  const t0 = Date.now();
  const quiet = () => live.every(p => Date.now() - (p.lastOutAt || 0) > 1500) || Date.now() - t0 > 8000;
  const finish = () => {
    for (const p of live) { try { p.kill(); } catch { /* ignore */ } }
    ptys.clear();
    app.quit();
  };
  const exitAll = () => {
    for (const p of live) { try { p.write('\x03'); } catch { /* already gone */ } }
    setTimeout(() => { for (const p of live) { try { p.write('\x03'); } catch { /* already gone */ } } }, 400);
    setTimeout(finish, 2500);
  };
  const wait = () => (quiet() ? exitAll() : setTimeout(wait, 300));
  wait();
});
app.on('window-all-closed', () => app.quit());
