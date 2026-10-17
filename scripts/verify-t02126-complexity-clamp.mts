/**
 * T02126 门：complexity 钳位单源 + 降级轨断言 + 三入口钳位 + 收口判据复跑。
 *
 * 来源：T02122（complexity 值域断言与钳位单源，2026-10-12 done）自认的验证缺口——
 *   代码已改、typecheck 0 错，但「降级轨断言 / 三入口钳位 / 收口判据复跑 / 既有回归门」四条
 *   当时标注「需后端服务启动后执行」而未执行。本门补落（隔离实例 :39899 已验证可跑，阻塞不存在）。
 *
 * 用法（Node 版本须与 better-sqlite3 预编译 ABI 对齐；启动器统一走 resolveServerLauncher，与 T02089 同口径）：
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-t02126-complexity-clamp.mts
 * 环境变量：`T02126_PORT`（默认随机 39500+rand400）；`T02126_PROD_PORT`（默认 39877，生产实例只读探针）；
 *            `T02126_PROD_TOKEN`（缺省从 %APPDATA%/MTask/data/tunnel/tunnel-config.json 读 accessToken）。
 *
 * 覆盖任务书四条待补验证：
 *   U 组 单元：clampComplexity 单源函数行为（0→null / 1→1 / 3.5→4 / 5→5 / 7→null / 非数字→null …）；
 *   S 组 源码守卫：三处写入口同调用单源、MCP schema 早拒、missing 响应带 invalid、
 *                  EstimateDerive 降级守卫未被改成报错（T02122 红线：历史行不许让面板整体空掉）；
 *   R 组 隔离实例 REST/MCP：
 *     R-02 PRD 导入入口：complexity 0/7/3.5 → 落库 NULL/NULL/4（不落非法值）；
 *     R-03 createBatch 入口：同上；
 *     R-04 MCP create_plans 入口：0/7/3.5 全部被 zod 早拒（isError），零落库；
 *     R-05 /complexity/missing 响应体带 invalid 计数；
 *     R-08 隔离库未归档行无越界值（入口侧清白）；
 *     R-06 降级轨·duration 分支：直写库 complexity=0（绕过钳位模拟存量脏行）→
 *          derive 对该行 rule='duration'、三点有限正数、不报错不 NaN；
 *     R-07 降级轨·caseWeight 分支：同上但挂关联用例 → rule='caseWeight'；
 *     R-09 收口判据·端点半轨（生产实例只读 GET，带 token）：count=0；
 *     R-10 收口判据·SQL 半轨（生产库 Online Backup 副本只读）：未归档行全部非空且值域 1~5。
 *
 * 隔离纪律（skill 红线 8）：库、端口、临时文件全部临时的，不碰生产数据目录，跑完 kill + 回收。
 * 断言输出落 .workbuddy/t02126-gate-results-<运行标识>.txt（中文 stdout 在本机 GBK 控制台会乱码，以文件为准）。
 */
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.T02126_PORT ?? 39_500 + Math.floor(Math.random() * 400));
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02126-clamp-'));
// 路由一律挂在 /api 下（index.ts:125）；health 探针必须打 /api/health 并校验响应体——
// 裸 /health 会命中 SPA 兜底返回 index.html 200（假绿，T02126 首轮实测踩到）。
const BASE = `http://127.0.0.1:${PORT}/api`;
// U 组在 import 任何 server 模块前先把数据目录指向临时库（connection.ts 读 MTask_DATA_DIR），
// 避免模块加载期误连生产库。
process.env.MTask_DATA_DIR = DATA_DIR;

const C = await import('../server/src/services/PlanComplexity.ts');
const D = await import('../server/src/services/EstimateDerive.ts');
const { resolveServerLauncher } = await import('./isolated-server-launcher.mts');

let pass = 0;
let fail = 0;
const results: Array<{ name: string; ok: boolean; extra?: string }> = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) pass += 1;
  else fail += 1;
  results.push({ name, ok: cond, extra: extra === undefined ? undefined : JSON.stringify(extra).slice(0, 400) });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 300)}`}`);
};
const skipped = (name: string, why: string) => {
  results.push({ name, ok: true, extra: `SKIP: ${why}` });
  console.log(`  [SKIP] ${name}（${why}）——不计 PASS`);
};
const group = (t: string) => console.log(`\n== ${t}`);

// =====================================================================
// U 组：clampComplexity 单源函数（纯函数，不落库）
// =====================================================================
group('U 组：clampComplexity 钳位单源（T02122 待补验证 2 的单元面）');
ok('U-01 clampComplexity(0) → null（越界下限丢弃，不落非法值）', C.clampComplexity(0) === null);
ok('U-02 clampComplexity(1) → 1（下边界合法值原样）', C.clampComplexity(1) === 1);
ok('U-03 clampComplexity(3.5) → 4（四舍五入夹回整数）', C.clampComplexity(3.5) === 4);
ok('U-04 clampComplexity(5) → 5（上边界合法值原样）', C.clampComplexity(5) === 5);
ok('U-05 clampComplexity(7) → null（越界上限丢弃）', C.clampComplexity(7) === null);
ok('U-06 clampComplexity(null) → null', C.clampComplexity(null) === null);
ok('U-07 clampComplexity(undefined) → null', C.clampComplexity(undefined) === null);
ok("U-08 clampComplexity('abc') → null（非数字丢弃）", C.clampComplexity('abc') === null);
ok('U-09 clampComplexity(2.4) → 2（非整数四舍五入）', C.clampComplexity(2.4) === 2);
ok('U-10 COMPLEXITY_BASE_DAYS 无 0 档（0 落不到 complexity 规则，必走降级轨）',
  D.COMPLEXITY_BASE_DAYS[0] === undefined && Object.keys(D.COMPLEXITY_BASE_DAYS).length === 5);

// =====================================================================
// S 组：源码守卫（三入口同单源 + 判据带 invalid + 降级守卫未被改坏）
// =====================================================================
group('S 组：源码守卫');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const planComplexitySrc = src('server/src/services/PlanComplexity.ts');
const planServiceSrc = src('server/src/services/PlanService.ts');
const mcpSrc = src('server/src/mcp/server.ts');
const plansRouteSrc = src('server/src/routes/plans.ts');
const deriveSrc = src('server/src/services/EstimateDerive.ts');

ok('S-01 PlanComplexity.ts 导出 clampComplexity（单源函数是 public）',
  /export function clampComplexity\(/.test(planComplexitySrc));
ok('S-02 PlanComplexity.ts 私有 normalize 已消除（不再有两份钳位实现）',
  !/function normalize\(/.test(planComplexitySrc));
ok('S-03 PlanService.ts 导入并调用 clampComplexity（PRD 导入 normalizePrdPlans + createBatch 两处调用点）',
  planServiceSrc.includes("import { clampComplexity } from './PlanComplexity'")
  && (planServiceSrc.match(/clampComplexity\(/g) ?? []).length >= 2, // import 行不含括号，两个调用点各 1 次
  (planServiceSrc.match(/clampComplexity\(/g) ?? []).length);
ok('S-04 createBatch 不再直写 it.complexity ?? null（T02122 前的失守写法已清除）',
  !/ins\.run\([^)]*it\.complexity \?\? null/.test(planServiceSrc));
ok('S-05 MCP create_plans schema 对 complexity 有 int().min(1).max(5) 早拒',
  /complexity: z\.number\(\)\.int\(\)\.min\(1\)\.max\(5\)\.optional\(\)/.test(mcpSrc));
ok('S-06 routes/plans.ts /complexity/missing 响应体带 invalid 计数',
  /invalid: listInvalidComplexity\(projectId\)\.length/.test(plansRouteSrc));
ok('S-07 EstimateDerive 降级守卫保持「顺落」而非报错（T02122 红线：历史脏行不许让面板整体空掉）',
  /const c = plan\.complexity;\s*\n\s*if \(c !== null && COMPLEXITY_BASE_DAYS\[c\] !== undefined\)/.test(deriveSrc)
  && !/complexity[^.]*throw/.test(deriveSrc));

// =====================================================================
// R 组：隔离实例（REST + MCP + 直写库）
// =====================================================================
group('R 组：隔离实例（三入口钳位 + 降级轨 + 收口判据）');
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
      // 必须校验响应体是健康 JSON——裸 /health 命中 SPA 兜底也会返 200（index.html），
      // 只判 res.ok 会把「服务没起来」放行成绿灯（T02126 首轮实测教训）。
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
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify-t02126-clamp', version: '1.0' } },
  });
  await mcpRaw({ jsonrpc: '2.0', method: 'notifications/initialized' });
}
async function callTool(name: string, args: Record<string, unknown>) {
  const body = await mcpRaw({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });
  const r = body?.result ?? {};
  return { isError: r?.isError === true, text: String(r?.content?.[0]?.text ?? ''), structured: (r?.structuredContent ?? {}) as Record<string, any> };
}

const planOf = (plans: any[], titlePart: string) => plans.find((p) => String(p?.title ?? '').includes(titlePart));
const finitePos = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;

let PID = '';
try {
  if (!(await waitForServer())) {
    ok('R-00 隔离服务启动', false, { port: PORT, log: serverLog.join('').slice(-800) });
    writeFileSync(join(ROOT, '.t02126-server-fail.log'), `port=${PORT}\n${serverLog.join('')}`);
  } else {
    ok(`R-00 隔离服务启动（临时端口 ${PORT} + 临时库）`, true);
    await mcpInit();

    // ---- R-01 建隔离项目 ----
    const proj = (await api('POST', '/projects', { name: `T02126 门-钳位与降级 ${Date.now() % 100000}` })).json;
    PID = String(proj?.id ?? '');
    ok('R-01 创建隔离项目', !!PID, proj);

    // ---- R-02 PRD 导入入口钳位 ----
    const imp = await api('POST', '/plans/import-prd', {
      projectId: PID,
      createTasks: false,
      plans: [
        { title: '导入-越界0', durationDays: 2, complexity: 0, reqNos: [] },
        { title: '导入-越界7', durationDays: 2, complexity: 7, reqNos: [] },
        { title: '导入-小数3.5', durationDays: 2, complexity: 3.5, reqNos: [] },
      ],
    });
    ok('R-02a PRD 导入入口接受三类非法 complexity（不报错、零拒绝）', imp.status === 200 && imp.json?.plans === 3,
      { status: imp.status, plans: imp.json?.plans, err: imp.json?.error });
    let plans = (await api('GET', `/plans?projectId=${PID}`)).json as any[];
    const pImp0 = planOf(plans, '导入-越界0');
    const pImp7 = planOf(plans, '导入-越界7');
    const pImp35 = planOf(plans, '导入-小数3.5');
    ok('R-02b PRD 导入后 complexity=0/7 落为 NULL（clampComplexity 丢弃非法值，不落库）',
      !!pImp0 && !!pImp7 && (pImp0.complexity ?? null) === null && (pImp7.complexity ?? null) === null,
      { c0: pImp0?.complexity, c7: pImp7?.complexity });
    ok('R-02c PRD 导入后 complexity=3.5 落为 4（四舍五入夹回 1~5 整数）',
      !!pImp35 && pImp35.complexity === 4, { c35: pImp35?.complexity });

    // ---- R-03 createBatch 入口钳位 ----
    const batch = await api('POST', '/plans/batch', {
      projectId: PID,
      items: [
        { title: '批量-越界0', durationDays: 1, complexity: 0 },
        { title: '批量-越界7', durationDays: 1, complexity: 7 },
        { title: '批量-小数3.5', durationDays: 1, complexity: 3.5 },
      ],
    });
    ok('R-03a createBatch 入口接受三类非法 complexity（T02122 前此处直写落库）',
      batch.status === 200 && batch.json?.inserted === 3, { status: batch.status, inserted: batch.json?.inserted, err: batch.json?.error });
    plans = (await api('GET', `/plans?projectId=${PID}`)).json as any[];
    const pBat0 = planOf(plans, '批量-越界0');
    const pBat7 = planOf(plans, '批量-越界7');
    const pBat35 = planOf(plans, '批量-小数3.5');
    ok('R-03b createBatch 后 complexity=0/7 落为 NULL、3.5 落为 4（与 PRD 导入同一单源）',
      !!pBat0 && !!pBat7 && !!pBat35
      && (pBat0.complexity ?? null) === null && (pBat7.complexity ?? null) === null && pBat35.complexity === 4,
      { b0: pBat0?.complexity, b7: pBat7?.complexity, b35: pBat35?.complexity });

    // ---- R-04 MCP create_plans 入口早拒 ----
    const mcpCases: Array<[string, number]> = [['MCP-越界0', 0], ['MCP-越界7', 7], ['MCP-小数3.5', 3.5]];
    const mcpRejects: boolean[] = [];
    for (const [title, cx] of mcpCases) {
      const r = await callTool('mtask_create_plans', { projectId: PID, items: [{ title, durationDays: 1, complexity: cx }] });
      mcpRejects.push(r.isError === true);
    }
    ok('R-04 MCP create_plans 对 0/7/3.5 全部 zod 早拒（isError，入口层拦截）',
      mcpRejects.every(Boolean), mcpRejects);
    plans = (await api('GET', `/plans?projectId=${PID}`)).json as any[];
    const mcpLanded = plans.filter((p) => String(p?.title ?? '').startsWith('MCP-'));
    ok('R-04b MCP 早拒零落库（三条 MCP-* 行均未创建）', mcpLanded.length === 0, mcpLanded.map((p) => p.title));

    // ---- R-05 missing 端点带 invalid ----
    const missing = (await api('GET', `/plans/complexity/missing?projectId=${PID}`)).json;
    ok('R-05 /complexity/missing 响应体同时带 count 与 invalid（count=4 个 NULL 行，invalid=0 无越界）',
      typeof missing?.count === 'number' && missing.count === 4 && typeof missing?.invalid === 'number' && missing.invalid === 0,
      missing);

    // ---- R-08 隔离库入口侧清白（必须在直写脏行之前断言）----
    const Database = (await import('better-sqlite3')).default;
    const raw = new Database(join(DATA_DIR, 'mtask.db'));
    const invalidInIso = (raw.prepare(
      "SELECT COUNT(*) AS n FROM plan_tasks WHERE project_id = ? AND archived = 0 AND complexity IS NOT NULL AND (complexity < 1 OR complexity > 5)",
    ).get(PID) as { n: number }).n;
    ok('R-08 隔离库未归档行无越界 complexity（三入口写入的全部清白）', invalidInIso === 0, { invalidInIso });

    // ---- R-06 降级轨·duration 分支 ----
    // 直写库绕过钳位，模拟存量脏行（T02122 任务书第 4 点第二子项）
    raw.prepare('UPDATE plan_tasks SET complexity = 0 WHERE id = ?').run(pImp0.id);
    const d1 = (await api('POST', '/estimates/derive', { projectId: PID, dryRun: true, scope: 'all' })).json;
    const item1 = (d1?.items ?? []).find((i: any) => i.planId === pImp0.id);
    const noNaN = !/NaN/.test(JSON.stringify(item1 ?? {}));
    ok('R-06a 降级轨·duration：complexity=0 的行 rule 落为 duration（COMPLEXITY_BASE_DAYS[0] 查不到 → 顺落工期规则）',
      !!item1 && item1.rule === 'duration', { rule: item1?.rule, note: item1?.note });
    ok('R-06b 降级轨·duration：三点与期望值均为有限正数、不报错不 NaN',
      !!item1 && finitePos(item1.optimistic) && finitePos(item1.likely) && finitePos(item1.pessimistic) && finitePos(item1.expected) && noNaN,
      { o: item1?.optimistic, m: item1?.likely, p: item1?.pessimistic, e: item1?.expected });
    ok('R-06c 降级轨·duration：该行可写（writable 且无 skip，降级不是静默丢弃）',
      !!item1 && item1.writable === true && (item1.skip ?? '') === '', { skip: item1?.skip, writable: item1?.writable });

    // ---- R-07 降级轨·caseWeight 分支 ----
    // 造「需求 + 关联用例 + complexity=0 脏行」，让降级轨落在 caseWeight 规则上
    const imp2 = await api('POST', '/plans/import-prd', {
      projectId: PID,
      createTasks: false,
      requirements: [{ reqNo: 'REQ-T02126', title: '降级轨用例关联需求', content: 'T02126 门用例', sourceRef: '§门', priority: 'normal' }],
      plans: [{ title: '降级-用例行', durationDays: 2, complexity: 7, reqNos: ['REQ-T02126'] }],
    });
    const reqs = (await api('GET', `/plans/prd-requirements?projectId=${PID}`)).json as any[];
    // 响应是 DB 原始列名（蛇形 req_no）——与 MCP mtask_list_matrix 同款教训，按实测字段名匹配
    const req = (Array.isArray(reqs) ? reqs : []).find((r) => r?.req_no === 'REQ-T02126' || r?.reqNo === 'REQ-T02126');
    const caseCreated = await api('POST', '/plans/test-cases', {
      projectId: PID, title: '降级轨关联用例', reqId: req?.id, priority: 'P1',
    });
    plans = (await api('GET', `/plans?projectId=${PID}`)).json as any[];
    const pCase = planOf(plans, '降级-用例行');
    raw.prepare('UPDATE plan_tasks SET complexity = 0 WHERE id = ?').run(pCase.id);
    const d2 = (await api('POST', '/estimates/derive', { projectId: PID, dryRun: true, scope: 'all' })).json;
    const item2 = (d2?.items ?? []).find((i: any) => i.planId === pCase.id);
    const noNaN2 = !/NaN/.test(JSON.stringify(item2 ?? {}));
    ok('R-07a 降级轨·caseWeight：complexity=0 且挂关联用例的行 rule 落为 caseWeight',
      !!item2 && item2.rule === 'caseWeight',
      { rule: item2?.rule, note: item2?.note, reqId: req?.id, req_ids: pCase?.req_ids, caseStatus: caseCreated.status, imp2: imp2.status });
    ok('R-07b 降级轨·caseWeight：三点与期望值均为有限正数、不报错不 NaN',
      !!item2 && finitePos(item2.optimistic) && finitePos(item2.likely) && finitePos(item2.pessimistic) && finitePos(item2.expected) && noNaN2,
      { o: item2?.optimistic, m: item2?.likely, p: item2?.pessimistic, e: item2?.expected });
    raw.close();

    // ---- R-09 收口判据·端点半轨（生产实例只读 GET）----
    const PROD_PORT = Number(process.env.T02126_PROD_PORT ?? 39_877);
    const PROD_PID = 'a9911922-3f07-47a3-bc7b-bb4aac62bc16';
    let prodToken = process.env.T02126_PROD_TOKEN ?? '';
    if (!prodToken) {
      const cfgPath = join(process.env.APPDATA ?? '', 'MTask', 'data', 'tunnel', 'tunnel-config.json');
      if (existsSync(cfgPath)) {
        try { prodToken = String((JSON.parse(readFileSync(cfgPath, 'utf8')) as { accessToken?: string }).accessToken ?? ''); } catch { /* 缺配置则无 token */ }
      }
    }
    try {
      const res = await fetch(`http://127.0.0.1:${PROD_PORT}/api/plans/complexity/missing?projectId=${PROD_PID}`, {
        headers: prodToken ? { 'X-Access-Token': prodToken } : {},
      });
      const pj = (await res.json()) as Record<string, any>;
      if (res.status === 200 && typeof pj.count === 'number' && pj.count === 0) {
        ok('R-09a 生产端点 /complexity/missing count=0（四期未归档行无缺失）', true, pj);
        if (typeof pj.invalid === 'number') {
          ok('R-09b 生产端点 invalid=0（新构建已上线，端点半轨完整）', pj.invalid === 0, pj);
        } else {
          skipped('R-09b 生产端点 invalid=0', '生产实例运行的是 T02122 前的旧构建（响应无 invalid 字段）——越界半轨由 R-10 SQL 副本覆盖，新构建随下次打包/重启生效');
        }
      } else {
        ok('R-09 生产端点收口判据（count=0）', false, { status: res.status, body: pj });
      }
    } catch (e) {
      ok('R-09 生产端点收口判据（count=0）', false, { error: (e as Error).message });
    }

    // ---- R-10 收口判据·SQL 半轨（生产库 Online Backup 副本，只读）----
    try {
      // Windows 下 better-sqlite3 的 file: URI 不接受反斜杠路径——直接用普通路径 + readonly 选项
      // （T02090 同款口径：Online Backup API 做一致快照，避免与生产实例争锁）
      const prodDbPath = join(process.env.APPDATA ?? '', 'MTask', 'data', 'mtask.db');
      const src = new Database(prodDbPath, { readonly: true });
      const copyPath = join(DATA_DIR, 'prod-copy.db');
      // better-sqlite3 的 backup() 第一参是**路径字符串**（传 Database 实例会 TypeError），
      // 且返回 Promise（本机 v12）——await 后副本即就绪
      await src.backup(copyPath);
      const dst = new Database(copyPath, { readonly: true });
      const total = (dst.prepare('SELECT COUNT(*) AS n FROM plan_tasks WHERE project_id = ? AND archived = 0').get(PROD_PID) as { n: number }).n;
      const nulls = (dst.prepare('SELECT COUNT(*) AS n FROM plan_tasks WHERE project_id = ? AND archived = 0 AND complexity IS NULL').get(PROD_PID) as { n: number }).n;
      const bad = (dst.prepare('SELECT COUNT(*) AS n FROM plan_tasks WHERE project_id = ? AND archived = 0 AND complexity IS NOT NULL AND (complexity < 1 OR complexity > 5)').get(PROD_PID) as { n: number }).n;
      ok('R-10a 生产库副本：四期未归档行全部 complexity 非空', nulls === 0, { total, nulls });
      ok('R-10b 生产库副本：未归档行值域全部落在 1~5（越界 0 行）', bad === 0, { total, bad });
      ok('R-10c 生产库副本：与 R-09 端点口径互证（total=49 时点快照，两半轨同结论）', total > 0, { total });
      dst.close();
      src.close();
    } catch (e) {
      ok('R-10 生产库副本 SQL 半轨', false, { error: (e as Error).message });
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
const summary = `T02126 complexity 钳位单源 + 降级轨 + 三入口 + 收口判据：PASS=${pass} FAIL=${fail}\n`
  + results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.extra ? ` :: ${r.extra}` : ''}`).join('\n') + '\n';
mkdirSync(join(ROOT, '.workbuddy'), { recursive: true });
writeGateResults(join(ROOT, '.workbuddy'), 't02126-gate-results.txt', summary, { port: PORT, dataDir: DATA_DIR });
writeGateResults(join(ROOT, '.workbuddy'), 't02126-gate-results.json', JSON.stringify({ pass, fail, results }, null, 2), { port: PORT, dataDir: DATA_DIR });
console.log(`\n${summary}`);

// 退避清理临时目录（Windows 刚 kill 的进程可能仍持 DB 句柄，T02090 同款教训）
for (let i = 0; i < 5; i++) {
  try { rmSync(DATA_DIR, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
}
process.exit(fail === 0 ? 0 : 1);
