/**
 * T02101 门：工作量与降级逻辑（PRD FR-4.6 / FR-4.1 / FR-2.2 / K7 占位路径 / 验收 6）。
 *
 * 断言：
 *   S 组 契约守卫（T02293 判据 3 起为「字面锚点 + 同义行为断言」配对项）：占位词单源、人月因子不写死、
 *                  页脚口径来自 Bundle、不静默换数（R2）、零数据分支独立成文、缺数留痕落在页面正文。
 *   W 组 工作量口径纯函数：有估算 / 降级工期 / 零数据三分支的 footer、noData、reviewTrace。
 *   U 组 装配层取数：占位文本、覆盖率零用例改写、assignee 缺失禁编人名、脚注带章节与口径。
 *   P 组 真产物：解包 .pptx 逐页核对脚注与「不把空缺写成 0 人天」——页面上说了什么才算数。
 *   X 组 同进程改名模拟与同源自证（判据 3~4）：改 `PALETTE` 单源表 → 产物用色随表移动、旧值零残留、
 *                  还原逐字节相同；改 Bundle 口径通道 → 页面文案随通道移动；数据键表改名后合法集同动；
 *                  占位词是不可改原语，改走「重构同一性 + 有牙反证」。
 *   N 组 负对照（判据 4）：字面词在、行为不在的假夹具必须判红，且红因落在「行为失守」。
 *
 * 断言口径（T02293 改判）：
 *  - 每条中文文案锚都配一条**同义行为断言**，只在行为断言通过时才算绿；红因区分「行为失守」与
 *    「字面锚点失配（行为在）」（`docs/验收门判据规约.md` 判据 3、`scripts/lib/anchor-pair.mts`）。
 *  - 行为侧一律取**结构/产物**：解包后的 slide XML 文本运行、表格逐格与 Bundle 字段镜像比对、
 *    块数/行数/段数计数、Bundle 通道字段的字节一致性——不再靠「源码里有没有这句话」单独定绿。
 *  - 占位词读产品导出的 `KICKOFF_PLACEHOLDER`，门里不抄第二份。
 *
 * 隔离纪律：不连生产库、不起服务、不调 AI（Bundle/Summary 脚本内构造）。
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02101-kickoff-workload.mts
 * 结果落 .workbuddy/t02101-workload-<运行标识>.pptx（T02309 旁证同标识）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { gateArtifactPath } from './lib/gate-results.mts'; // T02309：旁证产物按运行标识命名
import { okPair } from './lib/anchor-pair.mts'; // T02293 判据 3：文案锚必须配行为断言

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};

const B = await import('../server/src/services/kickoffBuilder.ts');
const S = await import('../server/src/services/kickoffService.ts');
const LAY = await import('../server/src/services/kickoff-layout.ts');
/** 占位词单源（门里一律用这个常量，不再抄第二份「待补充」） */
const PH = S.KICKOFF_PLACEHOLDER as string;

const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const BSRC = stripComments(readFileSync(join(ROOT, 'server', 'src', 'services', 'kickoffBuilder.ts'), 'utf8'));
const SSRC = stripComments(readFileSync(join(ROOT, 'server', 'src', 'services', 'kickoffService.ts'), 'utf8'));

// ================= 夹具与行为侧公共料 =================
const plan = (i: number, days: number, kind = 'normal') => ({
  id: `p${i}`, title: `计划 ${i}`, kind, duration_days: days, start_date: '2026-01-05', end_date: '2026-01-12',
  progress: 0, status: 'todo', assignee: '张三', sort_order: i, complexity: 3,
}) as any;
const summaryOf = (over: Record<string, unknown> = {}) => ({
  countedKeys: ['k1', 'k2'], directManDays: { expected: 96, optimistic: 78, pessimistic: 132 },
  config: { manDaysPerManMonth: 20.83 }, quote: { p50ManDays: 96, p84ManDays: 118 },
  phases: [{ phase: '开发', expected: 60, rowCount: 12 }, { phase: '测试', expected: 36, rowCount: 6 }],
  ...over,
}) as any;
const pf = (p6: 'ok' | 'warn') => ({ items: [{ key: 'P6', status: p6 }] } as any);

const DAY = 86400000;
const iso = (base: number, off: number) => new Date(base + off * DAY).toISOString().slice(0, 10);
const T0 = Date.UTC(2026, 0, 5);
const row = (i: number) => ({
  id: `q${i}`, project_id: 'p1', title: `任务 ${i + 1}`, description: '',
  start_date: iso(T0, i * 3), end_date: iso(T0, i * 3 + 6), duration_days: 5, progress: 20, status: 'doing',
  assignee: '张三', sort_order: i, linked_task_id: null, req_ids: null, color: '', deps: '',
  complexity: 3, kind: 'normal', archived: 0, archived_at: null, created_at: '', updated_at: '',
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
  plans: Array.from({ length: 6 }, (_, i) => row(i)),
  milestones: [{ ...row(90), id: 'm1', title: 'M1 需求确认', kind: 'milestone' }],
  coverage: { total: 40, covered: 32, uncovered: 8, rate: 80 },
  assignees: [{ name: '张三', planCount: 4 }, { name: '李四', planCount: 2 }],
  risks: [],
  workload: est, // 默认走「有估算」通道（est/dur/zero 在下方先声明，函数体延迟求值故可用）
  preflight: {
    projectId: 'p1', projectName: 'mtask五期', blocked: false, missingHard: [], workloadSource: 'estimate',
    items: (['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'] as const).map((key, i) => ({
      key, label: `项${key}`, count: i, status: 'ok' as const, note: '示例说明', deepLink: 'plan', hard: i < 3,
    })),
  },
  workspaceNote: '工作空间可访问',
  dataAsOf: '2026-10-13',
  ...over,
}) as any;

/**
 * 装配层块 → 可比对的文本格（表格逐格 + 文本逐行）。
 * 占位/口径类断言从这里取**结构与值**，而不是从「页面像不像某句话」取。
 */
const cellsOf = (blocks: Array<any>): string[] =>
  blocks.flatMap((x) => (x.table ? [x.table.header, ...x.table.rows].flat() : x.text ? String(x.text.content).split('\n') : []));
/** 产品 `cell()` 的语义镜像：空/纯空白 → 导出占位常量，非空 → 原值 */
const mirror = (v: string | null | undefined) => ((v ?? '').trim() ? String(v) : PH);
/** 解包产物取「每页文本运行 + 原始 XML」——渲染出来的才算页面上说了什么 */
const deckSlides = async (buffer: Buffer): Promise<Array<{ xml: string; runs: string[] }>> => {
  const z = await JSZip.loadAsync(buffer);
  const names = Object.keys(z.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml/.exec(a)![1]) - Number(/(\d+)\.xml/.exec(b)![1]));
  return Promise.all(names.map(async (n) => {
    const xml = await z.file(n)!.async('string');
    return { xml, runs: [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]) };
  }));
};
const deckText = async (buffer: Buffer) => (await deckSlides(buffer)).map((s) => s.runs.join('\n')).join('\n');
const deckXml = async (buffer: Buffer) => (await deckSlides(buffer)).map((s) => s.xml).join('\n');
/** 文本运行里找包含某串的那一行（产物 ↔ 产品函数的同源自证用） */
const runOf = (text: string, needle: string) => text.split('\n').find((l) => l.includes(needle)) ?? '';

const est = S.workloadOf(summaryOf(), [plan(1, 10)], pf('ok'));
const dur = S.workloadOf(summaryOf({ countedKeys: [], phases: [] }), [plan(1, 10), plan(2, 8), plan(3, 0, 'milestone')], pf('warn'));
const zero = S.workloadOf(summaryOf({ countedKeys: [], phases: [] }), [plan(1, 0), plan(2, 0)], pf('warn'));
const workloadText = (b: any) => B.blocksForKey('workload', b)[0].text?.content ?? '';
const page = (layout: string, dataKeys: string[], section = '项目计划') => ({ section, title: '页', bullets: [], dataKeys, layout });

// ================= S 组：契约守卫（字面锚点 + 同义行为断言） =================
const gapPlanBundle = bundleOf({ plans: bundleOf().plans.map((p: any, i: number) => (i === 0 ? { ...p, assignee: '', start_date: '' } : p)) });
okPair(ok, 'S-01 占位词单源定义、装配层只引用常量（散写的「—/未指派」会各页口径不一）',
  // 行为侧：把带缺口的 Bundle 过一遍取数，逐格要求「该缺的恰出占位常量、填了的是原值」，
  // 且全表零第二种占位形态（—/未指派/undefined/空串）。「口径一致」只有取数层能证
  (() => {
    const pr = B.blocksForKey('planRows', gapPlanBundle)[0].table.rows;
    const tl = B.blocksForKey('timeline', gapPlanBundle)[0].table.rows;
    const cells = cellsOf([...B.blocksForKey('planRows', gapPlanBundle), ...B.blocksForKey('timeline', gapPlanBundle)]);
    return pr[0][2] === mirror('') && pr.slice(1).every((r: string[], i: number) => r[2] === mirror(gapPlanBundle.plans[i + 1].assignee))
      && tl[0][1] === mirror('') && cells.every((c: string) => c.trim() !== '' && !/^(—|-|–|未指派|待定|N\/A)$/.test(c.trim()))
      && !cells.some((c: string) => /undefined|null|NaN/.test(c));
  }),
  () => new RegExp(`export const KICKOFF_PLACEHOLDER = '${PH}'`).test(SSRC)
    && BSRC.includes('KICKOFF_PLACEHOLDER') && !BSRC.includes("|| '—'") && !BSRC.includes('未指派'),
  () => ({ 占位词: PH }));
okPair(ok, 'S-02 人月换算因子取估算配置，装配层不写死 20.83（因子可在参数页改，写死就跟计算分叉）',
  // 行为侧：只把配置因子当**数据**换成 20，manMonth 与页面呈现同时跟着走，旧因子在页面上零残留
  (() => {
    const alt = { ...est, manDaysPerManMonth: 20, manMonth: Math.round((est.manDays.expected / 20) * 100) / 100 };
    const a = workloadText(bundleOf({ workload: alt }));
    const d = workloadText(bundleOf());
    const w20 = S.workloadOf(summaryOf({ countedKeys: [], config: { manDaysPerManMonth: 20 } }), [plan(1, 40)], pf('ok'));
    return alt.manMonth === 4.8 && a.includes('20') && !a.includes('20.83') && d.includes('20.83')
      && w20.manMonth === 2 && w20.manDaysPerManMonth === 20;
  }),
  () => !/20\.83/.test(BSRC) && /manDaysPerManMonth: summary\.config\.manDaysPerManMonth/.test(SSRC) && /toManMonth\(/.test(SSRC));
okPair(ok, 'S-03 页脚口径来自 Bundle（验收 6 要求页面动态显示，不是模板硬话）',
  // 行为侧：页脚是 Bundle 通道字段的搬运工——改通道值页脚就换话、旧值零残留，两字段各自独立可达
  (() => {
    const wp = page('twoCol', ['workload'], '工作量');
    const viaFooter = B.footerOf(wp, bundleOf({ workload: { ...est, footer: 'ZZZ-口径甲' } }), 5, 12);
    const viaTrace = B.footerOf(wp, bundleOf({ workload: { ...dur, reviewTrace: 'ZZZ-留痕甲' } }), 5, 12);
    const base = B.footerOf(wp, bundleOf({ workload: dur }), 5, 12);
    return viaFooter.includes('ZZZ-口径甲') && !viaFooter.includes(est.footer)
      && viaTrace.includes('ZZZ-留痕甲') && !viaTrace.includes(String(dur.reviewTrace))
      && base.includes(dur.footer) && base.includes(String(dur.reviewTrace));
  }),
  () => /b\.workload\.footer/.test(BSRC) && /b\.workload\.reviewTrace/.test(BSRC));
okPair(ok, 'S-04 估算/降级判定仍以 countedKeys 为准且带来源标注（R2：不静默换数）',
  // 行为侧：source 只随 countedKeys 翻；两分支的页脚互不相同，降级页面上既无区间符号也无报价数
  (() => {
    const e2 = S.workloadOf(summaryOf(), [plan(1, 10)], pf('ok'));
    const d2 = S.workloadOf(summaryOf({ countedKeys: [], phases: [] }), [plan(1, 10)], pf('warn'));
    const t2 = workloadText(bundleOf({ workload: d2 }));
    return e2.source === 'estimate' && d2.source === 'duration' && e2.manDays.optimistic !== null
      && d2.manDays.optimistic === null && e2.footer !== d2.footer && !t2.includes('~') && !t2.includes('P84');
  }),
  () => /summary\.countedKeys\.length > 0/.test(SSRC) && /source: 'estimate'/.test(SSRC) && /source: 'duration'/.test(SSRC));
okPair(ok, 'S-05 零数据分支独立成文（0 人天是「没填」不是「工作量为零」）',
  // 行为侧：noData 恰在 Σ 工期为 0 那格为真；此时正文/脚注都不出现「0 人天」这种像结论的写法，
  // 且正文落到占位常量上。有工期时 noData 必须为假（分支不能被常开）
  (() => {
    const n = S.workloadOf(summaryOf({ countedKeys: [], phases: [] }), [plan(1, 7)], pf('warn'));
    const zBody = workloadText(bundleOf({ workload: zero }));
    const zFoot = B.footerOf(page('twoCol', ['workload'], '工作量'), bundleOf({ workload: zero }), 2, 4);
    return zero.noData === true && n.noData === false && zBody.includes(PH)
      && !zBody.includes('0 人天') && !zFoot.includes('0 人天');
  }),
  () => /const noData = execDays === 0/.test(SSRC) && /noData/.test(BSRC));
okPair(ok, 'S-06 覆盖率/工作空间的缺数留痕落在页面正文（FR-2.2 不许只在 UI 提示）',
  // 行为侧：零用例页/未配置工作空间页都**换了一套正文**（与有数据分支逐字不同），
  // 且都不把空缺写成 0%/0 条或抄一段真实路径——留痕真的在页面上
  (() => {
    const noCases = B.blocksForKey('coverage', bundleOf({ coverage: { total: 0, covered: 0, uncovered: 0, rate: 0 } }));
    const hasCases = B.blocksForKey('coverage', bundleOf());
    const noWs = B.blocksForKey('workspace', bundleOf({ project: { id: 'p1', name: 'mtask五期', workspacePath: '' } }));
    const hasWs = B.blocksForKey('workspace', bundleOf());
    const noCasesText = cellsOf(noCases).join('\n');
    const noWsText = cellsOf(noWs).join('\n');
    return noCasesText !== cellsOf(hasCases).join('\n') && !/0%|0 条/.test(noCasesText)
      && noCases.filter((x: any) => x.chart).length === 0
      && noWsText !== cellsOf(hasWs).join('\n') && !noWsText.includes('D:\\code');
  }),
  () => /本期未建/.test(BSRC) && /未配置/.test(BSRC));

// ================= W 组：workloadOf 三分支（口径纯函数） =================
okPair(ok, 'W-01 有估算行 → source=estimate + 页脚「工作量来源：估算引擎（P50/P84）」',
  // 行为侧：报价两档的数字真的出现在页脚里（数字来自入参），noData 为假，且与降级分支的页脚不同句
  (() => {
    const q = summaryOf().quote;
    const d2 = S.workloadOf(summaryOf({ countedKeys: [] }), [plan(1, 10)], pf('warn'));
    return est.source === 'estimate' && est.noData === false && est.footer.length > 0
      && est.footer.includes(String(q.p50ManDays)) && est.footer.includes(String(q.p84ManDays))
      && est.footer !== d2.footer;
  }),
  () => est.footer === '工作量来源：估算引擎（P50 96 人天 / P84 118 人天）', () => ({ 页脚: est.footer }));
ok('W-02 估算分支不叠工期（同一批工作量算两遍会让报价翻倍）',
  est.counted === 2 && est.manDays.expected === 96, est);
ok('W-03 人月 = 人天 ÷ 配置因子（96 ÷ 20.83 ≈ 4.61）', Math.abs(est.manMonth - 4.61) < 0.01, est.manMonth);

okPair(ok, 'W-04 无估算行 → 降级 Σ duration_days 且页脚「工期口径，非三点估算」',
  // 行为侧：降级页脚既不含估算报价的两个数（不冒充另一口径），也 ≠ 估算分支页脚；Σ 工期值如实为 18
  (() => {
    const q = summaryOf().quote;
    return dur.source === 'duration' && dur.manDays.expected === 18 && dur.footer.length > 0
      && !dur.footer.includes(String(q.p84ManDays)) && !dur.footer.includes(String(q.p50ManDays))
      && dur.footer !== est.footer;
  }),
  () => dur.footer === '工期口径，非三点估算', () => ({ 页脚: dur.footer }));
ok('W-05 降级分支排除 milestone 行（18 = 10+8，不含里程碑汇总）',
  dur.manDays.expected === 18 && dur.counted === 2, { expected: dur.manDays.expected, counted: dur.counted });
ok('W-06 降级没有三点 → 乐观/悲观如实为 null，不用期望值冒充区间',
  dur.manDays.optimistic === null && dur.manDays.pessimistic === null && dur.quote === null);
okPair(ok, 'W-07 P6 warn + 有工期 → 出 FR-2.2 页脚留痕「未经估算复核」',
  // 行为侧：留痕只在「降级 + P6 warn」这一格出现且与页脚是两条独立的话；P6 ok 时留痕为 null
  (() => {
    const okP6 = S.workloadOf(summaryOf({ countedKeys: [], phases: [] }), [plan(1, 10)], pf('ok'));
    return dur.reviewTrace !== null && dur.reviewTrace!.length > 0 && dur.reviewTrace !== dur.footer
      && okP6.reviewTrace === null && dur.manDays.expected > 0;
  }),
  () => dur.reviewTrace === '本页工期由排期推导，未经估算复核', () => ({ 留痕: dur.reviewTrace }));
ok('W-08 P6 ok 时不加留痕（有数据又齐备还写「建议复核」是自我抹黑）',
  S.workloadOf(summaryOf({ countedKeys: [], phases: [] }), [plan(1, 10)], pf('ok')).reviewTrace === null);

okPair(ok, 'W-09 工期全未填 → noData=true 且页脚写明「待补充」，不是 0 人天结论',
  // 行为侧：零数据页脚引用的是**导出的占位常量本身**（值级同一性），expected 为 0 时也不出现「0 人天」，
  // 且不叠留痕
  (() => zero.noData === true && zero.manDays.expected === 0 && zero.footer.includes(PH)
    && !zero.footer.includes('0 人天') && zero.reviewTrace === null),
  () => /待补充/.test(zero.footer), () => ({ 页脚: zero.footer }));
ok('W-10 零数据不叠留痕（连可复核的数都没有，写「由排期推导」是假话）',
  zero.reviewTrace === null, zero.reviewTrace);
ok('W-11 人月因子随配置走（改成 20 时 manMonth 与文字同变）', (() => {
  const w = S.workloadOf(summaryOf({ countedKeys: [], config: { manDaysPerManMonth: 20 } }), [plan(1, 40)], pf('ok'));
  return w.manMonth === 2 && w.manDaysPerManMonth === 20;
})(), S.workloadOf(summaryOf({ countedKeys: [], config: { manDaysPerManMonth: 20 } }), [plan(1, 40)], pf('ok')));

// ================= U 组：装配层取数与占位 =================
okPair(ok, 'U-01 有估算：工作量页出区间 + P50/P84 + 来源口径（验收 6）',
  // 行为侧：页面上的数字逐个 token 与入参相等（不认句子写法），阶段名一个不落地出现，
  // 并把 Bundle 通道里那份页脚原样搬上页面
  (() => {
    const t = workloadText(bundleOf());
    const nums = t.match(/[\d.]+/g) ?? [];
    const need = [String(est.manDays.optimistic), String(est.manDays.pessimistic), String(est.manDays.expected), String(est.quote!.p50ManDays), String(est.quote!.p84ManDays)];
    return need.every((n) => nums.includes(n)) && est.phases!.every((p: any) => t.includes(p.phase)) && t.includes(est.footer);
  }),
  () => /78~132（P50 96）/.test(workloadText(bundleOf())) && /P50 96 人天 \/ P84 118 人天/.test(workloadText(bundleOf())) && /阶段分布/.test(workloadText(bundleOf())),
  () => workloadText(bundleOf()).slice(0, 200));
okPair(ok, 'U-02 降级：按工期口径出单值，不谎称三点（无 P84 字样）',
  // 行为侧：工期值在页上、区间符号与报价档次数值都不在（口径不串台），页脚仍是通道原值
  (() => {
    const t = workloadText(bundleOf({ workload: dur }));
    const nums = t.match(/[\d.]+/g) ?? [];
    return nums.includes(String(dur.manDays.expected)) && !t.includes('~') && !t.includes('P84')
      && !nums.includes(String(summaryOf().quote.p84ManDays)) && t.includes(dur.footer);
  }),
  () => /总工作量 18 人天/.test(workloadText(bundleOf({ workload: dur }))) && /工期口径，非三点估算/.test(workloadText(bundleOf({ workload: dur }))),
  () => workloadText(bundleOf({ workload: dur })).slice(0, 200));
okPair(ok, 'U-03 零数据：出「待补充」并给补数路径，绝不出现「0 人天」',
  // 行为侧：把正文按行解析，「总工作量」那一行的值恰是导出占位常量；全页无「0 人天」；
  // 正文不止一句（还有换算与补数指引），noData 为真
  (() => {
    const t = workloadText(bundleOf({ workload: zero }));
    const line = t.split('\n').find((l: string) => l.startsWith('总工作量')) ?? '';
    return line.includes(PH) && !t.includes('0 人天') && t.split('\n').length >= 3 && zero.noData === true;
  }),
  () => /总工作量：待补充/.test(workloadText(bundleOf({ workload: zero })))
    && /估算工作台|工期\(工作日\)/.test(workloadText(bundleOf({ workload: zero }))),
  () => workloadText(bundleOf({ workload: zero })).slice(0, 200));
okPair(ok, 'U-04 人月因子跟配置同现（配置 20 时页面写 ÷ 20）',
  // 行为侧：因子当数据改，页面上出现的是新值、旧值零残留（写死时这一条必红）
  (() => {
    const a = workloadText(bundleOf({ workload: { ...dur, manDaysPerManMonth: 20 } }));
    const d = workloadText(bundleOf());
    return a.includes('÷ 20') && !a.includes('20.83') && d.includes('20.83');
  }),
  () => /÷ 20\.83）/.test(workloadText(bundleOf())) && /÷ 20）/.test(workloadText(bundleOf({ workload: { ...dur, manDaysPerManMonth: 20 } }))));

const tlPages = gapPlanBundle;
const planTable = B.blocksForKey('planRows', tlPages)[0].table!;
okPair(ok, 'U-05 计划表缺负责人/缺日期 → 单元格「待补充」，不渲染 undefined 或空白',
  // 行为侧：逐格与 Bundle 字段做映射比对（填了=原值、空了=导出占位常量），空格/undefined 零出现
  (() => {
    const rows = B.blocksForKey('planRows', tlPages)[0].table.rows;
    return rows.every((r: string[], i: number) => r[2] === mirror(tlPages.plans[i].assignee)
      && r[1].includes(mirror(tlPages.plans[i].start_date)) && r[1].includes(mirror(tlPages.plans[i].end_date)))
      && rows.every((r: string[]) => r.every((c: string) => c.trim() !== '' && !/undefined|null/.test(c)));
  }),
  () => planTable.rows.some((r) => r[2] === PH) && planTable.rows.every((r) => !/undefined|null/.test(r.join(''))),
  planTable.rows[0]);
const listTable = B.blocksForKey('timeline', tlPages)[0].table!;
okPair(ok, 'U-06 时间线列表版同样占位（与计划表同一口径，不一页「待补充」一页「—」）',
  // 行为侧：同一份缺口数据在两张表里落到**同一个常量**上（跨表口径一致是单源的行为后果），
  // 且两张表都没有第二种占位形态
  (() => {
    const tl = B.blocksForKey('timeline', tlPages)[0].table.rows;
    const pr = B.blocksForKey('planRows', tlPages)[0].table.rows;
    const phIn = (rows: string[][]) => rows.flat().filter((c) => c.includes(PH)).length;
    return phIn(tl) > 0 && phIn(pr) > 0 && tl.flat().every((c: string) => c.trim() !== '')
      && !tl.flat().concat(pr.flat()).some((c: string) => /^\s*[—–-]\s*$/.test(c));
  }),
  () => listTable.rows[0].includes(PH), listTable.rows[0]);

const noAssignee = B.blocksForKey('assignees', bundleOf({ assignees: [] }));
okPair(ok, 'U-07 全员未填负责人：整页占位 + 一句来源说明，不编人名',
  // 行为侧：块数=2（说明文本 + 占位表格），占位表格给的是常量 + 计划条数（真值），
  // 页面上出现的名字只能是 Bundle 里真有的——一个都不许凭空多
  (() => {
    const b = bundleOf({ assignees: [] });
    const blocks = B.blocksForKey('assignees', b);
    const real = new Set(b.plans.map((p: any) => p.assignee).filter(Boolean));
    const text = cellsOf(blocks).join('\n');
    const invented = ['王五', '赵六', '李四', '张三'].filter((n) => text.includes(n) && !real.has(n));
    return blocks.length === 2 && blocks[0].table == null && blocks[1].table != null
      && blocks[1].table.rows[0][0] === PH && blocks[1].table.rows[0][1] === String(b.plans.length)
      && text.includes(String(b.plans.length)) && invented.length === 0;
  }),
  () => /assignee/.test(noAssignee[0].text!.content) && !/王五|赵六/.test(noAssignee[0].text!.content)
    && noAssignee[1].table!.rows[0][0] === PH,
  noAssignee.map((x: any) => x.text?.content ?? x.table?.rows));

const noCases = B.blocksForKey('coverage', bundleOf({ coverage: { total: 0, covered: 0, uncovered: 0, rate: 0 } }));
okPair(ok, 'U-08 零用例：覆盖率页改写策略口径（P5 承诺），不出「覆盖率 0%」结论、不画空饼图',
  // 行为侧：零用例分支只出文本块（图表块数 0），正文无任何「0 条/0%」结论、落到占位常量上，
  // 并与有数据分支的正文逐字不同（真的走了另一套口径）
  (() => {
    const t = cellsOf(noCases).join('\n');
    const has = cellsOf(B.blocksForKey('coverage', bundleOf())).join('\n');
    return noCases.filter((x: any) => x.chart).length === 0 && !/0 ?条|0%/.test(t) && t.includes(PH) && t !== has;
  }),
  () => /本期未建/.test(noCases[0].text!.content) && !/0%/.test(noCases[0].text!.content) && !noCases.some((x: any) => x.chart),
  noCases.map((x: any) => x.text?.content ?? (x.chart ? 'chart' : 'table')));
const hasCases = B.blocksForKey('coverage', bundleOf());
okPair(ok, 'U-09 有用例时照旧出真数与饼图（占位分支不误伤正常页）',
  () => {
    const t = cellsOf(hasCases).join('\n');
    const c = bundleOf().coverage;
    return [String(c.total), String(c.covered), String(c.uncovered), String(c.rate)].every((n) => t.includes(n))
      && hasCases.some((x: any) => x.chart?.type === 'doughnut');
  },
  () => /测试用例 40 条/.test(hasCases[0].text!.content) && hasCases[1].chart?.type === 'doughnut', hasCases.length);

// ================= U 组：逐页脚注（FR-4.11 + 验收 6 + FR-2.2） =================
const fU10 = B.footerOf(page('list', ['planRows']), bundleOf(), 3, 12) as any;
okPair(ok, 'U-10 脚注固定含「项目名 · 章节 · 数据截至」（FR-4.11 逐页可回溯）',
  // 行为侧：按分隔符拆开逐位比对入参（项目名 / 章节 / 截至日 / 页码），四段齐且值全对——
  // 措辞改了拆包仍成立，字段丢了才算行为失守
  (() => {
    const parts = String(fU10).split(' · ');
    return parts.length === 4 && parts[0] === bundleOf().project.name && parts[1] === page('list', ['planRows']).section
      && parts[2].endsWith(bundleOf().dataAsOf) && parts[3] === '第 3/12 页';
  }),
  () => /^mtask五期 · 项目计划 · 数据截至 2026-10-13/.test(fU10) && /· 第 3\/12 页$/.test(fU10), fU10);
const fU11 = B.footerOf(page('twoCol', ['workload'], '工作量'), bundleOf(), 5, 12);
okPair(ok, 'U-11 工作量页脚注动态带估算引擎口径（验收 6）',
  // 行为侧：脚注含的正是 Bundle 通道里那份 footer（逐字节子串）；换通道值脚注跟着换、旧值零残留
  (() => {
    const alt = B.footerOf(page('twoCol', ['workload'], '工作量'), bundleOf({ workload: { ...est, footer: 'ZZZ-甲' } }), 5, 12);
    return fU11.includes(est.footer) && alt.includes('ZZZ-甲') && !alt.includes(est.footer);
  }),
  () => fU11.includes('工作量来源：估算引擎（P50 96 人天 / P84 118 人天）'), fU11);
const fU12 = B.footerOf(page('twoCol', ['workload'], '工作量'), bundleOf({ workload: dur }), 5, 12);
okPair(ok, 'U-12 降级 + P6 warn：脚注带「未经估算复核」留痕（FR-2.2 落在页面上）',
  // 行为侧：留痕以 Bundle 的 reviewTrace 原样进脚注；reviewTrace=null 的那份脚注里必须没有它
  (() => {
    const noTrace = B.footerOf(page('twoCol', ['workload'], '工作量'), bundleOf({ workload: { ...dur, reviewTrace: null } }), 5, 12);
    return fU12.includes(String(dur.reviewTrace)) && !noTrace.includes(String(dur.reviewTrace));
  }),
  () => fU12.includes('本页工期由排期推导，未经估算复核'), fU12);
okPair(ok, 'U-13 非工作量页不带口径文案（每页都贴工作量声明反而是噪音）',
  // 行为侧：非工作量页脚注段数恰为四段（名 · 章节 · 截至 · 页码），不贴任何口径/留痕段
  () => String(B.footerOf(page('table', ['planRows']), bundleOf({ workload: dur }), 2, 12)).split(' · ').length === 4,
  () => !/工作量来源|工期口径/.test(B.footerOf(page('table', ['planRows']), bundleOf({ workload: dur }), 2, 12)));
const fU14 = B.footerOf(page('twoCol', ['workload'], '工作量'), bundleOf({ workload: zero }), 5, 12);
okPair(ok, 'U-14 零数据页脚注如实写待补充（口径与正文同源）',
  // 行为侧：脚注里那段口径 = Bundle 的零数据 footer（同一份，正是「正文与脚注同源」的直接证据）
  () => fU14.includes(zero.footer) && zero.footer.includes(PH),
  () => fU14.includes('工作量数据待补充'), fU14);

// ================= U 组：AI 正文缺数时改占位（不许把幻觉改成 0） =================
const sanitize = (bullets: string[], b: any) => {
  const w: string[] = [];
  return { out: B.sanitizeBullets(bullets, b, 2, w), w };
};
const ph1 = sanitize(['整体工作量约 96 人天，含回归'], bundleOf({ workload: zero }));
okPair(ok, 'U-15 零数据：AI 写「96 人天」改占位「工作量待补充」，绝不改成「0 人天」（空缺≠结论）',
  // 行为侧：幻觉数被摘掉、占位常量落进来、没换成 0 这种假结论，且改写有且只有一处
  (() => {
    const t = ph1.out[0];
    return !t.includes('96') && t.includes(PH) && !t.includes('0 人天') && ph1.w.length === 1;
  }),
  () => ph1.out[0] === '整体工作量约工作量待补充，含回归' || (/待补充/.test(ph1.out[0]) && !/0 人天/.test(ph1.out[0])), () => ph1);
const ph2 = sanitize(['用例 12 条已铺满，覆盖率 80%'], bundleOf({ coverage: { total: 0, covered: 0, uncovered: 0, rate: 0 } }));
okPair(ok, 'U-16 零用例：用例数与覆盖率都改占位（与 P5「本期未建」口径一致，不出 0 条/0%）',
  // 行为侧：两个幻觉指标都落到占位常量上，句子里不再留 12/80，也不留裸 0（0 条/0% 都是把空缺冒充结论）
  (() => {
    const t = ph2.out[0];
    return t.includes(PH) && !t.includes('12') && !t.includes('80') && !/0/.test(t) && ph2.w.length === 2;
  }),
  () => /用例待补充/.test(ph2.out[0]) && /覆盖率待补充/.test(ph2.out[0]) && !/0/.test(ph2.out[0]), ph2.out[0]);
const ph3 = sanitize(['本期投入 96 人天'], bundleOf({ workload: dur }));
okPair(ok, 'U-17 有数据时仍按库内真值改写（占位分支不吞掉正常的纠偏）',
  // 行为侧：改写值 = Bundle 的工期真值（不是占位也不是原句），warning 里点名这个真值
  () => ph3.out[0].includes(String(dur.manDays.expected)) && !ph3.out[0].includes('96')
    && !ph3.out[0].includes(PH) && ph3.w.length === 1 && ph3.w[0].includes(String(dur.manDays.expected)),
  () => ph3.out[0] === '本期投入 18 人天' && /库内实为/.test(ph3.w[0]), ph3);
okPair(ok, 'U-18 占位改写会写进 warnings（面板要能点名是哪页哪句）',
  // 行为侧：warning 既点名页码又回收 AI 原值（面板据此定位），且没改写时一条都不发
  (() => {
    const untouched = sanitize(['范围与交付物'], bundleOf({ workload: zero }));
    return ph1.w.length === 1 && /第 2 页/.test(ph1.w[0]) && ph1.w[0].includes('96') && untouched.w.length === 0;
  }),
  () => /无此项数据/.test(ph1.w[0] ?? ''), ph1.w);

// ================= P 组：真产物 =================
mkdirSync(OUT_DIR, { recursive: true });
const outline = [
  { section: '封面', title: 'mtask五期 项目启动会', bullets: [], dataKeys: [], layout: 'cover' },
  { section: '工作量评估', title: '工作量与口径', bullets: [], dataKeys: ['workload'], layout: 'list' },
  { section: '项目团队', title: '项目负责人', bullets: [], dataKeys: ['assignees'], layout: 'table' },
  { section: '质量', title: '测试覆盖', bullets: [], dataKeys: ['coverage'], layout: 'list' },
] as any[];
const gapBundle = bundleOf({ workload: zero, assignees: [], coverage: { total: 0, covered: 0, uncovered: 0, rate: 0 } });
const built = await B.buildKickoffPpt(gapBundle, outline);
writeFileSync(gateArtifactPath(OUT_DIR, 't02101-workload.pptx'), built.buffer);
const gapSlides = await deckSlides(built.buffer);
const s2 = gapSlides[1].runs.join('\n');
const s3 = gapSlides[2].runs.join('\n');
const s4 = gapSlides[3].runs.join('\n');
const slideXmls = gapSlides.map((x) => x.xml);
const durBuilt = await B.buildKickoffPpt(bundleOf({ workload: dur }), outline);
const durText = await deckText(durBuilt.buffer);

okPair(ok, 'P-01 产物工作量页正文出「待补充」，全页无「0 人天」（空缺不冒充结论）',
  // 行为侧：解包出的「总工作量」那一行的值就是导出占位常量，且四页文本运行里零处「0 人天」
  (() => {
    const line = s2.split('\n').find((l) => l.startsWith('总工作量')) ?? '';
    return line.includes(PH) && ![s2, s3, s4].join('').includes('0 人天');
  }),
  () => /总工作量：待补充/.test(s2), s2.slice(0, 200));
okPair(ok, 'P-02 产物工作量页脚注带章节 + 零数据口径（验收 6 在页面上成立）',
  // 行为侧：页面上那一行 == 门进程 `footerOf(本页, 本 Bundle)` 的字节相同输出（产物与函数同源），
  // 并且带着项目名、章节、截至日、通道口径四个入参字段
  (() => {
    const expectFooter = B.footerOf(outline[1], gapBundle, 2, 4);
    return runOf(s2, expectFooter) === expectFooter && expectFooter.includes(gapBundle.project.name)
      && expectFooter.includes(outline[1].section) && expectFooter.includes(gapBundle.dataAsOf)
      && expectFooter.includes(gapBundle.workload.footer);
  }),
  () => /工作量评估 · 数据截至 2026-10-13 · 工作量数据待补充/.test(s2), s2.split('\n').at(-1));
okPair(ok, 'P-03 产物团队页出「待补充」行且不编人名',
  // 行为侧：团队页文本运行里占位常量出现，而这个 Bundle 里没有的一个人名字都不许出现在页上
  (() => {
    const real = new Set(gapBundle.plans.map((p: any) => p.assignee).filter(Boolean));
    const invented = ['张三', '李四', '王五', '赵六'].filter((n) => s3.includes(n) && !real.has(n));
    return s3.includes(PH) && invented.length === 0;
  }),
  () => /待补充/.test(s3) && !/张三|李四/.test(s3), s3.slice(0, 200));
okPair(ok, 'P-04 产物覆盖率页写明本期未建用例',
  () => !/0%|0 条/.test(s4) && s4.includes(PH),
  () => /本期未建/.test(s4), s4.slice(0, 200));
ok('P-05 占位稿不触发版式降级（缺数据也要排版合规，验收 7 反面）',
  built.degradedPages.length === 0, built.degradedPages);
okPair(ok, 'P-06 有估算 + 有工期时页脚动态切换（同一装配器两口径不同文案）',
  // 行为侧：工期稿的页面数字与通道字段全部来自 dur（估算那一份的数不再出现），两稿正文逐行不同
  () => durText.includes(String(dur.manDays.expected)) && !durText.includes(String(est.manDays.expected))
    && durText.includes(String(dur.reviewTrace)) && durText.includes(dur.footer) && s2 !== durText,
  () => /工期口径，非三点估算/.test(durText) && /未经估算复核/.test(durText) && /总工作量 18 人天/.test(durText),
  () => durText.slice(0, 200));
ok('P-07 全稿仍是原生对象（无整页贴图，验收 5）',
  // T02156：允许 `<p:bg>` 背景图（恒生模板版式资产——背景是版式不是内容），
  // 判据收紧为「内容零位图」：无 <p:pic>，且每页每个 r:embed 都来自 <p:bg>
  [1, 2, 3, 4].every((n) => !/<p:pic/.test(slideXmls[n - 1])) &&
    [1, 2, 3, 4].every((n) => (slideXmls[n - 1].match(/r:embed="/g) ?? []).length === (slideXmls[n - 1].match(/<p:bg>/g) ?? []).length),
  { media: Object.keys((await JSZip.loadAsync(built.buffer)).files).filter((n) => n.startsWith('ppt/media/')) });

// ================= X 组：改名模拟 / 同源自证（T02293 判据 3~4） =================
lines.push('');
lines.push('== X 组：改名模拟与同源自证');
{
  /**
   * X-01 版式用色单源表的改名模拟：`PALETTE` 是产品导出的对象表（门进程可改其属性），
   * 装配层每次上色都现取它。把页面真正用到的色换成另一支**同样过对比度门禁**的色值后重跑同一装配器，
   * 要求四件事全部成立：页数/块结构不变、用色随表移动、旧色值在产物里的**出现次数随之下降**、
   * 还原后幻灯片 XML 逐字相同。任一失守即说明装配层里还抄了第二份色值。
   * 判据用「次数下降」而非「零残留」：`PAPER_BG` 与 `ON_BRAND` 是**两个角色恰好同值**
   * （都是 FFFFFF，见 `server/src/util/exportStyle.ts:86,107`）——纸面色搬家后品牌带上的白字仍留该值，
   * 那是另一支单源常量在起作用，不是装配层的抄本。若装配层真写死了纸面色，次数不会下降，这一条照样判红。
   */
  const ALT: Record<string, string> = { ink: '26333F', paper: 'FDFDFD', border: 'C8CFDA', brandDeep: '0B4AAE' };
  const baseXml = await deckXml(built.buffer);
  const countOf = (xml: string, v: string) => xml.split(v).length - 1;
  const targets = Object.entries(ALT).filter(([k]) => baseXml.includes(String(LAY.PALETTE[k])));
  const findings: string[] = [];
  for (const [k, to] of targets) {
    const from = String((LAY.PALETTE as Record<string, string>)[k]);
    let movedXml = '';
    try {
      (LAY.PALETTE as Record<string, string>)[k] = to;
      const moved = await B.buildKickoffPpt(gapBundle, outline);
      if (LAY.auditPalette().length > 0) findings.push(`${k}：换成 ${to} 后色板自检不过（模拟用的替色不合门禁，结论不可用）`);
      movedXml = await deckXml(moved.buffer);
      if (moved.pageCount !== built.pageCount) findings.push(`${k}：改色后页数变了（版式行为被用色绑架）`);
      if (!movedXml.includes(to)) findings.push(`${k}：产物没随单源表移动（装配层另有抄本）`);
      if (countOf(movedXml, from) >= countOf(baseXml, from)) {
        findings.push(`${k}：旧色值 ${from} 出现次数没随表下降（${countOf(baseXml, from)} → ${countOf(movedXml, from)}）——那一处用的是抄本不是单源表`);
      }
      if (countOf(movedXml, to) - countOf(baseXml, to) !== countOf(baseXml, from) - countOf(movedXml, from)) {
        findings.push(`${k}：新色值增加数与旧色值减少数不等（挪走的格子没全部接上表）`);
      }
    } finally {
      (LAY.PALETTE as Record<string, string>)[k] = from;
    }
    const restored = await B.buildKickoffPpt(gapBundle, outline);
    if ((await deckXml(restored.buffer)) !== baseXml) findings.push(`${k}：还原后幻灯片 XML 不逐字相同（模拟留了残渣）`);
  }
  ok(`X-01 用色单源表改名模拟：${targets.length} 支上页面的色逐一同源移动（结构不变、随表移动、旧值计数下降、还原 XML 逐字相同）`,
    targets.length >= 3 && findings.length === 0, { findings, 参与色: targets.map(([k]) => k) });

  /**
   * X-02 Bundle 口径通道的改名模拟：footer / reviewTrace / 项目名 / 数据截至日是产品把口径送进页面的
   * 唯一通道。通道值改了，页面上那句话必须整体跟着改、旧值零残留、还原后幻灯片 XML 逐字相同。
   * 装配层若把某句口径写死，这一改就露出第二份来源。
   */
  const baseDeck = await B.buildKickoffPpt(bundleOf({ workload: dur }), outline);
  // 通道值的取证对象是「产品从 Bundle 搬上页面的字」，大纲里门自己写的标题（封面标题含项目名）不是产品来源，
  // 混进来会让「旧值零残留」变成恒红判据（把门的夹具当成了产品的抄本）。先剥掉门自撰的标题串。
  const stripOutline = (t: string) => (outline as any[]).reduce((s, p) => s.split(String(p.title)).join(''), t);
  const baseRuns = stripOutline(await deckText(baseDeck.buffer));
  const chFindings: string[] = [];
  const channels: Array<{ name: string; oldVal: string; mk: () => any }> = [
    { name: 'workload.footer', oldVal: dur.footer, mk: () => bundleOf({ workload: { ...dur, footer: 'ZZZ-口径通道' } }) },
    { name: 'workload.reviewTrace', oldVal: String(dur.reviewTrace), mk: () => bundleOf({ workload: { ...dur, reviewTrace: 'ZZZ-留痕通道' } }) },
    { name: 'project.name', oldVal: bundleOf().project.name, mk: () => { const b = bundleOf({ workload: dur }); b.project = { ...b.project, name: 'ZZZ-项目名' }; return b; } },
    { name: 'dataAsOf', oldVal: bundleOf().dataAsOf, mk: () => bundleOf({ workload: dur, dataAsOf: '2099-12-31' }) },
  ];
  for (const ch of channels) {
    if (!baseRuns.includes(ch.oldVal)) { chFindings.push(`${ch.name}：基线页面上没有「${ch.oldVal}」（通道没落到页面，模拟无从取证）`); continue; }
    const b2 = ch.mk();
    const newChannel = ch.name === 'workload.footer' ? b2.workload.footer
      : ch.name === 'workload.reviewTrace' ? b2.workload.reviewTrace
        : ch.name === 'project.name' ? b2.project.name : b2.dataAsOf;
    const deck2 = await B.buildKickoffPpt(b2, outline);
    const text2 = stripOutline(await deckText(deck2.buffer));
    if ((await deckSlides(deck2.buffer)).length !== (await deckSlides(baseDeck.buffer)).length) chFindings.push(`${ch.name}：改通道值后页数变了`);
    if (!text2.includes(String(newChannel))) chFindings.push(`${ch.name}：页面文案没随通道移动（产品里另有抄本）`);
    // 通道值改了，旧值就该从页面上整体消失；还留着 = 那句话有第二份来源（这才是本条的牙齿）
    if (text2.includes(ch.oldVal)) chFindings.push(`${ch.name}：通道值改名后页面仍残留旧值「${ch.oldVal}」（口径另有抄本，只改了一半）`);
    if (ch.name === 'workload.footer' && text2.includes(dur.footer)) chFindings.push('页脚口径出现两份来源：新通道值与旧通道值同页并存');
  }
  const restoredChannelDeck = await B.buildKickoffPpt(bundleOf({ workload: dur }), outline);
  // 用幻灯片 XML 逐字比而不是 zip 字节比：docProps 里的生成时刻会让两次构建的字节必然不同，
  // 拿它当「模拟留残渣」的判据是一条恒红断言（判据 2 的反面：断言打在了非行为字段上）
  if ((await deckXml(restoredChannelDeck.buffer)) !== (await deckXml(baseDeck.buffer))) chFindings.push('还原后幻灯片 XML 不逐字相同');
  ok(`X-02 Bundle 口径通道改名模拟：${channels.length} 条通道逐一动到页面上（页数不变、随通道移动、旧值零残留、还原 XML 逐字相同）`,
    chFindings.length === 0, chFindings);

  /**
   * X-03 占位词是不可改的原语常量（ESM 导出绑定改不了），改走**重构同一性 + 有牙反证**：
   *  ① 页面上每个占位槽的值都逐字等于导出的 `KICKOFF_PLACEHOLDER`；
   *  ② 把缺口补上后占位计数恰按缺口消失（有牙：不是「页面上随便都有那句话」的恒等式）；
   *  ③ 造一份「写着占位词但缺口其实没填」的假文本，值级比对必须判不通过。
   */
  const gapCells = cellsOf(['planRows', 'timeline', 'assignees'].flatMap((k) => B.blocksForKey(k as any, bundleOf({ assignees: [], plans: tlPages.plans }))));
  const filledCells = cellsOf(['planRows', 'timeline', 'assignees'].flatMap((k) => B.blocksForKey(k as any, bundleOf())));
  const gapCount = gapCells.filter((c) => c === PH).length;
  /** 第二种占位形态 = 口径不一（HEAD 的老 S-01 用「源码里没写 || '—'」证它，这里直接要求在页产值上证） */
  const badToken = (cs: string[]) => cs.filter((c) => /未指派|undefined|null/.test(c) || /^\s+$/.test(c));
  const fakeWithStem = `负责人：${PH}（其实张三在编）`;
  const fakeIsPlaceholderSlot = fakeWithStem === PH;
  okPair(ok, 'X-03 占位口径唯一（不可改原语 → 值级取证）：缺口格逐字等于导出常量、补缺后归零、全表无第二种占位形态',
    () => gapCount > 0 && filledCells.filter((c) => c === PH).length === 0 && badToken(gapCells).length === 0,
    () => fakeIsPlaceholderSlot === false && PH.length > 0,
    () => ({ 占位格数: gapCount, 补齐后: filledCells.filter((c) => c === PH).length, 异形态: badToken(gapCells).slice(0, 5), 含PH非等值格: gapCells.filter((c) => c.includes(PH) && c !== PH).slice(0, 5) }));
  ok('X-04 同一性判据有牙：补齐缺口后占位计数必须从 n 归 0（否则 X-03 只是恒等式）',
    gapCount > 0 && filledCells.filter((c) => c === PH).length === 0, { gapCount });

  /** X-05 数据键单源表改名模拟：合法键集合随 `KICKOFF_DATA_KEYS` 移动，旧键失效，还原后判定逐字相同 */
  const keys = S.KICKOFF_DATA_KEYS as unknown as string[];
  const idx = keys.indexOf('workload');
  const kf: string[] = [];
  if (idx < 0) kf.push('KICKOFF_DATA_KEYS 里没有 workload（表形态变了，模拟需重新接线）');
  else {
    const orig = keys[idx];
    const renamed = 'ZZZ-workload';
    const verdict = (k: string) => {
      try { S.assertOutlineShape([{ section: '工作量评估', title: 't', bullets: [], dataKeys: [k], layout: 'list' }]); return 'accepted'; }
      catch (e) { return `rejected:${(e as Error).message.slice(0, 20)}`; }
    };
    const before = verdict(orig);
    try {
      keys[idx] = renamed;
      if (verdict(renamed) !== before) kf.push(`新键没被同口径接受（${before} → ${verdict(renamed)}）`);
      if (verdict(orig) === before) kf.push('旧键改名后仍被接受——合法键集没跟着单源表移动');
    } finally {
      keys[idx] = orig;
    }
    if (verdict(orig) !== before) kf.push('还原后判定与初始不一致（模拟留了残渣）');
  }
  ok('X-05 数据键单源表改名模拟：合法键集随表移动、旧键失效、还原后判定逐字相同', kf.length === 0, kf);
}

// ================= N 组：负对照（T02293 判据 4） =================
lines.push('');
lines.push('== N 组：负对照（证明配对有牙）');
{
  const spy: Array<{ name: string; cond: boolean; extra?: unknown }> = [];
  const sOk = (name: string, cond: boolean, extra?: unknown) => spy.push({ name, cond, extra });
  // N-01 假夹具：文案里带占位词，但「assignee 全空」这个行为前提不成立（Bundle 其实有人）
  okPair(sOk, 'N-01 假夹具：占位词在文本里、缺口行为不在，配对必须判红',
    () => bundleOf().assignees.length === 0, () => `负责人：${PH}`.includes(PH), () => ({ 假文本: `负责人：${PH}` }));
  ok('N-01 负对照落地：只看字面会放行，配对判定为红且红因是「行为失守」',
    spy.length === 1 && spy[0].cond === false && JSON.stringify(spy[0].extra).includes('行为失守'), spy);

  // N-02 假夹具：页面照抄了降级口径那句话，但 Bundle 通道给的是估算口径（静默换数的形态）
  spy.length = 0;
  okPair(sOk, 'N-02 假夹具：工期口径文案逐字对得上、通道却是估算分支 → 判红',
    () => bundleOf().workload.source === 'duration', () => dur.footer === '工期口径，非三点估算', () => ({ 通道: bundleOf().workload.source }));
  ok('N-02 负对照落地：文案逐字相同也不放行，行为侧失守即红', spy.length === 1 && spy[0].cond === false, spy);

  // N-03 真反证：抽掉留痕通道后重装配，页面上那句话必须一并消失（留痕不是常驻模板字）
  const noTraceDeck = await B.buildKickoffPpt(bundleOf({ workload: { ...dur, reviewTrace: null } }), outline);
  const noTraceText = await deckText(noTraceDeck.buffer);
  okPair(ok, 'N-03 破行为反证：抽掉 reviewTrace 通道后页面文案随之消失（不是常驻模板字）',
    () => durText.includes(String(dur.reviewTrace)) && !noTraceText.includes(String(dur.reviewTrace)),
    () => /未经估算复核/.test(durText) && !/未经估算复核/.test(noTraceText),
    () => ({ 留痕: dur.reviewTrace }));

  // N-04 反证：AI 恰好写对了数 → 不改写、不产生 warning（纠偏不是无脑替换）
  const sameTruth = bundleOf({ workload: { ...est, manDays: { expected: 96, optimistic: 78, pessimistic: 132 } } });
  const s4 = sanitize(['整体工作量约 96 人天'], sameTruth);
  okPair(ok, 'N-04 反证：AI 写对了数就不改也不留 warning（配对不是「逢数字必改」）',
    () => s4.w.length === 0 && s4.out[0] === '整体工作量约 96 人天',
    () => s4.out[0].includes(String(sameTruth.workload.manDays.expected)), s4);

  // N-05 反证（判据 4）：占位判据必须**有牙**。门内造一份「缺口未填却出真名」的假夹具——
  // 把逐字等于 `KICKOFF_PLACEHOLDER` 的那些格换成「王五」，同一条判据必须立刻认不出占位；
  // 若它在假夹具上仍判绿，说明它认的只是页面结构（表头/说明句还在），不是占位行为本身。
  const gapAssigneeCells = cellsOf(B.blocksForKey('assignees', bundleOf({ assignees: [] })));
  const phCells = gapAssigneeCells.filter((c) => c === PH);
  const lyingCells = gapAssigneeCells.map((c) => (c === PH ? '王五' : c));
  okPair(ok, 'N-05 反证：占位格换成真名的假夹具必须让占位判据转红（恒绿的占位判据不算判据）',
    () => phCells.length > 0 && lyingCells.every((c) => c !== PH) && lyingCells.length === gapAssigneeCells.length
      && lyingCells.includes('王五') && gapAssigneeCells.includes(PH),
    () => /一律记/.test(gapAssigneeCells.join('\n')), () => ({ 占位格数: phCells.length, 篡改后: lyingCells.slice(0, 6) }));

  // N-06 红因可区分：行为失守与字面锚点失配是两种红，不能都读成「功能挂了」
  spy.length = 0;
  okPair(sOk, 'N-06a 行为失守样', () => false, () => true);
  okPair(sOk, 'N-06b 锚点失配样', () => true, () => false);
  okPair(sOk, 'N-06c 双绿样', () => true, () => true);
  ok('N-06 红因可区分：两种红各带自己的红因，双绿才计 PASS',
    spy.length === 3 && spy[0].cond === false && JSON.stringify(spy[0].extra).includes('行为失守')
    && spy[1].cond === false && JSON.stringify(spy[1].extra).includes('字面锚点失配') && spy[2].cond === true, spy);
}

console.log(`PASS=${pass} FAIL=${fail}`);
console.log(lines.join('\n'));
process.exit(fail === 0 ? 0 : 1);
