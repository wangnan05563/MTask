#!/usr/bin/env node
/**
 * T02300 验收门：PRD 导入预演端点 `POST /api/plans/import-prd/preview`（只读、判据与 importPrd 同源）。
 *
 * 拦的是什么：
 *  ① 「预演冒充只读」——preview 若偷偷开写事务，用户在点导入前的每一次试探都在改数据；
 *     V-01 用**全业务表逐字节快照**拦它（快照函数自身由 N-02 反证有判别力）。
 *  ② 「两套判重分叉」——preview 若在自身里另写一套判重/让号，报的数与实落库对不上，
 *     正是本单「边界」段落明令禁止的事；V-02/V-03/V-07/V-08 逐条比「预演计数 == 实落库增量」。
 *  ③ 「恒绿摆设」——夹具特意含一行「同标题、不同内容」（N-01）：真判据（标题+内容）判它新建，
 *     退化成「只按标题」的判据判它复用。若哪天判据被换窄，V-08/N-01 的等式立刻不成立。
 *
 * 通道纪律（判据写法服从 T02293）：
 *  - 夹具自造：门自己建项目、自己拼 payload，不读生产库、不依赖任何存量数据；
 *  - 不锁实现字面量：断言全部打在 HTTP 响应与库内容上，不 grep 源码字符串；
 *  - 隔离实例：`MTask_PORT` 默认 39960（`T02300_PORT` 可覆盖，避开 39877 生产实例），
 *    `MTask_DATA_DIR` 每次 `mkdtemp` 新建并落 **D:**（C 盘常年 0 可用会假性 SQLITE_FULL）；
 *  - 负对照：全部由夹具与反证步骤承担，工作区源码一个字节都不动。
 *
 * 用法：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02300-import-preview.mts
 *   环境变量：T02300_PORT、T02300_TMP_ROOT（默认 D:/code/tmp）、T02300_KEEP=1 保留临时目录
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';
import { resolveServerLauncher } from './isolated-server-launcher.mts';

const require = createRequire(join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'package.json'));
const sqlite = require('better-sqlite3') as typeof import('better-sqlite3');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_INDEX = join(ROOT, 'server', 'src', 'index.ts');
const OUT_DIR = join(ROOT, '.workbuddy');
const OUT_BASE = 't02300-import-preview-gate-results.txt';
const PORT = Number(process.env.T02300_PORT ?? 39960);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP_ROOT = process.env.T02300_TMP_ROOT ?? 'D:/code/tmp';
const KEEP = process.env.T02300_KEEP === '1';
const FIXTURE_PROJECT = `T02300 预演门项目-${Date.now()}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lines: string[] = [];
let pass = 0;
let failCount = 0;
const info = (m: string) => { console.log(`  [INFO] ${m}`); lines.push(`[INFO] ${m}`); };
const ok = (id: string, m: string) => { pass += 1; console.log(`  [PASS] ${id} ${m}`); lines.push(`[PASS] ${id} ${m}`); };
const fail = (id: string, m: string) => { failCount += 1; console.log(`  [FAIL] ${id} ${m}`); lines.push(`[FAIL] ${id} ${m}`); };
const check = (id: string, cond: boolean, m: string, detail = '') => {
  if (cond) ok(id, m + (detail ? ` → ${detail}` : ''));
  else fail(id, m + (detail ? ` → ${detail}` : ''));
};

let server: ReturnType<typeof spawn> | null = null;
const LAUNCHER_HOLDER = { v: undefined as ReturnType<typeof resolveServerLauncher> | undefined };

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
  try {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 240);
  } catch { return '(日志读不出)'; }
}

async function startServer(dataDir: string): Promise<void> {
  const launcher = (LAUNCHER_HOLDER.v ??= resolveServerLauncher(ROOT, SERVER_INDEX));
  mkdirSync(dataDir, { recursive: true });
  const logFile = join(dataDir, 'server.log');
  const fd = openSync(logFile, 'a');
  server = spawn(launcher.exec, launcher.tsx, {
    cwd: ROOT,
    env: { ...process.env, ...launcher.env, MTask_PORT: String(PORT), MTask_DATA_DIR: dataDir, MTask_LOG_DIR: dataDir },
    stdio: ['ignore', fd, fd],
  });
  info(`启动器：${launcher.label}`);
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

// ---------- 库快照（只读连接，绝不开写事务） ----------

type Db = ReturnType<typeof sqlite>;
function openDb(dbFile: string): Db {
  return sqlite(dbFile, { readonly: true });
}
function tableNames(db: Db): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>).map((r) => r.name);
}
/** 每表一份规范化转储（按 rowid 全列）+ 行数；返回 表名 → 摘要 */
function snapshot(db: Db, tables: string[]): Map<string, { digest: string; rows: number }> {
  const out = new Map<string, { digest: string; rows: number }>();
  for (const t of tables) {
    const rows = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all() as Array<Record<string, unknown>>;
    const digest = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    out.set(t, { digest, rows: rows.length });
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
  const res = await fetch(`${BASE}/api/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 400) }; }
  return { status: res.status, json };
}

/** 与面板同形的 payload（勾选过滤后的需求/计划 + PRD 原文），字段名与端点契约一致 */
type Req = { reqNo?: string; title: string; content?: string; sourceRef?: string; priority?: string };
type Plan = { title: string; description?: string; durationDays?: number; reqNos?: string[] };
/** 夹具 PRD 原文——**字节固定**是 V-13 的前提：第二轮要靠 content_hash 命中同一份文档，
 *  正文里绝不能混入时间戳之类的每次不同的内容（否则判据只能走文件名，断言就降级了）。 */
const FIXTURE_PRD_MD = '# 门内夹具 PRD\n\n仅供预演/导入对账，正文逐字节固定以便同内容命中判定。\n';
const FIXTURE_PRD_FILE = 't02300-fixture.md';
const payload = (projectId: string, requirements: Req[], plans: Plan[], reuse: boolean) => ({
  projectId, createTasks: false, requirements, plans,
  prdMd: FIXTURE_PRD_MD,
  prdFilename: FIXTURE_PRD_FILE,
  ...(reuse ? { onDuplicatePlan: 'reuse' } : {}),
});

async function main() {
  const tmp = mkdtempSync(join(TMP_ROOT, 't02300-gate-'));
  const dataDir = join(tmp, 'data');
  const dbFile = join(dataDir, 'mtask.db');
  info(`临时根 ${tmp} · 实例 http://127.0.0.1:${PORT}`);
  lines.push(`T02293 判据口径：夹具自造 / 不锁实现字面量 / 不依赖生产数据 / 每条改法配负对照`);

  try {
    // ---------- G 组：通道前提 ----------
    const holders = pidsListening(PORT);
    if (holders.length > 0) {
      fail('G-01', `端口 ${PORT} 已被 ${holders.join(',')} 占用——本门必须自起隔离实例，不能打在别人的服务上`);
      throw new Error('端口不干净');
    }
    ok('G-01', '端口空闲自检：断言只打在本门自起的隔离实例上');

    await startServer(dataDir);
    check('G-02', existsSync(dbFile), '隔离实例已建库（MTask_DATA_DIR 指向 D 盘临时目录）', dbFile);

    const created = await postJson('projects', { name: FIXTURE_PROJECT, description: '门内夹具项目，仅用于 PRD 导入预演对账。' });
    const list = (await (await fetch(`${BASE}/api/projects`)).json()) as Array<{ id: string; name: string }>;
    const project = list.find((p) => p.name === FIXTURE_PROJECT);
    if (!project) { fail('G-03', `夹具项目没建成（POST /api/projects status=${created.status}）`); throw new Error('夹具不可用'); }
    ok('G-03', '夹具项目建成，后续断言全部打在它身上', project.id);

    const probe = await postJson('plans/import-prd/preview', { projectId: project.id, requirements: [{ title: 'X', content: 'y' }], plans: [] });
    const previewShape = ['willCreatePlans', 'willReusePlans', 'willRenamePlans', 'willCreateReqs', 'willReuseReqs', 'reqNoMap', 'dupPlanTitles', 'prdDoc'];
    check('G-04', probe.status === 200 && previewShape.every((k) => k in (probe.json ?? {})),
      '预演端点已注册且回计数契约（404=没注册，缺字段=契约分叉）', `status=${probe.status}`);

    // ---------- 快照基线 + 后台噪声自标定 ----------
    const db = openDb(dbFile);
    const tables = tableNames(db);
    check('G-05', tables.length > 0, `库内业务表清点（${tables.length} 张，快照覆盖面按此动态取，不硬编码表名）`);
    const s0 = snapshot(db, tables);
    await sleep(4_000);
    const s1 = snapshot(db, tables);
    const noise = diffTables(s0, s1);
    if (noise.length) info(`后台噪声表（服务自身定时写入，与导入无关，不计入只读红线）：${noise.join('、')}`);
    const bizTables = tables.filter((t) => !noise.some((n) => n.startsWith(`${t}(`)));
    // 每次快照用完即关：只读连接在 Windows 上会钉住 db 文件，残留句柄会让收尾 rmSync 失败、
    // 且长期持有 WAL 读锁点（见 t02281 门的收口教训）。
    const bizSnapshot = () => {
      const d = openDb(dbFile);
      try { return snapshot(d, bizTables); } finally { d.close(); }
    };

    // ---------- R1 组：撞号让号 + 全新建 + 计划撞名 ----------
    // 先占号：不加这一步，空项目里 REQ-001..003 会原样落库、reqNoMap 恒空，
    // V-04/V-05 就退化成「两个空数组相等」的恒绿断言。
    const seed = (await postJson('plans/import-prd', {
      projectId: project.id, createTasks: false,
      requirements: [{ reqNo: 'REQ-001', title: 'S0 占号行', content: '先把 REQ-001 占住，逼后续批次让号' }],
      plans: [],
    })).json;
    check('V-00', seed.requirementsCreated === 1 && (seed.reqNoMap ?? []).length === 0,
      '占号预置生效：REQ-001 已被占用且本轮无需让号（预置自身的编号是干净的）',
      `新建 ${seed.requirementsCreated} 行 / reqNoMap ${(seed.reqNoMap ?? []).length} 条`);

    const r1Titles = ['预演端点落码', '面板预演按钮', '判据抽公共函数'];
    const reqRows = () => db.prepare(
      `SELECT req_no, title, content, status, sort_order FROM prd_requirements WHERE project_id = ? AND title IN (${r1Titles.map(() => '?').join(',')}) ORDER BY sort_order`,
    ).all(project.id, ...r1Titles) as Array<{ req_no: string; title: string; content: string; status: string; sort_order: number }>;
    const r1Reqs: Req[] = [
      { reqNo: 'REQ-001', title: '预演端点落码', content: '只读端点 + 路由', priority: 'normal' },
      { reqNo: 'REQ-002', title: '面板预演按钮', content: '导入前展示计数' },
      { reqNo: 'REQ-003', title: '判据抽公共函数', content: 'resolveImportReqPlan' },
    ];
    const r1Plans: Plan[] = [
      { title: '一期：预演通道', durationDays: 3, reqNos: ['REQ-001'] },
      { title: '一期：预演通道', durationDays: 2, reqNos: ['REQ-002'] }, // 撞名 → 新行带「（2）」
      { title: '二期：对账门', durationDays: 4, reqNos: ['REQ-003', 'REQ-404'] }, // REQ-404 不存在 → unlinked
    ];
    const before1 = bizSnapshot();
    const pv1 = (await postJson('plans/import-prd/preview', payload(project.id, r1Reqs, r1Plans, false))).json;
    const afterPv1 = bizSnapshot();
    const pvDrift = diffTables(before1, afterPv1);
    check('V-01', pvDrift.length === 0, '只读红线：preview 前后全部业务表逐字节不变', pvDrift.length ? `变化表 ${pvDrift.join('、')}` : `${bizTables.length} 张表零漂移`);

    const im1 = (await postJson('plans/import-prd', payload(project.id, r1Reqs, r1Plans, false))).json;
    info(`首轮导入后发生变化的表：${diffTables(before1, bizSnapshot()).join('、') || '(无——导入没落库，后面的同形断言将失去意义)'}`);
    check('V-02', pv1.willCreateReqs === im1.requirementsCreated && im1.requirementsCreated === 3 && pv1.willReuseReqs === (im1.reusedRequirements ?? 0) && im1.reusedRequirements === 0,
      '首轮计数同形：preview.willCreateReqs == import.requirementsCreated（3 条全新建、零复用）',
      `preview ${pv1.willCreateReqs}/${pv1.willReuseReqs} vs import ${im1.requirementsCreated}/${im1.reusedRequirements}`);
    check('V-03', pv1.willCreatePlans === im1.plans && im1.plans === 3 && pv1.willReusePlans === (im1.reusedPlans ?? 0) && im1.reusedPlans === 0,
      '首轮计划行同形：willCreatePlans == import.plans == 3，willReusePlans == reusedPlans == 0',
      `preview ${pv1.willCreatePlans}/${pv1.willReusePlans} vs import ${im1.plans}/${im1.reusedPlans}`);

    const reqRows1 = reqRows();
    const mapFromPv = (pv1.reqNoMap ?? []) as Array<{ from: string; to: string }>;
    const mapFromIm = (im1.reqNoMap ?? []) as Array<{ from: string; to: string }>;
    check('V-04', mapFromPv.length === 3 && mapFromPv.every((x) => x.from !== x.to)
      && JSON.stringify(mapFromPv) === JSON.stringify(mapFromIm),
      '让号明细两侧完全一致且非空：三条请求编号全部被让号，preview.reqNoMap == import.reqNoMap',
      `preview ${mapFromPv.length} 条 / import ${mapFromIm.length} 条`);
    const landedNos = reqRows1.map((r) => r.req_no).join(',');
    check('V-05', reqRows1.length === 3 && mapFromPv.every((x) => landedNos.split(',').includes(x.to)),
      'reqNoMap 的落库编号逐条在库里查得到（预演的号真的是要落进去的号）', `库里 ${landedNos}`);

    const planTitles = (db.prepare('SELECT title, req_ids FROM plan_tasks WHERE project_id = ? ORDER BY created_at').all(project.id) as Array<{ title: string; req_ids: string | null }>).map((x) => x.title);
    const renamedPv = (pv1.dupPlanTitles ?? []).filter((x: { renamedTo?: string }) => x.renamedTo).map((x: { renamedTo: string }) => x.renamedTo);
    check('V-06', pv1.willRenamePlans === 1 && renamedPv.length === 1 && planTitles.includes(renamedPv[0]),
      '撞名让号预告 == 实际落库标题（第二行确实带「（N）」后缀，不是同名双行）',
      `预告 ${JSON.stringify(renamedPv)} / 库里 ${JSON.stringify(planTitles)}`);
    const sorted = (a: unknown) => [...(a ?? [])].sort().join(',');
    check('V-07', sorted(pv1.unlinkedReqNos) === sorted(im1.unlinkedReqNos) && (pv1.unlinkedReqNos ?? []).includes('REQ-404'),
      '不存在编号在预演里就被点名，且与导入回传一致（V-07 也是「预演能提前拦误判」的正面证据）',
      `preview ${JSON.stringify(pv1.unlinkedReqNos)} / import ${JSON.stringify(im1.unlinkedReqNos)}`);
    const docsAfter1 = (db.prepare('SELECT count(*) AS c FROM prd_docs WHERE project_id = ?').get(project.id) as { c: number }).c;
    check('V-08', pv1.prdDoc?.action === 'create' && docsAfter1 === 1, '首轮 PRD 原文：预演判 create，落库确实 +1 份文档', `docs=${docsAfter1}`);

    // ---------- R2 组：reuse 轮（同一份 payload）——需求侧连带幂等（T02303 甲）+ 同形断言 ----------
    const before2 = bizSnapshot();
    const pv2 = (await postJson('plans/import-prd/preview', payload(project.id, r1Reqs, r1Plans, true))).json;
    const afterPv2 = bizSnapshot();
    check('V-09', diffTables(before2, afterPv2).length === 0, 'reuse 轮预演同样零写库', `${bizTables.length} 张表逐字节不变`);
    const im2 = (await postJson('plans/import-prd', payload(project.id, r1Reqs, r1Plans, true))).json;
    info(`reuse 轮导入后发生变化的表：${diffTables(before2, bizSnapshot()).join('、') || '(无)'}`);
    check('V-10', pv2.willReuseReqs === im2.reusedRequirements && pv2.willCreateReqs === im2.requirementsCreated
      && pv2.willReuseReqs === 3 && pv2.willCreateReqs === 0 && im2.requirementsCreated === 0,
      '同形断言（本单最硬的一条）：reuse 轮 preview.willReuseReqs == import.reusedRequirements 且 willCreateReqs == requirementsCreated == 0',
      `preview ${pv2.willReuseReqs}复用/${pv2.willCreateReqs}新建 vs import ${im2.reusedRequirements}/${im2.requirementsCreated}`);
    check('V-11', pv2.willReusePlans === 3 && pv2.willCreatePlans === 0 && im2.reusedPlans === 3 && im2.plans === 0,
      'reuse 轮计划侧同形：三条计划全部命中存量同名行补写，新建 0 行', `preview ${pv2.willReusePlans}/${pv2.willCreatePlans} vs import ${im2.reusedPlans}/${im2.plans}`);
    const reqRows2 = reqRows();
    check('V-12', JSON.stringify(reqRows1) === JSON.stringify(reqRows2),
      '存量需求行一字未动（编号/标题/内容/status/排序全等）——reuse 补写只碰计划侧，矩阵行受保护',
      `${reqRows2.length} 行逐列相等`);
    const docsAfter2 = (db.prepare('SELECT count(*) AS c FROM prd_docs WHERE project_id = ?').get(project.id) as { c: number }).c;
    check('V-13', pv2.prdDoc?.action === 'reuse' && pv2.prdDoc?.by === 'hash' && docsAfter2 === 1,
      '同内容 PRD 第二轮：预演判 reuse(by hash) 且文档数不增（判据与 persist 同源）', `docs=${docsAfter2}`);

    // ---------- N 组：负对照（夹具判别力 + 快照函数判别力） ----------
    const nReqs: Req[] = [
      { reqNo: 'REQ-001', title: '预演端点落码', content: '只读端点 + 路由' },           // 同标题同内容 → 复用
      { reqNo: 'REQ-002', title: '面板预演按钮', content: '内容改了一版，判据不再是标题' }, // 同标题**不同内容** → 必须新建
      { reqNo: 'REQ-900', title: '全新的一行', content: '库里没有' },                     // 新行
    ];
    const pvN = (await postJson('plans/import-prd/preview', payload(project.id, nReqs, [], true))).json;
    // 真判据（标题+内容）预期：复用 1 条、新建 2 条。若判据退化成「只看标题」，第二行会被算成复用（2/1）。
    const titleOnlyPrediction = { reuse: 2, create: 1 };
    check('N-01', pvN.willReuseReqs === 1 && pvN.willCreateReqs === 2,
      '负对照 A：判据是「标题+内容」而非「只看标题」——同标题改内容那行必须判新建',
      `实测 复用${pvN.willReuseReqs}/新建${pvN.willCreateReqs}，若退化为标题判重将是 复用${titleOnlyPrediction.reuse}/新建${titleOnlyPrediction.create}`);
    const imN = (await postJson('plans/import-prd', payload(project.id, nReqs, [], true))).json;
    check('N-02', pvN.willCreateReqs === imN.requirementsCreated && pvN.willReuseReqs === imN.reusedRequirements,
      '负对照 A 的落库侧对账：预演的 1/2 与实际落库的 1/2 相等（判据分叉会在这里亮红）',
      `import ${imN.reusedRequirements}/${imN.requirementsCreated}`);

    // 快照函数自身必须有判别力：V-01/V-09 的「不变」不能是恒绿
    const preWrite = bizSnapshot();
    await postJson('plans/import-prd', payload(project.id, [{ reqNo: 'REQ-777', title: '反证写入的一行', content: '只为了让快照变' }], [], false));
    const postWrite = bizSnapshot();
    const drift = diffTables(preWrite, postWrite);
    check('N-03', drift.length > 0 && drift.some((d) => d.startsWith('prd_requirements(')),
      '负对照 B：真写一次库，快照必须报变化——证明 V-01/V-09 的「逐字节不变」是可判真的断言，不是恒绿',
      `变化表 ${drift.join('、') || '(无，快照失效)'}`);
    const orphan = (pv2.orphanRequirements ?? []) as Array<{ reqNo: string }>;
    const orphanPv = (await postJson('plans/import-prd/preview', {
      projectId: project.id, requirements: [{ reqNo: 'REQ-500', title: '没有任何计划引用它', content: 'z' }], plans: [{ title: '只挂 REQ-501 的计划', reqNos: ['REQ-501'] }],
    })).json;
    check('V-14', (orphanPv.unlinkedReqNos ?? []).includes('REQ-501') && (orphanPv.orphanRequirements ?? []).length === 1,
      '预演同时点名「引用了不存在的编号」与「新建却零关联的行」（T01995 两类可见性在预演里等价在场）',
      `unlinked=${JSON.stringify(orphanPv.unlinkedReqNos)} orphan=${(orphanPv.orphanRequirements ?? []).length} 条；reuse 轮 orphan=${orphan.length}`);

    db.close();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    fail('ABORT', `门自身执行抛异常（崩溃即门失效，不得当成通过）→ ${msg}`);
  } finally {
    await stopServer();
    if (KEEP) info(`T02300_KEEP=1，临时目录保留：${tmp}`);
    else { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 占用则留给人工 */ } }
  }

  const verdict = `T02300 PRD 导入预演门：PASS=${pass} FAIL=${failCount} → ${failCount === 0 ? '预演与导入判据同源、且预演确实零写库（合格）' : '有断言不成立（不合格）'}`;
  console.log(`\n${verdict}`);
  const file = writeGateResults(OUT_DIR, OUT_BASE, [verdict, ...lines].join('\n'), { port: PORT, dataDir: TMP_ROOT, note: 'PRD 导入预演（只读端点）验收门' });
  if (failCount > 0) process.exitCode = 1;
  console.log(`结果文件：${file}`);
}

void main();
