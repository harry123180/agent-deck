'use strict';
const fs = require('fs');
const path = require('path');

// Where the folder picker should open: `start` if it is a folder, otherwise its nearest existing parent.
function nearestExisting(start) {
  if (!start || typeof start !== 'string') return undefined;
  let dir = path.normalize(start.replace(/^"|"$/g, '').trim());
  for (let i = 0; i < 64 && dir; i++) {
    try { if (fs.statSync(dir).isDirectory()) return dir; } catch { /* keep walking up */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const clean = p => (typeof p === 'string' ? p.replace(/^"|"$/g, '').trim() : '');
// a full path only (D:\x or \\server\share\x): a relative one would land wherever the app happens to run
const absolute = p => path.isAbsolute(p) && (process.platform !== 'win32' || /^([a-z]:[\\/]|\\\\)/i.test(p));

// What a typed card folder is: 'dir', 'missing' (can be created), 'file', or 'invalid'.
function folderState(p) {
  p = clean(p);
  if (!p || !absolute(p)) return 'invalid';
  try { return fs.statSync(p).isDirectory() ? 'dir' : 'file'; } catch { return 'missing'; }
}

// Create a card folder (and its missing parents). Returns the normalized path.
function makeFolder(p) {
  const state = folderState(p);
  if (state === 'invalid') throw new Error('請輸入完整路徑，例如 D:\\repos\\my-project');
  if (state === 'file') throw new Error('這個路徑是一個檔案，不是資料夾');
  const dir = path.normalize(clean(p));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { nearestExisting, folderState, makeFolder };
