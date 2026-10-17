/**
 * T02099 门：启动会 PPT 装配器（PRD-项目启动会PPT生成 FR-4 / 技术方案 §3.3 §4）。
 *
 * 断言：
 *   S 组 源码守卫：pptxgenjs 只在适配层、装配层不查库不调 AI、尺寸不散写、只用稳定原生对象 API、
 *                  降级路径与数字改写规则存在。
 *   U 组 纯函数 + 真产物：12 个 dataKey 全覆盖取数、堆叠/双栏不越界不重叠、假数字被改写真数字不动、
 *                  `buildKickoffPpt` 出真 .pptx 并解包 XML 断言（原生文本/表格/图表、无整页图片、
 *                  条数与库内真值一致 = 验收 5/6/8 的先声；越界页降级 = 验收 7 的先声）。
 *
 * 隔离纪律：不连生产库、不起服务、不调 AI（Bundle 由脚本内构造，字段形状对齐 KickoffBundle）。
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02099-kickoff-builder.mts
 * 结果落 .workbuddy/t02099-gate-results-<运行标识>.txt 与 t02099-sample-<运行标识>.pptx（T02309 旁证同标识）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults, gateArtifactPath } from './lib/gate-results.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};

// ---------- S 组：源码/契约守卫 ----------
const B = readFileSync(join(ROOT, 'server', 'src', 'services', 'kickoffBuilder.ts'), 'utf8');
const LAY = readFileSync(join(ROOT, 'server', 'src', 'services', 'kickoff-layout.ts'), 'utf8');
const IMPORTS = (B.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').match(/^import[\s\S]*?;$/gm) ?? []).join('\n');

const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const BODY = stripComments(B);
const plansSrc = stripComments(readFileSync(join(ROOT, 'server', 'src', 'routes', 'plans.ts'), 'utf8'));
ok('S-01 pptxgenjs 只在适配层被 import（风险 R1：kickoff 链路不散用）',
  /import\('pptxgenjs'\)/.test(BODY) && !/pptxgenjs/.test(stripComments(LAY)) && !/pptxgenjs/.test(plansSrc),
  { inBody: /import\('pptxgenjs'\)/.test(BODY), inLayout: /pptxgenjs/.test(stripComments(LAY)), inRoutes: /pptxgenjs/.test(plansSrc) });
ok('S-02 装配层不查库、不调 AI（取数全部来自 Bundle 入参）',
  !/better-sqlite3|getDb|AIService|askJson|fetch\(/.test(IMPORTS) && !/from '\.\.\/db\//.test(B));
ok('S-03 画布尺寸不散写：defineLayout 用 KICKOFF_LAYOUT_DEF，产物里不出现第二份 5.625',
  /pptx\.defineLayout\(KICKOFF_LAYOUT_DEF\)/.test(B) && !/5\.625/.test(B));
ok('S-04 只用稳定原生对象 API（addText/addTable/addChart），不整页贴图（验收 5）',
  /slide\.addText\(/.test(B) && /slide\.addTable\(/.test(B) && /slide\.addChart\(/.test(B) && !/addImage\(/.test(B));
ok('S-05 版式断言在写盘前消费（越界 → 降级 + warnings，验收 7）',
  /pageViolations\(/.test(B) && /safeFrames\(\)/.test(B) && /已降级为「标题 \+ 正文」安全版式/.test(B));
ok('S-06 数字防幻觉改写规则成表且逐条记 warning（FR-3.4 / 验收 8）',
  /const METRICS: Metric\[\] = \[/.test(B) && (B.match(/\bre: \//g) ?? []).length >= 6 && /数字由系统改写/.test(B));
ok('S-07 几何判断委托 T02098（本层不自己算对比度/边界）',
  !/relativeLuminance|Math\.pow\(/.test(B) && /assertInBounds/.test(B) && /findOverlaps/.test(B) && /contrastRatio/.test(B) === false && /auditPalette\(\)/.test(B));
ok('S-08 色值只走 PALETTE 单源', !/["'#][0-9a-fA-F]{6}/.test(B.replace(/\/\/.*$/gm, '')) && /PALETTE\./.test(B));

// ---------- 测试夹具（字段形状对齐 KickoffBundle） ----------
const bundleOf = (over: Record<string, unknown> = {}) => ({
  project: { id: 'p1', name: 'mtask五期', workspacePath: 'D:\\code\\otherProjects\\26_MTask' },
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
    projectId: 'p1', projectName: 'mtask五期', blocked: false, missingHard: [], workloadSource: 'estimate',
    items: (['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'] as const).map((key, i) => ({
      key, label: `项${key}`, count: [1, 14, 23, 6, 0, 23, 1][i], status: (i === 4 ? 'warn' : 'ok') as 'ok' | 'warn' | 'fail',
      note: '示例说明文字', deepLink: 'plan', hard: i < 3,
    })),
  },
  workspaceNote: '工作空间可访问，技术章节可引用其中素材',
  dataAsOf: '2026-10-13',
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
ok('U-03 覆盖率页取数用库内真值（40/32/8/80%），非模板假数',
  M.blocksForKey('coverage', bundle)[0].text!.content.includes('测试用例 40 条') && M.blocksForKey('coverage', bundle)[0].text!.content.includes('需求覆盖率 80%'));
ok('U-04 工作量页三点区间与页脚来源如实（估算分支）',
  (() => {
    const c = M.blocksForKey('workload', bundle)[0].text!.content;
    return c.includes('78~132（P50 96）') && c.includes('P50 96 / P84 118') && c.includes('工作量来源：估算引擎');
  })(), M.blocksForKey('workload', bundle)[0].text?.content);
ok('U-05 duration 降级分支不谎称三点（optimistic/pessimistic 为空 → 不输出区间）',
  (() => {
    const b2 = bundleOf({ workload: { ...(bundleOf() as any).workload, source: 'duration', manDays: { expected: 69, optimistic: null, pessimistic: null }, quote: null, footer: '工期口径，非三点估算' } });
    const c = M.blocksForKey('workload', b2)[0].text!.content;
    return c.includes('总工作量 69 人天') && !c.includes('~') && c.includes('工期口径');
  })(), M.blocksForKey('workload', bundleOf({ workload: { ...(bundleOf() as any).workload, quote: null } }))[0].text?.content);
ok('U-06 无估算行时不硬出饼图（用例 0 条 → coverage 只有文本块）',
  M.blocksForKey('coverage', bundleOf({ coverage: { total: 0, covered: 0, uncovered: 0, rate: 0 } })).length === 1);
ok('U-07 阶段 <2 时不出柱图（单阶段画出来没有信息量且易崩）',
  M.blocksForKey('workload', bundleOf({ workload: { ...(bundleOf() as any).workload, phases: [{ phase: '开发', expected: 60, rowCount: 3 }] } })).length === 1);

// ---------- U-2 数字防幻觉 ----------
const warns: string[] = [];
const rewritten = M.sanitizeBullets(['需求 999 条已就绪', '计划 23 条', '里程碑 3 个', '两周内出原型', '覆盖率 12%'], bundle, 4, warns);
ok('U-08 假数字改写为库内真值（需求 999 → 14）', rewritten[0].includes('需求 14 条'), rewritten[0]);
ok('U-09 真数字原样保留（计划 23 条不动、也不产生 warning）',
  rewritten[1] === '计划 23 条' && !warns.some((w) => /计划/.test(w)), { line: rewritten[1], warns });
ok('U-10 修辞数字不误伤（「两周内出原型」保持原句）', rewritten[3] === '两周内出原型', rewritten[3]);
ok('U-11 覆盖率假数改写且不产生「覆盖率 12%%」双写', rewritten[4].includes('覆盖率 80%') && !/%%/.test(rewritten[4]), rewritten[4]);
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
ok('U-23 产物文本里的数字就是库内真值（需求 14 / 计划 23 / 覆盖率 80%，且全文无 999，验收 8）',
  allText.includes('需求 14 条') && allText.includes('计划 23 条') && allText.includes('覆盖率 80%') && !/999/.test(allText),
  { req: allText.match(/需求 \d+ 条/)?.[0], plan: allText.match(/计划 \d+ 条/)?.[0], cov: allText.match(/覆盖率 \d+%/)?.[0], has999: /999/.test(allText) });
ok('U-24 每页页脚带项目名与数据截至日（口径可追溯）', slideXmls.every((x) => /mtask五期/.test(x) && /2026-10-13/.test(x)));
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

// ---------- 输出 ----------
writeGateResults(OUT_DIR, 't02099-gate-results.txt', `T02099 装配器门：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`);
console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
