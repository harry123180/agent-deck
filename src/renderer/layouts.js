'use strict';
// Split-view layout templates. A template is a CSS-grid description:
//   areas: matrix of pane names ("p1".."pN"), cols/rows: relative track sizes (fr).
// Users can switch templates and drag the dividers (which only changes cols/rows).
(function (root) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const lcm = (a, b) => (a * b) / gcd(a, b);
  const mk = (id, label, areas, cols, rows) => ({
    id, label, areas,
    cols: cols || Array(areas[0].length).fill(1),
    rows: rows || Array(areas.length).fill(1),
  });
  const capacity = t => new Set(t.areas.flat()).size;
  const key = t => JSON.stringify([t.areas, t.cols, t.rows]);

  // n panes in c columns; a short last row is stretched to fill the full width
  function gridAreas(n, c) {
    const rows = Math.ceil(n / c);
    const k = n - c * (rows - 1);
    const m = lcm(c, k);
    const out = [];
    let idx = 1;
    for (let r = 0; r < rows; r++) {
      const cnt = r === rows - 1 ? k : c;
      const row = [];
      for (let j = 0; j < cnt; j++) { for (let s = 0; s < m / cnt; s++) row.push('p' + idx); idx++; }
      out.push(row);
    }
    return out;
  }

  const gridLabel = (n, c) => (c === 1 ? '上下堆疊' : c === n ? '左右並排' : `${c} 欄格狀`);

  // All templates that fit exactly n panes. The first one is the "auto" default.
  function templatesFor(n) {
    n = Math.max(1, Math.min(9, n | 0));
    if (n === 1) return [mk('single', '單一滿版', [['p1']])];
    const def = n <= 4 ? 2 : 3;
    const cs = [def, ...[1, 2, 3, 4, n].filter(c => c <= n && c !== def)];
    const list = cs.map(c => mk('g' + c, gridLabel(n, c), gridAreas(n, c)));
    const extra = [];
    if (n === 2) extra.push(mk('lr-21', '左大右小', [['p1', 'p2']], [2, 1]), mk('lr-12', '左小右大', [['p1', 'p2']], [1, 2]),
      mk('tb-21', '上大下小', [['p1'], ['p2']], [1], [2, 1]));
    if (n === 3) extra.push(mk('L1R2', '左 1 右 2', [['p1', 'p2'], ['p1', 'p3']]), mk('L2R1', '左 2 右 1', [['p1', 'p3'], ['p2', 'p3']]),
      mk('T1B2', '上 1 下 2', [['p1', 'p1'], ['p2', 'p3']]), mk('L21R1', '左大 2 右 1', [['p1', 'p3'], ['p2', 'p3']], [2, 1]));
    if (n === 4) extra.push(mk('main-r3', '左大右 3', [['p1', 'p2'], ['p1', 'p3'], ['p1', 'p4']], [2, 1]),
      mk('main-b3', '上大下 3', [['p1', 'p1', 'p1'], ['p2', 'p3', 'p4']], [1, 1, 1], [2, 1]));
    if (n === 5) extra.push(mk('main-r4', '左大右 4', [['p1', 'p2', 'p3'], ['p1', 'p4', 'p5']], [2, 1, 1]));
    const seen = new Set();
    return [list[0], ...extra, ...list.slice(1)].filter(t => { const k = key(t); if (seen.has(k)) return false; seen.add(k); return true; });
  }

  // Resolve the stored layout id ('auto' or a template id) for n panes.
  function resolve(n, layoutId) {
    const list = templatesFor(n);
    return list.find(t => t.id === layoutId) || list[0];
  }

  // Track sizes: user-dragged fractions win when they still match the template's track count.
  const tracks = (custom, def) => (Array.isArray(custom) && custom.length === def.length ? custom : def);

  // Divider segments to draw. Only where the two neighbouring cells belong to different panes,
  // so a divider never cuts through a pane that spans several tracks.
  function gutters(tpl) {
    const out = [];
    const R = tpl.areas.length, C = tpl.areas[0].length;
    for (let i = 0; i < C - 1; i++) {
      let start = -1;
      for (let j = 0; j <= R; j++) {
        const diff = j < R && tpl.areas[j][i] !== tpl.areas[j][i + 1];
        if (diff && start < 0) start = j;
        if (!diff && start >= 0) { out.push({ axis: 'col', index: i, from: start, to: j }); start = -1; }
      }
    }
    for (let i = 0; i < R - 1; i++) {
      let start = -1;
      for (let j = 0; j <= C; j++) {
        const diff = j < C && tpl.areas[i][j] !== tpl.areas[i + 1][j];
        if (diff && start < 0) start = j;
        if (!diff && start >= 0) { out.push({ axis: 'row', index: i, from: start, to: j }); start = -1; }
      }
    }
    return out;
  }

  // Move the divider between track i and i+1 by `delta` fr, keeping the sum and a minimum size.
  function drag(sizes, i, delta) {
    const total = sizes.reduce((a, b) => a + b, 0);
    const min = Math.max(0.1, total * 0.08);
    const a = sizes[i], b = sizes[i + 1];
    const d = Math.max(min - a, Math.min(b - min, delta));
    const out = sizes.slice();
    out[i] = a + d; out[i + 1] = b - d;
    return out;
  }

  const api = { templatesFor, resolve, tracks, gutters, drag, capacity, gridAreas };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Layouts = api;
})(typeof window !== 'undefined' ? window : globalThis);
