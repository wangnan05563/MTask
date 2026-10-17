/**
 * T02041（PRD-估算视图 §5.4 区间条 = P0）验证脚本：区间条几何的**归一口径**与「不含第二套算式」。
 *
 * 用法（与 verify-t02039/e4a 同写法，Node 版本要对齐 better-sqlite3 的预编译 ABI；
 *   C 段要渲染 JSX，**必须在 `web/` 下跑**——tsx 按 cwd 找 tsconfig 的 jsx 口径，见 verify-t02296 同注释）：
 *   cd web && <node22> ../node_modules/tsx/dist/cli.mjs ../scripts/verify-t02041-range.mts
 *
 * 两段结构：
 *   G 段（同进程·纯函数）：`whiskerGeometries()` 的取值域、归一基数、单调性、退化区间（O=P）、
 *     越界钳制，以及最关键的一条**篡改守卫**——把服务端 `rowRatios.expected` 换成任意值，
 *     区间条的 E 竖线必须跟着变。它证明 E 的位置来自服务端那一份，而不是前端又算了一遍 PERT。
 *   C 段（渲染产物）：把 `WhiskerBar` 用 `react-dom/server` 静态渲染成 DOM 串再断言——
 *     可访问图形（role/aria-label）、无几何不画节点、归一基数取自传入的那一份行集、
 *     建议行次级色 / 已落库行主色、四条线的顺序、色值只用 CSS 变量、
 *     tooltip 里的三点数值与基数、退化区间的最小可见宽度。
 *     （T02293 改判：这一段原来逐个正则匹配面板源码字面量，重构即恒红、删属性反而不红，
 *       判据与行为脱钩。面板侧接线由真机门用浏览器 DOM 守。）
 *
 * 真机走查（§10-1/2/13 三档视口、改值后条长跟变、筛选不改刻度、明暗双验、空项目不画图例）
 * 见 scripts/verify-t02041-ui.mjs。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PANEL_SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web/src/components/EstimatePanel.tsx'), 'utf8');
const T = '2026-10-11T00:00:00.000Z';
const PID = 'geom-e6';

let pass = 0; let fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra).toString().slice(0, 400)}` : ''}`);
  }
};

import { shimWebDocumentForNode } from './lib/web-dom-shim.mts';

// 面板模块取数逻辑是纯函数，但它 transitively import 了 `api/client.ts`（顶层从 document.baseURI
// 推 apiBase）——Node 侧没有 DOM，进门即 ReferenceError，整段断言都没机会跑。见 lib/web-dom-shim.mts。
shimWebDocumentForNode(39_899);
const P = await import('../web/src/components/EstimatePanel.tsx');

// ---- 行构造（与 e4a 同一套：已落库行 / 推导建议行 / 空行） ----
type Item = Parameters<typeof P.buildPanelRows>[1][number];
type Derive = Parameters<typeof P.buildPanelRows>[2][number];
type Ratio = Parameters<typeof P.buildPanelRows>[3][number];
const asPlan = (id: string, title: string, kind: string, complexity: number | null) => ({
  id, title, description: null, kind, start_date: '2026-10-12', end_date: '2026-10-12',
  duration_days: 3, progress: 0, status: 'todo', assignee: null, linked_task_id: null, complexity,
});
const mkItem = (planId: string, o: number, m: number, p: number, source = 'manual'): Item => ({
  id: `e-${planId}`, project_id: PID, plan_id: planId, phase: 'dev', unit: 'man_day',
  optimistic: o, likely: m, pessimistic: p, source, note: '', created_at: T, updated_at: T,
  planTitle: planId, planKind: 'normal', planArchived: 0, planStatus: 'todo', planProgress: 0,
  startDate: '2026-10-12', endDate: '2026-10-12', durationDays: 3, complexity: null,
}) as unknown as Item;
const mkDerive = (planId: string, o: number, m: number, p: number): Derive => ({
  planId, title: planId, kind: 'normal', phase: 'dev', rule: 'complexity',
  optimistic: o, likely: m, pessimistic: p, expected: (o + 4 * m + p) / 6,
  source: 'rule', note: '按复杂度推导', basis: {}, existing: null, writable: true, skip: '',
} as unknown as Derive);
const mkRatio = (key: string, expected: number, sigma: number): Ratio =>
  ({ key, expected, sigma }) as unknown as Ratio;

const plans = [
  asPlan('g-1', '小区间', 'normal', 1),
  asPlan('g-2', '最大 P 行', 'normal', 5),
  asPlan('g-3', '退化 O=P', 'normal', 2),
  asPlan('g-4', '仅有 M', 'normal', 2),
  asPlan('g-ms', '里程碑', 'milestone', 3),
];
const items = [mkItem('g-1', 1, 2, 3), mkItem('g-2', 4, 8, 16), mkItem('g-3', 6, 6, 6), mkItem('g-4', 2, 4, 6)];
const ratios = [mkRatio('g-1', 1.8333, 0.338), mkRatio('g-2', 9, 2), mkRatio('g-3', 6, 0), mkRatio('g-4', 4.6667, 1.33)];
const rows = P.buildPanelRows(plans as never, items, [], ratios, {});

console.log('\n=== G 段：区间条几何（同进程·纯函数） ===');
const geo = P.whiskerGeometries(rows);

ok('G-01 三点齐全的行才参与：4 行有几何（含 O=P 的退化行）', geo.size === 4, [...geo.keys()]);
ok('G-02 既无估算行又无推导建议的行（此处为里程碑行）不产生几何', !geo.has('g-ms'), { ms: geo.get('g-ms') ?? null });
{
  const emptyRows = P.buildPanelRows([asPlan('z', '空行', 'normal', null)], [], [], [], {});
  const zeroRow = P.buildPanelRows([asPlan('q', '全零行', 'normal', null)], [mkItem('q', 0, 0, 0)], [], [mkRatio('q', 0, 0)], {});
  const zq = P.whiskerGeometries(zeroRow).get('q');
  ok('G-02b 无三点无推导的行不产生几何；全零行不出现除零/NaN（基数兜底为 1）',
    P.whiskerGeometries(emptyRows).size === 0 && zq?.loPct === 0 && zq?.hiPct === 0 && zq?.scaleMax === 1,
    { empty: P.whiskerGeometries(emptyRows).size, zq });
}
{
  const g2 = geo.get('g-2');
  ok('G-03 归一基数=参与行的最大 P（16），最大 P 行的右端点贴满容器（100%）',
    g2?.scaleMax === 16 && g2?.hiPct === 100, g2);
  const g1 = geo.get('g-1');
  ok('G-04 各行共用同一基数（行间长度才可比）', g1?.scaleMax === 16 && geo.get('g-3')?.scaleMax === 16, { g1, g3: geo.get('g-3') });
  ok('G-05 百分比按值线性归一：O=1 → 6.25%，P=3 → 18.75%', g1?.loPct === 6.25 && g1?.hiPct === 18.75, g1);
}
{
  const bad = P.whiskerGeometries(P.buildPanelRows([asPlan('b', '乱序行', 'normal', null)],
    [mkItem('b', 9, 9, 2)], [], [mkRatio('b', 20, 1)], {}));
  const b = bad.get('b');
  ok('G-06 越界钳制在 [0,100]（服务端已保证 O≤M≤P，这里只防几何画出容器外）',
    !!b && b.loPct === 100 && b.hiPct === 100 && b.ePct === 100, b);
}
{
  const d = geo.get('g-3');
  ok('G-07 退化区间 O=P 时两端点重合（宽度由渲染层 Math.max 兜到可见，不是几何层造假）',
    d?.loPct === d?.hiPct && d?.loPct === 37.5, d);
}
ok('G-08 每行 loPct ≤ ePct ≤ hiPct（E 落在区间内是 PERT 的性质，几何层不重排三点）',
  [...geo.values()].every((g) => g.loPct <= g.ePct && g.ePct <= g.hiPct), [...geo.values()]);

console.log('\n=== G 段续：E 的位置只认服务端那一份（篡改守卫） ===');
{
  // 把服务端 rowRatios 的 expected 整体挪一位：若面板自己按 (O+4M+P)/6 算 E，竖线不会动；
  // 只有「位置取自 rowRatios」时才会跟着挪——这就是零计算红线在区间条上的可证形式。
  const shuffled = P.whiskerGeometries(P.buildPanelRows(plans as never, items, [],
    [mkRatio('g-1', 3, 1), mkRatio('g-2', 4, 1), mkRatio('g-3', 16, 1), mkRatio('g-4', 1, 1)], {}));
  const orig = geo.get('g-1');
  ok('G-09 篡改 rowRatios 后竖线立刻跟着挪（E 不是前端重算的）',
    shuffled.get('g-1')?.ePct === 18.75 && Math.abs((orig?.ePct ?? 0) - (1.8333 / 16 * 100)) < 1e-9,
    { before: orig?.ePct, after: shuffled.get('g-1')?.ePct });
  ok('G-10 篡改只影响 E 竖线，端点仍由 O/P 决定（几何层不碰三点值）',
    shuffled.get('g-1')?.loPct === orig?.loPct && shuffled.get('g-1')?.hiPct === orig?.hiPct,
    shuffled.get('g-1'));
}
{
  const sug = P.whiskerGeometries(P.buildPanelRows([asPlan('s', '建议行', 'normal', 3)], [],
    [mkDerive('s', 2, 3.5, 5)], [], {}));
  const s = sug.get('s');
  ok('G-11 未落库的推导建议行同样出几何（值来自 derive 响应，仍是服务端算的）',
    s?.loPct === 40 && s?.hiPct === 100 && s?.ePct === 70, s);
}

console.log('\n=== C 段：区间条的渲染产物（react-dom/server 静态串） ===');
/**
 * T02293 改判：这一段原来逐个正则匹配 `EstimatePanel.tsx` 的源码文本
 * （`role="img"`、颜色三元、`Math.max(hiPct-loPct, 0.4)`…）。那些字面量是**实现形态**：
 * 把三元提成变量、给 style 换个写法、把 JSX 挪进子组件，行为一模一样而门恒红；
 * 反过来把 aria-label 删掉则门不红——判据与被测行为脱钩。
 * 现在统一打在 `WhiskerBar` 的渲染串上（规约第 1 条允许的「渲染后的 DOM」），
 * 面板侧的接线由真机门 `verify-t02041-ui.mjs` 用浏览器 DOM 负责（U-15/U-17/U-18/U-33）。
 */
const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const renderBar = (rowId: string, rowsOf: typeof rows, geoOf: Map<string, any>): string => {
  const row = rowsOf.find((r) => r.planId === rowId)!;
  return renderToStaticMarkup(createElement(P.WhiskerBar, { row, geom: geoOf.get(rowId) }));
};
const stored = renderBar('g-1', rows, geo);
const degenerate = renderBar('g-3', rows, geo);
const sugRows = P.buildPanelRows([asPlan('s', '建议行', 'normal', 3)], [], [mkDerive('s', 2, 3.5, 5)], [], {});
const sugGeo = P.whiskerGeometries(sugRows);
const sugBar = renderBar('s', sugRows, sugGeo);
/** 里程碑行没有几何：`WhiskerBar` 收到 undefined 必须什么都不画（画出来就是给不存在的区间画图形） */
const msBar = renderToStaticMarkup(createElement(P.WhiskerBar, {
  row: rows.find((r) => r.planId === 'g-ms')!, geom: geo.get('g-ms'),
}));
/** 渲染串里第 i 条线的 background 值（四条线：横线 / O 帽 / P 帽 / E 竖线） */
const barLefts = (html: string): string[] => [...html.matchAll(/left:([\d.]+)%/g)].map((m) => m[1]);

ok('C-01 区间条是可访问图形：渲染串带 role="img" 且 aria-label 以「区间条 + 行标题」开头（走查脚本据此定位，不靠类名）',
  /role="img"/.test(stored) && /aria-label="区间条 小区间"/.test(stored), stored.slice(0, 200));
ok('C-02 无几何的行不产生任何图形节点；图例谓词两态都对（一条区间都画不出来时不解释一个不存在的图形）',
  msBar === '' && P.whiskerLegendShown(0) === false && P.whiskerLegendShown(sugGeo.size) === true && sugGeo.size > 0,
  { msBar, 几何条数: sugGeo.size });
// 规约第 3 条：这一条是「接线」事实，谓词本身真了还不够，面板得真的用它——留字面锚点配行为兜底。
ok('C-02b 面板图例确实走 whiskerLegendShown（谓词红了这条也红，不是各写各的）',
  PANEL_SRC.includes('whiskerLegendShown(whisker.size)') && P.whiskerLegendShown(0) === false, undefined);
ok('C-03 归一基数来自「传进来的那一份全量明细行」：给全量得 16，给筛后子集就变小——所以面板必须传全量（真机 U-20 守接线）',
  geo.get('g-1')?.scaleMax === 16
  && P.whiskerGeometries(rows.filter((r) => r.planId !== 'g-2')).get('g-1')?.scaleMax === 6,
  { 全量: geo.get('g-1')?.scaleMax, 去掉最大P行: P.whiskerGeometries(rows.filter((r) => r.planId !== 'g-2')).get('g-1')?.scaleMax });
ok('C-04 建议行渲染成次级色、已落库行渲染成主色（灰显口径延伸到区间条，且两色不同）',
  /background:var\(--accent\)/.test(stored) && !/var\(--text-muted\)/.test(stored)
  && /background:var\(--text-muted\)/.test(sugBar) && !/var\(--accent\)/.test(sugBar),
  { stored: stored.slice(0, 90), sug: sugBar.slice(0, 90) });
ok('C-05 四条线（横线 + O 帽 + P 帽 + E 竖线）都画出来了，顺序与走查脚本的 kids 约定一致',
  barLefts(stored).length === 4 && barLefts(stored)[0] === '6.25' && barLefts(stored).slice(1, 3).every((v) => v === '6.25' || v === '18.75'),
  { lefts: barLefts(stored) });
ok('C-06 渲染串里不出现硬编码色值（颜色只走 CSS 变量，明暗双验的前提）',
  !/#[0-9a-fA-F]{3,8}\b/.test(stored + sugBar + degenerate) && !/rgb\(/.test(stored),
  (stored + sugBar).match(/#[0-9a-fA-F]{3,8}/g) ?? []);
ok('C-07 tooltip 把三点数值与归一基数写给读者（E 用的就是服务端 rowRatios 那一份，门内不重算）',
  /title="O 1 —— P 3，竖线为 E 1\.83 人天/.test(stored) && /最大 P=16 归一/.test(stored),
  (stored.match(/title="[^"]*"/) ?? [''])[0]);
ok('C-08 退化区间（O=P）渲染出的横线宽度落在最小可见宽度上而不是 0%，且带 min-width 兜底（下限写在渲染层，几何层不掺假）',
  /width:0\.4%/.test(degenerate) && /min-width:2px/.test(degenerate)
  && /width:12\.5%/.test(stored) && !/width:0\.4%/.test(stored),
  { degenerate: (degenerate.match(/width:[\d.]+%/g) ?? []), stored: (stored.match(/width:[\d.]+%/g) ?? []) });
{
  // 反证（规约第 4 条）：E 竖线的 left 必须跟着 rowRatios 走——篡改基数后渲染串里的四个 left 全变，
  // 若面板自己按 (O+4M+P)/6 画 E，这里就不会动。
  const tampered = P.whiskerGeometries(P.buildPanelRows(plans as never, items, [],
    [mkRatio('g-1', 3, 1), mkRatio('g-2', 4, 1), mkRatio('g-3', 16, 1), mkRatio('g-4', 1, 1)], {}));
  ok('C-09 篡改服务端 expected 后，渲染串里 E 竖线的位置跟着挪（区间条没有第二套算式）',
    barLefts(renderBar('g-1', rows, tampered))[3] === '18.75' && barLefts(stored)[3] !== '18.75',
    { before: barLefts(stored)[3], after: barLefts(renderBar('g-1', rows, tampered))[3] });
}

console.log('\n=== N 段：反证（规约第 4 条——C 段判据必须有牙） ===');
{
  /**
   * C 段现在读的是渲染串，风险从「重构即误红」换成了「正则写得松到恒真」。
   * 这里把真实渲染串逐处改坏（摘掉 role、换掉 aria-label 前缀、把 CSS 变量换成硬编码色、
   * 去掉退化区间的最小宽度），喂回 C 段用的同一组判据表达式——判据必须逐个判红才算有牙。
   * 坏串只用来验判据本身，不参与任何被测行为。
   */
  const brokenA11y = stored.replace('role="img" ', '').replace('aria-label="区间条 小区间"', 'aria-label="进度条 小区间"');
  const brokenColor = stored.replace(/var\(--accent\)/g, '#2f6f4f');
  const brokenFloor = degenerate.replace('width:0.4%', 'width:0%').replace('min-width:2px', 'min-width:0');
  const a11yHold = (html: string) => /role="img"/.test(html) && /aria-label="区间条 /.test(html);
  const colorHold = (html: string, want: RegExp, reject: RegExp) => want.test(html) && !reject.test(html);
  const floorHold = (html: string) => /width:0\.4%/.test(html) && /min-width:2px/.test(html);
  ok('N-01 反证：摘掉 role、把 aria-label 前缀改成「进度条」，C-01 判据必须落空（真实串过、坏串不过）',
    a11yHold(stored) && !a11yHold(brokenA11y), { broken: brokenA11y.slice(0, 80) });
  ok('N-02 反证：把 CSS 变量换成硬编码色值，C-04/C-06 两条配色判据必须同时落空',
    colorHold(stored, /background:var\(--accent\)/, /var\(--text-muted\)/)
    && !colorHold(brokenColor, /background:var\(--accent\)/, /var\(--text-muted\)/)
    && /#[0-9a-fA-F]{3,8}\b/.test(brokenColor) && !/#[0-9a-fA-F]{3,8}\b/.test(stored + sugBar + degenerate),
    { broken: brokenColor.slice(0, 80) });
  ok('N-03 反证：退化区间若不写最小可见宽度（0% + min-width:0），C-08 判据必须落空',
    floorHold(degenerate) && !floorHold(brokenFloor) && !floorHold(stored.replace('width:12.5%', 'width:0.4%').replace(/min-width:2px/g, '')),
    { broken: (brokenFloor.match(/width:[\d.]+%|min-width:\d+/g) ?? []) });
  ok('N-04 反证：只有「三点齐全」的行才有几何——把 P 抹掉后 C-02 那条渲染必须为空串',
    sugGeo.size > 0 && renderToStaticMarkup(createElement(P.WhiskerBar, {
      row: P.buildPanelRows([asPlan('n4', '缺 P 行', 'normal', null)],
        [{ ...mkItem('n4', 1, 2, 3), pessimistic: null } as unknown as Item], [], [mkRatio('n4', 2, 1)], {})[0],
      geom: undefined,
    })) === '',
    { 建议行几何条数: sugGeo.size });
}

console.log(`\n结果：PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
