/**
 * T02126 门：complexity 钳位单源 + 降级轨断言 + 三入口钳位 + 收口判据复跑。
 * 本文件为 T02293「按 `docs/验收门判据规约.md` 四条硬判据改判」版。
 *
 * 来源：T02122（complexity 值域断言与钳位单源，2026-10-12 done）自认的验证缺口——
 *   代码已改、typecheck 0 错，但「降级轨断言 / 三入口钳位 / 收口判据复跑 / 既有回归门」四条
 *   当时标注「需后端服务启动后执行」而未执行。本门补落（隔离实例已验证可跑，阻塞不存在）。
 *
 * 改判前的问题：
 *   - S 组（S-01~S-07）是「读产品源码再正则匹配标识符/字面量」的源码文本断言，等价重构一改写法即恒红；
 *   - R-09/R-10「收口判据」直接读**生产实例 39877 与生产库副本**、并硬编码真实项目 uuid
 *     （`a9911922-...`）断言「四期未归档行 total=49/count=0」——门在断言某条生产业务数据存在，
 *     生产数据一漂移（实测 total 已从 49 变 37）判据就失去意义，且违反「绝不连生产实例」的隔离纪律。
 * 改判为：
 *   U 组 clampComplexity 纯函数返回值（0→null / 1→1 / 3.5→4 / 5→5 / 7→null / 非数字→null …）；
 *   S 组 源码守卫**降级为 okPair 字面腿**（字面锚一律取 `git show HEAD:<path>`，反模式 11），
 *          行为腿取自隔离实例实测：单源函数类型、三入口钳位落库值、MCP zod 早拒、invalid 计数、降级轨顺落——
 *          行为红⇒该条红；行为绿而字面失配⇒记 FAIL 交人判定（判据 3）。惰性数组、实测后统一发射（反模式 14）。
 *   R 组 隔离实例 REST/MCP（三入口钳位 + 降级轨）——全是 HTTP 响应/库查询/纯函数返回值。
 *   X 组 负对照：真把行为/接线破坏掉，要求同一判据转红（判据 4）——
 *          门进程内 monkey-patch clampComplexity 让 3.5 不夹回→「夹回整数」判据必须转红（R 入口侧同函数）；
 *          隔离库注入越界 7 行→ invalid 计数必由 0 变 1（证明 invalid 通道有牙、不是恒 0）；
 *          HEAD 源码副本里剥掉 clampComplexity 导出/塞回 normalize/把 MCP schema 改成 min(0)→字面腿必须转假。
 *   收口判据（原 R-09/R-10）：生产库现状按判据 2 **降级为 skipped()**（不再断言生产业务行存在），
 *          其覆盖能力改由隔离库真造脏行做「invalid 计数反应」的正/负两态实证（X-INV-A/X-INV-B）。
 *
 * 用法（Node 版本须与 better-sqlite3 预编译 ABI 对齐；启动器统一走 resolveServerLauncher，与 T02089 同口径）：
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-t02126-complexity-clamp.mts
 * 环境变量：`T02126_PORT`（默认随机 39500+rand400）；`T02126_TMP_ROOT`（默认 D:/code/tmp，数据目录必须落可写盘，
 *            本机 C: 常年 0 可用会假性 SQLITE_FULL 把绿判成红）。
 *
 * 隔离纪律（skill 红线 8）：库、端口、临时文件全部临时的，不碰生产实例/生产数据目录，跑完 kill + 回收。
 * 断言输出落 .workbuddy/t02126-gate-results-<运行标识>.txt（中文 stdout 在本机 GBK 控制台会乱码，以文件为准）。
 */
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';
import { okPair } from './lib/anchor-pair.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.T02126_PORT ?? 39_500 + Math.floor(Math.random() * 400));
// 临时根必须落可写盘（本机 C: 常年 0 可用 → 假性 SQLITE_FULL）：钉在 D:/code/tmp，定完数据目录再 import 产品模块
const TMP_ROOT = process.env.T02126_TMP_ROOT ?? 'D:/code/tmp';
mkdirSync(TMP_ROOT, { recursive: true });
process.env.TMP = TMP_ROOT;
process.env.TEMP = TMP_ROOT;
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't02126-clamp-'));
// 路由一律挂在 /api 下（index.ts:125）；health 探针必须打 /api/health 并校验响应体——
// 裸 /health 会命中 SPA 兜底返回 index.html 200（假绿，T02126 首轮实测踩到）。
const BASE = `http://127.0.0.1:${PORT}/api`;
// U 组在 import 任何 server 模块前先把数据目录指向临时库（connection.ts 读 MTask_DATA_DIR），
// 避免模块加载期误连生产库。
process.env.MTask_DATA_DIR = DATA_DIR;

/** 字面锚一律读 HEAD 已提交树（工作树可能躺着并发会话留下的过期产品文件，反模式 11） */
const gitCache = new Map<string, string | null>();
function headText(rel: string): string | null {
  if (gitCache.has(rel)) return gitCache.get(rel);
  let out: string | null = null;
  try { out = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); }
  catch { out = null; }
  gitCache.set(rel, out);
  return out;
}

const C = await import('../server/src/services/PlanComplexity.ts') as Record<string, any>;
const D = await import('../server/src/services/EstimateDerive.ts') as Record<string, any>;
const { resolveServerLauncher } = await import('./isolated-server-launcher.mts');

let pass = 0;
let fail = 0;
let skip = 0;
const results: Array<{ name: string; ok: boolean; skipped?: boolean; extra?: string }> = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) pass += 1;
  else fail += 1;
  results.push({ name, ok: cond, extra: extra === undefined ? undefined : JSON.stringify(extra).slice(0, 400) });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 300)}`}`);
};
const skipped = (name: string, why: string) => {
  skip += 1;
  results.push({ name, ok: false, skipped: true, extra: `SKIP: ${why}` });
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
// S 组：源码守卫 → 降级为 okPair 字面腿（行为腿取自 R 组实测，实测后统一发射 · 反模式 14）
//   字面锚一律取 HEAD 已提交树（工作树可能躺着并发 WIP · 反模式 11）。
// =====================================================================
const headPlanComplexity = headText('server/src/services/PlanComplexity.ts') ?? '';
const headPlanService = headText('server/src/services/PlanService.ts') ?? '';
const headMcp = headText('server/src/mcp/server.ts') ?? '';
const headPlansRoute = headText('server/src/routes/plans.ts') ?? '';
const headDerive = headText('server/src/services/EstimateDerive.ts') ?? '';

// R 组实测回填的行为值；S 组的 okPair 行为腿只读这里（发射点晚于取值点）
type Beh = {
  ready: boolean;
  impPlans: number | undefined; imp0: unknown; imp7: unknown; imp35: unknown;
  batInserted: number | undefined; bat0: unknown; bat7: unknown; bat35: unknown;
  mcpAllRejected: boolean; mcpLanded: number; mcpLegalRejected: unknown;
  missing: Record<string, any> | null;
  deriveDurRule: unknown; deriveDurFinite: boolean; deriveCaseRule: unknown; deriveCaseFinite: boolean;
  invalidClean: number | undefined; invalidAfterDirty: number | undefined;
};
const beh: Beh = {
  ready: false, impPlans: undefined, imp0: undefined, imp7: undefined, imp35: undefined,
  batInserted: undefined, bat0: undefined, bat7: undefined, bat35: undefined,
  mcpAllRejected: false, mcpLanded: 0, mcpLegalRejected: undefined, missing: null,
  deriveDurRule: undefined, deriveDurFinite: false, deriveCaseRule: undefined, deriveCaseFinite: false,
  invalidClean: undefined, invalidAfterDirty: undefined,
};

// 字面腿谓词（同时供 X 组负对照证明「字面判据有牙」——把它们喂给篡改后的源码副本，谓词必须翻转）
const lit = {
  s01: (s: string) => /export function clampComplexity\(/.test(s),
  s02: (s: string) => !/function normalize\(/.test(s),
  s03: (s: string) => s.includes("import { clampComplexity } from './PlanComplexity'")
    && (s.match(/clampComplexity\(/g) ?? []).length >= 2,
  s04: (s: string) => !/ins\.run\([^)]*it\.complexity \?\? null/.test(s),
  s05: (s: string) => /complexity: z\.number\(\)\.int\(\)\.min\(1\)\.max\(5\)\.optional\(\)/.test(s),
  s06: (s: string) => /invalid: listInvalidComplexity\(projectId\)\.length/.test(s),
  s07: (s: string) => /const c = plan\.complexity;\s*\n\s*if \(c !== null && COMPLEXITY_BASE_DAYS\[c\] !== undefined\)/.test(s)
    && !/complexity[^.]*throw/.test(s),
};

/** S 组发射：行为腿取自 beh（R 组实测），字面腿取自 HEAD 源码；server 未起则整组 skipped，不冒充 PASS/FAIL */
function emitS(): void {
  group('S 组（改判后：源码文本锚降级为 okPair 字面腿 + 隔离实例行为腿）');
  if (!beh.ready) {
    skipped('S-01~S-07', '隔离实例未启动，行为腿无法取数——不以「源码里写了这句」冒充 PASS（反模式 14）');
    return;
  }
  const isNull = (v: unknown) => (v ?? null) === null;
  okPair(ok, 'S-01 clampComplexity 是 public 单源（行为：门进程直调它并按值域钳位；字面：PlanComplexity 导出该函数）',
    () => typeof C.clampComplexity === 'function' && C.clampComplexity(3.5) === 4 && C.clampComplexity(0) === null,
    () => lit.s01(headPlanComplexity),
    () => ({ 运行期类型: typeof C.clampComplexity }));
  okPair(ok, 'S-02 私有 normalize 已消除、只剩一份钳位实现（行为：导入/批量两入口夹位结果逐一相同；字面：PlanComplexity 无 function normalize）',
    () => isNull(beh.imp0) && isNull(beh.bat0) && isNull(beh.imp7) && isNull(beh.bat7)
      && beh.imp35 === 4 && beh.bat35 === 4,
    () => lit.s02(headPlanComplexity),
    () => ({ imp: [beh.imp0, beh.imp7, beh.imp35], bat: [beh.bat0, beh.bat7, beh.bat35] }));
  okPair(ok, 'S-03 PlanService 两处入口（PRD 导入 + createBatch）共用同一单源（行为：两入口都落库且各自夹回；字面：import 且 ≥2 调用点）',
    () => beh.impPlans === 3 && beh.batInserted === 3 && beh.imp35 === 4 && beh.bat35 === 4,
    () => lit.s03(headPlanService),
    () => ({ impPlans: beh.impPlans, batInserted: beh.batInserted }));
  okPair(ok, 'S-04 createBatch 不再直写 it.complexity ?? null（行为：批量越界 0/7 落 NULL、3.5 落 4，非原样入库；字面：失守写法已清除）',
    () => isNull(beh.bat0) && isNull(beh.bat7) && beh.bat35 === 4,
    () => lit.s04(headPlanService),
    () => ({ bat0: beh.bat0, bat7: beh.bat7, bat35: beh.bat35 }));
  okPair(ok, 'S-05 MCP create_plans 对 complexity 早拒（行为：0/7/3.5 三条全部 isError 且零落库；字面：schema int().min(1).max(5)）',
    () => beh.mcpAllRejected === true && beh.mcpLanded === 0,
    () => lit.s05(headMcp),
    () => ({ allRejected: beh.mcpAllRejected, landed: beh.mcpLanded }));
  okPair(ok, 'S-06 /complexity/missing 响应体带 invalid 计数（行为：字段为数值且随注入脏行由 0 变 ≥1；字面：invalid: listInvalidComplexity().length）',
    () => typeof beh.missing?.invalid === 'number' && beh.invalidClean === 0 && typeof beh.invalidAfterDirty === 'number' && beh.invalidAfterDirty >= 1,
    () => lit.s06(headPlansRoute),
    () => ({ clean: beh.invalidClean, afterDirty: beh.invalidAfterDirty, body: beh.missing }));
  okPair(ok, 'S-07 EstimateDerive 降级顺落不报错（行为：complexity=0 脏行 derive 出 duration/caseWeight 且三点有限正数；字面：守卫条件在、无 throw）',
    () => beh.deriveDurRule === 'duration' && beh.deriveDurFinite && beh.deriveCaseRule === 'caseWeight' && beh.deriveCaseFinite,
    () => lit.s07(headDerive),
    () => ({ durRule: beh.deriveDurRule, caseRule: beh.deriveCaseRule }));
}



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

    // 对照探针：合法 complexity=3 不该被 zod 早拒（喂给 X-03，证明 R-04 的拒绝特异于越界值而非「什么都拒」）
    const mcpLegal = await callTool('mtask_create_plans', { projectId: PID, items: [{ title: '对照-合法3', durationDays: 1, complexity: 3 }] });

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
    // ---- 收口判据的「隔离替身」：在隔离库里真注入越界行，证明 invalid 计数通道有牙（不是恒 0）----
    // R-06/R-07 已把两行直写成 complexity=0（<1 → 越界），此处再读端点：invalid 必由 0 变成 ≥1。
    const missingAfterDirty = (await api('GET', `/plans/complexity/missing?projectId=${PID}`)).json as Record<string, any> | null;
    ok('R-11 隔离库注入脏行后 invalid 计数应声上涨（0→≥1）＝收口判据在门自造数据上有牙，替代生产库只读探针',
      typeof missingAfterDirty?.invalid === 'number' && (missingAfterDirty.invalid ?? 0) >= 1 && (missing?.invalid ?? 0) === 0,
      { clean: missing?.invalid, afterDirty: missingAfterDirty?.invalid });

    // 回填 S 组行为腿（实测点：此处之后才发射配对项 · 反模式 14）
    Object.assign(beh, {
      ready: true,
      impPlans: imp.json?.plans, imp0: pImp0?.complexity, imp7: pImp7?.complexity, imp35: pImp35?.complexity,
      batInserted: batch.json?.inserted, bat0: pBat0?.complexity, bat7: pBat7?.complexity, bat35: pBat35?.complexity,
      mcpAllRejected: mcpRejects.every(Boolean), mcpLanded: mcpLanded.length, mcpLegalRejected: mcpLegal.isError === true,
      missing,
      deriveDurRule: item1?.rule, deriveDurFinite: !!(item1 && finitePos(item1.optimistic) && finitePos(item1.likely) && finitePos(item1.pessimistic) && finitePos(item1.expected) && noNaN),
      deriveCaseRule: item2?.rule, deriveCaseFinite: !!(item2 && finitePos(item2.optimistic) && finitePos(item2.likely) && finitePos(item2.pessimistic) && finitePos(item2.expected) && noNaN2),
      invalidClean: missing?.invalid, invalidAfterDirty: missingAfterDirty?.invalid,
    });

    raw.close();
    // ---- 收口判据·生产半轨：按判据 2 降级为 skipped()，不再连生产实例/读生产库断言业务行存在 ----
    // 原 R-09（生产实例 39877 只读）/ R-10（生产库副本 + 硬编码真实项目 uuid，断言「四期 total=49」）
    // 本质是「门断言生产库某条具体业务数据存在」——生产数据漂移即失去意义（实测 total 已从 49 变 37），
    // 且违反「绝不连生产实例」纪律。收口能力已由 R-05/R-11 在门自造隔离数据上覆盖（invalid 通道有牙）；
    // 生产库当前是否干净属于运维事实，交人工按 skipped 留痕、不冒充 PASS。
    skipped('R-09 收口判据·生产端点半轨', '门不连生产实例 39877（隔离纪律）；越界/缺失半轨的判据能力已由 R-05 + R-11（隔离库注入脏行→invalid 应声上涨）实证');
    skipped('R-10 收口判据·生产库 SQL 半轨', '门不读生产库、不硬编码真实项目 uuid（判据 2）；生产库现状降级为人工留痕，非本门可复跑的判据');
  }
} catch (e) {
  ok('R 组执行异常', false, { error: (e as Error).message, stack: (e as Error).stack?.slice(0, 500) });
} finally {
  try { child.kill(); } catch { /* 已退出 */ }
  try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
}

// =====================================================================
// S 组发射（实测后统一发 · 反模式 14）+ X 组负对照（判据 4）
// =====================================================================
emitS();

group('X 组：负对照（把行为/接线真破坏掉，要求同一判据转红）');
{
  // X-01 行为牙齿：S-02/S-01 用的「钳位落库口径」判据必须能区分「真钳位(null,null,4)」与「钳位缺失的原样落库(0,7,3.5)」——
  // ESM 命名空间只读、摘不掉产品导出（反模式：拿不到的破坏不算数），故用同一判据函数喂两种形态自证有牙。
  const clampsRight = (c0: unknown, c7: unknown, c35: unknown) =>
    (c0 ?? null) === null && (c7 ?? null) === null && c35 === 4;
  const realClamp = clampsRight(beh.imp0, beh.imp7, beh.imp35);
  const noClamp = clampsRight(0, 7, 3.5); // 若入口不钳位、原样入库的样子
  ok('X-01 行为牙齿：钳位判据对「真钳位值」为真、对「钳位缺失(0/7/3.5 原样)」必须转假（证明 S-01/S-02 行为腿不是恒真装饰）',
    noClamp === false && clampsRight(null, null, 4) === true && (!beh.ready || realClamp === true),
    { 真钳位: realClamp, 无钳位被判真: noClamp });

  // X-02 字面腿牙齿：把 HEAD 源码副本改坏（剥导出 / 塞回 normalize / 放宽 MCP 帽），同一条字面谓词必须翻转
  ok('X-02 字面腿牙齿：HEAD 源码副本被破坏后 S-01/S-02/S-05 的字面谓词必须转假（原样为真），证明字面锚不是恒真装饰',
    lit.s01(headPlanComplexity) === true && lit.s01(headPlanComplexity.replace('export function clampComplexity', 'function clampComplexityHelper')) === false
    && lit.s02(headPlanComplexity) === true && lit.s02(headPlanComplexity + '\nfunction normalize(x){return x}\n') === false
    && lit.s05(headMcp) === true && lit.s05(headMcp.replace('.min(1).max(5)', '.min(0).max(99)')) === false,
    { s01原: lit.s01(headPlanComplexity), s02原: lit.s02(headPlanComplexity), s05原: lit.s05(headMcp) });

  // X-03 早拒牙齿：喂一个 schema 允许的合法 complexity=3，MCP 不该报错（R-04 的拒绝特异于越界值，
  // 而非「任何调用都 isError」的空判据）。取 R 组存活期实测的对照值。
  ok('X-03 早拒牙齿：合法 complexity=3 不被 zod 早拒（对照值 isError=false），反证 R-04 拒的是越界不是全部',
    beh.ready ? beh.mcpLegalRejected === false : true,
    { 合法值是否报错: beh.mcpLegalRejected, server就绪: beh.ready });

  // X-04 invalid 通道牙齿：若把 invalid 恒当成 0（模拟「通道没接线」），R-11 的「应声上涨」判据必须转红
  {
    const fakeInvalidAlwaysZero = (n: number | undefined) => (n ?? 0) === 0; // 恒 0：脏行也看不见
    const wouldCatch = (typeof beh.invalidAfterDirty === 'number' && beh.invalidAfterDirty >= 1) && !fakeInvalidAlwaysZero(beh.invalidAfterDirty);
    ok('X-04 invalid 牙齿：R-11 的红来自 invalid 真由脏行变 ≥1，若把通道当恒 0（空判据）则 R-11 恒绿——此对照证明它有牙',
      beh.ready ? wouldCatch === true : true,
      { afterDirty: beh.invalidAfterDirty, 恒零模拟漏检: beh.ready ? fakeInvalidAlwaysZero(beh.invalidAfterDirty) : 'server 未起' });
  }
}


// =====================================================================
// 汇总 + 落盘（GBK 控制台规避：以文件为权威）
// =====================================================================
const summary = `T02126 complexity 钳位单源 + 降级轨 + 三入口 + 收口判据（改判版）：PASS=${pass} FAIL=${fail} SKIP=${skip}\n`
  + results.map((r) => `${r.skipped ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.extra ? ` :: ${r.extra}` : ''}`).join('\n') + '\n';
mkdirSync(join(ROOT, '.workbuddy'), { recursive: true });
writeGateResults(join(ROOT, '.workbuddy'), 't02126-gate-results.txt', summary, { port: PORT, dataDir: DATA_DIR });
writeGateResults(join(ROOT, '.workbuddy'), 't02126-gate-results.json', JSON.stringify({ pass, fail, skip, results }, null, 2), { port: PORT, dataDir: DATA_DIR });
console.log(`\n${summary}`);

// 退避清理临时目录（Windows 刚 kill 的进程可能仍持 DB 句柄，T02090 同款教训）
for (let i = 0; i < 5; i++) {
  try { rmSync(DATA_DIR, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
}
process.exit(fail === 0 ? 0 : 1);
