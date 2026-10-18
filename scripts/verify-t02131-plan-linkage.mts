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
 *     R-12a 收口判据门内自证：本门关联通道写回的应关联行（LINK_TITLES）无一留下空 req_ids（不再断言生产库某批行存在性）；
 *     R-12b 归档可逆留痕（门内软删→查→恢复）；
 *     R-12c 生产库 K/M-K 批次现状：**只留痕不判定**（skipped，判据 2 禁止门拿生产业务数据判红）；
 *     R-13 复杂度防线：合法 4 原样落库；越界 99 在 MCP schema 层被拒收且该行零落库。
 *   N-06 clampComplexity/listInvalid 用产品真函数取证（越界档翻红 + 门自身临时库造脏值让 listInvalid 点名）。
 *   N 组 负对照：字面腿无永真式 / S-02 锚点改名各自翻红 / 抽掉运行期料行为腿全红 /
 *               门自身临时库**副本**上造反例验证孤儿判据与「真未关联」判据会翻脸。
 *
 * 隔离纪律（skill 红线 8）：库、端口、临时文件全部临时的，不碰生产数据目录，跑完 kill + 回收。
 * 断言输出落 .workbuddy/t02131-gate-results-<运行标识>.txt（中文 stdout 在本机 GBK 控制台会乱码，以文件为准）。
 */
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';
import { okPair } from './lib/anchor-pair.mts';

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

/** 关联通道夹具的 8 个应关联标题（故意悬空的 K5 不在列，它由 R-08 的告警点名兜住） */
const LINK_TITLES = ['K1 材料收集', 'K2 稿件撰写', 'K3 评审收口', 'K4 增量补录',
  'M1 里程碑', 'M1a 里程碑后子项', 'C04 合法复杂度'];
const parseArr = (v: unknown): string[] => {
  if (typeof v !== 'string' || !v.trim()) return [];
  try { const j = JSON.parse(v); return Array.isArray(j) ? j.map((x: any) => String(x?.id ?? x)) : []; } catch { return []; }
};
/** 孤儿收口判据（R-12a 与 N-04 共用同一份，负对照才有牙）：应关联标题中 req_ids 为空的行 */
const orphanTitles = (rows: Array<{ title: string; req_ids?: string | null }>) =>
  rows.filter((r) => LINK_TITLES.includes(r.title) && parseArr(r.req_ids).length === 0).map((r) => r.title);
/** 纯计划通道行是否真的没挂上关联（S-06 行为腿，N-05 共用） */
const reallyUnlinked = (row: { req_ids?: string | null; linked_task_id?: string | null } | undefined) =>
  !!row && parseArr(row.req_ids).length === 0 && !row.linked_task_id;

// =====================================================================
// S 组：契约守卫（HEAD 字面锚 × 运行期实测）——反模式 11/14：
//  字面腿只取 `git show HEAD:<path>`；行为腿取 R 组实测回来的 RT，故 S 组**延后到 R 组跑完再发射**，
//  这里只声明判据，不在此处判定。
// =====================================================================
group('S 组：契约守卫（声明期，实际发射在 R 组之后）');
const src = (p: string) => {
  // 反模式 11：工作树可能躺着并发会话留下的过期产品文件，字面锚一律回**已提交树**取
  try { return execFileSync('git', ['show', `HEAD:${p}`], { cwd: ROOT, encoding: 'utf8' }); }
  catch { return ''; }
};
const mcpSrc = src('server/src/mcp/server.ts');
const planServiceSrc = src('server/src/services/PlanService.ts');
/** R 组实测回填的行为料（发射 S 组前必须已取值） */
const RT: Record<string, unknown> = {};
/** 字面腿一律以「传入的源码」为取证面（而不是闭包捕获 mcpSrc），负对照才能拿篡改副本喂同一条判据 */
type SPair = { label: string; behavior: () => boolean; literal: (mcp: string, plan: string) => boolean; ctx: () => unknown };
const S_PAIRS: SPair[] = [
  {
    label: 'S-01 MCP create_plans schema 带 requirements / items[].reqNos / createTasks 三个关联入口',
    behavior: () => RT.linked === true && RT.counts === '2/3/3',
    literal: (mcp) => /requirements: z\.array\(z\.object\(\{/.test(mcp)
      && /reqNos: z\.array\(z\.string\(\)\)\.optional\(\)/.test(mcp)
      && /createTasks: z\.boolean\(\)\.optional\(\)/.test(mcp),
    ctx: () => ({ 关联通道实测: RT.linked, 一次调用建行数: RT.counts }),
  },
  {
    label: 'S-02 关联请求路由到 importPrd（不复制一份联动逻辑，单源）',
    behavior: () => RT.channel === 'prd_import',
    literal: (mcp) => /const wantLinkage = /.test(mcp) && /PlanService\.importPrd\(pid, \{/.test(mcp),
    ctx: () => ({ channel: RT.channel }),
  },
  {
    label: 'S-03 importPrd 回传 planRowIds 且 MCP 依赖解析改用它（下标对齐，撞名让号不断链）',
    behavior: () => RT.refEdgeToK1Id === true && RT.unresolvedDepWarn === false,
    literal: (mcp, plan) => /planRowIds = planTargets\.map\(/.test(plan)
      && /applyPlanItemDeps\([^)]*r\.planRowIds/.test(mcp),
    ctx: () => ({ K2的serial边指向: RT.refEdgeTarget, 未解析告警: RT.unresolvedDepWarn }),
  },
  {
    label: 'S-04 编号解析第三层回落：可挂到既往导入已建的矩阵行（按项目内唯一 req_no 定位）',
    behavior: () => RT.incrementalAttachedExisting === true && RT.incrementalNewReqs === 0,
    literal: (_mcp, plan) => /SELECT id FROM prd_requirements WHERE project_id = \? AND req_no = \?/.test(plan)
      && /requestedToId\.get\(n\) \?\? noToId\.get\(n\) \?\? existingReqId\(n\)/.test(plan),
    ctx: () => ({ 增量回写挂到的行: RT.incrementalReqIds, 新建矩阵行: RT.incrementalNewReqs }),
  },
  {
    label: 'S-05 关联通道保留 T01868 防重入前检（importPrd 默认让号会静默造第二条轨，必须先拒）',
    behavior: () => RT.reentrantRejected === true && RT.reentrantZeroWrite === true,
    literal: (mcp) => /防重入拦截/.test(mcp),
    ctx: () => ({ 拦截前: RT.planCountBefore, 拦截后: RT.planCountAfter }),
  },
  {
    label: 'S-06 纯计划通道补孤儿告警（K1~K8 当时零提示）',
    behavior: () => RT.plainWarnHasChannelHint === true && RT.plainRowsReallyUnlinked === true,
    literal: (mcp) => /纯计划通道/.test(mcp),
    ctx: () => ({ 告警: RT.plainWarn, 纯通道行req_ids: RT.plainRowReqIds }),
  },
  {
    label: 'S-07 createBatch 纯计划通道未被替换（不带关联字段时保持既有轻量语义）',
    behavior: () => RT.plainInserted === 3 && RT.plainChannelUndefined === true,
    literal: (mcp) => /PlanService\.createBatch\(pid, items, \{ dupPolicy/.test(mcp),
    ctx: () => ({ inserted: RT.plainInserted, channel: RT.plainChannel }),
  },
  {
    label: 'S-08 importPrd 计划行 status 透传（MCP 侧 doing/done 不再一律打回 todo）',
    behavior: () => RT.k2Status === 'doing',
    literal: (_mcp, plan) => /status: planItems\[i\]\.status \?\? \('todo' as PlanStatus\)/.test(plan),
    ctx: () => ({ K2落库status: RT.k2Status }),
  },
  {
    label: 'S-09 T02122 复杂度防线未被本轮改动破坏（越界值进不了关联通道、合法值原样落库）',
    behavior: () => RT.clampOutOfRangeRejected === true && RT.clampInRangeLanded === 4,
    literal: (_mcp, plan) => (plan.match(/clampComplexity\(/g) ?? []).length >= 2
      && /const cClamped = clampComplexity\(o\.complexity\)/.test(plan),
    ctx: () => ({ 越界99被拒收: RT.clampOutOfRangeRejected, 合法4落库: RT.clampInRangeLanded }),
  },
  {
    label: 'S-10 关联通道的编号顺延/未关联/歧义三类事实全部转成告警回传（不再只埋在返回值里）',
    behavior: () => RT.unlinkedNamedInWarn === true && RT.warningFieldsExposed === true,
    literal: (mcp) => /for \(const n of r\.unlinkedReqNos\) warnings\.push/.test(mcp)
      && /r\.ambiguousReqNos/.test(mcp) && /r\.reqNoMap\.length > 0/.test(mcp),
    ctx: () => ({ 未关联告警: RT.warn8, 三类字段可见: RT.warningFieldsExposed }),
  },
];

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
      'SELECT id, title, kind, status, req_ids, linked_task_id, deps, complexity FROM plan_tasks WHERE project_id = ? AND title = ? AND archived = 0', PID, title,
    );

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

    // ---- R-13 复杂度越界防线（S-09 的行为料）：合法 4 原样落库；99 在 MCP schema 层即被拒、该行零落库 ----
    const okBatch = await callTool('mtask_create_plans', {
      projectId: PID,
      requirements: [{ reqNo: 'REQ-013', title: '复杂度合法档', content: '4 档原样落库' }],
      items: [{ title: 'C04 合法复杂度', durationDays: 2, reqNos: ['REQ-013'], complexity: 4 }],
    });
    const overBatch = await callTool('mtask_create_plans', {
      projectId: PID,
      requirements: [{ reqNo: 'REQ-014', title: '复杂度越界档', content: '99 应被拒收' }],
      items: [{ title: 'C99 越界复杂度', durationDays: 2, reqNos: ['REQ-014'], complexity: 99 }],
    });
    const c04 = planRow('C04 合法复杂度');
    const c99 = planRow('C99 越界复杂度');
    ok('R-13a complexity=4 经关联通道原样落库（合法档不被误伤）',
      !okBatch.isError && !!c04 && Number(c04.complexity) === 4,
      { isError: okBatch.isError, C04: c04?.complexity, text: okBatch.text.slice(0, 160) });
    ok('R-13b complexity=99 越界值进不了库（MCP schema 前置拒收 + 该行零落库；脏值无从谈起）',
      overBatch.isError && c99 === undefined,
      { isError: overBatch.isError, text: overBatch.text.slice(0, 200), C99行: c99 ?? null });

    // ---- 行为料回填（S 组在 R 组之后发射，反模式 14）----
    RT.linked = !linkBatch.isError;
    RT.counts = `${st?.requirements}/${st?.plans}/${st?.tasks}`;
    RT.channel = st?.channel;
    RT.refEdgeTarget = k2depsObjs.find((d) => d.type === 'serial')?.id ?? null;
    RT.refEdgeToK1Id = k2depsObjs.some((d) => d.id === k1?.id && d.type === 'serial');
    RT.unresolvedDepWarn = ((st?.warnings ?? []) as string[]).some((w) => w.includes('未解析到'));
    RT.incrementalAttachedExisting = !!k4 && parseArr(k4.req_ids).join() === reqIds['REQ-001'];
    RT.incrementalNewReqs = inc.structured?.requirements ?? -1;
    RT.incrementalReqIds = k4?.req_ids ?? null;
    RT.reentrantRejected = reRun.isError && reRun.text.includes('防重入拦截');
    RT.reentrantZeroWrite = planCountAfter === planCountBefore;
    RT.planCountBefore = planCountBefore;
    RT.planCountAfter = planCountAfter;
    RT.plainWarn = plainWarn.slice(0, 200);
    RT.plainWarnHasChannelHint = plainWarn.includes('纯计划通道') && plainWarn.includes('requirements');
    RT.plainRowReqIds = p1?.req_ids ?? null;
    RT.plainRowsReallyUnlinked = reallyUnlinked(p1);
    RT.plainInserted = plain.structured?.inserted ?? -1;
    RT.plainChannel = plain.structured?.channel;
    RT.plainChannelUndefined = plain.structured?.channel === undefined;
    RT.k2Status = k2?.status;
    RT.clampOutOfRangeRejected = overBatch.isError && c99 === undefined;
    RT.clampInRangeLanded = c04 ? Number(c04.complexity) : null;
    RT.unlinkedNamedInWarn = (bad.structured?.unlinkedReqNos ?? []).includes('REQ-999') && warn8.includes('REQ-999');
    RT.warningFieldsExposed = ['warnings', 'unlinkedReqNos', 'reqNoMap']
      .every((k) => k in (bad.structured ?? {}));
    RT.matrixRowsPerProject = (q1('SELECT COUNT(*) AS n FROM prd_requirements WHERE project_id = ?', PID) as { n: number }).n;
    RT.danglingCount = dangling.length;

    // ---- R-12a/R-12b 收口判据门内自证（判据 2：不靠生产库某批业务行的存在性）----
    ok('R-12a 孤儿收口判据改门内自证（判据 2：本单收口不靠生产库某批行）：关联通道写回的应关联行无一留下空 req_ids，故意悬空的那行是唯一例外且已被告警点名',
      (() => {
        const rows = qAll('SELECT title, req_ids FROM plan_tasks WHERE project_id = ? AND archived = 0', PID);
        return rows.filter((r: any) => LINK_TITLES.includes(r.title)).length === LINK_TITLES.length
          && orphanTitles(rows).length === 0
          && parseArr(planRow('K5 悬空引用')?.req_ids ?? '').length === 0
          && ((bad.structured?.warnings ?? []) as string[]).join('；').includes('REQ-999');
      })(),
      { 应关联行数: LINK_TITLES.length, 孤儿行: orphanTitles(qAll('SELECT title, req_ids FROM plan_tasks WHERE project_id = ? AND archived = 0', PID)) });

    // R-12b（2026-10-17 改造）：归档留痕改由门自身数据自证。原断言把生产库某批次的时间戳写死成
    // `= 12 行`，而那 12 行后续经 T01874「彻底删除」通道（PlanService.ts:1276
    // `DELETE FROM plan_tasks WHERE id = ? AND archived = 1`，用户主动清理）被清掉——
    // 依赖易变的生产数据会让门失去复跑价值（恒红）。
    const sample = qAll(
      "SELECT id, title FROM plan_tasks WHERE project_id = ? AND archived = 0 AND req_ids IS NOT NULL AND req_ids NOT IN ('', '[]') LIMIT 3", PID,
    ) as Array<{ id: string }>;
    for (const p of sample) await api('POST', `/plans/${p.id}/archive`);
    const softArchived = (q1('SELECT COUNT(*) AS n FROM plan_tasks WHERE project_id = ? AND archived = 1', PID) as { n: number }).n;
    const softRowsStillThere = qAll(
      'SELECT id, req_ids, linked_task_id FROM plan_tasks WHERE project_id = ? AND archived = 1', PID,
    ).filter((r: { req_ids: string | null }) => parseArr(r.req_ids).length > 0).length;
    for (const p of sample) await api('POST', `/plans/${p.id}/restore`);
    const afterRestore = (q1('SELECT COUNT(*) AS n FROM plan_tasks WHERE project_id = ? AND archived = 1', PID) as { n: number }).n;
    ok('R-12b 归档可逆留痕（门内自证）：软删行仍在库可查且关联字段不丢，恢复后归档态清零',
      sample.length === 3 && softArchived === 3 && softRowsStillThere === 3 && afterRestore === 0,
      { sample: sample.length, softArchived, softRowsStillThere, afterRestore });

    // ---- R-12c 生产库现状：只留痕、不判定（判据 2 禁止门断言生产业务数据存在性）——
    //      四期那批 K/M-K 行此后可能被用户走 T01874 彻底删除通道清掉，拿它判红等于让门失去复跑价值。
    try {
      const prodDbPath = join(process.env.APPDATA ?? '', 'MTask', 'data', 'mtask.db');
      if (!existsSync(prodDbPath)) {
        skipped('R-12c 生产库 K/M-K 批次现状（仅留痕，不参与判定）', `生产库不存在（${prodDbPath}）`);
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
          "SELECT COUNT(*) AS n FROM plan_tasks WHERE project_id = ? AND archived = 1",
        ).get(FOUR) as { n: number }).n;
        dst.close();
        srcDb.close();
        skipped('R-12c 生产库 K/M-K 批次现状（仅留痕，不参与判定）',
          `生产库副本现状：未归档 K/M-K ${liveOrphan} 行、归档态 ${archivedOrphan} 行。本单收口判据已由 R-12a 在门内数据自证、
          R-12b 自证归档可逆；此处只记录外部现状供人工对照，门不据此判红（判据 2）`);
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

// 隔离实例收口（本机门族通坑）：taskkill 是异步的，子进程句柄没释放就删目录会留下残骸
await new Promise<void>((res) => {
  if (child.exitCode !== null || child.signalCode !== null) return res();
  child.once('exit', () => res());
  setTimeout(res, 8000);
});
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);

// =====================================================================
// S 组发射（反模式 14：行为腿依赖 R 组实测料，必须等运行期跑完再判）
// =====================================================================
group('S 组：契约守卫发射（HEAD 字面锚 × 运行期实测）');
okPair(ok, 'S-00 字面腿取证对象非空（HEAD 源码读到了，不是拿空串比空串）',
  () => RT.channel !== undefined || RT.linked !== undefined,
  () => mcpSrc.length > 2000 && planServiceSrc.length > 2000,
  () => ({ mcp行数: mcpSrc.split('\n').length, planService行数: planServiceSrc.split('\n').length }));
if (RT.channel === undefined) {
  S_PAIRS.forEach((s) => skipped(s.label, 'R 组隔离实例未跑通（缺 channel 等运行期料）——行为料缺失时不以字面锚冒充 PASS'));
} else {
  S_PAIRS.forEach((s) => okPair(ok, s.label, s.behavior, () => s.literal(mcpSrc, planServiceSrc), s.ctx));
}

// =====================================================================
// N 组：负对照（本轮每条改判都配牙齿——判据红得下来才算真判据）
// =====================================================================
group('N 组：负对照');
try {
  // N-01 空源码探针：10 条字面腿喂空串必须全红（否则该腿是永真式，不承重）
  const vacuous = S_PAIRS.filter((s) => s.literal('', '') === true).map((s) => s.label);
  ok('N-01 字面腿无永真式（喂空源码 10 条全部翻红）', vacuous.length === 0, { 空串仍为真的腿: vacuous });

  // N-02 具体变异对照：把 S-02 的两个字面锚目标分别改名，同一条判据必须各自翻红；先自证变异真的落进了副本
  const s02 = S_PAIRS[1];
  const tamperLinkage = mcpSrc.replace('const wantLinkage = ', 'const gateRenamedLink = ');
  const tamperImportCall = mcpSrc.replace('PlanService.importPrd(pid, {', 'PlanService.gateRenamedImport(pid, {');
  ok('N-02 字面腿有牙（S-02 两个锚点分别改名后同一条判据各自翻红，非换皮永真）',
    tamperLinkage !== mcpSrc && tamperImportCall !== mcpSrc
    && s02.literal(mcpSrc, planServiceSrc) === true
    && s02.literal(tamperLinkage, planServiceSrc) === false
    && s02.literal(tamperImportCall, planServiceSrc) === false,
    { 原文为真: s02.literal(mcpSrc, planServiceSrc), 改wantLinkage后: s02.literal(tamperLinkage, planServiceSrc), 改importPrd调用后: s02.literal(tamperImportCall, planServiceSrc) });

  // N-03 行为腿敏感性：抽掉运行期料（清空 RT）后 10 条行为腿必须全红，恢复后全绿
  const savedRT = { ...RT };
  Object.keys(RT).forEach((k) => { delete RT[k]; });
  const insensitive = S_PAIRS.filter((s) => s.behavior() === true).map((s) => s.label);
  Object.entries(savedRT).forEach(([k, v]) => { RT[k] = v; });
  const afterRestore = S_PAIRS.filter((s) => s.behavior() !== true).map((s) => s.label);
  ok('N-03 行为腿不空转（清空运行期料后全红、恢复后全绿）',
    insensitive.length === 0 && afterRestore.length === 0,
    { 无料仍为真: insensitive, 恢复后为假: afterRestore });

  // N-04/N-05 判据 SQL 有牙：在**门自身临时库的副本**上造反例（绝不写生产库、也不再写活实例的库）
  const Database = (await import('better-sqlite3')).default;
  const copyPath = join(DATA_DIR, 'negative-copy.db');
  if (!PID || !existsSync(DB_PATH())) {
    skipped('N-04/N-05 孤儿判据与纯通道判据的反例对照', `门内夹具库不可用（PID=${PID || '未建'}）`);
  } else {
    const live = new Database(DB_PATH());
    await live.backup(copyPath);
    live.close();
    const neg = new Database(copyPath);
    const readRows = () => neg.prepare(
      'SELECT title, req_ids, linked_task_id FROM plan_tasks WHERE project_id = ? AND archived = 0',
    ).all(PID) as Array<{ title: string; req_ids: string | null; linked_task_id: string | null }>;

    const beforeOrphans = orphanTitles(readRows());
    const k1 = neg.prepare("UPDATE plan_tasks SET req_ids = '[]' WHERE project_id = ? AND title = 'K1 材料收集'").run(PID);
    const k1NowEmpty = parseArr((neg.prepare(
      "SELECT req_ids FROM plan_tasks WHERE project_id = ? AND title = 'K1 材料收集'",
    ).get(PID) as { req_ids: string }).req_ids).length === 0;
    const afterOrphans = orphanTitles(readRows());
    ok('N-04 孤儿收口判据有牙（副本上把 K1 的 req_ids 清空，同一谓词必须点名它；且自证 UPDATE 真的落进副本）',
      k1.changes === 1 && beforeOrphans.length === 0 && k1NowEmpty
      && afterOrphans.length === 1 && afterOrphans[0] === 'K1 材料收集',
      { 清空前: beforeOrphans, 清空后: afterOrphans, UPDATE影响行: k1.changes });

    const plainBefore = reallyUnlinked(readRows().find((r) => r.title === 'P1 纯计划A'));
    const p2 = neg.prepare("UPDATE plan_tasks SET req_ids = '[\"REQ-901\"]', linked_task_id = 'gate-fake-task' WHERE project_id = ? AND title = 'P1 纯计划A'").run(PID);
    const plainAfter = reallyUnlinked(readRows().find((r) => r.title === 'P1 纯计划A'));
    ok('N-05 纯计划通道「真未关联」判据有牙（副本上补上 req_ids+linked_task_id，判据必须翻假）',
      p2.changes === 1 && plainBefore === true && plainAfter === false,
      { 补关联前: plainBefore, 补关联后: plainAfter });
    neg.close();
  }

  // N-06 用**产品真函数**取证（不是把判据文案抄一遍）：clampComplexity 边界语义 + listInvalid 能点名脏值
  try {
    const PC = await import('../server/src/services/PlanComplexity.ts');
    const sweep: Array<[unknown, number | null]> =
      [[1, 1], [5, 5], ['4', 4], [3.5, 4], [0, null], [6, null], [99, null], [NaN, null], ['abc', null], [null, null]];
    const wrong = sweep.filter(([v, want]) => PC.clampComplexity(v) !== want)
      .map(([v, want]) => `${String(v)}→${String(PC.clampComplexity(v))}（期望 ${String(want)}）`);
    ok('N-06a clampComplexity 真函数边界语义（1/5/"4"/3.5 归位；0/6/99/NaN/abc/null 一律为 null）',
      wrong.length === 0, { 偏差: wrong, 实测: sweep.map(([v]) => `${String(v)}→${String(PC.clampComplexity(v))}`).join(' ') });

    if (!PID || !existsSync(DB_PATH())) {
      skipped('N-06b listInvalid 反例对照', `门内夹具库不可用（PID=${PID || '未建'}）`);
    } else {
      const raw = new Database(DB_PATH());
      const cols = (raw.prepare('PRAGMA table_info(plan_tasks)').all() as Array<{ name: string }>).map((c) => c.name);
      const seed = raw.prepare(
        'SELECT * FROM plan_tasks WHERE project_id = ? AND archived = 0 ORDER BY id LIMIT 1',
      ).get(PID) as Record<string, unknown> | undefined;
      if (!seed) {
        skipped('N-06b listInvalid 反例对照', '门内库无计划行可作脏值模板');
      } else {
        const before = PC.listInvalid(PID).length;
        const dirty = { ...seed, id: 'gate-n06-dirty', title: 'N06 脏复杂度', complexity: 99, archived: 0 };
        raw.prepare(`INSERT INTO plan_tasks (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
          .run(...cols.map((c) => dirty[c] ?? null));
        const hit = PC.listInvalid(PID) as Array<{ title: string; complexity: number }>;
        raw.prepare("DELETE FROM plan_tasks WHERE id = 'gate-n06-dirty'").run();
        const after = PC.listInvalid(PID).length;
        ok('N-06b listInvalid 有牙（门自身临时库里造一行 complexity=99，产品函数必须点名它；清掉后即归位）',
          hit.length === before + 1 && hit.some((h) => h.title === 'N06 脏复杂度' && h.complexity === 99) && after === before,
          { 造脏值前: before, 命中: hit.map((h) => `${h.title}=${h.complexity}`), 清掉后: after });
      }
      raw.close();
    }
    // 产品模块在父进程里另开了一条连接，不收掉会锁住临时库文件、让结尾的 DATA_DIR 回收失败
    const { closeDb } = await import('../server/src/db/connection.ts');
    closeDb();
  } catch (e) {
    skipped('N-06 clampComplexity/listInvalid 产品真函数取证', `产品模块不可导入：${(e as Error).message.slice(0, 120)}`);
  }
} catch (e) {
  ok('N 组执行异常', false, { error: (e as Error).message, stack: (e as Error).stack?.slice(0, 400) });
}

// =====================================================================
// 汇总 + 落盘（GBK 控制台规避：以文件为权威）
// =====================================================================
const summary = `T02131 计划回写关联通道（矩阵/待办/req_ids）：PASS=${pass} FAIL=${fail}\n`
  + results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.extra ? ` :: ${r.extra}` : ''}`).join('\n') + '\n';
mkdirSync(join(ROOT, '.workbuddy'), { recursive: true });
writeGateResults(join(ROOT, '.workbuddy'), 't02131-gate-results.txt', summary, { port: PORT, dataDir: DATA_DIR });
writeGateResults(join(ROOT, '.workbuddy'), 't02131-gate-results.json', JSON.stringify({ pass, fail, results }, null, 2), { port: PORT, dataDir: DATA_DIR });
console.log(`\n${summary}`);

let cleaned = false;
for (let i = 0; i < 12; i++) {
  try { rmSync(DATA_DIR, { recursive: true, force: true }); cleaned = true; break; }
  catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
}
if (!cleaned) console.log(`⚠ 临时库目录未回收（句柄仍被占用，需手工删）：${DATA_DIR}`);
process.exit(fail === 0 ? 0 : 1);
