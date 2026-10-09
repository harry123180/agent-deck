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

module.exports = { nearestExisting };
