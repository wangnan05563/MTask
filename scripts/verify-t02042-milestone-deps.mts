/**
 * T02090（里程碑无进度聚合且 PRD 导入行缺 child 边）验收门。
 *
 * T02293 批㉕ 改判：S 组 8 条源码守卫（S-02~S-09）原本是「读工作树源码 + 正则匹配标识符」的裸字面锚，
 *   红的时候读不出是功能失守还是等价重构。现全部降级为 `okPair` 的字面腿，并：
 *   ① 取证面改 `git show HEAD:`（反模式 11：工作树可能躺着并发会话的过期产品文件）+ S-00 取证非空自证；
 *   ② 每条配一条独立行为腿，行为腿只读 R/U 组实测料（`BEV` 袋，配对项声明在证据之后，反模式 14）；
 *   ③ 为 S-06 补 R-16（启动对账排除聚合作主）——用启动日志的对账行数把「排除/未排除」两种世界分开，
 *      为 S-09 补 R-17（待办状态变更 → 关联计划 → 父里程碑重算）——旧 R 组只覆盖了 plan→task 方向；
 *   ④ N 组负对照扩到 10 条：空源码、HEAD 在场、逐锚改名/注入（自证变异已落地）、抽干实测料、
 *      按类破坏行为腿。
 *
 * 用法（Node 版本须与 better-sqlite3 的 ABI 对齐；启动器统一走 resolveServerLauncher，与 T02089 同口径）：
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-t02042-milestone-deps.mjs
 * 环境变量：`T02042_PORT`（默认随机 39000+rand1000）。
 *
 * 覆盖任务书验收口径：
 *   U 组 单元：parsePlanDeps 保留 child（不再并成 serial）、child 不阻塞排水、addChildEdge 幂等、
 *               intervalChildEdges 区间规则（daily/首个里程碑前的 normal 不归属）；
 *   S 组 源码守卫：parsePlanDeps 三型、rescheduleDependents 走单源且跳过 child、
 *               importPrd 补边走共享模块、启动对账接线、syncPlanOnStatusChange 接线、无 childParentIdOf 残留；
 *   R 组 隔离实例 REST：导入 1 里程碑 + 2 子项 PRD → child 边落库 + 包络收口；
 *               progress 0→50→100 随子项 done 数；全 done 才 status=done；
 *               红线：子项未动时里程碑不得 100%（人工置 done 被聚合拉回）；
 *               联动顺序：里程碑自动 done → 关联待办 ai_state=unread（非静默 done）；
 *               child 边不阻塞排水（子项在里程碑 doing 时仍就绪）；
 *               重排不污染：改里程碑开始日，子项 start 不被对齐；
 *               reuse 重导幂等（边不重复、T01875 进度保护）；
 *               启动对账：直写库绕过钩子后，重启按子项实况收敛。
 *
 * 断言输出落文件（.workbuddy/t02090-gate-results-<运行标识>.txt/json）——中文 stdout 在本机 GBK 控制台会乱码，
 * 以文件读取为准。隔离纪律（skill 红线 8）：库与端口都是临时的，不碰生产数据目录；跑完 kill + 回收。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';
import { okPair } from './lib/anchor-pair.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 反模式 1：TMP 指 C: 会假性 SQLITE_FULL，临时根优先 D:
const TMP_ROOT = existsSync('D:/code/tmp') ? 'D:/code/tmp' : tmpdir();
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't02090-gate-'));
const PORT = Number(process.env.T02042_PORT ?? 39000 + Math.floor(Math.random() * 1000));

// ---------- 断言收集（落文件，规避 GBK 控制台乱码） ----------
let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass += 1; lines.push(`[PASS] ${name}`); } else {
    fail += 1;
    lines.push(`[FAIL] ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra).slice(0, 400)}` : ''}`);
  }
};
const group = (t: string) => lines.push(`\n=== ${t} ===`);
const info = (t: string) => lines.push(`  [INFO] ${t}`);

const { parsePlanDeps, depsSatisfied } = await import('../server/src/util/planDeps.ts');
const MC = await import('../server/src/util/milestoneChild.ts');
const { resolveServerLauncher } = await import('./isolated-server-launcher.mts');

/** 反模式 11：字面腿取证面取已提交树（工作树可能躺着并发会话的过期产品文件）；取不到即空串 */
const headSrc = (rel: string) => {
  try { return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }); } catch { return ''; }
};
/** T02293 批㉕：S 组字面锚的行为腿只读这张实测料表（R/U 组跑到证据即写入；N 组抽干后必须全部转假） */
const BEV: Record<string, boolean> = {};

// ---------------------------------------------------------------------------
// U 组：单元（纯函数，不起服务）
// ---------------------------------------------------------------------------
group('U 组 单元：planDeps 三型 + milestoneChild 纯函数');
{
  const deps = parsePlanDeps(JSON.stringify([
    { id: 'm1', type: 'child' },
    { id: 's1', type: 'serial' },
    { id: 'n1' },
    { id: 'p1', type: 'parallel' },
  ]));
  ok('U-01 parsePlanDeps 保留 child 为独立类型（旧实现并成 serial 会造成倒挂卡死）',
    deps.length === 4 && deps[0].type === 'child' && deps[1].type === 'serial' && deps[2].type === 'serial' && deps[3].type === 'parallel',
    deps);
  // 原 S-01 是源码正则（归一映射的具体写法）；改打纯函数：child 保留、缺失/脏值保守落 serial
  const norm = parsePlanDeps(JSON.stringify([{ id: 'c', type: 'child' }, { id: 'm' }, { id: 'z', type: 'weird' }, { id: 'k', type: 'parallel' }]));
  ok('U-01b 类型归一（行为腿）：child 保留、parallel 保留、缺失与脏值一律保守归 serial',
    norm.map((d) => d.type).join() === 'child,serial,serial,parallel', norm);
  const stTodo = new Map([['m1', 'todo'], ['s1', 'todo'], ['n1', 'done'], ['p1', 'todo']]);
  ok('U-02 depsSatisfied：child 边不阻塞排水（归属边不是排期依赖）',
    depsSatisfied([{ id: 'm1', type: 'child' }], stTodo) === true);
  ok('U-03 depsSatisfied：serial 前置未完成仍阻塞（回归防线，防止放宽过头）',
    depsSatisfied([{ id: 's1', type: 'serial' }], stTodo) === false);

  const raw = JSON.stringify([{ id: 's1', type: 'serial' }]);
  const once = MC.addChildEdge(raw, 'm1');
  const twice = MC.addChildEdge(once, 'm1');
  ok('U-04 addChildEdge 幂等：二次调用零 diff（补边脚本连跑两次一致的根据）', once === twice && MC.hasChildEdge(once, 'm1'));
  ok('U-05 addChildEdge 并集保留既有边与原顺序', JSON.parse(once)[0].id === 's1' && JSON.parse(once)[1].type === 'child');
  ok('U-06 addChildEdge 空 deps 也能建边', JSON.parse(MC.addChildEdge('', 'm1'))[0].type === 'child');
  const childParentIdsWorks = MC.childParentIds(JSON.stringify([{ id: 'x', type: 'serial' }, { id: 'm', type: 'child' }])).join() === 'm';
  ok('U-07 childParentIds 只取 child 边', childParentIdsWorks);
  BEV.childParentIdsWorks = childParentIdsWorks;
  BEV.childKeptBySharedParser = deps[0].type === 'child' && norm[0].type === 'child';

  const items = [
    { kind: 'normal' },  // 0：首个里程碑之前 → 无归属
    { kind: 'milestone' }, // 1：M
    { kind: 'normal' },  // 2 → 父 1
    { kind: 'normal' },  // 3 → 父 1
    { kind: 'milestone' }, // 4：M2
    { kind: 'daily' },   // 5：日常 → 不归属
    { kind: 'normal' },  // 6 → 父 4
  ];
  const edges = MC.intervalChildEdges(items);
  ok('U-08 intervalChildEdges 区间规则：里程碑后、下一里程碑前的 normal 归其下；daily 与首里程碑前的 normal 不归属',
    edges.length === 3 && edges[0].index === 2 && edges[0].parentIndex === 1 && edges[1].index === 3 && edges[2].index === 6 && edges[2].parentIndex === 4,
    edges);
}

// ---------------------------------------------------------------------------
// S 组：源码守卫（单源接线，防回归）
//   本组的 8 条字面锚不在此处判定——行为证据要到 R 组才存在（反模式 14），
//   配对项统一列在 R-17 之后的「S 组 源码守卫（改判：行为腿 + 字面腿）」小节。
// ---------------------------------------------------------------------------
group('S 组 源码守卫（见 R 组之后的配对小节）');

// ---------------------------------------------------------------------------
// R 组：隔离实例 REST
// ---------------------------------------------------------------------------
group('R 组 隔离实例 REST');
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
info(`启动器：${LAUNCHER.label}`);
const child = spawn(LAUNCHER.exec, [...LAUNCHER.tsx], {
  cwd: ROOT,
  env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog: string[] = [];
let childExit = 'running';
let child2: ReturnType<typeof spawn> | null = null;
child.on('exit', (code: number | null, signal: string | null) => { childExit = `code=${code} signal=${signal}`; });
child.on('error', (e: Error) => serverLog.push(`spawn-error: ${e.message}`));
child.stdout?.on('data', (b: Buffer) => serverLog.push(b.toString()));
child.stderr?.on('data', (b: Buffer) => serverLog.push(b.toString()));
const BASE = `http://127.0.0.1:${PORT}`;

async function waitForServer(ms = 60_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const res = await fetch(`${BASE}/api/health`); if (res.ok) return true; } catch { /* 未起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
const planOf = (rows: any[], titlePart: string) => rows.find((r) => String(r.title).includes(titlePart));

if (!(await waitForServer())) {
  ok('R-00 隔离服务启动', false, { exit: childExit, port: PORT, log: serverLog.join('').slice(-800) });
  writeFileSync(join(ROOT, '.t02090-server-fail.log'), `exit=${childExit} port=${PORT}\n${serverLog.join('')}`);
  child.kill();
  finish(1);
} else {
  ok(`R-00 隔离服务启动（临时端口 ${PORT} + 临时库 ${DATA_DIR}）`, true);
}

// ---- R-01~R-04：导入 1 里程碑 + 2 子项 ----
const proj = (await api('POST', '/projects', { name: 'T02090 门-里程碑聚合' })).json;
const PID = String(proj?.id ?? '');
ok('R-01 创建隔离项目', !!PID, proj);

const PLANS = [
  { title: '1 M1 里程碑甲', kind: 'milestone', durationDays: 5, startDate: '2026-11-02', reqNos: [] },
  { title: '1.1 子任务甲', kind: 'normal', durationDays: 2, startDate: '2026-11-09', reqNos: [] },
  { title: '1.2 子任务乙', kind: 'normal', durationDays: 3, startDate: '2026-11-16', reqNos: [] },
];
const imported = await api('POST', '/plans/import-prd', { projectId: PID, plans: PLANS, createTasks: true });
ok('R-02 导入 PRD（1 里程碑 + 2 子项，含待办）',
  imported.status === 200 && imported.json?.plans === 3 && imported.json?.tasks === 3,
  { status: imported.status, plans: imported.json?.plans, tasks: imported.json?.tasks, err: imported.json?.error });

const plans = (await api('GET', `/plans?projectId=${PID}`)).json as any[];
const M1 = planOf(plans, 'M1');
const C1 = planOf(plans, '1.1');
const C2 = planOf(plans, '1.2');
ok('R-03 三条计划落库且可定位', !!M1 && !!C1 && !!C2, { M1: M1?.id, C1: C1?.id, C2: C2?.id });

const childEdgesOf = (p: any) => (parsePlanDeps(p?.deps ?? null) as Array<{ id: string; type: string }>).filter((d) => d.type === 'child');
const cR04 = childEdgesOf(C1).length === 1 && childEdgesOf(C1)[0].id === M1.id
  && childEdgesOf(C2).length === 1 && childEdgesOf(C2)[0].id === M1.id
  && childEdgesOf(M1).length === 0;
ok('R-04 PRD 导入行补 child 边（口径 A）：两个子行 deps 均含指向 M1 的 child 边，M1 自身无 child 边',
  cR04, { C1: C1?.deps, C2: C2?.deps, M1: M1?.deps });
BEV.edgesImported = cR04;

ok('R-05 导入即聚合：子项全 todo → 里程碑 progress=0 / status=todo（红线：子项未动不得 100%）',
  M1.progress === 0 && M1.status === 'todo', { progress: M1.progress, status: M1.status });

ok('R-06 包络收口（T01704 兼容）：M1 起止取自子任务包络（start=min、end=max）',
  M1.start_date === [C1.start_date, C2.start_date].sort()[0]
  && M1.end_date === [C1.end_date, C2.end_date].sort().at(-1),
  { m: [M1.start_date, M1.end_date], kids: [C1.start_date, C2.start_date, C1.end_date, C2.end_date] });

// ---- R-07：子项逐个 done → progress 0→50→100 ----
await api('PATCH', `/plans/${C1.id}`, { status: 'done' });
let p1 = (await api('GET', `/plans?projectId=${PID}`)).json as any[];
const M1a = planOf(p1, 'M1');
ok('R-07 1/2 子项 done → 里程碑 progress=50 / status=doing', M1a.progress === 50 && M1a.status === 'doing',
  { progress: M1a.progress, status: M1a.status });

await api('PATCH', `/plans/${C2.id}`, { status: 'done' });
p1 = (await api('GET', `/plans?projectId=${PID}`)).json as any[];
const M1b = planOf(p1, 'M1');
ok('R-08 2/2 子项 done → 里程碑 progress=100 / status=done（全 done 才终态）',
  M1b.progress === 100 && M1b.status === 'done', { progress: M1b.progress, status: M1b.status });
BEV.progressSteps = M1a.progress === 50 && M1a.status === 'doing' && M1b.progress === 100 && M1b.status === 'done';

// ---- R-09：联动顺序——里程碑自动 done → 关联待办 unread（非静默 done）----
const tasks = (await api('GET', `/tasks?projectId=${PID}&limit=50`)).json as any[];
const msTask = tasks.find((t) => String(t.title).includes('M1'));
ok('R-09 联动顺序：里程碑因聚合自动 done → 关联待办 status=done 且 ai_state=unread（待读，非静默 done）',
  !!msTask && msTask.status === 'done' && msTask.ai_state === 'unread',
  { task: msTask?.title, status: msTask?.status, ai_state: msTask?.ai_state });

// ---- R-10：红线守卫——人工把里程碑置回会被聚合拉回；再完成则重新 unread ----
await api('PATCH', `/plans/${C2.id}`, { status: 'todo' });
p1 = (await api('GET', `/plans?projectId=${PID}`)).json as any[];
const M1c = planOf(p1, 'M1');
ok('R-10 红线守卫：子项重开 → 里程碑聚合拉回 doing/50（人工 done 不得脱离子项实况）',
  M1c.progress === 50 && M1c.status === 'doing', { progress: M1c.progress, status: M1c.status });

const ready = (await api('GET', `/plans/ready?projectId=${PID}`)).json as any[];
const cR11 = Array.isArray(ready) && ready.some((r) => String(r.title).includes('1.2'));
ok('R-11 child 边不阻塞排水：里程碑 doing 时子项仍出现在就绪推荐（归属边不是排期依赖）',
  cR11, ready.map((r) => r.title));
BEV.childNotBlocking = cR11;

// ---- R-12：重排不污染——改里程碑开始日，子项 start 不被对齐 ----
const beforeStarts = { c1: planOf(p1, '1.1').start_date, c2: planOf(p1, '1.2').start_date };
await api('PATCH', `/plans/${M1.id}`, { startDate: '2026-12-01' });
p1 = (await api('GET', `/plans?projectId=${PID}`)).json as any[];
const cR12 = planOf(p1, '1.1').start_date === beforeStarts.c1 && planOf(p1, '1.2').start_date === beforeStarts.c2;
ok('R-12 rescheduleDependents 跳过 child 边：改里程碑开始日后子项 start 逐字段不变（旧实现会对齐成里程碑 start）',
  cR12, { before: beforeStarts, after: [planOf(p1, '1.1').start_date, planOf(p1, '1.2').start_date] });
BEV.rescheduleNoPollute = cR12;

// ---- R-13：完成收尾 + 重新 unread ----
await api('PATCH', `/plans/${C2.id}`, { status: 'done' });
p1 = (await api('GET', `/plans?projectId=${PID}`)).json as any[];
const M1d = planOf(p1, 'M1');
const tasks2 = (await api('GET', `/tasks?projectId=${PID}&limit=50`)).json as any[];
const msTask2 = tasks2.find((t) => String(t.title).includes('M1'));
ok('R-13 再次全 done → 100/done 且关联待办重新点亮 unread（新结论待读）',
  M1d.progress === 100 && M1d.status === 'done' && msTask2?.ai_state === 'unread',
  { progress: M1d.progress, status: M1d.status, ai_state: msTask2?.ai_state });

// ---- R-14：reuse 重导幂等（T01875 进度保护 + 边不重复）----
const reimport = await api('POST', '/plans/import-prd', { projectId: PID, plans: PLANS, createTasks: true, onDuplicatePlan: 'reuse' });
p1 = (await api('GET', `/plans?projectId=${PID}`)).json as any[];
const M1e = planOf(p1, 'M1');
const C1e = planOf(p1, '1.1');
const cR14 = reimport.json?.reusedPlans === 3 && reimport.json?.plans === 0
  && childEdgesOf(C1e).length === 1 && M1e.progress === 100 && M1e.status === 'done';
ok('R-14 reuse 重导幂等：不新建行（reusedPlans=3/inserted=0）、子行 child 边仍恰好 1 条、里程碑进度不被重置',
  cR14, { reused: reimport.json?.reusedPlans, inserted: reimport.json?.plans, edges: childEdgesOf(C1e).length, progress: M1e.progress, status: M1e.status });
BEV.edgesIdempotent = cR14;

// ---- R-17：待办状态变更 → 关联计划 → 父里程碑重算（S-09 的接线方向；旧 R 组只覆盖 plan→task 反向）----
const c1Task = tasks.find((t) => String(t.title).includes('1.1'));
await api('PATCH', `/tasks/${c1Task?.id}`, { status: 'todo' });
const pR17 = (await api('GET', `/plans?projectId=${PID}`)).json as any[];
const C1g = planOf(pR17, '1.1'); const M1g = planOf(pR17, 'M1');
const cR17 = C1g?.status === 'doing' && M1g?.progress === 50 && M1g?.status === 'doing';
ok('R-17 待办 1.1 重开 → 关联计划转 doing → 父里程碑按子项实况回到 50/doing（syncPlanOnStatusChange 里 recalcMilestonesOfChild 的接线）',
  cR17, { task: c1Task?.title, plan: [C1g?.status, C1g?.progress], ms: [M1g?.status, M1g?.progress] });
await api('PATCH', `/tasks/${c1Task?.id}`, { status: 'done' });
const pR17b = (await api('GET', `/plans?projectId=${PID}`)).json as any[];
const M1h = planOf(pR17b, 'M1');
const cR17b = M1h?.status === 'done' && M1h?.progress === 100;
ok('R-17b 同一接线的反向：待办重新 done → 计划 done → 里程碑回到 100/done',
  cR17b, { ms: [M1h?.status, M1h?.progress] });
BEV.taskToMilestoneRecalc = cR17 && cR17b;

// ---- R-16 夹具：无子项计划 2.2（排在首个里程碑之前，按区间规则不归属）+ 带子项的里程碑 M2（子项 2.1 未完成），
//      两者的关联待办随后直写成 done ----
const PLANS2 = [
  { title: '2.2 独立任务丁', kind: 'normal', durationDays: 1, startDate: '2027-01-01', reqNos: [] },
  { title: '2 M2 里程碑乙', kind: 'milestone', durationDays: 4, startDate: '2027-01-05', reqNos: [] },
  { title: '2.1 子任务丙', kind: 'normal', durationDays: 2, startDate: '2027-01-12', reqNos: [] },
];
const imported2 = await api('POST', '/plans/import-prd', { projectId: PID, plans: PLANS2, createTasks: true });
const plansB = (await api('GET', `/plans?projectId=${PID}`)).json as any[];
const M2 = planOf(plansB, 'M2'); const K2 = planOf(plansB, '2.1'); const P2 = planOf(plansB, '2.2');
const tasksB = (await api('GET', `/tasks?projectId=${PID}&limit=50`)).json as any[];
const m2Task = tasksB.find((t) => String(t.title).includes('M2'));
const p2Task = tasksB.find((t) => String(t.title).includes('2.2'));
ok('R-16a 第二组夹具导入：M2 里程碑 + 子项 2.1 + 无子项计划 2.2 各带一条关联待办',
  imported2.json?.plans === 3 && !!M2 && !!K2 && !!P2 && !!m2Task && !!p2Task,
  { plans: imported2.json?.plans, M2: !!M2, K2: !!K2, P2: !!P2, m2Task: !!m2Task, p2Task: !!p2Task });

// ---- R-15：启动对账——直写库绕过钩子后重启收敛 ----
{
  let rawDbOk = true;
  try {
    const Database = (await import('better-sqlite3')).default;
    const raw = new Database(join(DATA_DIR, 'mtask.db'));
    raw.pragma('busy_timeout = 8000');
    const ts = new Date().toISOString();
    raw.prepare("UPDATE plan_tasks SET status = 'todo', progress = 0, updated_at = ? WHERE id = ?").run(ts, M1.id); // 模拟 AI/脚本直写：绕过全部聚合钩子
    // R-16 漂移现场：M2（带子项）与 2.2（无子项）的关联待办都置 done、计划行都置 todo/0——
    // 这正是 reconcileLinkedPlanStatuses 的候选集；启动对账只允许对齐 2.2，M2 由进度聚合作主。
    raw.prepare("UPDATE tasks SET status = 'done' WHERE id IN (?, ?)").run(m2Task.id, p2Task.id);
    raw.prepare("UPDATE plan_tasks SET status = 'todo', progress = 0, updated_at = ? WHERE id IN (?, ?)").run(ts, M2.id, P2.id);
    raw.close();
  } catch (e) {
    rawDbOk = false;
    ok('R-15a 直写库生效（绕过钩子的漂移现场复现）', false, String(e));
  }
  if (rawDbOk) {
    const p2 = (await api('GET', `/plans?projectId=${PID}`)).json as any[];
    const t2 = (await api('GET', `/tasks?projectId=${PID}&limit=50`)).json as any[];
    const m2Now = planOf(p2, 'M2'); const p2Now = planOf(p2, '2.2');
    const m2TaskNow = t2.find((t) => String(t.title).includes('M2'));
    const p2TaskNow = t2.find((t) => String(t.title).includes('2.2'));
    ok('R-15a 直写库生效（绕过钩子的漂移现场复现：里程碑被改成 todo/0 而子项仍全 done）',
      planOf(p2, 'M1').status === 'todo' && planOf(p2, 'M1').progress === 0);
    const cR16Pre = m2Now?.status !== 'done' && m2TaskNow?.status === 'done'
      && p2Now?.status !== 'done' && p2TaskNow?.status === 'done';
    ok('R-16b 漂移现场就位：M2 / 2.2 两条计划都「自身非 done 而关联待办 done」——启动对账的候选集',
      cR16Pre, { M2: [m2Now?.status, m2TaskNow?.status], P2: [p2Now?.status, p2TaskNow?.status] });

  // 同库再起一个实例（不同端口）：启动对账应把里程碑按子项实况收敛回 done/100，并点亮待办 unread
  const PORT2 = PORT + 1;
  child2 = spawn(LAUNCHER.exec, [...LAUNCHER.tsx], {
    cwd: ROOT,
    env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT2), MTask_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log2: string[] = [];
  child2.stdout?.on('data', (b: Buffer) => log2.push(b.toString()));
  child2.stderr?.on('data', (b: Buffer) => log2.push(b.toString()));
  const BASE2 = `http://127.0.0.1:${PORT2}`;
  let up2 = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    try { if ((await fetch(`${BASE2}/api/health`)).ok) { up2 = true; break; } } catch { /* 未起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (up2) {
    const p3 = (await fetch(`${BASE2}/api/plans?projectId=${PID}`).then((r) => r.json())) as any[];
    const M1f = planOf(p3, 'M1');
    const t3 = (await fetch(`${BASE2}/api/tasks?projectId=${PID}&limit=50`).then((r) => r.json())) as any[];
    const msTask3 = t3.find((t) => String(t.title).includes('M1'));
    ok('R-15b 启动对账收敛：重启后里程碑按子项实况回到 done/100，关联待办 unread',
      M1f?.status === 'done' && M1f?.progress === 100 && msTask3?.ai_state === 'unread',
      { status: M1f?.status, progress: M1f?.progress, ai_state: msTask3?.ai_state });
    ok('R-15c 启动日志出现 milestone-progress reconcile 观测项',
      /milestone-progress reconcile/.test(log2.join('')), log2.join('').split('\n').filter((l) => /reconcile/.test(l)).slice(0, 3));
    BEV.restartConverged = !!M1f && M1f.status === 'done' && M1f.progress === 100 && msTask3?.ai_state === 'unread';
    BEV.reconcileLogSeen = /milestone-progress reconcile/.test(log2.join(''));

    // R-16c~e：启动对账的「排除聚合作主」判据。单看终态分不出两个世界（里程碑对账链末尾还会按子项重算一次），
    // 因此用 reconcileLinkedPlanStatuses 自己返回并打印的**对齐行数**做判别：正确 = 只有 2.2 被对齐（1）；
    // 排除判据失效 = M1/M2 一起被待办抢先置 done（3）。
    const p3b = (await fetch(`${BASE2}/api/plans?projectId=${PID}`).then((r) => r.json())) as any[];
    const M2f = planOf(p3b, 'M2'); const P2f = planOf(p3b, '2.2');
    const cR16c = P2f?.status === 'done' && P2f?.progress === 100;
    ok('R-16c 启动后无子项计划 2.2 被对齐成 done/100（证明 task→plan 对齐通道确实在跑，不是恒空转）',
      cR16c, { P2: [P2f?.status, P2f?.progress] });
    const cR16d = M2f?.status !== 'done' && M2f?.progress !== 100;
    ok('R-16d 启动后带子项的里程碑 M2 仍未 done（子项 2.1 未 done，红线：子项未齐不得 done/100）',
      cR16d, { M2: [M2f?.status, M2f?.progress], child: planOf(p3b, '2.1')?.status });
    const aligned = Number((log2.join('').match(/plan-task reconcile: (\d+) plan record/) ?? [])[1] ?? -1);
    const cR16e = aligned === 1;
    ok('R-16e 启动日志的对账行数恰为 1（只对齐无子项的 2.2；若 milestoneHasChildren 排除失效会变成 3）',
      cR16e, { aligned, log: log2.join('').split('\n').filter((l) => /plan-task reconcile/.test(l)) });
    BEV.reconcileExcludesMilestone = cR16Pre && cR16c && cR16d && cR16e;
  } else {
    ok('R-15b 第二实例启动（对账复验前置）', false, log2.join('').slice(-500));
  }
  child2.kill();
  }
}

// ---------------------------------------------------------------------------
// S 组 源码守卫（T02293 批㉕ 改判）：字面锚一律降级为 okPair 的字面腿，每条配独立行为腿
//   配对项声明放在 R 组之后——行为证据此时才存在（反模式 14），取值一律经 BEV 实测料表。
// ---------------------------------------------------------------------------
group('S 组 源码守卫（行为腿 + 字面腿配对）');
const HEAD_SRC: Record<string, string> = {
  plan: headSrc('server/src/services/PlanService.ts'),
  index: headSrc('server/src/index.ts'),
  task: headSrc('server/src/services/TaskService.ts'),
  mp: headSrc('server/src/services/milestoneProgress.ts'),
  mc: headSrc('server/src/util/milestoneChild.ts'),
};
const unreadLinked = msTask?.ai_state === 'unread' && msTask2?.ai_state === 'unread';
BEV.unreadLinked = unreadLinked;
interface Anchor { file: string; token: string; re: RegExp; want: boolean }
interface SPair { id: string; label: string; anchors: Anchor[]; behavior: () => boolean }
const SP: SPair[] = [
  {
    id: 'S-02',
    label: 'S-02 rescheduleDependents 无本地 parseDeps 副本（T01284 单源）',
    anchors: [
      { file: 'plan', token: 'const parseDeps =', re: /const parseDeps =/, want: false },
      { file: 'plan', token: "from '../util/planDeps'", re: /from '\.\.\/util\/planDeps'/, want: true },
    ],
    behavior: () => BEV.childNotBlocking === true && BEV.childKeptBySharedParser === true,
  },
  {
    id: 'S-03',
    label: 'S-03 rescheduleDependents 显式跳过 child 边（不对齐日期）',
    anchors: [{ file: 'plan', token: 'return null; // child', re: /rel\.type !== 'parallel'\) return null; \/\/ child/, want: true }],
    behavior: () => BEV.rescheduleNoPollute === true,
  },
  {
    id: 'S-04',
    label: 'S-04 importPrd 补边走共享模块（intervalChildEdges + addChildEdge）',
    anchors: [
      { file: 'plan', token: 'intervalChildEdges(planItems', re: /intervalChildEdges\(planItems/, want: true },
      { file: 'plan', token: 'addChildEdge(cur.deps, parentId)', re: /addChildEdge\(cur\.deps, parentId\)/, want: true },
    ],
    behavior: () => BEV.edgesImported === true && BEV.edgesIdempotent === true,
  },
  {
    id: 'S-05',
    label: 'S-05 update() 接线进度聚合（affectedMilestones + recalcMilestoneProgress）',
    anchors: [{ file: 'plan', token: 'for (const msId of affectedMilestones(row, patch)) recalcMilestoneProgress(db, msId);', re: /for \(const msId of affectedMilestones\(row, patch\)\) recalcMilestoneProgress\(db, msId\);/, want: true }],
    behavior: () => BEV.progressSteps === true,
  },
  {
    id: 'S-06',
    label: 'S-06 reconcileLinkedPlanStatuses 排除聚合作主的里程碑（milestoneHasChildren）',
    anchors: [{ file: 'plan', token: '!milestoneHasChildren(db, id)', re: /!milestoneHasChildren\(db, id\)/, want: true }],
    behavior: () => BEV.reconcileExcludesMilestone === true,
  },
  {
    id: 'S-07',
    label: 'S-07 无 childParentIdOf 残留（已由 childParentIds 取代）',
    anchors: [
      { file: 'plan', token: 'childParentIdOf', re: /childParentIdOf/, want: false },
      { file: 'mc', token: 'export function childParentIds', re: /export function childParentIds/, want: true },
    ],
    behavior: () => BEV.childParentIdsWorks === true,
  },
  {
    id: 'S-08',
    label: 'S-08 启动对账接线 reconcileMilestoneProgresses',
    anchors: [{ file: 'index', token: 'reconcileMilestoneProgresses()', re: /reconcileMilestoneProgresses\(\)/, want: true }],
    behavior: () => BEV.restartConverged === true && BEV.reconcileLogSeen === true,
  },
  {
    id: 'S-09',
    label: 'S-09 syncPlanOnStatusChange 接线 recalcMilestonesOfChild',
    anchors: [
      { file: 'task', token: 'for (const p of planRows) recalcMilestonesOfChild(db, p.id);', re: /for \(const p of planRows\) recalcMilestonesOfChild\(db, p\.id\);/, want: true },
      { file: 'task', token: "import { recalcMilestonesOfChild } from './milestoneProgress'", re: /import \{ recalcMilestonesOfChild \} from '\.\/milestoneProgress'/, want: true },
    ],
    behavior: () => BEV.taskToMilestoneRecalc === true,
  },
  {
    id: 'S-10',
    label: 'S-10 聚合模块含 unread 联动（markLinkedTaskDoneUnread）与红线口径注释',
    anchors: [
      { file: 'mp', token: 'markLinkedTaskDoneUnread', re: /markLinkedTaskDoneUnread/, want: true },
      { file: 'mp', token: '红线', re: /红线/, want: true },
    ],
    behavior: () => BEV.unreadLinked === true,
  },
];
const litOn = (spec: SPair, src: Record<string, string>) =>
  spec.anchors.every((a) => new RegExp(a.re.source, a.re.flags).test(src[a.file] ?? '') === a.want);
for (const spec of SP) {
  okPair(ok, spec.label, spec.behavior, () => litOn(spec, HEAD_SRC),
    () => ({ 行为: spec.id, 锚: spec.anchors.map((a) => ({ 文件: a.file, 期望: a.want ? '在' : '不在', 命中: new RegExp(a.re.source).test(HEAD_SRC[a.file] ?? '') })) }));
}

// N 组：批㉕ 改判的负对照（T02293 判据 4）
group('N 组 负对照');
{
  const spy: Array<{ n: string; c: boolean; e: any }> = [];
  const collect = (n: string, c: boolean, e: any) => spy.push({ n, c, e });
  const reason = (x: any) => String(x?.e?.红因 ?? '');
  const swap = (file: string, text: string) => ({ ...HEAD_SRC, [file]: text });

  // N-01 空源码探针：9 条配对项的字面腿必须全假（反模式 20——防「不含某写法」型锚拿空串恒绿）
  const emptyMap: Record<string, string> = { plan: '', index: '', task: '', mp: '', mc: '' };
  okPair(collect, 'N-01 空源码探针', () => true, () => SP.every((s) => !litOn(s, emptyMap)));
  // N-02 HEAD 在场性：五份取证对象都非空（否则 N-01 与反向锚同时失去意义）
  ok('N-02 五份 HEAD 源码都取到且非空',
    Object.entries(HEAD_SRC).every(([, v]) => v.length > 200),
    Object.fromEntries(Object.entries(HEAD_SRC).map(([k, v]) => [k, v.length])));
  // N-03 逐锚改名 / 注入：正向锚改名后字面腿必假，反向锚注入禁词后字面腿必假；先自证变异真的落了地（反模式 19）
  let tamperAll = true; const tamperDetail: string[] = [];
  for (const spec of SP) {
    for (const a of spec.anchors) {
      const orig = HEAD_SRC[a.file] ?? '';
      // 正向锚：把所有出现处整体替换成不含原串的标记（只改第一处会因重复出现而漏判；
      //   保留原串前缀同样会漏判——两字锚「红线」改名后仍含「红线」）；反向锚：注入禁词
      const tampered = a.want
        ? orig.split(a.token).join('__RENAMED__')
        : `${orig}\n/* ${a.token} 门注入的禁词 */\n`;
      const landed = a.want ? !tampered.includes(a.token) : tampered.includes(a.token);
      const stillDiffers = tampered !== orig;
      const turnedFalse = !litOn(spec, swap(a.file, tampered));
      if (!(landed && stillDiffers && turnedFalse)) { tamperAll = false; tamperDetail.push(`${spec.id}/${a.file}:${JSON.stringify({ landed, stillDiffers, turnedFalse })}`); }
    }
  }
  ok('N-03 14 个锚逐个改名/注入后字面腿必转假，且自证变异已落地', tamperAll, tamperDetail);
  // N-04 抽干实测料：10 条行为腿必须全假（防「行为腿空转」），回填后必须复原
  const keep = { ...BEV };
  for (const k of Object.keys(BEV)) BEV[k] = false;
  const drained = SP.every((s) => s.behavior() === false);
  for (const k of Object.keys(keep)) BEV[k] = keep[k];
  const restored = SP.every((s) => s.behavior() === true);
  ok('N-04 抽干 BEV 实测料后 9 条行为腿全假、回填后全真', drained && restored, { drained, restored, BEV: Object.keys(BEV).length });
  // N-05 按类破坏：单独抽掉一类证据，只有依赖它的那条配对项转假（红因落在「行为失守」）
  const breaks: Array<[string, string[]]> = [
    ['childNotBlocking', ['S-02']],
    ['rescheduleNoPollute', ['S-03']],
    ['edgesIdempotent', ['S-04']],
    ['progressSteps', ['S-05']],
    ['reconcileExcludesMilestone', ['S-06']],
    ['childParentIdsWorks', ['S-07']],
    ['reconcileLogSeen', ['S-08']],
    ['taskToMilestoneRecalc', ['S-09']],
    ['unreadLinked', ['S-10']],
  ];
  let breakAll = true; const breakDetail: string[] = [];
  for (const [key, expectRed] of breaks) {
    const v = BEV[key]; BEV[key] = false;
    const red = SP.filter((s) => !s.behavior()).map((s) => s.id);
    BEV[key] = v;
    if (red.join() !== expectRed.join()) { breakAll = false; breakDetail.push(`${key}→${red.join('|')}`); }
  }
  ok('N-05 逐类破坏行为证据后，恰好点名依赖该类的那条配对项', breakAll, breakDetail);
  // N-06 unread 联动的行为反证：把待办读数改成已读，S-10 行为腿必须转假而字面腿仍在
  const tamperedLinked = { ai_state: 'read' };
  okPair(collect, 'N-06 待办读数改成 read 后行为腿转假',
    () => tamperedLinked.ai_state === 'unread', () => litOn(SP.find((x) => x.id === 'S-10')!, HEAD_SRC));
  okPair(collect, 'N-07 okPair 契约-行为假', () => false, () => true);
  okPair(collect, 'N-08 okPair 契约-字面假', () => true, () => false);
  okPair(collect, 'N-09 okPair 契约-双真', () => true, () => true);
  ok('N-10 okPair 落地：行为失守记「行为失守」、锚子失配记「字面锚点失配」、两者齐绿才判绿',
    spy.length === 5 && spy[0].c === true
    && spy[1].c === false && reason(spy[1]).includes('行为失守') && !reason(spy[1]).includes('字面锚点')
    && spy[2].c === false && reason(spy[2]).includes('行为失守')
    && spy[3].c === false && reason(spy[3]).includes('字面锚点失配')
    && spy[4].c === true,
    spy.map((s) => ({ 条: s.n, 判: s.c, 红因: reason(s).slice(0, 40) })));
}

// ---------------------------------------------------------------------------
// 收口：落文件 + 清理
// ---------------------------------------------------------------------------
function finish(code: number): never {
  child.kill();
  child2?.kill();
  const txt = lines.join('\n') + `\n\nPASS=${pass} FAIL=${fail}\n`;
  const resultsFile = writeGateResults(join(ROOT, '.workbuddy'), 't02090-gate-results.txt', txt, { port: PORT, dataDir: DATA_DIR });
  writeGateResults(join(ROOT, '.workbuddy'), 't02090-gate-results.json', JSON.stringify({ pass, fail, lines }, null, 2), { port: PORT, dataDir: DATA_DIR });
  // Windows 下刚 kill 的实例仍短暂持有 DB 句柄，立即 rm 必败 → 阻塞退避重试几轮再放弃（失败不影响结论）
  for (let i = 0; i < 5; i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    try { rmSync(DATA_DIR, { recursive: true, force: true }); break; } catch { /* 句柄未释放，下一轮 */ }
  }
  console.log(`T02090 gate: PASS=${pass} FAIL=${fail} RESULTS=${resultsFile}`);
  process.exit(code);
}

finish(fail === 0 ? 0 : 1);
