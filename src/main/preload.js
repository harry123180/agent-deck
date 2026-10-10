'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deck', {
  getAgents: () => ipcRenderer.invoke('agents:get'),
  clipboardPaste: () => ipcRenderer.invoke('clipboard:paste'),
  listSessions: (agent, cwd) => ipcRenderer.invoke('sessions:list', agent, cwd),
  scanImport: () => ipcRenderer.invoke('import:scan'),
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: s => ipcRenderer.send('state:save', s),
  pickFolder: start => ipcRenderer.invoke('dialog:folder', start),
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: on => ipcRenderer.invoke('autostart:set', on),
  spawn: opts => ipcRenderer.invoke('pty:spawn', opts),
  write: (id, d) => ipcRenderer.send('pty:write', id, d),
  resize: (id, c, r) => ipcRenderer.send('pty:resize', id, c, r),
  kill: id => ipcRenderer.send('pty:kill', id),
  onData: cb => ipcRenderer.on('pty:data', (_e, id, d) => cb(id, d)),
  onExit: cb => ipcRenderer.on('pty:exit', (_e, id, code) => cb(id, code)),
});
