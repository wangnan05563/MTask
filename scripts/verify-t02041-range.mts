/**
 * T02041（PRD-估算视图 §5.4 区间条 = P0）验证脚本：区间条几何的**归一口径**与「不含第二套算式」。
 *
 * 用法（与 verify-t02039/e4a 同写法，Node 版本要对齐 better-sqlite3 的预编译 ABI）：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02041-range.mts
 *
 * 两段结构：
 *   G 段（同进程·纯函数）：`whiskerGeometries()` 的取值域、归一基数、单调性、退化区间（O=P）、
 *     越界钳制，以及最关键的一条**篡改守卫**——把服务端 `rowRatios.expected` 换成任意值，
 *     区间条的 E 竖线必须跟着变。它证明 E 的位置来自服务端那一份，而不是前端又算了一遍 PERT。
 *   C 段（源码守卫）：面板里区间条的可测接线（role/aria-label/图例条件渲染）、
 *     颜色只取 CSS 变量、建议行用次级色、里程碑组头不画区间条、
 *     归一基数取「全部明细行」而非筛选后可见行，且新增代码里不得出现 E/σ 公式。
 *
 * 真机走查（§10-1/2/13 三档视口、改值后条长跟变、筛选不改刻度、明暗双验）见 scripts/verify-t02041-ui.mjs。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const T = '2026-10-11T00:00:00.000Z';
const PID = 'geom-e6';

let pass = 0; let fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra).toString().slice(0, 400)}` : ''}`);
  }
};

const P = await import('../web/src/components/EstimatePanel.tsx');
const PANEL_SRC = readFileSync(join(ROOT, 'web/src/components/EstimatePanel.tsx'), 'utf-8');

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

console.log('\n=== C 段：面板源码守卫（接线、配色、口径不漂移） ===');
{
  const code = PANEL_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('C-01 区间条是可访问图形：role="img" + aria-label 以「区间条」开头（走查脚本据此定位，不靠类名）',
    /role="img"/.test(code) && /aria-label=\{`区间条 /.test(code));
  ok('C-02 图例条件渲染：一条区间都画不出来时不解释一个不存在的图形',
    /whisker\.size > 0 && \(/.test(code));
  ok('C-03 归一基数取全部明细行，不取「只看未复核」筛后的可见行（筛选不改刻度）',
    /useMemo\(\(\) => whiskerGeometries\(rows\), \[rows\]\)/.test(code));
  ok('C-04 建议行用次级色、已落库行用 --accent（灰显口径延伸到区间条）',
    /r\.suggestion \? 'var\(--text-muted\)' : 'var\(--accent\)'/.test(code));
  ok('C-05 区间条只画在明细行循环内，里程碑组头不画（§4.6 红线一）',
    (() => {
      const msHeader = code.slice(code.indexOf('不进 Σ'), code.indexOf('不进 Σ') + 40);
      const rowIdx = code.indexOf('aria-label={`区间条 ');
      const msIdx = code.indexOf('group.items.map');
      return rowIdx > msIdx && !msHeader.includes('区间条') && rowIdx > 0;
    })(), { msHeaderSnippet: code.slice(code.indexOf('不进 Σ'), code.indexOf('不进 Σ') + 30) });
  const block = code.slice(code.indexOf('aria-label={`区间条 '), code.indexOf('aria-label={`区间条 ') + 1400);
  ok('C-06 区间条块内不出现硬编码色值（颜色只走 CSS 变量，明暗双验的前提）', !/#[0-9a-fA-F]{3,8}\b/.test(block), block.slice(0, 120));
  ok('C-07 几何函数里没有 PERT/σ 公式（/6、sigma(、Math.sqrt 都不许出现）',
    !/\/\s*6\b/.test(code.slice(code.indexOf('export function whiskerGeometries'), code.indexOf('export function whiskerGeometries') + 900))
    && !/Math\.sqrt/.test(code.slice(code.indexOf('export function whiskerGeometries'), code.indexOf('export function whiskerGeometries') + 900)));
  ok('C-08 退化区间的最小可见宽度写在渲染层（Math.max(hiPct-loPct, 0.4) + minWidth 2px 双下限），不在几何层偷偷改 O/P',
    /Math\.max\(g\.hiPct - g\.loPct, 0\.4\)/.test(code) && /width: `\$\{Math\.max\(g\.hiPct - g\.loPct, 0\.4\)\}%`, minWidth: 2/.test(code));
}

console.log(`\n结果：PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
