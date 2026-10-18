/**
 * T02095 门：启动会 PPT 前置校验（PRD-项目启动会PPT生成 §3.2 FR-2）落地验证。
 *
 * 判据口径（T02293 改判，见 `docs/验收门判据规约.md`）：
 *  - **不再读生产库**：原先「复制 `APPDATA/MTask/data/mtask.db` + 写死 mtask五期 projectId」的轨道整条删掉，
 *    夹具由本门在隔离库里自造（判据 2）。生产库现状改记 `skipped()`，不冒充 PASS。
 *  - S 组源码文本锚改打**副作用探针 + 返回值**：AI/网络/库写入三类副作用由门内挂钩量出来
 *    （`AIService` 方法替换、`globalThis.fetch` 代理、SQL `total_changes()`、`sqlite_master` 表名集合），
 *    取数一致性由「独立调用各 Service 查询做 oracle」证明；字面锚一律走 `okPair`，只在行为侧通过时才算绿。
 *  - T 组阈值改测**帽在哪一格**（2 条需求 fail / 3 条 ok；50% 日期填充 warn / 66.7% ok；60% 工期填充 warn / 80% ok），
 *    不再匹配 `MIN_REQUIREMENTS = 3` 这类常量写法——等价重构改写法不误红，阈值真漂移必红。
 *  - N 组负对照（判据 4）：每条改判都造一份「行为被破坏」的对照（门内 UPDATE、AI 桩被真调、
 *    篡改内存副本、purge 一条夹具计划、抽掉估算行），证明同一判据会因此转红。
 *
 * 分组：
 *   S 组 契约守卫（进程内 preflight + 副作用探针 × HEAD 字面锚）
 *   T 组 阈值与判定分档（门内夹具逐格撞帽）
 *   R 组 隔离实例 HTTP（生产口径的端点面：结构、跨端点条数一致、幂等、400 信封）
 *   N 组 负对照
 *
 * 隔离纪律：库、端口、临时目录全部临时的；不碰生产数据目录、不连生产实例（39877）。
 * 用法（better-sqlite3 需与当前 Node ABI 匹配；不匹配时用 scripts/vendor/bs137.tar.gz 恢复）：
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-t02095-kickoff-preflight.mts
 * 环境变量：`T02095_PORT`（默认随机 38_741+rand40，与同族其他门的 396xx 段错开）、
 *   `T02095_TMP_ROOT`（默认 D:/code/tmp，**必须落可写盘**——C: 常年满，sqlite 会假报 SQLITE_FULL）。
 * 结果文件落 .workbuddy/t02095-gate-results-<运行标识>.txt 与 t02095-preflight-payload-<运行标识>.json。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeGateResults, gateArtifactPath } from './lib/gate-results.mts';
import { okPair } from './lib/anchor-pair.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP_ROOT = process.env.T02095_TMP_ROOT ?? 'D:/code/tmp';
mkdirSync(TMP_ROOT, { recursive: true });
// ⚠ TMP/TEMP 与数据目录都必须在 D:：C: 常年 0 可用，sqlite 在 C: 上会给出误导性的 SQLITE_FULL
process.env.TMP = TMP_ROOT;
process.env.TEMP = TMP_ROOT;
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't02095-preflight-'));
const PORT = Number(process.env.T02095_PORT ?? 38_741 + Math.floor(Math.random() * 40));
const BASE = `http://127.0.0.1:${PORT}/api`;

// ⚠ 环境变量必须在任何 getDb() 落到磁盘之前设好，否则进程内探针会连到生产库
process.env.MTask_DATA_DIR = DATA_DIR;

const { resolveServerLauncher } = await import('./isolated-server-launcher.mts');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const skippedList: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};
const skipped = (name: string, why: string) => {
  skippedList.push(`${name}：${why}`);
  lines.push(`[SKIP] ${name} —— ${why}（不计 PASS）`);
};
const group = (t: string) => lines.push(`\n== ${t}`);

// ======================= 产品运行时（进程内直调，判据 1） =======================
const U = (rel: string) => pathToFileURL(join(ROOT, 'server', rel)).href;
const { getDb, closeDb, dbFilePath } = await import(U('src/db/connection.ts'));
const { initSchema } = await import(U('src/db/schema.ts'));
const { PlanService } = await import(U('src/services/PlanService.ts'));
const { TestCaseService } = await import(U('src/services/TestCaseService.ts'));
const { EstimateService, ESTIMATE_PHASES } = await import(U('src/services/EstimateService.ts'));
const { AIService } = await import(U('src/services/AIService.ts'));
const { estimatesSnapshot } = await import(U('src/routes/estimates.ts'));
const K = await import(U('src/services/kickoffService.ts'));

const db = getDb();
initSchema();
const projectIds = () => (db.prepare('SELECT id FROM projects').all() as Array<{ id: string }>).map((r) => r.id);
/** 产品自身 schema 的种子项目（如 `sys-inbox` 收件箱），在任何门内夹具落库之前取，作为「白名单基线」 */
const IDS0 = new Set(projectIds());

/** 产品代码一律取**已提交树**（反模式 11：工作树可能躺着并发会话留下的过期副本；本仓 `routes/plans.ts` 实测就是脏的） */
const headSrc = (rel: string): string => {
  try { return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 }).toString('utf8'); }
  catch { return ''; }
};
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const svcRaw = headSrc('server/src/services/kickoffService.ts');
const svcSrc = stripComments(svcRaw);
const routeSrc = stripComments(headSrc('server/src/routes/plans.ts'));
// 零 AI 依赖按**段**断言：大纲段（T02096）与流式段（T02103）后续落在同一文件里，整文件断言会在合法演进中误红。
// ⚠ 分节线本身是注释：必须先在**未剥注释**的原文上切段，切完再剥注释——先剥后切会切出空串（假绿/假红都无从判断）。
const preflightSrc = (() => {
  const a = svcRaw.indexOf('// ---------- 前置校验');
  const b = a < 0 ? -1 : svcRaw.indexOf('// ----------', a + 1);
  return a < 0 || b <= a ? '' : stripComments(svcRaw.slice(a, b));
})();

// ======================= 副作用探针（判据 1 的行为侧） =======================
const tableNames = () => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
const TABLES0 = new Set(tableNames());
/** SQLite 权威写计数（本连接累计改动的行数）——不受产品语句缓存影响，比扫源码文本可靠 */
const totalChanges = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;

/**
 * 在 `run()` 期间记录四类副作用：`AIService` 任一方法被调、`globalThis.fetch` 被调、
 * 本连接改动过的行数（`total_changes`，SQLite 权威计数，不受语句缓存影响）、新增表名。
 * 挂钩一律在 finally 里还原——探针本身不许留下残渣（反模式 12 的同源要求：破坏的必须是行为，不是世界状态）。
 */
function probeEffects(run: () => unknown): { ai: string[]; net: string[]; writes: number; newTables: string[] } {
  const ai: string[] = [];
  const net: string[] = [];
  const before = new Set(tableNames());
  const t0 = totalChanges();
  const origs = new Map<string, unknown>();
  for (const key of Object.keys(AIService)) {
    const v = (AIService as Record<string, unknown>)[key];
    if (typeof v === 'function') {
      origs.set(key, v);
      (AIService as Record<string, unknown>)[key] = (..._a: unknown[]) => { ai.push(`AIService.${key}`); return Promise.resolve(null); };
    }
  }
  const origFetch = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = (...a: unknown[]) => {
    net.push(String((a[0] as { toString?: () => string })?.toString?.() ?? a[0]));
    return (origFetch as (...x: unknown[]) => unknown).apply(globalThis, a);
  };
  try {
    run();
  } finally {
    for (const [key, v] of origs) (AIService as Record<string, unknown>)[key] = v;
    (globalThis as Record<string, unknown>).fetch = origFetch;
  }
  return { ai, net, writes: totalChanges() - t0, newTables: tableNames().filter((n) => !before.has(n)) };
}

/** 全库写痕指纹：夹具表行数 + updated_at 长度和。跨 HTTP 调用前后必须逐字相同（只读性的外部证据） */
const writeFingerprint = () => {
  const tabs = ['projects', 'prd_docs', 'prd_requirements', 'plan_tasks', 'test_cases', 'estimate_items'];
  return tabs
    .map((t) => {
      const r = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(COALESCE(updated_at,''))), 0) AS a FROM ${t}`).get() as { n: number; a: number };
      return `${t}:${r.n}:${r.a}`;
    })
    .join('|');
};

// ======================= 夹具（判据 2：门内自造数据） =======================
const DAY = 86400000;
const T0 = Date.UTC(2026, 0, 5);
const iso = (offDays: number) => new Date(T0 + offDays * DAY).toISOString().slice(0, 10);
const NOW = new Date().toISOString();
const insProj = db.prepare('INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');

interface FixCfg {
  id: string; name: string; docs?: number; reqs?: number; plans?: number; milestones?: number;
  /** 有起止日期的计划条数（其余按门内夹具写入清空，模拟「无排期」） */
  dated?: number;
  /** 工期与复杂度都为空的条数（模拟 P6 未填） */
  unrated?: number;
  cases?: number; estimates?: number; workspace?: 'real' | 'missing' | 'unset';
}
interface Fixture extends FixCfg {
  planIds: string[];
  /** 由 PlanService.list 实际读到的行（preflight 与它们同源） */
  rows: Array<Record<string, any>>;
  docs: number; reqs: number; cases: number;
}
const FIX: Record<string, Fixture> = {};

function seed(cfg: FixCfg): Fixture {
  insProj.run(cfg.id, cfg.name, '', NOW, NOW);
  for (let i = 0; i < (cfg.docs ?? 0); i++) {
    PlanService.createPrdDoc({ projectId: cfg.id, filename: `PRD-夹具-${cfg.id}-${i + 1}.md`, contentMd: `# 背景\n夹具正文 ${i + 1}` });
  }
  for (let i = 0; i < (cfg.reqs ?? 0); i++) PlanService.createRequirement(cfg.id, { title: `夹具需求 ${i + 1}` });
  const planIds: string[] = [];
  const total = cfg.plans ?? 0;
  const ms = cfg.milestones ?? 0;
  for (let i = 0; i < total; i++) {
    const row = PlanService.create({
      projectId: cfg.id, title: i < ms ? `M${i + 1} 夹具里程碑` : `夹具计划 ${i + 1}`,
      startDate: iso(i * 3), durationDays: 5, kind: i < ms ? 'milestone' : 'normal', assignee: '夹具甲',
    });
    planIds.push(String(row.id));
  }
  if (cfg.dated !== undefined && cfg.dated < total) {
    // 里程碑排在前面，只清空普通行的日期
    const normals = planIds.slice(ms);
    const toBlank = normals.slice(0, Math.max(0, normals.length - Math.max(0, (cfg.dated ?? total) - ms)));
    const upd = db.prepare("UPDATE plan_tasks SET start_date = '', end_date = '' WHERE id = ?");
    toBlank.forEach((id) => upd.run(id));
  }
  if (cfg.unrated !== undefined && cfg.unrated > 0) {
    const normals = planIds.slice(ms);
    const upd = db.prepare('UPDATE plan_tasks SET duration_days = 0, complexity = NULL WHERE id = ?');
    normals.slice(0, cfg.unrated).forEach((id) => upd.run(id));
  }
  for (let i = 0; i < (cfg.cases ?? 0); i++) TestCaseService.create({ projectId: cfg.id, title: `夹具用例 ${i + 1}` });
  if (cfg.estimates && cfg.estimates > 0) {
    const normals = planIds.slice(ms).slice(0, cfg.estimates);
    const r = EstimateService.upsertBatch(cfg.id, normals.map((planId) => ({
      planId, phase: ESTIMATE_PHASES[2] as string, optimistic: 2, likely: 4, pessimistic: 8,
    })) as never);
    if (r.written !== normals.length) throw new Error(`估算夹具写入不完整：${JSON.stringify(r)}`);
  }
  const wsPath = cfg.workspace === 'real' ? DATA_DIR : cfg.workspace === 'missing' ? join(DATA_DIR, 'fx-no-such-dir') : '';
  db.prepare('UPDATE projects SET workspace_path = ? WHERE id = ?').run(wsPath, cfg.id);
  const rows = PlanService.list(cfg.id) as Array<Record<string, any>>;
  return {
    ...cfg, planIds, rows,
    docs: PlanService.listPrdDocs(cfg.id).length,
    reqs: PlanService.listRequirements(cfg.id).length,
    cases: TestCaseService.stats(cfg.id).total,
  };
}

const CFGS: FixCfg[] = [
  { id: 'fx-empty', name: 'T02095 夹具·全空' },
  { id: 'fx-full', name: 'T02095 夹具·数据齐备', docs: 1, reqs: 4, plans: 6, milestones: 2, cases: 3, estimates: 3, workspace: 'real' },
  { id: 'fx-partial', name: 'T02095 夹具·只缺 PRD', reqs: 4, plans: 4, workspace: 'unset' },
  { id: 'fx-req2', name: 'T02095 夹具·需求 2 条', docs: 1, reqs: 2, plans: 4 },
  { id: 'fx-req3', name: 'T02095 夹具·需求 3 条', docs: 1, reqs: 3, plans: 4 },
  { id: 'fx-plan2', name: 'T02095 夹具·计划 2 条', docs: 1, reqs: 4, plans: 2 },
  { id: 'fx-datelow', name: 'T02095 夹具·日期填充 50%', docs: 1, reqs: 4, plans: 6, dated: 3 },
  { id: 'fx-datehigh', name: 'T02095 夹具·日期填充 66.7%', docs: 1, reqs: 4, plans: 6, dated: 4 },
  { id: 'fx-wllow', name: 'T02095 夹具·工期填充 60%', docs: 1, reqs: 4, plans: 5, unrated: 2 },
  { id: 'fx-wlhigh', name: 'T02095 夹具·工期填充 80%', docs: 1, reqs: 4, plans: 5, unrated: 1 },
  { id: 'fx-noest', name: 'T02095 夹具·无估算行', docs: 1, reqs: 4, plans: 4 },
  { id: 'fx-flip', name: 'T02095 夹具·估算开关轨', docs: 1, reqs: 4, plans: 4 },
  { id: 'fx-wsbad', name: 'T02095 夹具·工作空间不可访问', docs: 1, reqs: 4, plans: 4, workspace: 'missing' },
];
CFGS.forEach((c) => { FIX[c.id] = seed(c); });

const pf = (id: string) => K.preflight(id) as any;
const itemOf = (r: any, key: string) => (r?.items ?? []).find((i: any) => i.key === key);
/** 独立 oracle：不经 preflight，直接按各 Service 的公开查询算出「页面上应当是多少」 */
const oracle = (id: string) => {
  const rows = PlanService.list(id) as Array<Record<string, any>>;
  const ws = (db.prepare('SELECT workspace_path FROM projects WHERE id = ?').get(id) as { workspace_path: string } | undefined)?.workspace_path ?? '';
  let wsOk = 0;
  try { wsOk = ws && statSync(ws).isDirectory() ? 1 : 0; } catch { wsOk = 0; }
  return {
    P1: PlanService.listPrdDocs(id).length,
    P2: PlanService.listRequirements(id).length,
    P3: rows.length,
    P4: rows.filter((p) => p.kind === 'milestone').length,
    P5: TestCaseService.stats(id).total,
    P6: rows.filter((p) => p.complexity != null || (p.duration_days ?? 0) > 0).length,
    P7: wsOk,
  };
};
const countsOf = (r: any) => Object.fromEntries(((r?.items ?? []) as any[]).map((i) => [i.key, i.count]));
const statusOf = (r: any, key: string) => itemOf(r, key)?.status;

// 进程内基线（带副作用探针）——后续 S 组的行为侧全部取这一份实测
const FULL = FIX['fx-full'];
let probeRun = { ai: [] as string[], net: [] as string[], writes: 0, newTables: [] as string[] };
const PF_FULL: any = (() => { let out: any = null; probeRun = probeEffects(() => { out = pf('fx-full'); }); return out; })();
const EMPTY_PF = pf('fx-empty');
const PARTIAL_PF = pf('fx-partial');
const WS_BAD_PF = pf('fx-wsbad');

// ======================= S 组：契约守卫（行为侧实测 × HEAD 字面锚） =======================
group('S 组 契约守卫（进程内 preflight + 副作用探针）');
const liveIds = projectIds();
const fxIds = liveIds.filter((id) => id.startsWith('fx-'));
const foreignIds = liveIds.filter((id) => !id.startsWith('fx-') && !IDS0.has(id));
const dbFile = dbFilePath().replace(/\\/g, '/');
ok('S-00 隔离库由门内自造夹具，零生产数据接触',
  FIX['fx-full'].rows.length === 6
  && fxIds.length === CFGS.length && CFGS.every((c) => fxIds.includes(c.id))
  && foreignIds.length === 0
  && dbFile.startsWith(`${DATA_DIR.replace(/\\/g, '/')}/`)
  && !dbFile.includes(join(process.env.APPDATA ?? '', 'MTask', 'data').replace(/\\/g, '/')),
  { 夹具项目: fxIds.length, 外来项目: foreignIds, 产品种子: [...IDS0], 库文件: dbFile });
skipped('原 R-00a/R-17 生产库副本与 mtask五期 现状',
  '判据 2：存量业务数据是易变外部状态（五期那批计划此后可能被删），本门不再复制 `APPDATA/MTask/data/mtask.db`、不再断言生产项目；真实项目轨道改由门内夹具（S/T/R 组）承担');

okPair(ok, 'S-01 校验实现零 AI 依赖、零网络（FR-2.3 只读、零配额）',
  // 行为侧：把 AIService 全部方法与 globalThis.fetch 换成记录器后真跑一次 preflight——
  // 一次调用都不许发生，同时结果仍是完整的七项结构（不靠「源码里有没有那个名字」定绿）
  () => PF_FULL?.items?.length === 7 && PF_FULL?.projectName === FULL.name && probeRun.ai.length === 0 && probeRun.net.length === 0,
  () => preflightSrc.length > 200 && !/AIService|askJson|fetch\(/.test(preflightSrc),
  () => ({ 'AI 调用': probeRun.ai, '网络调用': probeRun.net, 段长: preflightSrc.length }));

okPair(ok, 'S-02 未新增表、未写库（只读聚合）',
  // 行为侧：SQLite 权威计数器 total_changes 在本次调用里增量为 0，且 sqlite_master 表名集合不变
  () => PF_FULL?.items?.length === 7 && probeRun.writes === 0 && probeRun.newTables.length === 0 && TABLES0.has('plan_tasks'),
  () => !/\b(INSERT|UPDATE|DELETE)\b/i.test(preflightSrc),
  () => ({ 'total_changes 增量': probeRun.writes, 新增表: probeRun.newTables }));

okPair(ok, 'S-03 取数全部复用既有 Service 查询（校验值 = 页面实际条数，PRD 验收 3）',
  // 行为侧：七个 key 的 count 逐个等于「不经 preflight、独立调用各 Service 公开查询」算出的条数；
  // 两个夹具同时成立（只对一个项目成立可能是巧合）
  () => {
    const cmp = (id: string) => {
      const o = oracle(id); const c = countsOf(pf(id));
      return (Object.keys(o) as Array<keyof typeof o>).every((k) => c[k] === o[k]);
    };
    return cmp('fx-full') && cmp('fx-datelow') && cmp('fx-empty');
  },
  // 字面侧：实现里只允许「工作空间」一处直查 projects（其余一律经 Service）
  () => (svcSrc.match(/getDb\(\)/g) ?? []).length === 1,
  () => ({ 实测: countsOf(PF_FULL), oracle: oracle('fx-full') }));

okPair(ok, 'S-04 硬阻塞口径 = P1∧P2∧P3 全 fail 才阻塞（FR-2.4，非任意缺失即阻塞）',
  // 行为侧：全空夹具 blocked=true 且 missingHard 恰为三个硬项；只缺 PRD 的夹具 blocked=false
  // 而 missingHard 恰是那一个 fail 的硬项（「部分缺失仍可生成」的口径只能在真数据上验）
  () => {
    const hardKeys = (r: any) => (r.items as any[]).filter((i) => i.hard).map((i) => i.key).sort().join('');
    const failedHard = (r: any) => (r.items as any[]).filter((i) => i.hard && i.status === 'fail').map((i) => i.key).sort().join('');
    return EMPTY_PF.blocked === true && hardKeys(EMPTY_PF) === 'P1P2P3' && String(EMPTY_PF.missingHard.sort().join('')) === 'P1P2P3'
      && PARTIAL_PF.blocked === false && failedHard(PARTIAL_PF) === 'P1' && PARTIAL_PF.missingHard.join('') === 'P1';
  },
  () => /hardItems\.length > 0 && missingHard\.length === hardItems\.length/.test(svcSrc) && /key: 'P1'[\s\S]*hard: true/.test(svcSrc),
  () => ({ 全空: { blocked: EMPTY_PF.blocked, missingHard: EMPTY_PF.missingHard }, 只缺PRD: { blocked: PARTIAL_PF.blocked, missingHard: PARTIAL_PF.missingHard } }));

okPair(ok, 'S-05 工作量来源判定复用估算汇总 countedKeys（不另数一遍）',
  // 行为侧：workloadSource 与**同一个** `estimatesSnapshot(pid).summary.countedKeys` 的长度同判，
  // 有估算行的夹具判 estimate、没有的判 duration（两个夹具各自独立成立）
  () => {
    const verdict = (id: string) => {
      const counted = estimatesSnapshot(id).summary.countedKeys.length;
      return pf(id).workloadSource === (counted > 0 ? 'estimate' : 'duration') ? counted : -1;
    };
    const a = verdict('fx-full'); const b = verdict('fx-noest');
    return a > 0 && b === 0;
  },
  () => /estimatesSnapshot\(projectId\)\.summary/.test(svcSrc) && /countedKeys\.length > 0/.test(svcSrc),
  () => ({ '有估算 countedKeys': estimatesSnapshot('fx-full').summary.countedKeys.length, '无估算 countedKeys': estimatesSnapshot('fx-noest').summary.countedKeys.length }));

const NOTE_KEYS = ['fx-full', 'fx-empty', 'fx-partial', 'fx-wsbad', 'fx-datelow', 'fx-req2', 'fx-plan2', 'fx-wllow'];
okPair(ok, 'S-06 每条都带「怎么补」文案与前端深链，且文案里点名的是本轮夹具自己的数',
  // 行为侧：八个夹具的每一项 note 非空、deepLink 命中前端可达形态（plan/report 打头）且同项跨夹具稳定；
  // 硬缺失项的文案必须带上「门自己写进库里的数」——缺日期条数 / 工作空间路径 / 计划条数，
  // 抄在源码里的第二份数字过不了这一关
  () => {
    const deepOk = (s: string) => /^(plan|report)(\?|$)/.test(String(s ?? ''));
    for (const id of NOTE_KEYS) {
      const r = pf(id);
      for (const it of r.items as any[]) {
        if (!it.note || String(it.note).trim().length < 4) return false;
        if (!deepOk(it.deepLink)) return false;
      }
    }
    const o = oracle('fx-datelow');
    const p3 = itemOf(pf('fx-datelow'), 'P3');
    const undated = o.P3 - (FIX['fx-datelow'].rows as any[]).filter((p) => String(p.start_date ?? '').trim() && String(p.end_date ?? '').trim()).length;
    const gapOk = undated > 0 ? String(p3.note).includes(String(undated)) : true;
    const wsNote = String(itemOf(pf('fx-wsbad'), 'P7').note);
    const badPath = join(DATA_DIR, 'fx-no-such-dir');
    const p1Empty = String(itemOf(EMPTY_PF, 'P2').note);
    return gapOk && wsNote.includes(badPath) && p1Empty.includes(String(oracle('fx-empty').P2));
  },
  () => /note:/.test(svcSrc) && /deepLink: 'plan\?menu=prd'/.test(svcSrc) && /deepLink: 'report\?card=prd-import'/.test(svcSrc),
  () => ({ 缺日期条数: oracle('fx-datelow').P3, P3文案: itemOf(pf('fx-datelow'), 'P3').note, P7文案: itemOf(pf('fx-wsbad'), 'P7').note }));

ok('S-07 硬项深链与降级项深链不同源（P1→PRD 菜单、P3→导入卡片，前端照此落点）',
  (() => {
    const e = EMPTY_PF.items as any[];
    const by = (k: string) => e.find((i) => i.key === k)?.deepLink;
    return ['P1', 'P2', 'P3'].every((k) => by(k) && by(k).includes('?')) && new Set(['P1', 'P2', 'P3'].map(by)).size === 3;
  })(), (EMPTY_PF.items as any[]).map((i) => [i.key, i.deepLink]));

ok('S-08 校验结果字段集固定（面板契约：projectId/projectName/items/blocked/missingHard/workloadSource）',
  ['projectId', 'projectName', 'items', 'blocked', 'missingHard', 'workloadSource'].every((k) => k in PF_FULL) &&
    Object.keys(itemOf(PF_FULL, 'P1')).sort().join(',') === 'count,deepLink,hard,key,label,note,status',
  { 顶层: Object.keys(PF_FULL), 项: Object.keys(itemOf(PF_FULL, 'P1')) });

// ======================= T 组：阈值撞格（替代「抄常量」的写法锚） =======================
group('T 组 阈值与分档（门内夹具撞帽）');
ok('T-01 P2 帽在 3：2 条需求 → fail，3 条 → ok（数量与夹具逐条对齐）',
  statusOf(pf('fx-req2'), 'P2') === 'fail' && statusOf(pf('fx-req3'), 'P2') === 'ok'
  && countsOf(pf('fx-req2')).P2 === 2 && countsOf(pf('fx-req3')).P2 === 3,
  { 两条: statusOf(pf('fx-req2'), 'P2'), 三条: statusOf(pf('fx-req3'), 'P2') });
ok('T-02 P3 帽在 3：2 条计划 → fail，4 条 → 不 fail',
  statusOf(pf('fx-plan2'), 'P3') === 'fail' && statusOf(pf('fx-req3'), 'P3') !== 'fail',
  { 两条: statusOf(pf('fx-plan2'), 'P3'), 四条: statusOf(pf('fx-req3'), 'P3') });
ok('T-03 P3 日期填充率帽在 60%：3/6 → warn，4/6 → ok（两端各差一格）',
  statusOf(pf('fx-datelow'), 'P3') === 'warn' && statusOf(pf('fx-datehigh'), 'P3') === 'ok',
  { 低: itemOf(pf('fx-datelow'), 'P3')?.note, 高: itemOf(pf('fx-datehigh'), 'P3')?.note });
ok('T-04 P6 工期/复杂度填充率帽在 80%：3/5 → warn，4/5 → ok',
  statusOf(pf('fx-wllow'), 'P6') === 'warn' && statusOf(pf('fx-wlhigh'), 'P6') === 'ok',
  { 低: countsOf(pf('fx-wllow')).P6, 高: countsOf(pf('fx-wlhigh')).P6 });
ok('T-05 P4 里程碑：0 个 → warn 且不阻塞，2 个 → ok',
  statusOf(pf('fx-req3'), 'P4') === 'warn' && statusOf(pf('fx-full'), 'P4') === 'ok' && PARTIAL_PF.blocked === false,
  { 零: statusOf(pf('fx-req3'), 'P4'), 齐: statusOf(pf('fx-full'), 'P4') });
ok('T-06 P5 用例：0 条 → warn 且不改写 P1~P3 判定，3 条 → ok',
  statusOf(pf('fx-partial'), 'P5') === 'warn' && statusOf(pf('fx-full'), 'P5') === 'ok' && countsOf(pf('fx-partial')).P5 === 0,
  { 零: statusOf(pf('fx-partial'), 'P5'), 有: countsOf(pf('fx-full')).P5 });
ok('T-07 P7 工作空间三态：未配置 / 目录不可访问 → warn+count 0；真实目录 → ok+count 1',
  statusOf(pf('fx-partial'), 'P7') === 'warn' && countsOf(pf('fx-partial')).P7 === 0
  && statusOf(pf('fx-wsbad'), 'P7') === 'warn' && countsOf(pf('fx-wsbad')).P7 === 0
  && statusOf(pf('fx-full'), 'P7') === 'ok' && countsOf(pf('fx-full')).P7 === 1,
  { 未配置: countsOf(pf('fx-partial')).P7, 不可访问: countsOf(pf('fx-wsbad')).P7, 可访问: countsOf(pf('fx-full')).P7 });
ok('T-08 七项顺序与硬项标记稳定（P1~P7 齐备，硬项恰为前三）',
  ((PF_FULL.items as any[]).map((i) => i.key).join('') === 'P1P2P3P4P5P6P7')
  && (PF_FULL.items as any[]).filter((i) => i.hard).map((i) => i.key).join('') === 'P1P2P3',
  (PF_FULL.items as any[]).map((i) => [i.key, i.hard]));
ok('T-09 数据齐备的夹具项目不被硬阻塞（原「真实项目不被阻塞」的门内轨道）',
  PF_FULL.blocked === false && PF_FULL.missingHard.length === 0 && (PF_FULL.items as any[]).every((i) => i.status !== 'fail'),
  { blocked: PF_FULL.blocked, missingHard: PF_FULL.missingHard, statuses: (PF_FULL.items as any[]).map((i) => [i.key, i.status]) });

// ======================= R 组：隔离实例（HTTP 行为面） =======================
group('R 组 隔离实例 HTTP');
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
ok('R-00a 隔离实例 launcher 解析成功', existsSync(join(ROOT, 'server', 'src', 'index.ts')), { exec: LAUNCHER.exec, label: LAUNCHER.label });
const child: ChildProcess = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT,
  env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog: string[] = [];
child.stdout?.on('data', (b: Buffer) => serverLog.push(b.toString()));
child.stderr?.on('data', (b: Buffer) => serverLog.push(b.toString()));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUp(ms = 90_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok && (await res.json().catch(() => null))?.service === 'mtask-server') return true;
    } catch { /* 还没起来 */ }
    await sleep(400);
  }
  return false;
}
async function get<T = any>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(BASE + path);
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}
async function post<T = any>(path: string, json: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

let HTTP_BODY = '';
if (!(await waitUp())) {
  ok('R-00 隔离实例启动', false, serverLog.join('').slice(-500));
} else {
  ok('R-00 隔离实例启动', true);
  const fpBefore = writeFingerprint();
  const pfHttp = await get<any>(`/plans/kickoff-preflight?projectId=${FULL.id}`);
  HTTP_BODY = JSON.stringify(pfHttp.body);
  const items: any[] = pfHttp.body?.items ?? [];
  const by = (k: string) => items.find((i) => i.key === k)?.count;

  ok('R-01 端点 200 且返回固定结构（items 数组 + blocked 布尔）',
    pfHttp.status === 200 && Array.isArray(items) && typeof pfHttp.body.blocked === 'boolean',
    { status: pfHttp.status, keys: Object.keys(pfHttp.body ?? {}) });
  ok('R-02 七项齐备且顺序 P1~P7', items.length === 7 && items.map((i) => i.key).join('') === 'P1P2P3P4P5P6P7', items.map((i) => i.key));
  ok('R-03 每项都有 label/count/status/note/deepLink/hard',
    items.every((i) => i.label && typeof i.count === 'number' && ['ok', 'warn', 'fail'].includes(i.status) && i.note && i.deepLink && typeof i.hard === 'boolean'),
    items.find((i) => !i.label || !i.note || !i.deepLink));

  const docs = await get<any[]>(`/plans/prd-docs?projectId=${FULL.id}`);
  const reqs = await get<any[]>(`/plans/prd-requirements?projectId=${FULL.id}`);
  const plans = await get<any[]>(`/plans?projectId=${FULL.id}`);
  const cases = await get<any>('/plans/test-cases/stats?projectId=' + FULL.id);
  ok('R-04 P1 条数 = /prd-docs 实际条数', by('P1') === (docs.body ?? []).length, { preflight: by('P1'), api: (docs.body ?? []).length });
  ok('R-05 P2 条数 = /prd-requirements 实际条数', by('P2') === (reqs.body ?? []).length, { preflight: by('P2'), api: (reqs.body ?? []).length });
  ok('R-06 P3 条数 = /plans 实际条数（门内夹具 6 条）', by('P3') === (plans.body ?? []).length && by('P3') === 6,
    { preflight: by('P3'), api: (plans.body ?? []).length });
  ok('R-07 P4 条数 = P3 中 kind=milestone 行数', by('P4') === (plans.body ?? []).filter((p: any) => p.kind === 'milestone').length,
    { preflight: by('P4') });
  ok('R-08 P5 条数 = /test-cases/stats.total', by('P5') === cases.body?.total, { preflight: by('P5'), api: cases.body?.total });

  const rows: any[] = plans.body ?? [];
  const dated = rows.filter((p) => !!String(p.start_date ?? '').trim() && !!String(p.end_date ?? '').trim()).length;
  const p3 = itemOf(pfHttp.body, 'P3');
  const expectP3 = rows.length < 3 ? 'fail' : dated / Math.max(rows.length, 1) < 0.6 ? 'warn' : 'ok';
  ok('R-09 P3 status 与独立复算的日期填充率一致', p3?.status === expectP3, { actual: p3?.status, expect: expectP3, dated, total: rows.length });
  const lowHttp = await get<any>(`/plans/kickoff-preflight?projectId=fx-datelow`);
  const lowRows = await get<any[]>(`/plans?projectId=fx-datelow`);
  const highRows = await get<any[]>(`/plans?projectId=fx-datehigh`);
  const undatedOf = (rs: any[]) => (rs ?? []).filter((p) => !String(p.start_date ?? '').trim() || !String(p.end_date ?? '').trim()).length;
  const lowUndated = undatedOf(lowRows.body);
  const highUndated = undatedOf(highRows.body);
  ok('R-10 P3 文案点名的缺日期条数 = 本轮 /plans 实际缺日期的条数（warn 与 ok 两档都带上自己的数）',
    lowUndated === 3 && highUndated === 2
    && String(itemOf(lowHttp.body, 'P3')?.note).includes(String(lowUndated))
    && String(itemOf(pf('fx-datehigh'), 'P3').note).includes(String(highUndated)),
    { warn档缺: lowUndated, warn档文案: itemOf(lowHttp.body, 'P3')?.note, ok档缺: highUndated });

  const pf2 = await get<any>(`/plans/kickoff-preflight?projectId=${FULL.id}`);
  ok('R-11a 连续两次调用结果逐字一致（只读幂等）', JSON.stringify(pfHttp.body) === JSON.stringify(pf2.body));
  ok('R-11b 跨 HTTP 调用零写痕（夹具表行数与 updated_at 长度和逐字不变）', writeFingerprint() === fpBefore,
    { 前: fpBefore, 后: writeFingerprint() });

  const estFull = await get<any>(`/estimates?projectId=${FULL.id}`);
  const estNone = await get<any>(`/estimates?projectId=fx-noest`);
  const countedFull = estFull.body?.summary?.countedKeys?.length;
  const countedNone = estNone.body?.summary?.countedKeys?.length;
  ok('R-12 workloadSource 与 /estimates 汇总 countedKeys 同判（两侧都走门内夹具）',
    typeof countedFull === 'number' && countedFull > 0 && pfHttp.body?.workloadSource === 'estimate'
    && countedNone === 0 && (await get<any>('/plans/kickoff-preflight?projectId=fx-noest')).body?.workloadSource === 'duration',
    { countedFull, countedNone, workloadSource: pfHttp.body?.workloadSource });

  const np = await post<any>('/projects', { name: `T02095 冒烟空项目 ${process.pid}` });
  const npId = np.body?.id ?? np.body?.project?.id;
  const blockedPf = await get<any>(`/plans/kickoff-preflight?projectId=${npId}`);
  const bi: any[] = blockedPf.body?.items ?? [];
  ok('R-13 新建空项目（经 POST /projects 放行侧写通道）P1/P2/P3 均 fail 且点名进 missingHard',
    np.status === 201 && blockedPf.status === 200 && ['P1', 'P2', 'P3'].every((k) => bi.find((i) => i.key === k)?.status === 'fail')
    && blockedPf.body?.missingHard?.slice().sort().join('') === 'P1P2P3', { 建项状态: np.status, missingHard: blockedPf.body?.missingHard });
  ok('R-14 空项目 blocked=true 且 3 条硬缺失各带深链与文案',
    blockedPf.body?.blocked === true && bi.filter((i) => i.hard).every((i) => !!i.deepLink && !!i.note), bi.filter((i) => i.hard));
  ok('R-15 空项目 P4~P7 只 warn（可选/降级项不阻塞）',
    bi.filter((i) => !i.hard).every((i) => i.status === 'warn'), bi.filter((i) => !i.hard).map((i) => [i.key, i.status]));

  const bad = await get('/plans/kickoff-preflight');
  ok('R-16 缺 projectId → 400 + { error } 且点名参数', bad.status === 400 && !!bad.body?.error && /projectId/.test(String(bad.body.error)), bad);
  ok('R-17 数据齐备的门内夹具不被硬阻塞（blocked=false）', pfHttp.body?.blocked === false && pfHttp.body?.missingHard?.length === 0,
    { blocked: pfHttp.body?.blocked, missingHard: pfHttp.body?.missingHard });
  ok('R-18 HTTP 响应与进程内 preflight() 逐字同结果（路由与服务同一条链路）', HTTP_BODY === JSON.stringify(pf(FULL.id)),
    { HTTP: HTTP_BODY.slice(0, 120), 进程内: JSON.stringify(pf(FULL.id)).slice(0, 120) });

  okPair(ok, 'R-19 kickoff-preflight 挂在 /:id 之前并走 wrap 统一错误口径',
    // 行为侧：该路径确实由 preflight 处理器应答（200 + 七项结构，而不是被参数路由吃掉的 404/明细），
    // 且参数缺失走 wrap 的 400 + { error } 信封
    () => pfHttp.status === 200 && (pfHttp.body?.items ?? []).length === 7 && bad.status === 400 && !!bad.body?.error,
    () => routeSrc.indexOf('/kickoff-preflight') > -1 && routeSrc.indexOf('/kickoff-preflight') < routeSrc.indexOf("planApi.patch('/:id'")
      && /planApi\.get\('\/kickoff-preflight'/.test(routeSrc) && /wrap\(res, \(\) => preflight\(pid\(req\)\)\)/.test(routeSrc),
    () => ({ 说明: '字面锚只锁注册位置（等价重构失配时记 FAIL 交人判定），判定本身由 HTTP 行为侧决定', status: pfHttp.status }));

  try {
    writeFileSync(gateArtifactPath(join(ROOT, '.workbuddy'), 't02095-preflight-payload.json'),
      JSON.stringify({ 夹具全量: pfHttp.body, 空项目: blockedPf.body, 全空夹具: EMPTY_PF, 只缺PRD: PARTIAL_PF }, null, 2), 'utf8');
  } catch { /* 旁证写失败不影响判定 */ }
}

// ======================= N 组：负对照（判据 4） =======================
group('N 组 负对照（证明上面的判据有牙）');
{
  const spy: Array<{ name: string; cond: boolean; extra?: unknown }> = [];
  const sOk = (name: string, cond: boolean, extra?: unknown) => spy.push({ name, cond, extra });

  // N-01 写入探针：门内真改一行夹具，同一条 total_changes 判据必须检出
  const descBefore = (db.prepare('SELECT description FROM projects WHERE id = ?').get('fx-partial') as { description: string }).description;
  const wProbe = probeEffects(() => { db.prepare('UPDATE projects SET description = ? WHERE id = ?').run('反证写入', 'fx-partial'); });
  db.prepare('UPDATE projects SET description = ? WHERE id = ?').run(descBefore, 'fx-partial');
  const cleanProbe = probeEffects(() => { pf('fx-partial'); });
  ok('N-01 写入判据有牙：一次 UPDATE 被探针检出（writes=1），而 preflight 仍为 0——S-02 不是恒绿',
    wProbe.writes === 1 && cleanProbe.writes === 0, { 反证检出: wProbe.writes, 校验实际: cleanProbe.writes });

  // N-02 AI/网络探针：真调一次被挂钩的方法与 fetch，探针必须抓到（否则 S-01 只是恒绿）
  const aiProbe = probeEffects(() => {
    void (AIService as any).askJson({});
    void globalThis.fetch(`http://127.0.0.1:${PORT}/api/health`);
  });
  ok('N-02 AI/网络判据有牙：挂钩期间一次 AIService 调用 + 一次 fetch 都被点名，preflight 期间两者为 0',
    aiProbe.ai.length >= 1 && aiProbe.net.length === 1 && probeRun.ai.length === 0 && probeRun.net.length === 0,
    { 反证: { ai: aiProbe.ai, net: aiProbe.net }, 校验: { ai: probeRun.ai, net: probeRun.net } });

  // N-03 硬阻塞判据：把「部分缺失」的副本人为置成 blocked=true，同一条判据必须判红
  const hardSemantics = (r: any) => {
    const hard = (r.items as any[]).filter((i) => i.hard);
    const failed = hard.filter((i) => i.status === 'fail').map((i) => i.key).sort().join('');
    return r.blocked === (hard.length > 0 && failed === hard.map((i) => i.key).sort().join(''))
      && (r.missingHard as string[]).slice().sort().join('') === failed;
  };
  const tamperedBlocked = { ...PARTIAL_PF, blocked: true, missingHard: ['P1', 'P2'] };
  ok('N-03 硬阻塞判据有牙：真结果判绿、篡改副本（部分缺失也阻塞）判红',
    hardSemantics(EMPTY_PF) && hardSemantics(PARTIAL_PF) && !hardSemantics(tamperedBlocked),
    { 篡改副本: { blocked: tamperedBlocked.blocked, missingHard: tamperedBlocked.missingHard } });

  // N-04 取数实时性：走产品自己的下线通道（archive → purge）抽掉一条夹具计划，
  // 旧结果必须与新 oracle 不再相等——若比的是同一份快照（判据无牙）则新旧一致。
  const beforeSnap = countsOf(pf('fx-req3'));
  const victim = (PlanService.list('fx-req3') as Array<Record<string, any>>).find((p) => p.kind !== 'milestone')!;
  const archived = PlanService.archive(String(victim.id));
  const purged = PlanService.purge(String(victim.id));
  const afterPf = countsOf(pf('fx-req3'));
  const afterOracle = oracle('fx-req3');
  ok('N-04 取数判据有牙：产品下线通道抽掉一行后 preflight 与 oracle 同步下降，且旧结果被同一判据判为过期',
    archived === true && purged.deleted === true
    && afterPf.P3 === afterOracle.P3 && afterOracle.P3 === beforeSnap.P3 - 1 && beforeSnap.P3 !== afterOracle.P3,
    { 归档: archived, 清除: purged, 前: beforeSnap.P3, 后: afterPf.P3, oracle: afterOracle.P3 });

  // N-05 countedKeys 关联：给「无估算轨」补上估算行 → 必须翻成 estimate；再删掉 → 必须翻回 duration
  const flipIds = (PlanService.list('fx-flip') as Array<Record<string, any>>).filter((p) => p.kind !== 'milestone').slice(0, 2);
  const before0 = pf('fx-flip').workloadSource;
  EstimateService.upsertBatch('fx-flip', flipIds.map((p) => ({
    planId: String(p.id), phase: ESTIMATE_PHASES[2] as string, optimistic: 2, likely: 4, pessimistic: 8,
  })) as never);
  const after1 = pf('fx-flip').workloadSource;
  flipIds.forEach((p) => EstimateService.remove('fx-flip', String(p.id)));
  const after2 = pf('fx-flip').workloadSource;
  ok('N-05 countedKeys 判据有牙：补估算行翻 estimate、抽掉后翻回 duration（写死的口径不会翻）',
    before0 === 'duration' && after1 === 'estimate' && after2 === 'duration', { 补前: before0, 补后: after1, 抽后: after2 });

  // N-06 note/deepLink 判据：造一份「字段还在但深链为空/文案不含本轮夹具的数」的假结果，同一判据必须判红
  const noteJudge = (r: any) => (r.items as any[]).every((i) => !!i.deepLink && /^(plan|report)(\?|$)/.test(i.deepLink) && String(i.note ?? '').trim().length > 3);
  const fakeNote = JSON.parse(JSON.stringify(EMPTY_PF));
  fakeNote.items[0].deepLink = '';
  const fakeNote2 = JSON.parse(JSON.stringify(EMPTY_PF));
  fakeNote2.items[1].note = '';
  ok('N-06 文案/深链判据有牙：抽掉深链或文案的副本判红，真结果判绿',
    noteJudge(EMPTY_PF) && !noteJudge(fakeNote) && !noteJudge(fakeNote2), { 抽掉的项: [fakeNote.items[0].key, fakeNote2.items[1].key] });

  // N-07 阈值判据：把「2 条需求」的夹具结果人为改成 ok，撞帽判据必须认不出来才叫有牙
  const req2 = pf('fx-req2');
  const tamperedReq = JSON.parse(JSON.stringify(req2));
  tamperedReq.items.find((i: any) => i.key === 'P2').status = 'ok';
  const capJudge = (r: any) => {
    const c = countsOf(r);
    const s = (k: string) => (r.items as any[]).find((i) => i.key === k)?.status;
    return !(c.P2 === 2 && s('P2') === 'ok') && !(c.P2 === 3 && s('P2') === 'fail');
  };
  ok('N-07 阈值判据有牙：低于帽却报 ok 的篡改副本被拒（说明 T-01 认的是「几格」而不是「有没有这句话」）',
    capJudge(req2) && capJudge(pf('fx-req3')) && !capJudge(tamperedReq), { 篡改: { count: countsOf(tamperedReq).P2, status: 'ok' } });

  // N-08 配对红因可区分：行为失守与字面锚点失配是两种红，不能都读成「功能挂了」
  spy.length = 0;
  okPair(sOk, 'N-08a 行为失守样', () => false, () => true);
  okPair(sOk, 'N-08b 锚点失配样', () => true, () => false);
  okPair(sOk, 'N-08c 双绿样', () => true, () => true);
  ok('N-08 红因可区分：两种红各带自己的红因，双绿才计 PASS',
    spy.length === 3 && spy[0].cond === false && JSON.stringify(spy[0].extra).includes('行为失守')
    && spy[1].cond === false && JSON.stringify(spy[1].extra).includes('字面锚点失配') && spy[2].cond === true, spy);
}

try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
const summary = `T02095 前置校验门（kickoff-preflight）：PASS=${pass} FAIL=${fail} SKIP=${skippedList.length}\n` + lines.join('\n') + '\n';
mkdirSync(join(ROOT, '.workbuddy'), { recursive: true });
writeGateResults(join(ROOT, '.workbuddy'), 't02095-gate-results.txt', summary, { port: PORT, dataDir: DATA_DIR });
console.log(`PASS=${pass} FAIL=${fail} SKIP=${skippedList.length}`);
console.log(lines.join('\n'));

// 关自己的库句柄再删目录：Windows 上句柄未释放时 rmSync 只会留下半删的残骸
try { closeDb(); } catch { /* 已关闭 */ }
for (let i = 0; i < 8; i++) {
  try { rmSync(DATA_DIR, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
}
process.exit(fail === 0 ? 0 : 1);
