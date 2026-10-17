/**
 * T02308 回归门：/api/ai/usage 的 `recent` 必须随 days 窗口过滤、并按厂商采样去挤占。
 *
 * 拦的缺陷（生产 39877 实测）：`recent` 原为无窗口 `ORDER BY created_at DESC LIMIT 30`——
 *   某厂商进入快速失败风暴（~340ms/次）时 30 行被同一厂商同一错误全部占满，另一厂商的逐行
 *   错误原文在面板里一行都看不到；且 days=1/7/30/limit=300 四次请求返回逐字节相同。
 *
 * 用法（Node 须与 better-sqlite3 ABI 对齐；见 isolated-server-launcher 探测）：
 *   <node> node_modules/tsx/dist/cli.mjs scripts/verify-t02308-usage-window.mts
 *
 * 环境变量：T02308_PORT（默认 39938）、T02308_TMP_ROOT（默认 D:/code/tmp，勿指 C:——常年 0 可用会 SQLITE_FULL 假性失败）
 *
 * 隔离纪律（skill 红线 8）：夹具写进 mkdtemp 的临时库，另起隔离实例（独立端口 + MTask_DATA_DIR），
 *   不连生产 39877、不碰生产数据目录；跑完 kill 实例 + 回收目录。
 * W-06 为非空转反证：在同库上复跑改前 SQL 形态，要求「旧口径取不到 B 厂商行、新接口取得到」。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveServerLauncher } from './isolated-server-launcher.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP_ROOT = process.env.T02308_TMP_ROOT || 'D:/code/tmp';
mkdirSync(TMP_ROOT, { recursive: true });
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't02308-usage-'));
process.env.MTask_DATA_DIR = DATA_DIR;
const PORT = Number(process.env.T02308_PORT ?? 39938);
const BASE = `http://127.0.0.1:${PORT}`;

const { getDb, closeDb } = await import('../server/src/db/connection.ts');
const { initSchema } = await import('../server/src/db/schema.ts');
initSchema();

const TAG = 'T02308门';
const TA = `${TAG}-A`;   // 失败风暴厂商：近 45 秒内 40 条
const TB = `${TAG}-B`;   // 需要逐行复核的错误原文：1 小时前 1 条
const TC = `${TAG}-C`;   // 窗口外厂商：10 天前 1 条

const nowMs = Date.now();
const ago = (sec: number) => new Date(nowMs - sec * 1000).toISOString();

{
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO ai_usage (id, tool_id, tool_name, model, kind, ok, duration_ms, content_chars, error, created_at)
     VALUES (?, ?, ?, ?, 'classify', 0, 340, 0, ?, ?)`,
  );
  for (let i = 0; i < 40; i++) ins.run(`${TA}-${i}`, null, TA, 'mock-mini', '免费用户限流：rate limit exceeded', ago(5 + i));
  ins.run(`${TB}-0`, null, TB, 'mock-mini', 'Insufficient user quota', ago(3600));
  ins.run(`${TC}-0`, null, TC, 'mock-mini', 'window-outside-fixture', ago(10 * 86400));
}

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${extra !== undefined ? ` → ${JSON.stringify(extra).slice(0, 300)}` : ''}`); }
};

const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const child: ChildProcess = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT,
  env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR, MTask_LOG_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
console.log(`隔离实例启动器：${LAUNCHER.label} / 数据目录 ${DATA_DIR}`);
const serverLog: string[] = [];
child.stdout?.on('data', (b: Buffer) => serverLog.push(b.toString()));
child.stderr?.on('data', (b: Buffer) => serverLog.push(b.toString()));

async function waitForServer(ms = 90_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch { /* 还没起来 */ }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
async function usage(query: string) {
  const res = await fetch(`${BASE}/api/ai/usage${query}`);
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, any> | null };
}
const toolsOf = (recent: any[]) => new Set(recent.map((r) => r.tool_name));
const countOf = (recent: any[], tool: string) => recent.filter((r) => r.tool_name === tool).length;

try {
  if (!(await waitForServer())) {
    ok('S-00 隔离实例就绪', false, { log: serverLog.slice(-10).join('\n').slice(0, 500) });
  } else {
    console.log('\n== W 段：recent 窗口与采样口径 ==');
    const r7 = await usage('?days=7');
    const recent7: any[] = r7.json?.recent ?? [];
    ok('W-01 接口回传口径字段（days/limit/perTool 随响应）',
      r7.status === 200 && r7.json?.days === 7 && Number(r7.json?.limit) > 0 && Number(r7.json?.perTool) > 0,
      { status: r7.status, days: r7.json?.days, limit: r7.json?.limit, perTool: r7.json?.perTool });
    ok('W-02 recent 不再无窗口：days=7 时窗口外厂商 C 的行不出现',
      !toolsOf(recent7).has(TC) && recent7.every((r) => r.created_at >= new Date(nowMs - 7 * 86400e3).toISOString()),
      { n: recent7.length, tools: [...toolsOf(recent7)] });

    const r30 = await usage('?days=30');
    const recent30: any[] = r30.json?.recent ?? [];
    ok('W-03 窗口参数生效可区分：days=30 时 C 的行出现（days=1/7/30 不再逐字节相同）',
      toolsOf(recent30).has(TC), { n: recent30.length, tools: [...toolsOf(recent30)] });
    const diff = await Promise.all(['?days=1', '?days=7', '?days=30'].map(async (q) => JSON.stringify((await usage(q)).json?.recent)));
    ok('W-04 窗口对 recent 真有影响（days=7 与 days=30 结果不再逐字节相同）',
      diff[1] !== diff[2], { sizes: diff.map((d) => d.length) });

    ok('W-05 本单复现用例：风暴厂商 A 连续 40 条失败时，厂商 B 的最近一条仍在 recent 中',
      countOf(recent30, TB) === 1, { n: recent30.length, B: countOf(recent30, TB), A: countOf(recent30, TA) });
    ok('W-06 反证/非空转：改前 SQL 形态（无窗口 + LIMIT 30）在同库上取不到 B 行，新接口取得到',
      (() => {
        const oldRows = getDb().prepare(
          `SELECT tool_name FROM ai_usage ORDER BY created_at DESC LIMIT 30`,
        ).all() as any[];
        return !oldRows.some((r) => r.tool_name === TB) && countOf(recent30, TB) === 1;
      })(),
      { oldTools: [...toolsOf(getDb().prepare('SELECT tool_name FROM ai_usage ORDER BY created_at DESC LIMIT 30').all() as any[])] });

    const perTool = Number(r30.json?.perTool);
    ok('W-07 抗挤占采样：单厂商最多 perTool 条（风暴不吞掉整表）',
      perTool > 0 && countOf(recent30, TA) <= perTool && recent30.length < 40,
      { perTool, A: countOf(recent30, TA), n: recent30.length });
    ok('W-08 每厂商最近一条优先入选（前 K 行覆盖全部 K 个厂商）',
      (() => {
        const k = toolsOf(recent30).size;
        return new Set(recent30.slice(0, k).map((r) => r.tool_name)).size === k;
      })(), { tools: [...toolsOf(recent30)] });

    const rl = await usage('?days=30&limit=3');
    ok('W-09 limit 参数生效且不越界', (rl.json?.recent ?? []).length === 3 && rl.json?.limit === 3,
      { n: (rl.json?.recent ?? []).length, limit: rl.json?.limit });
    const rh = await usage('?days=30&limit=99999');
    ok('W-10 limit 越界被钳制（≤200 且不报错）', rh.status === 200 && Number(rh.json?.limit) <= 200,
      { limit: rh.json?.limit });
    const rp = await usage('?days=30&perTool=1');
    const recentP1: any[] = rp.json?.recent ?? [];
    ok('W-11 perTool=1 时每厂商恰好保留最近一条（三厂商全覆盖）',
      toolsOf(recentP1).size === 3 && [TA, TB, TC].every((t) => countOf(recentP1, t) === 1),
      { tools: [...toolsOf(recentP1)], A: countOf(recentP1, TA) });

    console.log('\n== G 段：同窗口径回归护栏 ==');
    const sum7: any[] = r7.json?.summary ?? [];
    const sum30: any[] = r30.json?.summary ?? [];
    ok('G-01 summary/byTool 仍带窗口（days 放大后聚合天数不减）',
      sum30.length >= sum7.length && (r30.json?.byTool ?? []).length >= (r7.json?.byTool ?? []).length,
      { sum7: sum7.length, sum30: sum30.length });
    ok('G-02 recent 与 summary 同窗：days=7 时 recent 全部落在近 7 天，无「两口径同屏」',
      recent7.length > 0 && recent7.every((r) => r.created_at >= new Date(nowMs - 7 * 86400e3).toISOString()),
      { n: recent7.length });
  }
} finally {
  await new Promise<void>((resolveDone) => {
    const done = () => resolveDone();
    child.once('exit', done);
    child.kill();
    setTimeout(done, 4000);
  });
  console.log(`\n合计 PASS=${pass} FAIL=${fail}`);
  try { closeDb(); } catch { /* 已关闭 */ }
  try {
    rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    console.log(`  [WARN] 临时目录回收失败（不影响断言结论）：${String((e as Error)?.message).slice(0, 120)}`);
  }
}
process.exit(fail === 0 ? 0 : 1);
