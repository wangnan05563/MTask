#!/usr/bin/env node
/**
 * T02630（面板与交付件同名 `ratioCheck.excluded.unEstimated` 口径分叉）验收门。
 *
 * 判据对象是**口径本身**：同一个 `excluded` 对象在两条取数路径上必须逐键同值。
 *   面板：`GET /api/estimates` → `estimatesSnapshot()` → 全明细行喂 `buildSummary`；
 *   交付件：`buildEstimateArtifact()` → `layoutEstimate()` → dev 明细 + 非 dev 阶段聚合行喂 `buildSummary`。
 * 业主裁定（2026-10-19，T02630 选项乙′）：`unEstimated` 只数**明细行**，阶段缺口另设
 * `unEstimatedPhases`（六个标准阶段里没有任何有值行进 Σ 的**阶段个数**）；交付件 §4.4 备注分列两句。
 *
 * 分五组：
 *   E 前置：隔离实例真起来（不连生产 39877）、夹具期望值独立推导；
 *   A 引擎层（进程内纯函数）：分桶规则 + 粒度无关性 + Σ 中性（`count` 行不得重复进 Σ）；
 *   R 数据层：隔离实例真 HTTP 造夹具并读面板 `excluded`；服务进程收口后单句柄直调
 *     `buildEstimateArtifact()`，断言交付件 `excluded` 与面板逐键相等、PDF 备注四计数与两者同值；
 *     `scope=estimated_only` 属**取数过滤**，单独交代，不假装相等；
 *   S 锚点层：中文文案/键名锚点走 `okPair`（T02293），取证面默认 `git show HEAD:`，
 *     入库前首跑可用 `T02630_ANCHOR_REF=WORKTREE` 读磁盘副本；
 *   N 负对照（无条件执行）：聚合行退回修复前 tagging / 摘掉 `count` 行 / 只改 tagging 不摘 `count` ——
 *     三条变异各自让对应判据当场转红，证明门钉的是规则不是数字。
 *
 * 用法（本门不需要浏览器）：
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-t02630-excluded-parity.mjs
 *   环境变量：T02630_PORT（默认 39971）、T02630_ANCHOR_REF（默认 HEAD）、T02630_KEEP=1 保留临时目录
 *
 * 隔离纪律：`MTask_DATA_DIR` 指临时目录（临时根优先 D:/code/tmp，反模式 1），端口自配，
 * 生产实例与生产库全程不碰。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP_ROOT = existsSync('D:/code/tmp') ? 'D:/code/tmp' : tmpdir();
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't02630-parity-'));
const PORT = Number(process.env.T02630_PORT ?? 39971);
const ANCHOR_REF = process.env.T02630_ANCHOR_REF ?? 'HEAD';
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { gateShotsDir, writeGateResults } = await import(pathToFileURL(join(ROOT, 'scripts/lib/gate-results.mts')).href);
const { okPair } = await import(pathToFileURL(join(ROOT, 'scripts/lib/anchor-pair.mts')).href);
gateShotsDir('t02630');
const OUT_DIR = join(ROOT, '.workbuddy');
const OUT_BASE = 't02630-excluded-parity-gate-results.txt';

let pass = 0; let fail = 0; let skip = 0;
const lines = [];
const probes = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; lines.push(`[PASS] ${name}`); console.log(`  [PASS] ${name}`); } else {
    fail += 1;
    const tail = extra !== undefined ? ` -> ${JSON.stringify(extra).toString().slice(0, 500)}` : '';
    lines.push(`[FAIL] ${name}${tail}`);
    console.log(`  [FAIL] ${name}${tail}`);
  }
};
const skipped = (name, why) => {
  skip += 1;
  lines.push(`[SKIP] ${name}（${why}）——不计 PASS`);
  console.log(`  [SKIP] ${name}（${why}）`);
};
const group = (t) => { lines.push(`\n## ${t}`); console.log(`\n=== ${t} ===`); };
const note = (t) => { lines.push(`  [INFO] ${t}`); console.log(`  [INFO] ${t}`); };
/** okPair 自身的契约探针按设计必红，走 PROBE 通道留痕、不进判定计数（反模式 37） */
const probe = (label, behavior, literal) => {
  const b = (() => { try { return behavior() === true; } catch { return false; } })();
  const l = (() => { try { return literal() === true; } catch { return false; } })();
  probes.push(`[PROBE] ${label} 行为=${b} 字面=${l}`);
};

// ---------------- 夹具（同一份项目事实，两种喂法） ----------------
// 事实：req 1 有值 + 1 条没估；design 1 有值；dev 3 有值 + 1 条没估；onsite 1 条没估；
//       impl / common 整段没有任何计划；里程碑 2 条（一有一无）。
const FACTS = [
  { key: 'pa-req1', phase: 'req', points: { optimistic: 4, likely: 6, pessimistic: 8 } },
  { key: 'pa-req2', phase: 'req', points: null },
  { key: 'pa-des1', phase: 'design', points: { optimistic: 2, likely: 3, pessimistic: 4 } },
  { key: 'pa-dev1', phase: 'dev', points: { optimistic: 5, likely: 7, pessimistic: 9 } },
  { key: 'pa-dev2', phase: 'dev', points: { optimistic: 3, likely: 4, pessimistic: 6 } },
  { key: 'pa-dev3', phase: 'dev', points: { optimistic: 8, likely: 10, pessimistic: 15 } },
  { key: 'pa-dev4', phase: 'dev', points: null },
  { key: 'pa-ons1', phase: 'onsite', points: null },
  { key: 'ms1', phase: 'req', points: { optimistic: 1, likely: 2, pessimistic: 3 }, planKind: 'milestone' },
  { key: 'ms2', phase: 'design', points: null, planKind: 'milestone' },
];
const isDetail = (f) => f.planKind !== 'milestone';
const PHASES = (await import(pathToFileURL(join(ROOT, 'server/src/services/EstimateService.ts')).href)).ESTIMATE_PHASES;
const WANT = {
  // 全部独立由 FACTS 推导，不由 buildSummary 反算（避免同义反复）
  counted: FACTS.filter((f) => isDetail(f) && f.points).length,                                   // 5
  unEstimated: FACTS.filter((f) => isDetail(f) && !f.points).length,                             // 3
  milestone: FACTS.filter((f) => !isDetail(f)).length,                                           // 2
  // 六个标准阶段里「没有任何有值明细进 Σ」的：onsite / impl / common
  unEstimatedPhases: PHASES.filter((p) => !FACTS.some((f) => f.phase === p && isDetail(f) && f.points)).length,
  // 修复前交付件侧的读数 = 空阶段聚合行数（req/design/impl/common/onsite 五格聚合成 1 行，
  // 没值的那几格从前冒充明细）+ dev 段无值明细
  preFixUnEstimated: PHASES.filter((p) => p !== 'dev'
    && !FACTS.some((f) => f.phase === p && isDetail(f) && f.points)).length
    + FACTS.filter((f) => f.phase === 'dev' && isDetail(f) && !f.points).length,                 // 4
};
const sum = (rows) => rows.reduce((a, r) => a + (r.points ? (r.points.optimistic + 4 * r.points.likely + r.points.pessimistic) / 6 : 0), 0);
const WANT_MAN_DAYS = sum(FACTS.filter(isDetail));

/** 面板喂法：全明细行（`routes/estimates.ts` 的 `engineRows()` 形态） */
const panelRows = () => FACTS.map((f) => ({
  key: f.key, phase: f.phase, points: f.points, role: 'detail', planKind: f.planKind ?? 'normal',
}));
/** 交付件喂法（修复后）：非 dev 聚合行 `phase` + dev 明细 `detail` + 非 dev 明细 `count` + 小计行 */
const artifactRows = (over = {}) => {
  const nonDev = FACTS.filter((f) => f.phase !== 'dev' && isDetail(f));
  const aggPoints = (p) => {
    const list = nonDev.filter((f) => f.phase === p && f.points);
    if (list.length === 0) return null;
    return {
      optimistic: list.reduce((a, f) => a + f.points.optimistic, 0),
      likely: list.reduce((a, f) => a + f.points.likely, 0),
      pessimistic: list.reduce((a, f) => a + f.points.pessimistic, 0),
    };
  };
  const rows = [];
  for (const p of PHASES.filter((x) => x !== 'dev')) {
    rows.push({ key: `phase:${p}`, phase: p, points: aggPoints(p), role: over.aggRole ?? 'phase' });
  }
  for (const f of FACTS.filter((x) => x.phase === 'dev' && isDetail(x))) {
    rows.push({ key: f.key, phase: 'dev', points: f.points, role: 'detail' });
  }
  if (!over.dropCount) {
    for (const f of nonDev) {
      rows.push({ key: f.key, phase: f.phase, points: f.points, role: 'count' });
    }
  }
  rows.push({ key: 'subtotal:dev', phase: 'dev', points: null, role: 'subtotal' });
  for (const f of FACTS.filter((x) => !isDetail(x))) {
    rows.push({ key: f.key, phase: f.phase, points: f.points, role: 'detail', planKind: 'milestone' });
  }
  return rows;
};

const E = await import(pathToFileURL(join(ROOT, 'server/src/services/estimate-engine.ts')).href);
const CFG = E.DEFAULT_ESTIMATE_CONFIG;
const bs = (rows) => E.buildSummary(rows, CFG);
const ex = (rows) => bs(rows).ratioCheck.excluded;

group('E 前置');
ok('E-01 隔离数据目录已建且不在 C:（C: 常年 0 可用，落 C: 会报假性 SQLITE_FULL）', existsSync(DATA_DIR) && !/^C:/i.test(DATA_DIR), DATA_DIR);
ok('E-02 夹具期望值自洽：未估明细 3 / 里程碑 2 / 空阶段 3 / 进 Σ 5 行，且三桶与进 Σ 行构成完整划分（=10 条计划）',
  WANT.unEstimated === 3 && WANT.milestone === 2 && WANT.unEstimatedPhases === 3
  && WANT.counted + WANT.unEstimated + WANT.milestone === FACTS.length && WANT_MAN_DAYS > 0,
  { WANT, FACTS: FACTS.length, WANT_MAN_DAYS });
ok('E-03 修复前基线独立推导：交付件侧从前会把 4 行读成「未估算明细」（本单现场 0 vs 4 型分叉的夹具版）',
  WANT.preFixUnEstimated === 4 && WANT.preFixUnEstimated !== WANT.unEstimated, WANT.preFixUnEstimated);

group('A 引擎层（分桶规则 · 粒度无关 · Σ 中性）');
{
  const p = ex(panelRows());
  const a = ex(artifactRows());
  ok('A-01 面板喂法：unEstimated 只数无三点明细行（=独立推导 3），里程碑不混进来',
    p.unEstimated === WANT.unEstimated && p.milestone === WANT.milestone, p);
  ok('A-02 面板喂法：unEstimatedPhases = 无任何有值行进 Σ 的阶段个数（=独立推导 3）',
    p.unEstimatedPhases === WANT.unEstimatedPhases, p);
  ok('A-03 交付件喂法：空阶段聚合行（role=phase、points=null）不进明细桶，只由阶段桶承载',
    a.unEstimated === WANT.unEstimated && a.unEstimatedPhases === WANT.unEstimatedPhases, a);
  ok('A-04 核心不变量：同一份项目事实，两种喂法的四个计数键逐键相等（subtotal 属结构性差异，另条交代）',
    a.unEstimated === p.unEstimated && a.milestone === p.milestone
    && a.unEstimatedPhases === p.unEstimatedPhases && a.subtotal === p.subtotal + 1,
    { 面板: p, 交付件: a });
  ok('A-05 subtotal 差异如实钉住：交付件多 1 条小计行、面板没有（1 行差 = 结构性差异，不是口径漂移）',
    a.subtotal === p.subtotal + 1 && p.subtotal === 0, { 面板: p.subtotal, 交付件: a.subtotal });
  ok('A-06 Σ 中性：count 行（有值的非 dev 明细）不得重复进 Σ——两条路径的直接投入人天同值且等于手算值',
    Math.abs(bs(panelRows()).directManDays.expected - bs(artifactRows()).directManDays.expected) < 1e-9
    && Math.abs(bs(artifactRows()).directManDays.expected - WANT_MAN_DAYS) < 1e-9,
    { 面板: bs(panelRows()).directManDays.expected, 交付件: bs(artifactRows()).directManDays.expected, 手算: WANT_MAN_DAYS });
  ok('A-07 阶段桶的分母是六个标准阶段（全空项目报 6，不报「5 条待录入」）',
    ex([{ key: 'x', phase: 'dev', points: null, role: 'detail' }]).unEstimatedPhases === PHASES.length
    && ex([]).unEstimatedPhases === PHASES.length,
    { 阶段全集: PHASES.length, 单条无值明细: ex([{ key: 'x', phase: 'dev', points: null, role: 'detail' }]), 空集: ex([]) });
  ok('A-08 划分不重叠：面板喂法的 countedKeys 数 + unEstimated + milestone = 行数（同一行不会被两个桶各记一次）',
    bs(panelRows()).countedKeys.length === WANT.counted
    && bs(panelRows()).countedKeys.length + p.unEstimated + p.milestone === FACTS.length,
    { counted: bs(panelRows()).countedKeys.length, ...p, rows: FACTS.length });
}

group('R 数据层（隔离实例真 HTTP 造夹具 + 真导出件构造）');
process.env.MTask_DATA_DIR = DATA_DIR;
const { resolveServerLauncher } = await import(pathToFileURL(join(ROOT, 'scripts/isolated-server-launcher.mts')).href);
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const server = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT, env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout?.on('data', (b) => serverLog.push(b.toString()));
server.stderr?.on('data', (b) => serverLog.push(b.toString()));
const killTree = (pid) => { try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } };
const cleanup = () => {
  if (process.env.T02630_KEEP) return;
  for (let i = 0; i < 8; i++) { try { rmSync(DATA_DIR, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300 * (i + 1)); } }
};
process.on('exit', cleanup);

const api = async (method, path, json) => {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json),
  });
  let out = null;
  try { out = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, json: out };
};

let panel = null;         // 面板 excluded（真 HTTP）
let artEx = null;         // 交付件 excluded（真导出件构造）
let noteMatch = null;     // PDF §4.4 备注四计数
let R_SEED = false;
let ART_PID = '';
try {
  let health = null;
  for (let i = 0; i < 60; i++) {
    try { const j = await (await fetch(`${BASE}/api/health`)).json(); if (j.service === 'mtask-server') { health = j; break; } } catch { /* 等启动 */ }
    await sleep(1000);
  }
  ok('R-01 隔离实例就绪（/api/health 的 service=mtask-server；全程不连生产 39877）', !!health, health ?? String(serverLog.join('')).slice(-400));
  if (health) {
    const proj = (await api('POST', '/api/projects', { name: 'T02630-口径分叉夹具' })).json;
    const PID = String(proj?.id ?? '');
    // 标题都带阶段关键词，避免 `inferPhase` 兜底把没估算的计划全塞进 dev
    const TITLE = { req: '需求：', design: '系统设计：', dev: '开发：', impl: '实施：', common: '测试：', onsite: '现场：' };
    const batch = await api('POST', '/api/plans/batch', {
      projectId: PID,
      items: FACTS.map((f) => ({ title: `${TITLE[f.phase]}${f.key}`, kind: f.planKind ?? 'normal', complexity: 2 })),
    });
    const planIds = batch.json?.ids ?? [];
    ok('R-02 夹具经 API 落库：10 条计划（含 2 条里程碑）按序拿到 planId', planIds.length === FACTS.length && !!PID, { PID, got: planIds.length });
    if (planIds.length === FACTS.length) {
      const patch = [];
      for (let i = 0; i < FACTS.length; i++) {
        const f = FACTS[i];
        if (!f.points) continue;
        const r = await api('PATCH', `/api/estimates/${encodeURIComponent(planIds[i])}?projectId=${encodeURIComponent(PID)}`,
          { phase: f.phase, unit: 'man_day', optimistic: f.points.optimistic, likely: f.points.likely, pessimistic: f.points.pessimistic });
        patch.push({ key: f.key, status: r.status, err: r.json?.message ?? r.json?.error ?? null });
      }
      ok('R-03 有值行三点写入全部 200（无值行留空=真实「待录入」，不靠脚本兜底填数）',
        patch.length === WANT.counted + 1 && patch.every((x) => x.status === 200), patch);
      const view = await api('GET', `/api/estimates?projectId=${encodeURIComponent(PID)}`);
      panel = view.json?.summary?.ratioCheck?.excluded ?? null;
      ok('R-04 真 HTTP 面板读数：excluded 带第四键 unEstimatedPhases 且与夹具独立推导同值（路由没把新键过滤掉）',
        !!panel && typeof panel.unEstimatedPhases === 'number' && panel.unEstimated === WANT.unEstimated
        && panel.unEstimatedPhases === WANT.unEstimatedPhases && panel.milestone === WANT.milestone, panel);
      R_SEED = !!panel;
      ART_PID = PID;
    }
  }
} catch (e) {
  ok('R-00 数据层夹具构造整体执行', false, String(e && e.message || e));
}

// 服务进程收口后再单句柄直调路由层——`buildEstimateArtifact` 会写快照行，与运行中的服务同库并发写会撞锁
killTree(server.pid);
for (let i = 0; i < 10 && R_SEED; i++) {
  try { await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(500) }); await sleep(500); } catch { break; }
}
if (!R_SEED) {
  skipped('R-05…R-09 交付件构造对比', '夹具未落库/实例未就绪，不拿空读数凑绿');
} else {
  try {
    const R = await import(pathToFileURL(join(ROOT, 'server/src/routes/estimates.ts')).href);
    const PDFSVC = await import(pathToFileURL(join(ROOT, 'server/src/services/estimateExportPdf.ts')).href);
    const art = await R.buildEstimateArtifact(ART_PID, 'pdf', { scope: 'all', audience: 'internal', phases: PHASES });
    artEx = art.layout.summary.ratioCheck.excluded;
    const md = PDFSVC.buildEstimateReportMd(art.layout);
    noteMatch = /未计入合计的行：小计 (\d+) 行、里程碑 (\d+) 行、未估算明细 (\d+) 行、未估阶段 (\d+) 个/.exec(md);
    ok('R-05 真交付件构造读数：layout.summary.excluded 与面板逐键相等（本单缺陷的正面对偶：修复前 unEstimated 0 vs 4 型分叉）',
      artEx.unEstimated === panel.unEstimated && artEx.milestone === panel.milestone
      && artEx.unEstimatedPhases === panel.unEstimatedPhases, { 面板: panel, 交付件: artEx });
    ok('R-06 交付件比面板多 1 条小计行（结构性差异，同 A-05 在真链路上复核一次）',
      artEx.subtotal === panel.subtotal + 1, { 面板: panel.subtotal, 交付件: artEx.subtotal });
    ok('R-07 §4.4 备注四计数与交付件引擎逐项同值（备注取数单源，不是第二份口径）',
      !!noteMatch && Number(noteMatch[1]) === artEx.subtotal && Number(noteMatch[2]) === artEx.milestone
      && Number(noteMatch[3]) === artEx.unEstimated && Number(noteMatch[4]) === artEx.unEstimatedPhases,
      { 备注: noteMatch && noteMatch[0], 交付件: artEx });
    ok('R-08 备注四计数同时等于面板读数（客户对照 PDF 与面板不会读到两个数）',
      !!noteMatch && Number(noteMatch[3]) === panel.unEstimated && Number(noteMatch[4]) === panel.unEstimatedPhases,
      { 备注: noteMatch && noteMatch[0], 面板: panel });
    ok('R-09 报价数不受本次口径改动影响：真导出件的实际预估人月 = 手算（Σ明细三点期望 ÷ 每人月工天标准 ×(1+Σ系数)）',
      Math.abs(art.layout.summary.actualManMonths.expected
        - (WANT_MAN_DAYS / CFG.manDaysPerManMonth) * (1 + E.ESTIMATE_COEF_KEYS.reduce((a, k) => a + CFG.coefs[k], 0))) < 1e-6,
      { got: art.layout.summary.actualManMonths.expected, 手算: (WANT_MAN_DAYS / CFG.manDaysPerManMonth) * (1 + E.ESTIMATE_COEF_KEYS.reduce((a, k) => a + CFG.coefs[k], 0)) });
    const artOnly = await R.buildEstimateArtifact(ART_PID, 'pdf', { scope: 'estimated_only', audience: 'internal', phases: PHASES });
    const onlyEx = artOnly.layout.summary.ratioCheck.excluded;
    ok('R-10 scope=estimated_only 是**取数过滤**不是口径漂移：无三点明细不进件 → 明细桶归零，阶段桶仍如实',
      onlyEx.unEstimated === 0 && onlyEx.unEstimatedPhases === WANT.unEstimatedPhases,
      { estimated_only: onlyEx, all: artEx });
  } catch (e) {
    ok('R-11 交付件构造段整体执行', false, String(e && e.message || e));
  }
}

group('S 锚点层（字面腿走 okPair，取证面 ' + ANCHOR_REF + '）');
const srcOf = (rel) => (ANCHOR_REF === 'WORKTREE'
  ? readFileSync(join(ROOT, rel), 'utf8')
  : execFileSync('git', ['show', `${ANCHOR_REF}:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
{
  const eng = srcOf('server/src/services/estimate-engine.ts');
  const xlsx = srcOf('server/src/services/estimateExportXlsx.ts');
  const pdf = srcOf('server/src/services/estimateExportPdf.ts');
  const panelSrc = srcOf('web/src/components/EstimatePanel.tsx');
  const apiSrc = srcOf('web/src/api/estimates.ts');
  const engRows = ex(artifactRows());
  okPair(ok, 'S-01 引擎声明并落地 unEstimatedPhases（行为腿：A-04 两侧同值）',
    () => engRows.unEstimatedPhases === WANT.unEstimatedPhases && engRows.unEstimated === WANT.unEstimated,
    () => eng.includes('unEstimatedPhases: number') && eng.includes("if (r.role !== 'phase') excluded.unEstimated += 1;"),
    () => ({ 引擎计数: engRows }));
  okPair(ok, 'S-02 交付件把非 dev 聚合行标 role:phase、把非 dev 明细标 role:count（行为腿：Σ 中性 A-06）',
    () => Math.abs(bs(panelRows()).directManDays.expected - bs(artifactRows()).directManDays.expected) < 1e-9,
    () => xlsx.includes("role: 'phase'") && xlsx.includes("role: 'count'"),
    () => ({ "xlsx 打标行": xlsx.split('\n').filter((l) => /role: '(phase|count)'/.test(l)).map((l) => l.trim()) }));
  okPair(ok, 'S-03 PDF 备注文案分列「未估算明细 N 行、未估阶段 M 个」（行为腿：R-07 备注与引擎同值）',
    () => !!noteMatch,
    () => pdf.includes('未估算明细 ${rc.excluded.unEstimated} 行、未估阶段 ${rc.excluded.unEstimatedPhases} 个'),
    () => ({ 取证源码行: pdf.split('\n').find((l) => l.includes('未计入合计的行')) ?? '', 备注实测: noteMatch && noteMatch[0] }));
  okPair(ok, 'S-04 面板显示分列文案、API 类型带第四键，且读的就是 API 里那个键（行为腿：R-04 的 API 读数）',
    () => !!panel && typeof panel.unEstimatedPhases === 'number' && panel.unEstimatedPhases === WANT.unEstimatedPhases,
    () => panelSrc.includes('未估阶段 {rc.excluded.unEstimatedPhases} 个') && apiSrc.includes('unEstimatedPhases: number'),
    () => ({ "面板行": panelSrc.split('\n').find((l) => l.includes('未估阶段'))?.trim() ?? '', "api行": apiSrc.split('\n').find((l) => l.includes('unEstimatedPhases'))?.trim() ?? '' }));
  if (!R_SEED) skipped('S-03/S-04 的行为腿', 'R 段未就绪——字面腿单独存活不足以证明口径统一');
}

group('N 负对照（无条件执行）');
{
  const pre = ex(artifactRows({ aggRole: 'detail', dropCount: true }));   // 修复前的 tagging
  const post = ex(artifactRows());
  const pnl = ex(panelRows());
  ok('N-01 变异复现：聚合行退回 role:detail 且不喂 count 行（=修复前）→ 交付件 unEstimated 读 4 与面板 3 分叉，阶段桶却照样是 3（所以它才是该承载阶段缺口的键）',
    pre.unEstimated === WANT.preFixUnEstimated && pre.unEstimated !== pnl.unEstimated
    && pre.unEstimatedPhases === WANT.unEstimatedPhases && post.unEstimated === pnl.unEstimated,
    { 修复前: pre, 修复后: post, 面板: pnl });
  ok('N-02 变异复现：摘掉 count 行（只改这一处）→ 非 dev 的未估明细在交付件侧消失，分叉复现',
    ex(artifactRows({ dropCount: true })).unEstimated < post.unEstimated
    && ex(artifactRows({ dropCount: true })).unEstimated === WANT.unEstimated
      - FACTS.filter((f) => isDetail(f) && f.phase !== 'dev' && !f.points).length,
    { 无count: ex(artifactRows({ dropCount: true })).unEstimated, 有count: post.unEstimated });
  ok('N-03 变异复现：把聚合行 tagging 改掉（phase→detail 一处，count 仍喂）→ 阶段缺口又被算成「待录入条数」',
    ex(artifactRows({ aggRole: 'detail' })).unEstimated > post.unEstimated,
    { 冒充明细: ex(artifactRows({ aggRole: 'detail' })).unEstimated, 正确: post.unEstimated });
  ok('N-04 反证面自证：判据不依赖环境——同一份夹具在两种喂法下各自独立命中期望值，且计数桶与进 Σ 行构成完整划分',
    ex(panelRows()).unEstimated === WANT.unEstimated && ex(artifactRows()).unEstimatedPhases === WANT.unEstimatedPhases
    && bs(panelRows()).countedKeys.length + pnl.unEstimated + pnl.milestone === FACTS.length, { WANT });
  probe('N-05 okPair 契约探针（按设计让字面腿失配，验红因落「锚点失配」而非「行为失守」）', () => true, () => false);
}

group('收口');
note(`夹具：${FACTS.length} 条计划（里程碑 ${WANT.milestone}、未估明细 ${WANT.unEstimated}、空阶段 ${WANT.unEstimatedPhases}、进 Σ ${WANT.counted}）`);
note(`面板 excluded：${JSON.stringify(panel)}｜交付件 excluded：${JSON.stringify(artEx)}`);
note(`取证面：${ANCHOR_REF}（入库后复跑请删掉 T02630_ANCHOR_REF 让默认 HEAD 生效）`);
note(`数据目录：${DATA_DIR}（收尾自动删除，除非 T02630_KEEP=1）`);

const head = 'T02630 excluded 口径分叉门（T02293 改判：判据对象＝真实取数路径上的 excluded 逐键同值 + 真导出件备注取值）\n';
const body = `PASS=${pass} FAIL=${fail} SKIP=${skip}\n${head}${lines.join('\n')}\n${probes.join('\n')}\n`;
const file = writeGateResults(OUT_DIR, OUT_BASE, body, { port: PORT, dataDir: DATA_DIR, note: `锚点面=${ANCHOR_REF}` });
console.log(`\nPASS=${pass} FAIL=${fail} SKIP=${skip} → ${file}`);
process.exit(fail > 0 ? 1 : 0);
