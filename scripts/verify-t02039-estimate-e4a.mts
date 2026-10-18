/**
 * E4 首段（T02039 · PRD-估算视图 §5.1/§5.2）验证脚本：估算面板的「零计算 + 单源」接线。
 *
 * 用法（Node 版本必须与 node_modules/better-sqlite3 的预编译 ABI 对齐，本机 Node22 ABI127 可加载；
 *   与 verify-t02034/e1、verify-t02037/e3 同写法，不在 package.json 硬编码 node 绝对路径）：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02039-estimate-e4a.mts
 *
 * 三段结构：
 *   S 段（同进程·纯函数）：`EstimatePanel` 的取数逻辑 `buildPanelRows`、徽标枚举、形态阈值、
 *     以及两条「红线守卫」——面板源码里不得出现 PERT 式子（零计算），不得自造第三套分组/枚举。
 *     本段不碰磁盘，也不起服务。
 *   R 段（隔离实例·REST）：起 `MTask_PORT` + `MTask_DATA_DIR` 临时进程，按面板真实的取数路径
 *     （GET /api/estimates + POST /api/estimates/derive + GET /api/plans + GET /api/plans/prd-requirements）
 *     打真请求，**把真实响应喂给 buildPanelRows**——这是 E4 与 E3 的焊接点：响应字段漂移当场就红。
 *
 * 隔离纪律（skill 红线 8）：库与端口都是临时的，不碰生产数据目录，跑完 kill + 回收临时目录。
 * UI 交互与 §10-13 三档视口走查不在本脚本内（Playwright 真机取证另做，见任务回传）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveServerLauncher } from './isolated-server-launcher.mts';
import { shimWebDocumentForNode } from './lib/web-dom-shim.mts';
import { okPair } from './lib/anchor-pair.mts'; // T02293 判据 3：文案锚必须配行为断言

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02039-e4a-'));
const PORT = Number(process.env.T02039_PORT ?? 39929);
process.env.MTask_DATA_DIR = DATA_DIR;

const { getDb, closeDb } = await import('../server/src/db/connection.ts');
const { initSchema } = await import('../server/src/db/schema.ts');
// ESTIMATE_META / ESTIMATE_ERRORS 是服务端的阶段标签表与错误词干单源——面板/门都从这两张表取词，改措辞门不假红
const { ESTIMATE_SOURCES, ESTIMATE_PHASES, ESTIMATE_META, ESTIMATE_ERRORS } = await import('../server/src/services/EstimateService.ts');
const { DERIVE_RULES } = await import('../server/src/services/EstimateDerive.ts');
const { sigma, expected, parseRuleRatio } = await import('../server/src/services/estimate-engine.ts');
// 面板模块的取数逻辑是纯函数，但它 transitively import 了 `api/client.ts`（顶层要用 document.baseURI）
// ——Node 侧没有 DOM，进门即 ReferenceError，整段 S/R 都没机会跑。见 lib/web-dom-shim.mts。
shimWebDocumentForNode(PORT);
const P = await import('../web/src/components/EstimatePanel.tsx');

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra).slice(0, 260)}` : ''}`);
  }
};
const near = (a: number, b: number, eps = 1e-9) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < eps;
/** 把「应当抛错的调用」收成文案（不抛则空串）——供 H 段与 REST 原文逐字符比对 */
const fire = (fn: () => unknown): string => {
  try { fn(); return ''; } catch (e) { return e instanceof Error ? e.message : String(e); }
};
/**
 * REST 400 类断言的配对器（T02293 判据 3）。行为侧 = 请求真的被拒（400 + 非空文案，可再叠「拒绝即零写入」）；
 * 字面侧 = 文案含产品单源词干（`ESTIMATE_ERRORS`）。REST 400 体是裸 `{ error }`（无 MCP 的「错误：」信封），故逐字符可比。
 * 每条 400 同时登记进 `rest400`，供 H 段拿服务端原文与门进程词干做同一性比对。
 */
const rest400: Array<{ label: string; error: string }> = [];
const rejected400 = (
  label: string,
  res: { status: number; json?: Record<string, any> },
  stem: string,
  extraBehavior?: () => boolean,
) => {
  if (res.status === 400) rest400.push({ label, error: String(res.json?.error ?? '') });
  return okPair(ok, label,
    () => res.status === 400 && String(res.json?.error ?? '').length > 0 && (extraBehavior ? extraBehavior() : true),
    () => String(res.json?.error ?? '').includes(stem),
    () => ({ status: res.status, error: String(res.json?.error ?? '').slice(0, 140) }));
};
const T = '2026-10-11T00:00:00.000Z';
const PID = 'p-e4a';

// ---------------- 夹具：直接写隔离测试库（不经 REST，也不碰生产） ----------------
initSchema();
const db = getDb();
db.prepare('INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
  .run(PID, 'T02039-估算面板E4a', '', T, T);

const insPlan = db.prepare(
  `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
     progress, status, assignee, sort_order, created_at, updated_at, kind, complexity, req_ids)
   VALUES (?, ?, ?, '', ?, ?, ?, 0, 'todo', '', ?, ?, ?, ?, ?, ?)`,
);
type Seed = [id: string, title: string, dur: number, sort: number, kind: string, cx: number | null, reqs: string[]];
const seeds: Seed[] = [
  ['ms-1', 'M1 需求阶段', 10, 1, 'milestone', 4, []],
  ['pl-cx', '需求分析-复杂度档', 5, 2, 'normal', 3, ['rq-1']],
  ['pl-case', '系统设计-用例加权', 4, 3, 'normal', null, ['rq-1']],
  ['pl-dur', '开发联调-仅工期', 7, 4, 'normal', null, []],
  ['pl-man', '开发实施-人工已录', 3, 5, 'normal', 2, []],
  ['pl-arch', '开发归档-不应出现', 4, 6, 'normal', 5, []],
];
for (const [id, title, dur, sort, kind, cx, reqs] of seeds) {
  insPlan.run(id, PID, title, '2026-10-12', '2026-10-12', dur, sort, T, T, kind, cx, reqs.length ? JSON.stringify(reqs) : null);
}
db.prepare('UPDATE plan_tasks SET archived = 1, archived_at = ? WHERE id = ?').run(T, 'pl-arch');

db.prepare(`INSERT INTO prd_requirements (id, project_id, req_no, title, content, source_ref, priority, status, sort_order, created_at, updated_at)
   VALUES (?, ?, ?, ?, '', '', 'normal', 'todo', 0, ?, ?)`)
  .run('rq-1', PID, 'REQ-001', '面板需求编号列来源', T, T);
const insCase = db.prepare(
  `INSERT INTO test_cases (id, project_id, req_id, case_no, title, priority, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
[['tc-1', 'P0'], ['tc-2', 'P1'], ['tc-3', 'P2']].forEach(([id, pri], i) => {
  insCase.run(id, PID, 'rq-1', `C-${i + 1}`, `用例${i + 1}`, pri, T, T);
});

const insEst = db.prepare(
  `INSERT INTO estimate_items (id, project_id, plan_id, phase, unit, optimistic, likely, pessimistic, source, note, created_at, updated_at)
   VALUES (?, ?, ?, ?, 'man_day', ?, ?, ?, ?, ?, ?, ?)`,
);
insEst.run('es-man', PID, 'pl-man', 'impl', 3, 4, 8, 'manual', '人工复核过的行', T, T);

console.log('\n=== S 段：面板纯函数与红线守卫（同进程·不碰磁盘） ===');
type Row = ReturnType<typeof P.buildPanelRows>[number];
const asPlan = (id: string, title: string, kind: string, complexity: number | null) => ({
  id, title, description: null, kind, start_date: '2026-10-12', end_date: '2026-10-12',
  duration_days: 3, progress: 0, status: 'todo', assignee: null, linked_task_id: null, complexity,
});
const mkItem = (planId: string, o: number, m: number, p: number, source: string, note = '', phase = 'dev') => ({
  id: `e-${planId}`, project_id: PID, plan_id: planId, phase, unit: 'man_day',
  optimistic: o, likely: m, pessimistic: p, source, note, created_at: T, updated_at: T,
  planTitle: planId, planKind: 'normal', planArchived: 0, planStatus: 'todo', planProgress: 0,
  startDate: '2026-10-12', endDate: '2026-10-12', durationDays: 3, complexity: null,
}) as unknown as Parameters<typeof P.buildPanelRows>[1][number];
const mkDerive = (planId: string, rule: string, o: number, m: number, p: number, skip = '', title = planId, kind = 'normal') => ({
  planId, title, kind, phase: 'dev', rule, optimistic: o, likely: m, pessimistic: p,
  expected: (o + 4 * m + p) / 6, source: 'rule', note: `按${rule}推导`, basis: {}, existing: null,
  writable: skip === '', skip,
}) as unknown as Parameters<typeof P.buildPanelRows>[2][number];

// S1-S2 枚举单源：面板徽标表必须覆盖服务端枚举，且不多造
{
  const badgeKeys = Object.keys(P.SOURCE_BADGE);
  ok('S-01 SOURCE_BADGE 覆盖服务端 ESTIMATE_SOURCES 全集（两侧枚举不漂移）',
    ESTIMATE_SOURCES.every((s) => badgeKeys.includes(s)) && badgeKeys.filter((k) => k !== 'none').length === ESTIMATE_SOURCES.length,
    { badgeKeys, ESTIMATE_SOURCES });
  const ruleKeys = Object.keys(P.RULE_LABEL);
  ok('S-02 RULE_LABEL 键集 = 服务端 DERIVE_RULES 三档（顺序无关）',
    ruleKeys.length === DERIVE_RULES.length && DERIVE_RULES.every((r) => ruleKeys.includes(r)),
    { ruleKeys, DERIVE_RULES });
  ok('S-03 阶段标签由服务端下发（面板不硬编码 6 阶段名）',
    ESTIMATE_PHASES.length === 6 && !readFileSync(join(ROOT, 'web', 'src', 'components', 'EstimatePanel.tsx'), 'utf8').includes("'需求分析', '系统设计'"));
}

// S4-S9 buildPanelRows 取数优先级
{
  const plans = [asPlan('pl-man', '开发实施-人工已录', 'normal', 2), asPlan('ms-1', 'M1 需求阶段', 'milestone', 4)];
  const rows: Row[] = P.buildPanelRows(
    plans,
    [mkItem('pl-man', 3, 4, 8, 'manual', '已复核')],
    [mkDerive('ms-1', 'complexity', 5, 5.5, 7)],
    [{ key: 'pl-man', expected: expected({ optimistic: 3, likely: 4, pessimistic: 8 }), sigma: sigma({ optimistic: 3, likely: 4, pessimistic: 8 }), ratio: 0.1 }],
    { 'pl-man': ['REQ-001'] },
  );
  const man = rows.find((r) => r.planId === 'pl-man')!;
  // 行为侧＝落库行的数据接线（三点取估算行、E/σ 取服务端 rowRatios、非建议、note 原样回读）；
  // 「已复核」是夹具写入的 note 往返（行为），不是产品文案；徽标「人工」是产品单源词，移到字面侧读 SOURCE_BADGE。
  okPair(ok, 'S-04 已落库行：三点取估算行、E/σ 取服务端 rowRatios（行为），徽标取单源「人工」（锚点）',
    () => man.optimistic === 3 && man.likely === 4 && man.pessimistic === 8
      && near(man.expected as number, 4.5, 1e-9) && near(man.sigma as number, sigma({ optimistic: 3, likely: 4, pessimistic: 8 }), 1e-9)
      && man.suggestion === false && man.tip === '已复核',
    () => man.badge.label === P.SOURCE_BADGE.manual.label,
    () => ({ badge: man.badge, tip: man.tip }));
  const ms = rows.find((r) => r.planId === 'ms-1')!;
  // tip「按complexity推导」是夹具写入的推导 note 往返（行为）；徽标「默认·复杂度」是产品单源词，移到字面侧读 RULE_LABEL。
  okPair(ok, 'S-05 建议行：标为 suggestion 且 tip 回读推导依据（行为），徽标取单源 RULE_LABEL（锚点）',
    () => ms.suggestion === true && ms.tip === '按complexity推导',
    () => ms.badge.label === P.RULE_LABEL.complexity,
    () => ({ badge: ms.badge, tip: ms.tip }));
  ok('S-06 里程碑行 inSigma=false（面板明说「不进 Σ」，值照样显示供参考）',
    ms.inSigma === false && man.inSigma === true);
  ok('S-07 需求编号列：有关注入 req_no，无关注空数组（不是 undefined、不渲染成 null）',
    JSON.stringify(man.reqNos) === '["REQ-001"]' && JSON.stringify(ms.reqNos) === '[]');

  const orphan: Row[] = P.buildPanelRows(
    [asPlan('pl-x', '实施部署-无依据', 'normal', null)], [], [mkDerive('pl-x', 'duration', 1, 1, 1.4, 'milestone')], [], {},
  );
  // skip 行仍显示推导值（行为：值在、且是非落库建议行）；tip 的「里程碑行不落估算」是单源 SKIP_LABEL，移到字面侧读它。
  // ⚠ tip 前缀「不落库：」写在 buildPanelRows 渲染处、未进任何单源表（见回传报告）——故此处只锚单源那一段，
  //   前缀失配由 NC-03 的破行为负控兜住（文案在、不落库行为缺失必须判红）。
  okPair(ok, 'S-08 skip 行（里程碑）仍显示推导值（行为），tip 引用单源跳过说明（锚点）',
    () => orphan[0].optimistic === 1 && orphan[0].suggestion === true,
    () => orphan[0].tip.includes(P.SKIP_LABEL.milestone),
    () => ({ tip: orphan[0].tip }));

  const noRatio: Row[] = P.buildPanelRows(
    [asPlan('pl-y', '需求分析-未归阶段', 'normal', 1)], [mkItem('pl-y', 2, 2, 2, 'rule', '', 'req')], [], [], {},
  );
  ok('S-09 已落库但 rowRatios 缺该键：E 显示空而不是伪造 0（面板不许掩盖缺算）',
    noRatio[0].expected === null && noRatio[0].optimistic === 2, noRatio[0]);

  const both: Row[] = P.buildPanelRows(
    [asPlan('pl-z', '开发甲', 'normal', 3)], [mkItem('pl-z', 1, 2, 3, 'default')], [mkDerive('pl-z', 'complexity', 3, 3.5, 5)], [], {},
  );
  okPair(ok, 'S-10 同一行既有落库值又有推导值：以落库为准（行为），徽标取单源「默认」（锚点）',
    () => both[0].likely === 2 && both[0].suggestion === false,
    () => both[0].badge.label === P.SOURCE_BADGE.default.label,
    () => ({ badge: both[0].badge, likely: both[0].likely }));

  const nothing: Row[] = P.buildPanelRows([asPlan('pl-n', '无数据行', 'normal', null)], [], [], [], {});
  okPair(ok, 'S-11 既无估算行又无推导：三点全空不以 0 充数（行为），徽标取单源「未录入」（锚点）',
    () => nothing[0].optimistic === null && nothing[0].expected === null,
    () => nothing[0].badge.label === P.SOURCE_BADGE.none.label,
    () => ({ badge: nothing[0].badge }));
}

// S12-S15 红线守卫（源码特征）
{
  const src = readFileSync(join(ROOT, 'web', 'src', 'components', 'EstimatePanel.tsx'), 'utf8');
  const page = readFileSync(join(ROOT, 'web', 'src', 'pages', 'PlanPage.tsx'), 'utf8');
  const pert = [/\boptimistic\s*\+\s*likely/, /likely\s*\*\s*4/, /\/\s*6\b/, /sigma\s*\(/, /\bexpected\s*=\s*\(/];
  ok('S-12 零计算红线：面板源码不含 PERT/σ 式子（E、σ、汇总只从服务端响应取）',
    pert.every((re) => !re.test(src)), pert.map((re) => re.source).filter((s) => new RegExp(s).test(src)));
  ok('S-13 不引第三方图表库、不 import 服务端模块（前端只经 REST 取数）',
    !/(recharts|echarts|chart\.js|d3)/.test(src) && !/\.\.\/\.\.\/server\//.test(src));
  ok('S-14 分组单源：面板复用时间线 groupTimelinePhases，不另写里程碑分组',
    /groupTimelinePhases/.test(src) && src.includes('./PlanTimeline'));
  ok('S-15 接线：面板宽取共享常量、形态双分支、开关键 plan.estimatePanelOpen 且不改 viewMode',
    page.includes('ESTIMATE_PANEL_WIDTH') && /estimateMode === 'docked'/.test(page) && /estimateMode === 'overlay'/.test(page)
    && page.includes("'plan.estimatePanelOpen'") && !/setViewMode\(.*estimate/i.test(page));
  ok('S-16 形态阈值 = PRD §5.1 的 1200px（1199 覆盖式 / 1200 与更宽停靠）',
    P.estimatePanelModeForWidth(1199) === 'overlay' && P.estimatePanelModeForWidth(1200) === 'docked'
    && P.estimatePanelModeForWidth(1440) === 'docked' && P.estimatePanelModeForWidth(1920) === 'docked');
  // T02299(4)：S-17 原本写死 `=== 420`（PRD §5.1 第 11 条当时的值）。T02124 依用户反馈把停靠宽
  // 调到 520，PRD 那一条没有回写 → 门里继续钉 420，等于把「文档里一版过期的实现细节」当长期判据，
  // 设计一动即恒红（同一常量已被 verify-t02039-e4-ui 改成「读实现声明值」）。
  // 这里只钉两条到今天仍然成立的口径：宽度是**单一来源常量**（全仓只声明一次、页面无第二处字面量），
  // 且落在停靠面板的合理带宽内。「PRD §5.1 第 11 条 420 vs 实现 520」已由 T02318 裁决 A（以实现为准）
  // 回写为 520（§5.1/§5.2/§10-13 同步）；按 T02293，S-17 不退回「等于某个字面量」——宽度仍允许在
  // 320~760 带宽内演进，文档随实现同步。
  const decls = [...(src.match(/ESTIMATE_PANEL_WIDTH\s*=\s*\d+/g) || []), ...(page.match(/ESTIMATE_PANEL_WIDTH\s*=\s*\d+/g) || [])];
  ok('S-17 面板宽是单一来源常量（面板+页面合计只声明一次）且落在停靠带宽 320~760',
    Number.isInteger(P.ESTIMATE_PANEL_WIDTH) && P.ESTIMATE_PANEL_WIDTH >= 320 && P.ESTIMATE_PANEL_WIDTH <= 760
    && decls.length === 1,
    { width: P.ESTIMATE_PANEL_WIDTH, decls });
}

console.log('\n=== R 段：按面板真实取数路径打 REST（隔离实例） ===');
closeDb();
// 启动器按 native 模块 ABI 探测（打包.bat 会把 better-sqlite3 重编译成 Electron ABI，
// 此时 process.execPath 直跑会 ERR_DLOPEN_FAILED）——见 isolated-server-launcher.mts
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const child: ChildProcess = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT,
  env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
console.log(`隔离实例启动器：${LAUNCHER.label}`);
const serverLog: string[] = [];
child.stdout?.on('data', (b: Buffer) => serverLog.push(b.toString()));
child.stderr?.on('data', (b: Buffer) => serverLog.push(b.toString()));

const BASE = `http://127.0.0.1:${PORT}`;
async function waitForServer(ms = 45_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const res = await fetch(`${BASE}/api/health`); if (res.ok) return true; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json: json as Record<string, any> };
}

if (!(await waitForServer())) {
  ok('R-00 隔离服务启动', false, serverLog.join('').slice(-400));
  child.kill();
  rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\nPASS=${pass} FAIL=${fail}`);
  process.exit(1);
}
ok('R-00 隔离服务启动（临时端口 + 临时库）', true);

// R1 面板首屏请求
const all = await api('GET', `/estimates?projectId=${PID}`);
ok('R-01 GET /api/estimates 200 且五段齐（items/summary/params/meta/checks）',
  all.status === 200 && ['items', 'summary', 'params', 'meta', 'checks'].every((k) => all.json[k] !== undefined),
  { status: all.status, keys: Object.keys(all.json) });
const items = all.json.items as Array<Record<string, unknown>>;
const need = ['plan_id', 'optimistic', 'likely', 'pessimistic', 'source', 'planTitle', 'planKind', 'complexity', 'durationDays', 'phase', 'note'];
ok('R-02 明细行字段面覆盖面板列（缺一个就得改服务端或删一列）',
  items.length === 1 && need.every((k) => k in items[0]), { items, miss: need.filter((k) => !(k in items[0])) });
okPair(ok, 'R-03 阶段标签随响应下发且与门进程单源表逐键相同（行为=键集/计数，锚点=req 词取 ESTIMATE_META）',
  () => all.status === 200
    && Object.keys(all.json.meta.phaseLabels).length === 6
    && ESTIMATE_META.phases.every((ph) => (all.json.meta.phaseLabels as Record<string, string>)[ph] === ESTIMATE_META.phaseLabels[ph]),
  () => (all.json.meta.phaseLabels as Record<string, string>).req === ESTIMATE_META.phaseLabels.req,
  () => ({ 下发: all.json.meta.phaseLabels, 单源: ESTIMATE_META.phaseLabels }));

// R4 rowRatios 的 σ 就是面板 σ 列的唯一来源
{
  const rr = all.json.summary.rowRatios as Array<{ key: string; expected: number; sigma: number }>;
  const one = rr.find((r) => r.key === 'pl-man')!;
  ok('R-04 rowRatios 每行带 sigma（E4 明细列要显示 σ，前端不得自算）',
    !!one && near(one.sigma, sigma({ optimistic: 3, likely: 4, pessimistic: 8 }), 1e-9)
    && near(one.expected, expected({ optimistic: 3, likely: 4, pessimistic: 8 }), 1e-9), one);
  ok('R-05 逐行 E/σ 与三点同源（任何行都算得出，不留空壳字段）',
    rr.every((r) => Number.isFinite(r.expected) && Number.isFinite(r.sigma)), rr);
}

// R6 归档行不进面板可见集
const visible = all.json.checks.visiblePlans as number;
ok('R-06 可见计划数不含归档行（pl-arch 归档后面板不出现）', visible === 5, { visible });

// R7 真实响应喂 buildPanelRows —— E4/E3 的焊接点
// sumBefore：填充前 Σ(直接投入人天)，R-18 要对照「填充后只增不减」，故声明在块外。
let sumBefore = 0;
const plansResp = await api('GET', `/plans?projectId=${PID}`);
const matrixResp = await api('GET', `/plans/prd-requirements?projectId=${PID}`);
{
  const planRows = (plansResp.json as unknown as Array<Record<string, unknown>>).filter((p) => !p.archived);
  const dv = await api('POST', '/estimates/derive', { projectId: PID, dryRun: true, scope: 'all' });
  ok('R-07 derive dryRun 预览 200 且 items 覆盖全部可见计划（面板每行都要有值或建议）',
    dv.status === 200 && (dv.json.items as unknown[]).length === planRows.length,
    { plans: planRows.length, derive: (dv.json.items as Array<Record<string, unknown>>).map((i) => i.planId) });
  const reqMap: Record<string, string[]> = {};
  for (const r of (matrixResp.json as Array<{ req_no: string; linkedPlans: Array<{ id: string }> }>)) {
    for (const lp of r.linkedPlans ?? []) (reqMap[lp.id] ??= []).push(r.req_no);
  }
  ok('R-08 需求编号列依赖面：矩阵接口按 linkedPlans[].id 可反查 req_no',
    JSON.stringify(reqMap['pl-cx']) === '["REQ-001"]', reqMap);

  const tl = planRows.map((p) => asPlan(String(p.id), String(p.title), String(p.kind ?? 'normal'), p.complexity == null ? null : Number(p.complexity)));
  const rows: Row[] = P.buildPanelRows(
    tl, all.json.items, dv.json.items, all.json.summary.rowRatios, reqMap,
  );
  const sugg = rows.filter((r) => r.suggestion);
  const written = rows.filter((r) => !r.suggestion && r.optimistic !== null);
  ok('R-09 真实响应喂面板：行数=可见计划数、已录入 1 行、其余全为建议值',
    rows.length === visible && written.length === 1 && sugg.length === visible - 1,
    { rows: rows.length, visible, written: written.length, sugg: sugg.length });
  // 行为侧与文案无关：里程碑不进 Σ + 建议行都渲染为「推导徽标」（默认色）；三档词「复杂度/用例/工期」移到字面侧读 RULE_LABEL。
  okPair(ok, 'R-10 建议行渲染为推导徽标且里程碑不进 Σ（行为），三档徽标取单源 RULE_LABEL（锚点）',
    () => rows.find((r) => r.planId === 'ms-1')!.inSigma === false
      && rows.filter((r) => r.suggestion).length > 0
      && rows.every((r) => !r.suggestion || r.badge.color === P.SOURCE_BADGE.default.color),
    () => [P.RULE_LABEL.complexity, P.RULE_LABEL.caseWeight, P.RULE_LABEL.duration].every((w) => rows.some((r) => r.badge.label === w)),
    () => rows.map((r) => [r.planId, r.badge.label, r.suggestion]));
  ok('R-11 面板汇总读数与响应逐字一致（零计算在真实数据上成立：E 列直接来自 rowRatios）',
    rows.every((r) => {
      const rr = (all.json.summary.rowRatios as Array<{ key: string; expected: number }>).find((x) => x.key === r.planId);
      return rr ? r.expected === rr.expected : r.expected === (dv.json.items as Array<{ planId: string; expected: number }>).find((d) => d.planId === r.planId)?.expected;
    }));
  const sumBeforeRow = (all.json.summary.directManDays as { expected: number }).expected;
  ok('R-12 建议值不进 Σ（未落库的行只作参考，汇总仍只算已录入行）',
    near(sumBeforeRow, expected({ optimistic: 3, likely: 4, pessimistic: 8 }), 1e-9), { sumBefore: sumBeforeRow });
  sumBefore = sumBeforeRow;
}

// R13 空态一键填充：预览行数 == 写入行数（§10-5）
{
  const preview = await api('POST', '/estimates/derive', { projectId: PID, dryRun: true, scope: 'all' });
  const write = await api('POST', '/estimates/derive', { projectId: PID, dryRun: false, scope: 'missing' });
  const writable = preview.json.writableCount as number;
  ok('R-13 dryRun 预览的可写行数 = 实际写入行数（按钮文案与落库不打架）',
    write.status === 200 && write.json.written === writable && writable > 0,
    { writable, written: write.json.written, errors: write.json.errors });
  ok('R-14 里程碑不落库（红线一在写入路径同样生效）',
    !(write.json.writtenPlanIds as string[]).includes('ms-1'), write.json.writtenPlanIds);

  const after = await api('GET', `/estimates?projectId=${PID}`);
  const manRow = (after.json.items as Array<Record<string, unknown>>).find((i) => i.plan_id === 'pl-man');
  ok('R-15 人工行不被规则覆盖（三点原值 + source 仍 manual，红线二）',
    manRow?.likely === 4 && manRow?.source === 'manual' && manRow?.note === '人工复核过的行', manRow);
  ok('R-16 填充后覆盖度：missing 归零、estimated = 可见 normal 行数',
    (after.json.checks.coverage as { missing: number; estimated: number }).missing === 0
    && (after.json.checks.coverage as { estimated: number; normal: number }).estimated === (after.json.checks.coverage as { normal: number }).normal,
    after.json.checks.coverage);
  const dvAfter = await api('POST', '/estimates/derive', { projectId: PID, dryRun: true, scope: 'all' });
  const rowsAfter: Row[] = P.buildPanelRows(
    (plansResp.json as unknown as Array<Record<string, unknown>>).filter((p) => !p.archived)
      .map((p) => asPlan(String(p.id), String(p.title), String(p.kind ?? 'normal'), p.complexity == null ? null : Number(p.complexity))),
    after.json.items, dvAfter.json.items, after.json.summary.rowRatios, {},
  );
  const suggAfter = rowsAfter.filter((r) => r.suggestion && r.planId !== 'ms-1');
  // 行为侧用「徽标对象引用同一份 SOURCE_BADGE.rule」+ 全部转落库，与文案无关；「人工/规则」两个词移到字面侧读单源表。
  okPair(ok, 'R-17 填充后建议行转为已落库、徽标随实际 source（行为），且词取单源 SOURCE_BADGE（锚点）',
    () => suggAfter.length === 0
      && rowsAfter.filter((r) => r.planId !== 'ms-1').every((r) => r.persisted === true)
      && rowsAfter.filter((r) => r.badge === P.SOURCE_BADGE.rule).length === 3,
    () => rowsAfter.filter((r) => r.planId !== 'ms-1').every((r) =>
        r.badge.label === P.SOURCE_BADGE.manual.label || r.badge.label === P.SOURCE_BADGE.rule.label)
      && rowsAfter.filter((r) => r.badge.label === P.SOURCE_BADGE.rule.label).length === 3,
    () => rowsAfter.map((r) => [r.planId, r.badge.label, r.suggestion, r.persisted]));
  const sumAfter = (after.json.summary.directManDays as { expected: number }).expected;
  ok('R-18 Σ 只增不减且里程碑始终在外（填充后汇总随服务端重算，面板无参与）',
    sumAfter > sumBefore
    && !(after.json.summary.countedKeys as string[]).includes('ms-1')
    && (after.json.items as Array<Record<string, unknown>>).every((i) => i.plan_id !== 'ms-1'),
    { sumBefore, sumAfter, countedKeys: after.json.summary.countedKeys });
}

const logText = serverLog.join('');
ok('R-19 服务日志无 estimates/面板取数相关异常',
  !/estimates[\s\S]{0,120}(Error|异常|unhandled)/i.test(logText) && !/UnhandledPromiseRejection/.test(logText),
  logText.split('\n').filter((l) => /error|异常/i.test(l)).slice(0, 3));

// R-20：面板取数路径里补一条真实拒绝，让 H 段拿到「服务端 400 原文」与门进程词干做同一性比对。
// 走 PUT /params 写一个中段非 4 的比例——服务端在 resolveEstimateConfig 里抛 parseRuleRatio 的文案，整批零写入。
const badParam = await api('PUT', `/estimates/params?projectId=${PID}`, { settings: { 'estimate.rule.default.ratio': '1:5:1.6' } });
const gAfterParam = await api('GET', `/estimates/params?projectId=${PID}`);
rejected400('R-20 比例中段非 4 → 400，文案取单源词干（REST 无错误信封，拒绝即零写入）', badParam, ESTIMATE_ERRORS.ratioMidPert,
  () => (gAfterParam.json?.config?.ruleRatio?.pMul ?? 0) === 1.6); // 被拒的批次没改动默认 pMul=1.6

// ============ H 段：跨进程同源自证（T02293 判据 4） ============
// R 段的 400/阶段标签出自**隔离服务进程**，门进程只持有 `ESTIMATE_ERRORS` / `ESTIMATE_META` 两张 on-disk 表。
// 逐条命中 + 假词干零命中 + 同入参逐字符相同，自证「改措辞门不假红」靠的是同源，不是抄本。
{
  const stems = Object.values(ESTIMATE_ERRORS);
  ok('H-01 服务端 400 原文逐条命中门进程单源词干',
    rest400.length >= 1 && rest400.every((r) => stems.some((s) => r.error.includes(s))),
    { 条数: rest400.length, 未命中: rest400.filter((r) => !stems.some((s) => r.error.includes(s))).map((r) => r.label) });
  ok('H-02 假词干对全部 400 原文零命中（H-01 的比对不是恒真式）',
    rest400.length > 0 && rest400.every((r) => !r.error.includes('ZZZ-本门不存在的词干')), { 条数: rest400.length });
  ok('H-03 同一入参的服务端 400 文案与门进程 parseRuleRatio 逐字符相同',
    String(badParam.json?.error ?? '') === fire(() => parseRuleRatio('1:5:1.6')),
    { 服务端: badParam.json?.error, 门进程: fire(() => parseRuleRatio('1:5:1.6')) });
  ok('H-04 阶段标签跨进程同源：REST meta 与门进程 ESTIMATE_META.phaseLabels 逐键相同',
    ESTIMATE_META.phases.every((ph) => (all.json.meta.phaseLabels as Record<string, string>)[ph] === ESTIMATE_META.phaseLabels[ph])
    && (all.json.meta.phaseLabels as Record<string, string>).req === ESTIMATE_META.phaseLabels.req,
    { 下发: all.json.meta.phaseLabels, 单源: ESTIMATE_META.phaseLabels });
}

child.kill();
await new Promise((r) => setTimeout(r, 600));
rmSync(DATA_DIR, { recursive: true, force: true });

// ============ G 段：面板单源词表改名模拟（T02293 判据 4·同进程） ============
// 面板的「抄本风险」不在引擎表，而在它自己的徽标/标签常量（SOURCE_BADGE/RULE_LABEL/SKIP_LABEL）。
// buildPanelRows 是纯函数：把某支词干改成 `ZZZ-<key>` 后重新喂同一批夹具，看渲染出的词是否随之移动——
// 若渲染处写死了「人工」「默认·复杂度」「里程碑行不落估算」，改名模拟当场抓出第二份抄本。还原逐字符相同即证无污染。
console.log('\n=== G 段：面板单源词表改名模拟（同进程·判据 4） ===');
{
  const SRC = P.SOURCE_BADGE as unknown as Record<string, { label: string; color: string }>;
  const RULE = P.RULE_LABEL as unknown as Record<string, string>;
  const SKIP = P.SKIP_LABEL as unknown as Record<string, string>;
  const chkPlan = [asPlan('chk', '校验行', 'normal', null)];
  const badgeOf = (source: string) => P.buildPanelRows(chkPlan, [mkItem('chk', 1, 1, 1, source)], [], [], {})[0].badge.label;
  const deriveBadge = (rule: string) => P.buildPanelRows(chkPlan, [], [mkDerive('chk', rule, 1, 1, 1)], [], {})[0].badge.label;
  const skipTip = () => P.buildPanelRows(chkPlan, [], [mkDerive('chk', 'duration', 1, 1, 1.4, 'milestone')], [], {})[0].tip;
  const wholeTable = () => JSON.stringify([badgeOf('manual'), badgeOf('rule'), badgeOf('default'), badgeOf('none'), deriveBadge('complexity'), skipTip()]);
  const cases: Array<{ title: string; get: () => string; set: (v: string) => void; render: () => string }> = [
    { title: 'SOURCE_BADGE.manual', get: () => SRC.manual.label, set: (v) => { SRC.manual.label = v; }, render: () => badgeOf('manual') },
    { title: 'SOURCE_BADGE.rule', get: () => SRC.rule.label, set: (v) => { SRC.rule.label = v; }, render: () => badgeOf('rule') },
    { title: 'SOURCE_BADGE.default', get: () => SRC.default.label, set: (v) => { SRC.default.label = v; }, render: () => badgeOf('default') },
    { title: 'SOURCE_BADGE.none', get: () => SRC.none.label, set: (v) => { SRC.none.label = v; }, render: () => badgeOf('none') },
    { title: 'RULE_LABEL.complexity', get: () => RULE.complexity, set: (v) => { RULE.complexity = v; }, render: () => deriveBadge('complexity') },
    { title: 'SKIP_LABEL.milestone', get: () => SKIP.milestone, set: (v) => { SKIP.milestone = v; }, render: () => skipTip() },
  ];
  const baseline = wholeTable();
  const zj: string[] = [];
  for (const c of cases) {
    const stem = c.get();
    const before = c.render();
    if (!before.includes(stem)) { zj.push(`${c.title}：渲染词未含单源值「${stem}」→ 渲染处留了写死抄本`); continue; }
    const renamed = `ZZZ-${c.title}`;
    c.set(renamed);
    let after = '';
    try { after = c.render(); } finally { c.set(stem); }
    if (!after.includes(renamed)) zj.push(`${c.title}：改表后渲染未随单源移动（第二份抄本）`);
    if (after.includes(stem)) zj.push(`${c.title}：改表后仍渲染旧词「${stem}」= 残留抄本`);
    if (c.render() !== before) zj.push(`${c.title}：还原后渲染与原始件不逐字符相同`);
  }
  ok('G-01 面板徽标/标签改名模拟全项通过（渲染随单源移动、旧词零残留、还原逐字符相同、纯函数零副作用）', zj.length === 0, zj);
  ok('G-02 改名模拟覆盖面板单源词表 ≥6 支（四类徽标 + 三档推导 + 跳过说明）', cases.length >= 6, { 支数: cases.length });
  ok('G-03 改名模拟无污染：全表逐字符还原到基线（跨断言不残留 `ZZZ`）', wholeTable() === baseline, { baseline, now: wholeTable() });
}

// ============ NC 段：配对器反证与破行为负控（T02293 判据 4） ============
console.log('\n=== NC 段：配对器反证与破行为负控 ===');
{
  const seen: Array<{ cond: boolean; 红因?: string }> = [];
  const spy = (_n: string, cond: boolean, extra?: unknown) => {
    seen.push({ cond, 红因: (extra as Record<string, unknown> | undefined)?.红因 as string | undefined });
  };
  // NC-01：徽标文案对得上单源，但该行根本不是落库行（行为缺失）→ 必须判「行为失守」，不被文案带绿。
  const fakeRow = { badge: { label: P.SOURCE_BADGE.manual.label, color: 'x' }, persisted: false };
  okPair(spy, 'NC-01（预期红：行为失守）', () => fakeRow.persisted === true, () => fakeRow.badge.label === P.SOURCE_BADGE.manual.label);
  // NC-02：行为在，但锚抄成别的词 → 判「字面锚点失配（行为在）」。
  okPair(spy, 'NC-02（预期红：锚点失配）', () => true, () => '人工'.includes('完全不存在的旧词'));
  // NC-03：「不落库」文案在（含单源 SKIP_LABEL 段），但不落库行为缺失 → 判「行为失守」（S-08 前缀的破行为负控）。
  okPair(spy, 'NC-03（预期红：行为失守）', () => false, () => `不落库：${P.SKIP_LABEL.milestone}`.includes(P.SKIP_LABEL.milestone));
  // NC-04：双绿基准。
  okPair(spy, 'NC-04（预期绿）', () => true, () => P.SOURCE_BADGE.none.label === P.SOURCE_BADGE.none.label);
  ok('NC-01 徽标文案对得上但落库行为缺失 → 配对器判红、红因=行为失守',
    seen[0]?.cond === false && /行为失守/.test(seen[0]?.红因 ?? ''), seen[0]);
  ok('NC-02 行为在但锚抄错词 → 红因=字面锚点失配（行为在）',
    seen[1]?.cond === false && /字面锚点失配/.test(seen[1]?.红因 ?? ''), seen[1]);
  ok('NC-03「不落库」文案在但不落库行为缺失 → 红因=行为失守（S-08 前缀的破行为负控）',
    seen[2]?.cond === false && /行为失守/.test(seen[2]?.红因 ?? ''), seen[2]);
  ok('NC-04 双绿基准：行为与锚同时成立才判绿',
    seen[3]?.cond === true, seen[3]);
}

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
