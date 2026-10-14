'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nearestExisting, folderState, makeFolder } = require('../src/main/paths');

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

assert.strictEqual(folderState(sub), 'dir');
assert.strictEqual(folderState(path.join(dir, 'file.txt')), 'file');
assert.strictEqual(folderState(path.join(dir, 'new')), 'missing');
assert.strictEqual(folderState('relative\\folder'), 'invalid');
assert.strictEqual(folderState(''), 'invalid');
const made = makeFolder(`"${path.join(dir, 'new', 'deep')}"`);       // quotes stripped, parents created
same(made, path.join(dir, 'new', 'deep'));
assert.strictEqual(folderState(made), 'dir');
same(makeFolder(sub), sub);                                           // existing folder is fine
assert.throws(() => makeFolder(path.join(dir, 'file.txt')));
assert.throws(() => makeFolder('relative'));
fs.rmSync(dir, { recursive: true, force: true });
console.log('paths tests passed');
