#!/usr/bin/env node
/**
 * T02354 验收门：MCP 通道 `mtask_import_prd` 的 `dryRun` 预演（只读、与页面通道同判据）。
 *
 * 拦的是什么：
 *  ① 「预演冒充只读」——Agent 是最容易重复导入把需求跟踪矩阵翻倍的调用方（T02303 实测 35→70），
 *     它之所以敢先试一次，全靠 dryRun 真的零写库；M-01/M-03/M-04/M-05/M-06 每一腿前后都取全库快照。
 *  ② 「两套判重分叉」——MCP 壳若在自身里另算一份（或漏传 createTasks/prdFilename/onDuplicatePlan），
 *     报给 Agent 的数与实落库对不上。M-02/M-03/M-05 逐条比「预演计数 == 实落库增量」，
 *     M-04 更要 MCP 预演与 HTTP `/api/plans/import-prd/preview` 在**同一库状态**下逐字段全等。
 *  ③ 「恒绿摆设」——夹具特意造了「同标题、不同内容」的一行（R2）：reuse 模式下真判据判它新建，
 *     只看标题判它复用；又造了一个不存在的编号 REQ-900 让 unlinked 恒非空。
 *     N-02 更把「参数被advertise 却被忽略、直接落库」的缺陷变体打在 HEAD 副本上，逼零写库红线亮红。
 *
 * 通道纪律（判据写法服从 T02293）：
 *  - 夹具自造：门自建 4 个项目、自起 mock AI 厂商桩（零真实配额），payload 逐字节固定；
 *  - 不锁实现字面量：断言全部打在 MCP tools/call 的 structuredContent、HTTP 响应与库内容上；
 *    G-05 的 tools/list schema 腿只作「契约在场」，其价值由 M-01 的行为腿承担（N-02 证明只靠 schema 抓不住缺陷）；
 *  - 隔离实例：`MTask_PORT` 默认 39962（`T02354_PORT` 可覆盖，避开 39877 生产实例），
 *    `MTask_DATA_DIR` 每次 `mkdtemp` 新建并落 **D:**（C 盘常年 0 可用会假性 SQLITE_FULL）；
 *  - 负对照只在 `git worktree add --detach` 副本里动刀，主仓工作树一个字节都不写（N-03 用 sha256 自证）。
 *
 * 用法：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02354-mcp-prd-preview.mts
 *   环境变量：T02354_PORT、T02354_TMP_ROOT（默认 D:/code/tmp）、T02354_KEEP=1 保留临时目录
 */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';
import { resolveServerLauncher } from './isolated-server-launcher.mts';

const require = createRequire(join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'package.json'));
const sqlite = require('better-sqlite3') as typeof import('better-sqlite3');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');
const OUT_BASE = 't02354-mcp-prd-preview-gate-results.txt';
const PORT = Number(process.env.T02354_PORT ?? 39962);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP_ROOT = process.env.T02354_TMP_ROOT ?? 'D:/code/tmp';
const KEEP = process.env.T02354_KEEP === '1';
const FIXTURE_FILE = 't02354-fixture.md';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lines: string[] = [];
let pass = 0;
let failCount = 0;
const info = (m: string) => { console.log(`  [INFO] ${m}`); lines.push(`[INFO] ${m}`); };
const ok = (id: string, m: string, detail = '') => { pass += 1; console.log(`  [PASS] ${id} ${m}${detail ? ` → ${detail}` : ''}`); lines.push(`[PASS] ${id} ${m}${detail ? ` → ${detail}` : ''}`); };
const fail = (id: string, m: string, detail = '') => { failCount += 1; console.log(`  [FAIL] ${id} ${m}${detail ? ` → ${detail}` : ''}`); lines.push(`[FAIL] ${id} ${m}${detail ? ` → ${detail}` : ''}`); };
const check = (id: string, cond: boolean, m: string, detail = '') => (cond ? ok(id, m, detail) : fail(id, m, detail));

// =====================================================================
// 夹具：两份逐字节固定的 PRD 正文 + mock AI 桩（按正文里的「模式：Rx」回固定解析结果）
//   正文不得含时间戳——同一份文件两次上传必须命中同一 content_hash，prdDoc 判定才可对账。
// =====================================================================
const FIXTURE_R1_MD = '# T02354 门内夹具 PRD\n\n模式：R1\n\n- 预演通道参数、计数透出、同标题改内容的一行。\n';
const FIXTURE_R2_MD = '# T02354 门内夹具 PRD\n\n模式：R2\n\n- 同标题那一行的内容改了一版：真判据（标题+内容）必须判它新建。\n';
const REQ_T1 = 'MCP 预演参数';
const REQ_T2 = '预演计数透出';
const REQ_T3 = '同标题改内容的一行';
const PLAN_T1 = '1 里程碑：MCP 预演通道';
const PLAN_T2 = '1.1 落码 dryRun 分支';
const PLAN_T3 = '1.2 对账门';
const MODEL_REPLIES: Record<string, unknown> = {
  R1: {
    requirements: [
      { reqNo: 'REQ-001', title: REQ_T1, content: 'dryRun 布尔入参', sourceRef: '§1', priority: 'high' },
      { reqNo: 'REQ-002', title: REQ_T2, content: '原样透出计数与明细', sourceRef: '§2', priority: 'normal' },
      { reqNo: 'REQ-003', title: REQ_T3, content: 'R1 版内容', sourceRef: '§3', priority: 'normal' },
    ],
    plans: [
      { title: PLAN_T1, description: '顶层里程碑', durationDays: 5, reqNos: [], kind: 'milestone' },
      { title: PLAN_T2, description: '与 importPrd 共用判重函数', durationDays: 2, reqNos: ['REQ-001'], kind: 'normal', complexity: 2 },
      { title: PLAN_T3, description: '预演计数 == 实落库增量', durationDays: 3, reqNos: ['REQ-002', 'REQ-900'], kind: 'normal', complexity: 3 },
    ],
  },
  R2: {
    requirements: [
      { reqNo: 'REQ-001', title: REQ_T1, content: 'dryRun 布尔入参', sourceRef: '§1', priority: 'high' },
      { reqNo: 'REQ-002', title: REQ_T2, content: '原样透出计数与明细', sourceRef: '§2', priority: 'normal' },
      { reqNo: 'REQ-003', title: REQ_T3, content: 'R2 版内容（改了）', sourceRef: '§3', priority: 'normal' },
    ],
    plans: [
      { title: PLAN_T1, description: '顶层里程碑', durationDays: 5, reqNos: [], kind: 'milestone' },
      { title: PLAN_T2, description: '与 importPrd 共用判重函数', durationDays: 2, reqNos: ['REQ-001'], kind: 'normal', complexity: 2 },
      { title: PLAN_T3, description: '预演计数 == 实落库增量', durationDays: 3, reqNos: ['REQ-002', 'REQ-900'], kind: 'normal', complexity: 3 },
    ],
  },
};
const mockHits: string[] = [];
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    let j: any = {};
    try { j = JSON.parse(body); } catch { /* 坏请求回空 */ }
    const user = String((j.messages ?? []).filter((m: any) => m.role === 'user').map((m: any) => m.content).join('\n'));
    const mode = /模式：(R\d)/.exec(user)?.[1] ?? 'R1';
    mockHits.push(mode);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(MODEL_REPLIES[mode] ?? MODEL_REPLIES.R1) } }] }));
  });
});
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
const MOCK_PORT = (mock.address() as { port: number }).port;

// =====================================================================
// 隔离实例（可按 root 启动：主仓 / HEAD 副本）
// =====================================================================
type Launcher = ReturnType<typeof resolveServerLauncher>;
const LAUNCHERS = new Map<string, Launcher>();
function launcherFor(root: string): Launcher {
  let l = LAUNCHERS.get(root);
  if (!l) { l = resolveServerLauncher(root, join(root, 'server', 'src', 'index.ts')); LAUNCHERS.set(root, l); }
  return l;
}
let server: ReturnType<typeof spawn> | null = null;
let serverLog = '';

function pidsListening(port: number): string[] {
  let out = '';
  try { out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' }); } catch { return []; }
  const set = new Set<string>();
  for (const line of out.split('\n')) {
    if (!/LISTENING/i.test(line) || !new RegExp(`:${port}(\\s|$)`).test(line)) continue;
    const pid = line.trim().split(/\s+/).pop() ?? '';
    if (/^\d+$/.test(pid)) set.add(pid);
  }
  return [...set];
}
function killTree(pid: number) {
  try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已不在 */ }
}
function tailOf(file: string): string {
  try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 240); } catch { return '(日志读不出)'; }
}

async function startServer(root: string, dataDir: string, sandbox: string): Promise<void> {
  const launcher = launcherFor(root);
  mkdirSync(dataDir, { recursive: true });
  const logFile = join(dataDir, 'server.log');
  const fd = openSync(logFile, 'a');
  server = spawn(launcher.exec, launcher.tsx, {
    cwd: root,
    env: { ...process.env, ...launcher.env, MTask_PORT: String(PORT), MTask_DATA_DIR: dataDir, MTask_LOG_DIR: dataDir, TMP: sandbox, TEMP: sandbox },
    stdio: ['ignore', fd, fd],
  });
  info(`启动器：${launcher.label}（cwd=${root}）`);
  const t0 = Date.now();
  let warned = 0;
  for (;;) {
    if (server && server.exitCode !== null) throw new Error(`实例过早退出 code=${server.exitCode}，看 ${logFile}`);
    try { if ((await fetch(`${BASE}/api/health`)).ok) { info(`[instance up] 用时 ${Math.round((Date.now() - t0) / 1000)}s · 数据目录 ${dataDir}`); return; } } catch { /* 未就绪 */ }
    const took = Date.now() - t0;
    if (took > 420_000) throw new Error(`实例启动超时（${Math.round(took / 1000)}s），看 ${logFile}；端口持有者 ${pidsListening(PORT).join(',') || '(无)'}`);
    if (took > warned * 60_000) { warned += 1; info(`[waiting ${Math.round(took / 1000)}s] 未就绪，日志尾部：${tailOf(logFile)}`); }
    await sleep(1_000);
  }
}

async function stopServer(): Promise<void> {
  const s = server;
  server = null;
  const killAll = () => {
    if (s?.pid) killTree(s.pid);
    for (const pid of pidsListening(PORT)) killTree(Number(pid));
  };
  killAll();
  const t0 = Date.now();
  for (;;) {
    let up = false;
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { /* 已无应答 */ }
    if (!up && pidsListening(PORT).length === 0) return;
    if (Date.now() - t0 > 30_000) { info('实例收口超时（端口仍被持有）——后续复跑请先查残留进程'); return; }
    killAll();
    await sleep(1_000);
  }
}

// ---------- 库快照（只读连接，绝不开写事务；用完即关，避免 Windows 上钉住 db 文件） ----------
type Db = ReturnType<typeof sqlite>;
const openDb = (dbFile: string): Db => sqlite(dbFile, { readonly: true });
const tableNames = (db: Db): string[] =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>).map((r) => r.name);
function snapshot(db: Db, tables: string[]): Map<string, { digest: string; rows: number }> {
  const out = new Map<string, { digest: string; rows: number }>();
  for (const t of tables) {
    const rows = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all() as Array<Record<string, unknown>>;
    out.set(t, { digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex'), rows: rows.length });
  }
  return out;
}
function diffTables(a: Map<string, { digest: string; rows: number }>, b: Map<string, { digest: string; rows: number }>): string[] {
  const changed: string[] = [];
  for (const [t, v] of b) if (a.get(t)?.digest !== v.digest) changed.push(`${t}(${a.get(t)?.rows ?? '-'}→${v.rows})`);
  return changed;
}

// ---------- HTTP ----------
async function postJson(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 400) }; }
  return { status: res.status, json };
}
async function getJson(path: string): Promise<any> {
  const res = await fetch(`${BASE}/api/${path}`);
  try { return await res.json(); } catch { return null; }
}

// ---------- MCP 通道（streamable HTTP：SSE 帧要拼完再解析，T01490/T00978 教训） ----------
function makeMcp() {
  let sessionId = '';
  let rpcId = 0;
  async function raw(payload: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${BASE}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
      body: JSON.stringify(payload),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    const text = await res.text();
    const frames = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    try { return JSON.parse(frames || text); } catch { return undefined; }
  }
  async function init() {
    await raw({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify-t02354', version: '1.0' } } });
    await raw({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }
  async function listTools(): Promise<any[]> {
    const body = await raw({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} });
    return (body as any)?.result?.tools ?? [];
  }
  async function callTool(name: string, args: Record<string, unknown>) {
    const body = await raw({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });
    const rpcErr = (body as any)?.error;
    if (rpcErr) return { isError: true, text: `JSON-RPC ${JSON.stringify(rpcErr)}`, structured: {} as Record<string, any> };
    const r = (body as any)?.result ?? {};
    return { isError: r?.isError === true, text: String(r?.content?.[0]?.text ?? ''), structured: (r?.structuredContent ?? {}) as Record<string, any> };
  }
  return { init, listTools, callTool };
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

async function main() {
  const tmp = mkdtempSync(join(TMP_ROOT, 't02354-gate-'));
  const dataDir = join(tmp, 'data');
  const dbFile = join(dataDir, 'mtask.db');
  info(`临时根 ${tmp} · 实例 http://127.0.0.1:${PORT} · mock AI 127.0.0.1:${MOCK_PORT}`);
  lines.push('T02293 判据口径：夹具自造 / 不锁实现字面量 / 不依赖生产数据 / 每条改法配负对照');
  let negRoot = '';
  let mcp: ReturnType<typeof makeMcp> | null = null;

  try {
    // ---------- G 组：通道前提 ----------
    const holders = pidsListening(PORT);
    if (holders.length > 0) { fail('G-01', `端口 ${PORT} 已被 ${holders.join(',')} 占用——本门必须自起隔离实例`); throw new Error('端口不干净'); }
    ok('G-01', '端口空闲自检：断言只打在本门自起的隔离实例上');

    await startServer(ROOT, dataDir, tmp);
    check('G-02', existsSync(dbFile), '隔离实例已建库（MTask_DATA_DIR 落 D 盘临时目录）', dbFile);

    const pids: string[] = [];
    for (const n of ['甲', '乙', '丙', '丁']) {
      const name = `T02354 预演门项目${n}-${Date.now()}-${n}`;
      await postJson('projects', { name, description: '门内夹具项目，仅用于 MCP PRD 预演对账。' });
      const list = (await getJson('projects')) as Array<{ id: string; name: string }>;
      const hit = list.find((p) => p.name === name);
      if (!hit) { fail('G-03', `夹具项目「${n}」没建成`); throw new Error('夹具不可用'); }
      pids.push(hit.id);
    }
    ok('G-03', '四个夹具项目建成（甲=首轮同形 / 乙=双通道对账 / 丙=待办连带 / 丁=缺省回归），断言全打在它们身上');

    const tool = await postJson('aitools', {
      name: 't02354-mock', type: 'openai-compatible', endpoint: `http://127.0.0.1:${MOCK_PORT}`,
      apiKey: 'mock-key', model: 'mock-prd-parse', timeoutMs: 20_000,
    });
    const toolId = String(tool.json?.id ?? '');
    check('G-04', tool.status < 300 && !!toolId, '门内 mock AI 厂商桩已登记为工具（零真实配额，解析结果逐字节固定）', `status=${tool.status} toolId=${toolId}`);

    mcp = makeMcp();
    await mcp.init();
    const tools = await mcp.listTools();
    const impTool = tools.find((t: any) => t?.name === 'mtask_import_prd');
    check('G-05', !!impTool?.inputSchema?.properties?.dryRun,
      '契约腿：tools/list 里 mtask_import_prd 的入参 schema 含 dryRun（此腿的价值由 M-01 行为腿承担，N-02 证明只靠它抓不住「报参数不认账」）',
      `properties=${Object.keys(impTool?.inputSchema?.properties ?? {}).join(',').slice(0, 160)}`);

    // ---------- 噪声自标定：哪些表与导入无关（服务自身定时写入 + AI 计量），不计入只读红线 ----------
    const db0 = openDb(dbFile);
    const tables = tableNames(db0);
    db0.close();
    check('G-06', tables.length > 0, `库内表清点（${tables.length} 张，快照覆盖面动态取，不硬编码表名）`);
    const bizSnap = () => { const d = openDb(dbFile); try { return snapshot(d, BIZ_TABLES); } finally { d.close(); } };
    const snapAll = () => { const d = openDb(dbFile); try { return snapshot(d, tables); } finally { d.close(); }; };
    const s0 = snapAll();
    await sleep(4_000);
    const idleNoise = diffTables(s0, snapAll());
    // 纯解析调用（HTTP ai-parse-prd：跑同一条 aiParsePrd、零写业务表）——它摸过的表就是「AI 计量类」表
    const parseRes = await fetch(`${BASE}/api/plans/ai-parse-prd?projectId=${pids[0]}&toolId=${toolId}&filename=${FIXTURE_FILE}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: FIXTURE_R1_MD,
    });
    const parsed = await parseRes.json() as any;
    await sleep(1_500);
    const parseNoise = diffTables(s0, snapAll());
    const noise = [...new Set([...idleNoise, ...parseNoise])];
    info(`噪声/计量表（服务自身与 AI 调用写入，不计入只读红线）：${noise.join('、') || '(无)'}`);
    const BIZ_TABLES = tables.filter((t) => !noise.some((n) => n.startsWith(`${t}(`)));
    check('G-07', parseRes.status === 200 && (parsed?.requirements ?? []).length === 3 && (parsed?.drafts ?? []).length === 3,
      'mock 桩解析链路可用，且 aiParsePrd 归一化后的载荷正是后续 HTTP 对账要投的那一份（3 需求 / 3 计划）',
      `requirements=${(parsed?.requirements ?? []).length} drafts=${(parsed?.drafts ?? []).length}`);
    const PAGE_PAYLOAD = { requirements: parsed.requirements, plans: parsed.drafts };
    const importTouched: string[] = [];
    const countRows = (table: string, projectId: string): number => {
      const d = openDb(dbFile);
      try { return (d.prepare(`SELECT count(*) AS c FROM "${table}" WHERE project_id = ?`).get(projectId) as { c: number }).c; } finally { d.close(); }
    };
    const readRows = (sql: string): any[] => {
      const d = openDb(dbFile);
      try { return d.prepare(sql).all() as any[]; } finally { d.close(); }
    };

    const importVia = (projectId: string, md: string, extra: Record<string, unknown> = {}) =>
      mcp!.callTool('mtask_import_prd', { projectId, toolId, filename: FIXTURE_FILE, fileBase64: b64(md), createTasks: false, ...extra });

    // ---------- M-01/M-02：首轮预演零写库 + 预演计数 == 实落库增量 ----------
    const before1 = bizSnap();
    const pv1r = await importVia(pids[0], FIXTURE_R1_MD, { dryRun: true });
    const afterPv1 = bizSnap();
    const pv1 = pv1r.structured?.preview ?? {};
    const drift1 = diffTables(before1, afterPv1);
    check('M-01a', pv1r.isError === false && pv1r.structured?.dryRun === true && pv1r.structured?.readOnly === true,
      'dryRun:true 走预演分支并自证只读（isError=false + dryRun/readOnly 标记）', `text=${pv1r.text.slice(0, 120)}`);
    check('M-01b', drift1.length === 0, '只读红线：MCP 预演前后全部业务表逐字节不变', drift1.length ? `变化表 ${drift1.join('、')}` : `${BIZ_TABLES.length} 张表零漂移`);
    check('M-01c', pv1.willCreateReqs === 3 && pv1.willReuseReqs === 0 && pv1.willCreatePlans === 3 && pv1.willRenamePlans === 0
      && (pv1.reqNoMap ?? []).length === 0 && (pv1.unlinkedReqNos ?? []).includes('REQ-900') && (pv1.orphanRequirements ?? []).length === 1
      && pv1.prdDoc?.action === 'create' && pv1.createTasks === false,
      '首轮预演计数（判别力自证：全新项目里 3 建 0 复用、REQ-900 被点名、零关联需求 1 条、PRD 判 create）——空壳/恒零实现在这里必红',
      `req ${pv1.willCreateReqs}/${pv1.willReuseReqs} plan ${pv1.willCreatePlans}/${pv1.willReusePlans} unlinked ${JSON.stringify(pv1.unlinkedReqNos)} orphan ${(pv1.orphanRequirements ?? []).length}`);

    const im1r = await importVia(pids[0], FIXTURE_R1_MD);
    const im1 = im1r.structured?.imported ?? {};
    const afterIm1 = bizSnap();
    const d1 = diffTables(before1, afterIm1);
    importTouched.push(...d1);
    const reqN1 = countRows('prd_requirements', pids[0]);
    const planN1 = countRows('plan_tasks', pids[0]);
    const docN1 = countRows('prd_docs', pids[0]);
    const taskN1 = countRows('tasks', pids[0]);
    check('M-02a', im1.requirementsCreated === pv1.willCreateReqs && im1.reusedRequirements === pv1.willReuseReqs
      && im1.plans === pv1.willCreatePlans && im1.reusedPlans === pv1.willReusePlans && im1.requirementsCreated === 3 && im1.plans === 3,
      '同形（回传侧）：预演计数与导入回传逐条相等（3 建 0 复用）',
      `preview ${pv1.willCreateReqs}/${pv1.willCreatePlans} vs import ${im1.requirementsCreated}/${im1.plans}`);
    check('M-02b', reqN1 === pv1.willCreateReqs && planN1 === pv1.willCreatePlans && docN1 === 1 && taskN1 === 0,
      '同形（库侧）：项目内需求行数 == 预演预告的 willCreateReqs，计划行数 == willCreatePlans，PRD 文档 +1，待办 0 行（createTasks=false）',
      `库内 需求${reqN1}/计划${planN1}/文档${docN1}/待办${taskN1}`);
    const linkedPlans = (readRows(`SELECT title, req_ids FROM plan_tasks WHERE project_id='${pids[0]}'`)).filter((r: any) => String(r.req_ids ?? '').trim());
    check('M-02c', linkedPlans.length === 2, '矩阵↔计划关联如实落库：三条计划里恰有两条带 req_ids（里程碑行不挂需求，与预演的 orphan 口径一致）', linkedPlans.map((r: any) => r.title).join(' / '));

    // ---------- M-03：落库后再预演同一份 payload —— 翻倍预警（T02303 场景）提前看得见 ----------
    const before3 = bizSnap();
    const pv3 = (await importVia(pids[0], FIXTURE_R1_MD, { dryRun: true })).structured?.preview ?? {};
    const drift3 = diffTables(before3, bizSnap());
    check('M-03a', drift3.length === 0, '同一份 payload 落库后再预演，仍然零写库（预演不是「偷偷试导」）', `${BIZ_TABLES.length} 张表逐字节不变`);
    check('M-03b', pv3.willCreateReqs === 3 && pv3.willReuseReqs === 0 && (pv3.reqNoMap ?? []).length === 3
      && (pv3.reqNoMap ?? []).every((x: any) => x.from !== x.to) && pv3.willCreatePlans === 3 && pv3.willRenamePlans === 3
      && pv3.prdDoc?.action === 'reuse' && pv3.prdDoc?.by === 'hash',
      '预演读的是当前库状态而非硬编码：撞号全部让号（3 条 from≠to）、撞名计划全部换后缀（3 条）、同内容 PRD 判 reuse(by hash)——「矩阵还会 +3 行」在导入前就摆在 Agent 面前',
      `reqNoMap ${JSON.stringify(pv3.reqNoMap)}`);
    const im3 = (await importVia(pids[0], FIXTURE_R1_MD)).structured?.imported ?? {};
    const d3 = diffTables(before3, bizSnap());
    importTouched.push(...d3);
    const reqN3 = countRows('prd_requirements', pids[0]);
    const planN3 = countRows('plan_tasks', pids[0]);
    const docN3 = countRows('prd_docs', pids[0]);
    const landedNos = readRows(`SELECT req_no FROM prd_requirements WHERE project_id='${pids[0]}'`).map((r: any) => r.req_no);
    check('M-03c', im3.requirementsCreated === pv3.willCreateReqs && reqN3 === reqN1 + pv3.willCreateReqs
      && im3.plans === pv3.willCreatePlans && planN3 === planN1 + pv3.willCreatePlans && docN3 === docN1,
      '翻倍如实发生且被预告：需求行 3→6 == 预演的 willCreateReqs，计划行 3→6 == willCreatePlans，PRD 文档不增（判重同源的最硬证据）',
      `库里 需求${reqN1}→${reqN3} / 计划${planN1}→${planN3} / 文档${docN3}`);
    check('M-03d', (pv3.reqNoMap ?? []).every((x: any) => landedNos.includes(x.to)) && readRows(`SELECT title FROM plan_tasks WHERE project_id='${pids[0]}'`).filter((r: any) => /（\d+）/.test(String(r.title))).length === 3,
      '预演报的让号编号与改名后缀逐条在库里查得到（Agent 据此能预判落库长什么样，不是空口计数）',
      `让号落库 ${JSON.stringify((pv3.reqNoMap ?? []).map((x: any) => x.to))} / 带后缀计划 3 行`);

    // ---------- M-04：双通道同判据（MCP 预演 vs HTTP preview，同一库状态、同一份 payload） ----------
    for (const reuse of [false, true]) {
      const tag = reuse ? 'reuse' : 'new';
      const b4 = bizSnap();
      const pvMcp = (await importVia(pids[1], FIXTURE_R1_MD, { ...(reuse ? { onDuplicatePlan: 'reuse' } : {}), dryRun: true })).structured?.preview ?? {};
      const drift4 = diffTables(b4, bizSnap());
      const pvHttp = (await postJson('plans/import-prd/preview', {
        projectId: pids[1], createTasks: false, prdMd: FIXTURE_R1_MD, prdFilename: FIXTURE_FILE,
        requirements: PAGE_PAYLOAD.requirements, plans: PAGE_PAYLOAD.plans, ...(reuse ? { onDuplicatePlan: 'reuse' } : {}),
      })).json;
      const keys = ['willCreateReqs', 'willReuseReqs', 'willCreatePlans', 'willReusePlans', 'willRenamePlans', 'requirements', 'createTasks', 'readOnly'];
      const fieldMismatch = keys.filter((k) => JSON.stringify(pvMcp[k]) !== JSON.stringify(pvHttp[k]));
      const deepMismatch = ['reqNoMap', 'dupPlanTitles', 'unlinkedReqNos', 'ambiguousReqNos', 'orphanRequirements', 'prdDoc', 'planRowsPreview']
        .filter((k) => JSON.stringify(pvMcp[k] ?? null) !== JSON.stringify(pvHttp[k] ?? null));
      check(`M-04${reuse ? 'b' : 'a'}`, drift4.length === 0 && fieldMismatch.length === 0 && deepMismatch.length === 0,
        `通道同判据（${tag} 轮）：MCP 预演与页面 preview 在同一库状态下逐字段全等——漏传 createTasks/prdFilename/onDuplicatePlan 或另写一套判重都会在这里亮红`,
        `计数差 ${fieldMismatch.join(',') || '(无)'} 明细差 ${deepMismatch.join(',') || '(无)'} 漂移 ${drift4.join(',') || '(无)'}`);
    }

    // ---------- M-05：R2（同标题改内容）在 reuse 模式下的判别 —— 预演不得退化成「按长度回数」 ----------
    const imP2 = (await importVia(pids[1], FIXTURE_R1_MD)).structured?.imported ?? {};
    const p2ReqBefore = countRows('prd_requirements', pids[1]);
    check('M-05a', imP2.requirementsCreated === 3 && imP2.plans === 3 && p2ReqBefore === 3,
      '乙项目首轮实导（供 R2 判别做基线）：3 需求 / 3 计划落库', `库内需求 ${p2ReqBefore} 行`);
    const b5 = bizSnap();
    const pv5 = (await importVia(pids[1], FIXTURE_R2_MD, { onDuplicatePlan: 'reuse', dryRun: true })).structured?.preview ?? {};
    const drift5 = diffTables(b5, bizSnap());
    check('M-05b', drift5.length === 0
      && pv5.willReuseReqs === 2 && pv5.willCreateReqs === 1 && pv5.willReusePlans === 3 && pv5.willCreatePlans === 0
      && pv5.prdDoc?.action === 'reuse' && pv5.prdDoc?.by === 'name',
      '负对照 A（判据判别力）：R2 同标题改内容那行必须判新建（2 复用 / 1 新建）、三条同名计划全部命中复用、PRD 同名不同内容判 reuse(by name)——预演若只按 payload 长度回数（3 复用/0 新建）即红',
      `req 复用${pv5.willReuseReqs}/新建${pv5.willCreateReqs}，plan 复用${pv5.willReusePlans}/新建${pv5.willCreatePlans}，prdDoc ${pv5.prdDoc?.action}/${pv5.prdDoc?.by}`);
    const im5 = (await importVia(pids[1], FIXTURE_R2_MD, { onDuplicatePlan: 'reuse' })).structured?.imported ?? {};
    const d5 = diffTables(b5, bizSnap());
    importTouched.push(...d5);
    check('M-05c', im5.requirementsCreated === pv5.willCreateReqs && im5.reusedRequirements === pv5.willReuseReqs
      && im5.reusedPlans === pv5.willReusePlans && im5.plans === pv5.willCreatePlans
      && countRows('prd_requirements', pids[1]) === p2ReqBefore + pv5.willCreateReqs,
      'R2 落库对账：实导的新建/复用数与预演逐条相等，需求行数 +1（让号那行）',
      `import ${im5.reusedRequirements}复用/${im5.requirementsCreated}新建，计划 ${im5.reusedPlans}复用/${im5.plans}新建`);

    // ---------- M-06：createTasks 连带影响可见（待办表零漂移 → 实导才涨） ----------
    const b6 = bizSnap();
    const pv6 = (await mcp!.callTool('mtask_import_prd', {
      projectId: pids[2], toolId, filename: FIXTURE_FILE, fileBase64: b64(FIXTURE_R1_MD), createTasks: true, dryRun: true,
    })).structured?.preview ?? {};
    const drift6 = diffTables(b6, bizSnap());
    const im6 = (await mcp!.callTool('mtask_import_prd', {
      projectId: pids[2], toolId, filename: FIXTURE_FILE, fileBase64: b64(FIXTURE_R1_MD), createTasks: true,
    })).structured?.imported ?? {};
    const d6 = diffTables(b6, bizSnap());
    importTouched.push(...d6);
    const taskN6 = countRows('tasks', pids[2]);
    check('M-06', drift6.length === 0 && pv6.createTasks === true && im6.tasks === taskN6 && taskN6 > 0,
      '待办连带（createTasks:true）：预演如实回显 createTasks 且待办表零漂移，实导才生成待办；生成的待办行数 == 导入回传 tasks',
      `预演漂移 ${drift6.length ? drift6.join('、') : '无'}，实导待办 ${taskN6} 行（导入回传 ${im6.tasks}，新建计划预告 ${pv6.willCreatePlans}）`);

    // ---------- M-07：缺省与显式 dryRun:false 都走写通道（改动不回归旧语义） ----------
    const b7 = bizSnap();
    const r7 = (await mcp!.callTool('mtask_import_prd', {
      projectId: pids[3], toolId, filename: FIXTURE_FILE, fileBase64: b64(FIXTURE_R1_MD), createTasks: false, dryRun: false,
    })).structured ?? {};
    const d7 = diffTables(b7, bizSnap());
    importTouched.push(...d7);
    check('M-07', r7.dryRun === undefined && r7.imported?.requirementsCreated === 3 && d7.length > 0 && countRows('prd_requirements', pids[3]) === 3,
      '显式 dryRun:false（与缺省同义）仍走写通道并落库——新分支没有把旧调用方一起改掉',
      `返回键 ${Object.keys(r7).join(',')}，漂移表 ${d7.map((x) => x.split('(')[0]).join('、')}`);

    // ---------- N 组：负对照 ----------
    const touchedSet = [...new Set(importTouched.map((x) => x.split('(')[0]))];
    check('N-01', touchedSet.length > 0 && touchedSet.every((t) => BIZ_TABLES.includes(t)),
      '负对照 B（红线覆盖面）：所有实导摸过的表都在业务表清单里，即「只读红线」的快照确实罩住了导入会写的那些表（否则 M-01b 的零漂移是恒绿摆设）',
      `实导触及 ${touchedSet.join('、')} · 红线覆盖 ${BIZ_TABLES.length} 张表`);

    // ---------- N-02：缺陷变体打在 HEAD 副本——工具「广告了 dryRun 却不认账」，红线必须亮红 ----------
    negRoot = join(tmp, 't02354-negwt');
    const mainShaBefore = shaOf(join(ROOT, 'server', 'src', 'mcp', 'server.ts'));
    try {
      await stopServer();
      execFileSync('git', ['worktree', 'add', '--detach', negRoot, 'HEAD'], { cwd: ROOT, stdio: 'pipe', timeout: 120_000 });
      symlinkSync(join(ROOT, 'node_modules'), join(negRoot, 'node_modules'), 'junction');
      const negFile = join(negRoot, 'server', 'src', 'mcp', 'server.ts');
      const src = readFileSync(negFile, 'utf8');
      // 缺陷变体构造随产品现状走：HEAD 里 dryRun 已有 schema + handler 两条腿，
      // 把 handler 那条短路掉才是「广告了参数却不认账」的缺陷本体（旧写法是给 schema 补一行，
      // 在产品已支持 dryRun 之后打上去等于没打——负对照会因「红线没被触发」而假红）。
      const anchor = '      if (a.dryRun === true) {';
      const hit = src.includes(anchor) && /dryRun: z\.boolean\(\)\.optional\(\)/.test(src);
      writeFileSync(negFile, src.replace(anchor, '      if (a.dryRun === true && false) {'));
      check('N-02a', hit, '副本缺陷变体已就位：HEAD 副本里只短路 dryRun 的 handler 分支（schema 照旧广告、值不认账，直接落库）——主仓未被写入，改动只打在 worktree 副本', hit ? '两条腿锚点命中' : '锚点未命中（变体没打上）');
      const negData = join(tmp, 'neg-data');
      await startServer(negRoot, negData, tmp);
      const nName = `T02354 缺陷变体项目-${Date.now()}`;
      await postJson('projects', { name: nName, description: '负对照用。' });
      const nPid = ((await getJson('projects')) as Array<{ id: string; name: string }>).find((p) => p.name === nName)?.id ?? '';
      const nTool = String((await postJson('aitools', { name: 't02354-mock-neg', type: 'openai-compatible', endpoint: `http://127.0.0.1:${MOCK_PORT}`, apiKey: 'mock-key', model: 'mock-prd-parse', timeoutMs: 20_000 }).then((r) => r.json))?.id ?? '');
      const nMcp = makeMcp();
      await nMcp.init();
      const nSchema = !!(await nMcp.listTools()).find((t: any) => t?.name === 'mtask_import_prd')?.inputSchema?.properties?.dryRun;
      const negDbFile = join(negData, 'mtask.db');
      // 副本由 HEAD 建库，表集合可能比主仓工作树少（本单不赌 schema 差异）：红线取两侧交集
      const negTables = (() => { const d = openDb(negDbFile); try { return tableNames(d); } finally { d.close(); } })()
        .filter((t) => BIZ_TABLES.includes(t));
      check('N-02a2', negTables.length > 0 && negTables.some((t) => ['prd_requirements', 'plan_tasks', 'prd_docs'].includes(t)),
        '副本库表清单与主仓红线口径可对账（交集含导入会写的核心表，负对照才打在真表上）', `交集 ${negTables.length} 张表`);
      const snapNeg = () => { const d = openDb(negDbFile); try { return snapshot(d, negTables); } finally { d.close(); } };
      const nb = snapNeg();
      const nres = await nMcp.callTool('mtask_import_prd', { projectId: nPid, toolId: nTool, filename: FIXTURE_FILE, fileBase64: b64(FIXTURE_R1_MD), createTasks: false, dryRun: true });
      const nDrift = diffTables(nb, snapNeg());
      check('N-02b', nSchema === true, '缺陷变体同样「schema 里有 dryRun」——证明 G-05 那条契约腿抓不住这个缺陷（它只能由行为腿抓）', `副本 tools/list ${nSchema ? '含' : '不含'} dryRun`);
      check('N-02c', nDrift.length > 0 && nres.structured?.readOnly !== true,
        '负对照 C（本单主判据的牙齿）：dryRun 被忽略、直接落库的变体下，「预演前后逐字节不变」必须亮红——M-01b/M-03a/M-05b/M-06 的红线确有判别力',
        `副本漂移表 ${nDrift.map((x) => x.split('(')[0]).join('、') || '(无，红线失效)'}`);
      await stopServer();
    } catch (e) {
      fail('N-02x', `负对照执行异常（崩溃即门失效，不得当成通过）→ ${e instanceof Error ? e.message : String(e)}`);
      try { await stopServer(); } catch { /* 忽略 */ }
    } finally {
      try { rmSync(join(negRoot, 'node_modules'), { recursive: true, force: true }); } catch { /* 链接已不在 */ }
      try { execFileSync('git', ['worktree', 'remove', '--force', negRoot], { cwd: ROOT, stdio: 'pipe', timeout: 120_000 }); } catch { rmSync(negRoot, { recursive: true, force: true }); }
      try { execFileSync('git', ['worktree', 'prune'], { cwd: ROOT, stdio: 'pipe', timeout: 60_000 }); } catch { /* 忽略 */ }
    }
    check('N-03', shaOf(join(ROOT, 'server', 'src', 'mcp', 'server.ts')) === mainShaBefore,
      '负对照还原校验：主仓 server/src/mcp/server.ts 的 sha256 与进入 N 组前逐字一致（破坏只发生在副本里）');
    check('N-04', !existsSync(negRoot), 'HEAD 副本工作树已拆除（不留残骸、不污染 git worktree list）');
    await startServer(ROOT, dataDir, tmp);
    mcp = makeMcp();
    await mcp.init();
    const still = (await mcp.listTools()).find((t: any) => t?.name === 'mtask_import_prd');
    const pvFinal = (await importVia(pids[3], FIXTURE_R1_MD, { dryRun: true })).structured?.preview ?? {};
    check('N-05', !!still?.inputSchema?.properties?.dryRun && pvFinal.readOnly === true,
      '收口复跑：负对照拆除后主仓实例仍可用 dryRun（预演仍只读），证明 N 组没有把改动带歪', `readOnly=${pvFinal.readOnly}`);

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    fail('ABORT', `门自身执行抛异常（崩溃即门失效，不得当成通过）→ ${msg}`);
  } finally {
    await stopServer();
    mock.close();
    if (KEEP) info(`T02354_KEEP=1，临时目录保留：${tmp}`);
    else { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 占用则留给人工 */ } }
  }

  const verdict = `T02354 MCP PRD 导入预演门：PASS=${pass} FAIL=${failCount} → ${failCount === 0 ? 'dryRun 与页面通道同判据、且确实零写库（合格）' : '有断言不成立（不合格）'}`;
  console.log(`\n${verdict}`);
  const file = writeGateResults(OUT_DIR, OUT_BASE, [verdict, ...lines].join('\n'), { port: PORT, dataDir: TMP_ROOT, note: 'MCP mtask_import_prd dryRun 预演（只读）验收门' });
  if (failCount > 0) process.exitCode = 1;
  console.log(`结果文件：${file}`);
}

function shaOf(p: string): string {
  try { return createHash('sha256').update(readFileSync(p)).digest('hex'); } catch { return '(读不出)'; }
}

void main();
