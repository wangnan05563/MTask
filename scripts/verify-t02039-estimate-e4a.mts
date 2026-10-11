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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02039-e4a-'));
const PORT = Number(process.env.T02039_PORT ?? 39929);
process.env.MTask_DATA_DIR = DATA_DIR;

const { getDb, closeDb } = await import('../server/src/db/connection.ts');
const { initSchema } = await import('../server/src/db/schema.ts');
const { ESTIMATE_SOURCES, ESTIMATE_PHASES } = await import('../server/src/services/EstimateService.ts');
const { DERIVE_RULES } = await import('../server/src/services/EstimateDerive.ts');
const { sigma, expected } = await import('../server/src/services/estimate-engine.ts');
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
  ok('S-04 已落库行：三点取估算行、E/σ 取服务端 rowRatios、徽标=人工',
    man.optimistic === 3 && man.likely === 4 && man.pessimistic === 8 && man.badge.label === '人工'
    && near(man.expected as number, 4.5, 1e-9) && near(man.sigma as number, sigma({ optimistic: 3, likely: 4, pessimistic: 8 }), 1e-9)
    && man.suggestion === false && man.tip === '已复核', man);
  const ms = rows.find((r) => r.planId === 'ms-1')!;
  ok('S-05 建议行：徽标带推导档（默认·复杂度），且标为 suggestion',
    ms.badge.label === '默认·复杂度' && ms.suggestion === true && ms.tip === '按complexity推导', ms.badge);
  ok('S-06 里程碑行 inSigma=false（面板明说「不进 Σ」，值照样显示供参考）',
    ms.inSigma === false && man.inSigma === true);
  ok('S-07 需求编号列：有关注入 req_no，无关注空数组（不是 undefined、不渲染成 null）',
    JSON.stringify(man.reqNos) === '["REQ-001"]' && JSON.stringify(ms.reqNos) === '[]');

  const orphan: Row[] = P.buildPanelRows(
    [asPlan('pl-x', '实施部署-无依据', 'normal', null)], [], [mkDerive('pl-x', 'duration', 1, 1, 1.4, 'milestone')], [], {},
  );
  ok('S-08 skip 行（如里程碑）仍显示推导值，但 tip 说明为何不落库',
    orphan[0].tip.startsWith('不落库') && orphan[0].optimistic === 1, orphan[0]);

  const noRatio: Row[] = P.buildPanelRows(
    [asPlan('pl-y', '需求分析-未归阶段', 'normal', 1)], [mkItem('pl-y', 2, 2, 2, 'rule', '', 'req')], [], [], {},
  );
  ok('S-09 已落库但 rowRatios 缺该键：E 显示空而不是伪造 0（面板不许掩盖缺算）',
    noRatio[0].expected === null && noRatio[0].optimistic === 2, noRatio[0]);

  const both: Row[] = P.buildPanelRows(
    [asPlan('pl-z', '开发甲', 'normal', 3)], [mkItem('pl-z', 1, 2, 3, 'default')], [mkDerive('pl-z', 'complexity', 3, 3.5, 5)], [], {},
  );
  ok('S-10 同一行既有落库值又有推导值：以落库为准（推导只填空，不覆盖）',
    both[0].likely === 2 && both[0].badge.label === '默认' && both[0].suggestion === false, both[0]);

  const nothing: Row[] = P.buildPanelRows([asPlan('pl-n', '无数据行', 'normal', null)], [], [], [], {});
  ok('S-11 既无估算行又无推导：徽标「未录入」且三点全空（不以 0 充数）',
    nothing[0].badge.label === '未录入' && nothing[0].optimistic === null && nothing[0].expected === null, nothing[0]);
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
  ok('S-17 面板宽 420（与 PRD §5.1 布局图同值）', P.ESTIMATE_PANEL_WIDTH === 420);
}

console.log('\n=== R 段：按面板真实取数路径打 REST（隔离实例） ===');
closeDb();
const tsxPath = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const child: ChildProcess = spawn(process.execPath, [tsxPath, join(ROOT, 'server', 'src', 'index.ts')], {
  cwd: ROOT,
  env: { ...process.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
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
ok('R-03 阶段标签/枚举随响应下发（面板不硬编码）',
  (all.json.meta.phaseLabels as Record<string, string>)['req'] === '需求分析'
  && Object.keys(all.json.meta.phaseLabels).length === 6);

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
  ok('R-10 建议行三档各自到位（复杂度/用例/工期）+ 里程碑标为不进 Σ',
    rows.some((r) => r.badge.label === '默认·复杂度') && rows.some((r) => r.badge.label === '默认·用例')
    && rows.some((r) => r.badge.label === '默认·工期') && rows.find((r) => r.planId === 'ms-1')!.inSigma === false,
    rows.map((r) => [r.planId, r.badge.label]));
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
  ok('R-17 再取一次：原建议行转为已落库（徽标从「默认·×」变成行内实际 source，规则写入即「规则」）',
    suggAfter.length === 0
    && rowsAfter.filter((r) => r.planId !== 'ms-1').every((r) => r.badge.label === '人工' || r.badge.label === '规则')
    && rowsAfter.filter((r) => r.badge.label === '规则').length === 3,
    rowsAfter.map((r) => [r.planId, r.badge.label, r.suggestion]));
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

child.kill();
await new Promise((r) => setTimeout(r, 600));
rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
