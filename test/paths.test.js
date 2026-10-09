'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nearestExisting } = require('../src/paths');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-paths-'));
const sub = path.join(dir, 'proj', 'src');
fs.mkdirSync(sub, { recursive: true });
fs.writeFileSync(path.join(dir, 'file.txt'), 'x');
const same = (a, b) => assert.strictEqual(path.resolve(a).toLowerCase(), path.resolve(b).toLowerCase());

same(nearestExisting(sub), sub);                                      // existing folder -> itself
same(nearestExisting(sub.split(path.sep).join('/')), sub);                // forward slashes (as stored in state) are normalized
same(nearestExisting(`"${sub}"`), sub);                               // pasted with quotes
same(nearestExisting(path.join(sub, 'gone', 'deeper')), sub);         // missing -> nearest existing parent
same(nearestExisting(path.join(dir, 'file.txt')), dir);               // a file -> its folder
assert.strictEqual(nearestExisting(''), undefined);                   // nothing typed -> picker default
assert.strictEqual(nearestExisting(undefined), undefined);
assert.strictEqual(nearestExisting(42), undefined);
console.log('paths tests passed');
