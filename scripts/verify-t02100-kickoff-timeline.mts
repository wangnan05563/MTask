/**
 * T02100 门：时间线形状绘制（PRD FR-4.5 / 技术方案 §4 时间线几何 / 验收 6）。
 *
 * 判据口径（T02293 改判，见 `docs/验收门判据规约.md`）：
 *  - **S 组不再是源码文本匹配**。每条都改成 `okPair`：行为侧量自**真产物**（解包 .pptx 的 slide XML：
 *    `<a:prstGeom>` 原生几何、EMU 逐条比对、`<p:pic>` 零内容贴图）与**独立复算**（拿 T02098 的
 *    `dateRangeOf/xAt/barBox/diamondBox/axisTicks` 自己算一遍期望坐标，再跟产物比），
 *    字面锚（`addShape`、`axisTicks(range, 4, bars)`、`时间线回落列表版` 等）只在行为侧绿时才算绿。
 *  - **抄在断言里的中文文案**（U-15/U-16/U-17/U-20/U-21/U-23/U-32/U-33）同样配行为侧：
 *    认的是「这条 note 里点名的是本轮夹具自己的数」（条数、并组数、剩余高度、页号由夹具反算），
 *    措辞换了拆包仍成立，字段丢了/数不对才算行为失守。
 *  - **配色单源**用内存改色证明：把 `PALETTE.brandBright/brandDeep` 临时改成另外两个色，重装的稿里
 *    条/菱形/轴的颜色必须随之改变，改回来必须与改前**逐字同一张 slide XML**（比 XML 文本，不比 zip 字节——
 *    两次构建的 docProps 时间戳必然不同）。
 *  - N 组负对照（判据 4）：上面每条改判都造一份「行为被破坏」的对照（注入菱形的降级页、把刻度搬到
 *    默认全宽框上、忽略 frame 的死参数副本、按等分而非日期映射的条位……），证明**同一条判据**会因此转红。
 *  - 产品源码一律读 `git show HEAD:<path>`（反模式 11：并发会话可能在工作树里留下过期副本）。
 *
 * 分组：
 *   S 组 契约守卫（真产物 XML × T02098 独立复算 × HEAD 字面锚）
 *   U 组 纯函数 + 真产物：日期范围/降级前提/条与菱形/轴刻度/同日挤道/缺日期不硬画/超行数如实折脚
 *   N 组 负对照
 *
 * 隔离纪律：不连生产库、不起服务、不调 AI（Bundle 由本门在脚本内自造，不复制任何存量业务数据）。
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02100-kickoff-timeline.mts
 * 结果落 .workbuddy/t02100-gate-results-<运行标识>.txt 与 t02100-timeline-<运行标识>.pptx（T02309 旁证同标识）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { writeGateResults, gateArtifactPath } from './lib/gate-results.mts';
import { okPair } from './lib/anchor-pair.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const skippedList: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};
const skipped = (name: string, why: string) => {
  skippedList.push(`${name}：${why}`);
  lines.push(`[SKIP] ${name} —— ${why}（不计 PASS）`);
};
const group = (t: string) => lines.push(`\n== ${t}`);

const M = await import('../server/src/services/kickoffBuilder.ts');
const LAY = await import('../server/src/services/kickoff-layout.ts');

// ---------- 产品源码（只取已提交树，用于字面锚腿） ----------
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const headSrc = (rel: string): string => {
  try { return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 }).toString('utf8'); }
  catch { return ''; }
};
const SRC = stripComments(headSrc('server/src/services/kickoffBuilder.ts'));
const LAYSRC = stripComments(headSrc('server/src/services/kickoff-layout.ts'));

// ---------- 产物解析工具（EMU 与形状口径单源在此） ----------
const EMU = 914400;
interface Sp {
  name: string; prst: string; off: number[]; ext: number[]; rawOff: string[];
  text: string; geom: boolean; el: string; spPr: string;
}
/**
 * 只数「真形状」：pptxgenjs 给文本盒也写 `prst="rect"`，按 prst 直接计数会把 4 个刻度
 * 文本也算成甘特条。库里形状名统一是 `Shape n`、文本是 `Text n`，以此区分。
 */
const spsIn = (xml: string): Sp[] =>
  xml.split('<p:sp>').slice(1).map((s) => {
    const end = s.indexOf('</p:sp>');
    const spPr = (s.match(/<p:spPr>[\s\S]*?<\/p:spPr>/) ?? [''])[0];
    return {
      prst: (s.match(/prst="([a-z]+)"/) ?? [])[1] ?? '',
      name: (s.match(/name="([^"]*)"/) ?? [])[1] ?? '',
      rawOff: (s.match(/<a:off x="(\d+)" y="(\d+)"\/>/) ?? []).slice(1),
      off: (s.match(/<a:off x="(\d+)" y="(\d+)"\/>/) ?? []).slice(1).map((v) => +v / EMU),
      ext: (s.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/) ?? []).slice(1).map((v) => +v / EMU),
      text: (s.match(/<a:t>([^<]*)/) ?? [])[1] ?? '',
      geom: /<a:prstGeom prst="[a-z]+"/.test(s),
      el: end >= 0 ? `<p:sp>${s.slice(0, end + 7)}` : '',
      spPr,
    };
  });
const shapesIn = (xml: string) => spsIn(xml).filter((o) => /^Shape\b/.test(o.name));
const textsIn = (xml: string) => spsIn(xml).filter((o) => /^Text\b/.test(o.name));
/** 一个形状元素 spPr 里出现过的全部 srgb 色值（填充与描边都算，去重） */
const colorsOf = (spPr: string) =>
  [...new Set((spPr.match(/val="([0-9A-Fa-f]{6})"/g) ?? []).map((v) => v.slice(5, 11).toUpperCase()))];
const close = (a: number, b: number, tol = 0.0015) => Math.abs(a - b) <= tol;

// ---------- 测试夹具（门内自造 Bundle，不读库） ----------
const DAY = 86400000;
const iso = (base: number, offDays: number) => new Date(base + offDays * DAY).toISOString().slice(0, 10);
const T0 = Date.UTC(2026, 0, 5);
const FX_PROJECT = 'T02100 夹具·启动会时间线';
const FX_WORKSPACE = ROOT;
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
  project: { id: 'p1', name: FX_PROJECT, workspacePath: FX_WORKSPACE },
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
    projectId: 'p1', projectName: FX_PROJECT, blocked: false, missingHard: [], workloadSource: 'estimate',
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

// ---------- 模型侧预计算（U 组与 S 组共用同一份判据函数） ----------
const tl = M.timelineBlocks(bundle, frame);
const bars = tl.blocks.filter((x: any) => x.shape?.kind === 'rect');
const diams = tl.blocks.filter((x: any) => x.shape?.kind === 'diamond');
const axis = tl.blocks.find((x: any) => x.shape?.kind === 'line');
const ticks = tl.blocks.filter((x: any) => x.text && /^\d+\/\d+$/.test(x.text.content));
const tlItem = { section: '项目计划', title: '项目计划时间线', bullets: [], dataKeys: ['timeline'], layout: 'timeline' } as any;
const laid = M.layoutBody(tlItem, bundle, LAY.framesFor('data', 'timeline'), []);
const outline = [
  { section: '封面', title: `${FX_PROJECT} 项目启动会`, bullets: [], dataKeys: [], layout: 'cover' },
  tlItem,
  { section: '项目计划', title: '里程碑', bullets: [], dataKeys: ['milestones'], layout: 'table' },
] as any[];
// T02171：计划超行数会展开时间线续页，「大纲第 n 页 = 第 n 张幻灯片」不再成立——
// 本节凡按页取 XML 的，都按渲染页序反查（续页归给它所属的时间线索引）。
const renderOf = (o: any[]) => M.expandTimelinePages(bundle, o) as any[];
const slideIdxOfOutline = (o: any[], oi: number) => renderOf(o.slice(0, oi + 1)).length - 1;
const RENDER_PAGES = renderOf(outline);
const isTlPage = (p: any) => p.layout === 'timeline' && (p.dataKeys ?? []).includes('timeline');
/** 时间线首页的页号（渲染序，1 起）——降级 warning 里的「第 n 页」按这个数点 */
const TL_RENDER_NO = RENDER_PAGES.findIndex(isTlPage) + 1;
/** 时间线族全部渲染页的页号（续页也在内） */
const TL_PAGE_NOS = RENDER_PAGES.map((p, i) => (isTlPage(p) ? i + 1 : 0)).filter((n) => n > 0);

// ---------- 真产物：装一份稿并解包 ----------
const unzipSlide = async (buf: Uint8Array | Buffer, n: number) =>
  await (await JSZip.loadAsync(buf)).file(`ppt/slides/slide${n}.xml`)!.async('string');
const built = await M.buildKickoffPpt(bundle, outline);
writeFileSync(gateArtifactPath(OUT_DIR, 't02100-timeline.pptx'), built.buffer);
const zip = await JSZip.loadAsync(built.buffer);
const slideXml = async (n: number) => await zip.file(`ppt/slides/slide${n}.xml`)!.async('string');
const coverXml = await slideXml(1);
const tlXml = await slideXml(TL_RENDER_NO);
const listXml = await slideXml(3);
const tlShapes = shapesIn(tlXml);
const tlBars = tlShapes.filter((s) => s.prst === 'rect');
const tlDiams = tlShapes.filter((s) => s.prst === 'diamond');
const tlAxis = tlShapes.filter((s) => s.prst === 'line');
const renderDeck = async (b: any) => {
  const d = await M.buildKickoffPpt(b, outline);
  return { built: d, xml: await unzipSlide(d.buffer, TL_RENDER_NO) };
};

/** 把某个已知形状元素的 x 改成新值（负对照专用：只动产物文本，不动产品源码） */
const setSpX = (xml: string, sp: Sp, newX: number) => {
  const needle = `<a:off x="${sp.rawOff[0]}" y="${sp.rawOff[1]}"/>`;
  return xml.includes(needle) ? xml.replace(needle, `<a:off x="${Math.round(newX * EMU)}" y="${sp.rawOff[1]}"/>`) : xml;
};

// ======================= 判据函数（S/U 与 N 组共用同一份，负对照才算证明） =======================
/** 轴带（条形区）直接从产物上的轴线读，不抄 TL_LABEL_W/TL_LABEL_GAP 常量 */
const bandFromXml = (xml: string) => {
  const ln = shapesIn(xml).find((s) => s.prst === 'line');
  return ln ? { x: ln.off[0], y: ln.off[1], w: ln.ext[0], h: ln.ext[1] } : null;
};
const orderedPlans = (b: any) =>
  [...b.plans].sort((p: any, q: any) => (p.start_date || '9999-12-31').localeCompare(q.start_date || '9999-12-31') || p.sort_order - q.sort_order);
/** 期望条位：`mode=linear` 用 T02098 的 `xAt` 线性映射；`mode=even` 是「按行等分」的反例 */
const expectBars = (b: any, band: { x: number; w: number }, n: number, mode: 'linear' | 'even' = 'linear') => {
  const range = LAY.dateRangeOf(b.plans);
  if (!range) return [];
  return orderedPlans(b).slice(0, n).map((p: any, i: number) => {
    if (mode === 'even') return { x: band.x + (band.w * i) / n, w: band.w / n };
    const x1 = LAY.xAt(Date.parse(p.start_date), range, band as any);
    const x2 = LAY.xAt(Date.parse(p.end_date), range, band as any);
    return { x: x1, w: Math.max(x2 - x1, 0.06) };
  });
};
/** 期望菱形：`diamondBox` 逐枚算位，同日挤在一起的按 `findOverlaps` 并成一枚（与产品并组口径同一套原语） */
const expectDiamonds = (b: any, band: { x: number; y: number; w: number; h: number }) => {
  const range = LAY.dateRangeOf(b.plans);
  if (!range) return [];
  const times = b.milestones.map((m: any) => Date.parse(m.end_date || m.start_date || '')).filter(Number.isFinite).sort((a: number, c: number) => a - c);
  const out: Array<{ x: number; w: number }> = [];
  for (const t of times) {
    const box = LAY.diamondBox(t, range, band as any, band.y);
    const last = out.at(-1);
    if (last && LAY.findOverlaps([last as any, box]).length > 0) continue;
    out.push(box);
  }
  return out;
};
const tickBoxXs = (range: any, band: { x: number; w: number }, frameBox: { x: number; w: number }) =>
  LAY.axisTicks(range, 4, frameBox as any).map((t) => Math.min(t.x, band.x + band.w - 0.62));
const tickLabels = (range: any, band: { x: number; w: number }, frameBox: { x: number; w: number }) =>
  LAY.axisTicks(range, 4, frameBox as any).map((t) => t.label);

/** 判据 A：整页是原生几何而非贴图，且每个形状都带可编辑的 prstGeom + offset/ext */
const nativeShapeJudge = (xml: string) => {
  const sh = shapesIn(xml);
  return (
    sh.length > 0 &&
    sh.every((s) => s.geom && s.off.length === 2 && s.ext.length === 2 && ['rect', 'diamond', 'line'].includes(s.prst)) &&
    new Set(sh.map((s) => s.prst)).size >= 3 &&
    !/<p:pic/.test(xml) &&
    !sh.some((s) => /<a:blipFill|<a:blip /.test(s.spPr)) &&
    (xml.match(/r:embed="/g) ?? []).length === (xml.match(/<p:bg>/g) ?? []).length
  );
};
/** 判据 B：产物上的条/菱形/刻度位置 = T02098 原语按本轮 Bundle 独立复算的结果 */
const geomJudge = (xml: string, b: any) => {
  const band = bandFromXml(xml);
  if (!band || band.w <= 0) return false;
  const range = LAY.dateRangeOf(b.plans);
  if (!range) return false;
  const sh = shapesIn(xml);
  const gotBars = sh.filter((s) => s.prst === 'rect').map((s) => ({ x: s.off[0], w: s.ext[0] }));
  const gotDiams = sh.filter((s) => s.prst === 'diamond').map((s) => ({ x: s.off[0], w: s.ext[0] }));
  const gotTicks = textsIn(xml).filter((t) => /^\d+\/\d+$/.test(t.text));
  const expBars = expectBars(b, band, gotBars.length, 'linear');
  const expDiams = expectDiamonds(b, band);
  const expTickX = tickBoxXs(range, band, band);
  const expTickLabel = tickLabels(range, band, band);
  return (
    gotBars.length > 0 && gotBars.length === expBars.length &&
    expBars.every((e, i) => close(e.x, gotBars[i].x) && close(e.w, gotBars[i].w)) &&
    gotDiams.length === expDiams.length && expDiams.every((e, i) => close(e.x, gotDiams[i].x) && close(e.w, gotDiams[i].w)) &&
    gotTicks.length === expTickX.length &&
    expTickX.every((e, i) => close(e, gotTicks[i].off[0])) &&
    expTickLabel.every((l, i) => l === gotTicks[i].text)
  );
};
/** 判据 C：刻度贴的是条形区（轴线所在带），不是内容框全宽——两种框必须真的给出不同的格子 */
const tickAlignJudge = (xml: string, b: any) => {
  const band = bandFromXml(xml);
  if (!band) return false;
  const range = LAY.dateRangeOf(b.plans);
  if (!range) return false;
  const got = textsIn(xml).filter((t) => /^\d+\/\d+$/.test(t.text)).map((t) => t.off[0]);
  const onBand = tickBoxXs(range, band, band);
  const onDefault = tickBoxXs(range, band, LAY.getContentFrame());
  return (
    got.length === 4 &&
    onBand.every((e, i) => close(e, got[i])) &&
    got.every((g) => g >= band.x - 0.0015 && g <= band.x + band.w - 0.6 + 0.0015) &&
    !onDefault.every((e, i) => close(e, got[i]))
  );
};
/** 判据 D：颜色按「角色」取自 PALETTE——条走 brandBright，菱形与轴走 brandDeep */
const colorJudge = (xml: string, barColor: string, deepColor: string) => {
  const sh = shapesIn(xml);
  const rects = sh.filter((s) => s.prst === 'rect');
  const ds = sh.filter((s) => s.prst === 'diamond');
  const ln = sh.filter((s) => s.prst === 'line');
  return (
    rects.length > 0 && ds.length > 0 && ln.length > 0 &&
    rects.every((s) => colorsOf(s.spPr).includes(barColor)) &&
    [...ds, ...ln].every((s) => colorsOf(s.spPr).includes(deepColor)) &&
    !rects.some((s) => colorsOf(s.spPr).includes(deepColor))
  );
};
/** 判据 E：绘制前提缺失 → 整页零形状 + 出表格 + warning 点名是哪一页、缺的是哪一样 */
const degradeJudge = (r: { xml: string; built: any }, b: any, reason: string, pageNo: number) =>
  reason.trim() !== '' &&
  shapesIn(r.xml).length === 0 &&
  /<a:tbl>/.test(r.xml) &&
  r.built.warnings.some((w: string) => w.includes(reason) && w.includes(`第 ${pageNo} 页`)) &&
  M.timelineDegradeReason(b) === reason;

/** note 里的数按「独立 token」认（前后不接数字），否则「12」会把「1」蒙过去 */
const numberAppears = (note: string, n: number) => new RegExp(`(?<!\\d)${n}(?!\\d)`).test(note);
const legendOf = (r: any) => r.blocks.find((x: any) => x.text && /里程碑/.test(x.text.content))?.text?.content ?? '';

/** 判据 F：复算对上了还不算完——本层若自带 span 比例，产物会同时满足两套算式；
 *  「按行等分」这套反算式必须**对不上**产物，否则判据分不清日期映射与行序等分。 */
const evenSpacedMismatch = (xml: string, b: any) => {
  const band = bandFromXml(xml);
  if (!band) return false;
  const got = shapesIn(xml).filter((s) => s.prst === 'rect').map((s) => ({ x: s.off[0], w: s.ext[0] }));
  if (got.length < 2) return false;
  const even = expectBars(b, band, got.length, 'even');
  return !even.every((e, i) => close(e.x, got[i].x));
};

// 降级轨的两份产物（行为侧要的东西先量好，判据函数才保持同步）
const NO_MS = bundleOf({ milestones: [] });
const NO_MS_REASON = M.timelineDegradeReason(NO_MS) ?? '';
const NO_DATES = bundleOf({ plans: bundle.plans.map((p: any) => ({ ...p, start_date: '', end_date: '' })) });
const NO_DATES_REASON = M.timelineDegradeReason(NO_DATES) ?? '';
const degMs = await renderDeck(NO_MS);
const degDt = await renderDeck(NO_DATES);

// 改色轨：内存改 PALETTE → 重装 → 还原 → 再装（比 slide XML 文本，不比 zip 字节）
const PAL = LAY.PALETTE as any;
const PAL_BAR = String(PAL.brandBright).toUpperCase();
const PAL_DEEP = String(PAL.brandDeep).toUpperCase();
const altCandidates = ['134FA0', '0E4C8A', '1F3C78', '2B5EA7', '3A2E8C', '175B8F', '0B4FBF', '24594D', '6B2B6B', '4A2E1F'];
/** 取一个「既不在现调色板里、又保持可读对比」的替代色——值级巧合（改成的色与角色同色）不算单源证明 */
const altPick = (exclude: string[]) =>
  altCandidates.find((c) => ![...Object.values(PAL).map((v) => String(v).toUpperCase()), ...exclude].includes(c) &&
    LAY.assertContrast(c, PAL.paper) === null && LAY.assertContrast(PAL.onBrand, c) === null)
  ?? altCandidates.find((c) => ![...Object.values(PAL).map((v) => String(v).toUpperCase()), ...exclude].includes(c)) ?? '';
const ALT_BAR = altPick([]);
const ALT_DEEP = altPick([ALT_BAR]);
let altXml = '';
let backXml = '';
let inkXml = '';
if (ALT_BAR && ALT_DEEP) {
  const snapBar = PAL.brandBright;
  const snapDeep = PAL.brandDeep;
  PAL.brandBright = ALT_BAR;
  PAL.brandDeep = ALT_DEEP;
  altXml = (await renderDeck(bundle)).xml;
  PAL.brandBright = snapBar;
  PAL.brandDeep = snapDeep;
  backXml = (await renderDeck(bundle)).xml;
}
{
  const snapInk = PAL.ink;
  PAL.ink = ALT_BAR || '134FA0';
  inkXml = (await renderDeck(bundle)).xml;
  PAL.ink = snapInk;
}

// ======================= S 组：契约守卫（真产物 × 独立复算 × HEAD 字面锚） =======================
group('S 组 契约守卫（产物 XML × T02098 复算 × HEAD 字面锚）');
okPair(ok, 'S-01 形状走原生 addShape，不退回贴图（验收 5/6：PowerPoint 里可拖拽改）',
  // 行为侧：解包真稿的时间线页，逐个形状必须有 `<a:prstGeom prst="rect|diamond|line">` + offset/ext，
  // 三类几何齐备，且全页零 `<p:pic>`、形状 spPr 内零 `<a:blipFill>`；整份稿三页都不含内容图
  () => nativeShapeJudge(tlXml) &&
    [coverXml, tlXml, listXml].every((x) => !/<p:pic/.test(x)) &&
    [coverXml, tlXml, listXml].every((x) => (x.match(/r:embed="/g) ?? []).length === (x.match(/<p:bg>/g) ?? []).length),
  () => /slide\.addShape\(/.test(SRC) && !/addImage\(/.test(SRC) && !/<p:pic>/.test(SRC),
  () => ({ 形状数: shapesIn(tlXml).length, 几何种: [...new Set(shapesIn(tlXml).map((s) => s.prst))], 位图: /<p:pic/.test(tlXml) }));

okPair(ok, 'S-02 日期→坐标的线性映射全部委托 T02098（本层不自己算 span 比例）',
  // 行为侧：拿 T02098 的 `dateRangeOf/xAt/diamondBox/axisTicks` 按本轮 Bundle 独立复算一遍，
  // 产物里每条计划条的 x/宽、每枚菱形的 x、每格刻度的 x 与 M/D 标签都必须逐条对上（EMU 容差 0.0015"）
  () => geomJudge(tlXml, bundle) && evenSpacedMismatch(tlXml, bundle),
  () => /dateRangeOf\(/.test(SRC) && /barBox\(/.test(SRC) && /diamondBox\(/.test(SRC) && /axisTicks\(/.test(SRC) &&
    !/\(range\.max - range\.min\)/.test(SRC) && !/86400000/.test(SRC),
  () => {
    const band = bandFromXml(tlXml);
    const got = shapesIn(tlXml).filter((s) => s.prst === 'rect').map((s) => [+s.off[0].toFixed(3), +s.ext[0].toFixed(3)]);
    return { 条形区: band, 产物前3条: got.slice(0, 3), 复算前3条: expectBars(bundle, band!, 3).map((e) => [+e.x.toFixed(3), +e.w.toFixed(3)]), 等分反算前3条: expectBars(bundle, band!, 3, 'even').map((e) => [+e.x.toFixed(3), +e.w.toFixed(3)]) };
  });

okPair(ok, 'S-03 形状配色只走 PALETTE 单源（门禁 6：改单源就跟着改，改回来逐字同图）',
  // 行为侧：内存里把 brandBright/brandDeep 换成另两个色 → 重装稿，条全部变新条色、菱形与轴变新深色，
  // 原条色在产物里零残留；还原后重装的 slide XML 必须与还原前**逐字相同**（只动了调色板、没留残渣）；
  // 改一个时间线用不到的角色色（ink）不许改变条/菱形配色（值级巧合不算单源）
  () => !!ALT_BAR && !!ALT_DEEP && colorJudge(tlXml, PAL_BAR, PAL_DEEP) &&
    colorJudge(altXml, ALT_BAR, ALT_DEEP) &&
    !shapesIn(altXml).filter((s) => s.prst === 'rect').some((s) => colorsOf(s.spPr).includes(PAL_BAR)) &&
    backXml === tlXml &&
    colorJudge(inkXml, PAL_BAR, PAL_DEEP),
  () => !/["'#][0-9a-fA-F]{6}/.test(SRC) && /PALETTE\.(accent|warn|ink)/.test(SRC),
  () => ({ 单源条色: PAL_BAR, 单源菱形色: PAL_DEEP, 改色后条色: ALT_BAR, 改色后菱形色: ALT_DEEP, 还原后XML与原件逐字相同: backXml === tlXml }));

okPair(ok, 'S-04 轴刻度对齐条形栏框（用默认全宽框会整体错位）',
  // 行为侧：刻度 x 逐格等于「以产物轴线所在带为框」复算的格子，且**不等于**「以内容框全宽为框」的格子
  // （两套格子必须真的不同，否则这条判据分不清用了哪个框）
  () => tickAlignJudge(tlXml, bundle),
  () => /axisTicks\(range, 4, bars\)/.test(SRC),
  () => {
    const band = bandFromXml(tlXml)!;
    const range = LAY.dateRangeOf(bundle.plans)!;
    return { 条形区格子: tickBoxXs(range, band, band).map((v) => +v.toFixed(3)), 全宽框格子: tickBoxXs(range, band, LAY.getContentFrame()).map((v) => +v.toFixed(3)) };
  });

okPair(ok, 'S-05 时间线前提缺失走「如实降级 + 带原因」通道，不静默出假甘特',
  // 行为侧：两种缺前提的 Bundle 各自成稿——时间线页零形状、出原生表格、warnings 里点名
  // 「第几页 + 缺的是哪一样」，且两个原因互不相同（同一句套话覆盖不了两种缺数）
  () => degradeJudge(degMs, NO_MS, NO_MS_REASON, TL_RENDER_NO) &&
    degradeJudge(degDt, NO_DATES, NO_DATES_REASON, TL_RENDER_NO) &&
    NO_MS_REASON !== NO_DATES_REASON &&
    shapesIn(tlXml).length > 0,
  () => /timelineDegradeReason\(/.test(SRC) && /时间线回落列表版/.test(SRC) && /notes\.push\(/.test(SRC),
  () => ({ 首页形状: shapesIn(degMs.xml).length, 表格: /<a:tbl>/.test(degMs.xml), 原因: [NO_MS_REASON, NO_DATES_REASON], warnings: degMs.built.warnings }));

okPair(ok, 'S-06 版式层把轴刻度框参数化（否则 T02100 只能散写坐标）',
  // 行为侧：同一个 range 换两个框调用 `axisTicks`，返回位置必须精确跟随所给框（x/w 线性落位），
  // 且不传框时等于内容框口径；「忽略 frame 的死参数副本」给出的是另一套格子——判据能区分两者
  () => {
    const range = LAY.dateRangeOf(bundle.plans)!;
    const A = { x: 1, y: 1, w: 6, h: 0.2 };
    const B = { x: 0.5, y: 2, w: 3, h: 0.2 };
    const follow = (ticks: any[], f: any) => ticks.length === 3 && ticks.every((t, i) => close(t.x, f.x + (f.w * i) / 2, 1e-9));
    const dead = LAY.axisTicks(range, 3); // 与 axisTicks(range,3,A) 不同 ⇒ 参数真被消费
    return follow(LAY.axisTicks(range, 3, A as any), A) && follow(LAY.axisTicks(range, 3, B as any), B) &&
      follow(LAY.axisTicks(range, 3), LAY.getContentFrame()) &&
      dead.some((t, i) => !close(t.x, 1 + (6 * i) / 2, 1e-9));
  },
  () => /export function axisTicks\(range: DateRange, count = 4, frame: Box = getContentFrame\(\)\)/.test(LAYSRC),
  () => {
    const range = LAY.dateRangeOf(bundle.plans)!;
    return { 带A: LAY.axisTicks(range, 3, { x: 1, y: 1, w: 6, h: 0.2 } as any).map((t) => +t.x.toFixed(3)), 不带框: LAY.axisTicks(range, 3).map((t) => +t.x.toFixed(3)) };
  });

// ======================= U 组：绘制前提 =======================
group('U 组 绘制前提（纯函数行为）');
ok('U-01 日期齐备 + 有里程碑 → 用形状版（前提成立时不降级）', M.timelineDegradeReason(bundle) === null, M.timelineDegradeReason(bundle));
okPair(ok, 'U-02 计划全无起止日期 → 点名缺起止日期（P3 口径，不画猜出来的工期）',
  // 行为侧：`dateRangeOf` 独立复算为 null ⇒ 前提判据必须给出原因，且这页真的不出形状
  () => LAY.dateRangeOf(NO_DATES.plans) === null && NO_DATES_REASON.trim() !== '' && shapesIn(degDt.xml).length === 0,
  () => /起止日期/.test(NO_DATES_REASON), NO_DATES_REASON);
okPair(ok, 'U-03 里程碑 0 个 → 点名降级（P4 口径：验收 6 的菱形无从存在）',
  // 行为侧：日期范围仍算得出（缺的是里程碑），原因串与「缺日期」那条不同，且产物里零菱形
  () => LAY.dateRangeOf(NO_MS.plans) !== null && NO_MS_REASON.trim() !== '' && NO_MS_REASON !== NO_DATES_REASON &&
    !/prst="diamond"/.test(degMs.xml) && NO_MS.milestones.length === 0,
  () => /里程碑为 0/.test(NO_MS_REASON), NO_MS_REASON);
ok('U-04 部分行缺日期也只降级那一行：整体前提仍成立',
  M.timelineDegradeReason(bundleOf({ plans: [{ ...bundle.plans[0], start_date: '', end_date: '' }, ...bundle.plans.slice(1)] })) === null);

// ---------- U 组：形状几何 ----------
group('U 组 形状几何');
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
ok('U-10 条宽按工期线性可比：5 天条 < 8 天条 < 11 天条（同一比例尺）', () => {
  const w = (d: number) => {
    const r = M.timelineBlocks(bundleOf({ plans: [
      { ...bundle.plans[0], start_date: '2026-01-05', end_date: iso(T0, d) },
      { ...bundle.plans[1], start_date: '2026-01-05', end_date: '2026-02-20' },
    ] }), frame);
    return r.blocks.find((x: any) => x.shape?.kind === 'rect').box.w;
  };
  return w(10) < w(20) && w(20) < w(40);
});
ok('U-11 条高 = TIMELINE_BAR_H 单源（不散写 0.18）', bars.every((x: any) => Math.abs(x.box.h - LAY.TIMELINE_BAR_H) < 1e-9));
ok('U-12 菱形全部骑在轴线高带上（中心不偏离轴 > 一个条高）', () => {
  const axisY = (axis as any).box.y;
  return diams.every((d: any) => Math.abs(d.box.y + d.box.h / 2 - axisY) <= LAY.TIMELINE_BAR_H * 1.6);
});
ok('U-13 画出的菱形两两不重叠（同日挤不下就下移或计数，不叠成一坨）',
  LAY.findOverlaps(diams.map((d: any) => d.box)).length === 0, LAY.findOverlaps(diams.map((d: any) => d.box)).length);
ok('U-14 正常数据零越界点名（violations 为空即整页不降级）', tl.violations.length === 0, tl.violations);
const sameDay = bundleOf({ milestones: Array.from({ length: 12 }, (_, i) => ({ ...msRow(0), id: `s${i}` })) });
okPair(ok, 'U-15 同日里程碑并成一枚菱形：一个都不少画，也不叠成一坨（图上菱形数 ≠ 库内数时必须有说法）',
  // 行为侧：画的 1 枚 + 并掉的 11 枚 = 夹具里的 12 个（数量守恒由夹具反算，不认句子写法）；
  // 图例里出现的两个数恰是「库内总数」与「并后组数」，且菱形两两不重叠
  () => {
    const r = M.timelineBlocks(sameDay, frame);
    const drawn = r.blocks.filter((x: any) => x.shape?.kind === 'diamond');
    const note = legendOf(r);
    return drawn.length === 1 && r.mergedMilestones === 11 && drawn.length + r.mergedMilestones === sameDay.milestones.length &&
      numberAppears(note, sameDay.milestones.length) && numberAppears(note, drawn.length) &&
      LAY.findOverlaps(drawn.map((d: any) => d.box)).length === 0;
  },
  () => /◆ 里程碑 12 个（同日并成 1 组）/.test(legendOf(M.timelineBlocks(sameDay, frame))),
  () => { const r = M.timelineBlocks(sameDay, frame); return { 画了: r.blocks.filter((x: any) => x.shape?.kind === 'diamond').length, 并掉: r.mergedMilestones, 库内: sameDay.milestones.length }; });
okPair(ok, 'U-15b 日期分得开的里程碑逐个成菱形，图例不多写「并组」',
  // 行为侧：并组数为 0 ⇒ 菱形数恰等于库内数，图例里只有那一个数、没有第二种计数
  () => {
    const r = M.timelineBlocks(bundle, frame);
    const note = legendOf(r);
    return r.mergedMilestones === 0 && r.blocks.filter((x: any) => x.shape?.kind === 'diamond').length === bundle.milestones.length &&
      numberAppears(note, bundle.milestones.length) && !/并成/.test(note);
  },
  () => (M.timelineBlocks(bundle, frame).blocks.find((x: any) => x.text?.content === `◆ 里程碑 ${bundle.milestones.length} 个`)?.text?.content) === `◆ 里程碑 ${bundle.milestones.length} 个`,
  () => M.timelineBlocks(bundle, frame).blocks.find((x: any) => /里程碑/.test(x.text?.content ?? ''))?.text?.content);
okPair(ok, 'U-16 缺起止日期的行不画条，改为在该行的条形区原位给一个占位块',
  // 行为侧：3 条计划里清空 1 条 ⇒ 只画 2 个 rect，缺的那条在轴线所在带（bars.x）上留一个等高占位文本块，
  // 占位块数 = 清空数（认的是「少了的条有没有被如实说一声」，不是那句中文）
  () => {
    const r = M.timelineBlocks(bundleOf({ plans: [{ ...bundle.plans[0], start_date: '', end_date: '' }, bundle.plans[1], bundle.plans[2]] }), frame);
    const bandX = r.blocks.find((x: any) => x.shape?.kind === 'line')?.box.x ?? NaN;
    const rects = r.blocks.filter((x: any) => x.shape?.kind === 'rect');
    const ph = r.blocks.filter((x: any) => x.text && Math.abs(x.box.x - bandX) < 1e-9 && Math.abs(x.box.h - LAY.TIMELINE_BAR_H) < 1e-9);
    return r.undated === 1 && rects.length === 2 && ph.length === 1;
  },
  () => (M.timelineBlocks(bundleOf({ plans: [{ ...bundle.plans[0], start_date: '', end_date: '' }, bundle.plans[1], bundle.plans[2]] }), frame).blocks
    .some((x: any) => x.text?.content === '无起止日期')),
  () => { const r = M.timelineBlocks(bundleOf({ plans: [{ ...bundle.plans[0], start_date: '', end_date: '' }, bundle.plans[1], bundle.plans[2]] }), frame); return { 占位: r.blocks.filter((x: any) => x.text && x.text.content.includes('起止')).map((x: any) => x.text.content) }; });
okPair(ok, 'U-17 超行数的计划折进页脚提示，条数不硬塞（塞了就是压扁的纸片条）',
  // 行为侧：overflow 由「库内条数 − 实绘 − 缺日期」反算得出，页脚那一条里出现的数必须等于它；
  // 行数钳在上限内（塞满了就不可能还有剩余）
  () => {
    // 页脚那条 = 版面底部、横贯整宽的文本块；它里面点的数必须是「库内 − 实绘 − 缺日期」
    const noteBlock = tl.blocks.find((x: any) => x.text && Math.abs(x.box.w - frame.w) < 1e-6 && x.box.y + x.box.h >= frame.y + frame.h - 0.06);
    const note = noteBlock?.text?.content ?? '';
    const calc = bundle.plans.length - bars.length - tl.undated;
    return tl.overflow > 0 && tl.overflow === calc && numberAppears(note, calc) &&
      bars.length + tl.undated <= Math.min(bundle.plans.length, 8);
  },
  () => /其余 \d+ 条计划未绘出/.test(tl.blocks.map((x: any) => x.text?.content ?? '').join('\n')),
  () => ({ 实绘: bars.length, 缺日期: tl.undated, overflow: tl.overflow }));
ok('U-18 单侧行（起点=终点）也给出可辨宽度（不画成 0 宽的看不见的条）', () => {
  const r = M.timelineBlocks(bundleOf({ plans: [{ ...bundle.plans[0], start_date: '2026-01-05', end_date: '2026-01-05' }, bundle.plans[1]] }), frame);
  return r.blocks.filter((x: any) => x.shape?.kind === 'rect').every((b: any) => b.box.w >= 0.06);
});

// ---------- U 组：整页排布接线 ----------
group('U 组 整页排布接线');
ok('U-19 时间线页排布产出形状块，不再同时挂列表表格（两种形态不重复占版面）',
  laid.blocks.some((x: any) => x.shape) && laid.blocks.every((x: any) => !x.table), { shapes: laid.blocks.filter((x: any) => x.shape).length });
okPair(ok, 'U-20 前提缺失时整页回落列表表格，notes 点名原因（面板可复核「为什么这页是列表」）',
  // 行为侧：形状块 0、表格块 1、notes 非空且与 `timelineDegradeReason` 同源（缺哪种说哪种），
  // 并带上所缺量的数字（里程碑 0 个 ⇒ 0 来自夹具本身）
  () => {
    const r = M.layoutBody(tlItem, NO_MS, LAY.framesFor('data', 'timeline'), []);
    const joined = r.notes.join('');
    return r.blocks.every((x: any) => !x.shape) && r.blocks.some((x: any) => x.table) &&
      r.notes.length > 0 && joined.includes(NO_MS_REASON) && joined.includes(String(NO_MS.milestones.length));
  },
  () => /回落列表版/.test(M.layoutBody(tlItem, NO_MS, LAY.framesFor('data', 'timeline'), []).notes.join('')),
  () => M.layoutBody(tlItem, NO_MS, LAY.framesFor('data', 'timeline'), []).notes);
okPair(ok, 'U-21 版面高度不足以容纳「轴 + 2 行」时同样回落，不硬画半个甘特',
  // 行为侧：把 body 高压到 1.0"（夹具自己给的数），形状块必须为 0，且 note 里出现的剩余高度
  // 等于夹具给的那个数——写死一句话过不了这一关
  () => {
    const tiny = { ...LAY.framesFor('data', 'timeline'), body: { x: frame.x, y: frame.y, w: frame.w, h: 1.0 } };
    const r = M.layoutBody(tlItem, bundle, tiny as any, []);
    const joined = r.notes.join('');
    return r.blocks.every((x: any) => !x.shape) && r.notes.length > 0 && joined.includes((1.0).toFixed(2)) &&
      /[\d.]+/.test(joined);
  },
  () => /剩余高度/.test(M.layoutBody(tlItem, bundle, { ...LAY.framesFor('data', 'timeline'), body: { x: frame.x, y: frame.y, w: frame.w, h: 1.0 } } as any, []).notes.join('')),
  () => M.layoutBody(tlItem, bundle, { ...LAY.framesFor('data', 'timeline'), body: { x: frame.x, y: frame.y, w: frame.w, h: 1.0 } } as any, []).notes);
ok('U-22 菱形骑轴不被误判重叠（参照线排除，否则每页都是假越界）',
  M.pageViolations(LAY.framesFor('data', 'timeline').title, '项目计划时间线', laid.blocks, 22).length === 0,
  M.pageViolations(LAY.framesFor('data', 'timeline').title, '项目计划时间线', laid.blocks, 22));
okPair(ok, 'U-23 越界的形状块会被点名成形状而非笼统文本',
  // 行为侧：同一个越界盒，作为形状与作为文本各判一次——两条违规串必须分别带上各自的元素名，
  // 且都点名到这个盒自己的坐标（产品报的是越界边 y+h，不是 y；数字从夹具反算，不写死）
  () => {
    const badBox = { x: 0.5, y: 5.2, w: 1, h: 0.18 };
    const tag = (badBox.y + badBox.h).toFixed(2);
    const asShape = M.pageViolations(LAY.framesFor('data').title, 't', [{ box: badBox, shape: { kind: 'rect', tone: 'bar' } }] as any, 22);
    const asText = M.pageViolations(LAY.framesFor('data').title, 't', [{ box: badBox, text: { content: 'x', pt: 14 } }] as any, 22);
    const asWide = M.pageViolations(LAY.framesFor('data').title, 't', [{ box: { x: 9.9, y: 3, w: 1, h: 0.2 }, shape: { kind: 'rect', tone: 'bar' } }] as any, 22);
    return asShape.length === 1 && asText.length === 1 && asShape[0] !== asText[0] &&
      asShape[0].includes('形状') && asText[0].includes('文本') &&
      asShape[0].includes(tag) && asText[0].includes(tag) &&
      asWide.length === 1 && asWide[0].includes('形状') && asWide[0].includes((9.9 + 1).toFixed(2));
  },
  () => /function blockKindLabel\(blk: Block\): string/.test(SRC) &&
    /if \(blk\.shape\) return '形状'/.test(SRC) && /return '文本'/.test(SRC) &&
    /blockBoundsIssues\(blocks\)/.test(SRC),
  () => M.pageViolations(LAY.framesFor('data').title, 't', [{ box: { x: 0.5, y: 5.2, w: 1, h: 0.18 }, shape: { kind: 'rect', tone: 'bar' } }] as any, 22));
ok('U-24 非时间线页不受本单接线影响（列表页 dataKeys 照常出表格）',
  M.layoutBody({ section: '正文', title: '计划列表', bullets: [], dataKeys: ['timeline'], layout: 'table' } as any, bundle, LAY.framesFor('data'), []).blocks.some((x: any) => x.table));
ok('U-24b layout 只是版式族：不挂 timeline 数据键就不该抢画甘特（否则覆盖率页会变成时间线）',
  M.layoutBody({ section: '正文', title: '用例覆盖', bullets: [], dataKeys: ['coverage'], layout: 'timeline' } as any, bundle, LAY.framesFor('data', 'timeline'), []).blocks
    .every((x: any) => !x.shape));

// ---------- U 组：真产物解包（原生形状只能由产物证明） ----------
group('U 组 真产物解包');
ok('U-25 产物里时间线页确有原生几何：rect 条 + diamond 菱形 + line 轴三类齐备（不是截图）',
  tlBars.length > 0 && tlDiams.length > 0 && tlAxis.length === 1,
  { rect: tlBars.length, diamond: tlDiams.length, line: tlAxis.length });
const TL_RECTS = await Promise.all(TL_PAGE_NOS.map(async (n) => shapesIn(await unzipSlide(built.buffer, n)).filter((s) => s.prst === 'rect').length));
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
ok('U-29 整份稿不含内容图片（验收 5 的反面：不许整页贴图）',
  // T02156：允许 `<p:bg>` 背景图（恒生模板版式资产——背景是版式不是内容）。
  // 判据相应收紧为「内容零位图」：无 <p:pic>，且 slide 里每个 r:embed 都来自 <p:bg>；
  // pptxgenjs 会留一个空的 `ppt/media/` 目录项，那不算贴图
  [coverXml, tlXml, listXml].every((x) => !/<p:pic/.test(x)) &&
    [coverXml, tlXml, listXml].every((x) => (x.match(/r:embed="/g) ?? []).length === (x.match(/<p:bg>/g) ?? []).length),
  { media: Object.keys(zip.files).filter((n) => n.startsWith('ppt/media/')), pic: /<p:pic/.test(tlXml) });
ok('U-30 时间线页不因形状触发降级（常规数据下版式本来就够）',
  !built.degradedPages.includes(TL_RENDER_NO), built.degradedPages);
const tlSlideCount = renderOf(outline).length - outline.length;
ok('U-31 列表页仍出原生表格（本单接线没把别的页带崩）',
  /<a:tbl>/.test(await slideXml(slideIdxOfOutline(outline, 2) + 1)) && !/prst="diamond"/.test(await slideXml(slideIdxOfOutline(outline, 2) + 1)),
  { tlSlideCount });
okPair(ok, 'U-32 绘制前提缺失的整份稿：时间线页零菱形 + warnings 点名回落原因',
  () => degradeJudge(degMs, NO_MS, NO_MS_REASON, TL_RENDER_NO) && !/prst="diamond"/.test(degMs.xml) && /<a:tbl>/.test(degMs.xml),
  () => /回落列表版/.test(degMs.built.warnings.join('')),
  () => degMs.built.warnings);
okPair(ok, 'U-33 warnings 如实带上「续页承载」的量（页面上看不出来的取舍要能被复核）',
  // 行为侧：逐页解包数真条——各时间线页实绘条数之和 = 库内计划数（一条不丢），
  // 且每条续页 warning 里点的数 = 其后各页实绘之和（拿产物自己的数对账，不认中文措辞）
  () => {
    const numsOf = (w: string) => (w.match(/\d+/g) ?? []).map(Number);
    const carried = built.warnings.map(numsOf).filter((ns) => ns.length >= 2 && TL_PAGE_NOS.includes(ns[0]));
    const tailSum = (from: number) => TL_RECTS.slice(from).reduce((a, b) => a + b, 0);
    return TL_RECTS.length > 1 && TL_RECTS.every((n) => n > 0) &&
      TL_RECTS.reduce((a, b) => a + b, 0) === bundle.plans.length &&
      carried.length === TL_RECTS.length - 1 &&
      carried.every((ns, i) => ns[1] === tailSum(i + 1));
  },
  () => built.warnings.some((w: string) => /其余 \d+ 条计划超出本页可排行数/.test(w) || /折成页脚提示/.test(w) || /条计划续排到下页/.test(w) || /缺起止日期/.test(w)),
  () => ({ 各页实绘: TL_RECTS, 库内条数: bundle.plans.length, warnings: built.warnings }));
ok('U-34 时间线页形状数随库内数据变化（不是写死的模板画）', await (async () => {
  const few = await M.buildKickoffPpt(bundleOf({ plans: bundle.plans.slice(0, 3), milestones: bundle.milestones.slice(0, 2) }), outline);
  const xml = await unzipSlide(few.buffer, 2);
  const sh = shapesIn(xml);
  return sh.filter((s) => s.prst === 'diamond').length === 2 && sh.filter((s) => s.prst === 'rect').length === 3;
})());
ok('U-35 时间线页越界时同样收敛到「标题+正文」：降级页不残留形状（验收 7 的不变量优先于甘特好看）', await (async () => {
  const long = await M.buildKickoffPpt(bundle, [
    outline[0],
    { section: '项目计划', title: `${'时间线'.repeat(11)}超长标题`, bullets: ['要点甲'], dataKeys: ['timeline'], layout: 'timeline' },
  ] as any[]);
  const xml = await unzipSlide(long.buffer, 2);
  return long.degradedPages.includes(2) && shapesIn(xml).length === 0 && !/<a:tbl>/.test(xml);
})());

// ======================= N 组：负对照（判据 4） =======================
group('N 组 负对照（证明上面的判据有牙）');
{
  const spy: Array<{ name: string; cond: boolean; extra?: unknown }> = [];
  const sOk = (name: string, cond: boolean, extra?: unknown) => spy.push({ name, cond, extra });

  // N-01 S-01「原生几何」判据：文本盒页、贴图页、无 offset/ext 页都必须被拒
  //      三份副本都要先证「篡改确实落了盘」，否则是拿原产物冒充反例（假牙齿）
  const textOnlyXml = spsIn(tlXml).filter((s) => s.name.startsWith('Text')).map((s) => s.el).join('');
  const picXml = tlXml.replace('</p:spTree>', '<p:pic><p:blipFill><a:blip r:embed="rId9"/></p:blipFill></p:pic></p:spTree>');
  const noGeomXml = tlXml.replace(/<a:prstGeom prst="[a-z]+">/g, '<a:prstGeom>');
  ok('N-01 原生几何判据有牙：真页判绿，只有文本盒/注入贴图/去掉 prst 的三种副本都判红',
    nativeShapeJudge(tlXml) && !nativeShapeJudge(`<p:cSld><p:spTree>${textOnlyXml}</p:spTree></p:cSld>`) &&
      !nativeShapeJudge(picXml) && !nativeShapeJudge(noGeomXml),
    { 真页形状: shapesIn(tlXml).length, 纯文本盒页: shapesIn(textOnlyXml).length, 贴图页含pic: /<p:pic/.test(picXml), 无prst页: noGeomXml !== tlXml });
  ok('N-01b 三份反例副本本身非恒等（篡改有落盘证据，不是拿原产物冒充反例）',
    textOnlyXml.length > 0 && shapesIn(textOnlyXml).length === 0 &&
      picXml !== tlXml && /<p:pic/.test(picXml) && noGeomXml !== tlXml &&
      !/<a:prstGeom prst="[a-z]+">/.test(noGeomXml),
    { 文本盒数: shapesIn(textOnlyXml).length, pic增量: picXml.length - tlXml.length, 无prst增量: noGeomXml.length - tlXml.length });

  // N-02 S-02「线性映射」判据：把第一条的 x 搬 0.35"、以及「按行等分」这套反算式都必须被拒
  const band0 = bandFromXml(tlXml)!;
  const got0 = shapesIn(tlXml).filter((s) => s.prst === 'rect');
  const shifted = setSpX(tlXml, got0[0], got0[0].off[0] + 0.35);
  const even = expectBars(bundle, band0, got0.length, 'even');
  ok('N-02 日期映射判据有牙：搬动一条 x 的产物副本判红；按行等分的反算式对不上真产物（说明认的是日期比例尺）',
    geomJudge(tlXml, bundle) && !geomJudge(shifted, bundle) &&
      !even.every((e, i) => close(e.x, got0[i].off[0])) &&
      expectBars(bundle, band0, got0.length, 'linear').every((e, i) => close(e.x, got0[i].off[0])),
    { 搬动量: 0.35, 等分式首格: +even[0].x.toFixed(3), 线性式首格: +expectBars(bundle, band0, 1)[0].x.toFixed(3), 产物首格: +got0[0].off[0].toFixed(3), 判据: { 真: geomJudge(tlXml, bundle), 搬动后: geomJudge(shifted, bundle) } });

  // N-03 S-03「配色单源」判据：改色必须在产物上看得见，改一个时间线用不到的角色色不算数
  const altShapes = shapesIn(altXml);
  const inkShapes = shapesIn(inkXml);
  ok('N-03 配色单源判据有牙：改 brandBright 后条色逐枚换新、原色零残留；只改 ink 时条/菱形配色不变（认角色不认巧合）',
    !!ALT_BAR && altShapes.length > 0 && altShapes.filter((s) => s.prst === 'rect').every((s) => colorsOf(s.spPr).includes(ALT_BAR)) &&
      altShapes.filter((s) => s.prst === 'rect').every((s) => !colorsOf(s.spPr).includes(PAL_BAR)) &&
      inkShapes.length === tlShapes.length &&
      inkShapes.every((s, i) => colorsOf(s.spPr).join(',') === colorsOf(tlShapes[i].spPr).join(',')) &&
      backXml === tlXml,
    { 单源色: PAL_BAR, 改后色: ALT_BAR, 改后条数: altShapes.filter((s) => s.prst === 'rect').length, 只改ink后配色序列: inkShapes.slice(0, 2).map((s) => colorsOf(s.spPr).join('/')) });

  // N-04 S-04「刻度贴条形区」判据：把刻度搬到默认全宽框的格子上，同一判据必须判红
  const rangeN = LAY.dateRangeOf(bundle.plans)!;
  const gotTicksN = textsIn(tlXml).filter((t) => /^\d+\/\d+$/.test(t.text));
  const defXs = tickBoxXs(rangeN, band0, LAY.getContentFrame());
  let movedXml = tlXml;
  gotTicksN.forEach((t, i) => { movedXml = setSpX(movedXml, t, defXs[i]); });
  ok('N-04 刻度对齐判据有牙：条形区格子判绿、把同一批刻度挪到全宽框格子上判红（两套格子确实不同）',
    tickAlignJudge(tlXml, bundle) && !tickAlignJudge(movedXml, bundle) &&
      defXs.some((e, i) => !close(e, tickBoxXs(rangeN, band0, band0)[i])),
    { 条形区: tickBoxXs(rangeN, band0, band0).map((v) => +v.toFixed(3)), 全宽框: defXs.map((v) => +v.toFixed(3)), 判据: { 真: tickAlignJudge(tlXml, bundle), 挪动后: tickAlignJudge(movedXml, bundle) } });

  // N-05 S-05/U-32「降级不静默」判据：给降级页注入一枚真菱形（假甘特），同一判据必须判红
  const diamondEl = shapesIn(tlXml).find((s) => s.prst === 'diamond')!.el;
  const fakeGantt = degMs.xml.replace('</p:spTree>', `${diamondEl}</p:spTree>`);
  ok('N-05 降级判据有牙：真降级页判绿、往它里面补一枚菱形（谎称画得出甘特）判红',
    degradeJudge(degMs, NO_MS, NO_MS_REASON, TL_RENDER_NO) &&
      !degradeJudge({ xml: fakeGantt, built: degMs.built }, NO_MS, NO_MS_REASON, TL_RENDER_NO) &&
      !degradeJudge({ xml: tlXml, built }, NO_MS, NO_MS_REASON, TL_RENDER_NO),
    { 降级页形状: shapesIn(degMs.xml).length, 注入后形状: shapesIn(fakeGantt).length, warnings: degMs.built.warnings.slice(0, 2) });

  // N-06 S-06「frame 参数被消费」判据：一份忽略 frame 的副本必须被同一条判据拒掉
  const deadTicks = (range: any, count = 3) => LAY.axisTicks(range, count);
  const followOf = (ticks: any[], f: any) => ticks.length === 3 && ticks.every((t, i) => close(t.x, f.x + (f.w * i) / 2, 1e-9));
  const A = { x: 1, y: 1, w: 6, h: 0.2 };
  ok('N-06 参数化判据有牙：真实现按框落位、忽略 frame 的死参数副本判红（死参数不是参数化）',
    followOf(LAY.axisTicks(rangeN, 3, A as any), A) && !followOf(deadTicks(rangeN, 3) as any, A),
    { 按A: LAY.axisTicks(rangeN, 3, A as any).map((t) => +t.x.toFixed(3)), 死参数: deadTicks(rangeN, 3).map((t) => +t.x.toFixed(3)) });

  // N-07 U-15/U-15b/U-17 的「数与夹具同源」判据：note 里点的数必须是本轮夹具的数
  const sameDayNote = legendOf(M.timelineBlocks(sameDay, frame));
  const baseNote = legendOf(M.timelineBlocks(bundle, frame));
  ok('N-07 计数判据有牙：图例的数来自本轮夹具——把两份夹具的图例互换取值（12↔6）判红',
    numberAppears(sameDayNote, sameDay.milestones.length) && numberAppears(sameDayNote, 1) &&
      !numberAppears(sameDayNote, bundle.milestones.length) &&
      numberAppears(baseNote, bundle.milestones.length) && !numberAppears(baseNote, sameDay.milestones.length) &&
      sameDayNote !== baseNote,
    { 同日夹具图例: sameDayNote, 常规夹具图例: baseNote, 反例: { 同日里找常规数: bundle.milestones.length, 常规里找同日数: sameDay.milestones.length } });

  // N-08 U-21/U-23/U-33 的数字点名判据：把夹具的高度改掉，note 里点的数必须跟着改
  //      取「多个高度都点名、且点的是各自那个数」的形态，不写死某一句文案；
  //      同时要求存在一个不降档的高度（1.55" 那一路改走折行/分页），证明这条 note 不是无条件出现的
  const remainOf = (r: { notes: string[] }) => (r.notes.join('').match(/剩余高度 ([\d.]+)"/) ?? [])[1] ?? null;
  const heights = [0.6, 1.0, 1.4];
  const swept = heights.map((h) => {
    const r = M.layoutBody(tlItem, bundle, { ...LAY.framesFor('data', 'timeline'), body: { x: frame.x, y: frame.y, w: frame.w, h } } as any, []) as any;
    return { h, printed: remainOf(r) };
  });
  const nonDegrade = M.layoutBody(tlItem, bundle, { ...LAY.framesFor('data', 'timeline'), body: { x: frame.x, y: frame.y, w: frame.w, h: 1.55 } } as any, []) as any;
  ok('N-08 留痕数字跟夹具走：每个高度点名的都是自己那个数，且高到不降档时这条留痕不出现（写死一句话过不了）',
    swept.filter((s) => s.printed === s.h.toFixed(2)).length >= 2 &&
      swept.every((s) => s.printed === null || s.printed === s.h.toFixed(2)) &&
      new Set(swept.map((s) => s.printed).filter(Boolean)).size >= 2 &&
      remainOf(nonDegrade) === null,
    { 扫描: swept, 高档不降档留痕: nonDegrade.notes.join('').slice(0, 80) });

  // N-09 形状计数判据：真产物按数据变化（3 条计划 2 枚菱形），抽掉一枚的假产物必须被同一比对判红
  const barsXs = (xml: string) => shapesIn(xml).filter((s) => s.prst === 'rect').map((s) => +s.off[0].toFixed(3));
  const droppedXml = tlXml.replace(diamondEl, '');
  ok('N-09 形状计数判据有牙：抽掉真产物里一枚菱形后，S-02 的逐条比对判红（少画一个不是四舍五入的事）',
    geomJudge(tlXml, bundle) && !geomJudge(droppedXml, bundle) && barsXs(tlXml).length === bars.length,
    { 真: shapesIn(tlXml).length, 抽掉菱形后: shapesIn(droppedXml).length, 模型条数: bars.length });

  // N-10 配对红因可区分：行为失守与字面锚点失配是两种红，不能都读成「功能挂了」
  okPair(sOk, 'N-10a 行为失守样', () => false, () => true);
  okPair(sOk, 'N-10b 锚点失配样', () => true, () => false);
  okPair(sOk, 'N-10c 双绿样', () => true, () => true);
  ok('N-10 红因可区分：两种红各带自己的红因，双绿才计 PASS',
    spy.length === 3 && spy[0].cond === false && JSON.stringify(spy[0].extra).includes('行为失守')
    && spy[1].cond === false && JSON.stringify(spy[1].extra).includes('字面锚点失配') && spy[2].cond === true, spy);
}

mkdirSync(OUT_DIR, { recursive: true });
const summary = `T02100 时间线形状门：PASS=${pass} FAIL=${fail} SKIP=${skippedList.length}\n` + lines.join('\n') + '\n';
writeGateResults(OUT_DIR, 't02100-gate-results.txt', summary);
console.log(`PASS=${pass} FAIL=${fail} SKIP=${skippedList.length}`);
console.log(lines.join('\n'));
process.exit(fail ? 1 : 0);
