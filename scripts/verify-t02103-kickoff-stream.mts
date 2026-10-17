/**
 * T02103 门：SSE 流式生成接口（技术方案 §2.3 / PRD FR-1.4 FR-4.8 验收 9）。
 *
 * 断言：
 *   S 组 源码守卫：令牌落盘单源（纠偏 C3）、事件形态与周报逐字同构、res.close 而非 req.close、
 *                  快速失败在 SSE 头之前、并发闸、措辞失败只降级、中止消息单源。
 *   W 组 措辞回锁纯函数 wordingFromAi：条数/数字/「」名称/长度四道钉，source 不经模型。
 *   O 组 入参形状 assertOutlineShape：用户编辑过的大纲逐页点名坏字段，页数只兜失控不套 AI 铁律。
 *   B 组 装配接缝：onPage 逐页回调、预中止不留稿、取消在装配中途真的生效（事件循环确被让出）。
 *   E 组 隔离实例 + 本地 mock AI 走真 SSE：stage 逐页、done 令牌换回可解包 .pptx、
 *      措辞违约仍出稿且如实告警、客户端断开后临时目录零半成品零孤儿令牌（验收 9）。
 *
 * 用法（与 T02095/T02096 同口径，better-sqlite3 需匹配当前 Node ABI）：
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-t02103-kickoff-stream.mts
 * 环境变量：`T02103_PORT`（默认随机 39700+rand300）。
 * 隔离纪律（skill 红线 8）：库副本/端口/临时目录全临时，不写生产库，mock 不消耗真实配额。
 * 结果落 .workbuddy/t02103-gate-results-<运行标识>.txt 与 t02103-stream-<运行标识>.pptx（T02309 旁证同标识）。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { writeGateResults, gateArtifactPath } from './lib/gate-results.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.T02103_PORT ?? 39_700 + Math.floor(Math.random() * 300));
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02103-stream-'));
const BASE = `http://127.0.0.1:${PORT}/api`;
const FIVE_PID = '95f31a46-92f6-4046-8cb6-ee3c4e228a44'; // mtask五期
const OUT_DIR = join(ROOT, '.workbuddy');
const TMP_DIR = join(DATA_DIR, 'tmp');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const S = await import('../server/src/services/kickoffService.ts');
const B = await import('../server/src/services/kickoffBuilder.ts');

const RSRC = readFileSync(join(ROOT, 'server', 'src', 'services', 'ReportService.ts'), 'utf8');
const SSRC = readFileSync(join(ROOT, 'server', 'src', 'services', 'kickoffService.ts'), 'utf8');
const BSRC = readFileSync(join(ROOT, 'server', 'src', 'services', 'kickoffBuilder.ts'), 'utf8');
const ROUTE = readFileSync(join(ROOT, 'server', 'src', 'routes', 'plans.ts'), 'utf8');
// 只截本端点这一段：plans.ts 有 900+ 行别的注册，整文件断言会把别人的写法算到我头上
const routeCut = ROUTE.indexOf("planApi.post('/kickoff-ppt-stream'");
const streamRoute = routeCut < 0 ? '' : ROUTE.slice(routeCut, ROUTE.indexOf('\nplanApi.', routeCut + 10));
const streamSrc = SSRC.slice(SSRC.indexOf('// ---------- 流式生成'));

// =====================================================================
// S 组：源码/契约守卫
// =====================================================================
ok('S-01 令牌落盘收口为 saveReportBuffer 单源（纠偏 C3：令牌形态一分叉，白名单与下载端点就得处处加特例）',
  /export function saveReportBuffer\(buffer: Buffer\): string \{[\s\S]{0,160}randomUUID\(\)[\s\S]{0,120}writeFileSync\(join\(reportTmpDir\(\), token\), buffer\)/.test(RSRC) &&
    (RSRC.match(/writeFileSync\(join\(reportTmpDir\(\), token\), buffer\)/g) ?? []).length === 1,
  (RSRC.match(/writeFileSync\(join\(reportTmpDir\(\), token\), buffer\)/g) ?? []).length);
ok('S-02 周报两条链路都改走单源（不在别处再拼一遍 randomUUID+writeFileSync）',
  (RSRC.match(/const token = saveReportBuffer\(buffer\);/g) ?? []).length === 2);
ok('S-03 kickoffService 不自己碰文件系统落盘（只经 saveReportBuffer）',
  /saveReportBuffer\(assembled\.buffer\)/.test(SSRC) && !/writeFileSync|createWriteStream|\.part/.test(SSRC));
ok('S-04 事件形态与周报逐字同构：stage {msg} / done {token, fileName, pageCount, warnings} / error {error}',
  /send\('stage', \{ msg \}\)/.test(streamRoute) &&
    /send\('done', \{ token: r\.token, fileName: r\.fileName, pageCount: r\.pageCount, warnings: r\.warnings \}\)/.test(streamRoute) &&
    /send\('error', \{ error: /.test(streamRoute));
ok('S-05 断连监听 res 的 close 并 ac.abort()（监听 req 会被 express.json() 提前 close，stage/done 全误丢——T00838 实测坑）',
  /res\.on\('close', \(\) => \{[\s\S]{0,80}closed = true;[\s\S]{0,80}ac\.abort\(\);/.test(streamRoute) && !/req\.on\('close'/.test(streamRoute));
ok('S-06 参数与大纲形状在 SSE 头之前快速失败（前端要拿到结构化 400，不是流里一条 error）',
  streamRoute.indexOf('assertOutlineShape(b.outline)') < streamRoute.indexOf('res.flushHeaders?.()') &&
    /projectId 必填/.test(streamRoute) && /toolId 必填（生成需要模型工具）/.test(streamRoute));
ok('S-07 挂并发闸且 defer（与周报共用闸语义，超限 429 由 T02105 实测）',
  /planApi\.post\('\/kickoff-ppt-stream', exportGate\(REPORT_GATE, undefined, \{ defer: true \}\)/.test(ROUTE));
ok('S-08 中止消息单源（builder 抛出与 service 检查同一句，面板与门禁都认这句）',
  /export const KICKOFF_ABORT_MSG = '[^']*';/.test(SSRC) &&
    (BSRC.match(/throw new Error\(KICKOFF_ABORT_MSG\)/g) ?? []).length >= 2 &&
    SSRC.includes('throw new Error(KICKOFF_ABORT_MSG)'));
ok('S-09 措辞段失败不阻断：try/catch + 未配模型同步抛错同样收口，逐字降级告警在位',
  /KICKOFF_WORDING_FALLBACK_MSG = '风险措辞 AI 失败，已用本地条目'/.test(SSRC) &&
    /\}\s*catch \(e\) \{\s*\/\/ runtimeWithModel/.test(SSRC) &&
    /warnings\.push\(`\$\{KICKOFF_WORDING_FALLBACK_MSG\}（原因：/.test(SSRC));
ok('S-10 溯源 source 一律保留本地值（措辞是话术，出处不是，不经模型）', /source: r\.source,/.test(streamSrc));
ok('S-11 无风险页且无沟通页就不发这次模型调用（不烧没落点的配额）',
  /function needsWording\(/.test(streamSrc) && /跳过措辞润色（不消耗模型配额）/.test(streamSrc));
ok('S-12 service→builder 用动态 import（builder 静态引用本模块常量，双向静态 import 成环）',
  /const \{ buildKickoffPpt[^}]*\} = await import\('\.\/kickoffBuilder'\)/.test(streamSrc));
ok('S-13 生成链路零落库（A-3 决定日志只进控制台 SSE 流，不建 kickoff_ppt_logs）',
  !/INSERT INTO|UPDATE /.test(streamSrc));
ok('S-14 逐页 stage 文案按 §2.3 口径「页 n/N 已装配：<章节>」（N=渲染页数，T02171 分页后不等于大纲页数）',
  /页 \$\{pageNo\}\/\$\{renderTotal\} 已装配：\$\{item\.section\}/.test(streamSrc) &&
    /renderTotal = expandTimelinePages\(/.test(streamSrc));
ok('S-15 装配循环每页开头检查 signal.aborted 且逐页让出事件循环（否则 stage 憋到最后、取消形同虚设）',
  /if \(opts\.signal\?\.aborted\) throw new Error\(KICKOFF_ABORT_MSG\)/.test(BSRC) &&
    /await yieldToLoop\(\);/.test(BSRC) && /setImmediate\(resolve\)/.test(BSRC));

// =====================================================================
// W 组：wordingFromAi 措辞回锁（纯函数）
// =====================================================================
const LOCAL_RISKS = [
  { item: '计划「数据面联调」当前为阻塞态', impact: '该计划及其后继无法按期开工', mitigation: '会上明确阻塞责任方与解除时限', source: 'plan_tasks.status=blocked' },
  { item: '14 条需求未关联任何计划', impact: '这部分范围没有排期承载', mitigation: '逐条确认纳入本期或列入范围外', source: 'prd_requirements.linkedPlans' },
];
const LOCAL_COMMS = ['里程碑节点后一次周会', '变更走需求跟踪矩阵登记'];
const local = { risks: LOCAL_RISKS, comms: LOCAL_COMMS };
const good = {
  risks: [
    { item: '「数据面联调」处于阻塞态，卡住后续', impact: '后继计划无法按期开工', mitigation: '会上定阻塞责任方与解除时限' },
    { item: '14 条需求还没挂到计划上', impact: '这部分范围无人承载，易漏交付', mitigation: '会上逐条定纳入本期或列入范围外' },
  ],
  comms: ['周会跟里程碑节点走', '变更先登记进需求跟踪矩阵'],
};
const w1 = S.wordingFromAi(local, good);
ok('W-01 合规改写通过：三条措辞落到页面文案', w1.risks[1].item.includes('14 条需求') && w1.comms[0] === '周会跟里程碑节点走');
ok('W-02 source 保持本地原值（模型没机会改溯源）', w1.risks.every((r, i) => r.source === LOCAL_RISKS[i].source));
ok('W-03 增删条目拒收：风险条数 1≠2 点名「不得增删」',
  /风险条目数 1 与系统枚举的 2 不一致/.test((() => { try { S.wordingFromAi(local, { ...good, risks: [good.risks[0]] }); return ''; } catch (e) { return String(e); } })()));
ok('W-04 沟通口径条数同样钉死',
  /沟通口径条数 3 与系统给出的 2 不一致/.test((() => { try { S.wordingFromAi(local, { ...good, comms: ['a', 'b', 'c'] }); return ''; } catch (e) { return String(e); } })()));
const expectErr = (label: string, payload: unknown, re: RegExp) => {
  try {
    S.wordingFromAi(local, payload);
    ok(label, false, '未抛错');
  } catch (e) {
    ok(label, re.test(String(e)), String(e));
  }
};
expectErr('W-05 数字幻觉拒收：凭空多出的 999 条', { ...good, comms: ['999 条变更每周复盘', good.comms[1]] }, /没有的数字「999」/);
expectErr('W-06 百分比幻觉同样拒收', { ...good, comms: ['覆盖率 80% 每周复盘', good.comms[1]] }, /没有的数字「80」/);
expectErr('W-07 名称幻觉拒收：「」里出现输入中没有的计划名',
  { ...good, risks: [{ ...good.risks[0], item: '计划「幽灵模块」阻塞' }, good.risks[1]] }, /没有的名称/);
expectErr('W-08 超长拒收：item 超 60 字（页面上会挤成三行）',
  { ...good, risks: [{ item: '长'.repeat(61), impact: good.risks[0].impact, mitigation: good.risks[0].mitigation }, good.risks[1]] }, /item 超 60 字/);
expectErr('W-09 空字段拒收：不把「空措辞」当合法改写',
  { ...good, risks: [{ item: '  ', impact: good.risks[0].impact, mitigation: good.risks[0].mitigation }, good.risks[1]] }, /item 为空/);
expectErr('W-10 缺数组拒收：本轮要 2 条风险却没给 risks', { comms: good.comms }, /缺 risks 数组/);
const w2 = S.wordingFromAi({ risks: LOCAL_RISKS, comms: [] }, { risks: good.risks });
ok('W-11 未索要 comms 时缺键不算违约（回空数组，别把可用改写打成降级）', w2.comms.length === 0);
expectErr('W-12 索要了 comms 却缺键 → 抛错', { risks: good.risks }, /缺 comms 数组/);
ok('W-13 两份清单都空时只回空对象（不因此放弃整份稿）',
  S.wordingFromAi({ risks: [], comms: [] }, {}).risks.length === 0);

// =====================================================================
// O 组：assertOutlineShape 入参形状
// =====================================================================
const page = (i: number, over: Record<string, unknown> = {}) => ({
  section: '项目计划', title: `启动会页 ${i}`, bullets: ['范围与交付物'], dataKeys: ['preflight'], layout: 'table', ...over,
});
const shapeErr = (label: string, raw: unknown, re: RegExp, withPage = true) => {
  try {
    S.assertOutlineShape(raw);
    ok(label, false, '未抛错');
  } catch (e) {
    const msg = String(e);
    ok(label, re.test(msg), msg);
    if (withPage) ok(`${label}——逐页点名（面板才知道去改哪一页）`, /第 \d+ 页/.test(msg), msg);
  }
};
ok('O-01 合规大纲原样收（section/bullets/dataKeys/layout 齐）',
  S.assertOutlineShape([page(1), page(2)]).length === 2);
shapeErr('O-02 空数组拒收（面板没确认就别开工）', [], /非空数组/, false);
shapeErr('O-03 非数组拒收', { outline: [] }, /非空数组/, false);
shapeErr('O-04 缺标题逐页点名', [page(1), page(2, { title: '  ' })], /第 2 页缺标题/);
shapeErr('O-05 版式不在枚举 → 拒收（不能让 builder 拿到未知 layout 猜一套）', [page(1, { layout: 'gantt' })], /版式「gantt」不在枚举/);
shapeErr('O-06 未知 dataKey → 拒收（拼错键会静默少一整块内容）', [page(1, { dataKeys: ['reqlists'] })], /未知数据键「reqlists」/);
shapeErr('O-07 缺 dataKeys 数组 → 拒收', [page(1, { dataKeys: undefined })], /缺 dataKeys 数组/);
shapeErr('O-08 bullet 混进非字符串 → 拒收', [page(1, { bullets: [3] })], /第 1 页第 2? 条要点不是字符串|不是字符串/);
ok('O-09 section 缺失补「正文」（§3.2 口径），空 bullet 丢弃',
  (() => {
    const r = S.assertOutlineShape([page(1, { section: '  ', bullets: ['甲', '  ', '乙'] })]);
    return r[0].section === '正文' && r[0].bullets.join() === '甲,乙';
  })());
shapeErr('O-10 页数失控（>40）拒收，但 9 页这种用户手删不拦——12~18 是 AI 编排铁律不是装配铁律',
  Array.from({ length: 41 }, (_, i) => page(i + 1)), /超出上限 40 页/, false);
ok('O-11 用户删到 9 页仍能装配（不把大纲段规则二次套上）', S.assertOutlineShape(Array.from({ length: 9 }, (_, i) => page(i + 1))).length === 9);
ok('O-12 下载名按 §2.4：项目启动会-<项目名>-<YYYYMMDD>.pptx',
  S.kickoffFileName('mtask五期', '2026-10-13') === '项目启动会-mtask五期-20261013.pptx');

// =====================================================================
// B 组：装配接缝（夹具内构造，不连库不起服务）
// =====================================================================
const DAY = 86400_000;
const T0 = Date.UTC(2026, 0, 5);
const iso = (off: number) => new Date(T0 + off * DAY).toISOString().slice(0, 10);
const planRow = (i: number) => ({
  id: `q${i}`, project_id: 'p1', title: `任务 ${i + 1}`, description: '', start_date: iso(i * 3), end_date: iso(i * 3 + 6),
  duration_days: 5, progress: i < 8 ? 100 : 20, status: i < 8 ? 'done' : 'doing', assignee: '张三', sort_order: i,
  linked_task_id: null, req_ids: null, color: '', deps: '', complexity: (i % 5) + 1, kind: 'normal', archived: 0,
  archived_at: null, created_at: '', updated_at: '',
});
const fixtureBundle = {
  project: { id: 'p1', name: 'mtask五期', workspacePath: ROOT },
  prdDocs: [{ id: 'd1', filename: 'PRD-项目启动会PPT生成.md', updatedAt: '2026-10-12', contentChars: 1200 }],
  prdDoc: { id: 'd1', filename: 'PRD-项目启动会PPT生成.md', updatedAt: '2026-10-12', contentMd: '# 背景\n口径来源说明。' },
  prdExcerpt: '# 背景\n口径来源说明。',
  prdTruncated: false,
  requirements: Array.from({ length: 14 }, (_, i) => ({
    id: `r${i}`, project_id: 'p1', req_no: `R${i + 1}`, title: `需求 ${i + 1}`, content: null, source_ref: null,
    priority: 'normal', status: 'doing', sort_order: i, created_at: null, updated_at: null, prd_id: 'd1',
    linkedPlans: [{ id: 'x', title: '计划', status: 'doing' }], linkedTasks: [], prdDoc: null,
  })),
  plans: Array.from({ length: 23 }, (_, i) => planRow(i)),
  milestones: Array.from({ length: 6 }, (_, i) => ({ ...planRow(100 + i), id: `m${i}`, title: `M${i + 1} 里程碑`, kind: 'milestone', start_date: iso(i * 12), end_date: iso(i * 12 + 2) })),
  coverage: { total: 40, covered: 32, uncovered: 8, rate: 80 },
  assignees: [{ name: '张三', planCount: 23 }],
  risks: LOCAL_RISKS,
  workload: {
    source: 'estimate', manDays: { expected: 96, optimistic: 78, pessimistic: 132 }, manMonth: 4.6,
    quote: { p50ManDays: 96, p84ManDays: 118 }, phases: [{ phase: '开发', expected: 60, rowCount: 12 }],
    complexity: [{ level: '3', count: 5 }], counted: 23, manDaysPerManMonth: 20.83, noData: false, reviewTrace: null,
    footer: '工作量来源：估算引擎（P50 96 人天 / P84 118 人天）',
  },
  preflight: {
    projectId: 'p1', projectName: 'mtask五期', blocked: false, missingHard: [], workloadSource: 'estimate',
    items: (['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'] as const).map((key, i) => ({
      key, label: `项${key}`, count: [1, 14, 23, 6, 40, 23, 1][i], status: (i === 4 ? 'warn' : 'ok') as 'ok' | 'warn' | 'fail',
      note: '示例说明', deepLink: 'plan', hard: i < 3,
    })),
  },
  workspaceNote: '工作空间可访问',
  dataAsOf: '2026-10-13',
} as never;

const outlinePages = (n: number) =>
  S.assertOutlineShape(
    Array.from({ length: n }, (_, i) => ({
      section: i === 0 ? '封面' : i === 2 ? '项目风险' : i === 3 ? '沟通管理' : '项目计划',
      title: `启动会页 ${i + 1}`,
      bullets: ['范围与交付物', '责任分工'],
      dataKeys: i === 2 ? ['risks'] : ['planRows'],
      layout: i === 0 ? 'cover' : 'table',
    })),
  );

{
  const seen: Array<{ n: number; section: string }> = [];
  const built = await B.buildKickoffPpt(fixtureBundle, outlinePages(5), {
    onPage: (n, item) => seen.push({ n, section: item.section }),
  });
  ok('B-01 onPage 逐页回调：页码连续 1..N 且带章节名（stage 文案的原料）',
    seen.map((s) => s.n).join() === '1,2,3,4,5' && seen[2].section === '项目风险' && seen[3].section === '沟通管理');
  ok('B-01b 不传 opts 与 T02099 行为一致（pageCount/warnings 齐，向后兼容既有门禁）',
    built.pageCount === 5 && Array.isArray(built.warnings) && built.buffer.length > 10_000);

  const ac1 = new AbortController();
  ac1.abort();
  let msg1 = '';
  const r1 = await B.buildKickoffPpt(fixtureBundle, outlinePages(4), { signal: ac1.signal }).catch((e: unknown) => {
    msg1 = e instanceof Error ? e.message : String(e);
    return null;
  });
  ok('B-02 预中止信号 → 抛中止消息且不产出 buffer（不返半成品）', r1 === null && msg1 === S.KICKOFF_ABORT_MSG, msg1);

  const ac2 = new AbortController();
  let callbackCount = 0;
  const err2 = await B.buildKickoffPpt(fixtureBundle, outlinePages(8), {
    signal: ac2.signal,
    onPage: () => {
      callbackCount += 1;
      if (callbackCount === 2) ac2.abort();
    },
  }).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
  ok('B-03 画到第 2 页时被取消 → 后续页不再画（callbackCount 停在 2，不是 8）',
    err2 === S.KICKOFF_ABORT_MSG && callbackCount === 2, { err2, callbackCount });

  const ac3 = new AbortController();
  const p3 = B.buildKickoffPpt(fixtureBundle, outlinePages(8), { signal: ac3.signal });
  setTimeout(() => ac3.abort(), 0);
  const err3 = await p3.then(() => 'RESOLVED').catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
  ok('B-04 取消在装配中途真的生效（外部 timer 能在两页之间插进去）——同步死循环里这条不可能成立',
    err3 === S.KICKOFF_ABORT_MSG, err3);

  mkdirSync(TMP_DIR, { recursive: true });
  const before = readdirSync(TMP_DIR);
  const built13 = await B.buildKickoffPpt(fixtureBundle, outlinePages(6));
  writeFileSync(gateArtifactPath(OUT_DIR, 't02103-builder.pptx'), built13.buffer);
  ok('B-05 builder 层零落盘（只回 Buffer，令牌落盘只在 saveReportBuffer 一处）',
    readdirSync(TMP_DIR).length === before.length, { before, after: readdirSync(TMP_DIR) });
}

// =====================================================================
// mock OpenAI 兼容服务（本地、零真实配额）
// =====================================================================
type MockMode = 'good' | 'badNum' | 'badCount' | 'boom';
let mockMode: MockMode = 'good';
let mockDelayMs = 0;
const mockRequests: Array<{ system: string; user: string }> = [];
const AI_MARK_IMPACT = '该计划延后会顶到下个里程碑';
const AI_MARK_MITIGATION = '会上定责任方与解除时限';
const AI_MARK_COMM = '周会跟里程碑节点走';
/**
 * item 只保留本地条目里的「计划名」再换说法：计划名是库里原文（pinField 认这条白名单），
 * 直接照抄本地长条目会撞上 60 字上限，反而把「合规改写」这条路测不到。
 */
function rewordItem(localItem: string): string {
  const name = /「([^」]+)」/.exec(localItem)?.[1];
  return name && name.length <= 24 ? `「${name}」这条要会上定责任方` : '这条计划要会上定责任方';
}
function wordingReply(user: string): string {
  const risks = [...user.matchAll(/^\d+\. 风险：(.+)$/gm)].map((m) => ({
    item: rewordItem(m[1].trim()),
    impact: AI_MARK_IMPACT,
    mitigation: AI_MARK_MITIGATION,
  }));
  const commBlock = user.split('【沟通口径')[1] ?? '';
  const comms = [...commBlock.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1].trim());
  // 注入必须「一定违规」而不是「通常违规」：提示词里的本地条目数随库内数据而变（M6 推进后进度落后类
  // 风险归零、只剩 1 条），旧的 `risks.length > 1` 门槛会让 pop 退化成空操作——两轮问答都合规、不降级、
  // 整组静默假绿。风险数组空到无可 pop 时把违规挪到沟通数组，保证注入始终打得到校验。
  if (mockMode === 'badCount') {
    if (risks.length) risks.pop();
    else if (comms.length) comms.pop();
  }
  if (mockMode === 'badNum') {
    if (risks.length) risks[0] = { item: '999 条计划全部阻塞', impact: AI_MARK_IMPACT, mitigation: AI_MARK_MITIGATION };
    else if (comms.length) comms[0] = '999 条计划全部阻塞';
  }
  if (comms.length && mockMode === 'good') comms[0] = AI_MARK_COMM;
  return JSON.stringify({ risks, comms });
}
const mock = createServer((req, res) => {
  let raw = '';
  req.on('data', (c: Buffer) => (raw += c.toString()));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}') as { messages?: Array<{ role: string; content: string }> };
    const user = body.messages?.[1]?.content ?? '';
    mockRequests.push({ system: body.messages?.[0]?.content ?? '', user });
    const reply = () => {
      if (mockMode === 'boom') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock 上游异常' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: wordingReply(user) }, finish_reason: 'stop' }], usage: { total_tokens: 10 } }));
    };
    if (mockDelayMs > 0) setTimeout(reply, mockDelayMs);
    else reply();
  });
});
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
const MOCK_PORT = (mock.address() as { port: number }).port;

// =====================================================================
// E 组：隔离实例（生产库只读副本 → 临时目录）真 SSE
// =====================================================================
const { resolveServerLauncher } = await import('./isolated-server-launcher.mts');
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const prodDb = join(process.env.APPDATA ?? '', 'MTask', 'data', 'mtask.db');
{
  const Database = (await import('better-sqlite3')).default;
  const src = new Database(prodDb, { readonly: true });
  await src.backup(join(DATA_DIR, 'mtask.db'));
  src.close();
}
ok('E-00a 生产库只读副本已生成（不写生产库）', existsSync(join(DATA_DIR, 'mtask.db')));

const child: ChildProcess = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT,
  env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog: string[] = [];
child.stdout?.on('data', (b: Buffer) => serverLog.push(b.toString()));
child.stderr?.on('data', (b: Buffer) => serverLog.push(b.toString()));

async function waitUp(ms = 90_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok && (await res.json().catch(() => null))?.service === 'mtask-server') return true;
    } catch { /* 还没起来 */ }
    await sleep(400);
  }
  return false;
}
async function call(method: string, path: string, json?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  // 先取文本再解析：res 一旦回传给调用方就再没读过 body，避免 "Body has already been read"
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON（如二进制下载） */ }
  return { status: res.status, body, text };
}

async function postRaw(path: string, json: unknown) {
  return fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(json),
  });
}

interface SseResult {
  status: number;
  ctype: string;
  json: any;
  events: Array<{ event: string; data: any }>;
  clientAborted: boolean;
}
/** 走真 SSE：按空行切事件，可指定「收到某事件后由客户端断开」或固定时长后断开（模拟面板点「停止」） */
async function sse(path: string, body: unknown, opts: { abortAfterMs?: number; stopAfter?: string } = {}): Promise<SseResult> {
  const ac = new AbortController();
  const events: Array<{ event: string; data: any }> = [];
  let raw = '';
  let clientAborted = false;
  const kill = () => { clientAborted = true; ac.abort(); };
  const timer = opts.abortAfterMs ? setTimeout(kill, opts.abortAfterMs) : null;
  let status = 0;
  let ctype = '';
  let json: any = null;
  try {
    const res = await fetch(BASE + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal,
    });
    status = res.status;
    ctype = res.headers.get('content-type') ?? '';
    if (!ctype.includes('event-stream')) {
      if (timer) clearTimeout(timer);
      json = await res.json().catch(() => null);
      return { status, ctype, json, events, clientAborted };
    }
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += dec.decode(value, { stream: true });
      let i = raw.indexOf('\n\n');
      while (i >= 0) {
        const chunk = raw.slice(0, i);
        raw = raw.slice(i + 2);
        const event = /^event: (.+)$/m.exec(chunk)?.[1] ?? '';
        const dataStr = /^data: (.*)$/m.exec(chunk)?.[1] ?? '{}';
        try { events.push({ event, data: JSON.parse(dataStr) }); } catch { /* 忽略坏帧 */ }
        if (opts.stopAfter && event === opts.stopAfter) {
          if (timer) clearTimeout(timer);
          kill();
        }
        i = raw.indexOf('\n\n');
      }
    }
  } catch { /* 客户端 abort 会抛 AbortError：预期内 */ }
  if (timer) clearTimeout(timer);
  return { status, ctype, json, events, clientAborted };
}

const outline13 = Array.from({ length: 13 }, (_, i) => ({
  section: i === 0 ? '封面' : i === 2 ? '项目风险' : i === 3 ? '沟通管理' : i === 6 ? '项目计划' : i === 7 ? '工作量评估' : '项目需求',
  title: `启动会页 ${i + 1}`,
  bullets: i === 3 ? ['周会跟里程碑节点开', '变更先登记进需求跟踪矩阵'] : ['范围与交付物', '责任分工'],
  dataKeys: i === 2 ? ['risks'] : i === 6 ? ['timeline', 'planRows'] : i === 7 ? ['workload'] : ['reqStats'],
  layout: i === 0 ? 'cover' : i === 6 ? 'timeline' : i === 7 ? 'chart' : 'table',
}));

if (!(await waitUp())) {
  ok('E-00 隔离实例启动', false, serverLog.join('').slice(-600));
} else {
  ok('E-00 隔离实例启动', true);
  const toolMock = await call('POST', '/aitools', { name: 't02103-mock', type: 'openai-compatible', endpoint: `http://127.0.0.1:${MOCK_PORT}`, apiKey: 'mock-key', model: 'mock-wording', timeoutMs: 20000 });
  const toolNoModel = await call('POST', '/aitools', { name: 't02103-nomodel', type: 'openai-compatible', endpoint: `http://127.0.0.1:${MOCK_PORT}`, apiKey: 'mock-key', timeoutMs: 20000 });
  const mockId = String(toolMock.body?.id ?? '');
  const noModelId = String(toolNoModel.body?.id ?? '');
  ok('E-00b 测试工具已建（含无 model 的那个）', !!mockId && toolNoModel.status === 201 && !toolNoModel.body?.model);

  const body = (over: Record<string, unknown> = {}) => ({ projectId: FIVE_PID, toolId: mockId, outline: outline13, ...over });
  const planCount0 = ((await call('GET', `/plans?projectId=${FIVE_PID}`)).body as unknown[])?.length ?? -1;

  // E-01 快速失败：不建流
  mockMode = 'good';
  const noPid = await sse('/plans/kickoff-ppt-stream', { toolId: mockId, outline: outline13 });
  const noTool = await sse('/plans/kickoff-ppt-stream', { projectId: FIVE_PID, outline: outline13 });
  const badShape = await sse('/plans/kickoff-ppt-stream', body({ outline: [{ section: '项目风险', bullets: [], dataKeys: ['risks'], layout: 'table' }] }));
  ok('E-01 缺 projectId / 缺 toolId / 大纲坏形状 → 结构化 400 且不是 event-stream（零 mock 请求、零装配）',
    noPid.status === 400 && !noPid.ctype.includes('event-stream') && noTool.status === 400 &&
      badShape.status === 400 && /第 1 页缺标题/.test(String(badShape.json?.error)) && mockRequests.length === 0,
    { noPid: noPid.status, noTool: noTool.status, badShape: badShape.json, asks: mockRequests.length });

  // E-02 正常链路：逐页 stage + done
  mockMode = 'good';
  mockRequests.length = 0;
  const good1 = await sse('/plans/kickoff-ppt-stream', body());
  const stages = good1.events.filter((e) => e.event === 'stage');
  const dones = good1.events.filter((e) => e.event === 'done');
  // T02171：大纲 13 页是**下界**——计划超行数的时间线页会展开续页，产物页数由装配层报，
  // 判据改成「stage 页序 / done.pageCount / 解包页数三者同源」，比钉死 13 更严。
  const reportPages = Number(dones[0]?.data?.pageCount ?? 0);
  const pageStages = stages.filter((e) => /页 \d+\/\d+ 已装配：/.test(String(e.data.msg)));
  ok('E-02a done 事件恰好 1 条且无 error 事件', dones.length === 1 && !good1.events.some((e) => e.event === 'error'),
    good1.events.map((e) => e.event).join(','));
  ok('E-02b done 负载字段齐（token 是 UUID、fileName 合规、pageCount ≥ 大纲 13 页、warnings 是数组）',
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(dones[0]?.data?.token)) &&
      /^项目启动会-.+-20\d{6}\.pptx$/.test(String(dones[0]?.data?.fileName)) && reportPages >= 13 &&
      Array.isArray(dones[0]?.data?.warnings), dones[0]?.data);
  ok('E-02c 逐页 stage 按页序一条不拆，且分母与 done.pageCount 同源（分页后页码不错位）',
    pageStages.length === reportPages && pageStages.every((e, i) => String(e.data.msg).startsWith(`页 ${i + 1}/${reportPages} 已装配：`)),
    { stages: stages.map((e) => e.data.msg).slice(0, 6), reportPages });
  ok('E-02d 措辞段发过一次 askJson 且提示词写明「数字/名称/条数」三道禁令',
    mockRequests.length === 1 && /严禁新增输入里没有的数字/.test(mockRequests[0].system) &&
      /「」内的计划名/.test(mockRequests[0].system) && /条目数量与顺序必须与输入完全一致/.test(mockRequests[0].system),
    mockRequests.length);
  ok('E-02e 风险清单原文进提示词（AI 只能在这四条本地条目上改措辞，看不到就别编）',
    /风险条目（系统按本地规则枚举/.test(mockRequests[0]?.user ?? '') && /出处：plan_tasks\./.test(mockRequests[0]?.user ?? ''),
    (mockRequests[0]?.user ?? '').slice(0, 200));

  // E-03 令牌换回真产物（下载即删，命名走 §2.4）
  const token1 = String(dones[0]?.data?.token);
  const fileName1 = String(dones[0]?.data?.fileName);
  const dlRes = await postRaw('/report/ai-download', { token: token1, filename: fileName1 });
  const buf = Buffer.from(await dlRes.arrayBuffer());
  let slides: string[] = [];
  if (buf.length > 1000) {
    writeFileSync(gateArtifactPath(OUT_DIR, 't02103-stream.pptx'), buf);
    const zip = await JSZip.loadAsync(buf);
    slides = await Promise.all(
      Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
        .sort((a, b) => Number(/(\d+)\.xml/.exec(a)?.[1]) - Number(/(\d+)\.xml/.exec(b)?.[1]))
        .map((f) => zip.file(f)!.async('string')),
    );
  }
  const allText = slides.join('\n').replace(/<[^>]+>/g, '|');
  ok('E-03a 令牌经 /report/ai-download 换回 .pptx（A-2 零改动：白名单已含 pptx）',
    dlRes.status === 200 && buf.length > 20_000 && buf.subarray(0, 2).toString() === 'PK', { status: dlRes.status, bytes: buf.length });
  ok('E-03b 产物页数 = done.pageCount（原生页，非贴图；T02171 后含时间线续页）',
    slides.length === Number(dones[0]?.data?.pageCount ?? -1) && slides.length >= 13 && !/id="Picture/.test(allText),
    { slides: slides.length, pageCount: dones[0]?.data?.pageCount });
  ok('E-03c 第 2 段措辞真落到风险页（AI 改的词在页面上，不是只改了内存）',
    allText.includes(AI_MARK_IMPACT) || allText.includes(AI_MARK_MITIGATION), allText.slice(allText.indexOf('风险'), allText.indexOf('风险') + 240));
  ok('E-03d 沟通页 bullets 同样被改写（FR-4.9 协作口径走 AI）', allText.includes(AI_MARK_COMM),
    allText.match(/周会[^\n|]{0,40}/)?.[0]);
  ok('E-03e 下载即删：tmp 目录回到空（不留孤儿令牌文件）', readdirSync(TMP_DIR).length === 0, readdirSync(TMP_DIR));

  // E-04 措辞违约不阻断（验收：任一段失败仍给得出稿子，且如实说明用的是本地条目）
  for (const mode of ['badCount', 'badNum'] as MockMode[]) {
    mockMode = mode;
    mockRequests.length = 0;
    const r = await sse('/plans/kickoff-ppt-stream', body());
    const d = r.events.find((e) => e.event === 'done');
    const warns = (d?.data?.warnings ?? []) as string[];
    ok(`E-04-${mode} 措辞不合约束 → 触发自带重试后整段降级，done 仍成功且 warnings 点名原因`,
      !!d && !r.events.some((e) => e.event === 'error') && mockRequests.length === 2 &&
        warns.some((w) => w.startsWith(S.KICKOFF_WORDING_FALLBACK_MSG)) && /原因：/.test(warns.find((w) => w.startsWith(S.KICKOFF_WORDING_FALLBACK_MSG)) ?? ''),
      { asks: mockRequests.length, warns: warns.slice(0, 3) });
    if (d) {
      const dlt = await postRaw('/report/ai-download', { token: String(d.data.token), filename: String(d.data.fileName) });
      const b2 = Buffer.from(await dlt.arrayBuffer());
      const z2 = await JSZip.loadAsync(b2);
      const t2 = (await Promise.all(Object.keys(z2.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).map((f) => z2.file(f)!.async('string')))).join(' ')
        .replace(/<[^>]+>/g, '|')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      // 逐条比对提示词里枚举的本地原文（库内真值随项目而变，写死断言话术等于猜数据）；
      // 表列宽预算会把单元格截到 22 字（T02099 risksTable 口径），故按「页面应有的形态」比对前缀。
      // 风险与沟通两组都纳入比对：违规注入落在哪组，回落证据就在哪组页面。
      const prompt0 = mockRequests[0]?.user ?? '';
      const localItems = [...prompt0.matchAll(/^\d+\. 风险：(.+)$/gm)].map((m) => m[1].trim());
      const localComms = [...(prompt0.split('【沟通口径')[1] ?? '').matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1].trim());
      const missing = [...localItems, ...localComms].filter((s) => !t2.includes(s.slice(0, 22)));
      ok(`E-04-${mode}-0 提示词确有可注入的本地条目（两组皆空则本组等于空跑，先钉住再说降级）`,
        localItems.length + localComms.length > 0, { risks: localItems.length, comms: localComms.length });
      ok(`E-04-${mode}b 降级页整表回落本地条目（与提示词枚举的库内真值逐条一致，不是空表也不是半路截行）`,
        missing.length === 0, { localCount: localItems.length + localComms.length, missing: missing.slice(0, 2) });
    }
  }

  // E-05 上游 500：askJson 两轮皆败 → 同样只降级
  mockMode = 'boom';
  const boom = await sse('/plans/kickoff-ppt-stream', body());
  ok('E-05 模型上游 500 不阻断生成（done 成功 + 降级 warning）',
    !!boom.events.find((e) => e.event === 'done') &&
      ((boom.events.find((e) => e.event === 'done')?.data?.warnings ?? []) as string[]).some((w) => w.startsWith(S.KICKOFF_WORDING_FALLBACK_MSG)),
    boom.events.map((e) => e.event).join(','));

  // E-06 工具未配 model：同步抛错也被措辞段收口（不因模型配置没得稿子）
  mockMode = 'good';
  mockRequests.length = 0;
  const noModel = await sse('/plans/kickoff-ppt-stream', body({ toolId: noModelId }));
  const noModelDone = noModel.events.find((e) => e.event === 'done');
  ok('E-06 未配 model 的工具 → 仍出稿，warnings 原文透传「所选模型未配置…」且零 mock 请求',
    !!noModelDone && mockRequests.length === 0 &&
      ((noModelDone?.data?.warnings ?? []) as string[]).some((w) => /所选模型未配置/.test(w)),
    { warns: (noModelDone?.data?.warnings ?? []).slice(0, 2), asks: mockRequests.length });

  // E-07 断连无残留（验收 9）：AI 等待期客户端走人
  mkdirSync(TMP_DIR, { recursive: true });
  readdirSync(TMP_DIR).forEach((f) => rmSync(join(TMP_DIR, f), { force: true }));
  mockMode = 'good';
  mockDelayMs = 2500;
  const disc = await sse('/plans/kickoff-ppt-stream', body(), { abortAfterMs: 600 });
  await sleep(3200); // 等模型回来 + 服务端 abort 检查跑完
  mockDelayMs = 0;
  ok('E-07a 客户端断开被识别（未收到 done/error，连接由客户端主动 abort）',
    disc.clientAborted && !disc.events.some((e) => e.event === 'done'), { events: disc.events.map((e) => e.event).join(','), aborted: disc.clientAborted });
  ok('E-07b 断连后 tmp 目录零半成品零孤儿令牌（验收 9；只有一个落盘点才守得住这条）',
    readdirSync(TMP_DIR).length === 0 && !readdirSync(TMP_DIR).some((f) => f.endsWith('.part')), readdirSync(TMP_DIR));

  // E-08 装配中途取消同样零残留（页数多 + 无风险页时没有 AI 等待窗口）
  readdirSync(TMP_DIR).forEach((f) => rmSync(join(TMP_DIR, f), { force: true }));
  mockMode = 'good';
  const mid = await sse('/plans/kickoff-ppt-stream', body({ outline: outline13.map((p, i) => (i === 2 ? { ...p, section: '项目范围', dataKeys: ['reqStats'] } : p)) }), { stopAfter: 'stage' });
  await sleep(800);
  ok('E-08 收到首条 stage 即断开：装配被中止且临时目录仍空',
    mid.clientAborted && readdirSync(TMP_DIR).length === 0, { events: mid.events.length, tmp: readdirSync(TMP_DIR) });

  // E-09 零落库：整条链路只读聚合，不写任何业务表（A-3：日志只进控制台流）
  const planCount1 = ((await call('GET', `/plans?projectId=${FIVE_PID}`)).body as unknown[])?.length ?? -2;
  ok('E-09 生成链路不改计划/需求数据（只读聚合；计划条数与开工前一致）',
    planCount0 > 0 && planCount1 === planCount0, { planCount0, planCount1 });
}

child.kill();
mock.close();
await new Promise<void>((r) => {
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* Windows 上句柄可能未释放 */ }
  r();
});
rmSync(TMP_DIR, { recursive: true, force: true });

lines.push('');
lines.push(`PASS=${pass} FAIL=${fail}`);
mkdirSync(OUT_DIR, { recursive: true });
writeGateResults(OUT_DIR, 't02103-gate-results.txt', lines.join('\n'), { port: PORT, dataDir: DATA_DIR });
console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
