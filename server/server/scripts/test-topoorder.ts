import { topoOrder } from '../src/util/planDeps';

// 旧实现（原样复制）作为等价对照
function oldTopoOrder(ids: string[], edges: Array<{ from: string; to: string }>): string[] {
  if (ids.length <= 1) return [...ids];
  const inSet = new Set(ids);
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of ids) { indeg.set(id, 0); adj.set(id, []); }
  for (const e of edges) {
    if (e.from === e.to || !inSet.has(e.from) || !inSet.has(e.to)) continue;
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  const out: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    out.push(id);
    for (const next of adj.get(id) ?? []) {
      const left = (indeg.get(next) ?? 1) - 1;
      indeg.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  if (out.length < ids.length) {
    const seen = new Set(out);
    for (const id of ids) if (!seen.has(id)) out.push(id);
  }
  return out;
}

let bad = 0;
let total = 0;
for (let seed = 0; seed < 2000; seed++) {
  const n = 1 + (seed % 9);
  const ids = Array.from({ length: n }, (_, i) => 'p' + i);
  const edges: { from: string; to: string }[] = [];
  const m = seed % 7;
  for (let k = 0; k < m; k++) {
    const a = ids[(seed * (k + 3) + k) % n];
    const b = ids[(seed * (k + 5) + 1) % n];
    edges.push({ from: a, to: b });
  }
  total++;
  const x = topoOrder(ids, edges).join(',');
  const y = oldTopoOrder(ids, edges).join(',');
  if (x !== y) {
    bad++;
    if (bad <= 3) console.log('DIFF', { ids, edges, x, y });
  }
}
console.log('等价性：' + (total - bad) + '/' + total + ' 一致');
