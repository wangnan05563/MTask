/**
 * T02172 门：柔性块按类型设最小可读高 + dataKeys 上限硬校验（派生自 T02166）。
 *
 * 三条口径各一组断言：
 *   F 组 分型下限：图表压到 0.45" 是 placed 但不可读（刻度/图例/环心叠成一团）。现在
 *        ① 预算不足先让同页表格继续收行；② 图表拿不到 1.2" 才整块省略并点名；
 *        ③ 文本仍按 0.45"（一刀切抬高会把本来能读的文本也挤掉）；
 *        ④ 收无可收的表格允许「计数行单独成表」——仍不谎称画全，但不再因 0.05" 被整块丢。
 *        T02293 改判：下限「单源」不再读源码里的常量与函数名，改为**双分支 × 多档预算扫描**
 *        同一条不变式（placed 的图表必 ≥1.2"、少画的图必点名、页面无版式违规）——
 *        两栏与整栏两条分支各自都会走完 flexStrip / fitStack / pushStackedBlocks，
 *        任何一处漏下限都会在某个预算点位露出一张 <1.2" 的图。
 *   V 组 dataKeys≤2（纯函数层）：超限判失败、重试轮转软截断、截断有回执、≤2 不误伤、
 *        截断不得把全稿唯一的必含键（timeline/workload）截没。
 *   G 组 dataKeys≤2（真链路层，T02293 由 V-06/V-07 源码锚点改判）：门内自建隔离库 + 本地
 *        mock 厂商，跑真 `kickoffOutline` → 真 AIService → 真重试协议。看的是**发出去的请求体**
 *        与**返回的大纲**，不是 kickoffService.ts 里有没有 `parseRound++` 那行字。
 *   P 组 真产物：解包 .pptx 用 EMU 证每张图表实排高 ≥1.2"，页面上没图的必须带 drop 留痕。
 *
 * 隔离纪律：不连生产库（G 组夹具 = scripts/lib/outline-harness.mts 自建临时库）、不起服务、
 * 不调真实 AI（桩是本机 127.0.0.1 随机端口的 OpenAI 兼容服务，零配额）。
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02172-kickoff-flex-floor.mts
 * 结果落 .workbuddy/t02172-gate-results-<运行标识>.txt 与 t02172-flex-<运行标识>.pptx（T02309 旁证同标识）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { writeGateResults, gateArtifactPath } from './lib/gate-results.mts';
import { startOutlineHarness } from './lib/outline-harness.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');
mkdirSync(OUT_DIR, { recursive: true });

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 600)}`}`);
};

const M = await import('../server/src/services/kickoffBuilder.ts');
const LAY = await import('../server/src/services/kickoff-layout.ts');
const SVC = await import('../server/src/services/kickoffService.ts');

const EMU = 914400;
const CHART_FLOOR = 1.2;
const TEXT_FLOOR = 0.45;

// ---------- 测试夹具 ----------
const DAY = 86400000;
const iso = (base: number, off: number) => new Date(base + off * DAY).toISOString().slice(0, 10);
const T0 = Date.UTC(2026, 0, 5);
const planRow = (i: number) => ({
  id: `q${i}`, project_id: 'p1', title: `任务 ${i + 1}`, description: '',
  start_date: iso(T0, i * 3), end_date: iso(T0, i * 3 + 6), duration_days: 5, progress: i < 8 ? 100 : 20,
  status: i < 8 ? 'done' : 'doing', assignee: '张三', sort_order: i, linked_task_id: null, req_ids: null,
  color: '', deps: '', complexity: (i % 5) + 1, kind: 'normal', archived: 0, archived_at: null, created_at: '', updated_at: '',
});

const bundle = {
  project: { id: 'p1', name: 'mtask五期', workspacePath: ROOT },
  prdDocs: [{ id: 'd1', filename: 'PRD-项目启动会PPT生成.md', updatedAt: '2026-10-12', contentChars: 1200 }],
  prdDoc: { id: 'd1', filename: 'PRD-项目启动会PPT生成.md', updatedAt: '2026-10-12', contentMd: '# 背景\n口径来源说明。' },
  prdExcerpt: '# 背景\n口径来源说明。',
  prdTruncated: false,
  requirements: Array.from({ length: 14 }, (_, i) => ({
    id: `r${i}`, project_id: 'p1', req_no: `R${i + 1}`, title: `需求 ${i + 1}`, content: null, source_ref: null,
    priority: 'normal', status: i < 6 ? 'done' : 'doing', sort_order: i, created_at: null, updated_at: null,
    prd_id: 'd1', linkedPlans: [], linkedTasks: [], prdDoc: null,
  })),
  plans: Array.from({ length: 12 }, (_, i) => planRow(i)),
  milestones: [1, 2, 3].map((i) => ({ ...planRow(100 + i), id: `m${i}`, title: `M${i} 里程碑`, start_date: iso(T0, i * 12), end_date: iso(T0, i * 12 + 2), kind: 'milestone' })),
  coverage: { total: 40, covered: 32, uncovered: 8, rate: 80 },
  assignees: [{ name: '张三', planCount: 12 }],
  risks: [{ item: '计划进度落后', impact: '排期后移', mitigation: '拆分并行', source: '计划表' }],
  workload: {
    source: 'estimate', manDays: { expected: 96, optimistic: 78, pessimistic: 132 }, manMonth: 4.6,
    quote: { p50ManDays: 96, p84ManDays: 118 }, phases: [{ phase: '开发', expected: 60, rowCount: 12 }, { phase: '测试', expected: 36, rowCount: 6 }],
    complexity: [{ level: '1', count: 4 }], counted: 12, footer: '工作量来源：估算引擎（P50 96 人天）',
  },
  preflight: {
    projectId: 'p1', projectName: 'mtask五期', blocked: false, missingHard: [], workloadSource: 'estimate',
    items: (['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'] as const).map((key, i) => ({
      key, label: `项${key}`, count: [1, 14, 12, 3, 1, 12, 1][i], status: 'ok' as const, note: '示例说明', deepLink: 'plan', hard: i < 3,
    })),
  },
  workspaceNote: '工作空间可访问',
  dataAsOf: '2026-10-13',
} as any;

/** 真链路第 9 页形态：双栏 + 长要点 + 覆盖率文本/环图 + 需求表 */
const longBullets = Array.from({ length: 4 }, (_, i) => `「需求 ${i + 1}」已完成拆解并与排期对齐，当前处于开发阶段，风险与依赖已在跟踪矩阵登记留痕`);
const squeezeItem = { section: '正文', title: '需求覆盖', bullets: longBullets, dataKeys: ['coverage', 'reqList'], layout: 'twoCol' };
const twoCol = LAY.framesFor('twoCol', 'twoCol', LAY.TEXT_SPLIT);
const squeezed = M.layoutBody(squeezeItem as any, bundle, twoCol, longBullets) as any;
const kindOf = (b: any) => (b.chart ? 'chart' : b.table ? 'table' : b.text ? 'text' : 'other');
const blockOf = (r: any, kind: string) => r.blocks.find((b: any) => kindOf(b) === kind);
const rightCol = twoCol.cols![1];

// ---------- F 组：柔性块分型下限 ----------

/** 分型下限不变式（F-10 改判的判据本体，T02293 规约第 1 条：打在排布产物上，不打在源码文本上）：
 *  ① placed 的图表实排高必 ≥1.2"；② 该画而没画上的图表必须在 dropped 点名；③ 页面无版式违规。
 *  「三处排布路径守同一张图表下限」由「两条分支 × 多档预算」覆盖：双栏分支与整栏分支各自都会
 *  走完 flexStrip / fitStack / pushStackedBlocks，任何一处漏下限都会在某个点位露出 <1.2" 的图。 */ok('F-01 极限双栏页：图表 placed 且实排高 ≥ 1.2" 可读下限（不再靠压扁换 placed）',
  !!blockOf(squeezed, 'chart') && blockOf(squeezed, 'chart').box.h >= CHART_FLOOR - 1e-6,
  { chart: blockOf(squeezed, 'chart')?.box, dropped: squeezed.dropped });
ok('F-02 图表抬下限的同页表格仍 placed，且底边不越出分栏（收表格而不是丢表格）',
  !!blockOf(squeezed, 'table') && blockOf(squeezed, 'table').box.y + blockOf(squeezed, 'table').box.h <= rightCol.y + rightCol.h + 1e-6,
  { table: blockOf(squeezed, 'table')?.box, col: rightCol });
ok('F-03 表格确实被继续收行（行数 < 原始 clampRows 出数）',
  blockOf(squeezed, 'table').table.rows.length < M.blocksForKey('reqList', bundle)[0].table.rows.length,
  { fitted: blockOf(squeezed, 'table').table.rows.length, raw: M.blocksForKey('reqList', bundle)[0].table.rows.length });
/** 右栏里的柔性文本（左栏是整栏要点盒，不参与分型下限的比对） */
const flexTextOf = (r: any) =>
  r.blocks.filter((b: any) => kindOf(b) === 'text' && b.box.x >= rightCol.x - 1e-6)[0];
ok('F-04 文本块按自己的 0.45" 下限排（没被跟着图表抬到 1.2"，一刀切会把能读的文本也挤掉）',
  !!flexTextOf(squeezed) && flexTextOf(squeezed).box.h >= TEXT_FLOOR - 1e-6 && flexTextOf(squeezed).box.h < CHART_FLOOR,
  squeezed.blocks.map((b: any) => ({ k: kindOf(b), x: +b.box.x.toFixed(2), h: +b.box.h.toFixed(2) })));

// 挤到图表拿不到 1.2" 的窄页：把右栏高度压到只够「文本 + 表格」，图表应整块让位并点名
const tightFrames = { ...twoCol, cols: [{ ...twoCol.cols![0], h: 1.6 }, { ...rightCol, h: 1.6 }] as [typeof rightCol, typeof rightCol] };
const tight = M.layoutBody(squeezeItem as any, bundle, tightFrames, longBullets) as any;
ok('F-05 预算不足且收无可收：图表整块省略，dropped 点名到具体图名（宁可少一块，不画一块看不清的）',
  !blockOf(tight, 'chart') && tight.dropped.some((d: string) => /图表/.test(d)),
  { dropped: tight.dropped, blocks: tight.blocks.map(kindOf) });
ok('F-06 被牺牲的是不可读的图表，同页文本块照常 placed',
  !!flexTextOf(tight) && !blockOf(tight, 'chart'),
  tight.blocks.map((b: any) => ({ k: kindOf(b), h: +b.box.h.toFixed(2) })));
ok('F-07 两种版面都零版式违规（分型下限不越页）',
  squeezed.violations.length === 0 && tight.violations.length === 0,
  { tight: tight.violations, squeezed: squeezed.violations });

// fitTableRows 的总行数上限此前被 `Math.max(1, …)` 顶穿，导致表格恒超预算 0.05" 被整块丢
const wideTable = { header: ['需求', '状态'], rows: Array.from({ length: 9 }, (_, i) => [`R${i + 1}`, '进行中']), bodyFontPt: 14 } as any;
const oneRow = M.fitTableRows(wideTable, 1) as any;
ok('F-08 收无可收时「计数行单独成表」：总行数（不含表头）≤ 上限，不再用恒留 1 条数据行顶穿预算',
  oneRow.rows.length <= 1, { rows: oneRow.rows });
ok('F-09 单独成表仍如实报未绘条数（不谎称画全）',
  /^其余\s*\d+\s*(条|个|人|项)/.test((oneRow.rows[0]?.[0] ?? '').trim()), oneRow.rows);
/** 本页可出的图表数（用于「少画了图必须点名」那一半判据） */
const chartsAvailable = (keys: string[]) =>
  keys.reduce((s, k) => s + M.blocksForKey(k as any, bundle).filter((d: any) => !!d.chart).length, 0);
const SQUEEZE_KEYS = ['coverage', 'reqList'];
const AVAIL_CHARTS = chartsAvailable(SQUEEZE_KEYS);

const checkFloor = (r: any, avail: number): { ok: boolean; why: unknown } => {
  const charts = r.blocks.filter((b: any) => kindOf(b) === 'chart');
  const squashed = charts.filter((b: any) => b.box.h < CHART_FLOOR - 1e-6).map((b: any) => +b.box.h.toFixed(2));
  const silent = charts.length < avail && !r.dropped.some((d: string) => /图表/.test(d));
  return {
    ok: squashed.length === 0 && !silent && r.violations.length === 0,
    why: {
      压扁的图: squashed, 静默丢图: silent, 违规: r.violations,
      图高: charts.map((b: any) => +b.box.h.toFixed(2)), 点名: r.dropped,
    },
  };
};

/** 只压纵向预算（x/w 跟着版式族走不动）——双栏族压两栏、整栏族压 body */
const pressFrames = (frames: any, ratio: number): any => ({
  ...frames,
  body: { ...frames.body, h: frames.body.h * ratio },
  cols: frames.cols ? frames.cols.map((c: any) => ({ ...c, h: c.h * ratio })) : undefined,
});

/** 一档版面 × 七档预算 → 违反不变式的点位 + 是否真排上过图（防空扫描：全程没一张图也「绿」） */
const sweepFloor = (frames: any) => {
  const points = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.45].map((ratio) => {
    const r = M.layoutBody(squeezeItem as any, bundle, pressFrames(frames, ratio), longBullets) as any;
    return { ratio, placed: r.blocks.filter((b: any) => kindOf(b) === 'chart').length, ...checkFloor(r, AVAIL_CHARTS) };
  });
  return { bad: points.filter((p) => !p.ok), 排上过图的点位数: points.filter((p) => p.placed > 0).length };
};

const twoColFloor = sweepFloor(twoCol);
const dataFloor = sweepFloor(LAY.framesFor('data'));

ok('F-10 双栏分支：预算从充裕连压到 45%（七档）每张 placed 的图表仍 ≥1.2"，让位的必点名，且确有档位排上图',
  twoColFloor.bad.length === 0 && twoColFloor['排上过图的点位数'] > 0, twoColFloor);
ok('F-11 整栏分支（data 族）同一扫描同样成立——这条排布路径旧门从没测过，只靠读源码里的 minReadableH 撑着',
  dataFloor.bad.length === 0 && dataFloor['排上过图的点位数'] > 0, dataFloor);

// 有牙证明（规约第 4 条）：在真实产物上做两次破坏，不变式判定必须随之转红
const teethSquash = (() => {
  const r = M.layoutBody(squeezeItem as any, bundle, twoCol, longBullets) as any;
  const chart = r.blocks.find((b: any) => kindOf(b) === 'chart');
  if (!chart) return { 有图: false, 转红: false };
  chart.box.h = 0.6; // 模拟「某处排布路径漏掉图表下限」的产物
  return { 有图: true, 转红: !checkFloor(r, AVAIL_CHARTS).ok };
})();
const teethSilent = (() => {
  const named = tight.dropped.slice(); // F-05 那张让位页：图没画，但点了名
  tight.dropped.length = 0;
  const turnedRed = !checkFloor(tight, AVAIL_CHARTS).ok;
  tight.dropped.push(...named);
  return { 原本点名: named, turnedRed };
})();
ok('F-12 不变式有牙：把 placed 图表人为压回 0.6"、或抹掉整块省略时的点名，两条判定都转红（不是恒绿摆设）',
  teethSquash.有图 && teethSquash.转红 && teethSilent.turnedRed, { teethSquash, teethSilent });

// ---------- V 组：dataKeys ≤2 硬校验 ----------
const page = (i: number, dataKeys: string[], layout = 'twoCol') => ({
  section: '项目背景', title: `第${i + 1}页`, bullets: ['「需求 1」已完成拆解'], dataKeys, layout,
});
const outlineOf = (page3: string[], tlPages: boolean[] = [true, true]) =>
  Array.from({ length: 12 }, (_, i) =>
    i === 0 ? page(0, [], 'cover')
      : i === 1 ? page(1, [], 'toc')
        : i === 3 ? page(3, page3)
          : i === 5 ? page(5, tlPages[0] ? ['timeline'] : [])
            : i === 7 ? page(7, tlPages[1] ? ['workload'] : [])
              : i === 11 ? page(11, [], 'thanks')
                : page(i, ['reqStats']));

let strictErr = '';
try {
  SVC.validateOutline(outlineOf(['coverage', 'reqList', 'milestones']));
} catch (e) {
  strictErr = e instanceof Error ? e.message : String(e);
}
ok('V-01 首轮严格：一页 3 个 dataKeys 直接判失败（软约束变硬约束），并点名页码与键',
  /第 4 页 dataKeys 3 个超出 2 个上限/.test(strictErr) && /coverage\/reqList\/milestones/.test(strictErr), strictErr);

const lenient = SVC.validateOutline(outlineOf(['coverage', 'reqList', 'milestones']), { lenientDataKeys: true });
ok('V-02 重试轮转软：不再打死整份大纲，截断为前 2 个',
  lenient.outline[3].dataKeys.join(',') === 'coverage,reqList', lenient.outline[3].dataKeys);
ok('V-03 截断有回执：warnings 点名被去掉的键（面板看得见「哪块没上稿」）',
  lenient.warnings.some((w: string) => /第 4 页 dataKeys 3 个超出 2 个上限/.test(w) && /去掉：milestones/.test(w)),
  lenient.warnings);

const within = SVC.validateOutline(outlineOf(['coverage', 'reqList']), { lenientDataKeys: true });
ok('V-04 ≤2 的页不误伤：两种模式都不截、不记 warning',
  within.outline[3].dataKeys.length === 2 && !within.warnings.some((w: string) => /超出 2 个上限/.test(w)), within.warnings);

// 全稿唯一的时间线页正好是超限页：截断优先保留必含键，否则就是自己造一次硬失败
const keptTl = SVC.validateOutline(outlineOf(['reqList', 'milestones', 'timeline'], [false, true]), { lenientDataKeys: true });
ok('V-05 截断不把全稿唯一的必含键截没（timeline 优先保留）',
  keptTl.outline[3].dataKeys.includes('timeline') && keptTl.outline.some((p: any) => p.dataKeys.includes('timeline')),
  { page4: keptTl.outline[3].dataKeys, warn: keptTl.warnings.filter((w: string) => /超出/.test(w)) });

ok('V-08 既有「章节页/结束页 dataKeys 清空」口径未被新校验带崩',
  SVC.validateOutline(outlineOf(['reqStats'], [true, true])).outline[11].dataKeys.length === 0);

// ---------- G 组：大纲段真链路（门内自建隔离库 + 本地 mock 厂商，零真实配额） ----------
// V-01~V-08 问的是纯函数 `validateOutline`；原先另两条腿（V-06「RETRY 话术带新硬约束」、
// V-07「按解析轮次切软硬」）靠正则读 kickoffService.ts 的源码文本
// （let parseRound = 0 / parseRound++ / 每页 dataKeys **≤${DATA_KEYS_MAX} 个**）——等价重构一次就恒红。
// 本组把它们改判成**发往厂商的请求体**与**返回的大纲**：真 kickoffOutline → 真 AIService.askJson → 真重试协议。
// 夹具（隔离库 + mock 桩）由 scripts/lib/outline-harness.mts 单源提供，别的门复用同一套。
const GPID = 't02172-flex';
const H = await startOutlineHarness({
  projectId: GPID,
  projectName: 'mtask五期（下限门夹具）',
  workspacePath: ROOT,
  prdFilename: 'PRD-项目启动会PPT生成.md',
  prdContentMd: '# 背景\n门内自造的口径来源说明，正文够预检判定即可。',
  plans: [
    ...Array.from({ length: 12 }, (_, i) => ({
      id: `q${i}`, title: `任务 ${i + 1}`, start_date: iso(T0, i * 3), end_date: iso(T0, i * 3 + 6),
      duration_days: 5, progress: i < 8 ? 100 : 20, status: i < 8 ? 'done' : 'doing', assignee: '张三', complexity: (i % 5) + 1,
    })),
    ...Array.from({ length: 3 }, (_, i) => ({
      id: `m${i + 1}`, title: `M${i + 1} 里程碑`, start_date: iso(T0, i * 12), end_date: iso(T0, i * 12 + 2),
      duration_days: 2, kind: 'milestone', complexity: 3,
    })),
  ],
});

// 场景 A：模型两轮都写 3 个 dataKeys（超限页正好在第 4 页）
const over = JSON.stringify(outlineOf(['coverage', 'reqList', 'milestones']));
const A = await H.run([over, over]);
ok('G-01 首轮超限在真链路上确实触发了第 2 次厂商请求（「第 1 轮严格」不是纯函数层的自说自话）',
  A.asks === 2 && A.res.outline.length >= 10, { 请求次数: A.asks, 页数: A.res.outline.length });
ok('G-02 第 2 轮发出去的话术带着新硬约束（dataKeys ≤2）与首轮具体违规原因——看请求体，不看源码',
  /dataKeys/.test(A.systems[1]) && /≤\s*2\s*个/.test(A.systems[1]) &&
    /第 4 页 dataKeys 3 个超出 2 个上限/.test(A.systems[1]) &&
    !/上一轮输出被拒/.test(A.systems[0]),
  { 首轮话术尾部: A.systems[0].slice(-160), 重试话术: A.systems[1].slice(0, 420) });
ok('G-03 重试轮仍超限也不打死整稿：返回大纲第 4 页收到 2 个键、warnings 点名被去掉的 milestones',
  A.res.outline[3].dataKeys.join(',') === 'coverage,reqList' &&
    A.res.warnings.some((w: string) => /去掉：milestones/.test(w)),
  { 第4页: A.res.outline[3].dataKeys, warnings: A.res.warnings });

// 场景 B（互为反证）：模型首轮就写对 → 只发一次请求、不截断。
// A 的「必发第 2 轮」与 B 的「只发 1 轮」是一对判别式点位：若首轮就转软，B 与 A 都会只发一次；
// 若永远严格，A 会整稿失败——两条同时成立才说明「按解析轮次切软硬」真的接在链路上。
const withinLimits = JSON.stringify(outlineOf(['coverage', 'reqList']));
const B = await H.run([withinLimits]);
ok('G-04 反证侧：首轮合规只发一次请求、无截断回执（证明 G-01/G-03 不是恒真）',
  B.asks === 1 && B.res.outline[3].dataKeys.length === 2 &&
    !B.res.warnings.some((w: string) => /超出 2 个上限/.test(w)),
  { 请求次数: B.asks, 第4页: B.res.outline[3].dataKeys, warnings: B.res.warnings });

// 场景 C：全稿唯一的时间线页正好是超限页——真链路上也必须保住必含键
const tlOver = JSON.stringify(outlineOf(['reqList', 'milestones', 'timeline'], [false, true]));
const C = await H.run([tlOver, tlOver]);
ok('G-05 真链路同样不把全稿唯一的必含键截没（timeline 优先保留，V-05 的端到端版）',
  C.asks === 2 && C.res.outline[3].dataKeys.includes('timeline') &&
    C.res.outline.some((p: any) => p.dataKeys.includes('timeline')),
  { 第4页: C.res.outline[3].dataKeys, 请求次数: C.asks, warnings: C.res.warnings.filter((w: string) => /超出/.test(w)) });

// ---------- P 组：真产物 ----------
const built = await M.buildKickoffPpt(bundle as any, [
  page(0, [], 'cover'), page(1, [], 'toc'), page(2, ['reqStats']),
  page(3, ['coverage', 'reqList']), page(4, ['timeline'], 'timeline'), page(5, ['workload']), page(6, [], 'thanks'),
] as any);
const zip = await JSZip.loadAsync(built.buffer);
const slideNames = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
  .sort((a, b) => Number(/(\d+)\.xml/.exec(a)![1]) - Number(/(\d+)\.xml/.exec(b)![1]));
const xmls: Record<string, string> = {};
for (const n of slideNames) xmls[n] = await zip.file(n)!.async('string');

/** 抽出每页图表框的真实高度（EMU→英寸）：graphicFrame 里的 chart + xfrm ext */
const chartsOf = (xml: string) =>
  (xml.match(/<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/g) ?? [])
    .filter((f) => /\/chart/.test(f))
    .map((f) => Number(/<a:ext cx="(\d+)" cy="(\d+)"/.exec(f)?.[2] ?? 0) / EMU);
const allCharts = slideNames.flatMap((n) => chartsOf(xmls[n]));
ok('P-01 产物里每张图表实排高 ≥ 1.2"（EMU 逐张核对，压扁的图就是不可读）',
  allCharts.length > 0 && allCharts.every((h) => h >= CHART_FLOOR - 1e-4), allCharts.map((h) => +h.toFixed(3)));
ok('P-02 页面上没出图的必须带 drop 留痕（placed 或点名，二选一，不许静默消失）',
  slideNames.every((n, i) => {
    const wanted = /覆盖率|用例覆盖/.test(xmls[n]) && i === 3;
    if (!wanted || chartsOf(xmls[n]).length > 0) return true;
    return (built.warnings ?? []).some((w: string) => /省略/.test(w) && /图表/.test(w));
  }),
  { slides: slideNames.map((n) => chartsOf(n).length), warnings: built.warnings });
ok('P-03 全稿无越界降级页、无版式违规告警（下限抬高没把别的页带崩）',
  built.degradedPages.length === 0 && !built.warnings.some((w: string) => /越界|超出页面/.test(w)),
  { degraded: built.degradedPages, warnings: built.warnings });

writeFileSync(gateArtifactPath(OUT_DIR, 't02172-flex.pptx'), built.buffer);
// G 组收口交给夹具：关桩 → 关库句柄 → 删临时库（动态 import 自持 SQLite 句柄，不关会让删目录打转）
H.close();
writeGateResults(OUT_DIR, 't02172-gate-results.txt', `T02172 柔性块可读高与 dataKeys 硬校验门：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`);
console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
