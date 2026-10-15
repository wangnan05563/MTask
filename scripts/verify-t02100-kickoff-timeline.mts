/**
 * T02100 门：时间线形状绘制（PRD FR-4.5 / 技术方案 §4 时间线几何 / 验收 6）。
 *
 * 断言：
 *   S 组 源码守卫：形状只走 addShape、线性映射一律委托 T02098、色值与图内字号单源。
 *   U 组 纯函数 + 真产物：日期范围/降级前提/条与菱形/轴刻度/同日挤道/缺日期不硬画/超行数如实折脚，
 *        再解包真 .pptx 数 `<a:prstGeom prst="rect|diamond|line">`——「原生形状」只能由产物证明。
 *
 * 隔离纪律：不连生产库、不起服务、不调 AI（Bundle 脚本内构造）。
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02100-kickoff-timeline.mts
 * 结果落 .workbuddy/t02100-gate-results.txt 与 t02100-timeline.pptx。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};

const M = await import('../server/src/services/kickoffBuilder.ts');
const LAY = await import('../server/src/services/kickoff-layout.ts');

// ---------- S 组：源码/契约守卫 ----------
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const SRC = stripComments(readFileSync(join(ROOT, 'server', 'src', 'services', 'kickoffBuilder.ts'), 'utf8'));
const LAYSRC = stripComments(readFileSync(join(ROOT, 'server', 'src', 'services', 'kickoff-layout.ts'), 'utf8'));

ok('S-01 形状走原生 addShape，不退回贴图（验收 5/6：PowerPoint 里可拖拽改）',
  /slide\.addShape\(/.test(SRC) && !/addImage\(/.test(SRC) && !/<p:pic>/.test(SRC));
ok('S-02 日期→坐标的线性映射全部委托 T02098（本层不自己算 span 比例）',
  /dateRangeOf\(/.test(SRC) && /barBox\(/.test(SRC) && /diamondBox\(/.test(SRC) && /axisTicks\(/.test(SRC) &&
    !/\(range\.max - range\.min\)/.test(SRC) && !/86400000/.test(SRC));
ok('S-03 形状配色只走 PALETTE 单源（门禁 6）', !/["'#][0-9a-fA-F]{6}/.test(SRC) && /PALETTE\.(accent|warn|ink)/.test(SRC));
ok('S-04 轴刻度对齐条形栏框（用默认全宽框会整体错位）', /axisTicks\(range, 4, bars\)/.test(SRC));
ok('S-05 时间线前提缺失走「如实降级 + 带原因」通道，不静默出假甘特',
  /timelineDegradeReason\(/.test(SRC) && /时间线回落列表版/.test(SRC) && /notes\.push\(/.test(SRC));
ok('S-06 版式层把轴刻度框参数化（否则 T02100 只能散写坐标）',
  /export function axisTicks\(range: DateRange, count = 4, frame: Box = getContentFrame\(\)\)/.test(LAYSRC));

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
const bundleOf = (over: Record<string, unknown> = {}) => ({
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
  plans: Array.from({ length: 23 }, (_, i) => planRow(i)),
  milestones: Array.from({ length: 6 }, (_, i) => msRow(i)),
  coverage: { total: 40, covered: 32, uncovered: 8, rate: 80 },
  assignees: [{ name: '张三', planCount: 12 }, { name: '李四', planCount: 11 }],
  risks: [{ item: '3 条计划阻塞', impact: '排期后移', mitigation: '拆分并行', source: '计划表' }],
  workload: {
    source: 'estimate', manDays: { expected: 96, optimistic: 78, pessimistic: 132 }, manMonth: 4.6,
    quote: { p50ManDays: 96, p84ManDays: 118 }, phases: [{ phase: '开发', expected: 60, rowCount: 12 }, { phase: '测试', expected: 36, rowCount: 6 }],
    complexity: [{ level: '1', count: 4 }], counted: 23, footer: '工作量来源：估算引擎（P50 96 人天）',
  },
  preflight: {
    projectId: 'p1', projectName: 'mtask五期', blocked: false, missingHard: [], workloadSource: 'estimate',
    items: (['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'] as const).map((key, i) => ({
      key, label: `项${key}`, count: [1, 14, 23, 6, 0, 23, 1][i], status: (i === 4 ? 'warn' : 'ok') as 'ok' | 'warn' | 'fail',
      note: '示例说明', deepLink: 'plan', hard: i < 3,
    })),
  },
  workspaceNote: '工作空间可访问',
  dataAsOf: '2026-10-13',
  ...over,
}) as any;

const bundle = bundleOf();
const frame = LAY.framesFor('data').body;

// ---------- U 组：绘制前提 ----------
ok('U-01 日期齐备 + 有里程碑 → 用形状版（前提成立时不降级）', M.timelineDegradeReason(bundle) === null, M.timelineDegradeReason(bundle));
ok('U-02 计划全无起止日期 → 点名「没有可用的起止日期」（P3 口径，不画猜出来的工期）',
  /起止日期/.test(M.timelineDegradeReason(bundleOf({ plans: bundle.plans.map((p: any) => ({ ...p, start_date: '', end_date: '' })) })) ?? ''),
  M.timelineDegradeReason(bundleOf({ plans: bundle.plans.map((p: any) => ({ ...p, start_date: '', end_date: '' })) })));
ok('U-03 里程碑 0 个 → 点名降级（P4 口径：验收 6 的菱形无从存在）',
  /里程碑为 0/.test(M.timelineDegradeReason(bundleOf({ milestones: [] })) ?? ''));
ok('U-04 部分行缺日期也只降级那一行：整体前提仍成立',
  M.timelineDegradeReason(bundleOf({ plans: [{ ...bundle.plans[0], start_date: '', end_date: '' }, ...bundle.plans.slice(1)] })) === null);

// ---------- U 组：形状几何 ----------
const tl = M.timelineBlocks(bundle, frame);
const bars = tl.blocks.filter((x: any) => x.shape?.kind === 'rect');
const diams = tl.blocks.filter((x: any) => x.shape?.kind === 'diamond');
const axis = tl.blocks.find((x: any) => x.shape?.kind === 'line');
const ticks = tl.blocks.filter((x: any) => x.text && /^\d+\/\d+$/.test(x.text.content));
ok('U-05 三类原生形状齐全：矩形条 + 里程碑菱形 + 日期轴（FR-4.5 三件套）',
  bars.length > 0 && diams.length === bundle.milestones.length && !!axis, { bars: bars.length, diams: diams.length });
ok('U-06 绘制条数受版面行数钳制，页脚如实报剩余（不静默丢也不硬塞）',
  bars.length + tl.undated > 0 && bars.length + tl.undated <= Math.min(bundle.plans.length, 8) &&
    tl.overflow === bundle.plans.length - bars.length - tl.undated,
  { bars: bars.length, undated: tl.undated, overflow: tl.overflow });
ok('U-07 日期轴是零高度参照线，横跨整个条形区（不是又一条内容块）',
  !!axis && axis.box.h === 0 && Math.abs(axis.box.w - (frame.w - 2.2 - 0.15)) < 1e-6, axis?.box);
ok('U-08 刻度 4 格且全部贴条形区（用全宽框的老口径会整体左移 2.35"）',
  ticks.length === 4 && ticks.every((t: any) => t.box.x >= frame.x + 2.2 - 1e-6 && t.box.x + t.box.w <= frame.x + frame.w + 1e-6),
  ticks.map((t: any) => +t.box.x.toFixed(2)));
ok('U-09 首条条起点贴条形区左缘（min(start_date) 即轴起点）',
  Math.abs(bars[0].box.x - (frame.x + 2.2 + 0.15)) < 1e-6, bars[0].box);
ok('U-10 条宽按工期线性可比：5 天条 < 8 天条 < 11 天条（同一比例尺）', (() => {
  const w = (d: number) => {
    const r = M.timelineBlocks(bundleOf({ plans: [
      { ...bundle.plans[0], start_date: '2026-01-05', end_date: iso(T0, d) },
      { ...bundle.plans[1], start_date: '2026-01-05', end_date: '2026-02-20' },
    ] }), frame);
    return r.blocks.find((x: any) => x.shape?.kind === 'rect').box.w;
  };
  return w(10) < w(20) && w(20) < w(40);
})());
ok('U-11 条高 = TIMELINE_BAR_H 单源（不散写 0.18）', bars.every((x: any) => Math.abs(x.box.h - LAY.TIMELINE_BAR_H) < 1e-9));
ok('U-12 菱形全部骑在轴线高带上（中心不偏离轴 > 一个条高）', (() => {
  const axisY = (axis as any).box.y;
  return diams.every((d: any) => Math.abs(d.box.y + d.box.h / 2 - axisY) <= LAY.TIMELINE_BAR_H * 1.6);
})());
ok('U-13 画出的菱形两两不重叠（同日挤不下就下移或计数，不叠成一坨）',
  LAY.findOverlaps(diams.map((d: any) => d.box)).length === 0, LAY.findOverlaps(diams.map((d: any) => d.box)).length);
ok('U-14 正常数据零越界点名（violations 为空即整页不降级）', tl.violations.length === 0, tl.violations);
const sameDay = bundleOf({ milestones: Array.from({ length: 12 }, (_, i) => ({ ...msRow(0), id: `s${i}` })) });
ok('U-15 同日里程碑并成一枚菱形：一个都不少画，也不叠成一坨（图上菱形数 ≠ 库内数时必须有说法）', (() => {
  const r = M.timelineBlocks(sameDay, frame);
  const drawn = r.blocks.filter((x: any) => x.shape?.kind === 'diamond').length;
  return drawn === 1 && r.mergedMilestones === 11 &&
    r.blocks.some((x: any) => /◆ 里程碑 12 个（同日并成 1 组）/.test(x.text?.content ?? '')) &&
    LAY.findOverlaps(r.blocks.filter((x: any) => x.shape?.kind === 'diamond').map((d: any) => d.box)).length === 0;
})(), M.timelineBlocks(sameDay, frame).mergedMilestones);
ok('U-15b 日期分得开的里程碑逐个成菱形，图例不多写「并组」', (() => {
  const r = M.timelineBlocks(bundle, frame);
  return r.mergedMilestones === 0 && r.blocks.filter((x: any) => x.shape?.kind === 'diamond').length === bundle.milestones.length &&
    r.blocks.some((x: any) => x.text?.content === `◆ 里程碑 ${bundle.milestones.length} 个`);
})(), M.timelineBlocks(bundle, frame).blocks.filter((x: any) => x.text).map((x: any) => x.text.content));
ok('U-16 缺起止日期的行不画条，改为如实标注「无起止日期」', (() => {
  const r = M.timelineBlocks(bundleOf({ plans: [{ ...bundle.plans[0], start_date: '', end_date: '' }, bundle.plans[1], bundle.plans[2]] }), frame);
  return r.undated === 1 && r.blocks.filter((x: any) => x.shape?.kind === 'rect').length === 2 &&
    r.blocks.some((x: any) => x.text?.content === '无起止日期');
})());
ok('U-17 超行数的计划折进页脚提示，条数不硬塞（塞了就是压扁的纸片条）',
  tl.overflow > 0 && tl.blocks.some((x: any) => /其余 \d+ 条计划未绘出/.test(x.text?.content ?? '')), tl.overflow);
ok('U-18 单侧行（起点=终点）也给出可辨宽度（不画成 0 宽的看不见的条）', (() => {
  const r = M.timelineBlocks(bundleOf({ plans: [{ ...bundle.plans[0], start_date: '2026-01-05', end_date: '2026-01-05' }, bundle.plans[1]] }), frame);
  return r.blocks.filter((x: any) => x.shape?.kind === 'rect').every((b: any) => b.box.w >= 0.06);
})());

// ---------- U 组：整页排布接线 ----------
const tlItem = { section: '项目计划', title: '项目计划时间线', bullets: [], dataKeys: ['timeline'], layout: 'timeline' } as any;
const laid = M.layoutBody(tlItem, bundle, LAY.framesFor('data', 'timeline'), []);
ok('U-19 时间线页排布产出形状块，不再同时挂列表表格（两种形态不重复占版面）',
  laid.blocks.some((x: any) => x.shape) && laid.blocks.every((x: any) => !x.table), { shapes: laid.blocks.filter((x: any) => x.shape).length });
ok('U-20 前提缺失时整页回落列表表格，notes 点名原因（面板可复核「为什么这页是列表」）', (() => {
  const r = M.layoutBody(tlItem, bundleOf({ milestones: [] }), LAY.framesFor('data', 'timeline'), []);
  return r.blocks.every((x: any) => !x.shape) && r.blocks.some((x: any) => x.table) && /回落列表版/.test(r.notes.join(''));
})(), M.layoutBody(tlItem, bundleOf({ milestones: [] }), LAY.framesFor('data', 'timeline'), []).notes);
ok('U-21 版面高度不足以容纳「轴 + 2 行」时同样回落，不硬画半个甘特', (() => {
  const tiny = { ...LAY.framesFor('data', 'timeline'), body: { x: frame.x, y: frame.y, w: frame.w, h: 1.0 } };
  const r = M.layoutBody(tlItem, bundle, tiny as any, []);
  return r.blocks.every((x: any) => !x.shape) && /剩余高度/.test(r.notes.join(''));
})());
ok('U-22 菱形骑轴不被误判重叠（参照线排除，否则每页都是假越界）',
  M.pageViolations(LAY.framesFor('data', 'timeline').title, '项目计划时间线', laid.blocks, 22).length === 0,
  M.pageViolations(LAY.framesFor('data', 'timeline').title, '项目计划时间线', laid.blocks, 22));
ok('U-23 越界的形状块会被点名成「形状…」而非笼统「文本」', (() => {
  const bad = [{ box: { x: 0.5, y: 5.2, w: 1, h: 0.18 }, shape: { kind: 'rect', tone: 'bar' } }] as any;
  return M.pageViolations(LAY.framesFor('data').title, 't', bad, 22).some((s: string) => /形状/.test(s));
})());
ok('U-24 非时间线页不受本单接线影响（列表页 dataKeys 照常出表格）',
  M.layoutBody({ section: '正文', title: '计划列表', bullets: [], dataKeys: ['timeline'], layout: 'table' } as any, bundle, LAY.framesFor('data'), []).blocks.some((x: any) => x.table));
ok('U-24b layout 只是版式族：不挂 timeline 数据键就不该抢画甘特（否则覆盖率页会变成时间线）',
  M.layoutBody({ section: '正文', title: '用例覆盖', bullets: [], dataKeys: ['coverage'], layout: 'timeline' } as any, bundle, LAY.framesFor('data', 'timeline'), []).blocks
    .every((x: any) => !x.shape));

// ---------- U 组：真产物解包（原生形状只能由产物证明） ----------
const outline = [
  { section: '封面', title: 'mtask五期 项目启动会', bullets: [], dataKeys: [], layout: 'cover' },
  { section: '项目计划', title: '项目计划时间线', bullets: [], dataKeys: ['timeline'], layout: 'timeline' },
  { section: '项目计划', title: '里程碑', bullets: [], dataKeys: ['milestones'], layout: 'table' },
] as any[];
const built = await M.buildKickoffPpt(bundle, outline);
writeFileSync(join(OUT_DIR, 't02100-timeline.pptx'), built.buffer);
const zip = await JSZip.loadAsync(built.buffer);
const slideXml = async (n: number) => await zip.file(`ppt/slides/slide${n}.xml`)!.async('string');
const tlXml = await slideXml(2);
const listXml = await slideXml(3);

/**
 * 只数「真形状」：pptxgenjs 给文本盒也写 `prst="rect"`，按 prst 直接计数会把 4 个刻度
 * 文本也算成甘特条。库里形状名统一是 `Shape n`、文本是 `Text n`，以此区分。
 */
const shapesIn = (xml: string) =>
  xml
    .split('<p:sp>')
    .slice(1)
    .map((s) => ({
      prst: (s.match(/prst="([a-z]+)"/) ?? [])[1] ?? '',
      name: (s.match(/name="([^"]*)"/) ?? [])[1] ?? '',
      off: (s.match(/<a:off x="(\d+)" y="(\d+)"\/>/) ?? []).slice(1).map((v) => +v / 914400),
      ext: (s.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/) ?? []).slice(1).map((v) => +v / 914400),
    }))
    .filter((o) => /^Shape\b/.test(o.name));

const tlShapes = shapesIn(tlXml);
const tlBars = tlShapes.filter((s) => s.prst === 'rect');
const tlDiams = tlShapes.filter((s) => s.prst === 'diamond');
const tlAxis = tlShapes.filter((s) => s.prst === 'line');

ok('U-25 产物里时间线页确有原生几何：rect 条 + diamond 菱形 + line 轴三类齐备（不是截图）',
  tlBars.length > 0 && tlDiams.length > 0 && tlAxis.length === 1,
  { rect: tlBars.length, diamond: tlDiams.length, line: tlAxis.length });
ok('U-26 形状数量与页面绘制口径一致（菱形 = 里程碑数、条数 = 绘制行数）',
  tlDiams.length === diams.length && tlBars.length === bars.length,
  { xml: { diams: tlDiams.length, bars: tlBars.length }, model: { diams: diams.length, bars: bars.length } });
ok('U-27 每个形状都是可编辑的 <p:sp> 且带 offset/ext，条高 = TIMELINE_BAR_H（EMU 逐条核对）',
  tlShapes.every((s) => s.off.length === 2 && s.ext.length === 2) &&
    tlBars.every((s) => Math.abs(s.ext[1] - LAY.TIMELINE_BAR_H) < 1e-4),
  tlBars.map((s) => s.ext));
ok('U-28 形状坐标全部落在 10 × 5.625 画布内（越界的形状就是坏页）',
  tlShapes.length > 0 && tlShapes.every((s) => s.off[0] >= 0 && s.off[1] >= 0 && s.off[0] + s.ext[0] <= 10 + 1e-6 && s.off[1] + s.ext[1] <= 5.625 + 1e-6),
  tlShapes.filter((s) => s.off[0] + s.ext[0] > 10.000001));
ok('U-29 整份稿不含图片元素（验收 5 的反面：不许整页贴图）',
  // pptxgenjs 会留一个空的 `ppt/media/` 目录项，只要里面没有真图就不算贴图
  !Object.keys(zip.files).some((n) => n.startsWith('ppt/media/') && !n.endsWith('/')) &&
    !/<p:pic/.test(tlXml) && !/<p:pic/.test(listXml),
  { media: Object.keys(zip.files).filter((n) => n.startsWith('ppt/media/')), pic: /<p:pic/.test(tlXml) });
ok('U-30 时间线页不因形状触发降级（常规数据下版式本来就够）',
  !built.degradedPages.includes(2), built.degradedPages);
// T02171：计划超行数会展开时间线续页，「大纲第 n 页 = 第 n 张幻灯片」不再成立——
// 本节凡按页取 XML 的，都按渲染页序反查（续页归给它所属的时间线索引）。
const renderOf = (o: any[]) => M.expandTimelinePages(bundle, o) as any[];
const slideIdxOfOutline = (o: any[], oi: number) => renderOf(o.slice(0, oi + 1)).length - 1;
const tlSlideCount = renderOf(outline).length - outline.length;

ok('U-31 列表页仍出原生表格（本单接线没把别的页带崩）',
  /<a:tbl>/.test(await slideXml(slideIdxOfOutline(outline, 2) + 1)) && !/prst="diamond"/.test(await slideXml(slideIdxOfOutline(outline, 2) + 1)),
  { tlSlideCount });
ok('U-32 绘制前提缺失的整份稿：时间线页零菱形 + warnings 点名回落原因', await (async () => {
  const degraded = await M.buildKickoffPpt(bundleOf({ milestones: [] }), outline);
  const xml = await (await JSZip.loadAsync(degraded.buffer)).file('ppt/slides/slide2.xml')!.async('string');
  return !/prst="diamond"/.test(xml) && /<a:tbl>/.test(xml) && degraded.warnings.some((w) => /回落列表版/.test(w));
})());
ok('U-33 warnings 如实带上「缺日期/续页承载」的量（页面上看不出来的取舍要能被复核）',
  built.warnings.some((w: string) => /其余 \d+ 条计划超出本页可排行数/.test(w) || /折成页脚提示/.test(w) ||
    /条计划续排到下页/.test(w) || /缺起止日期/.test(w)),
  built.warnings.filter((w: string) => /时间线|页：/.test(w)));
ok('U-34 时间线页形状数随库内数据变化（不是写死的模板画）', await (async () => {
  const few = await M.buildKickoffPpt(bundleOf({ plans: bundle.plans.slice(0, 3), milestones: bundle.milestones.slice(0, 2) }), outline);
  const xml = await (await JSZip.loadAsync(few.buffer)).file('ppt/slides/slide2.xml')!.async('string');
  const sh = shapesIn(xml);
  return sh.filter((s) => s.prst === 'diamond').length === 2 && sh.filter((s) => s.prst === 'rect').length === 3;
})());
ok('U-35 时间线页越界时同样收敛到「标题+正文」：降级页不残留形状（验收 7 的不变量优先于甘特好看）', await (async () => {
  const long = await M.buildKickoffPpt(bundle, [
    outline[0],
    { section: '项目计划', title: `${'时间线'.repeat(11)}超长标题`, bullets: ['要点甲'], dataKeys: ['timeline'], layout: 'timeline' },
  ] as any[]);
  const xml = await (await JSZip.loadAsync(long.buffer)).file('ppt/slides/slide2.xml')!.async('string');
  return long.degradedPages.includes(2) && shapesIn(xml).length === 0 && !/<a:tbl>/.test(xml);
})());

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 't02100-gate-results.txt'), `T02100 时间线形状门：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`);
console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
