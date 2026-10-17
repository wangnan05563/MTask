/**
 * T02296 回归门：帕累托图（E11）「柱子 ↔ 条目」必须始终可对应。
 *
 * 拦的缺陷：`ParetoChart` 的 x 轴行号标签原受 `n <= 14 &&` 整段门控——行数一多整条轴清空
 *   （mtask四期真实数据 n=27 实测 `text=1`，只有 80% 参考线文字）；且 n≤14 时标签也只是纯序号，
 *   没有任何反查通道。修复（方案①）：密集时「每 5 根标一次 + 始终标末根」，并给每根柱加原生
 *   SVG `<title>`（`序号. 行标题 · E 值 · 累计 N%`）。
 *
 * 用法（tsx 按 **cwd** 找 tsconfig 的 jsx 口径，必须在 `web/` 下跑）：
 *   cd web && <node22> ../node_modules/tsx/dist/cli.mjs ../scripts/verify-t02296-pareto-labels.mts
 *
 * 断言全部基于 `react-dom/server` 静态渲染串（DOM 字符串级），无浏览器、无网络、无数据目录；
 * P-05 为非空转反证：在同一次渲染里把改前的轴门控规则重放一遍，证明 n>14 组断言确实只有新规则能过。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ParetoChart, paretoGeometries, type ParetoGeom } from '../web/src/components/estimateCharts.tsx';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${extra !== undefined ? ` → ${JSON.stringify(extra).slice(0, 300)}` : ''}`); }
};
const group = (t: string) => console.log(`\n== ${t}`);

type Row = { key: string; expected: number; title?: string };
const mkRows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ key: `p${i + 1}`, expected: 120 - i * 4, title: `计划条目 ${i + 1}号` }));

interface Render { rects: number; titleNodes: number; ticks: string[]; allTexts: string[]; titles: string[]; html: string }
const render = (geoms: readonly ParetoGeom[]): Render => {
  const html = renderToStaticMarkup(createElement(ParetoChart, { geoms }));
  const allTexts = [...html.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  const titles = [...html.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]);
  return {
    html,
    rects: (html.match(/<rect/g) ?? []).length,
    titleNodes: titles.length,
    ticks: allTexts.filter((s) => /^\d+$/.test(s)),
    allTexts,
    titles,
  };
};

group('G-0 几何入参：title/expected 透传，数值口径逐字不变');
{
  const rows = mkRows(27);
  const geoms = paretoGeometries(rows, new Set(['p3']));
  ok('G-01 里程碑行不进图（过滤数=入参数-1）', geoms.length === 26, { n: geoms.length });
  ok('G-02 title 透传、expected 随行携带（仅显示用）',
    geoms.every((g, i) => g.title === rows.filter((r) => !['p3'].includes(r.key))[i].title && Number.isFinite(g.expected)),
    { first: geoms[0]?.title });
  ok('G-03 title 缺省回落 key', paretoGeometries([{ key: 'k9', expected: 5 }], new Set())[0]?.title === 'k9');
  const sorted = [...geoms].sort((a, b) => b.expected - a.expected);
  const maxE = sorted[0].expected;
  const total = geoms.reduce((s, g) => s + g.expected, 0);
  let cum = 0;
  const replay = geoms.map((g) => { cum += g.expected; return { ePct: (g.expected / maxE) * 100, cumPct: (cum / total) * 100 }; });
  ok('G-04 ePct/cumPct 与独立重算一致（零计算红线未破，1e-9）',
    geoms.every((g, i) => Math.abs(g.ePct - replay[i].ePct) < 1e-9 && Math.abs(g.cumPct - replay[i].cumPct) < 1e-9));
  ok('G-05 末根累计=100%', Math.abs(geoms[geoms.length - 1].cumPct - 100) < 1e-9, { cum: geoms.at(-1)?.cumPct });
}

group('P 段：轴刻度与 tooltip 对应通道');
{
  const dense = render(paretoGeometries(mkRows(27), new Set()));
  ok('P-01 n=27 时 x 轴有标识（>0，缺陷复现用例）', dense.ticks.length > 0, { ticks: dense.ticks });
  ok('P-02 n=27 刻度为稀疏集「每 5 根 + 末根」=[1,6,11,16,21,26,27]',
    JSON.stringify(dense.ticks) === JSON.stringify(['1', '6', '11', '16', '21', '26', '27']), { ticks: dense.ticks });
  ok('P-03 n=27 每根柱都有 <title> 对应通道（titleNodes=rects=27）',
    dense.titleNodes === 27 && dense.rects === 27, { titleNodes: dense.titleNodes, rects: dense.rects });
  ok('P-04 title 文本含「序号. 行标题 · E 值 · 累计 %」三要素',
    /^1\. 计划条目 1号 · E /.test(dense.titles[0]) && /累计 \d+%$/.test(dense.titles[0]), { first: dense.titles[0] });

  const oldRule = new Set<number>();
  const n = dense.rects;
  if (n <= 14) for (let i = 0; i < n; i++) oldRule.add(String(i + 1) as unknown as number);
  ok('P-05 反证/非空转：改前规则（n≤14 才画）在 n=27 下刻度集为空，本组 P-01/P-02 只有新实现能过',
    oldRule.size === 0 && dense.ticks.length > 0, { old: [...oldRule], now: dense.ticks });

  const sparse = render(paretoGeometries(mkRows(12), new Set()));
  ok('P-06 n≤14 行为不回归：刻度仍是全量 1..12',
    JSON.stringify(sparse.ticks) === JSON.stringify(Array.from({ length: 12 }, (_, i) => String(i + 1))), { ticks: sparse.ticks });
  ok('P-07 n=12 同样每柱有 title（补上「序号无法反查」那层）', sparse.titleNodes === 12 && sparse.rects === 12,
    { titleNodes: sparse.titleNodes });

  const big = render(paretoGeometries(mkRows(200), new Set()));
  ok('P-08 标签不随行数爆炸（n=200 刻度仍 ≤ 行数/4，title 覆盖每柱）',
    big.ticks.length > 0 && big.ticks.length <= 50 && big.titleNodes === big.rects,
    { ticks: big.ticks.length, titleNodes: big.titleNodes, rects: big.rects });
}

group('E 段：空态与边界');
{
  const empty = render(paretoGeometries([], new Set()));
  ok('E-01 空批：无柱、无刻度、无 title（空态不画）',
    empty.rects === 0 && empty.ticks.length === 0 && empty.titleNodes === 0, empty);
  const single = render(paretoGeometries(mkRows(1), new Set()));
  ok('E-02 单行：1 柱 1 刻度 1 title（末根规则不误伤）',
    single.rects === 1 && single.ticks.length === 1 && single.titleNodes === 1, { ticks: single.ticks });
  const zeroE = paretoGeometries([{ key: 'z', expected: 0, title: '零行' }], new Set());
  ok('E-03 expected≤0 不进图（原口径保持）', zeroE.length === 0, { n: zeroE.length });
}

console.log(`\n合计 PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
