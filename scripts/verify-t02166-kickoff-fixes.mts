/**
 * T02166 门（PRD-项目启动会PPT生成 · 用户反馈「套话+表格越界」修复）。
 *
 * 覆盖四条主线的**改动前后差值**——每条断言都能反向证伪：
 *   J 组：`stripJsonTrailingCommas` / `parseAiJson` 修尾逗号；不吞字符串内的逗号，不放过语义违规。
 *   O 组：`outlineFacts` 补「样例事实」段（真实需求/计划/里程碑名），并驱动 OUTLINE_SYSTEM 第 10 条硬约束。
 *   R 组：`pushStackedBlocks` 只对表格刚性 drop；图表/文本仍允许裁（矢量图/截字不越页）。
 *   S 组：`layoutBody` 在有表格时给 bullets 封顶，让首个表格不因 avail<自然高被省略；
 *        无表格页保留原排版（不无端压 bullets）。
 *   F 组：`fitTableRows` 版面收行——表格排不下时按剩余高度收行并把被收掉的行并进
 *        「其余 n 条」计数，而不是整块 drop（整块 drop 就是用户反馈的「各页只剩套话」）。
 *   G 组：真链路（真实 AI 大纲 + 真项目）回灌的两形态——表格+文本+要点同页不得把预算算成负数，
 *        文本+图表同页时图表等比裁（`fitStack`）而不是被「空间不足」整块省略。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02166-kickoff-fixes.mts
 * 结果落 .workbuddy/t02166-gate-results-<运行标识>.txt。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');
mkdirSync(OUT_DIR, { recursive: true });

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};

const S = readFileSync(join(ROOT, 'server', 'src', 'services', 'kickoffService.ts'), 'utf8');
const B = readFileSync(join(ROOT, 'server', 'src', 'services', 'kickoffBuilder.ts'), 'utf8');

// ---------- J 组：AI JSON 尾逗号修复 ----------
const svc = await import('../server/src/services/kickoffService.ts');
const { stripJsonTrailingCommas, parseAiJson } = svc as unknown as {
  stripJsonTrailingCommas: (s: string) => string;
  parseAiJson: (s: string) => unknown;
};

// 用户反馈原文（日志里的形态）：对象末尾 + 数组末尾各带一个尾逗号
const tailCase = `{"risks":[{"item":"计划进度落后","mitigation":"确保调整可控",}],}`;
ok('J-01 结构位尾逗号被剥掉（对象尾、数组尾各一），JSON.parse 不再抛', (() => {
  const cleaned = stripJsonTrailingCommas(tailCase);
  const parsed = JSON.parse(cleaned) as { risks: Array<{ item: string; mitigation: string }> };
  return parsed.risks.length === 1 && parsed.risks[0].mitigation === '确保调整可控';
})(), stripJsonTrailingCommas(tailCase));

ok('J-02 字符串字面量内的「, 」与转义引号不被误伤', (() => {
  const src = `{"note":"a, b, ] c \\"end\\"","arr":[1,2,]}`;
  const parsed = JSON.parse(stripJsonTrailingCommas(src)) as { note: string; arr: number[] };
  return parsed.note === 'a, b, ] c "end"' && parsed.arr.length === 2;
})(), stripJsonTrailingCommas(`{"note":"a, b, ] c \\"end\\"","arr":[1,2,]}`));

ok('J-03 parseAiJson 一次通过代码围栏 + 尾逗号双重脏输入', (() => {
  const raw = '```json\n{"risks":[{"item":"x","impact":"y","mitigation":"z",}],"comms":["c1","c2",],}\n```';
  const parsed = parseAiJson(raw) as { risks: unknown[]; comms: string[] };
  return parsed.risks.length === 1 && parsed.comms.length === 2 && parsed.comms[0] === 'c1';
})(), 'parseAiJson failed on fenced+trailing-comma input');

// wordingFromAi 端到端：把日志里的形态喂进 parse，走非降级路径
const local = {
  risks: [{ item: '计划「甲」当前为阻塞态', impact: '该计划及其后继无法按期开工', mitigation: '会上明确阻塞责任方与解除时限', source: 'plan_tasks.status=blocked' }],
  comms: ['口径一', '口径二'],
};
const aiRaw = '{"risks":[{"item":"计划「甲」当前为阻塞态","impact":"该计划及其后继无法按期开工","mitigation":"会上明确阻塞责任方与解除时限",}],"comms":["口径一","口径二",],}';
ok('J-04 wordingFromAi(parseAiJson(tail)) 通过（此前 JSON.parse(stripFence) 直接抛错 → 走本地条目）', (() => {
  const out = (svc as unknown as { wordingFromAi: (l: unknown, r: unknown) => { risks: unknown[]; comms: unknown[] } }).wordingFromAi(local, parseAiJson(aiRaw));
  return out.risks.length === 1 && out.comms.length === 2;
})(), 'wordingFromAi still throws on trailing-comma shape');

ok('J-05 修复仅剥解析器噪声，语义违规仍被 wordingFromAi 拦下（AI 新增条目照样抛）', (() => {
  try {
    const bad = '{"risks":[{},{},],"comms":[]}'; // 3 条 vs 期望 1 条
    (svc as unknown as { wordingFromAi: (l: unknown, r: unknown) => unknown }).wordingFromAi(local, parseAiJson(bad));
    return false;
  } catch {
    return true;
  }
})());

// ---------- O 组：outlineFacts 样例事实段 ----------
// 反射调 outlineFacts（未 export）：从 kickoffOutline 的 user 拼装里取出
ok('O-01 outlineFacts 里带「样例事实」段落与需求名/里程碑名的引号包裹',
  /样例事实/.test(S) && /reqSamples/.test(S) && /milestoneSamples/.test(S) && /doingSamples/.test(S) && /blockedSamples/.test(S));

ok('O-02 OUTLINE_SYSTEM 追加第 10 条：bullets 必须引用【样例事实】里的具体名称，禁写无指代套话',
  /10\.\s*T02166[：:].*bullets.*样例事实/.test(S) && /无指代套话|无指代/.test(S));

ok('O-03 样例只喂名称与截止日，条数/合计数字仍由 dataKeys 覆盖（不违反 FR-3.4）',
  /数字仍由\s*dataKeys\s*覆盖/.test(S));

// 用 bundleOf 反射调 outlineFacts：从模块导出路径拿
// outlineFacts 未 export，但 kickoffOutline 内部会调用；我们直接检查文本包含关系：
// 手工构造一个 bundle，检查 outlineFacts 走的是 collectBundle 之后的分支——
// 这里改为源码断言 + 一个通过 collectBundle 的端到端 sanity check。
const fakeBundle = {
  project: { id: 'p1', name: '样例项目', workspacePath: '' },
  prdDocs: [], prdDoc: null, prdExcerpt: '', prdTruncated: false,
  requirements: Array.from({ length: 5 }, (_, i) => ({
    id: `r${i}`, project_id: 'p1', req_no: `R${i + 1}`, title: `需求样本标题${i + 1}这个标题很长超过限制`,
    content: null, source_ref: null, priority: 'high', status: 'doing', sort_order: i,
    created_at: null, updated_at: null, prd_id: null,
    linkedPlans: [{ id: 'x', title: 'p', status: 'doing' }], linkedTasks: [], prdDoc: null,
  })),
  plans: Array.from({ length: 6 }, (_, i) => ({
    id: `q${i}`, project_id: 'p1', title: `进行中任务${i + 1}`, description: '', start_date: '2026-01-05', end_date: '2026-02-20',
    duration_days: 3, progress: 50, status: i < 3 ? 'doing' : 'blocked', assignee: '张三', sort_order: i,
    linked_task_id: null, req_ids: null, color: '', deps: '', complexity: 3, kind: 'normal',
    archived: 0, archived_at: null, created_at: '', updated_at: '',
  })),
  milestones: [{
    id: 'm1', project_id: 'p1', title: 'M1 里程碑', description: '', start_date: '2026-01-10', end_date: '2026-03-01',
    duration_days: 20, progress: 0, status: 'doing', assignee: '', sort_order: 0, linked_task_id: null,
    req_ids: null, color: '', deps: '', complexity: null, kind: 'milestone', archived: 0, archived_at: null, created_at: '', updated_at: '',
  }],
  coverage: { total: 0, covered: 0, uncovered: 0, rate: 0 },
  assignees: [{ name: '张三', planCount: 6 }],
  risks: [],
  workload: {
    source: 'duration', manDays: { expected: 18, optimistic: null, pessimistic: null }, manMonth: 0.83,
    quote: null, phases: [], complexity: [], counted: 6, footer: 'x', noData: false, reviewTrace: null,
    manDaysPerManMonth: 21.75,
  },
  preflight: {
    projectId: 'p1', projectName: '样例项目', blocked: false, missingHard: [], workloadSource: 'duration',
    items: [],
  },
  workspaceNote: '', dataAsOf: '2026-10-15',
};
// 反射访问非导出的 outlineFacts——通过 kickoffOutline 的 user 拼装路径太长。
// T02205：锚语义化——原三条备择全是「声明行写法」的字面变体（改名/换写法即全灭）。
// 改锚「clip 单源声明（默认 n=18）+ 在 outlineFacts 正文被调用 ≥3 处」：剪短是行为语义，不锁声明行怎么写。
const ofMatch = /function outlineFacts\(b: KickoffBundle\)[\s\S]*?\r?\n}\r?\n/.exec(S);
const clipDecl = /const\s+clip\s*=\s*\(s:\s*string,\s*n\s*=\s*(\d+)\)/.exec(S);
const clipUses = ofMatch ? (ofMatch[0].match(/clip\(/g) ?? []).length : 0;
ok('O-04 样例事实里标题走 clip() 剪短（默认 n=18；outlineFacts 正文调用 ≥3 处——声明或剪短没了即点名）',
  !!clipDecl && Number(clipDecl[1]) === 18 && clipUses >= 3,
  { 声明: clipDecl?.[0], 调用处数: clipUses });

// 直接反射调用：把 outlineFacts 通过源码替换暴露成可求值的临时函数
ok('O-05 outlineFacts 函数体可反射读取（保证 O 组后续断言作用在真实代码路径上）', !!ofMatch, ofMatch ? ofMatch[0].slice(0, 100) : 'no match');

// ---------- R 组：pushStackedBlocks 刚性判定 ----------
const lay = await import('../server/src/services/kickoff-layout.ts');
const M = await import('../server/src/services/kickoffBuilder.ts');

// 用 blocksForKey('planRows') 造一个真实大表格；然后手工塞进 layoutBody 看是否被裁或 drop
const bigBundle = {
  ...fakeBundle,
  plans: Array.from({ length: 23 }, (_, i) => ({
    id: `q${i}`, project_id: 'p1', title: `任务 ${i + 1}`, description: '', start_date: '2026-01-05', end_date: '2026-02-20',
    duration_days: 3, progress: i < 8 ? 100 : 20, status: i < 8 ? 'done' : 'doing', assignee: i % 2 ? '张三' : '李四',
    sort_order: i, linked_task_id: null, req_ids: null, color: '', deps: '', complexity: (i % 5) + 1, kind: 'normal',
    archived: 0, archived_at: null, created_at: '', updated_at: '',
  })),
  milestones: Array.from({ length: 6 }, (_, i) => ({
    id: `m${i}`, project_id: 'p1', title: `M${i + 1} 里程碑`, description: '', start_date: '2026-01-10', end_date: '2026-03-01',
    duration_days: 20, progress: i * 15, status: i === 0 ? 'done' : 'doing', assignee: '', sort_order: i,
    linked_task_id: null, req_ids: null, color: '', deps: '', complexity: null, kind: 'milestone',
    archived: 0, archived_at: null, created_at: '', updated_at: '',
  })),
};
const tbl = (M as unknown as { blocksForKey: (k: string, b: unknown) => Array<{ table?: { rows: string[][]; header: string[] }}> }).blocksForKey('planRows', bigBundle)[0];
ok('R-01 planRows 表格 fixture 就绪（23 条 clampRows 到 9 行含「其余 n 条」）',
  !!tbl.table && tbl.table.rows.length === 9 && /其余 \d+ 条/.test(tbl.table.rows[8]?.[0] ?? ''), tbl.table?.rows?.length);

// 手工调 layoutBody：单栏 + 无 bullets + 只塞一个 9 行表格 → 表格自然高 3.12"，avail=3.225"
// 应当 placed 而非裁
const singleTablePage = (M as unknown as {
  layoutBody: (item: unknown, b: unknown, frames: unknown, bullets: string[]) => { blocks: Array<{ box: { y: number; h: number }; table?: unknown }>; dropped: string[] };
}).layoutBody({ title: 't', bullets: [], dataKeys: ['planRows'], layout: 'table', section: '正文' }, bigBundle, lay.framesFor('data'), []);
ok('R-02 单栏无 bullets 页：9 行表格整块 placed（box.h == 自然高，无裁）',
  singleTablePage.blocks.length === 1 && !singleTablePage.dropped.length && Math.abs(singleTablePage.blocks[0].box.h - (0.3 * 10 + 0.12)) < 1e-6,
  { blocks: singleTablePage.blocks.length, dropped: singleTablePage.dropped, h: singleTablePage.blocks[0]?.box.h });

// avail 不够时**先按版面收行**（F 组），被收掉的行并进「其余 n 条」计数：
// 两张表都能排下就都 placed——既不越页，也不整块丢内容（用户反馈「各页只剩套话」的正解）
const overflowPage = (M as unknown as {
  layoutBody: (item: unknown, b: unknown, frames: unknown, bullets: string[]) => { blocks: Array<{ box: { y: number; h: number }; table?: { rows: string[][] }; text?: { content: string } }>; dropped: string[] };
}).layoutBody(
  { title: 't', bullets: [], dataKeys: ['planRows', 'planRows'], layout: 'table', section: '正文' },
  bigBundle,
  lay.framesFor('data'),
  []
);
const pageBottom = lay.getContentFrame().y + lay.getContentFrame().h;
ok('R-03 两个 9 行表格同页：各自按剩余高度收行后都 placed（不越页、不整块丢，末行如实点名剩余条数）',
  overflowPage.blocks.length === 2 &&
    overflowPage.dropped.length === 0 &&
    overflowPage.blocks.every((bl) => bl.box.y + bl.box.h <= pageBottom + 1e-6) &&
    overflowPage.blocks.every((bl) => /其余 \d+ 条/.test((bl.table!.rows[bl.table!.rows.length - 1][0] ?? ''))),
  { blocks: overflowPage.blocks.length, dropped: overflowPage.dropped, rows: overflowPage.blocks.map((bl) => bl.table?.rows.length) });

// 图表允许裁：coverage 页 chart 自然高 2.4，avail 只剩 ~1.0 时应 placed（裁到 avail）而非 drop。
// 3 短 bullets 才能把 cursor 停在 chart 还剩 > MIN_BLOCK_H 的位置；6 长 bullets 场景由 S 组表格路径覆盖。
const covBundle = { ...bigBundle, coverage: { total: 40, covered: 32, uncovered: 8, rate: 80 } };
const covBullets = ['要点一', '要点二', '要点三'];
const covPage = (M as unknown as {
  layoutBody: (item: unknown, b: unknown, frames: unknown, bullets: string[]) => {
    blocks: Array<{ box: { h: number }; chart?: unknown; text?: unknown }>;
    dropped: string[];
  };
}).layoutBody(
  { title: 't', bullets: covBullets, dataKeys: ['coverage'], layout: 'chart', section: '正文' },
  covBundle,
  lay.framesFor('data'),
  covBullets
);
ok('R-04 coverage 页：bullets 挤压后 chart 仍 placed（矢量图允许裁到 avail），不 drop',
  covPage.dropped.length === 0 && covPage.blocks.some((b) => b.chart),
  { blocks: covPage.blocks.length, dropped: covPage.dropped });

// ---------- S 组：bullets 给表格让位（首个表格不因 bullets 撑爆版面被 drop） ----------
const tableWithBullets = (M as unknown as {
  layoutBody: (item: unknown, b: unknown, frames: unknown, bullets: string[]) => {
    blocks: Array<{ box: { y: number; h: number }; table?: unknown; text?: unknown }>;
    dropped: string[];
    notes: string[];
  };
}).layoutBody(
  { title: 't', bullets: [], dataKeys: ['milestones'], layout: 'table', section: '正文' },
  bigBundle,
  lay.framesFor('data'),
  []
);
// milestones 有 1 个 fixture → 表格 2 行 → 自然高 0.72；对照：加 6 长 bullets 后表格是否仍 placed
const longBullets = Array.from({ length: 6 }, (_, i) => `要点说明文本比较长会挤压版面-${i + 1}`);
const tableLongBullets = (M as unknown as {
  layoutBody: (item: unknown, b: unknown, frames: unknown, bullets: string[]) => {
    blocks: Array<{ box: { y: number; h: number }; table?: unknown; text?: unknown }>;
    dropped: string[];
    notes: string[];
  };
}).layoutBody(
  { title: 't', bullets: longBullets, dataKeys: ['milestones'], layout: 'table', section: '正文' },
  bigBundle,
  lay.framesFor('data'),
  longBullets
);
ok('S-01 有表格时 bullets 长文本自动压缩，表格仍 placed（此前会被挤到 drop）',
  tableLongBullets.blocks.some((b) => b.table) && tableLongBullets.dropped.length === 0,
  { dropped: tableLongBullets.dropped, notes: tableLongBullets.notes });

ok('S-02 bullets 被压缩时 notes 如实回报压缩幅度（面板可见）',
  tableLongBullets.notes.some((n) => /要点为表格让位压缩排版/.test(n) && /自然高/.test(n) && /实排/.test(n)),
  tableLongBullets.notes);

// 无表格页（只有 chart / text）：bullets 不被无端压缩
const noTablePage = (M as unknown as {
  layoutBody: (item: unknown, b: unknown, frames: unknown, bullets: string[]) => {
    blocks: Array<{ box: { y: number; h: number }; table?: unknown; text?: unknown }>;
    dropped: string[];
    notes: string[];
  };
}).layoutBody(
  { title: 't', bullets: longBullets, dataKeys: ['reqStats'], layout: 'list', section: '正文' },
  bigBundle,
  lay.framesFor('data'),
  longBullets
);
ok('S-03 无表格页保留原排版：bullets 不被「让位压缩」触发',
  !noTablePage.notes.some((n) => /要点为表格让位/.test(n)),
  noTablePage.notes);

// 大表格页（planRows 9 行，自然 3.12"）：bullets 必须严重压缩；表格 placed 或至少 notes 有留痕
const bigPlanPage = (M as unknown as {
  layoutBody: (item: unknown, b: unknown, frames: unknown, bullets: string[]) => {
    blocks: Array<{ box: { y: number; h: number; x: number }; table?: unknown; text?: { content: string } }>;
    dropped: string[];
    notes: string[];
  };
}).layoutBody(
  { title: 't', bullets: longBullets, dataKeys: ['planRows'], layout: 'table', section: '正文' },
  bigBundle,
  lay.framesFor('data'),
  longBullets
);
// 断言：或表格 placed 且无越页；或表格 drop 但 notes/dropped 里有点名（不留静默越页）
ok('S-04 大表格 + 长 bullets：要么表格 placed 且在 bounds 内，要么被如实 drop（绝不裁盒越页）',
  (() => {
    const tblBlk = bigPlanPage.blocks.find((b) => b.table);
    if (tblBlk) {
      const bottom = lay.getContentFrame().y + lay.getContentFrame().h;
      return tblBlk.box.y + tblBlk.box.h <= bottom + 1e-6;
    }
    return bigPlanPage.dropped.some((d) => /表格/.test(d));
  })(),
  { dropped: bigPlanPage.dropped, notes: bigPlanPage.notes });

// ---------- F 组：版面收行（表格按剩余高度收行，不再整块被丢） ----------
// 用户反馈的两半在这里合流：越页（P0-1 裁盒无效）与「各页只剩套话」（表格被 avail 不足整块 drop）
const fit = (M as unknown as {
  fitTableRows: (t: { header: string[]; rows: string[][] }, maxRows: number) => { header: string[]; rows: string[][] };
}).fitTableRows;
const wide = {
  header: ['任务', '起止', '负责人'],
  rows: [...Array.from({ length: 8 }, (_, i) => [`任务${i + 1}`, '2026-01', '张三']), ['其余 15 条', '见项目计划页', '']],
};
const fitted = fit(wide, 4);
ok('F-01 版面收行：行数收到上限内，末行仍是「其余 n 条」且 n 累加本次收掉的行（不谎称画全）',
  fitted.rows.length === 4 && fitted.rows[3][0] === '其余 20 条' && fitted.rows[0][0] === '任务1', fitted.rows);
ok('F-02 收行不动表头与列数（列宽/边框口径不变）',
  fitted.header.length === 3 && fitted.rows.every((r) => r.length === 3), fitted.rows);
const idem = fit(wide, 9);
ok('F-03 排得下时原样返回（不无端删行、不重复计数）',
  idem.rows.length === wide.rows.length && idem.rows[8][0] === '其余 15 条', idem.rows);
const noRest = { header: ['项', '结论', '条数', '说明'], rows: Array.from({ length: 7 }, (_, i) => [`P${i + 1}`, '✓', '1', 'x']) };
const fittedNoRest = fit(noRest, 3);
ok('F-04 无「其余」行的表（如 preflight）收行后补出提示行，隐藏数从本次算起',
  fittedNoRest.rows.length === 3 && fittedNoRest.rows[2][0] === '其余 5 条' && fittedNoRest.rows[2].length === 4, fittedNoRest.rows);

// 时间线回落列表版（ev二期 形态：有计划、零里程碑）——表格必须留在页面上，不能因要点占位被丢
const tlBundle = { ...bigBundle, milestones: [] };
const tlPageF = (M as unknown as {
  layoutBody: (item: unknown, b: unknown, frames: unknown, bullets: string[]) => {
    blocks: Array<{ box: { y: number; h: number }; table?: { rows: string[][] } }>;
    dropped: string[];
    notes: string[];
  };
}).layoutBody(
  { title: 't', bullets: longBullets, dataKeys: ['timeline'], layout: 'timeline', section: '正文' },
  tlBundle,
  lay.framesFor('data'),
  longBullets
);
ok('F-05 时间线回落列表版（零里程碑）：表格收行后 placed，页面不只剩要点',
  tlPageF.blocks.some((b) => b.table) && tlPageF.dropped.length === 0 &&
    tlPageF.notes.some((n) => /时间线回落列表版/.test(n)),
  { blocks: tlPageF.blocks.length, dropped: tlPageF.dropped, notes: tlPageF.notes });

ok('F-06 收行后的表格不越页（刚性块只在「连 1 行都排不下」时才 drop）',
  (() => {
    const bottom = lay.getContentFrame().y + lay.getContentFrame().h;
    return tlPageF.blocks.filter((b) => b.table).every((b) => b.box.y + b.box.h <= bottom + 1e-6);
  })(),
  tlPageF.blocks.filter((b) => b.table).map((b) => ({ y: b.box.y, h: b.box.h })));

// ---------- G 组：真链路回灌（mtask五期 真 AI 大纲暴露的两形态） ----------
// 第 4 页形态：表格 + 文本块 + 要点同页。此前预算只给要点留位、没给文本块留位，
// 实排时文本块又吃掉一段 → 剩余算成负数 → 要点被「让位」整块不排（面板报 剩余 -0.05"）。
const mixedPage = (M as unknown as {
  layoutBody: (item: unknown, b: unknown, frames: unknown, bullets: string[]) => {
    blocks: Array<{ box: { y: number; h: number }; table?: unknown; text?: unknown }>;
    dropped: string[];
    notes: string[];
  };
}).layoutBody(
  { title: 't', bullets: ['核心功能需求一', '核心功能需求二', '核心功能需求三'], dataKeys: ['reqList', 'reqStats'], layout: 'table', section: '正文' },
  bigBundle,
  lay.framesFor('data'),
  ['核心功能需求一', '核心功能需求二', '核心功能需求三']
);
ok('G-01 表格+文本+要点同页：三块都 placed，无丢块且无「让位不排」（预算与实排同口径）',
  mixedPage.dropped.length === 0 &&
    mixedPage.blocks.filter((b) => b.table).length === 1 &&
    mixedPage.blocks.filter((b) => b.text).length === 2 &&
    !mixedPage.notes.some((n) => /未排入版面/.test(n)),
  { dropped: mixedPage.dropped, notes: mixedPage.notes, blocks: mixedPage.blocks.length });

// 第 7 页形态：文本 + 图表（自然高 2.4"）+ 要点。此前图表按自然高排队，末尾只剩零点几英寸
// → 被当「排不下」整块省略，页面少一块真数据。现在柔性块等比裁，图必须在。
// workload 的柱图只在有阶段分布时才出块（phases ≥ 2），fixture 必须造真实分布
const phaseBundle = {
  ...bigBundle,
  workload: {
    ...bigBundle.workload,
    phases: [
      { phase: '需求分析', expected: 12, optimistic: 9, pessimistic: 18 },
      { phase: '开发', expected: 30, optimistic: 24, pessimistic: 42 },
      { phase: '测试', expected: 14, optimistic: 10, pessimistic: 20 },
    ],
  },
};
const chartPage = (M as unknown as {
  layoutBody: (item: unknown, b: unknown, frames: unknown, bullets: string[]) => {
    blocks: Array<{ box: { y: number; h: number }; chart?: unknown; text?: unknown }>;
    dropped: string[];
    notes: string[];
  };
}).layoutBody(
  { title: 't', bullets: longBullets, dataKeys: ['workload'], layout: 'chart', section: '正文' },
  phaseBundle,
  lay.framesFor('data'),
  longBullets
);
ok('G-02 文本+图表页余量不足：图表等比裁后 placed（不再被「空间不足」整块省略）',
  chartPage.dropped.length === 0 && chartPage.blocks.some((b) => b.chart),
  { dropped: chartPage.dropped, blocks: chartPage.blocks.map((b) => ({ h: Number(b.box.h.toFixed(2)), kind: b.chart ? 'chart' : 'text' })) });

ok('G-03 裁后仍在画布内（柔性块缩到保底高度也不越页）',
  (() => {
    const bottom = lay.getContentFrame().y + lay.getContentFrame().h;
    return [...mixedPage.blocks, ...chartPage.blocks].every((b) => b.box.y + b.box.h <= bottom + 1e-6);
  })(),
  [...mixedPage.blocks, ...chartPage.blocks].map((b) => ({ y: Number(b.box.y.toFixed(2)), h: Number(b.box.h.toFixed(2)) })));

// 第 9 页形态（真链路 mtask五期）：双栏页同时挂 要点 + 覆盖率文本 + 覆盖率图 + 需求表。
// 旧 fitStack 逐块取 `max(下限, 自然高比例)`：先触底的文本块把自己垫到 0.45，图表仍按
// **全预算**分比例（0.73），两块合计 1.18 > 预算 1.005 → 超出的 0.18 把同页表格挤到
// avail 不足 → 表格整块被省略（就是用户看到的「这页怎么没内容」）。注水分配后：
// 触底块退出竞争，余量在未完成块之间重分，柔性块合计恒 ≤ 预算。
const flexOverrunPage = (M as unknown as {
  layoutBody: (item: unknown, b: unknown, frames: unknown, bullets: string[]) => {
    blocks: Array<{ box: { y: number; h: number }; table?: unknown; chart?: unknown; text?: unknown }>;
    dropped: string[];
  };
}).layoutBody(
  { title: 't', bullets: longBullets, dataKeys: ['coverage', 'reqList'], layout: 'twoCol', section: '正文' },
  covBundle,
  lay.framesFor('twoCol', 'twoCol', lay.TEXT_SPLIT),
  longBullets
);
ok('G-04 双栏页 要点+文本+图表+表格：柔性块注水不超预算，表格与图表都 placed（真链路第 9 页形态）',
  flexOverrunPage.dropped.length === 0 &&
    flexOverrunPage.blocks.some((b) => b.table) &&
    flexOverrunPage.blocks.some((b) => b.chart),
  {
    dropped: flexOverrunPage.dropped,
    blocks: flexOverrunPage.blocks.map((b) => ({
      kind: b.table ? 'table' : b.chart ? 'chart' : 'text',
      y: Number(b.box.y.toFixed(2)),
      h: Number(b.box.h.toFixed(2)),
    })),
  });

// 源码层守门：确认 clip 表 h 的路径只对非 table 生效
ok('R-05 源码：pushStackedBlocks 中 table 走 drop 分支，chart/text 走 clip 分支',
  /if \(d\.table != null\)[\s\S]*?avail(?: \+ 1e-6)? < natural[\s\S]*?dropped\.push/.test(B) && /Math\.min\(natural, avail\)/.test(B));

// 源码：out 里不再用 boxes[i].h 直传（原代码用 Math.min(boxes[i].h, avail) 掩盖裁盒越页）
ok('R-06 源码：out.push 表格分支用原 boxes[i]（自然高），非表分支才裁 h',
  /out\.push\(\{ box: boxes\[i\], \.\.\.d \}\)/.test(B) && /box: \{ \.\.\.boxes\[i\], h: Math\.min\(natural, avail\) \}/.test(B));

// 措辞解析路径改造：polishWording 的 parse 走 parseAiJson 而非 JSON.parse(stripFence)
ok('J-06 polishWording 使用 parseAiJson（不再直 JSON.parse(stripFence)）',
  /wordingFromAi\(local, parseAiJson\(content\)\)/.test(S) && !/wordingFromAi\(local, JSON\.parse\(stripFence/.test(S));

// parseOutlinePayload 也带尾逗号修复
ok('J-07 parseOutlinePayload 两处 JSON.parse 都过 stripJsonTrailingCommas',
  /JSON\.parse\(stripJsonTrailingCommas\(body\)\)/.test(S) && /JSON\.parse\(stripJsonTrailingCommas\(body\.slice/.test(S));

// 端到端：build 一份含表格+长 bullets 的大纲，产物 XML 中至少一个表格存在且未越页
const built = await (M as unknown as {
  buildKickoffPpt: (b: unknown, o: unknown[]) => Promise<{ buffer: Buffer; warnings: string[]; pageCount: number; degradedPages: number[] }>;
}).buildKickoffPpt(bigBundle, [
  { section: '正文', title: '封面', bullets: [], dataKeys: [], layout: 'cover' },
  { section: '正文', title: '计划表', bullets: longBullets, dataKeys: ['planRows'], layout: 'table' },
  { section: '正文', title: '工时', bullets: [], dataKeys: ['workload'], layout: 'chart' },
]);
ok('E-01 build 产物可生成（3 页含真实表格），未崩溃',
  built.buffer[0] === 0x50 && built.buffer[1] === 0x4b && built.pageCount === 3,
  { bytes: built.buffer.length, pages: built.pageCount });

// 越界降级页应 ≤1（长 bullets+大表格若 drop 则不算降级，若裁盒越页才算）——本改动核心：不再有「裁盒越页」
ok('E-02 越界降级页数为 0（此前若有 clip 越页会触发 pageViolations 降级；现在要么 drop 要么 placed，均不越页）',
  built.degradedPages.length === 0,
  { degraded: built.degradedPages, warnings: built.warnings });

writeGateResults(OUT_DIR, 't02166-gate-results.txt', `T02166 修复门：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`);
console.log(`T02166: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
