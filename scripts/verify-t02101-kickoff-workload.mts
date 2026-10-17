/**
 * T02101 门：工作量与降级逻辑（PRD FR-4.6 / FR-4.1 / FR-2.2 / K7 占位路径 / 验收 6）。
 *
 * 断言：
 *   S 组 源码守卫：占位词单源、人月因子不写死、页脚口径来自 Bundle、不静默换数（R2）。
 *   W 组 工作量口径纯函数：有估算 / 降级工期 / 零数据三分支的 footer、noData、reviewTrace。
 *   U 组 装配层取数：占位文本、覆盖率零用例改写、assignee 缺失禁编人名、脚注带章节与口径。
 *   P 组 真产物：解包 .pptx 逐页核对脚注文案与「不把空缺写成 0 人天」——页面上说了什么才算数。
 *
 * 隔离纪律：不连生产库、不起服务、不调 AI（Bundle/Summary 脚本内构造）。
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02101-kickoff-workload.mts
 * 结果落 .workbuddy/t02101-gate-results-<运行标识>.txt 与 t02101-workload-<运行标识>.pptx（T02309 旁证同标识）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { gateArtifactPath } from './lib/gate-results.mts'; // T02309：旁证产物按运行标识命名

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

// ---------- S 组：源码/契约守卫 ----------
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const BSRC = stripComments(readFileSync(join(ROOT, 'server', 'src', 'services', 'kickoffBuilder.ts'), 'utf8'));
const SSRC = stripComments(readFileSync(join(ROOT, 'server', 'src', 'services', 'kickoffService.ts'), 'utf8'));

ok('S-01 占位词单源定义、装配层只引用常量（散写的「—/未指派」会各页口径不一）',
  /export const KICKOFF_PLACEHOLDER = '待补充'/.test(SSRC) && BSRC.includes('KICKOFF_PLACEHOLDER') &&
    !BSRC.includes("|| '—'") && !BSRC.includes('未指派'));
ok('S-02 人月换算因子取估算配置，装配层不写死 20.83（因子可在参数页改，写死就跟计算分叉）',
  !/20\.83/.test(BSRC) && /manDaysPerManMonth: summary\.config\.manDaysPerManMonth/.test(SSRC) &&
    /toManMonth\(/.test(SSRC));
ok('S-03 页脚口径来自 Bundle（验收 6 要求页面动态显示，不是模板硬话）',
    /b\.workload\.footer/.test(BSRC) && /b\.workload\.reviewTrace/.test(BSRC));
ok('S-04 估算/降级判定仍以 countedKeys 为准且带来源标注（R2：不静默换数）',
  /summary\.countedKeys\.length > 0/.test(SSRC) && /source: 'estimate'/.test(SSRC) && /source: 'duration'/.test(SSRC));
ok('S-05 零数据分支独立成文（0 人天是「没填」不是「工作量为零」）',
  /const noData = execDays === 0/.test(SSRC) && /noData/.test(BSRC));
ok('S-06 覆盖率/工作空间的缺数留痕落在页面正文（FR-2.2 不许只在 UI 提示）',
  /本期未建/.test(BSRC) && /未配置/.test(BSRC));

// ---------- W 组：workloadOf 三分支（口径纯函数） ----------
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

const est = S.workloadOf(summaryOf(), [plan(1, 10)], pf('ok'));
ok('W-01 有估算行 → source=estimate + 页脚「工作量来源：估算引擎（P50/P84）」',
  est.source === 'estimate' && est.footer === '工作量来源：估算引擎（P50 96 人天 / P84 118 人天）' && est.noData === false, est.footer);
ok('W-02 估算分支不叠工期（同一批工作量算两遍会让报价翻倍）',
  est.counted === 2 && est.manDays.expected === 96, est);
ok('W-03 人月 = 人天 ÷ 配置因子（96 ÷ 20.83 ≈ 4.61）', Math.abs(est.manMonth - 4.61) < 0.01, est.manMonth);

const dur = S.workloadOf(summaryOf({ countedKeys: [], phases: [] }), [plan(1, 10), plan(2, 8), plan(3, 0, 'milestone')], pf('warn'));
ok('W-04 无估算行 → 降级 Σ duration_days 且页脚「工期口径，非三点估算」',
  dur.source === 'duration' && dur.footer === '工期口径，非三点估算' && dur.manDays.expected === 18, dur);
ok('W-05 降级分支排除 milestone 行（18 = 10+8，不含里程碑汇总）',
  dur.manDays.expected === 18 && dur.counted === 2, { expected: dur.manDays.expected, counted: dur.counted });
ok('W-06 降级没有三点 → 乐观/悲观如实为 null，不用期望值冒充区间',
  dur.manDays.optimistic === null && dur.manDays.pessimistic === null && dur.quote === null);
ok('W-07 P6 warn + 有工期 → 出 FR-2.2 页脚留痕「未经估算复核」',
  dur.reviewTrace === '本页工期由排期推导，未经估算复核', dur.reviewTrace);
ok('W-08 P6 ok 时不加留痕（有数据又齐备还写「建议复核」是自我抹黑）',
  S.workloadOf(summaryOf({ countedKeys: [], phases: [] }), [plan(1, 10)], pf('ok')).reviewTrace === null);

const zero = S.workloadOf(summaryOf({ countedKeys: [], phases: [] }), [plan(1, 0), plan(2, 0)], pf('warn'));
ok('W-09 工期全未填 → noData=true 且页脚写明「待补充」，不是 0 人天结论',
  zero.noData === true && /待补充/.test(zero.footer) && zero.manDays.expected === 0, zero.footer);
ok('W-10 零数据不叠留痕（连可复核的数都没有，写「由排期推导」是假话）',
  zero.reviewTrace === null, zero.reviewTrace);
ok('W-11 人月因子随配置走（改成 20 时 manMonth 与文字同变）', (() => {
  const w = S.workloadOf(summaryOf({ countedKeys: [], config: { manDaysPerManMonth: 20 } }), [plan(1, 40)], pf('ok'));
  return w.manMonth === 2 && w.manDaysPerManMonth === 20;
})(), S.workloadOf(summaryOf({ countedKeys: [], config: { manDaysPerManMonth: 20 } }), [plan(1, 40)], pf('ok')));

// ---------- 夹具 Bundle ----------
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
  workload: est,
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
const workloadBlockText = (b: any) => B.blocksForKey('workload', b)[0].text?.content ?? '';

// ---------- U 组：装配层取数与占位 ----------
ok('U-01 有估算：工作量页出区间 + P50/P84 + 来源口径（验收 6）', (() => {
  const t = workloadBlockText(bundleOf());
  return /78~132（P50 96）/.test(t) && /P50 96 人天 \/ P84 118 人天/.test(t) && /阶段分布/.test(t);
})(), workloadBlockText(bundleOf()));
ok('U-02 降级：按工期口径出单值，不谎称三点（无 P84 字样）', (() => {
  const t = workloadBlockText(bundleOf({ workload: dur }));
  return /总工作量 18 人天/.test(t) && !/P84/.test(t) && /工期口径，非三点估算/.test(t);
})(), workloadBlockText(bundleOf({ workload: dur })));
ok('U-03 零数据：出「待补充」并给补数路径，绝不出现「0 人天」', (() => {
  const t = workloadBlockText(bundleOf({ workload: zero }));
  return /总工作量：待补充/.test(t) && !/0 人天/.test(t) && /估算工作台|工期\(工作日\)/.test(t);
})(), workloadBlockText(bundleOf({ workload: zero })));
ok('U-04 人月因子跟配置同现（配置 20 时页面写 ÷ 20）',
  /÷ 20\.83）/.test(workloadBlockText(bundleOf())) && /÷ 20）/.test(workloadBlockText(bundleOf({ workload: { ...dur, manDaysPerManMonth: 20 } }))));

const tlPages = bundleOf({ plans: bundleOf().plans.map((p: any, i: number) => (i === 0 ? { ...p, assignee: '', start_date: '' } : p)) });
const planTable = B.blocksForKey('planRows', tlPages)[0].table!;
ok('U-05 计划表缺负责人/缺日期 → 单元格「待补充」，不渲染 undefined 或空白',
  planTable.rows.some((r) => r[2] === '待补充') && planTable.rows.every((r) => !/undefined|null/.test(r.join(''))),
  planTable.rows[0]);
const listTable = B.blocksForKey('timeline', tlPages)[0].table!;
ok('U-06 时间线列表版同样占位（与计划表同一口径，不一页「待补充」一页「—」）',
  listTable.rows[0].includes('待补充'), listTable.rows[0]);

const noAssignee = B.blocksForKey('assignees', bundleOf({ assignees: [] }));
ok('U-07 全员未填负责人：整页占位 + 一句来源说明，不编人名',
  noAssignee.length === 2 && /assignee/.test(noAssignee[0].text!.content) && !/王五|赵六/.test(noAssignee[0].text!.content) &&
    noAssignee[1].table!.rows[0][0] === '待补充', noAssignee.map((x) => x.text?.content ?? x.table?.rows));

const noCases = B.blocksForKey('coverage', bundleOf({ coverage: { total: 0, covered: 0, uncovered: 0, rate: 0 } }));
ok('U-08 零用例：覆盖率页改写策略口径（P5 承诺），不出「覆盖率 0%」结论、不画空饼图',
  /本期未建/.test(noCases[0].text!.content) && !/0%/.test(noCases[0].text!.content) && !noCases.some((x) => x.chart),
  noCases.map((x) => x.text?.content ?? (x.chart ? 'chart' : 'table')));
const hasCases = B.blocksForKey('coverage', bundleOf());
ok('U-09 有用例时照旧出真数与饼图（占位分支不误伤正常页）',
  /测试用例 40 条/.test(hasCases[0].text!.content) && hasCases[1].chart?.type === 'doughnut', hasCases.length);

// ---------- U 组：逐页脚注（FR-4.11 + 验收 6 + FR-2.2） ----------
const page = (layout: string, dataKeys: string[], section = '项目计划') => ({ section, title: '页', bullets: [], dataKeys, layout });
ok('U-10 脚注固定含「项目名 · 章节 · 数据截至」（FR-4.11 逐页可回溯）',
  /^mtask五期 · 项目计划 · 数据截至 2026-10-13/.test(B.footerOf(page('list', ['planRows']), bundleOf(), 3, 12) as any) &&
    /· 第 3\/12 页$/.test(B.footerOf(page('list', ['planRows']), bundleOf(), 3, 12)),
  B.footerOf(page('list', ['planRows']), bundleOf(), 3, 12));
ok('U-11 工作量页脚注动态带估算引擎口径（验收 6）',
  B.footerOf(page('twoCol', ['workload'], '工作量'), bundleOf(), 5, 12).includes('工作量来源：估算引擎（P50 96 人天 / P84 118 人天）'));
ok('U-12 降级 + P6 warn：脚注带「未经估算复核」留痕（FR-2.2 落在页面上）',
  B.footerOf(page('twoCol', ['workload'], '工作量'), bundleOf({ workload: dur }), 5, 12).includes('本页工期由排期推导，未经估算复核'),
  B.footerOf(page('twoCol', ['workload'], '工作量'), bundleOf({ workload: dur }), 5, 12));
ok('U-13 非工作量页不带口径文案（每页都贴工作量声明反而是噪音）',
  !/工作量来源|工期口径/.test(B.footerOf(page('table', ['planRows']), bundleOf({ workload: dur }), 2, 12)));
ok('U-14 零数据页脚注如实写待补充（口径与正文同源）',
  B.footerOf(page('twoCol', ['workload'], '工作量'), bundleOf({ workload: zero }), 5, 12).includes('工作量数据待补充'));

// ---------- U 组：AI 正文缺数时改占位（不许把幻觉改成 0） ----------
const sanitize = (bullets: string[], b: any) => {
  const w: string[] = [];
  return { out: B.sanitizeBullets(bullets, b, 2, w), w };
};
const ph1 = sanitize(['整体工作量约 96 人天，含回归'], bundleOf({ workload: zero }));
ok('U-15 零数据：AI 写「96 人天」改占位「工作量待补充」，绝不改成「0 人天」（空缺≠结论）',
  ph1.out[0] === '整体工作量约工作量待补充，含回归' || /待补充/.test(ph1.out[0]) && !/0 人天/.test(ph1.out[0]),
  ph1);
const ph2 = sanitize(['用例 12 条已铺满，覆盖率 80%'], bundleOf({ coverage: { total: 0, covered: 0, uncovered: 0, rate: 0 } }));
ok('U-16 零用例：用例数与覆盖率都改占位（与 P5「本期未建」口径一致，不出 0 条/0%）',
  /用例待补充/.test(ph2.out[0]) && /覆盖率待补充/.test(ph2.out[0]) && !/0/.test(ph2.out[0]), ph2.out[0]);
const ph3 = sanitize(['本期投入 96 人天'], bundleOf({ workload: dur }));
ok('U-17 有数据时仍按库内真值改写（占位分支不吞掉正常的纠偏）',
  ph3.out[0] === '本期投入 18 人天' && /库内实为/.test(ph3.w[0]), ph3);
ok('U-18 占位改写会写进 warnings（面板要能点名是哪页哪句）',
  /无此项数据/.test(ph1.w[0] ?? ''), ph1.w);

// ---------- P 组：真产物 ----------
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
const zip = await JSZip.loadAsync(built.buffer);
const slideTexts = async (n: number) => {
  const xml = await zip.file(`ppt/slides/slide${n}.xml`)!.async('string');
  return [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join('\n');
};
const s2 = await slideTexts(2);
const s3 = await slideTexts(3);
const s4 = await slideTexts(4);
const slideXmls = await Promise.all([1, 2, 3, 4].map(async (n) => await zip.file(`ppt/slides/slide${n}.xml`)!.async('string')));

ok('P-01 产物工作量页正文出「待补充」，全页无「0 人天」（空缺不冒充结论）',
  /总工作量：待补充/.test(s2) && !/0 人天/.test(s2 + s3 + s4), s2.slice(0, 200));
ok('P-02 产物工作量页脚注带章节 + 零数据口径（验收 6 在页面上成立）',
  /工作量评估 · 数据截至 2026-10-13 · 工作量数据待补充/.test(s2), s2.split('\n').at(-1));
ok('P-03 产物团队页出「待补充」行且不编人名',
  /待补充/.test(s3) && !/张三|李四/.test(s3), s3.slice(0, 200));
ok('P-04 产物覆盖率页写明本期未建用例',
  /本期未建/.test(s4) && !/0%/.test(s4), s4.slice(0, 200));
ok('P-05 占位稿不触发版式降级（缺数据也要排版合规，验收 7 反面）',
  built.degradedPages.length === 0, built.degradedPages);
ok('P-06 有估算 + 有工期时页脚动态切换（同一装配器两口径不同文案）', await (async () => {
  const ok2 = await B.buildKickoffPpt(bundleOf({ workload: dur }), outline);
  const z2 = await JSZip.loadAsync(ok2.buffer);
  const x2 = await z2.file('ppt/slides/slide2.xml')!.async('string');
  const t2 = [...x2.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join('\n');
  return /工期口径，非三点估算/.test(t2) && /未经估算复核/.test(t2) && /总工作量 18 人天/.test(t2);
})(), '见 slide2 文本');
ok('P-07 全稿仍是原生对象（无整页贴图，验收 5）',
  // T02156：允许 `<p:bg>` 背景图（恒生模板版式资产——背景是版式不是内容），
  // 判据收紧为「内容零位图」：无 <p:pic>，且每页每个 r:embed 都来自 <p:bg>
  [1, 2, 3, 4].every((n) => !/<p:pic/.test(slideXmls[n - 1])) &&
    [1, 2, 3, 4].every((n) => (slideXmls[n - 1].match(/r:embed="/g) ?? []).length === (slideXmls[n - 1].match(/<p:bg>/g) ?? []).length),
  { media: Object.keys(zip.files).filter((n) => n.startsWith('ppt/media/')) });

console.log(`PASS=${pass} FAIL=${fail}`);
console.log(lines.join('\n'));
