/**
 * T02308 回归门：/api/ai/usage 的 `recent` 必须随 days 窗口过滤、并按厂商采样去挤占。
 * 本文件为 T02293「按 `docs/验收门判据规约.md` 四条硬判据改判」版。
 *
 * 拦的缺陷（生产 39877 实测）：`recent` 原为无窗口 `ORDER BY created_at DESC LIMIT 30`——
 *   某厂商进入快速失败风暴（~340ms/次）时 30 行被同一厂商同一错误全部占满，另一厂商的逐行
 *   错误原文在面板里一行都看不到；且 days=1/7/30/limit=300 四次请求返回逐字节相同。
 *
 * 改判口径（本轮）：
 *  - 判据 1（打在行为上）：W/G 段全部断言打**隔离实例的 HTTP 响应体**（status/days/limit/perTool/
 *    recent 行集与 created_at 值），无一读产品源码文本；取证一律 `(await fetch).json()`。
 *  - 判据 2（门自造数据）：零生产库/生产实例接触——隔离端口 + 隔离 DATA_DIR，空库由产品
 *    initSchema 自建。风暴行/时旅行（1h/10d 前）是时间轴夹具，REST 通道造不出「过去」，按规约
 *    判据 2 的「夹具由门自己写入隔离库」通道写入；并新增 W-12 用**产品写钩子**（`POST /aitools`
 *    + `POST /aitools/:id/probe`，kind='probe' 由 ConfigService.recordProbeUsage 落库）真实写入
 *    一行，证明产品自己的写路径同样进得了 recent——门夹具不是库内唯一来源形态。
 *  - 判据 3：本门无产品源码文本锚（无需 okPair 降级项），如实记载。
 *  - 判据 4（负对照四条腿）：
 *      N-01 HEAD 副本 worktree 行为反证（双腿子跑）——把 `recent` 查询改回缺陷形态（无窗口
 *        `LIMIT 30`），并把**本门脚本本体投放进副本**（覆盖 HEAD 旧版；旧版硬编码 40 行风暴、
 *        无视 T02308_STORM，两腿会跑出逐字节相同的红项＝假牙齿）后整套重跑两次：STORM=25 盯窗口腿（W-02/W-04/
 *        W-07/G-02 必须转红），STORM=40 盯挤占腿（W-04/W-05/W-06/W-07/W-09 必须转红）——
 *        单一风暴规模罩不住两个失守面（40 行时 top30 全是 A，窗口外行根本进不了前 30），
 *        如实拆成两条腿。反例副本自证「篡改确实落了盘」（回读 sha256 变化 + `WITH ranked`
 *        锚消失 + LIMIT 30 新锚在场）。
 *      N-02 判据牙齿（证据副本复放）——同一判据函数喂「伪造进窗口外行的 recent」「剥掉 perTool
 *        字段的响应体」必须转假，喂原证据必须为真；副本与原件逐字节不同自证。
 *      N-03 主仓工作树零写入 sha256 自证。
 *  - 环境缺口记 `skipped()` 不计 PASS：隔离实例起不来 ⇒ S-00 记红 + 后续组全部 SKIP（诚实留痕，
 *    不以源码文本或旧 SQL 复放冒充行为 PASS）。
 *
 * 用法（Node 须与 better-sqlite3 ABI 对齐；见 isolated-server-launcher 探测）：
 *   TMP=/d/code/tmp TEMP=/d/code/tmp node node_modules/tsx/dist/cli.mjs scripts/verify-t02308-usage-window.mts
 * 环境变量：T02308_PORT（默认 39938，被占用时自动向后扫 40 格——并发会话常留隔离实例，撞端口
 *   等于对着别人的服务取证）、T02308_TMP_ROOT（默认 D:/code/tmp，勿指 C:——常年 0 可用会
 *   SQLITE_FULL 假性失败）、T02308_STORM（风暴夹具行数，默认 40）、T02308_SKIP_NEG=1
 *   （供 N-01 副本子跑跳过负对照段，防递归）。
 * 结果落 .workbuddy/t02308-usage-window-gate-results-<运行标识>.txt。
 * 隔离纪律（skill 红线 8）：夹具写进 mkdtemp 的临时库，另起隔离实例（独立端口 + MTask_DATA_DIR），
 *   不连生产 39877、不碰生产数据目录；跑完 kill 实例 + 回收目录。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, existsSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveServerLauncher } from './isolated-server-launcher.mts';
import { writeGateResults } from './lib/gate-results.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP_ROOT = process.env.T02308_TMP_ROOT || 'D:/code/tmp';
mkdirSync(TMP_ROOT, { recursive: true });
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't02308-usage-'));
process.env.MTask_DATA_DIR = DATA_DIR;
const BASE_PORT = Number(process.env.T02308_PORT ?? 39938);

const { getDb, closeDb } = await import('../server/src/db/connection.ts');
const { initSchema } = await import('../server/src/db/schema.ts');
initSchema();

const TAG = 'T02308门';
const STORM = Number(process.env.T02308_STORM ?? 40); // 风暴行数：主跑 40；负对照子跑用 25（见 N-01 双反证说明）
const TA = `${TAG}-A`;   // 失败风暴厂商：近 45 秒内 STORM 条
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
  for (let i = 0; i < STORM; i++) ins.run(`${TA}-${i}`, null, TA, 'mock-mini', '免费用户限流：rate limit exceeded', ago(5 + i));
  ins.run(`${TB}-0`, null, TB, 'mock-mini', 'Insufficient user quota', ago(3600));
  ins.run(`${TC}-0`, null, TC, 'mock-mini', 'window-outside-fixture', ago(10 * 86400));
}

let pass = 0;
let fail = 0;
const lines: string[] = [];
const skippedList: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  const line = `  [${cond ? 'PASS' : 'FAIL'}] ${name}${extra !== undefined ? ` → ${JSON.stringify(extra).slice(0, 300)}` : ''}`;
  lines.push(line.trim());
  if (cond) pass += 1; else fail += 1;
  console.log(line);
};
const skipped = (range: string, why: string) => {
  skippedList.push(`${range}：${why}`);
  lines.push(`[SKIP] ${range} —— ${why}（不计 PASS）`);
};

/** 端口避让（t02320 同口径）：撞端口＝对着并发会话留存的实例取证，判据全失真 */
async function pickPort(base: number): Promise<number> {
  for (let p = base; p < base + 40; p++) {
    const occupied = await fetch(`http://127.0.0.1:${p}/api/health`).then(() => true).catch(() => false);
    if (!occupied) return p;
  }
  throw new Error(`端口 ${base}~${base + 39} 全被占用，放弃（避免对其他实例取证）`);
}

const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
let PORT = 0;
let BASE = '';
let child: ChildProcess | null = null;
const serverLog: string[] = [];

async function startInstance(): Promise<boolean> {
  PORT = await pickPort(BASE_PORT);
  BASE = `http://127.0.0.1:${PORT}`;
  child = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
    cwd: ROOT,
    env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR, MTask_LOG_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (b: Buffer) => serverLog.push(b.toString()));
  child.stderr?.on('data', (b: Buffer) => serverLog.push(b.toString()));
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
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
// 判据抽成纯函数（判据 4「同一判据」在原件/证据副本两侧复放的前提）
const judgeWindow7 = (recent: any[]) =>
  !toolsOf(recent).has(TC) && recent.every((r) => r.created_at >= new Date(nowMs - 7 * 86400e3).toISOString());
const judgeEcho = (j: Record<string, any> | null, status: number) =>
  status === 200 && j?.days === 7 && Number(j?.limit) > 0 && Number(j?.perTool) > 0;

// mock AI 厂商：W-12 走产品真实写钩子（probe）需要一根能实调成功的端点，零真实配额
const mock = createServer((req, res) => {
  let raw = '';
  req.on('data', (c: Buffer) => (raw += c.toString()));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { total_tokens: 1 } }));
  });
});
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
const MOCK_PORT = (mock.address() as { port: number }).port;

try {
  if (!(await startInstance())) {
    ok('S-00 隔离实例就绪', false, { log: serverLog.slice(-10).join('\n').slice(0, 500) });
    skipped('W/G/W-12 全部行为判据', '隔离实例未启动，HTTP 响应体取证无法进行（不以源码文本或旧 SQL 复放冒充 PASS）');
  } else {
    console.log(`\n== W 段：recent 窗口与采样口径（端口 ${PORT}）==`);
    const r7 = await usage('?days=7');
    const recent7: any[] = r7.json?.recent ?? [];
    ok('W-01 接口回传口径字段（days/limit/perTool 随响应）', judgeEcho(r7.json, r7.status),
      { status: r7.status, days: r7.json?.days, limit: r7.json?.limit, perTool: r7.json?.perTool });
    ok('W-02 recent 不再无窗口：days=7 时窗口外厂商 C 的行不出现', judgeWindow7(recent7),
      { n: recent7.length, tools: [...toolsOf(recent7)] });

    const r30 = await usage('?days=30');
    const recent30: any[] = r30.json?.recent ?? [];
    ok('W-03 窗口参数生效可区分：days=30 时 C 的行出现（days=1/7/30 不再逐字节相同）',
      toolsOf(recent30).has(TC), { n: recent30.length, tools: [...toolsOf(recent30)] });
    const diff = await Promise.all(['?days=1', '?days=7', '?days=30'].map(async (q) => JSON.stringify((await usage(q)).json?.recent)));
    ok('W-04 窗口对 recent 真有影响（days=7 与 days=30 结果不再逐字节相同）',
      diff[1] !== diff[2], { sizes: diff.map((d) => d.length) });

    ok(`W-05 本单复现用例：风暴厂商 A 连续 ${STORM} 条失败时，厂商 B 的最近一条仍在 recent 中`,
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
      perTool > 0 && countOf(recent30, TA) <= perTool && recent30.length < STORM,
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

    console.log('\n== H 段：产品写钩子真实落行（判据 2：夹具不是库内唯一来源形态）==');
    const PROBE_TOOL = `t02308-probe-${process.pid}`;
    const tool = await (await fetch(`${BASE}/api/aitools`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: PROBE_TOOL, type: 'openai-compatible', endpoint: `http://127.0.0.1:${MOCK_PORT}`, apiKey: 'mock-key', model: 'mock-probe', timeoutMs: 15_000 }),
    })).json().catch(() => null) as Record<string, any> | null;
    const probeResp = await fetch(`${BASE}/api/aitools/${tool?.id}/probe`, { method: 'POST' });
    const r1 = await usage('?days=1');
    const recent1: any[] = r1.json?.recent ?? [];
    const probeRow = recent1.find((x) => x.tool_name === PROBE_TOOL && x.kind === 'probe');
    ok('W-12 经产品接口真写的一行（POST /aitools + POST /aitools/:id/probe，kind=probe）出现在 recent：'
      + '窗口口径对真实写路径同样生效，门夹具 INSERT 不是唯一来源形态',
      probeResp.status === 200 && !!probeRow && typeof probeRow.created_at === 'string',
      { probeStatus: probeResp.status, hit: probeRow ? { kind: probeRow.kind, tool: probeRow.tool_name } : null });

    console.log('\n== G 段：同窗口径回归护栏 ==');
    const sum7: any[] = r7.json?.summary ?? [];
    const sum30: any[] = r30.json?.summary ?? [];
    ok('G-01 summary/byTool 仍带窗口（days 放大后聚合天数不减）',
      sum30.length >= sum7.length && (r30.json?.byTool ?? []).length >= (r7.json?.byTool ?? []).length,
      { sum7: sum7.length, sum30: sum30.length });
    ok('G-02 recent 与 summary 同窗：days=7 时 recent 全部落在近 7 天，无「两口径同屏」',
      recent7.length > 0 && judgeWindow7(recent7), { n: recent7.length });

    // ---------------- N 组：负对照（判据 4） ----------------
    if (process.env.T02308_SKIP_NEG === '1') {
      skipped('N 组', '本子跑是 N-01 行为反证的副本执行（SKIP_NEG=1），负对照只在主跑做，避免递归');
    } else {
      console.log('\n== N 组：负对照（HEAD 副本行为反证 + 证据副本牙齿复放）==');
      const shaOf = (buf: string | Uint8Array) => createHash('sha256').update(buf).digest('hex');

      // N-02 证据副本牙齿复放：同一判据喂伪造证据必须转假（且副本确与原件不同）
      {
        const forgedRecent = [...recent7, { tool_name: TC, created_at: ago(10 * 86400), kind: 'classify' }];
        const copyDiff = JSON.stringify(forgedRecent) !== JSON.stringify(recent7);
        const strippedBody = { ...(r7.json ?? {}), perTool: undefined };
        ok('N-02a W-02 判据有牙：窗口判据喂「混进窗口外厂商行」的 recent 副本必须转假（原证据为真、副本确与原件不同）',
          judgeWindow7(recent7) === true && judgeWindow7(forgedRecent) === false && copyDiff, { copyDiff });
        ok('N-02b W-01 判据有牙：口径回传判据喂「剥掉 perTool 字段」的响应体副本必须转假（不是 status==200 就绿）',
          judgeEcho(r7.json, r7.status) === true && judgeEcho(strippedBody, r7.status) === false
          && JSON.stringify(strippedBody) !== JSON.stringify(r7.json));
      }

      // N-01 HEAD 副本 worktree 行为反证（双腿）：recent 退回「无窗口 LIMIT 30」缺陷形态。
      //   单一样本量罩不住两个失守面——风暴 40 行时 top30 全被 A 占据，窗口外 C 行根本进不了
      //   前 30（W-02/G-02 无从转红）；风暴 25 行时 top30 溢出到 B/C（挤占面 W-05/W-06 反而不红）。
      //   故同一缺陷形态跑两次子门：STORM=25 盯**窗口腿**，STORM=40 盯**挤占腿**。
      const { execFileSync } = await import('node:child_process');
      const NEG_ROOT = join(TMP_ROOT, `t02308-negwt-${process.pid}`);
      const REL = join('server', 'src', 'routes', 'index.ts');
      const mainShaBefore = shaOf(readFileSync(join(ROOT, REL)));
      let negReady = false;
      try {
        if (existsSync(NEG_ROOT)) rmSync(NEG_ROOT, { recursive: true, force: true });
        execFileSync('git', ['worktree', 'add', '--detach', NEG_ROOT, 'HEAD'], { cwd: ROOT, stdio: 'pipe', timeout: 180_000 });
        symlinkSync(join(ROOT, 'node_modules'), join(NEG_ROOT, 'node_modules'), 'junction');
        // 把本体门脚本投放进副本覆盖 HEAD 旧版：负对照子跑必须跑「同一支门」（含 T02308_STORM
        // 参数与 SKIP_NEG 防递归守卫）。HEAD 旧版硬编码 40 行风暴、无视 STORM——窗口腿会拿着
        // 挤占腿的判据空转，反证只剩名分没有牙齿（实测两腿红项逐字节相同即此病灶）。
        const SELF = fileURLToPath(import.meta.url);
        writeFileSync(join(NEG_ROOT, 'scripts', 'verify-t02308-usage-window.mts'), readFileSync(SELF));
        negReady = existsSync(join(NEG_ROOT, REL)) && existsSync(join(NEG_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'))
          && shaOf(readFileSync(join(NEG_ROOT, 'scripts', 'verify-t02308-usage-window.mts'))) === shaOf(readFileSync(SELF));
      } catch { negReady = false; }
      ok('N-00 负对照工作区就绪：HEAD 的 detached worktree 副本 + node_modules junction（主仓工作树全程只读）',
        negReady, { NEG_ROOT });
      if (negReady) {
        const p = join(NEG_ROOT, REL);
        const before = readFileSync(p, 'utf8');
        const m = /const recent = db\.prepare\(\s*`WITH[\s\S]*?\.all\(since, perTool, limit\);/.exec(before);
        let landed = false;
        if (m) {
          writeFileSync(p, before.slice(0, m.index)
            + 'const recent = db.prepare(`SELECT tool_name, model, kind, ok, duration_ms, content_chars, error, created_at FROM ai_usage ORDER BY created_at DESC LIMIT 30`).all();'
            + before.slice(m.index + m[0].length));
          const back = readFileSync(p, 'utf8');
          landed = shaOf(back) !== shaOf(before) && /ORDER BY created_at DESC LIMIT 30`\)\.all\(\);/.test(back) && !/WITH ranked/.test(back);
        }
        ok('N-01a 篡改确实落了盘：副本 recent 查询退回缺陷形态（回读 sha256 变化、旧 CTE 锚消失、LIMIT 30 新锚在场）',
          landed, { 锚命中: !!m });
        const runNegChild = (storm: number, portBase: number) => {
          const child2 = spawnSync(LAUNCHER.exec,
            [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(NEG_ROOT, 'scripts', 'verify-t02308-usage-window.mts')],
            {
              cwd: NEG_ROOT,
              env: { ...process.env, ...LAUNCHER.env, T02308_SKIP_NEG: '1', T02308_STORM: String(storm), T02308_PORT: String(portBase), TMP: TMP_ROOT, TEMP: TMP_ROOT, TMPDIR: TMP_ROOT },
              encoding: 'utf8', timeout: 300_000,
            });
          const out = `${child2.stdout ?? ''}${child2.stderr ?? ''}`;
          const reds = new Set([...out.matchAll(/^\s*\[FAIL\] ([WG]-\d+)/gm)].map((x) => x[1]));
          return { out, reds };
        };
        // 窗口腿：STORM=25 ⇒ 缺陷形态 days=7 也吐出 10 天前的 C 行
        {
          const { out, reds } = runNegChild(25, PORT + 50);
          const want = ['W-02', 'W-04', 'W-07', 'G-02'];
          const missing = want.filter((id) => !reds.has(id));
          ok('N-01b 行为反证（窗口腿）：STORM=25 副本子跑中，W-02/W-04/W-07/G-02 全部转红——窗口判据在缺陷形态下真的有牙',
            landed && missing.length === 0, { 红项: [...reds], 缺: missing, tail: out.slice(-260) });
        }
        // 挤占腿：STORM=40 ⇒ 缺陷形态 30 行全被 A 占据，B 的原文一行看不到（生产缺陷原样复现）
        {
          const { out, reds } = runNegChild(40, PORT + 90);
          const want = ['W-04', 'W-05', 'W-06', 'W-07', 'W-09'];
          const missing = want.filter((id) => !reds.has(id));
          ok('N-01c 行为反证（挤占腿）：STORM=40 副本子跑中，W-04/W-05/W-06/W-07/W-09 全部转红——B 行被风暴挤出、limit 参数失效当场现形',
            landed && missing.length === 0, { 红项: [...reds], 缺: missing, tail: out.slice(-260) });
          ok('N-01d 反证没有把整门跑崩（子跑完整执行到 G 段汇总，红是行为失守不是崩溃）',
            /合计 PASS=\d+ FAIL=\d+/.test(out) && reds.size >= want.length - missing.length, { tail: out.slice(-160) });
        }
        try { rmSync(join(NEG_ROOT, 'node_modules'), { recursive: true, force: true }); } catch { /* 未建成 */ }
        try { execFileSync('git', ['worktree', 'remove', '--force', NEG_ROOT], { cwd: ROOT, stdio: 'ignore', timeout: 180_000 }); }
        catch { rmSync(NEG_ROOT, { recursive: true, force: true }); }
        try { execFileSync('git', ['worktree', 'prune'], { cwd: ROOT, stdio: 'ignore', timeout: 60_000 }); } catch { /* 尽力 */ }
      } else {
        ok('N-01a 篡改确实落了盘：副本 recent 查询退回缺陷形态（回读 sha256 变化、旧 CTE 锚消失、LIMIT 30 新锚在场）', false, '负对照工作区未建成');
        ok('N-01b 行为反证（窗口腿）：STORM=25 副本子跑中，W-02/W-04/W-07/G-02 全部转红——窗口判据在缺陷形态下真的有牙', false, '负对照工作区未建成');
        ok('N-01c 行为反证（挤占腿）：STORM=40 副本子跑中，W-04/W-05/W-06/W-07/W-09 全部转红——B 行被风暴挤出、limit 参数失效当场现形', false, '负对照工作区未建成');
        ok('N-01d 反证没有把整门跑崩（子跑完整执行到 G 段汇总，红是行为失守不是崩溃）', false, '负对照工作区未建成');
      }
      ok('N-03 主仓工作树零写入自证：负对照全程后 routes/index.ts 的 sha256 与开跑前一致',
        shaOf(readFileSync(join(ROOT, REL))) === mainShaBefore, { before: mainShaBefore.slice(0, 16) });
    }
  }
} finally {
  const done = new Promise<void>((resolveDone) => {
    if (!child) return resolveDone();
    child.once('exit', () => resolveDone());
    child.kill();
    setTimeout(() => resolveDone(), 6_000);
  });
  await done;
  mock.closeAllConnections();
  await new Promise<void>((r) => mock.close(() => r()));
  try { closeDb(); } catch { /* 已关闭 */ }
  console.log(`\n合计 PASS=${pass} FAIL=${fail}${skippedList.length ? ` SKIP=${skippedList.length}` : ''}`);
  lines.unshift(`PASS=${pass} FAIL=${fail}${skippedList.length ? ` SKIP=${skippedList.length}` : ''}`);
  const resultsFile = writeGateResults(join(ROOT, '.workbuddy'), 't02308-usage-window-gate-results.txt',
    lines.join('\n') + (skippedList.length ? `\n跳过项：\n${skippedList.join('\n')}\n` : ''), { port: PORT, dataDir: DATA_DIR });
  console.log(`结果文件：${resultsFile}`);
  try {
    rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    console.log(`  [WARN] 临时目录回收失败（不影响断言结论）：${String((e as Error)?.message).slice(0, 120)}`);
  }
}
process.exitCode = fail === 0 ? 0 : 1;
