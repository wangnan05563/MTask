/**
 * T02131 门：计划回写关联通道（矩阵 + 待办 + req_ids 回填）落地验证。
 *
 * 来源：四期 K1~K8 事故——T02073 经 mtask_create_plans 回写 12 行计划，
 *   因该工具只调 PlanService.createBatch（仅写 plan_tasks，无 req_ids/linked_task_id/矩阵行），
 *   留下「计划孤岛」且当时零提示。本门验 T02131 的三处改动：
 *   ① importPrd 编号解析补第三层回落（可挂到既往导入已建的矩阵行）；
 *   ② importPrd 返回 planRowIds（下标对齐，供调用方回填依赖）+ 计划 status 透传；
 *   ③ mtask_create_plans 新增 requirements / items[].reqNos / createTasks，
 *      带任一关联字段即改走 importPrd 联动通道，并按 T01868 口径保留防重入前检；
 *      纯计划通道（无关联字段）补孤儿告警。
 *
 * 用法（Node 版本须与 better-sqlite3 预编译 ABI 对齐；启动器统一走 resolveServerLauncher，与 T02089/T02126 同口径）：
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-t02131-plan-linkage.mts
 * 环境变量：`T02131_PORT`（默认随机 39500+rand400）；`T02131_PROD_PORT`（默认 39877，生产实例只读探针，可省）；
 *            `T02131_PROD_TOKEN`（缺省从 %APPDATA%/MTask/data/tunnel/tunnel-config.json 读 accessToken）。
 *
 * 断言：
 *   S 组 源码守卫：MCP schema 三字段齐、关联路由到 importPrd、planRowIds 回传、三级编号回落、
 *                  防重入前检、孤儿告警、createBatch 纯通道未被替换、status 透传、T02122 钳位单源未被破坏。
 *   R 组 隔离实例（REST + MCP + 同库只读复核）：
 *     R-02 关联通道落库：requirements/plans/tasks 三者同建，返回 channel='prd_import'；
 *     R-03 plan.req_ids 回填且指向的矩阵行真实存在（外键完整）；
 *     R-04 待办联动：[PRD] 前缀待办 + plan.linked_task_id + tasks.req_ids 与计划同源；
 *     R-05 里程碑 child 边（T02090 区间规则在 MCP 通道同样生效）；
 *     R-06 同批 ref 依赖解析到实际落库行（用 planRowIds，不用标题匹配）；
 *     R-07 增量回写挂既有矩阵行：不新建需求、req_ids 命中旧行（第三层回落，K1~K8 的另一半成因）；
 *     R-08 引用不存在编号 → unlinkedReqNos + 告警点名（不再静默丢关联）；
 *     R-09 纯计划通道仍可用且带孤儿告警（不破坏既有轻量语义）；
 *     R-10 防重入：关联通道同样拦截重复拆解；
 *     R-11 status 透传（MCP 传 doing 不再被一律打成 todo）；
 *     R-12 收口判据：生产库副本四期未归档行中无 K/M-K 孤儿批次残留。
 *
 * 隔离纪律（skill 红线 8）：库、端口、临时文件全部临时的，不碰生产数据目录，跑完 kill + 回收。
 * 断言输出落 .workbuddy/t02131-gate-results.txt（中文 stdout 在本机 GBK 控制台会乱码，以文件为准）。
 */
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.T02131_PORT ?? 39_500 + Math.floor(Math.random() * 400));
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02131-link-'));
// 路由一律挂在 /api 下（index.ts:125）；health 探针必须打 /api/health 并校验响应体——
// 裸 /health 会命中 SPA 兜底返回 index.html 200（假绿，T02126 首轮实测踩到）。
const BASE = `http://127.0.0.1:${PORT}/api`;
process.env.MTask_DATA_DIR = DATA_DIR;

const { resolveServerLauncher } = await import('./isolated-server-launcher.mts');

let pass = 0;
let fail = 0;
const results: Array<{ name: string; ok: boolean; extra?: string }> = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) pass += 1;
  else fail += 1;
  results.push({ name, ok: cond, extra: extra === undefined ? undefined : JSON.stringify(extra).slice(0, 500) });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 300)}`}`);
};
const skipped = (name: string, why: string) => {
  results.push({ name, ok: true, extra: `SKIP: ${why}` });
  console.log(`  [SKIP] ${name}（${why}）——不计 PASS`);
};
const group = (t: string) => console.log(`\n== ${t}`);

// =====================================================================
// S 组：源码守卫
// =====================================================================
group('S 组：源码守卫（关联通道接线是否真落在代码里）');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const mcpSrc = src('server/src/mcp/server.ts');
const planServiceSrc = src('server/src/services/PlanService.ts');

ok('S-01 MCP create_plans schema 带 requirements / items[].reqNos / createTasks 三个关联入口',
  /requirements: z\.array\(z\.object\(\{/.test(mcpSrc)
  && /reqNos: z\.array\(z\.string\(\)\)\.optional\(\)/.test(mcpSrc)
  && /createTasks: z\.boolean\(\)\.optional\(\)/.test(mcpSrc));
ok('S-02 关联请求路由到 importPrd（不复制一份联动逻辑，单源）',
  /const wantLinkage = /.test(mcpSrc) && /PlanService\.importPrd\(pid, \{/.test(mcpSrc));
ok('S-03 importPrd 回传 planRowIds 且 MCP 依赖解析改用它（下标对齐，撞名让号不断链）',
  /planRowIds = planTargets\.map\(/.test(planServiceSrc) && /resolveDeps\(r\.planRowIds\)/.test(mcpSrc));
ok('S-04 编号解析第三层回落：可挂到既往导入已建的矩阵行（按项目内唯一 req_no 定位）',
  /SELECT id FROM prd_requirements WHERE project_id = \? AND req_no = \?/.test(planServiceSrc)
  && /requestedToId\.get\(n\) \?\? noToId\.get\(n\) \?\? existingReqId\(n\)/.test(planServiceSrc));
ok('S-05 关联通道保留 T01868 防重入前检（importPrd 默认让号会静默造第二条轨，必须先拒）',
  /防重入拦截/.test(mcpSrc));
ok('S-06 纯计划通道补孤儿告警（K1~K8 当时零提示）',
  /纯计划通道/.test(mcpSrc));
ok('S-07 createBatch 纯计划通道未被替换（不带关联字段时保持既有轻量语义）',
  /PlanService\.createBatch\(pid, items, \{ dupPolicy/.test(mcpSrc));
ok('S-08 importPrd 计划行 status 透传（MCP 侧 doing/done 不再一律打回 todo）',
  /status: planItems\[i\]\.status \?\? \('todo' as PlanStatus\)/.test(planServiceSrc));
ok('S-09 T02122 复杂度钳位单源未被本轮改动破坏（PlanService 内两处调用点仍在）',
  (planServiceSrc.match(/clampComplexity\(/g) ?? []).length >= 2,
  (planServiceSrc.match(/clampComplexity\(/g) ?? []).length);
ok('S-10 关联通道的编号顺延/未关联/歧义三类事实全部转成告警回传（不再只埋在返回值里）',
  /for \(const n of r\.unlinkedReqNos\) warnings\.push/.test(mcpSrc)
  && /r\.ambiguousReqNos/.test(mcpSrc) && /r\.reqNoMap\.length > 0/.test(mcpSrc));

// =====================================================================
// R 组：隔离实例
// =====================================================================
group('R 组：隔离实例（MCP 关联通道 + 直读库复核）');
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const child: ChildProcess = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT,
  env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog: string[] = [];
child.stdout?.on('data', (b: Buffer) => serverLog.push(b.toString()));
child.stderr?.on('data', (b: Buffer) => serverLog.push(b.toString()));
console.log(`隔离实例启动器：${LAUNCHER.label}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitForServer(ms = 90_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) {
        const j = (await res.json().catch(() => null)) as { service?: string } | null;
        if (j?.service === 'mtask-server') return true;
      }
    } catch { /* 还没起来 */ }
    await sleep(400);
  }
  return false;
}
async function api(method: string, path: string, json?: unknown) {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json),
  });
  let out: Record<string, any> | null = null;
  try { out = (await res.json()) as Record<string, any>; } catch { /* 非 JSON */ }
  return { status: res.status, json: out };
}

// ---- MCP 通道（streamable HTTP：SSE 帧要拼完再解析，T01490/T00978 教训）----
let sessionId = '';
let rpcId = 0;
async function mcpRaw(payload: Record<string, unknown>) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(payload),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  const frames = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
  let latest: Record<string, any> | undefined;
  try { latest = JSON.parse(frames || text); } catch { latest = undefined; }
  return latest as Record<string, any>;
}
async function mcpInit() {
  await mcpRaw({
    jsonrpc: '2.0', id: 0, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify-t02131-linkage', version: '1.0' } },
  });
  await mcpRaw({ jsonrpc: '2.0', method: 'notifications/initialized' });
}
async function callTool(name: string, args: Record<string, unknown>) {
  const body = await mcpRaw({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });
  const r = body?.result ?? {};
  return { isError: r?.isError === true, text: String(r?.content?.[0]?.text ?? ''), structured: (r?.structuredContent ?? {}) as Record<string, any> };
}

const DB_PATH = () => join(DATA_DIR, 'mtask.db');
let PID = '';
try {
  if (!(await waitForServer())) {
    ok('R-00 隔离服务启动', false, { port: PORT, log: serverLog.join('').slice(-800) });
    writeFileSync(join(ROOT, '.t02131-server-fail.log'), `port=${PORT}\n${serverLog.join('')}`);
  } else {
    ok(`R-00 隔离服务启动（临时端口 ${PORT} + 临时库）`, true);
    await mcpInit();

    const Database = (await import('better-sqlite3')).default;
    const q1 = (sql: string, ...a: unknown[]) => new Database(DB_PATH(), { readonly: true }).prepare(sql).get(...a) as any;
    const qAll = (sql: string, ...a: unknown[]) => new Database(DB_PATH(), { readonly: true }).prepare(sql).all(...a) as any[];
    const planRow = (title: string) => q1(
      'SELECT id, title, kind, status, req_ids, linked_task_id, deps FROM plan_tasks WHERE project_id = ? AND title = ? AND archived = 0', PID, title,
    );
    const parseArr = (v: unknown): string[] => {
      if (typeof v !== 'string' || !v.trim()) return [];
      try { const j = JSON.parse(v); return Array.isArray(j) ? j.map((x: any) => String(x?.id ?? x)) : []; } catch { return []; }
    };

    // ---- R-01 建隔离项目 ----
    const proj = (await api('POST', '/projects', { name: `T02131 门-计划关联 ${Date.now() % 100000}` })).json;
    PID = String(proj?.id ?? '');
    ok('R-01 创建隔离项目', !!PID, proj);

    // ---- R-02 关联通道：矩阵 + 计划 + 待办同建 ----
    const linkBatch = await callTool('mtask_create_plans', {
      projectId: PID,
      requirements: [
        { reqNo: 'REQ-001', title: '启动会材料定稿', content: 'PPT 第 3~5 页口径统一', sourceRef: '§2.1', priority: 'high' },
        { reqNo: 'REQ-002', title: '里程碑计划对齐', content: 'M1~M3 区间不重叠', sourceRef: '§3' },
      ],
      createTasks: true,
      items: [
        { title: 'K1 材料收集', durationDays: 2, reqNos: ['REQ-001'], ref: 'K1' },
        { title: 'K2 稿件撰写', durationDays: 3, reqNos: ['REQ-001', 'REQ-002'], ref: 'K2', deps: [{ ref: 'K1', type: 'serial' }], status: 'doing' },
        { title: 'K3 评审收口', durationDays: 1, reqNos: ['REQ-002'], kind: 'milestone' },
      ],
    });
    const st = linkBatch.structured;
    ok('R-02a MCP 关联通道调用成功且走 importPrd（channel=prd_import）',
      !linkBatch.isError && st?.channel === 'prd_import', { isError: linkBatch.isError, text: linkBatch.text.slice(0, 300), channel: st?.channel });
    ok('R-02b 一次调用同时建矩阵 2 行 / 计划 3 行 / 待办 3 条',
      st?.requirements === 2 && st?.plans === 3 && st?.tasks === 3,
      { requirements: st?.requirements, plans: st?.plans, tasks: st?.tasks });

    // ---- R-03 req_ids 回填且外键完整 ----
    const reqIds = qAll("SELECT id, req_no FROM prd_requirements WHERE project_id = ? AND req_no IN ('REQ-001','REQ-002')", PID)
      .reduce((m: Record<string, string>, r: any) => { m[r.req_no] = r.id; return m; }, {} as Record<string, string>);
    const k1 = planRow('K1 材料收集');
    const k2 = planRow('K2 稿件撰写');
    ok('R-03a 计划 req_ids 已回填且指向真实矩阵行（K1→REQ-001，K2→REQ-001+REQ-002）',
      !!k1 && parseArr(k1.req_ids).join() === reqIds['REQ-001']
      && !!k2 && parseArr(k2.req_ids).sort().join() === [reqIds['REQ-001'], reqIds['REQ-002']].sort().join(),
      { k1: k1?.req_ids, k2: k2?.req_ids, reqIds });
    const knownReqIds = new Set(qAll('SELECT id FROM prd_requirements WHERE project_id = ?', PID).map((r: any) => r.id));
    const dangling = qAll('SELECT title, req_ids FROM plan_tasks WHERE project_id = ? AND archived = 0', PID)
      .flatMap((p: any) => parseArr(p.req_ids).filter((rid) => !knownReqIds.has(rid)).map((rid) => `${p.title}→${rid}`));
    ok('R-03b 全库无悬空 req_ids（回填的都是存在的矩阵行）', dangling.length === 0, dangling);

    // ---- R-04 待办联动 ----
    const t1 = q1('SELECT id, title, req_ids FROM tasks WHERE id = ?', k1?.linked_task_id ?? '');
    ok('R-04a plan.linked_task_id 已回填，待办标题带 [PRD] 前缀',
      !!k1?.linked_task_id && String(t1?.title ?? '').startsWith('[PRD] '), { linked: k1?.linked_task_id, title: t1?.title });
    ok('R-04b 待办 req_ids 与计划同源（三方一致：矩阵↔计划↔待办）',
      !!t1 && parseArr(t1.req_ids).join() === reqIds['REQ-001'], { taskReqIds: t1?.req_ids });
    const taskCount = (q1("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND title LIKE '[PRD] %' AND archived = 0", PID) as { n: number }).n;
    ok('R-04c 每条计划各生成一条待办（3 条，无漏建）', taskCount === 3, { taskCount });

    // ---- R-05 里程碑 child 边（T02090 区间规则经 MCP 通道同样生效）----
    // 区间口径：里程碑之后的 normal 行才归到它下面，故 K3 放末尾、其后再来一条子行。
    const ms = await callTool('mtask_create_plans', {
      projectId: PID,
      items: [
        { title: 'M1 里程碑', durationDays: 5, kind: 'milestone', reqNos: ['REQ-002'] },
        { title: 'M1a 里程碑后子项', durationDays: 2, reqNos: ['REQ-002'] },
      ],
    });
    const m1 = planRow('M1 里程碑');
    const m1a = planRow('M1a 里程碑后子项');
    const m1aDeps = JSON.parse(m1a?.deps ?? '[]') as Array<{ id: string; type: string }>;
    ok('R-05 里程碑区间内的计划行自动补 child 边（deps 含里程碑 id）',
      !ms.isError && !!m1 && !!m1a && m1aDeps.some((d) => d.id === m1.id && d.type === 'child'),
      { m1: m1?.id, m1aDeps: m1a?.deps, text: ms.text.slice(0, 200) });

    // ---- R-06 同批 ref 依赖解析到实际落库行 ----
    const k2depsObjs = JSON.parse(k2?.deps ?? '[]') as Array<{ id: string; type: string }>;
    ok('R-06 ref 依赖解析为 K1 的实际行 id（用 planRowIds 下标对齐，非标题匹配）',
      k2depsObjs.some((d) => d.id === k1?.id && d.type === 'serial'), { k1: k1?.id, deps: k2?.deps });
    ok('R-06b 关联通道未报「依赖未解析到」',
      !((st?.warnings ?? []) as string[]).some((w) => w.includes('未解析到')), st?.warnings);

    // ---- R-07 增量回写挂既有矩阵行（第三层回落）----
    const inc = await callTool('mtask_create_plans', {
      projectId: PID,
      items: [{ title: 'K4 增量补录', durationDays: 1, reqNos: ['REQ-001'] }],
    });
    const k4 = planRow('K4 增量补录');
    ok('R-07a 不带 requirements 的增量回写仍可挂既有矩阵行（REQ-001 命中上批已建行）',
      !inc.isError && !!k4 && parseArr(k4.req_ids).join() === reqIds['REQ-001'],
      { req_ids: k4?.req_ids, expect: reqIds['REQ-001'], text: inc.text.slice(0, 200) });
    ok('R-07b 增量回写未新建矩阵行（requirements=0，不产生重复需求）',
      inc.structured?.requirements === 0, { requirements: inc.structured?.requirements });

    // ---- R-08 引用不存在编号点名 ----
    const bad = await callTool('mtask_create_plans', {
      projectId: PID,
      items: [{ title: 'K5 悬空引用', durationDays: 1, reqNos: ['REQ-999'] }],
    });
    const warn8 = ((bad.structured?.warnings ?? []) as string[]).join('；');
    ok('R-08 编号不存在 → unlinkedReqNos + 告警点名（不再静默丢关联）',
      (bad.structured?.unlinkedReqNos ?? []).includes('REQ-999') && warn8.includes('REQ-999'),
      { unlinkedReqNos: bad.structured?.unlinkedReqNos, warn8: warn8.slice(0, 200) });
    const k5 = planRow('K5 悬空引用');
    ok('R-08b 未解析的关联不落库（req_ids 仍为空，不写脏引用）', parseArr(k5?.req_ids).length === 0, { req_ids: k5?.req_ids });

    // ---- R-11 status 透传（放在纯通道用例前，互不干扰）----
    ok('R-11 关联通道 status 透传（MCP 传 doing 落库 doing，不再一律 todo）',
      k2?.status === 'doing', { status: k2?.status });

    // ---- R-09 纯计划通道保持可用 + 孤儿告警 ----
    const plain = await callTool('mtask_create_plans', {
      projectId: PID,
      items: [
        { title: 'P1 纯计划A', durationDays: 1 },
        { title: 'P2 纯计划B', durationDays: 1 },
        { title: 'P3 纯计划C', durationDays: 1 },
      ],
    });
    const plainWarn = ((plain.structured?.warnings ?? []) as string[]).join('；');
    ok('R-09a 不带关联字段仍走 createBatch 纯计划通道（既有轻量语义不破）',
      !plain.isError && plain.structured?.inserted === 3 && plain.structured?.channel === undefined,
      { text: plain.text.slice(0, 200) });
    ok('R-09b 纯计划通道补孤儿告警（提示改传 requirements/reqNos）',
      plainWarn.includes('纯计划通道') && plainWarn.includes('requirements'), { plainWarn: plainWarn.slice(0, 250) });
    const p1 = planRow('P1 纯计划A');
    ok('R-09c 纯计划通道确实无关联（req_ids 空、无待办）——告警与事实一致',
      !!p1 && parseArr(p1.req_ids).length === 0 && !p1.linked_task_id, { req_ids: p1?.req_ids, linked: p1?.linked_task_id });

    // ---- R-10 关联通道防重入 ----
    const planCountBefore = (q1('SELECT COUNT(*) AS n FROM plan_tasks WHERE project_id = ? AND archived = 0', PID) as { n: number }).n;
    const reRun = await callTool('mtask_create_plans', {
      projectId: PID,
      createTasks: true,
      items: [
        { title: 'K1 材料收集', durationDays: 2, reqNos: ['REQ-001'] },
        { title: 'K2 稿件撰写', durationDays: 3, reqNos: ['REQ-001'] },
        { title: 'K3 评审收口', durationDays: 1, reqNos: ['REQ-002'] },
      ],
    });
    const planCountAfter = (q1('SELECT COUNT(*) AS n FROM plan_tasks WHERE project_id = ? AND archived = 0', PID) as { n: number }).n;
    ok('R-10 同一份拆解重复回写在关联通道同样被防重入拦截（importPrd 让号会静默造第二条轨，必须先拒）',
      reRun.isError && reRun.text.includes('防重入拦截'), { isError: reRun.isError, text: reRun.text.slice(0, 250) });
    ok('R-10b 拦截后零落库（计划行数与拦截前一致）',
      planCountAfter === planCountBefore && planCountBefore === 10, { planCountBefore, planCountAfter });

    // ---- R-12 生产库副本收口判据（只读，四期 K/M-K 孤儿批次已归档）----
    try {
      const prodDbPath = join(process.env.APPDATA ?? '', 'MTask', 'data', 'mtask.db');
      if (!existsSync(prodDbPath)) {
        skipped('R-12 生产库副本：四期未归档行无 K/M-K 孤儿批次', `生产库不存在（${prodDbPath}）`);
      } else {
        const FOUR = 'a9911922-3f07-47a3-bc7b-bb4aac62bc16';
        const srcDb = new Database(prodDbPath, { readonly: true });
        const copyPath = join(DATA_DIR, 'prod-copy.db');
        await srcDb.backup(copyPath);
        const dst = new Database(copyPath, { readonly: true });
        const liveOrphan = (dst.prepare(
          "SELECT COUNT(*) AS n FROM plan_tasks WHERE project_id = ? AND archived = 0 AND (title LIKE 'K%' OR title LIKE 'M-K%')",
        ).get(FOUR) as { n: number }).n;
        const archivedOrphan = (dst.prepare(
          "SELECT COUNT(*) AS n FROM plan_tasks WHERE project_id = ? AND archived = 1 AND created_at = '2026-10-12T14:30:16.529Z'",
        ).get(FOUR) as { n: number }).n;
        ok('R-12a 生产库四期未归档行中无 K/M-K 孤儿批次（本单收口判据）', liveOrphan === 0, { liveOrphan });
        ok('R-12b 归档可逆留痕：K1~K8 + M-K1~M-K4 整批 12 行在归档态可查（软删而非硬删）', archivedOrphan === 12, { archivedOrphan });
        dst.close();
        srcDb.close();
      }
    } catch (e) {
      skipped('R-12 生产库副本收口判据', `生产库不可读：${(e as Error).message}`);
    }
  }
} catch (e) {
  ok('R 组执行异常', false, { error: (e as Error).message, stack: (e as Error).stack?.slice(0, 500) });
} finally {
  try { child.kill(); } catch { /* 已退出 */ }
  try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
}

// =====================================================================
// 汇总 + 落盘（GBK 控制台规避：以文件为权威）
// =====================================================================
const summary = `T02131 计划回写关联通道（矩阵/待办/req_ids）：PASS=${pass} FAIL=${fail}\n`
  + results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.extra ? ` :: ${r.extra}` : ''}`).join('\n') + '\n';
mkdirSync(join(ROOT, '.workbuddy'), { recursive: true });
writeFileSync(join(ROOT, '.workbuddy', 't02131-gate-results.txt'), summary, 'utf8');
writeFileSync(join(ROOT, '.workbuddy', 't02131-gate-results.json'), JSON.stringify({ pass, fail, results }, null, 2), 'utf8');
console.log(`\n${summary}`);

for (let i = 0; i < 5; i++) {
  try { rmSync(DATA_DIR, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
}
process.exit(fail === 0 ? 0 : 1);
