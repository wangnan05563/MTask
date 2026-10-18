/**
 * T02171 门：时间线/计划页超行数改为分页承载（派生自 T02166）。
 *
 * 本轮（T02293 改判标准）口径，逐条如实：
 *  1) 断言全部落在**行为与产物**上：expandTimelinePages/timelineBlocks/layoutBody 的返回值、
 *     解包 .pptx 的幻灯片 XML 计数与页脚文本。文案锚点（「其余 n 条计划未绘出」「（续）」「第 n/N 页」）
 *     一律降级为 okPair 的字面腿，字面取自 `git show HEAD:server/src/services/kickoffBuilder.ts`
 *     （反模式 11：绝不读工作区产物文件），行为腿先量后发（反模式 14）。
 *  2) 不依赖任何生产业务数据：Bundle 全部脚本内构造（p1 / mtask五期 是门内自有夹具，不是库里真项目），
 *     不连库、不起服务、不调 AI。
 *  3) 负对照 N-01..N-06：对分页窗口/注块/幻灯片 XML/页脚做**真破坏**，同一个判据函数必须转红，
 *     且每条红项自带「篡改落盘自证」（先实测到篡改后的值，再判红）——沿用 t02100 的假牙齿防法：
 *     判据函数与 PASS 组共用，不在 N 组另写一套。
 *  4) 环境缺口（git 不可用取不到 HEAD 源）时配对项如实 SKIP，不冒充 PASS。
 * 中文文案断言按「注块报的是本次夹具自己的条数」判定（total - 各页实绘之和），不是照抄一句话。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02171-kickoff-tl-paging.mts
 * 结果落 .workbuddy/t02171-gate-results-<运行标识>.txt 与 t02171-paging-<运行标识>.pptx（T02309 旁证同标识）。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { writeGateResults, gateArtifactPath } from './lib/gate-results.mts';
import { okPair } from './lib/anchor-pair.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');
mkdirSync(OUT_DIR, { recursive: true });

let pass = 0;
let fail = 0;
let skip = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 500)}`}`);
};
const skipped = (name: string, why: string) => {
  skip += 1;
  lines.push(`[SKIP] ${name} —— ${why}（不计 PASS）`);
};

// ---------- HEAD 源字面锚点（反模式 11：只从 git show 取，绝不读工作区） ----------
let HEAD_SRC = '';
let HEAD_ERR = '';
try {
  HEAD_SRC = execFileSync('git', ['show', 'HEAD:server/src/services/kickoffBuilder.ts'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  // 剥注释：字面腿只允许命中代码里的文案模板，不许命中注释/文档复述
  HEAD_SRC = HEAD_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
} catch (e) {
  HEAD_ERR = e instanceof Error ? e.message : String(e);
}
/** 配对发射：HEAD 取不到 ⇒ 该配对项是环境缺口，如实 SKIP（行为腿也不单发，避免「只量行为」冒充改判完成） */
const emitPair = (label: string, behavior: () => boolean, literal: () => boolean, ctx: () => unknown) => {
  if (!HEAD_SRC) skipped(label, `HEAD 源不可得（git show 失败：${HEAD_ERR.slice(0, 120)}）——字面腿无法判`);
  else okPair(ok, label, behavior, literal, ctx);
};

const M = await import('../server/src/services/kickoffBuilder.ts');
const LAY = await import('../server/src/services/kickoff-layout.ts');

// ---------- 测试夹具（判据 2：全部脚本内构造，与库内真实项目无关） ----------
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
    quote: { p50ManDays: 96, p84ManDays: 118 },
    phases: [{ phase: '开发', expected: 60, rowCount: 12 }, { phase: '测试', expected: 36, rowCount: 6 }],
    complexity: [{ level: '1', count: 4 }], counted: planCount, footer: '工作量来源：估算引擎（P50 96 人天）',
    reviewTrace: null,
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

// ---------- 判据函数（PASS 组与 N 组共用，杜绝「判据只对真数据有效的假牙齿」） ----------
const REST_NOTE_RE = /其余 (\d+) 条计划未绘出/;

/** 注块判据：中间页不许有注；全承载不许有注；只有真被上限挡住的末页才许，且条数 = total - 实绘之和 */
function noteJudge(perPageBlocks: any[][], lastFlags: boolean[], drawnSum: number, total: number) {
  const notes = perPageBlocks.map((blocks) => {
    const hit = blocks.find((x: any) => x?.text && REST_NOTE_RE.test(x.text.content));
    return hit ? Number(REST_NOTE_RE.exec(hit.text.content)![1]) : null;
  });
  const lastIdx = lastFlags.length - 1;
  const flagsOk = lastFlags[lastIdx] === true && lastFlags.slice(0, -1).every((f) => f !== true);
  let notesOk = true;
  if (drawnSum >= total) notesOk = notes.every((n) => n === null);
  else notesOk = notes[lastIdx] === total - drawnSum && notes.slice(0, -1).every((n) => n === null);
  return { ok: flagsOk && notesOk, notes, lastFlags };
}

/** 窗口链判据：offset 从 0 起、步长 = 该页版面实收行数（用传入 pages 重测——篡改过的副本自然红） */
function offsetChainJudge(bundle: any, pages: any[]) {
  let expect = 0;
  const offs: number[] = [];
  for (const p of pages) {
    offs.push(p.tlWindow.offset);
    if (p.tlWindow.offset !== expect) return { ok: false, offs, at: `第 ${offs.length} 页应为 ${expect}` };
    expect += drawnOf(bundle, p, []);
  }
  return { ok: true, offs, end: expect };
}

/** 续页形状判据：原生甘特（rect>0、line=1、diamond=里程碑数），表格凑页即红 */
function countPrims(xml: string, prst: string) {
  return xml.split('<p:sp>').slice(1)
    .filter((s) => /^Shape\b/.test((s.match(/name="([^"]*)"/) ?? [])[1] ?? ''))
    .filter((s) => (s.match(/prst="([a-z]+)"/) ?? [])[1] === prst).length;
}
function ganttJudge(tlSlides: string[], msCount: number) {
  return tlSlides.length > 1 && tlSlides.every((x) => countPrims(x, 'rect') > 0 && countPrims(x, 'line') === 1 && countPrims(x, 'diamond') === msCount) &&
    !/<a:tbl>/.test(tlSlides.join(''));
}

/** 页脚判据：第 i 页产物必须原样带上 footerOf(渲染页 i, 分母=渲染页数) 的算得文本（同 t02100 XML 副本篡改的共用口径） */
function footerJudge(xmls: string[], render: any[], bundle: any) {
  return xmls.every((x, i) => x.includes(M.footerOf(render[i], bundle, i + 1, render.length)));
}

/** 越界判据：时间线页形状底边不越画布（高 5.625"） */
function bottomJudge(tlSlides: string[]) {
  const boxes = tlSlides.flatMap((x) =>
    x.split('<p:sp>').slice(1)
      .filter((s) => /^Shape\b/.test((s.match(/name="([^"]*)"/) ?? [])[1] ?? ''))
      .map((s) => {
        const off = (s.match(/<a:off x="(\d+)" y="(\d+)"\/>/) ?? []).slice(1).map((v) => +v / 914400);
        const ext = (s.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/) ?? []).slice(1).map((v) => +v / 914400);
        return { y: off[1], h: ext[1] };
      }));
  return { ok: boxes.length > 0 && boxes.every((b) => b.y + b.h <= 5.625 + 1e-6), maxBottom: Math.max(...boxes.map((b) => b.y + b.h)) };
}

// ---------- 先测量（反模式 14：断言发射只发生在量完之后） ----------
const bundle = bundleOf(23);
const firstPageRows = drawnOf(bundle, tlItem());
const pages = M.expandTimelinePages(bundle, [tlItem()]) as any[];
const perPageBlocks = pages.map((p) => M.timelineBlocks(bundle, frames.body, p.tlWindow).blocks);
const lastFlags = pages.map((p) => p.tlWindow.last === true);
const drawnSum = pages.reduce((s, p) => s + drawnOf(bundle, p, []), 0);
const chain = offsetChainJudge(bundle, pages);

const mixed = M.expandTimelinePages(bundle, [tlItem({ bullets: ['任务 1 已交付，任务 9 进行中'], dataKeys: ['timeline', 'planRows'] })]) as any[];
const smallPages = M.expandTimelinePages(bundleOf(3), [tlItem()]) as any[];
const noMsPages = M.expandTimelinePages({ ...bundle, milestones: [] }, [tlItem()]) as any[];
const passthrough = M.expandTimelinePages(bundle, [
  tlItem(), { section: '正文', title: '需求概览', bullets: [], dataKeys: ['reqList'], layout: 'table' }, tlItem({ title: '第二条时间线' }),
]) as any[];

const hugeBundle = bundleOf(90);
const huge = M.expandTimelinePages(hugeBundle, [tlItem()]) as any[];
const hugeDrawn = huge.reduce((s, p) => s + drawnOf(hugeBundle, p, []), 0);
const hugeBlocks = huge.map((p) => M.timelineBlocks(hugeBundle, frames.body, p.tlWindow).blocks);
const hugeJudge = noteJudge(hugeBlocks, huge.map((p) => p.tlWindow.last === true), hugeDrawn, 90);

const pageLayout = pages.map((p) => {
  const r = M.layoutBody(p, bundle, frames, []);
  const bottom = LAY.getContentFrame().y + LAY.getContentFrame().h;
  return { violations: r.violations.length, inside: r.blocks.every((b: any) => b.box.y >= 0 && b.box.y + b.box.h <= bottom + 1e-6) };
});

const outline = [
  { section: '封面', title: 'mtask五期 项目启动会', bullets: [], dataKeys: [], layout: 'cover' },
  { section: '项目计划', title: '项目计划时间线', bullets: [], dataKeys: ['timeline'], layout: 'timeline' },
  { section: '项目计划', title: '用例覆盖', bullets: [], dataKeys: ['coverage'], layout: 'chart' },
] as any[];
const built = await M.buildKickoffPpt(bundle, outline);
writeFileSync(gateArtifactPath(OUT_DIR, 't02171-paging.pptx'), built.buffer);
const zip = await JSZip.loadAsync(built.buffer);
const slideNames = Object.keys(zip.files)
  .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
  .sort((a, b) => Number(/(\d+)\.xml/.exec(a)![1]) - Number(/(\d+)\.xml/.exec(b)![1]));
const xmls: string[] = [];
for (const n of slideNames) xmls.push(await zip.file(n)!.async('string'));
const render = M.expandTimelinePages(bundle, outline) as any[];
const tlSlideCount = render.filter((p) => p.layout === 'timeline').length;
const tlSlides = xmls.slice(1, 1 + tlSlideCount);
const footerOkReal = footerJudge(xmls, render, bundle);

// ---------- S 组发射（行为 + 字面配对） ----------
emitPair('P-01 首页版面实收行数由 layoutBody 测得且在甘特行上限内（探针与装配同一口径，不在别处重算几何）',
  () => firstPageRows > 0 && firstPageRows <= 8,
  () => /MAX_TL_ROWS = 8/.test(HEAD_SRC),
  () => ({ firstPageRows }));

ok('P-02 23 条计划首页收不完 → 展开成多页承载（不再折成页脚）', pages.length > 1, { pages: pages.length, firstPageRows });
ok('P-03 窗口 offset 从 0 起严格递增，步长=各页版面实收行数', chain.ok, { offs: chain.offs, ...(chain.ok ? {} : { 证据: chain }) });
ok('P-04 全量承载：各页实绘条数之和 = 夹具计划数（一条不丢，也不重复画）', drawnSum === bundle.plans.length,
  { sum: drawnSum, plans: bundle.plans.length });
emitPair('P-05 只有末页能带「其余 n 条」注且条数=本次夹具真余量；全承载时末页也不带',
  () => noteJudge(perPageBlocks, lastFlags, drawnSum, bundle.plans.length).ok,
  () => /其余 \$\{overflow\} 条计划未绘出/.test(HEAD_SRC),
  () => ({ notes: noteJudge(perPageBlocks, lastFlags, drawnSum, bundle.plans.length).notes, lastFlags }));
emitPair('P-06 续页只带时间线：标题带（续）后缀、要点与其他数据块留在首页（同表重画不是承载）',
  () => pages.slice(1).every((p) => /（续）$/.test(p.title) && p.bullets.length === 0 && p.dataKeys.join() === 'timeline'),
  () => /\$\{item\.title\}（续）/.test(HEAD_SRC),
  () => pages.map((p) => ({ t: p.title, keys: p.dataKeys, b: p.bullets.length })));

ok('P-07 首页带要点+表格（版面被挤小）时分页仍成立，要点不被复制到续页',
  mixed.length > 1 && mixed[0].bullets.length === 1 && mixed[0].dataKeys.join() === 'timeline,planRows' &&
    mixed.slice(1).every((p) => p.bullets.length === 0),
  { pages: mixed.length, first: mixed[0]?.dataKeys });
ok('P-08 单页装得下就不开续页（不给小项目硬塞页）', smallPages.length === 1 && smallPages[0].tlWindow.last === true,
  smallPages.map((p: any) => p.tlWindow));
ok('P-09 绘制前提缺失（里程碑 0 个）→ 不分页，交回列表版降级口径（不造空壳甘特页）', noMsPages.length === 1, noMsPages.length);
ok('P-10 非时间线页原样透传（大纲顺序与页数不被改动）',
  passthrough.filter((p) => p.layout !== 'timeline').length === 1 && passthrough[0].title === '项目计划时间线' &&
    passthrough.some((p) => p.title === '第二条时间线'),
  passthrough.map((p: any) => p.title));
emitPair('P-11 页数有上限：超大夹具最多铺到上限页，末页注如实报本次夹具的未绘条数（不谎称画全）',
  () => huge.length === 6 && hugeJudge.ok && 90 - hugeDrawn > 0,
  () => /MAX_TL_PAGES = 6/.test(HEAD_SRC) && /其余 \$\{overflow\} 条计划未绘出/.test(HEAD_SRC),
  () => ({ pages: huge.length, drawn: hugeDrawn, notes: hugeJudge.notes }));

ok('P-12 分页后的每页都过版式断言：无 violations 且所有块在画布内（分页不越页）',
  pageLayout.every((r) => r.violations === 0 && r.inside), pageLayout);

// ---------- U 组：真产物（.pptx 解包） ----------
ok('U-01 产物幻灯片数 = 渲染页数（大纲 + 时间线续页），pageCount 与之同源',
  xmls.length === render.length && built.pageCount === xmls.length && render.length > outline.length,
  { slides: xmls.length, pageCount: built.pageCount, outline: outline.length, render: render.length });
emitPair('U-02 页脚分母跟着渲染页数走：每页产物原样带 footerOf(本页, 分母=幻灯片数) 的算得文本',
  () => footerOkReal,
  () => /第 \$\{pageNo\}\/\$\{total\} 页/.test(HEAD_SRC),
  () => ({ total: render.length, footerOf第2页: M.footerOf(render[1], bundle, 2, render.length).slice(-24) }));
ok('U-03 warnings 不再出现旧口径「超出本页可排行数 / 折成页脚提示」（23 条计划全部有页承载）',
  !built.warnings.some((w: string) => /超出本页可排行数|折成页脚提示/.test(w)),
  built.warnings.filter((w: string) => /时间线|页：/.test(w)));
emitPair('U-03b 新口径警告点名的是本次夹具的续排条数（数字与首页实绘联动，不是硬编码句）',
  () => built.warnings.some((w: string) => {
    const m = /^第 \d+ 页：(\d+) 条计划续排到下页/.exec(w) ?? /(\d+) 条计划续排到下页/.exec(w);
    return !!m && Number(m![1]) === bundle.plans.length - firstPageRows;
  }),
  () => /\$\{tl\.overflow\} 条计划续排到下页/.test(HEAD_SRC),
  () => built.warnings.filter((w: string) => /续排/.test(w)));
ok('U-04 续页仍是原生甘特（rect 条 + line 轴 + 菱形里程碑数=夹具 6），不是回退成表格凑页',
  ganttJudge(tlSlides, bundle.milestones.length),
  xmls.map((x) => ({ tbl: /<a:tbl>/.test(x), dia: countPrims(x, 'diamond') })));
ok('U-05 时间线各页形状底边都不越画布（分页后依旧不越页）', bottomJudge(tlSlides).ok, bottomJudge(tlSlides));
ok('U-06 分页页不触发整页降级（越界判据仍按页计，续页不被误判坏页）', built.degradedPages.length === 0, built.degradedPages);

// ---------- N 组：负对照（真破坏 → 同一判据必须转红 + 篡改落盘自证） ----------
// N-01 给中间页注块注入假「其余 5 条未绘出」→ noteJudge 红；自证：注确实落在第 1 页且原数组没有
{
  const tampered = perPageBlocks.map((b, i) => (i === 0 ? [...b, { text: { content: '其余 5 条计划未绘出，见「项目计划」列表页' } }] : b));
  const landed = tampered[0].some((x: any) => REST_NOTE_RE.test(x?.text?.content ?? '')) && !perPageBlocks[0].some((x: any) => REST_NOTE_RE.test(x?.text?.content ?? ''));
  ok('N-01 篡改落盘自证：假未绘注被注入第 1 页块集（原块集没有此注）', landed, { 原第1页有注: perPageBlocks[0].some((x: any) => REST_NOTE_RE.test(x?.text?.content ?? '')) });
  ok('N-01 中间页带「其余 n 条」注 → 同一判据转红（谎报未绘就是红，不装看不见）',
    !noteJudge(tampered, lastFlags, drawnSum, bundle.plans.length).ok, noteJudge(tampered, lastFlags, drawnSum, bundle.plans.length));
}
// N-02 把 last 标记挪到中间页（末页不再 last）→ 判据红；自证：标记数组确实变了
{
  const flags = lastFlags.map((f, i) => (i === 0 ? true : i === lastFlags.length - 1 ? false : f));
  const landed = flags[0] === true && flags.at(-1) === false && flags.join() !== lastFlags.join();
  ok('N-02 篡改落盘自证：末页 last 被挪到第 1 页', landed, { flags, 原: lastFlags });
  ok('N-02 last 链错位（中间页自称末页）→ 同一判据转红',
    !noteJudge(perPageBlocks, flags, drawnSum, bundle.plans.length).ok, noteJudge(perPageBlocks, flags, drawnSum, bundle.plans.length));
}
// N-03 抹掉续页一个菱形里程碑 → 甘特计数判据红；自证：计数恰好少 1
{
  const src = tlSlides[1];
  const parts = src.split('<p:sp>');
  const idx = parts.findIndex((s) => (s.match(/prst="([a-z]+)"/) ?? [])[1] === 'diamond');
  const cut = [parts[0], ...parts.slice(1).filter((_, j) => j !== idx - 1)].join('<p:sp>');
  const before = countPrims(src, 'diamond');
  const after = countPrims(cut, 'diamond');
  const landed = idx >= 0 && after === before - 1 && before === bundle.milestones.length;
  ok('N-03 篡改落盘自证：副本续页菱形计数 6→5（真删一个形状，不是判据空转）', landed, { before, after });
  const tamperedSlides = tlSlides.map((x, i) => (i === 1 ? cut : x));
  ok('N-03 菱形里程碑缺一个 → 原生甘特判据转红（漏画节点必须红）', !ganttJudge(tamperedSlides, bundle.milestones.length), { dia: tamperedSlides.map((x) => countPrims(x, 'diamond')) });
}
// N-04 篡改第 2 页页脚「第 2/N」→「第 5/N」→ footer 判据红；自证：篡改串确在副本里
{
  const needle = `第 2/${render.length}`;
  const fake = `第 5/${render.length}`;
  const tamperedXmls = xmls.map((x, i) => (i === 1 ? x.replace(needle, fake) : x));
  const landed = tamperedXmls[1].includes(fake) && footerOkReal === true;
  ok('N-04 篡改落盘自证：第 2 页页脚页码被改为 5（原产物页脚判据本为绿）', landed, { 页脚原含: xmls[1].includes(needle) });
  ok('N-04 页码与渲染位错位（第 5/N 出现在第 2 页）→ 同一页脚判据转红', !footerJudge(tamperedXmls, render, bundle), undefined);
}
// N-05 把第三页窗口 offset +1（跳画一条）→ offset 链判据红；自证：实测 offs 数组变了
{
  const tamperedPages = pages.map((p, i) => (i === 2 ? { ...p, tlWindow: { ...p.tlWindow, offset: p.tlWindow.offset + 1 } } : p));
  const tChain = offsetChainJudge(bundle, tamperedPages);
  const landed = tChain.offs.join() !== chain.offs.join();
  ok('N-05 篡改落盘自证：offset 链被挪位（第 3 页起窗口跳 1）', landed, { 原: chain.offs, 改后: tChain.offs });
  ok('N-05 窗口步长不再等于版面实收行数 → 同一链判据转红（跳画/重画必须红）', !tChain.ok, tChain);
}
// N-06 把一个时间线形状整体挪出画布 → 底边判据红；自证：重测 maxBottom 越界
{
  const src = tlSlides[1];
  const parts = src.split('<p:sp>');
  const bi = parts.findIndex((s) => /^Shape\b/.test((s.match(/name="([^"]*)"/) ?? [])[1] ?? '') && /<a:off x="(\d+)" y="(\d+)"\/>/.test(s));
  const blk = parts[bi] ?? '';
  const m = /<a:off x="(\d+)" y="(\d+)"\/>/.exec(blk);
  const bumpedBlk = m ? blk.replace(m![0], `<a:off x="${m![1]}" y="5943600"/>`) : blk; // 6.5in > 5.625in 画布高
  const bumped = parts.map((s, j) => (j === bi ? bumpedBlk : s)).join('<p:sp>');
  const probeB = bi >= 0 && m ? bottomJudge([bumped]) : { ok: true, maxBottom: 0 };
  const landed = bi >= 0 && !!m && probeB.maxBottom > 5.625;
  ok('N-06 篡改落盘自证：副本 Shape 形状被顶出画布（底边实测 > 5.625"）', landed, { bi, probeB });
  const tamperedSlides = tlSlides.map((x, i) => (i === 1 ? bumped : x));
  ok('N-06 形状越出画布下沿 → 同一越界判据转红', landed && !bottomJudge(tamperedSlides).ok, bottomJudge(tamperedSlides));
}

const header = `T02171 时间线分页门：PASS=${pass} FAIL=${fail}${skip ? ` SKIP=${skip}` : ''}\n`;
writeGateResults(OUT_DIR, 't02171-gate-results.txt', `${header}${lines.join('\n')}\n`);
console.log(header.trim());
console.log(lines.filter((l) => !l.startsWith('[PASS]')).join('\n'));
process.exit(fail ? 1 : 0);
