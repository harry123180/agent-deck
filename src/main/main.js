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

app.whenReady().then(() => { Menu.setApplicationMenu(null); createWindow(); });
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
