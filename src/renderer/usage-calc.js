'use strict';
// Pure aggregation of `ccusage daily --instances --json` / `ccusage blocks --active --json` output
// for the "Token用量" panel. No DOM here so it can be unit-tested.
(function (root) {
  const encode = cwd => String(cwd || '').replace(/[^A-Za-z0-9]/g, '-');   // how Claude Code names a project folder
  const pad = n => String(n).padStart(2, '0');
  const dateKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const tail = key => key.split('-').filter(Boolean).slice(-2).join('/') || key;

  // last `n` calendar days ending today, oldest first
  function lastDays(n, now) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) out.push(dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
    return out;
  }

  /**
   * daily:    ccusage `daily --instances --json` ({ projects: { <encodedDir>: [ {date,totalCost,totalTokens,modelBreakdowns...} ] } })
   * tabs:     Agent Deck cards  [{ title, cwd, projectId }]
   * projects: Agent Deck project groups [{ id, name }]
   */
  function summarize(daily, { tabs = [], projects = [], now = new Date(), days = 30 } = {}) {
    const dayList = lastDays(days, now);
    const inRange = new Set(dayList);
    const byKey = new Map();                         // repo key -> aggregate
    const models = new Map();
    const perDay = new Map(dayList.map(d => [d, { date: d, cost: 0, tokens: 0, byRepo: {} }]));

    for (const [key, entries] of Object.entries((daily && daily.projects) || {})) {
      for (const e of entries || []) {
        if (!inRange.has(e.date)) continue;
        const cost = Number(e.totalCost) || 0, tokens = Number(e.totalTokens) || 0;
        let r = byKey.get(key);
        if (!r) byKey.set(key, (r = { key, cost: 0, tokens: 0, last: '', days: {} }));
        r.cost += cost; r.tokens += tokens; r.days[e.date] = (r.days[e.date] || 0) + cost;
        if (e.date > r.last) r.last = e.date;
        const d = perDay.get(e.date);
        d.cost += cost; d.tokens += tokens; d.byRepo[key] = (d.byRepo[key] || 0) + cost;
        for (const m of e.modelBreakdowns || []) {
          const mm = models.get(m.modelName) || { name: m.modelName, cost: 0, tokens: 0 };
          mm.cost += Number(m.cost) || 0;
          mm.tokens += (m.inputTokens || 0) + (m.outputTokens || 0) + (m.cacheCreationTokens || 0) + (m.cacheReadTokens || 0);
          models.set(m.modelName, mm);
        }
      }
    }

    // map every repo key to the cards that live in that folder
    const cardsByKey = new Map();
    for (const t of tabs) {
      const k = encode(t.cwd);
      if (!cardsByKey.has(k)) cardsByKey.set(k, []);
      cardsByKey.get(k).push(t);
    }
    const repos = [...byKey.values()].map(r => {
      const cards = cardsByKey.get(r.key) || [];
      const cwd = cards[0]?.cwd;
      return { ...r, name: cwd ? (cwd.split(/[\\/]+/).filter(Boolean).pop() || cwd) : tail(r.key), cwd: cwd || '', matched: cards.length > 0 };
    }).sort((a, b) => b.cost - a.cost);

    // by Agent Deck project group: sum the repo folders its cards use (a folder counts once per group)
    const groups = [];
    const used = new Set();
    const addGroup = (id, name, keys) => {
      const rs = repos.filter(r => keys.has(r.key));
      if (!rs.length) return;
      rs.forEach(r => used.add(r.key));
      groups.push({ id, name, cost: rs.reduce((a, r) => a + r.cost, 0), tokens: rs.reduce((a, r) => a + r.tokens, 0), repos: rs });
    };
    for (const p of projects) {
      const keys = new Set(tabs.filter(t => t.projectId === p.id).map(t => encode(t.cwd)));
      addGroup(p.id, p.name, new Set([...keys].filter(k => !used.has(k))));
    }
    addGroup('', '未分組卡片', new Set(tabs.filter(t => !t.projectId).map(t => encode(t.cwd)).filter(k => !used.has(k))));
    addGroup('other', '其他資料夾（沒有對應卡片）', new Set(repos.filter(r => !used.has(r.key)).map(r => r.key)));
    groups.sort((a, b) => b.cost - a.cost);

    const dayArr = dayList.map(d => perDay.get(d));
    const sum = (arr, f) => arr.reduce((a, d) => a + d[f], 0);
    return {
      days: dayArr,
      repos, groups,
      models: [...models.values()].sort((a, b) => b.cost - a.cost),
      totals: {
        today: { cost: dayArr.at(-1).cost, tokens: dayArr.at(-1).tokens },
        week: { cost: sum(dayArr.slice(-7), 'cost'), tokens: sum(dayArr.slice(-7), 'tokens') },
        month: { cost: sum(dayArr, 'cost'), tokens: sum(dayArr, 'tokens') },
      },
    };
  }

  const money = v => (v >= 100 ? '$' + Math.round(v).toLocaleString('en-US') : '$' + v.toFixed(2));
  const compact = n => {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  };

  const api = { summarize, encode, lastDays, money, compact };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.UsageCalc = api;
})(typeof window !== 'undefined' ? window : globalThis);
