/**
 * T02199 门：降级页 fit:shrink 渲染期收缩 + 空正文页收口（含截字/收缩留痕口径分列）。
 *
 * 三条口径各一组断言：
 *   S 组 收缩只在降级页：安全版式是「已知装不下原文」的页，预测量在这里最不可靠（框换了、
 *        字数没换），交给渲染期 shrink；正文页维持「预测量 + 截字留痕」——否则长文会静默缩成
 *        小字，读者看不到也问不出「这页被缩过」。产物级证据是 pptxgenjs 把 fit:'shrink' 落成
 *        `<a:normAutofit/>`（不开就不写该标签），逐页核对「降级页有、正文页无」。
 *   E 组 空正文收口：每页强制写标题带与脚注，所以 v1 的「无块且无标题」永不成立——真实形态是
 *        「正文无可绘内容」（AI 交出空 bullets + 空 dataKeys 的内容页，或降级路径回塞出 content
 *        为空的文本块：块在、页上没字）。这类页比越界页更难在抽查里被发现，生成时就得拦。
 *   C 组 口径不互相覆盖：同页既能出「按 pptxgenjs 截字」（正文页压缩）又能出「fit:shrink 收缩」
 *        （降级页），两条留痕各自成立、互不冒充。
 *
 * 隔离纪律：不连生产库、不起服务、不调 AI（Bundle 脚本内构造）。
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02199-kickoff-shrink-empty.mts
 * 结果落 .workbuddy/t02199-gate-results-<运行标识>.txt 与 t02199-shrink-<运行标识>.pptx（T02309 旁证同标识）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { writeGateResults, gateArtifactPath } from './lib/gate-results.mts';

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

const OVERFLOW_TITLE = '本页标题刻意超长以逼出越界'.repeat(4);
const page = (over: any) => ({ section: '正文', title: '常规标题页', bullets: ['「需求 1」已完成拆解并与排期对齐', '「需求 2」处于开发阶段'], dataKeys: ['reqStats'], layout: 'list', ...over });

/**
 * 8 页混合稿（页号即 slide 序，无时间线页所以不展开）：
 *  1 cover / 2 toc / 8 thanks —— 按设计留白，不参与空正文收口
 *  3 正常内容页（正文页口径：预测量 + 不收缩）
 *  4 越界长标题 + 有要点（降级 → 收缩）
 *  5 空 bullets + 空 dataKeys 的内容页（收口 → 回塞标题 + 收缩）
 *  6 越界 + 内容全空（同页只记一次降级，两条留痕都在）
 *  7 超长要点 + 大表（正文页「截字」留痕仍成立，且不许被收缩口径冒充）
 */
const outline = [
  page({ layout: 'cover', title: 'mtask五期 项目启动会', bullets: [], dataKeys: [] }),
  page({ layout: 'toc', title: '目录', bullets: [], dataKeys: [] }),
  page({ title: '需求与计划概况' }),
  page({ title: OVERFLOW_TITLE, dataKeys: ['planRows'] }),
  page({ title: '本页 AI 未交出任何内容', bullets: [], dataKeys: [] }),
  page({ title: OVERFLOW_TITLE, bullets: [], dataKeys: [] }),
  page({
    title: '要点与表格争版面',
    bullets: Array.from({ length: 22 }, (_, i) => `「需求 ${i + 1}」已完成拆解并与排期对齐，当前处于开发阶段，风险与依赖已在跟踪矩阵登记留痕，会上需确认验收口径与交付节点`),
    dataKeys: ['reqList'],
  }),
  page({ layout: 'thanks', title: '谢谢', bullets: [], dataKeys: [] }),
];

const DEGRADED = [4, 5, 6];
const PLAIN = [1, 2, 3, 7, 8];

// ---------- S 组：收缩只在降级页（单元层） ----------
const rec = () => {
  const calls: any[] = [];
  return { calls, addText: (t: any, o: any) => calls.push({ t, o }), addShape: () => {}, addTable: () => {}, addChart: () => {} };
};
const body = LAY.framesFor('data', 'list').body;
const plain = rec();
M.drawBlock(plain, { box: body, text: { content: '正文页文本', pt: 14 } });
ok('S-01 不带 shrink 的正文块不写 fit（正文页维持「预测量 + 截字留痕」，不静默缩字）',
  plain.calls.length === 1 && plain.calls[0].o.fit === undefined, plain.calls[0]?.o);

const shrunk = rec();
M.drawBlock(shrunk, { box: body, text: { content: '降级页文本', pt: 14, shrink: true } });
ok('S-02 降级块开 shrink → pptxgenjs 收到 fit:shrink',
  shrunk.calls[0]?.o.fit === 'shrink', shrunk.calls[0]?.o);

const twoCol = LAY.framesFor('twoCol', 'twoCol', LAY.TEXT_SPLIT);
const layouts = [
  { item: page({}), frames: LAY.framesFor('data', 'list') },
  { item: page({ dataKeys: ['coverage', 'reqList'] }), frames: twoCol },
  { item: page({ bullets: [], dataKeys: ['planRows', 'risks'] }), frames: LAY.framesFor('data', 'list') },
].map((c) => M.layoutBody(c.item as any, bundle, c.frames as any, c.item.bullets));
ok('S-03 layoutBody 的三组产出（含被压缩的正文页）都不带 shrink——收缩只在降级/收口路径',
  layouts.every((r) => r.blocks.every((b: any) => !b.text?.shrink)),
  layouts.map((r) => r.blocks.map((b: any) => !!b.text?.shrink)));

const emptyTextRec = rec();
M.drawBlock(emptyTextRec, { box: body, text: { content: '   ', pt: 14, shrink: true } });
ok('S-06 「块在、页上没字」的形态真实存在（空 content 仍会 addText，只数块数确实会漏）',
  emptyTextRec.calls.length === 1 && emptyTextRec.calls[0].t.trim() === '', emptyTextRec.calls);

// ---------- E 组 + 产物级 S 组 ----------
const built = await M.buildKickoffPpt(bundle as any, outline as any);
const zip = await JSZip.loadAsync(built.buffer);
const slideNames = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
  .sort((a, b) => Number(/(\d+)\.xml/.exec(a)![1]) - Number(/(\d+)\.xml/.exec(b)![1]));
const xmls: Record<string, string> = {};
for (const n of slideNames) xmls[n] = await zip.file(n)!.async('string');
const autofit = (n: string) => /<a:normAutofit/i.test(xmls[n]);
const textsOf = (n: string) => (xmls[n].match(/<a:t>([\s\S]*?)<\/a:t>/g) ?? []).map((t) => t.replace(/<\/?a:t>/g, ''));
const warnOf = (p: number) => built.warnings.filter((w: string) => w.startsWith(`第 ${p} 页`));
const pageNums = (re: RegExp) => built.warnings.filter((w) => re.test(w)).map((w) => Number(/^第 (\d+) 页/.exec(w)![1]));

ok('S-07 产物级：降级页正文确实带 <a:normAutofit（fit:shrink 落到 xml 的唯一形态）',
  DEGRADED.every((p) => autofit(slideNames[p - 1])),
  DEGRADED.map((p) => [p, autofit(slideNames[p - 1])]));
ok('S-08 产物级：非降级页（封面/目录/正文/截字页/结束页）一律不写 normAutofit（不静默缩字）',
  PLAIN.every((p) => !autofit(slideNames[p - 1])),
  PLAIN.map((p) => [p, autofit(slideNames[p - 1])]));
ok('S-09 留痕口径同步：每个降级页都点名去向（安全版式/章节式留白）并交代「渲染期收缩、不截字」',
  DEGRADED.every((p) => warnOf(p).some((w) => /安全版式|章节式留白/.test(w)) &&
    warnOf(p).some((w) => /渲染期收缩.*不截字|不截字.*渲染期收缩/.test(w)) &&
    (p === 4 || p === 6 ? warnOf(p).some((w) => /版式越界/.test(w)) : true) &&
    (p === 5 ? warnOf(p).some((w) => /皆空/.test(w)) : true)),
  { p4: warnOf(4), p5: warnOf(5), p6: warnOf(6) });
ok('S-10 收缩留痕不串页：带「渲染期收缩」的页恰为降级页集合（正文页不许被缩字口径污染）',
  JSON.stringify([...new Set(pageNums(/渲染期收缩/))].sort((a, b) => a - b)) === JSON.stringify(DEGRADED) &&
    pageNums(/渲染期收缩/).every((p) => built.degradedPages.includes(p)),
  { shrink: pageNums(/渲染期收缩/), degraded: built.degradedPages });

ok('E-01 空正文内容页被拦：warnings 点名「正文与要点皆空」，degradedPages 含该页',
  built.warnings.some((w) => /^第 5 页/.test(w) && /正文与要点皆空/.test(w)) && built.degradedPages.includes(5),
  { warn: warnOf(5), degraded: built.degradedPages });
ok('E-02 收口不是凑数：该页正文回塞成句（标题文本在页上出现 ≥2 次：标题带 + 正文）',
  textsOf(slideNames[4]).filter((t) => t.includes('本页 AI 未交出任何内容')).length >= 2,
  textsOf(slideNames[4]));
ok('E-03 按设计留白的页不误伤：封面/目录/结束页都没有「皆空」告警',
  ![1, 2, 8].some((p) => pageNums(/皆空/).includes(p)), pageNums(/皆空/));
ok('E-04 正常页不受牵连：第 3 页零告警、零降级',
  warnOf(3).length === 0 && !built.degradedPages.includes(3), { warn: warnOf(3), degraded: built.degradedPages });
ok('E-05 越界 + 内容全空同页只记一次降级（三条留痕都在，degradedPages 不重复）',
  built.degradedPages.filter((p) => p === 6).length === 1 &&
    warnOf(6).some((w) => /版式越界/.test(w)) && warnOf(6).some((w) => /渲染期收缩/.test(w)) && warnOf(6).some((w) => /皆空/.test(w)),
  { warn: warnOf(6), degraded: built.degradedPages });
ok('E-06 降级页集合恰为 {4,5,6}，其余页面零降级（收口没有把整稿带崩）',
  JSON.stringify([...new Set(built.degradedPages)].sort((a, b) => a - b)) === JSON.stringify(DEGRADED),
  built.degradedPages);

// ---------- S-04 / S-05：T02293 改判（原来是读 kickoffBuilder.ts 源码正则） ----------
// S-04 原写法：`fit:'shrink'` 在源码里只出现一次 + layoutBody 函数体内不出现 shrink。
// 那是「写在哪个函数、用词出现几次」的形态，等价重构（把收缩开关挪进 drawBlock 的入参归一化、
// 或把 layoutBody 拆成两段）必红，而机制有没有坏掉，S-03（单元层）+ S-07/S-08（产物层）已各自答过。
// 改判后钉行为：降级页写 normAutofit、非降级页一律不写；同页里 S-02 证明「要收缩时确实写得出」，
// 于是 S-08 的零出现不是恒绿（这正是本条的负对照配对）。
ok('S-04 收缩只落在降级路径（行为腿：layoutBody 三组产出无 shrink + 产物层降级页有 normAutofit、非降级页零 normAutofit；'
  + '反证腿：S-02 证明 shrink 入参确实会写出 fit，所以零出现不是恒绿）',
  layouts.every((r) => r.blocks.every((b: any) => !b.text?.shrink))
    && DEGRADED.every((pg) => autofit(slideNames[pg - 1]))
    && PLAIN.every((pg) => !autofit(slideNames[pg - 1]))
    && shrunk.calls[0]?.o.fit === 'shrink',
  { degradedHasAutofit: DEGRADED.map((pg) => autofit(slideNames[pg - 1])),
    plainHasAutofit: PLAIN.map((pg) => autofit(slideNames[pg - 1])) });

// S-05 原写法：源码里出现 `!bodyBlocks.some(drawable)` 且不再出现 `bodyBlocks.length === 0`。
// 判据换代的正确证据不是字面量，而是「新判据抓得到、旧判据抓不到」的那个形态：
// S-06 已证「块在页上、content 全空白」时 addText 仍被调用（块数=1，旧判据数块会放行），
// E-01 证同一个页面（第 5 页）现在被拦并降级——两条同时成立才算机制真的换了口径。
ok('S-05 空页判定按「有没有可绘内容」而非「有没有块」：空白 content 仍会 addText（旧判据数块会放行，S-06），'
  + '而该页确实被拦+降级（新判据，E-01）',
  emptyTextRec.calls.length === 1 && emptyTextRec.calls[0].t.trim() === ''
    && built.warnings.some((w) => /^第 5 页/.test(w) && /皆空/.test(w)) && built.degradedPages.includes(5),
  { 块数: emptyTextRec.calls.length, warn5: warnOf(5), degraded: built.degradedPages });

// ---------- C 组：两套留痕互不冒充 ----------
ok('C-01 正文页「截字」口径仍在：第 7 页要点为表格让位仍如实报截字',
  warnOf(7).some((w) => /按 pptxgenjs 截字/.test(w)), warnOf(7));
ok('C-02 收缩不冒充截字、截字不冒充收缩：两条文案分别只落在对应页上',
  !warnOf(7).some((w) => /渲染期收缩/.test(w)) &&
    !DEGRADED.some((p) => warnOf(p).some((w) => /按 pptxgenjs 截字/.test(w) && /收缩/.test(w))),
  { p7: warnOf(7), p4: warnOf(4) });
ok('C-03 收缩页仍零版式违规（回塞/降级文本没顶出安全框）',
  !built.warnings.some((w) => /越出|超出页面/.test(w)), built.warnings.filter((w) => /越|超/.test(w)));

writeFileSync(gateArtifactPath(OUT_DIR, 't02199-shrink.pptx'), built.buffer);
writeGateResults(OUT_DIR, 't02199-gate-results.txt', `T02199 降级页收缩与空正文收口门：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`);
console.log(`PASS=${pass} FAIL=${fail}`);
lines.filter((l) => l.startsWith('[FAIL]')).forEach((l) => console.log(l));
process.exit(fail ? 1 : 0);
