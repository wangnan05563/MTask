/**
 * T02171 门：时间线/计划页超行数改为分页承载（派生自 T02166）。
 *
 * 改造前口径：一页画不下的计划折成一句页脚「其余 n 条未绘出」，稿子里看不到完整排期。
 * 断言分两组：
 *   P 组 分页纯逻辑：窗口前移按**版面实收行数**（不是拍脑袋的行数上限）、只有末页才折注、
 *        续页不重复首页的要点与其他数据块、单页够用时一页不多开、降级前提不造空壳页、
 *        被页数上限挡住时仍如实报未绘条数。
 *   U 组 真产物：解包 .pptx 数幻灯片数与页脚分母（页数要与页码联动）、续页确为原生甘特形状、
 *        每页形状底边不出画布（分页不得顺手越页）。
 *
 * 隔离纪律：不连生产库、不起服务、不调 AI（Bundle 脚本内构造）。
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02171-kickoff-tl-paging.mts
 * 结果落 .workbuddy/t02171-gate-results-<运行标识>.txt 与 t02171-paging.pptx。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { writeGateResults } from './lib/gate-results.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');
mkdirSync(OUT_DIR, { recursive: true });

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 500)}`}`);
};

const M = await import('../server/src/services/kickoffBuilder.ts');
const LAY = await import('../server/src/services/kickoff-layout.ts');

// ---------- 测试夹具 ----------
const DAY = 86400000;
const iso = (base: number, offDays: number) => new Date(base + offDays * DAY).toISOString().slice(0, 10);
const T0 = Date.UTC(2026, 0, 5);
const planRow = (i: number) => ({
  id: `q${i}`, project_id: 'p1', title: `任务 ${i + 1}`, description: '',
  start_date: iso(T0, i * 3), end_date: iso(T0, i * 3 + 6 + (i % 3) * 4),
  duration_days: 5 + (i % 3) * 3, progress: i < 8 ? 100 : 20, status: i < 8 ? 'done' : 'doing',
  assignee: i % 2 ? '张三' : '李四', sort_order: i, linked_task_id: null, req_ids: null, color: '',
  deps: '', complexity: (i % 5) + 1, kind: 'normal', archived: 0, archived_at: null, created_at: '', updated_at: '',
});
const msRow = (i: number) => ({
  ...planRow(100 + i), id: `m${i}`, title: `M${i + 1} 里程碑`, start_date: iso(T0, i * 12), end_date: iso(T0, i * 12 + 2),
  kind: 'milestone',
});
const bundleOf = (planCount: number) => ({
  project: { id: 'p1', name: 'mtask五期', workspacePath: 'D:\\code\\otherProjects\\26_MTask' },
  prdDocs: [{ id: 'd1', filename: 'PRD-项目启动会PPT生成.md', updatedAt: '2026-10-12', contentChars: 1200 }],
  prdDoc: { id: 'd1', filename: 'PRD-项目启动会PPT生成.md', updatedAt: '2026-10-12', contentMd: '# 背景\n口径来源说明。' },
  prdExcerpt: '# 背景\n口径来源说明。',
  prdTruncated: false,
  requirements: Array.from({ length: 14 }, (_, i) => ({
    id: `r${i}`, project_id: 'p1', req_no: `R${i + 1}`, title: `需求 ${i + 1}`, content: null, source_ref: null,
    priority: 'normal', status: i < 6 ? 'done' : i < 9 ? 'doing' : 'todo', sort_order: i, created_at: null,
    updated_at: null, prd_id: 'd1', linkedPlans: [{ id: 'x', title: '计划', status: 'doing' }], linkedTasks: [], prdDoc: null,
  })),
  plans: Array.from({ length: planCount }, (_, i) => planRow(i)),
  milestones: Array.from({ length: 6 }, (_, i) => msRow(i)),
  coverage: { total: 40, covered: 32, uncovered: 8, rate: 80 },
  assignees: [{ name: '张三', planCount: 12 }, { name: '李四', planCount: 11 }],
  risks: [{ item: '计划进度落后', impact: '排期后移', mitigation: '拆分并行', source: '计划表' }],
  workload: {
    source: 'estimate', manDays: { expected: 96, optimistic: 78, pessimistic: 132 }, manMonth: 4.6,
    quote: { p50ManDays: 96, p84ManDays: 118 }, phases: [{ phase: '开发', expected: 60, rowCount: 12 }, { phase: '测试', expected: 36, rowCount: 6 }],
    complexity: [{ level: '1', count: 4 }], counted: planCount, footer: '工作量来源：估算引擎（P50 96 人天）',
  },
  preflight: {
    projectId: 'p1', projectName: 'mtask五期', blocked: false, missingHard: [], workloadSource: 'estimate',
    items: (['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'] as const).map((key, i) => ({
      key, label: `项${key}`, count: [1, 14, planCount, 6, 0, planCount, 1][i], status: (i === 4 ? 'warn' : 'ok') as 'ok' | 'warn' | 'fail',
      note: '示例说明', deepLink: 'plan', hard: i < 3,
    })),
  },
  workspaceNote: '工作空间可访问',
  dataAsOf: '2026-10-13',
}) as any;

const tlItem = (over: Record<string, unknown> = {}) => ({
  section: '项目计划', title: '项目计划时间线', bullets: [], dataKeys: ['timeline'], layout: 'timeline', ...over,
});
const frames = LAY.framesFor('data', 'timeline');
const drawnOf = (b: any, item: any, bullets: string[] = []) => M.layoutBody(item, b, frames, bullets).tlDrawn;

const bundle = bundleOf(23);

// ---------- P 组：分页窗口与承载 ----------
ok('P-01 首页版面收得下的行数由 layoutBody 实测（探针与装配同一口径，不在别处重算几何）',
  drawnOf(bundle, tlItem()) > 0 && drawnOf(bundle, tlItem()) <= 8, drawnOf(bundle, tlItem()));

const firstPageRows = drawnOf(bundle, tlItem());
const pages = M.expandTimelinePages(bundle, [tlItem()]) as any[];
ok(`P-02 23 条计划首页只收 ${firstPageRows} 条 → 展开成多页承载（不再折成页脚）`,
  pages.length > 1, { pages: pages.length });
ok('P-03 窗口 offset 从 0 起严格递增，步长=各页版面实收行数', (() => {
  let expect = 0;
  for (const p of pages) {
    if (p.tlWindow.offset !== expect) return false;
    expect += drawnOf(bundle, p, []);
  }
  return expect === bundle.plans.length;
})(), pages.map((p) => ({ off: p.tlWindow.offset, rows: drawnOf(bundle, p, []) })));
ok('P-04 全量承载：各页实绘条数之和 = 库内计划数（一条不丢，也不重复画）',
  pages.reduce((s, p) => s + drawnOf(bundle, p, []), 0) === bundle.plans.length,
  { sum: pages.reduce((s: number, p: any) => s + drawnOf(bundle, p, []), 0), plans: bundle.plans.length });
ok('P-05 只有末页能带「其余 n 条」注（中间页注了就是谎报未绘）；全承载时末页也不带', (() => {
  const frame = frames.body;
  const marks = pages.map((p) =>
    M.timelineBlocks(bundle, frame, p.tlWindow).blocks.some((x: any) => x.text && /其余 \d+ 条计划未绘出/.test(x.text.content))
  );
  return marks.every((m) => m === false) && pages.at(-1).tlWindow.last === true &&
    pages.slice(0, -1).every((p) => p.tlWindow.last !== true);
})(), pages.map((p) => ({ last: p.tlWindow.last, off: p.tlWindow.offset })));
ok('P-06 续页只带时间线：标题加「（续）」、要点与其他数据块留在首页（同表重画不是承载）',
  pages.slice(1).every((p) => /（续）$/.test(p.title) && p.bullets.length === 0 && p.dataKeys.join() === 'timeline'),
  pages.map((p) => ({ t: p.title, keys: p.dataKeys, b: p.bullets.length })));

const mixed = M.expandTimelinePages(bundle, [tlItem({ bullets: ['任务 1 已交付，任务 9 进行中'], dataKeys: ['timeline', 'planRows'] })]) as any[];
ok('P-07 首页带要点+表格（版面被挤小）时分页仍成立，要点不被复制到续页',
  mixed.length > 1 && mixed[0].bullets.length === 1 && mixed[0].dataKeys.join() === 'timeline,planRows' &&
    mixed.slice(1).every((p) => p.bullets.length === 0),
  { pages: mixed.length, first: mixed[0]?.dataKeys });

ok('P-08 单页装得下就不开续页（改造前后同形，不给小项目硬塞页）', (() => {
  const small = bundleOf(3);
  const p = M.expandTimelinePages(small, [tlItem()]) as any[];
  return p.length === 1 && p[0].tlWindow.last === true;
})(), M.expandTimelinePages(bundleOf(3), [tlItem()]).map((p: any) => p.tlWindow));

ok('P-09 绘制前提缺失（里程碑 0 个）→ 不分页，交回列表版降级口径（不造空壳甘特页）', (() => {
  const noMs = { ...bundle, milestones: [] };
  return M.expandTimelinePages(noMs, [tlItem()]).length === 1;
})(), M.expandTimelinePages({ ...bundle, milestones: [] }, [tlItem()]).length);

ok('P-10 非时间线页原样透传（大纲顺序与页数不被改动）', (() => {
  const out = M.expandTimelinePages(bundle, [
    tlItem(), { section: '正文', title: '需求概览', bullets: [], dataKeys: ['reqList'], layout: 'table' }, tlItem({ title: '第二条时间线' }),
  ]) as any[];
  return out.filter((p) => p.layout !== 'timeline').length === 1 && out[0].title === '项目计划时间线' &&
    out.some((p) => p.title === '第二条时间线');
})(), M.expandTimelinePages(bundle, [tlItem(), { section: '正文', title: '需求概览', bullets: [], dataKeys: ['reqList'], layout: 'table' }, tlItem({ title: '第二条时间线' })]).map((p: any) => p.title));

const huge = M.expandTimelinePages(bundleOf(90), [tlItem()]) as any[];
const hugeDrawn = huge.reduce((s, p) => s + drawnOf(bundleOf(90), p, []), 0);
ok('P-11 页数有上限：超大项目最多铺到上限页，末页如实报「其余 n 条」（不无限加页，也不谎称画全）',
  huge.length === 6 && huge.at(-1).tlWindow.last === true && 90 - hugeDrawn > 0 &&
    /其余 \d+ 条/.test(M.timelineBlocks(bundleOf(90), frames.body, huge.at(-1).tlWindow).blocks.map((x: any) => x.text?.content ?? '').join('|')),
  { pages: huge.length, drawn: hugeDrawn });

ok('P-12 分页后的每页都过版式断言：无 violations 且所有块在画布内（分页不越页）',
  pages.every((p) => {
    const r = M.layoutBody(p, bundle, frames, []);
    const bottom = LAY.getContentFrame().y + LAY.getContentFrame().h;
    return r.violations.length === 0 && r.blocks.every((b: any) => b.box.y >= 0 && b.box.y + b.box.h <= bottom + 1e-6);
  }),
  pages.map((p) => M.layoutBody(p, bundle, frames, []).violations));

// ---------- U 组：真产物 ----------
const outline = [
  { section: '封面', title: 'mtask五期 项目启动会', bullets: [], dataKeys: [], layout: 'cover' },
  { section: '项目计划', title: '项目计划时间线', bullets: [], dataKeys: ['timeline'], layout: 'timeline' },
  { section: '项目计划', title: '用例覆盖', bullets: [], dataKeys: ['coverage'], layout: 'chart' },
] as any[];
const built = await M.buildKickoffPpt(bundle, outline);
writeFileSync(join(OUT_DIR, 't02171-paging.pptx'), built.buffer);
const zip = await JSZip.loadAsync(built.buffer);
const slideNames = Object.keys(zip.files)
  .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
  .sort((a, b) => Number(/(\d+)\.xml/.exec(a)![1]) - Number(/(\d+)\.xml/.exec(b)![1]));
const xmls: string[] = [];
for (const n of slideNames) xmls.push(await zip.file(n)!.async('string'));
const render = M.expandTimelinePages(bundle, outline) as any[];

ok('U-01 产物幻灯片数 = 渲染页数（大纲 + 时间线续页），pageCount 与之同源',
  xmls.length === render.length && built.pageCount === xmls.length && render.length > outline.length,
  { slides: xmls.length, pageCount: built.pageCount, outline: outline.length, render: render.length });
ok('U-02 页脚分母跟着渲染页数走（不出现「第 5/3 页」这种页码错位）',
  xmls.every((x, i) => x.includes(`第 ${i + 1}/${render.length} 页`)),
  xmls.map((x) => (x.match(/第 \d+\/\d+ 页/) ?? [null])[0]));
ok('U-03 warnings 不再出现「超出本页可排行数 / 折成页脚提示」（23 条计划全部有页承载）',
  !built.warnings.some((w: string) => /超出本页可排行数|折成页脚提示/.test(w)),
  built.warnings.filter((w: string) => /时间线|页：/.test(w)));
ok('U-04 续页仍是原生甘特（rect 条 + diamond 菱形 + line 轴），不是回退成表格凑页', (() => {
  const tlSlides = xmls.slice(1, 1 + render.filter((p) => p.layout === 'timeline').length);
  const count = (x: string, prst: string) =>
    x.split('<p:sp>').slice(1)
      .filter((s) => /^Shape\b/.test((s.match(/name="([^"]*)"/) ?? [])[1] ?? ''))
      .filter((s) => (s.match(/prst="([a-z]+)"/) ?? [])[1] === prst).length;
  return tlSlides.length > 1 && tlSlides.every((x) => count(x, 'rect') > 0 && count(x, 'line') === 1 && count(x, 'diamond') === 6) &&
    !/<a:tbl>/.test(tlSlides.join(''));
})(), xmls.map((x) => ({ tbl: /<a:tbl>/.test(x), dia: /prst="diamond"/.test(x) })));
ok('U-05 时间线各页形状底边都不越画布（分页后依旧不越页）', (() => {
  const boxes = xmls.slice(1, 1 + render.filter((p: any) => p.layout === 'timeline').length).flatMap((x) =>
    x.split('<p:sp>').slice(1)
      .filter((s) => /^Shape\b/.test((s.match(/name="([^"]*)"/) ?? [])[1] ?? ''))
      .map((s) => {
        const off = (s.match(/<a:off x="(\d+)" y="(\d+)"\/>/) ?? []).slice(1).map((v) => +v / 914400);
        const ext = (s.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/) ?? []).slice(1).map((v) => +v / 914400);
        return { y: off[1], h: ext[1] };
      }));
  return boxes.length > 0 && boxes.every((b) => b.y + b.h <= 5.625 + 1e-6);
})(), xmls.length);
ok('U-06 分页页不触发整页降级（越界判据仍按页计，续页不被误判坏页）',
  built.degradedPages.length === 0, built.degradedPages);

writeGateResults(OUT_DIR, 't02171-gate-results.txt', `T02171 时间线分页门：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`);
console.log(`PASS=${pass} FAIL=${fail}`);
console.log(lines.filter((l) => l.startsWith('[FAIL]')).join('\n'));
process.exit(fail ? 1 : 0);
