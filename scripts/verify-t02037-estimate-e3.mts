/**
 * E3（T02037 · PRD-估算视图 §4.6/§7/§8）验证脚本：三档推导规则 + `/api/estimates*` REST 全链。
 *
 * 用法（Node 版本必须与 node_modules/better-sqlite3 的预编译 ABI 对齐，本机 Node22 ABI127 可加载）：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02037-estimate-e3.mts
 *
 * 两段结构：
 *   S 段（同进程·只读）：`EstimateDerive` 三档规则逐档取值、0.5 网格、里程碑/人工行保护、覆盖面、
 *     「Σ 含里程碑 − Σ 仅 normal = 里程碑推导值」恒等式（§4.6 v1.4 判据）。**不落库**，
 *     把写路径完整留给 R 段的 REST，避免「服务层先写一遍、REST 再断言一遍」的同义反复。
 *   R 段（隔离实例·REST）：起一个 `MTask_PORT` + `MTask_DATA_DIR` 的临时服务进程，按 §8 端点清单
 *     逐条打真请求——路由挂载、静态路径优先于 `:planId`、`wrap` 的 400 中文文案、批量零写入、
 *     PATCH 人工转 manual、参数读写校验、快照 compare、脱离行清理、归档行不进 Σ。
 *
 * 隔离纪律（skill 红线 8）：库与端口都是临时的，不碰生产数据目录，跑完 kill + 回收临时目录。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02037-e3-'));
const PORT = Number(process.env.T02037_PORT ?? 39927);
process.env.MTask_DATA_DIR = DATA_DIR;

const { getDb, closeDb } = await import('../server/src/db/connection.ts');
const { initSchema } = await import('../server/src/db/schema.ts');
const D = await import('../server/src/services/EstimateDerive.ts');
const { buildSummary, resolveEstimateConfig, expected, DEFAULT_ESTIMATE_CONFIG } = await import('../server/src/services/estimate-engine.ts');

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
const PID = 'p-e3';
const PID_B = 'p-e3b';

// ---------------- 夹具：直接写测试库（隔离临时库，不经 REST，也不碰生产） ----------------
initSchema();
const db = getDb();
const insProj = db.prepare(
  'INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
);
insProj.run(PID, 'T02037-估算E3', '', T, T);
insProj.run(PID_B, 'T02037-E3-第二项目', '', T, T);

const insPlan = db.prepare(
  `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
     progress, status, assignee, sort_order, created_at, updated_at, kind, complexity)
   VALUES (?, ?, ?, '', ?, ?, ?, 0, 'todo', '', ?, ?, ?, ?, ?)`,
);
type PlanSeed = [id: string, title: string, dur: number, sort: number, kind?: string, complexity?: number | null];
const plans: PlanSeed[] = [
  ['pl-c3', '需求分析-复杂度3', 5, 1, 'normal', 3],
  ['pl-c1', '系统设计-复杂度1', 2, 2, 'normal', 1],
  ['pl-case', '开发甲-用例加权', 4, 3, 'normal', null],
  ['pl-dur', '实施部署-仅工期', 7, 4, 'normal', null],
  ['pl-ms', 'M1 阶段包络', 20, 5, 'milestone', 4],
  ['pl-man', '开发乙-已人工录入', 3, 6, 'normal', 2],
  ['pl-rule', '开发丙-已有规则值', 6, 7, 'normal', 3],
  ['pl-arch', '开发丁-已归档', 4, 8, 'normal', 5],
];
for (const [id, title, dur, sort, kind, cx] of plans) {
  insPlan.run(id, PID, title, '2026-10-12', '2026-10-12', dur, sort, T, T, kind ?? 'normal', cx ?? null);
}
db.prepare('UPDATE plan_tasks SET archived = 1, archived_at = ? WHERE id = ?').run(T, 'pl-arch');
db.prepare("UPDATE plan_tasks SET req_ids = ? WHERE id = 'pl-case'").run(JSON.stringify(['rq-1']));

const insReq = db.prepare(
  `INSERT INTO prd_requirements (id, project_id, req_no, title, content, source_ref, priority, status, sort_order, created_at, updated_at)
   VALUES (?, ?, ?, ?, '', '', 'normal', 'todo', 0, ?, ?)`,
);
insReq.run('rq-1', PID, 'REQ-001', '用例加权来源需求', T, T);
const insCase = db.prepare(
  `INSERT INTO test_cases (id, project_id, req_id, case_no, title, priority, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
// Σ权重 = P0 3 + P1 2 + P2 1 + P3 0.5 = 6.5；'PPX' 是未知档，权重记 0 并进 unknown 计数
[['tc-1', 'P0'], ['tc-2', 'P1'], ['tc-3', 'P2'], ['tc-4', 'P3'], ['tc-5', 'PPX']].forEach(([id, pri], i) => {
  insCase.run(id, PID, 'rq-1', `C-${i + 1}`, `用例${i + 1}`, pri as string, T, T);
});

const insEst = db.prepare(
  `INSERT INTO estimate_items (id, project_id, plan_id, phase, unit, optimistic, likely, pessimistic, source, note, created_at, updated_at)
   VALUES (?, ?, ?, ?, 'man_day', ?, ?, ?, ?, '', ?, ?)`,
);
insEst.run('es-man', PID, 'pl-man', 'dev', 3, 4, 8, 'manual', T, T);
insEst.run('es-rule', PID, 'pl-rule', 'dev', 2, 2, 2, 'rule', T, T);
insEst.run('es-gone', PID, 'pl-gone', 'common', 1, 2, 3, 'default', T, T);

const insSnap = db.prepare(
  'INSERT INTO estimate_snapshots (id, project_id, format, filename, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
);
const payloadOf = (devE: number, dm: number, am: number) => JSON.stringify({
  phases: [{ phase: 'dev', expected: devE, idealManMonth: devE / 20.83, manMonth: devE / 20.83 }],
  directManDays: { optimistic: dm - 1, likely: dm, pessimistic: dm + 1, expected: dm },
  actualManMonths: { optimistic: am - 0.1, likely: am, pessimistic: am + 0.1, expected: am },
});
insSnap.run('sn-a', PID, 'xlsx', 'a.xlsx', payloadOf(10, 20, 2), '2026-10-01T00:00:00.000Z');
insSnap.run('sn-b', PID, 'xlsx', 'b.xlsx', payloadOf(12, 24, 2.4), '2026-10-05T00:00:00.000Z');

console.log('\n=== S 段：三档推导规则（同进程·只读） ===');
const CFG = DEFAULT_ESTIMATE_CONFIG;
const derive = () => D.deriveEstimates(PID, { config: resolveEstimateConfig({}) });

// S1 阶段关键字
ok('S-01 阶段关键字映射（需求/设计/开发/实施/维护/测试）',
  D.inferPhase('需求分析') === 'req' && D.inferPhase('系统架构设计') === 'design' && D.inferPhase('开发联调') === 'dev'
  && D.inferPhase('上线部署') === 'impl' && D.inferPhase('现场维护') === 'onsite' && D.inferPhase('测试与文档') === 'common');
ok('S-02 未命中关键字回落 dev（与 EstimateService 缺省同口径）', D.inferPhase('M1 阶段包络') === 'dev');

// S3 三档规则逐档取值（0.5 网格，§4.1 输入精度）
{
  const r = derive();
  const by = new Map(r.items.map((i) => [i.planId, i]));
  const c3 = by.get('pl-c3');
  ok('S-03 规则1 复杂度3：M=基准3.5、O=M×1、P=grid(3.5×1.6)=5.5',
    c3?.rule === 'complexity' && c3?.optimistic === 3.5 && c3?.likely === 3.5 && c3?.pessimistic === 5.5, c3);
  ok('S-04 规则1 E 由引擎单源算出（(3.5+4*3.5+5.5)/6）', c3 !== undefined && near(c3.expected, expected({ optimistic: 3.5, likely: 3.5, pessimistic: 5.5 })));
  const c1 = by.get('pl-c1');
  ok('S-05 规则1 复杂度1：M=1、P=grid(1.6)=1.5（不是 1.6——面板与导出同一个数）',
    c1?.likely === 1 && c1?.optimistic === 1 && c1?.pessimistic === 1.5 && c1?.phase === 'design', c1);
  const cs = by.get('pl-case');
  ok('S-06 规则2 用例加权：Σ权重6.5×k0.5=3.25 → M=grid(3.25)=3.5、P=grid(5.2)=5.0',
    cs?.rule === 'caseWeight' && cs?.optimistic === 3.5 && cs?.likely === 3.5 && cs?.pessimistic === 5, cs);
  ok('S-07 规则2 依据回传（5 条用例、1 条未知档、k 与 Σ权重可见）',
    cs?.basis.caseCount === 5 && cs?.basis.caseWeight === 6.5 && cs?.basis.caseWeightUnknown === 1 && cs?.basis.k === 0.5, cs?.basis);
  const du = by.get('pl-dur');
  ok('S-08 规则3 工期回退：M=duration7、O=grid(5.6)=5.5、P=grid(9.8)=10',
    du?.rule === 'duration' && du?.optimistic === 5.5 && du?.likely === 7 && du?.pessimistic === 10, du);
  ok('S-09 规则3 note 用 PRD 原文案（面板提示语不各写一套）', du?.note === D.DURATION_NOTE, du?.note);
  ok('S-10 规则优先级：复杂度非空即命中规则1（用例档不再参与）',
    by.get('pl-c3')?.rule === 'complexity' && (by.get('pl-c3')?.basis.caseCount ?? -1) === 0);
  ok('S-11 三点全程 O≤M≤P（落库前不违反 pointsError）',
    r.items.every((i) => i.optimistic <= i.likely && i.likely <= i.pessimistic), r.items.map((i) => [i.planId, i.optimistic, i.likely, i.pessimistic]));

  // S12~S16 跳过口径
  ok('S-12 里程碑行只出参考值、不落库（writable=false + skip=milestone）',
    by.get('pl-ms')?.skip === 'milestone' && by.get('pl-ms')?.writable === false);
  ok('S-13 人工行默认不被规则覆盖（skip=manual）', by.get('pl-man')?.skip === 'manual' && by.get('pl-man')?.existing === 'manual');
  ok('S-14 已有规则行在 scope=missing 下跳过（skip=exists）', by.get('pl-rule')?.skip === 'exists');
  ok('S-15 可写集合 = 4 条未估算明细（不含里程碑/人工/已有规则/归档）',
    r.writableCount === 4 && r.items.filter((i) => i.writable).map((i) => i.planId).sort().join(',') === 'pl-c1,pl-c3,pl-case,pl-dur',
    r.items.filter((i) => i.writable).map((i) => i.planId));
  ok('S-16 归档计划不进推导集合（pl-arch 不在 items 中）', !by.has('pl-arch') && !by.has('pl-gone'));

  // S17~S19 scope / includeManual
  const all = D.deriveEstimates(PID, { config: CFG, scope: 'all' });
  const allBy = new Map(all.items.map((i) => [i.planId, i]));
  ok('S-17 scope=all：已有规则行可重推，人工行仍受保护',
    allBy.get('pl-rule')?.writable === true && allBy.get('pl-man')?.skip === 'manual' && allBy.get('pl-ms')?.skip === 'milestone');
  const allM = D.deriveEstimates(PID, { config: CFG, scope: 'all', includeManual: true });
  ok('S-18 scope=all+includeManual：人工行也进可写集（显式才动）',
    allM.items.filter((i) => i.writable).length === 6 && allM.items.find((i) => i.planId === 'pl-man')?.writable === true,
    allM.items.filter((i) => i.writable).map((i) => i.planId));
  const one = D.deriveEstimates(PID, { config: CFG, planIds: ['pl-c3', 'pl-ms'] });
  ok('S-19 planIds 白名单生效（只返回指定行，顺序不变）',
    one.items.map((i) => i.planId).join(',') === 'pl-c3,pl-ms' && one.writableCount === 1, one.items.map((i) => i.planId));

  // S20 k 与比例配置真的进推导
  const k2 = D.deriveEstimates(PID, { config: CFG, caseWeightK: 2 });
  const k2cs = k2.items.find((i) => i.planId === 'pl-case');
  ok('S-20 覆盖 k=2 → M=grid(6.5×2)=13、P=grid(13×1.6)=20.8→21',
    k2cs?.likely === 13 && k2cs?.pessimistic === 21 && k2.caseWeightKFrom === 'override', k2cs);
  const r12 = D.deriveEstimates(PID, { config: { ...CFG, ruleRatio: { oMul: 1, pMul: 1.2 } } });
  const r12c3 = r12.items.find((i) => i.planId === 'pl-c3');
  ok('S-21 比例配置 pMul=1.2 → P=grid(4.2)=4.0（参数页与 derive 同一把尺子）',
    r12c3?.pessimistic === 4, r12c3);
  let kErr = '';
  try { D.deriveEstimates(PID, { config: CFG, caseWeightK: 0 }); } catch (e) { kErr = (e as Error).message; }
  ok('S-22 k=0 直接报错而不是静默回落', kErr.includes('正数'), kErr);

  // S23 clamp
  const huge = D.deriveEstimates(PID, { config: CFG, caseWeightK: 100 });
  ok('S-23 规则2 M 按 §4.6 clamp 到 20（k 再大也不失控）',
    (huge.items.find((i) => i.planId === 'pl-case')?.likely ?? 0) === 20, huge.items.find((i) => i.planId === 'pl-case'));

  // S24 覆盖面
  const cov = D.coverage(PID);
  ok('S-24 覆盖面：normal6 / milestone1 / estimated2 / missing4 / detached1',
    cov.normal === 6 && cov.milestone === 1 && cov.estimated === 2 && cov.missing === 4 && cov.detached === 1, cov);
  ok('S-25 来源分布含 manual/rule/default 三类（复核率出数口）',
    cov.bySource.manual === 1 && cov.bySource.rule === 1 && cov.bySource.default === 1, cov.bySource);

  // S26 里程碑不重复计恒等式（§4.6 v1.4 判据）：拿「逐行推导后朴素全表求和」与引擎求和对比，
  // 差值必须正好等于里程碑那一行的推导值——这就是「阶段工作量被算两遍」的可执行反证。
  const toEngine = (list: typeof r.items) => list.map((i) => ({
    key: i.planId, phase: i.phase, role: 'detail' as const, planKind: i.kind,
    points: { optimistic: i.optimistic, likely: i.likely, pessimistic: i.pessimistic },
  }));
  const naiveAll = r.items.reduce((a, i) => a + i.expected, 0);
  const engineAll = buildSummary(toEngine(r.items), CFG).directManDays.expected;
  const msE = by.get('pl-ms')?.expected ?? 0;
  const normalEngine = buildSummary(toEngine(r.items.filter((i) => i.kind !== 'milestone')), CFG).directManDays.expected;
  ok('S-26 Σ(含里程碑推导行) − Σ(仅 normal) = 里程碑推导值（复杂4→E5.5，算两遍被抓住）',
    near(naiveAll - normalEngine, msE, 1e-9) && near(msE, 5.5, 1e-9), { naiveAll, normalEngine, msE });
  ok('S-27 引擎自己就把里程碑挡在 Σ 外：喂全表 = 喂 normal',
    near(engineAll, normalEngine, 1e-9)
    && buildSummary(toEngine(r.items), CFG).countedKeys.indexOf('pl-ms') === -1, { engineAll, normalEngine });
}

// S28 第二项目互不串味
{
  const r = D.deriveEstimates(PID_B, { config: CFG });
  ok('S-28 空项目：derive 返回空集合而非报错，coverage 全 0',
    r.items.length === 0 && r.writableCount === 0 && D.coverage(PID_B).normal === 0);
  let err = '';
  try { D.deriveEstimates('no-such-project', { config: CFG }); } catch (e) { err = (e as Error).message; }
  ok('S-29 不存在的项目报错', err.includes('项目不存在'), err);
}

console.log('\n=== R 段：/api/estimates* REST（隔离实例） ===');
closeDb();

// tsx 的 package.json exports 不放行 ./dist/cli.mjs 子路径解析，按文件路径直取
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
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

type Resp = { status: number; json: Record<string, any> | null };
async function api(method: string, path: string, body?: unknown): Promise<Resp> {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: Record<string, any> | null = null;
  try { json = (await res.json()) as Record<string, any>; } catch { /* 非 JSON */ }
  return { status: res.status, json };
}
const Q = `?projectId=${PID}`;

if (!(await waitForServer())) {
  console.log('  [FAIL] 隔离服务未就绪，R 段整体跳过');
  console.log(serverLog.join('').slice(-1500));
  fail += 1;
} else {
  // R1 路由挂载 + 静态路径优先
  const health = await api('GET', '/api/health');
  ok('R-01 隔离实例就绪', health.status === 200);
  const params = await api('GET', `/api/estimates/params${Q}`);
  ok('R-02 静态路径 /params 不被 /:planId 抢占（plans.ts 同条红线）',
    params.status === 200 && params.json?.config?.manDaysPerManMonth === 20.83, params.json?.config);
  const meta = await api('GET', '/api/estimates/meta');
  ok('R-03 meta 单源下发阶段/系数标签与推导常量',
    meta.status === 200 && meta.json?.phaseLabels?.req === '需求分析'
    && meta.json?.complexityBaseDays?.[3] === 3.5 && meta.json?.casePriorityWeights?.P0 === 3
    && meta.json?.durationMul?.pMul === 1.4, meta.json && Object.keys(meta.json));
  const noPid = await api('GET', '/api/estimates');
  ok('R-04 projectId 必填走 400 中文文案', noPid.status === 400 && noPid.json?.error === 'projectId 必填', noPid.json);

  // R5 GET 全量
  const g0 = await api('GET', `/api/estimates${Q}`);
  const items0 = g0.json?.items ?? [];
  ok('R-05 GET 全量：明细左联 + 汇总 + 参数 + 校验结果四块齐备',
    g0.status === 200 && Array.isArray(items0) && g0.json?.summary?.phases && g0.json?.params?.config && g0.json?.checks?.ratioCheck);
  ok('R-06 首屏明细=2 行（未 derive），里程碑无行',
    items0.length === 2 && items0.every((i: any) => i.plan_id !== 'pl-ms'));
  ok('R-07 汇总只算已有估算行：E = pl-man4.5 + pl-rule2 = 6.5',
    near(g0.json.summary.directManDays.expected, 6.5, 1e-9), g0.json.summary.directManDays);
  ok('R-08 自检集合含未估算计划（visiblePlans=7：6 normal + 1 milestone）',
    g0.json.checks.visiblePlans === 7, g0.json.checks);
  // 引擎的排除分类按「先未估算、再小计/里程碑」计数：未估算的里程碑行归 unEstimated（5=4 明细+1 里程碑），
  // 里程碑一旦有了估算值才记进 excluded.milestone（R-53 断言那一支）
  ok('R-09 未估算计划计入自检（unEstimated=5），里程碑不进 countedKeys',
    g0.json.summary.ratioCheck.excluded.unEstimated === 5
    && !(g0.json.summary.countedKeys ?? []).includes('pl-ms'), g0.json.summary.ratioCheck);
  ok('R-10 sumRatio 恒等自检不报错（danger=false，偏差 <1%）',
    g0.json.summary.ratioCheck.danger === false && near(g0.json.summary.ratioCheck.sumRatio, 1, 1e-6),
    g0.json.summary.ratioCheck);
  ok('R-11 脱离计划的估算行 =1（不进明细也不进 Σ）',
    g0.json.checks.detached === 1 && !items0.some((i: any) => i.plan_id === 'pl-gone'), g0.json.checks);
  ok('R-12 归档计划不进 Σ（pl-arch 缺席骨架）', g0.json.checks.coverage.normal === 6);

  // R13 derive 预览默认不落库
  const dv = await api('POST', '/api/estimates/derive', { projectId: PID });
  ok('R-13 POST /derive 默认 dryRun 且 written=0',
    dv.status === 200 && dv.json?.dryRun === true && dv.json?.written === 0 && dv.json?.items?.length === 7, dv.json?.dryRun);
  const g1 = await api('GET', `/api/estimates${Q}`);
  ok('R-14 预览之后库里行数不变（(project,plan) 仍 2 行）', g1.json?.items?.length === 2);
  const dvm = dv.json?.items?.find((i: any) => i.planId === 'pl-ms');
  ok('R-15 预览里里程碑带参考值但 skip=milestone', dvm?.skip === 'milestone' && dvm?.writable === false && near(dvm.expected, 5.5, 1e-9));

  // R16 落库
  const dw = await api('POST', '/api/estimates/derive', { projectId: PID, dryRun: false });
  ok('R-16 dryRun:false 落库 4 行并回传 planIds',
    dw.json?.dryRun === false && dw.json?.written === 4 && dw.json?.writtenPlanIds?.length === 4 && dw.json?.errors?.length === 0,
    { written: dw.json?.written, ids: dw.json?.writtenPlanIds });
  const g2 = await api('GET', `/api/estimates${Q}`);
  const byId = new Map((g2.json?.items ?? []).map((i: any) => [i.plan_id, i]));
  ok('R-17 落库后 6 行：新增 4 行 source=rule',
    g2.json.items.length === 6 && byId.get('pl-c3')?.source === 'rule' && byId.get('pl-dur')?.source === 'rule');
  ok('R-18 落库值与预览逐值相等（REST 不改口径）',
    byId.get('pl-c3')?.optimistic === 3.5 && byId.get('pl-c3')?.likely === 3.5 && byId.get('pl-c3')?.pessimistic === 5.5
    && byId.get('pl-case')?.phase === 'dev' && byId.get('pl-dur')?.phase === 'impl', byId.get('pl-c3'));
  ok('R-19 人工行原值未动（3/4/8）',
    byId.get('pl-man')?.optimistic === 3 && byId.get('pl-man')?.likely === 4 && byId.get('pl-man')?.pessimistic === 8);
  ok('R-20 里程碑仍无估算行（derive 限定 normal）且不在 Σ 里',
    !byId.has('pl-ms') && !(g2.json.summary.countedKeys ?? []).includes('pl-ms')
    && g2.json.summary.ratioCheck.excluded.unEstimated === 1, g2.json.summary.ratioCheck);
  ok('R-21 汇总随落库更新：E = 6.5 + 3.8333+1.0833+3.75+7.25 = 22.4166667',
    near(g2.json.summary.directManDays.expected, 22.416666666666668, 1e-9), g2.json.summary.directManDays);
  ok('R-22 覆盖面收口：estimated=6 / missing=0',
    g2.json.checks.coverage.estimated === 6 && g2.json.checks.coverage.missing === 0, g2.json.checks.coverage);
  const sum = g2.json.summary;
  const normalSum = (g2.json.items as any[]).reduce((a, i) => a + expected({ optimistic: i.optimistic, likely: i.likely, pessimistic: i.pessimistic }), 0);
  ok('R-23 Σ(全部估算行) = Σ(仅 normal 行) —— 没有第二处把里程碑算进去', near(sum.directManDays.expected, normalSum, 1e-9));

  // R24 PATCH 单行 + 人工转 manual
  const p1 = await api('PATCH', `/api/estimates/pl-c3${Q}`, { optimistic: 4, likely: 5, pessimistic: 6 });
  ok('R-24 PATCH 单行成功并回视图行', p1.status === 200 && p1.json?.item?.optimistic === 4 && p1.json?.item?.planTitle === '需求分析-复杂度3');
  ok('R-25 人工改过即转 manual（§4.6：不转则复核率虚高）', p1.json?.item?.source === 'manual', p1.json?.item?.source);
  const p2 = await api('PATCH', `/api/estimates/pl-c3${Q}`, { likely: 5, source: 'rule' });
  ok('R-26 显式 source 优先（AI/批量通道仍可写回 rule）', p2.json?.item?.source === 'rule');
  const p3 = await api('PATCH', `/api/estimates/pl-c3${Q}`, { optimistic: 9, likely: 5, pessimistic: 6 });
  ok('R-27 三点校验走 400 中文文案（O>M）',
    p3.status === 400 && String(p3.json?.error).includes('乐观值'), p3.json);
  const p4 = await api('PATCH', `/api/estimates/pl-nope${Q}`, { optimistic: 1, likely: 1, pessimistic: 1 });
  ok('R-28 不存在的计划报错', p4.status === 400 && String(p4.json?.error).includes('计划条目不存在'), p4.json);

  // R29 批量
  const b1 = await api('POST', '/api/estimates/batch', {
    projectId: PID,
    items: [{ planId: 'pl-c1', phase: 'design', optimistic: 1, likely: 2, pessimistic: 3 },
      { planId: 'pl-dur', optimistic: 9, likely: 1, pessimistic: 2 }],
  });
  ok('R-29 批量任一行不合格 → 零写入 + 行级错误（带 index/planId）',
    b1.status === 200 && b1.json?.written === 0 && b1.json?.errors?.length === 1
    && b1.json.errors[0].index === 1 && b1.json.errors[0].planId === 'pl-dur', b1.json);
  const g3 = await api('GET', `/api/estimates${Q}`);
  const byId3 = new Map((g3.json?.items ?? []).map((i: any) => [i.plan_id, i]));
  ok('R-30 零写入是真的：同行批次的 pl-c1 未变（仍是 derive 的 1/1/1.5）',
    byId3.get('pl-c1')?.likely === 1 && byId3.get('pl-c1')?.pessimistic === 1.5);
  const b2 = await api('POST', '/api/estimates/batch', {
    projectId: PID, items: [{ planId: 'pl-c1', phase: 'design', optimistic: 1, likely: 2, pessimistic: 3 }],
  });
  ok('R-31 批量 mode=set 正常写入', b2.json?.written === 1 && b2.json?.errors?.length === 0, b2.json);
  const b3 = await api('POST', '/api/estimates/batch', { projectId: PID, mode: 'explode', items: [] });
  ok('R-32 未知批量模式报错', b3.status === 400 && String(b3.json?.error).includes('批量模式'), b3.json);
  const b4 = await api('POST', '/api/estimates/batch', { projectId: PID, mode: 'set', items: [] });
  ok('R-33 空批量内容报错（不是静默成功）', b4.status === 400 && String(b4.json?.error).includes('批量写入内容为空'), b4.json);
  const b5 = await api('POST', '/api/estimates/batch', { projectId: PID, mode: 'derive', dryRun: true });
  ok('R-34 mode=derive + dryRun 只预览（written=0）', b5.json?.mode === 'derive' && b5.json?.dryRun === true && b5.json?.written === 0);

  // R35 参数读写
  const pu = await api('PUT', `/api/estimates/params${Q}`, {
    settings: { 'estimate.manDaysPerManMonth': '20', 'estimate.coef.scope': '0.1', 'estimate.rule.default.ratio': '1:4:1.2' },
  });
  ok('R-35 PUT /params 落配置并回读生效',
    pu.status === 200 && pu.json?.config?.manDaysPerManMonth === 20 && pu.json?.config?.coefs?.scope === 0.1
    && pu.json?.config?.ruleRatio?.pMul === 1.2, pu.json?.config);
  const g4 = await api('GET', `/api/estimates${Q}`);
  ok('R-36 人月换算按新参数走（÷20 而非 ÷20.83）',
    near(g4.json.summary.idealManMonths.expected, g4.json.summary.directManDays.expected / 20, 1e-9),
    g4.json.summary.idealManMonths);
  const bad = await api('PUT', `/api/estimates/params${Q}`, {
    settings: { 'estimate.manDaysPerManMonth': '25', 'estimate.rule.default.ratio': '1:5:1.6' },
  });
  ok('R-37 比例中段非 4 → 400 且整批零写入（一位小数写歪就是钱）',
    bad.status === 400 && String(bad.json?.error).includes('PERT') && bad.json?.error !== undefined, bad.json);
  const g5 = await api('GET', `/api/estimates/params${Q}`);
  ok('R-38 失败批次里合法键也没落库（manDays 仍 20）',
    g5.json?.config?.manDaysPerManMonth === 20, g5.json?.config);
  const unk = await api('PUT', `/api/estimates/params${Q}`, { settings: { 'estimate.nope': '1' } });
  ok('R-39 未知参数键拒绝', unk.status === 400 && String(unk.json?.error).includes('未知估算参数键'), unk.json);
  const kpu = await api('PUT', `/api/estimates/params${Q}`, { settings: { [`estimate.caseWeightK.${PID}`]: '1' } });
  ok('R-40 项目级 k 覆盖生效（§4.6 规则2「项目级可配」）',
    kpu.status === 200 && kpu.json?.caseWeightK?.k === 1 && kpu.json?.caseWeightK?.from === 'project', kpu.json?.caseWeightK);
  const dK = await api('POST', '/api/estimates/derive', { projectId: PID, dryRun: true, scope: 'all', planIds: ['pl-case'] });
  const cse = dK.json?.items?.[0];
  ok('R-41 derive 走项目级 k：M=grid(6.5×1)=6.5、P=grid(6.5×1.2)=8',
    cse?.likely === 6.5 && cse?.pessimistic === 8, cse);
  const badK = await api('PUT', `/api/estimates/params${Q}`, { settings: { 'estimate.caseWeightK': '0' } });
  ok('R-42 k=0 拒绝（正数才有效）', badK.status === 400 && String(badK.json?.error).includes('正数'), badK.json);
  const clr = await api('PUT', `/api/estimates/params${Q}`, {
    settings: { 'estimate.manDaysPerManMonth': '', 'estimate.coef.scope': '', 'estimate.rule.default.ratio': '', 'estimate.hideCoefsForClient': 'true' },
  });
  ok('R-43 传空串=回落默认，脱敏开关可开',
    clr.status === 200 && clr.json?.config?.manDaysPerManMonth === 20.83 && clr.json?.config?.coefs?.scope === 0.05
    && clr.json?.config?.hideCoefsForClient === true, clr.json?.config);

  // R44 快照与 compare
  const sn = await api('GET', `/api/estimates/snapshots${Q}`);
  ok('R-44 快照列表按时间倒序（最近 20 条口径）',
    sn.status === 200 && sn.json?.snapshots?.length === 2 && sn.json.snapshots[0].id === 'sn-b');
  const cmp = await api('GET', `/api/estimates/snapshots${Q}&compare=sn-a,sn-b`);
  const dev = cmp.json?.compare?.diff?.phases?.find((p: any) => p.phase === 'dev');
  ok('R-45 compare 两版差异：dev E 10→12（Δ2）、人天合计 Δ4、人月合计 Δ0.4',
    cmp.status === 200 && near(dev?.expected?.delta, 2, 1e-9)
    && near(cmp.json.compare.diff.totals.directManDays, 4, 1e-9)
    && near(cmp.json.compare.diff.totals.actualManMonths, 0.4, 1e-9), cmp.json?.compare?.diff);
  const cmpBad = await api('GET', `/api/estimates/snapshots${Q}&compare=sn-a`);
  ok('R-46 compare 参数非两枚报错', cmpBad.status === 400 && String(cmpBad.json?.error).includes('两个快照'), cmpBad.json);

  // R47 归档行与脱离行
  const pa = await api('PATCH', `/api/estimates/pl-arch${Q}`, { optimistic: 2, likely: 2, pessimistic: 2 });
  ok('R-47 归档计划仍可存估算（历史报价依据）', pa.status === 200 && pa.json?.item?.planArchived === 1);
  const g6 = await api('GET', `/api/estimates${Q}`);
  const g6a = await api('GET', `/api/estimates${Q}&includeArchived=1`);
  ok('R-48 默认列表/Σ 都不含归档行，includeArchived 只多列不改 Σ',
    !g6.json.items.some((i: any) => i.plan_id === 'pl-arch')
    && g6a.json.items.some((i: any) => i.plan_id === 'pl-arch')
    && near(g6.json.summary.directManDays.expected, g6a.json.summary.directManDays.expected, 1e-9),
    { a: g6.json.items.length, b: g6a.json.items.length });
  const dl = await api('GET', `/api/estimates/detach${Q}`);
  ok('R-49 脱离行单独通道可见（1 条 pl-gone）', dl.status === 200 && dl.json?.rows?.length === 1 && dl.json.rows[0].plan_id === 'pl-gone');
  const dcBad = await api('POST', '/api/estimates/detach/cleanup', { projectId: PID, ids: ['es-man'] });
  ok('R-50 清理只动确属脱离的行（在架行跳过）', dcBad.status === 200 && dcBad.json?.removed === 0, dcBad.json);
  const dc = await api('POST', '/api/estimates/detach/cleanup', { projectId: PID, ids: ['es-gone'] });
  const g7 = await api('GET', `/api/estimates${Q}`);
  ok('R-51 显式清理脱离行后 checks.detached 归零', dc.json?.removed === 1 && g7.json.checks.detached === 0, g7.json.checks);

  // R52 删除单行
  const del = await api('DELETE', `/api/estimates/pl-dur${Q}`);
  const g8 = await api('GET', `/api/estimates${Q}`);
  ok('R-52 DELETE 单行生效且汇总同步回落',
    del.json?.removed === true && g8.json.checks.coverage.missing === 1
    && near(g8.json.summary.directManDays.expected, g7.json.summary.directManDays.expected - 7.25, 1e-9),
    { before: g7.json.summary.directManDays.expected, after: g8.json.summary.directManDays.expected });

  // R53 里程碑行不能直接 PATCH 进 Σ（路由层不拦，但引擎按 kind 排除）
  const pms = await api('PATCH', `/api/estimates/pl-ms${Q}`, { optimistic: 5, likely: 5, pessimistic: 8 });
  const g9 = await api('GET', `/api/estimates${Q}`);
  ok('R-53 误给里程碑写估算也不进 Σ（planKind 排除是最后一道）',
    pms.status === 200 && near(g9.json.summary.directManDays.expected, g8.json.summary.directManDays.expected, 1e-9)
    && g9.json.summary.ratioCheck.excluded.milestone === 1);

  ok('R-54 服务日志无 estimates 相关异常', !/estimates[\s\S]{0,200}(Error|throw)/i.test(serverLog.join('')));
}

console.log(`\nPASS=${pass} FAIL=${fail}`);
child.kill();
await new Promise((r) => setTimeout(r, 300));
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* Windows 句柄未放 */ }
process.exit(fail === 0 ? 0 : 1);
