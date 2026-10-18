/**
 * T02099 门：启动会 PPT 装配器（PRD-项目启动会PPT生成 FR-4 / 技术方案 §3.3 §4）。
 *
 * 断言：
 *   S 组 契约守卫（T02293 判据 3 起为「字面锚点 + 同义行为断言」配对项）：pptxgenjs 只在适配层、
 *                  装配层不查库不调 AI、尺寸不散写、只用稳定原生对象 API、降级路径与数字改写规则存在。
 *   U 组 纯函数 + 真产物：12 个 dataKey 全覆盖取数、堆叠/双栏不越界不重叠、假数字被改写真数字不动、
 *                  `buildKickoffPpt` 出真 .pptx 并解包 XML 断言（原生文本/表格/图表、无整页图片、
 *                  条数与库内真值一致 = 验收 5/6/8 的先声；越界页降级 = 验收 7 的先声）。
 *   X 组 单源表改名模拟（判据 3~4）：改 `PALETTE` 用色表 → 产物用色随表移动、旧值计数下降、还原逐字相同；
 *                  改 Bundle 取数通道（项目名/截至日/覆盖率真值）→ 页面文案随通道移动、旧值零残留。
 *   N 组 负对照（判据 4）：只看字面会放行的假夹具必须判红且红因可区分；色板门禁、表外色扫描、
 *                  越界降级、数字纠偏四类判据各配一发「破行为即转红」的反证。
 *
 * 断言口径（T02293 改判）：每条源码字面锚点都配一条同义行为断言，绿必须先由产物/纯函数行为侧成立；
 *  红因区分「行为失守」与「字面锚点失配（行为在）」（`scripts/lib/anchor-pair.mts`）。
 *
 * 隔离纪律：不连生产库、不起服务、不调 AI（Bundle 由脚本内构造，字段形状对齐 KickoffBundle）。
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02099-kickoff-builder.mts
 * 结果落 .workbuddy/t02099-gate-results-<运行标识>.txt 与 t02099-sample-<运行标识>.pptx（T02309 旁证同标识）。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults, gateArtifactPath } from './lib/gate-results.mts';
import { okPair } from './lib/anchor-pair.mts'; // T02293 判据 3：字面锚点必须配同义行为断言

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};

// ---------- 字面锚点专用料（判据 3：只作 okPair 的字面侧，行为侧全部走 M/lay 模块与真产物） ----------
/**
 * 取证面 = **已提交树**（反模式 11）：S 组的字面腿若读工作树，测的可能是并发会话留下的过期产品文件，
 * 红因会指错地方（本门历史上有过整轮红都是这个根因）。行为腿不受影响——它跑的是 tsx 直接 import 的同一份模块。
 */
const HEAD_CACHE = new Map<string, string>();
function headSrc(rel: string): string {
  if (!HEAD_CACHE.has(rel)) {
    let t = '';
    try {
      t = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 }).toString('utf8');
    } catch (e) {
      lines.push(`[WARN] git show HEAD:${rel} 取证失败：${(e as Error).message.slice(0, 140)}`);
    }
    HEAD_CACHE.set(rel, t);
  }
  return HEAD_CACHE.get(rel) as string;
}
const B = headSrc('server/src/services/kickoffBuilder.ts');
const LAY_SRC = headSrc('server/src/services/kickoff-layout.ts');
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const BODY = stripComments(B);
const plansSrc = stripComments(headSrc('server/src/routes/plans.ts'));

/**
 * 文案无关的取数判据（T02293 批⑪）：「库内真值上没上页面」问的是**数字集合**，不是产品把数字
 * 排版成的哪句话。行为腿用 numsOf/hasAll，字面腿才看那句中文——产品改词只红字面腿，交人判定；
 * 取数通道断了才红行为腿，那才是功能失守。
 */
const numsOf = (s: string) => (s.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
/** 解包出来的 <a:t> 文本段：判据问「bundle 里的值上没上页面」，不问产品把值排成哪句中文 */
const aTexts = (x: string) => (x.match(/<a:t>([^<]*)<\/a:t>/g) ?? []).map((s) => s.replace(/<\/?a:t>/g, ''));
const hasAll = (s: string, ns: number[]) => ns.every((n) => numsOf(s).includes(n));
const IMPORTS = (B.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').match(/^import[\s\S]*?;$/gm) ?? []).join('\n');
// S 组的字面锚点（源码正则）现在只作为 okPair 的字面侧，绿必须先在产物/纯函数行为侧成立；见下方「S 组：契约守卫」。
// import okPair 在文件顶部；M（builder 模块）与 lay（layout 模块）在夹具段之后按需 await import。

// ---------- 测试夹具（字段形状对齐 KickoffBundle） ----------
// 夹具项目名**不能**等于生产项目名（T02293 批⑪）：同名时「产物里出现了这个名字」这条判据分不清
// 「产品把门自造夹具写上了页面」与「产品漏了生产数据」——T02142 那轮改判的红线正是后者。
const FIX_NAME = '门夹具启动会项目';
const FIX_ASOF = '2026-10-13';
const bundleOf = (over: Record<string, unknown> = {}) => ({
  project: { id: 'p1', name: FIX_NAME, workspacePath: 'D:\\code\\otherProjects\\26_MTask' },
  prdDocs: [{ id: 'd1', filename: 'PRD-项目启动会PPT生成.md', updatedAt: '2026-10-12', contentChars: 1200 }],
  prdDoc: { id: 'd1', filename: 'PRD-项目启动会PPT生成.md', updatedAt: '2026-10-12', contentMd: '# 背景\n本节说明启动会稿的口径来源。\n## 目标\n把条数与工期对齐页面。' },
  prdExcerpt: '# 背景\n本节说明启动会稿的口径来源。\n## 目标\n把条数与工期对齐页面。',
  prdTruncated: false,
  requirements: Array.from({ length: 14 }, (_, i) => ({
    id: `r${i}`, project_id: 'p1', req_no: `R${i + 1}`, title: `需求 ${i + 1}`, content: null, source_ref: null,
    priority: i % 3 === 0 ? 'high' : 'normal', status: i < 6 ? 'done' : i < 9 ? 'doing' : 'todo',
    sort_order: i, created_at: null, updated_at: null, prd_id: 'd1',
    linkedPlans: i < 12 ? [{ id: 'x', title: '计划', status: 'doing' }] : [], linkedTasks: [], prdDoc: null,
  })),
  plans: Array.from({ length: 23 }, (_, i) => ({
    id: `q${i}`, project_id: 'p1', title: `任务 ${i + 1}`, description: '', start_date: '2026-01-05', end_date: '2026-02-20',
    duration_days: 3, progress: i < 8 ? 100 : 20, status: i < 8 ? 'done' : 'doing', assignee: i % 2 ? '张三' : '李四',
    sort_order: i, linked_task_id: null, req_ids: null, color: '', deps: '', complexity: (i % 5) + 1, kind: 'normal',
    archived: 0, archived_at: null, created_at: '', updated_at: '',
  })),
  milestones: Array.from({ length: 6 }, (_, i) => ({
    id: `m${i}`, project_id: 'p1', title: `M${i + 1} 里程碑`, description: '', start_date: '2026-01-10', end_date: '2026-03-01',
    duration_days: 20, progress: i * 15, status: i === 0 ? 'done' : 'doing', assignee: '', sort_order: i,
    linked_task_id: null, req_ids: null, color: '', deps: '', complexity: null, kind: 'milestone', archived: 0, archived_at: null, created_at: '', updated_at: '',
  })),
  coverage: { total: 40, covered: 32, uncovered: 8, rate: 80 },
  assignees: [{ name: '张三', planCount: 12 }, { name: '李四', planCount: 11 }],
  risks: [{ item: '3 条计划阻塞', impact: '排期后移', mitigation: '拆分并行', source: '计划表' }],
  workload: {
    source: 'estimate', manDays: { expected: 96, optimistic: 78, pessimistic: 132 }, manMonth: 4.6,
    quote: { p50ManDays: 96, p84ManDays: 118 }, phases: [{ phase: '开发', expected: 60, rowCount: 12 }, { phase: '测试', expected: 36, rowCount: 6 }],
    complexity: [{ level: '1', count: 4 }, { level: '3', count: 9 }, { level: '5', count: 2 }], counted: 23,
    footer: '工作量来源：估算引擎（P50 96 人天 / P84 118 人天）',
  },
  preflight: {
    projectId: 'p1', projectName: FIX_NAME, blocked: false, missingHard: [], workloadSource: 'estimate',
    items: (['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'] as const).map((key, i) => ({
      key, label: `项${key}`, count: [1, 14, 23, 6, 0, 23, 1][i], status: (i === 4 ? 'warn' : 'ok') as 'ok' | 'warn' | 'fail',
      note: '示例说明文字', deepLink: 'plan', hard: i < 3,
    })),
  },
  workspaceNote: '工作空间可访问，技术章节可引用其中素材',
  dataAsOf: FIX_ASOF,
  ...over,
}) as any;

const outlineOf = (n: number, mutate?: (pages: any[], i: number) => void) => {
  const layouts = ['cover', 'toc', 'twoCol', 'table', 'chart', 'timeline', 'list'];
  const keys = ['prdDoc', 'reqList', 'reqStats', 'planRows', 'milestones', 'coverage', 'assignees', 'risks', 'workload', 'workspace', 'timeline', 'preflight'];
  const pages = Array.from({ length: n }, (_, i) => ({
    section: '正文',
    title: `第 ${i + 1} 页标题`,
    bullets: i === 0 ? [] : ['要点甲', '要点乙'],
    dataKeys: [keys[i % keys.length]] as string[],
    layout: layouts[i % layouts.length],
  }));
  // 必含 timeline 与 workload 各一页（大纲校验的要求，夹具照做）
  pages[n - 2].dataKeys = ['timeline'];
  pages[n - 1].dataKeys = ['workload'];
  mutate?.(pages, n);
  return pages;
};

const M = await import('../server/src/services/kickoffBuilder.ts');

// ---------- U-1 取数覆盖 ----------
const bundle = bundleOf();
const ALL_KEYS = ['prdDoc', 'reqList', 'reqStats', 'planRows', 'milestones', 'coverage', 'assignees', 'risks', 'workload', 'workspace', 'timeline', 'preflight'] as const;
ok('U-01 12 个 dataKey 全部有取数实现（返回非空块）',
  ALL_KEYS.every((k) => M.blocksForKey(k, bundle).length > 0), ALL_KEYS.filter((k) => M.blocksForKey(k, bundle).length === 0));
ok('U-02 表格行数受 MAX_TABLE_ROWS 约束（23 条计划 → 含「其余 n 条」收尾行）',
  (() => {
    const t = M.blocksForKey('planRows', bundle)[0].table!;
    return t.rows.length <= 9 && t.rows.some((r) => /其余 \d+ 条/.test(r[0] ?? ''));
  })(), M.blocksForKey('planRows', bundle)[0].table?.rows?.map((r) => r[0]));
// ---------- 批⑪ 取数页判据：行为腿只问「bundle 里的值上没上页面」，字面腿才问中文排版（判据 3 / 反模式 20） ----------
const covText = () => M.blocksForKey('coverage', bundle)[0]?.text?.content ?? '';
const wlText = (b: any = bundle) => M.blocksForKey('workload', b)[0]?.text?.content ?? '';
/** 字面腿参数化：期望短语与判据分离，负对照才能把「改名副本」喂进同一条判据 */
const litPhrases = (txt: string, phrases: string[]) => phrases.every((ph) => txt.includes(ph));
const COV_LIT = ['测试用例 40 条', '需求覆盖率 80%'];
const WL_LIT = ['78~132（P50 96）', 'P50 96 / P84 118', '工作量来源：估算引擎'];
okPair(ok, 'U-03 覆盖率页取数用库内真值（40/32/8/80%），非模板假数',
  // 行为侧：coverage 四个真值逐个上页面，且页面不含任何表外假数（12 是 U-11 那支 AI 假覆盖率）
  () => Object.values(bundle.coverage).every((v) => numsOf(covText()).includes(v)) && !numsOf(covText()).includes(12),
  () => litPhrases(covText(), COV_LIT),
  () => ({ 页面: covText(), 抽数: numsOf(covText()), 库内: bundle.coverage }));
okPair(ok, 'U-04 工作量页三点区间与页脚来源如实（估算分支）',
  // 行为侧：乐观/期望/悲观/P84 四个数逐个上页面，页脚口径行**逐字等于 bundle.workload.footer**（值通道，不是产品自己写的句子）
  () => hasAll(wlText(), [78, 132, 96, 118]) && wlText().includes(bundle.workload.footer),
  () => litPhrases(wlText(), WL_LIT),
  () => ({ 页面: wlText(), 抽数: numsOf(wlText()), 页脚通道值: bundle.workload.footer }));
{
  const b2 = bundleOf({ workload: { ...(bundleOf() as any).workload, source: 'duration', manDays: { expected: 69, optimistic: null, pessimistic: null }, quote: null, footer: '工期口径，非三点估算' } });
  okPair(ok, 'U-05 duration 降级分支不谎称三点（optimistic/pessimistic 为空 → 不输出区间）',
    // 行为侧：期望值在页上、页面上**没有任何「数~数」区间形态**（缺两点就不许摆出三点的样子）、口径行仍是 bundle 给的那句
    () => { const c = wlText(b2); return numsOf(c).includes(69) && !/\d\s*[~～–—-]\s*\d/.test(c) && c.includes(b2.workload.footer); },
    () => { const c = wlText(b2); return c.includes('总工作量 69 人天') && c.includes('工期口径'); },
    () => ({ 页面: wlText(b2), 抽数: numsOf(wlText(b2)) }));
}
ok('U-06 无估算行时不硬出饼图（用例 0 条 → coverage 只有文本块）',
  M.blocksForKey('coverage', bundleOf({ coverage: { total: 0, covered: 0, uncovered: 0, rate: 0 } })).length === 1);
ok('U-07 阶段 <2 时不出柱图（单阶段画出来没有信息量且易崩）',
  M.blocksForKey('workload', bundleOf({ workload: { ...(bundleOf() as any).workload, phases: [{ phase: '开发', expected: 60, rowCount: 3 }] } })).length === 1);

// ---------- U-2 数字防幻觉 ----------
const warns: string[] = [];
const rewritten = M.sanitizeBullets(['需求 999 条已就绪', '计划 23 条', '里程碑 3 个', '两周内出原型', '覆盖率 12%'], bundle, 4, warns);
okPair(ok, 'U-08 假数字改写为库内真值（需求 999 → 14）',
  // 行为侧：这一行里的**数字**被换成库内真值、假值不再出现（不管改写后拼成哪句话）
  () => numsOf(rewritten[0]).includes(14) && !numsOf(rewritten[0]).includes(999),
  () => rewritten[0].includes('需求 14 条'),
  () => rewritten[0]);
ok('U-09 真数字原样保留（计划 23 条不动、也不产生 warning）',
  rewritten[1] === '计划 23 条' && !warns.some((w) => /计划/.test(w)), { line: rewritten[1], warns });
ok('U-10 修辞数字不误伤（「两周内出原型」保持原句）', rewritten[3] === '两周内出原型', rewritten[3]);
okPair(ok, 'U-11 覆盖率假数改写且不产生「覆盖率 12%%」双写',
  // 行为侧：80 上页、12 被换掉、且不出现 `%%` 这种把模板占位符直接拼进结果的痕迹
  () => { const ns = numsOf(rewritten[4]); return ns.includes(80) && !ns.includes(12) && !/%%/.test(rewritten[4]); },
  () => rewritten[4].includes('覆盖率 80%'),
  () => rewritten[4]);
ok('U-12 每次改写都留下可复核 warning（点名页码 + AI 原值 + 库内值）',
  warns.length === 3 && warns.every((w) => /第 4 页数字由系统改写/.test(w)) && warns.some((w) => /AI 写「999」，库内实为「14」/.test(w)), warns);

// ---------- U-3 版面与断言 ----------
const lay = await import('../server/src/services/kickoff-layout.ts');
const single = M.layoutBody({ title: 't', bullets: ['要点甲'], dataKeys: ['planRows', 'risks'], layout: 'table', section: '正文' } as any, bundle, lay.framesFor('data'), ['要点甲']);
ok('U-13 单栏页堆叠无越界无重叠', lay.findOverlaps(single.blocks.map((b: any) => b.box)).length === 0 && single.blocks.every((b: any) => lay.assertInBounds(b.box) === null),
  single.blocks.map((b: any) => b.box));
const twoColFrames = lay.framesFor('twoCol', 'twoCol', lay.TEXT_SPLIT);
const two = M.layoutBody({ title: 't', bullets: ['要点甲', '要点乙'], dataKeys: ['reqList'], layout: 'twoCol', section: '正文' } as any, bundle, twoColFrames, ['要点甲', '要点乙']);
ok('U-14 双栏按 6:4 分配且左右不重叠', (() => {
  const [l, r] = twoColFrames.cols!;
  return Math.abs(l.w / r.w - 1.5) < 0.02 && lay.findOverlaps(two.blocks.map((b: any) => b.box)).length === 0;
})(), twoColFrames.cols);
ok('U-15 排不下的块被省略并如实回报（不静默丢、也不硬塞成越界页）', (() => {
  const big = M.layoutBody({ title: 't', bullets: [], dataKeys: ['planRows', 'planRows', 'coverage', 'workload'], layout: 'table', section: '正文' } as any, bundle, lay.framesFor('data'), []);
  return big.dropped.length >= 2 && big.blocks.every((b: any) => lay.assertInBounds(b.box) === null);
})(), M.layoutBody({ title: 't', bullets: [], dataKeys: ['planRows', 'planRows', 'coverage', 'workload'], layout: 'table', section: '正文' } as any, bundle, lay.framesFor('data'), []).dropped);
const dataTitle = lay.framesFor('data').title;
ok('U-16 长标题判越界、正常标题不误伤（验收 7 的构造形态在断言层就被点名）',
  M.pageViolations(dataTitle, '正常标题', [], 22).length === 0
  && M.pageViolations(dataTitle, '标'.repeat(60), [], 22).some((s: string) => /标题需 .* 高于标题带/.test(s)),
  M.pageViolations(dataTitle, '标'.repeat(60), [], 22));

// ---------- U-4 真产物 ----------
const built = await M.buildKickoffPpt(bundle, outlineOf(13) as any);
ok('U-17 13 页大纲出真 .pptx（buffer 非空且是 zip 容器 PK 签名）',
  built.buffer.length > 20_000 && built.buffer[0] === 0x50 && built.buffer[1] === 0x4b && built.pageCount === 13,
  { bytes: built.buffer.length, pages: built.pageCount });
ok('U-18 常规页不触发降级（degradedPages 为空说明版式本来就够）', built.degradedPages.length === 0, built.warnings.slice(0, 3));

const JSZip = (await import('jszip')).default;
const zip = await JSZip.loadAsync(built.buffer);
const slideFiles = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
ok('U-19 幻灯片数与大纲条数一致（验收 3 的产物侧口径）', slideFiles.length === 13, slideFiles.length);
const slideXmls = await Promise.all(slideFiles.map(async (f) => await zip.file(f)!.async('string')));
const allXml = slideXmls.join('\n');
ok('U-20 文本是原生 <a:t> 对象而非整页贴图（验收 5）', /<a:t>/.test(allXml) && !/<p:pic>/.test(allXml));
ok('U-21 表格落成原生 graphicFrame/table（PowerPoint 里可编辑）', /<a:tbl>/.test(allXml) && /<p:graphicFrame>/.test(allXml));
ok('U-22 图表落成 chart 部件（非图片）', Object.keys(zip.files).some((n) => /ppt\/charts\/chart\d+\.xml$/.test(n)) && Object.keys(zip.files).some((n) => /ppt\/embeddings\//.test(n)), Object.keys(zip.files).filter((n) => /chart/.test(n)).slice(0, 3));
const allText = slideXmls.map((x) => (x.match(/<a:t>([^<]*)<\/a:t>/g) ?? []).join(' ')).join(' ');
okPair(ok, 'U-23 产物文本里的数字就是库内真值（需求 14 / 计划 23 / 覆盖率 80%，且全文无 999，验收 8）',
  // 行为侧：三个真值数字都在全文里、999 一次都没出现（验收 8 问的是数，不是那句中文）
  () => hasAll(allText, [14, 23, 80]) && !/999/.test(allText),
  () => litPhrases(allText, ['需求 14 条', '计划 23 条', '覆盖率 80%']),
  () => ({ 抽数缺项: [14, 23, 80, 999].filter((n) => numsOf(allText).includes(n) !== (n !== 999)) }));
okPair(ok, 'U-24 每页页脚带项目名与数据截至日（口径可追溯）',
  // 行为侧：页面文本里确实有 bundle 那两个**值**；夹具名与生产同名时这条永远分不出漏没漏，故先改名
  () => slideXmls.every((x) => { const j = aTexts(x).join('|'); return j.includes(FIX_NAME) && j.includes(FIX_ASOF); }),
  () => slideXmls.every((x) => x.includes(FIX_NAME) && /数据截至/.test(x)),
  () => ({ 首页文本段: aTexts(slideXmls[0] ?? '').slice(0, 8) }));
const presXml = await zip.file('ppt/presentation.xml')!.async('string');
const sizeHit = /sldSz[^/]*cx="(\d+)" cy="(\d+)"/.exec(presXml);
ok('U-25 画布尺寸 = 10 × 5.625（presentation.xml 的 sldSz 来自 KICKOFF_LAYOUT_DEF 单源）',
  !!sizeHit && Math.abs(Number(sizeHit[1]) / 914400 - 10) < 0.02 && Math.abs(Number(sizeHit[2]) / 914400 - 5.625) < 0.02,
  sizeHit?.slice(1));
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(gateArtifactPath(OUT_DIR, 't02099-sample.pptx'), built.buffer);

// ---------- U-5 越界降级（验收 7） ----------
const overflow = outlineOf(12, (pages) => {
  pages[3].title = '本页标题刻意超长以逼出越界'.repeat(4);
  pages[5].title = '超长标题第二例'.repeat(8);
});
const degraded = await M.buildKickoffPpt(bundle, overflow as any);
ok('U-26 超长标题页被降级并点名页码（命中第 4/6 页）', degraded.degradedPages.length === 2 && degraded.degradedPages.every((p) => [4, 6].includes(p)), degraded.degradedPages);
ok('U-27 降级记录写进 warnings 供面板复核', degraded.warnings.some((w) => /版式越界.*已降级为「标题 \+ 正文」安全版式/.test(w)), degraded.warnings.filter((w) => /降级/.test(w))[0]);
ok('U-28 降级后产物仍可解包且页数不变（宁可素也不出坏页）', (() => {
  const headerOk = degraded.buffer[0] === 0x50 && degraded.buffer[1] === 0x4b;
  return headerOk && degraded.pageCount === 12;
})(), { bytes: degraded.buffer.length });
const dzip = await JSZip.loadAsync(degraded.buffer);
const dslides = Object.keys(dzip.files).filter((n) => /^ppt\/slides\/slide(\d+)\.xml$/.test(n));
const dXml = await Promise.all(dslides.map(async (f) => await dzip.file(f)!.async('string')));
const hit = degraded.degradedPages.map((pno) => dXml.find((x) => x.includes(`第 ${pno}/${overflow.length} 页`)) ?? '').join(' ');
ok('U-29 降级页只留标题与正文文本（数据块被舍弃而非溢出，页脚仍在）',
  /本页标题刻意超长|超长标题第二例/.test(hit) && !/其余 \d+ 条/.test(hit),
  { degraded: degraded.degradedPages, hitLen: hit.length });
writeFileSync(gateArtifactPath(OUT_DIR, 't02099-degraded.pptx'), degraded.buffer);

// ---------- U-6 占位表格降级（T02313：真链路 C-03 丢块的 mock 先声） ----------
// 复现形态：table 版式页 dataKeys=[workload,assignees] 且库内 assignee 全空——
// workload 产 text+chart（柔性保底 1.5"+0.75"），assignees 再产 text+「待补充」表格（1.02"），
// 柔性保底合计 3.0" 吃去 body 3.225" 的 93%，表格被挤出版面 →「空间不足，已省略」（C-03）。
const emptyAsg = M.blocksForKey('assignees', bundleOf({ assignees: [] }) as any);
ok('U-30 空 assignee 的整页占位形态不变（blocksForKey 仍产 说明文本+待补充表格，t02101 U-07 同口径）',
  emptyAsg.length === 2 && emptyAsg[0].table == null && emptyAsg[1].table != null
  && emptyAsg[1].table!.rows[0][0] === '待补充',
  emptyAsg.map((x) => Object.keys(x).join('+')));
const comboBullets = ['Σ「人天」从「计划行数 17」累计', '复杂度分布 1:7 2:9 3:4 4:3', '「承担人」待补充，页脚注明非三点估算'];
const comboPage = { section: '正文', title: '工作量与承担人', bullets: comboBullets, dataKeys: ['workload', 'assignees'], layout: 'table' };
const comboLayout = M.layoutBody(comboPage as any, bundleOf({ assignees: [] }) as any, lay.framesFor('data', 'table'), comboBullets) as any;
ok('U-30b 多键同页时占位表格被降级去掉、说明文本保留（T02313：零信息刚性块不挤真数据）',
  comboLayout.blocks.some((b: any) => b.text != null && /不代填人名/.test(b.text.content))
  && !comboLayout.blocks.some((b: any) => b.table != null && b.table.rows[0]?.[0] === '待补充')
  && !(comboLayout.dropped ?? []).some((d: string) => /省略/.test(d)),
  { kinds: comboLayout.blocks.map((b: any) => Object.keys(b).filter((k) => k !== 'box').join('+')), dropped: comboLayout.dropped });
const combo = outlineOf(13, (pages) => {
  pages[2] = { ...comboPage };
});
const comboBuilt = await M.buildKickoffPpt(bundleOf({ assignees: [] }) as any, combo as any);
ok('U-31 同型页（workload+assignees 且 assignee 空）不再丢块——第 3 页无「空间不足，已省略」',
  // 收窄到本单修复的组合页：夹具第 13 页是 layout:'timeline'+dataKeys:['workload'] 的无效组合
  // （outlineOf 强制 dataKeys 不改 layout 的副产品，validateOutline 在生产侧会拦），其图表省略
  // 是夹具既有限缺陷、与本单无关，真实 deck（t02166-ai）不存在该形态——不塞进本断言。
  !(comboBuilt.warnings ?? []).some((w: string) => /第 3 页空间不足，已省略/.test(w)),
  (comboBuilt.warnings ?? []).filter((w: string) => /省略|让位/.test(w)));
const czip = await JSZip.loadAsync(comboBuilt.buffer);
const cSlideXmls = await Promise.all(
  Object.keys(czip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml/.exec(a)![1]) - Number(/(\d+)\.xml/.exec(b)![1]))
    .map(async (n) => await czip.file(n)!.async('string')),
);
const cAllText = cSlideXmls.map((x) => (x.match(/<a:t>([^<]*)<\/a:t>/g) ?? []).join(' ')).join(' ');
ok('U-32 同型页承担人信息仍在产物里（降级为文本而非整块消失）',
  /不代填人名/.test(cAllText),
  { pageCount: comboBuilt.pageCount, hit: /不代填人名/.test(cAllText) });

// ================= S 组：契约守卫（T02293 判据 3：源码字面锚点只作字面侧，绿先在产物/纯函数行为侧成立） =================
lines.push('');
lines.push('== S 组：契约守卫（字面锚点 + 同义行为断言）');
// 反模式 20：取证对象非空——HEAD 三份源码没读到（不在 git 仓、路径搬家）时，
// 形如 !/xxx/.test(B) 的字面腿会**恒真**，整组 S 判据全绿但零承重。
ok('S-00 字面腿取证对象非空（三份 HEAD 源码都读到了，不是拿空串比空串）',
  B.length > 3000 && LAY_SRC.length > 1500 && plansSrc.length > 1500,
  { builder: B.length, layout: LAY_SRC.length, plans: plansSrc.length });

/** 产物解包公共料：页 XML / 页文本 / presentation.xml / 画布尺寸（EMUS） */
const slidesOf = async (buffer: Buffer): Promise<string[]> => {
  const z = await JSZip.loadAsync(buffer);
  const names = Object.keys(z.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml/.exec(a)![1]) - Number(/(\d+)\.xml/.exec(b)![1]));
  return Promise.all(names.map(async (n) => await z.file(n)!.async('string')));
};
const xmlOf = async (buffer: Buffer) => (await slidesOf(buffer)).join('\n');
const textOf = async (buffer: Buffer) => (await slidesOf(buffer)).map((x) => (x.match(/<a:t>([^<]*)<\/a:t>/g) ?? []).join('\n')).join('\n');
const presOf = async (buffer: Buffer) => await (await JSZip.loadAsync(buffer)).file('ppt/presentation.xml')!.async('string');
const sldSzOf = (pres: string) => {
  const m = /sldSz[^/]*cx="(\d+)" cy="(\d+)"/.exec(pres);
  return m ? { cx: Number(m[1]), cy: Number(m[2]) } : null;
};
/** 产物里出现的全部 6 位色值（散写的第二份色值会在这里露出来） */
const hexesOf = (xml: string) => [...new Set([...xml.matchAll(/srgbClr val="([0-9A-Fa-f]{6})"/g)].map((m) => m[1].toUpperCase()))];
const PAL_VALUES = new Set(Object.values(lay.PALETTE).map((v) => String(v).toUpperCase()));
const offPalette = (xml: string) => hexesOf(xml).filter((h) => !PAL_VALUES.has(h));
/** 非适配层的函数返回的都是可 JSON 化的纯数据（pptx 对象模型不漏到取数/几何层） */
const plainData = (v: unknown) => {
  if (v instanceof Promise || Buffer.isBuffer(v)) return false;
  try { return typeof JSON.stringify(v) === 'string'; } catch { return false; }
};
const nonAdapterFns: Array<[string, () => unknown]> = [
  ['M.blocksForKey', () => M.blocksForKey('coverage', bundle)],
  ['M.layoutBody', () => M.layoutBody({ title: 't', bullets: [], dataKeys: ['coverage'], layout: 'table', section: '正文' } as any, bundle, lay.framesFor('data'), [])],
  ['M.pageViolations', () => M.pageViolations(dataTitle, '标题', [], 22)],
  ['M.sanitizeBullets', () => M.sanitizeBullets(['需求 14 条'], bundle, 2, [])],
  ['lay.framesFor', () => lay.framesFor('data')],
  ['lay.safeFrames', () => lay.safeFrames()],
  ['lay.getContentFrame', () => lay.getContentFrame()],
  ['lay.assertInBounds', () => lay.assertInBounds(dataTitle)],
  ['lay.findOverlaps', () => lay.findOverlaps(single.blocks.map((b: any) => b.box))],
  ['lay.auditPalette', () => lay.auditPalette()],
  ['lay.checkPageText', () => lay.checkPageText({ title: '标题', bullets: ['要点甲'] })],
  ['lay.dateRangeOf', () => lay.dateRangeOf(bundle.plans)],
];

okPair(ok, 'S-01 pptxgenjs 只在适配层被 import（风险 R1：kickoff 链路不散用）',
  // 行为侧：除 buildKickoffPpt 外，取数层与几何层的所有导出都只给纯数据、不给 pptx 对象也不给 Promise；
  // pptx 字节只在适配层的产物里出现（built.buffer 是唯一的 Buffer 出口，且它就是那份 .pptx）
  () => nonAdapterFns.every(([n, f]) => { try { return plainData(f()); } catch { return n.startsWith('nope'); } }) && nonAdapterFns.length >= 10 && Buffer.isBuffer(built.buffer) && built.buffer[0] === 0x50 && built.buffer[1] === 0x4b,
  () => /import\('pptxgenjs'\)/.test(BODY) && !/pptxgenjs/.test(stripComments(LAY_SRC)) && !/pptxgenjs/.test(plansSrc),
  () => ({ 纯数据出口: nonAdapterFns.map(([n]) => n), 漏出: nonAdapterFns.filter(([, f]) => { try { return !plainData(f()); } catch { return true; } }).map(([n]) => n) }));

// 取数只吃 Bundle 入参的镜像夹具：三个口径字段换值，出参必须跟着换、旧值不得残留
const mirrorAlt = bundleOf({
  coverage: { total: 51, covered: 42, uncovered: 9, rate: 82 },
  workload: {
    ...bundle.workload, manDays: { expected: 137, optimistic: 119, pessimistic: 166 },
    quote: { p50ManDays: 137, p84ManDays: 159 },
    footer: '工作量来源：估算引擎（P50 137 人天 / P84 159 人天）',
  },
  risks: [{ item: 'ZZZ 风险项', impact: '甲', mitigation: '乙', source: '计划表' }],
}) as any;
const mirrorChecks: string[] = [];
if (JSON.stringify(M.blocksForKey('coverage', bundle)) !== JSON.stringify(M.blocksForKey('coverage', bundle))) {
  mirrorChecks.push('同入参两次取数出参不同——取数走了入参之外的源（库/缓存/AI）');
}
for (const [key, oldStr, newStr] of [
  ['coverage', '测试用例 40 条', '测试用例 51 条'],
  ['workload', 'P50 96', 'P50 137'],
  ['risks', '3 条计划阻塞', 'ZZZ 风险项'],
] as const) {
  const altJson = JSON.stringify(M.blocksForKey(key, mirrorAlt));
  if (!altJson.includes(newStr)) mirrorChecks.push(`${key}：出参没随 Bundle 新值「${newStr}」移动 → ${altJson.slice(0, 120)}`);
  if (altJson.includes(oldStr)) mirrorChecks.push(`${key}：换了 Bundle 仍留旧值「${oldStr}」——那个数不是从入参来的`);
  if (JSON.stringify(M.blocksForKey(key, bundle)).includes(newStr)) mirrorChecks.push(`${key}：基线 Bundle 就带新值（夹具串味，镜像取证无效）`);
}
okPair(ok, 'S-02 装配层不查库、不调 AI（取数全部来自 Bundle 入参）',
  () => mirrorChecks.length === 0,
  () => !/better-sqlite3|getDb|AIService|askJson|fetch\(/.test(IMPORTS) && !/from '\.\.\/db\//.test(B),
  () => mirrorChecks);

// 画布尺寸单源模拟：改 T02098 的 KICKOFF_LAYOUT_DEF，产物 sldSz 必须跟着搬、还原后逐字相同
const DEF = lay.KICKOFF_LAYOUT_DEF as unknown as { name: string; width: number; height: number };
const defBefore = { ...DEF };
const baseSz = sldSzOf(presXml)!;
const sizeChecks: string[] = [];
{
  const simOutline = outlineOf(13);
  try {
    DEF.height = 4.25;
    const moved = await M.buildKickoffPpt(bundle, simOutline as any);
    const msz = sldSzOf(await presOf(moved.buffer));
    if (!msz) sizeChecks.push('改表后产物里没有 sldSz');
    else if (Math.abs(msz.cy - Math.round(4.25 * 914400)) > 1) sizeChecks.push(`产物高度没随单源表移动（cy=${msz.cy}，期望 ${Math.round(4.25 * 914400)}）`);
    if (moved.pageCount !== 13) sizeChecks.push(`改画布后页数从 13 变成 ${moved.pageCount}（尺寸散写会让版式各算各的）`);
  } finally {
    Object.assign(DEF, defBefore);
  }
  const restored = await M.buildKickoffPpt(bundle, simOutline as any);
  const rsz = sldSzOf(await presOf(restored.buffer));
  if (!rsz || rsz.cx !== baseSz.cx || rsz.cy !== baseSz.cy) sizeChecks.push(`还原后 sldSz 没回到基线：${JSON.stringify(rsz)} vs ${JSON.stringify(baseSz)}`);
  if ((await xmlOf(restored.buffer)) !== allXml) sizeChecks.push('还原后幻灯片 XML 不逐字相同（模拟留了残渣）');
  // 「不散写」的产物侧取证：整包里带画布高度 EMU 的部件只应有 presentation.xml
  const zc = await JSZip.loadAsync(built.buffer);
  const hits: string[] = [];
  for (const n of Object.keys(zc.files).filter((f) => !zc.files[f].dir && /\.(xml|rels)$/.test(f))) {
    const c = await zc.file(n)!.async('string').catch(() => '');
    if (c.includes(String(baseSz.cy))) hits.push(n);
  }
  if (hits.some((n) => n !== 'ppt/presentation.xml')) sizeChecks.push(`画布高度散写进了 ${hits.join(', ')}（尺寸不止一个来源）`);
}
okPair(ok, 'S-03 画布尺寸不散写：defineLayout 用 KICKOFF_LAYOUT_DEF，产物里不出现第二份 5.625',
  () => sizeChecks.length === 0 && Math.abs(baseSz.cx / 914400 - lay.KICKOFF_LAYOUT_DEF.width) < 0.02 && Math.abs(baseSz.cy / 914400 - lay.KICKOFF_LAYOUT_DEF.height) < 0.02,
  () => /pptx\.defineLayout\(KICKOFF_LAYOUT_DEF\)/.test(B) && !/5\.625/.test(B),
  () => ({ sizeChecks, 基线: baseSz }));

okPair(ok, 'S-04 只用稳定原生对象 API（addText/addTable/addChart），不整页贴图（验收 5）',
  // 行为侧全部在解包产物上：原生文本运行/原生表格/独立图表部件，且内容层零位图
  () => {
    const runs = (allXml.match(/<a:t>/g) ?? []).length;
    const chartParts = Object.keys(zip.files).filter((n) => /ppt\/charts\/chart\d+\.xml$/.test(n)).length;
    return runs > 200 && /<a:tbl>/.test(allXml) && /<p:graphicFrame>/.test(allXml) && chartParts >= 1 && !/<p:pic>/.test(allXml);
  },
  () => /slide\.addText\(/.test(B) && /slide\.addTable\(/.test(B) && /slide\.addChart\(/.test(B) && !/addImage\(/.test(B),
  () => ({ runs: (allXml.match(/<a:t>/g) ?? []).length, pic: /<p:pic>/.test(allXml) }));

okPair(ok, 'S-05 版式断言在写盘前消费（越界 → 降级 + warnings，验收 7）',
  // 行为侧：降级页码 = 判定函数在写盘前点名的页；产物里降级页只留标题正文（数据块被舍弃）、包仍合法
  () => {
    const flagged = overflow.map((p: any, i: number) => i + 1).filter((no: number) => M.pageViolations(dataTitle, overflow[no - 1].title, [], 22).length > 0);
    return degraded.degradedPages.length === 2 && JSON.stringify([...degraded.degradedPages].sort()) === JSON.stringify(flagged)
      && degraded.warnings.some((w) => /降级/.test(w))
      && degraded.pageCount === 12 && degraded.buffer[0] === 0x50 && !/其余 \d+ 条/.test(hit);
  },
  () => /pageViolations\(/.test(B) && /safeFrames\(\)/.test(B) && /已降级为「标题 \+ 正文」安全版式/.test(B),
  () => ({ degradedPages: degraded.degradedPages, warnings: degraded.warnings.filter((w) => /降级/.test(w)).slice(0, 2) }));

// 数字防幻觉：多条规则同表生效，且规则取的数随 Bundle 走（两份 Bundle 各改各的真值）
const fakeBullets = ['需求 999 条已就绪', '计划 23 条', '里程碑 88 个', '两周内出原型', '覆盖率 12%', '工作量 777 人天'];
const altTruth = bundleOf({
  requirements: bundle.requirements.slice(0, 7),
  milestones: bundle.milestones.slice(0, 2),
  coverage: { total: 10, covered: 6, uncovered: 4, rate: 60 },
  workload: {
    ...bundle.workload, manDays: { expected: 44, optimistic: 40, pessimistic: 50 },
    quote: { p50ManDays: 44, p84ManDays: 48 },
    footer: '工作量来源：估算引擎（P50 44 人天 / P84 48 人天）',
  },
}) as any;
const metricChecks: Array<{ name: string; hits: string[]; truth: string }> = [
  { name: '需求', hits: ['999'], truth: '14' },
  { name: '里程碑', hits: ['88'], truth: '6' },
  { name: '覆盖率', hits: ['12'], truth: '80' },
  { name: '工作量', hits: ['777'], truth: '96' },
];
const rewriteChecks: string[] = [];
{
  const wA: string[] = [];
  const outA = M.sanitizeBullets(fakeBullets, bundle, 7, wA);
  const wB: string[] = [];
  const outB = M.sanitizeBullets(fakeBullets, altTruth, 7, wB);
  for (const m of metricChecks) {
    if (!outA.some((l) => l.includes(`${m.name} ${m.truth}`))) rewriteChecks.push(`${m.name}：基线 Bundle 的假数没被改写成「${m.truth}」→ ${outA.join(' | ').slice(0, 160)}`);
    if (!outB.some((l) => new RegExp(`${m.name}\\s*(7|2|60|44)`).test(l))) rewriteChecks.push(`${m.name}：换 Bundle 后改写值没跟着走（写死在规则里）→ ${outB.join(' | ').slice(0, 160)}`);
  }
  if (outA[1] !== '计划 23 条' || outB[1] !== '计划 23 条') rewriteChecks.push('真数字被动了（纠偏变成了无脑替换）');
  if (outA[3] !== '两周内出原型') rewriteChecks.push(`修辞数字被误伤：${outA[3]}`);
  if (wA.length !== 4 || wB.length !== 4) rewriteChecks.push(`warning 条数与改写条数不符（A=${wA.length} B=${wB.length}）`);
  if (!wA.every((w) => /第 7 页数字由系统改写/.test(w) && /AI 写「\d+」，库内实为「\d+」/.test(w))) rewriteChecks.push('warning 没逐条点名页码与原值/真值', wA);
}
okPair(ok, 'S-06 数字防幻觉改写规则成表且逐条记 warning（FR-3.4 / 验收 8）',
  () => rewriteChecks.length === 0 && metricChecks.length >= 4,
  () => /const METRICS: Metric\[\] = \[/.test(B) && (B.match(/\bre: \//g) ?? []).length >= 6 && /数字由系统改写/.test(B),
  () => rewriteChecks);

// 几何判断委托模拟：改 T02098 的画布表，装配层的越界判定必须一起搬
const CANVAS_TBL = lay.CANVAS as unknown as { width: number; height: number };
const geoChecks: string[] = [];
/** 窄画布下装配层给出的第一条告警原文（只作 S-07b 的字面腿输入） */
let overflowWording = '';
{
  const longTitle = '标'.repeat(40);
  const frameBefore = JSON.stringify(lay.getContentFrame());
  const verdictBefore = JSON.stringify(M.pageViolations(dataTitle, longTitle, [], 22));
  try {
    CANVAS_TBL.width = 4; CANVAS_TBL.height = 2;
    const frameNow = JSON.stringify(lay.getContentFrame());
    const verdictNow = JSON.stringify(M.pageViolations(lay.framesFor('data').title!, longTitle, [], 22));
    if (frameNow === frameBefore) geoChecks.push('改了 T02098 的画布表而 getContentFrame 不动——几何另有抄本');
    if (verdictNow === verdictBefore) geoChecks.push('画布表改了而装配层判定不动——装配层自己算了几何');
    // 行为侧只看「窄画布下到底判没判出越界」；「越出」这个措辞挪进 S-07b 的字面腿，
    // 否则产品把告警改成同义词就会让 S-07 报「行为失守」——红因归错地方（批⑪）
    if ((M.pageViolations(lay.framesFor('data').title!, longTitle, [], 22) as string[]).length === 0) geoChecks.push(`窄画布下装配层没判出越界：${verdictNow}`);
    overflowWording = (M.pageViolations(lay.framesFor('data').title!, longTitle, [], 22) as string[])[0] ?? '';
  } finally {
    CANVAS_TBL.width = 10; CANVAS_TBL.height = 5.625;
  }
  if (JSON.stringify(lay.getContentFrame()) !== frameBefore) geoChecks.push('画布表还原失败（模拟留了残渣）');
  if (JSON.stringify(M.pageViolations(dataTitle, longTitle, [], 22)) !== verdictBefore) geoChecks.push('还原后装配层判定与基线逐字不一致');
}
okPair(ok, 'S-07b 窄画布越界告警的「越出」措辞只作字面腿（行为=确有告警）',
  () => geoChecks.length === 0 && overflowWording.length > 0,
  () => /越出/.test(overflowWording),
  () => ({ 告警原文: overflowWording }));
okPair(ok, 'S-07 几何判断委托 T02098（本层不自己算对比度/边界）',
  () => geoChecks.length === 0,
  () => !/relativeLuminance|Math\.pow\(/.test(B) && /assertInBounds/.test(B) && /findOverlaps/.test(B) && /contrastRatio/.test(B) === false && /auditPalette\(\)/.test(B),
  () => geoChecks);

okPair(ok, 'S-08 色值只走 PALETTE 单源',
  // 行为侧：产物里出现的每一支 6 位色值都取得自导出的单源表（散写的第六支色会在这里露出来），
  // 且确有 ≥3 支角色色上了页面、色板自检（门禁 6）通过
  () => offPalette(allXml).length === 0 && hexesOf(allXml).length >= 3 && hexesOf(allXml).every((h) => PAL_VALUES.has(h)) && lay.auditPalette().length === 0,
  () => !/["'#][0-9a-fA-F]{6}/.test(B.replace(/\/\/.*$/gm, '')) && /PALETTE\./.test(B),
  () => ({ 产物色值: hexesOf(allXml), 表外色值: offPalette(allXml) }));

// ================= X 组：单源表改名模拟（T02293 判据 3~4） =================
lines.push('');
lines.push('== X 组：单源表改名模拟');
{
  /**
   * X-01 用色单源表改名模拟：装配层每次上色现取 `PALETTE`，把上了页面的色换成另一支同样过对比度门禁的
   * 替色后重跑同一装配器，要求页数/结构不变、用色随表移动、旧色值出现**次数随之下降**、还原后 XML 逐字相同。
   * 判据用「次数下降 + 增减相等」而不是「旧值零残留」：paper 与 onBrand 是两个角色恰好同值（都是 FFFFFF，
   * 见 server/src/util/exportStyle.ts:86,107），纸面色搬家后品牌带上的白字仍留该值——那是另一支单源常量。
   */
  const ALT: Record<string, string> = { ink: '26333F', paper: 'FDFDFD', border: 'C8CFDA', brandDeep: '0B4AAE' };
  const countOf = (xml: string, v: string) => xml.split(v).length - 1;
  const simOutline = outlineOf(13);
  const simBase = await M.buildKickoffPpt(bundle, simOutline as any);
  const baseXml = await xmlOf(simBase.buffer);
  const targets = Object.entries(ALT).filter(([k]) => baseXml.includes(String(lay.PALETTE[k as keyof typeof lay.PALETTE])));
  const findings: string[] = [];
  const pal = lay.PALETTE as unknown as Record<string, string>;
  for (const [k, to] of targets) {
    const from = pal[k];
    let movedXml = '';
    try {
      pal[k] = to;
      const moved = await M.buildKickoffPpt(bundle, simOutline as any);
      if (lay.auditPalette().length > 0) findings.push(`${k}：替色 ${to} 自身过不了门禁 6，结论不可用`);
      movedXml = await xmlOf(moved.buffer);
      if (moved.pageCount !== simBase.pageCount) findings.push(`${k}：改色后页数变了（版式行为被用色绑架）`);
      if (!movedXml.includes(to)) findings.push(`${k}：产物没随单源表移动（装配层另有抄本）`);
      if (countOf(movedXml, from) >= countOf(baseXml, from)) findings.push(`${k}：旧色值 ${from} 次数没下降（${countOf(baseXml, from)} → ${countOf(movedXml, from)}）——那一处用的是抄本`);
      if (countOf(movedXml, to) - countOf(baseXml, to) !== countOf(baseXml, from) - countOf(movedXml, from)) findings.push(`${k}：新色值增加数与旧色值减少数不等（挪走的格子没全接上表）`);
    } finally {
      pal[k] = from;
    }
    const restored = await M.buildKickoffPpt(bundle, simOutline as any);
    if ((await xmlOf(restored.buffer)) !== baseXml) findings.push(`${k}：还原后幻灯片 XML 不逐字相同`);
    if (offPalette(await xmlOf(restored.buffer)).length > 0) findings.push(`${k}：还原后产物出现表外色值`);
  }
  ok(`X-01 用色单源表改名模拟：${targets.length} 支上页面的色逐一同源移动（结构不变、随表移动、旧值计数下降、还原 XML 逐字相同）`,
    targets.length >= 3 && findings.length === 0, { findings, 参与色: targets.map(([k]) => k) });

  /**
   * X-02 取数通道的改名模拟：项目名 / 数据截至日 / 覆盖率真值是产品把口径送进页面的通道，
   * 通道值改了，页面上那句话必须整体跟着改、旧值零残留、还原后 XML 逐字相同。
   * 装配层若写死其中任何一句，这一改就露出第二份来源。
   */
  const stripGateText = (t: string) => (simOutline as any[]).reduce((s, p) => s.split(String(p.title)).join(''), t);
  const chFindings: string[] = [];
  const channels: Array<{ name: string; oldVal: string; mk: () => any }> = [
    { name: 'project.name', oldVal: FIX_NAME, mk: () => { const b = bundleOf(); b.project = { ...b.project, name: 'ZZZ-项目名' }; return b; } },
    { name: 'dataAsOf', oldVal: FIX_ASOF, mk: () => bundleOf({ dataAsOf: '2099-12-31' }) },
    { name: 'coverage 真值', oldVal: '测试用例 40 条', mk: () => bundleOf({ coverage: { total: 51, covered: 42, uncovered: 9, rate: 82 } }) },
  ];
  const baseText = stripGateText(await textOf(simBase.buffer));
  for (const ch of channels) {
    if (!baseText.includes(ch.oldVal)) { chFindings.push(`${ch.name}：基线页面上没有「${ch.oldVal}」（通道没落到页面，无从取证）`); continue; }
    const b2 = ch.mk();
    const deck2 = await M.buildKickoffPpt(b2, simOutline as any);
    const t2 = stripGateText(await textOf(deck2.buffer));
    if ((await slidesOf(deck2.buffer)).length !== (await slidesOf(simBase.buffer)).length) chFindings.push(`${ch.name}：改通道后页数变了`);
    const newVal = ch.name === 'project.name' ? 'ZZZ-项目名' : ch.name === 'dataAsOf' ? '2099-12-31' : '测试用例 51 条';
    if (!t2.includes(newVal)) chFindings.push(`${ch.name}：页面文案没随通道移动（新值「${newVal}」不在页面上）`);
    if (t2.includes(ch.oldVal)) chFindings.push(`${ch.name}：通道改名后页面仍残留旧值「${ch.oldVal}」——那句话另有抄本`);
  }
  const restoredCh = await M.buildKickoffPpt(bundle, simOutline as any);
  if ((await xmlOf(restoredCh.buffer)) !== baseXml) chFindings.push('还原通道值后幻灯片 XML 不逐字相同');
  ok(`X-02 取数通道改名模拟：${channels.length} 条通道逐一动到页面上（页数不变、随通道移动、旧值零残留、还原 XML 逐字相同）`,
    chFindings.length === 0, chFindings);
}

// ================= N 组：负对照（T02293 判据 4） =================
lines.push('');
lines.push('== N 组：负对照（证明判据有牙）');
{
  const spy: Array<{ name: string; cond: boolean; extra?: unknown }> = [];
  const sOk = (name: string, cond: boolean, extra?: unknown) => spy.push({ name, cond, extra });

  // N-01 假夹具：字面那句「测试用例 40 条」确实在出参里，但换入参后值不动——只看字面会放行
  okPair(sOk, 'N-01 假夹具：取数文案在、镜像行为不在，配对必须判红',
    () => JSON.stringify(M.blocksForKey('coverage', bundle)).includes('测试用例 51 条'),
    () => JSON.stringify(M.blocksForKey('coverage', bundle)).includes('测试用例 40 条'),
    () => ({ 说明: '字面锚点只问「有没有这句」，行为锚点问「换入参后跟不跟」' }));
  ok('N-01 负对照落地：配对判红且红因是「行为失守」',
    spy.length === 1 && spy[0].cond === false && JSON.stringify(spy[0].extra).includes('行为失守'), spy);

  // N-02 红因可区分：行为在、字面锚点被等价重构换掉 → 红因必须是「字面锚点失配」
  okPair(sOk, 'N-02 红因区分样：行为绿、锚点失配', () => mirrorChecks.length === 0, () => /pptx\.defineLayout\(KICKOFF_LAYOUT_DEF_OTHER\)/.test(B));
  ok('N-02 负对照落地：两种红各带自己的红因，不都读成「功能挂了」',
    spy.length === 2 && spy[1].cond === false && JSON.stringify(spy[1].extra).includes('字面锚点失配'), spy[1]);

  // N-03 门禁 6 有牙：把单源表的一支色改成低对比度，自检必须报红，还原后归零
  const ink0 = (lay.PALETTE as unknown as Record<string, string>).ink;
  let palTeeth = '';
  try {
    (lay.PALETTE as unknown as Record<string, string>).ink = 'DDDDDD';
    palTeeth = lay.auditPalette()[0] ?? '';
  } finally {
    (lay.PALETTE as unknown as Record<string, string>).ink = ink0;
  }
  okPair(sOk, 'N-03 色板门禁有牙：改坏单源表一支色后 auditPalette 必报红，还原即归零',
    // 行为侧：告警确实**指着被改坏的那支色**（DDDDDD 出现在消息里），且还原后自检归零
    () => palTeeth.includes('DDDDDD') && lay.auditPalette().length === 0,
    () => /对比度不足/.test(palTeeth),
    () => ({ palTeeth }));
  ok('N-03b 配对落账：色板门禁判绿走的是同一条 okPair 通道', spy.length === 3 && spy[2].cond === true, spy[2]);

  // N-04 表外色值判据有牙：往 XML 里掺一支表外色，扫描器必须点出来（恒绿的扫描器不算判据）
  ok('N-04 色值单源判据有牙：掺入表外色后扫描必出 offender，基线出参为空',
    offPalette(`${allXml}<a:srgbClr val="FF8800"/>`).includes('FF8800') && offPalette(allXml).length === 0,
    { 掺色后: offPalette(`${allXml}<a:srgbClr val="FF8800"/>`) });

  // N-05 降级判据有牙：同一份大纲把超长标题修短后，降级必须归零（否则 S-05 打的是常驻字）
  {
    const repaired = outlineOf(12, (pages) => {
      pages[3].title = '正常标题甲';
      pages[5].title = '正常标题乙';
    });
    const cleanDeck = await M.buildKickoffPpt(bundle, repaired as any);
    ok('N-05 越界降级判据有牙：标题修短的同一份大纲降级归零，超长那份仍报 2 页',
      cleanDeck.degradedPages.length === 0 && degraded.degradedPages.length === 2 && cleanDeck.pageCount === 12,
      { clean: cleanDeck.degradedPages, overflow: degraded.degradedPages });
  }

  // N-07 数值腿真空探针（反模式 20）：把 coverage 通道值改掉后，U-03 的行为腿必须跟着假
  //        —— 否则那条「四值都在页上」的判据其实是拿常量字符串在比，改判等于没改
  {
    const b3 = bundleOf({ coverage: { total: 61, covered: 50, uncovered: 11, rate: 82 } });
    const c3 = M.blocksForKey('coverage', b3)[0]?.text?.content ?? '';
    ok('N-07 数值腿有牙：换掉库内真值后 U-03 行为判据必假（旧值 40 不再承重）',
      Object.values(b3.coverage).every((v) => numsOf(c3).includes(v)) && !numsOf(c3).includes(40),
      { 新页: c3, 抽数: numsOf(c3) });
  }

  // N-08 字面腿有牙：产品把中文重排（同义换词、数值不动）时，行为腿仍绿、字面腿必须红
  {
    const drift = covText().replace('测试用例', '本期用例');
    ok('N-08 字面腿有牙：同义换词副本上 litPhrases 必假、而数值判据仍真（两种红可区分）',
      drift !== covText() && !litPhrases(drift, COV_LIT) && Object.values(bundle.coverage).every((v) => numsOf(drift).includes(v)) && litPhrases(covText(), COV_LIT),
      { drift: drift.slice(0, 80) });
  }

  // N-06 改写判据有牙：AI 恰好写对了数就不改也不留 warning（纠偏不是逢数字必改）
  {
    const wN: string[] = [];
    const exact = M.sanitizeBullets(['需求 14 条已就绪', '计划 23 条', '里程碑 6 个', '覆盖率 80%'], bundle, 9, wN);
    ok('N-06 数字纠偏判据有牙：真值原样保留且零 warning，同表假值仍被改写',
      exact.join('|') === '需求 14 条已就绪|计划 23 条|里程碑 6 个|覆盖率 80%' && wN.length === 0 && rewriteChecks.length === 0,
      { exact, wN });
  }
}

// ---------- 输出 ----------
writeGateResults(OUT_DIR, 't02099-gate-results.txt', `T02099 装配器门：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`);
console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
