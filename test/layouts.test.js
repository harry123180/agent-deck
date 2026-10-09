'use strict';
const assert = require('assert');
const L = require('../src/renderer/layouts');

// every template for n panes holds exactly n panes, named p1..pn, and is rectangular
for (let n = 1; n <= 9; n++) {
  const list = L.templatesFor(n);
  assert.ok(list.length >= 1, `n=${n}`);
  const ids = new Set();
  for (const t of list) {
    assert.ok(!ids.has(t.id), `dup id ${t.id}`); ids.add(t.id);
    assert.strictEqual(L.capacity(t), n, `${t.id} capacity for n=${n}`);
    const names = new Set(t.areas.flat());
    for (let i = 1; i <= n; i++) assert.ok(names.has('p' + i), `${t.id} missing p${i}`);
    assert.ok(t.areas.every(r => r.length === t.areas[0].length), `${t.id} not rectangular`);
    assert.strictEqual(t.cols.length, t.areas[0].length);
    assert.strictEqual(t.rows.length, t.areas.length);
    // each pane's cells form a rectangle (CSS grid-areas must be rectangular)
    for (const nm of names) {
      const cells = []; t.areas.forEach((r, y) => r.forEach((v, x) => v === nm && cells.push([x, y])));
      const xs = cells.map(c => c[0]), ys = cells.map(c => c[1]);
      const w = Math.max(...xs) - Math.min(...xs) + 1, h = Math.max(...ys) - Math.min(...ys) + 1;
      assert.strictEqual(w * h, cells.length, `${t.id}/${nm} not a rectangle`);
    }
  }
}
// defaults
assert.deepStrictEqual(L.templatesFor(2)[0].areas, [['p1', 'p2']]);
assert.deepStrictEqual(L.templatesFor(3)[0].areas, [['p1', 'p2'], ['p3', 'p3']]);   // short last row stretched
assert.strictEqual(L.resolve(4, 'auto').id, 'g2');
assert.strictEqual(L.resolve(4, 'main-r3').id, 'main-r3');
assert.strictEqual(L.resolve(2, 'main-r3').id, 'g2');                                 // wrong-size id falls back to auto
// tracks: dragged sizes only apply when the track count still matches
assert.deepStrictEqual(L.tracks([3, 1], [1, 1]), [3, 1]);
assert.deepStrictEqual(L.tracks([3, 1, 1], [1, 1]), [1, 1]);
// gutters: 2 side-by-side => one vertical divider over the single row
assert.deepStrictEqual(L.gutters(L.resolve(2, 'g2')), [{ axis: 'col', index: 0, from: 0, to: 1 }]);
// left 1 / right 2: vertical divider spans both rows, horizontal one only the right column
const g = L.gutters(L.resolve(3, 'L1R2'));
assert.deepStrictEqual(g.find(x => x.axis === 'col'), { axis: 'col', index: 0, from: 0, to: 2 });
assert.deepStrictEqual(g.find(x => x.axis === 'row'), { axis: 'row', index: 0, from: 1, to: 2 });
// drag keeps sum and respects minimum
const d = L.drag([1, 1], 0, 0.5); assert.deepStrictEqual(d, [1.5, 0.5]);
const e = L.drag([1, 1], 0, 5); assert.ok(e[1] >= 0.15 && Math.abs(e[0] + e[1] - 2) < 1e-9);
const f = L.drag([1, 1], 0, -5); assert.ok(f[0] >= 0.15 && Math.abs(f[0] + f[1] - 2) < 1e-9);
console.log('layouts tests passed');
