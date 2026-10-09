'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const pty = require('node-pty');
const store = require('./store');
const importer = require('./importer');
const sessions = require('./sessions');
const { nearestExisting } = require('./paths');
const { AGENTS } = require('./agents');

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
ipcMain.handle('state:load', () => store.load(STATE_FILE()));
ipcMain.on('state:save', (_e, state) => { try { store.save(STATE_FILE(), state); } catch (err) { console.error('save failed', err); } });
ipcMain.handle('dialog:folder', async (_e, start) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: nearestExisting(start) });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('autostart:get', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('autostart:set', (_e, on) => { app.setLoginItemSettings({ openAtLogin: !!on }); return app.getLoginItemSettings().openAtLogin; });

ipcMain.handle('pty:spawn', (_e, { id, cwd, cols, rows, command, shell }) => {
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
      env: { ...process.env, COLORTERM: 'truecolor', TERM_PROGRAM: 'agent-deck' }, useConpty: true,
    });
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
  ptys.set(id, p);
  // a pty that was killed and replaced (restart) must not feed its old output or exit into the new one
  p.onData(d => { if (ptys.get(id) === p && win && !win.isDestroyed()) win.webContents.send('pty:data', id, d); });
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

app.whenReady().then(() => { Menu.setApplicationMenu(null); createWindow(); });
app.on('before-quit', () => { for (const p of ptys.values()) { try { p.kill(); } catch { /* ignore */ } } ptys.clear(); });
app.on('window-all-closed', () => app.quit());
