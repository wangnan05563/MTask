/**
 * T02105 门：并发闸集成（PRD §3.5 FR-5 / §5 R6 / 技术方案 §2.3）。
 *
 * 断言：
 *   S 组 源码守卫：闸名收编为 REPORT_GATE 常量且两处同源引用（各写一遍字面量迟早被拆回两个闸）、
 *                  kickoff 端点 defer 在位、错误口径中文 429。
 *   E 组 隔离实例 + 本地慢 mock 实测并发：超限 429 且不建 SSE 流、闸位归还（跑完可用 / 断连可用）、
 *                  与周报 /report/generate **共用同一计数**（这才是 FR-5 的立论：各自一名＝合计 4 路大稿）、
 *                  上限经 app_settings 热可调（exportGateLimit.report-generate）。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02105-kickoff-gate.mts
 * 环境变量：`T02105_PORT`（默认随机 39900+rand200）。
 * 隔离纪律（skill 红线 8）：库副本/端口/临时目录全临时；设置项只写进副本库，不碰生产 app_settings；
 *   mock 不消耗真实配额。
 * 结果落 .workbuddy/t02105-gate-results-<运行标识>.txt（汇总行后紧跟归属行，口径见 scripts/lib/gate-results.mts）。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.T02105_PORT ?? 39_900 + Math.floor(Math.random() * 200));
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02105-gate-'));
const BASE = `http://127.0.0.1:${PORT}/api`;
const FIVE_PID = '95f31a46-92f6-4046-8cb6-ee3c4e228a44'; // mtask五期（资料齐备，能真装配）
const OUT_DIR = join(ROOT, '.workbuddy');
const OUT_BASE = 't02105-gate-results.txt';
const TMP_DIR = join(DATA_DIR, 'tmp');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const GATE_SRC = readFileSync(join(ROOT, 'server', 'src', 'util', 'export-gate.ts'), 'utf8');
const PLANS = readFileSync(join(ROOT, 'server', 'src', 'routes', 'plans.ts'), 'utf8');
const INDEX = readFileSync(join(ROOT, 'server', 'src', 'routes', 'index.ts'), 'utf8');
const kickCut = PLANS.indexOf("planApi.post('/kickoff-ppt-stream'");
const streamRoute = kickCut < 0 ? '' : PLANS.slice(kickCut, PLANS.indexOf('\nplanApi.', kickCut + 10));

// =====================================================================
// S 组：源码守卫
// =====================================================================
ok('S-01 共用闸名以常量单源定义（REPORT_GATE，值仍是 report-generate）',
  /export const REPORT_GATE = 'report-generate'/.test(GATE_SRC));
ok('S-02 启动会端点挂 REPORT_GATE（不再自取端点专名——两名＝两个上限＝违背 FR-5 立论）',
  /exportGate\(REPORT_GATE, undefined, \{ defer: true \}\)/.test(streamRoute) &&
    !/exportGate\('kickoff-ppt-stream'/.test(PLANS),
  streamRoute.slice(0, 120));
ok('S-03 周报四格式导出同引 REPORT_GATE（两处引用同一常量，不是两处字面量）',
  /exportGate\(REPORT_GATE\)/.test(INDEX) && !/exportGate\('report-generate'/.test(INDEX));
ok('S-04 defer 在位：SSE 头之前计数已加、处理器 await 时事件循环可让出后续请求抵达闸门',
  /defer: true/.test(streamRoute));
ok('S-05 拒绝口径沿用仓内既有中文 429（不新造错误形态）',
  /res\.status\(429\)\.json\(\{ error: '导出任务过多，请稍后再试' \}\)/.test(GATE_SRC));
ok('S-06 上限默认 2 且逐请求读 app_settings（低频重活，换来即时生效）',
  /EXPORT_GATE_LIMIT = 2/.test(GATE_SRC) && /getSetting\(`exportGateLimit\.\$\{name\}`\)/.test(GATE_SRC));
ok('S-07 计数在 finish 与 close 双向归还（异常/断连都不把闸门锁死）',
  /res\.once\('finish', release\)/.test(GATE_SRC) && /res\.once\('close', release\)/.test(GATE_SRC));

// =====================================================================
// mock：慢响应把闸位「占住」，并发窗口才测得出来
// =====================================================================
let mockDelayMs = 1_200;
const mock = createServer((req, res) => {
  let raw = '';
  req.on('data', (c: Buffer) => (raw += c.toString()));
  req.on('end', () => {
    // 一律回不合约束的空壳：措辞段失败会走 askJson 自带 1 次重试 → 单请求占用时间翻倍，
    // 并发窗口更稳；措辞失败只降级不影响出稿（T02103 已把那条路钉住）。
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { total_tokens: 1 } }));
    }, mockDelayMs);
  });
});
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
const MOCK_PORT = (mock.address() as { port: number }).port;

// =====================================================================
// E 组：隔离实例（副本库 + 副本库内改设置项，不碰生产）
// =====================================================================
const { resolveServerLauncher } = await import('./isolated-server-launcher.mts');
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const prodDb = join(process.env.APPDATA ?? '', 'MTask', 'data', 'mtask.db');
const copyPath = join(DATA_DIR, 'mtask.db');
{
  const Database = (await import('better-sqlite3')).default;
  const src = new Database(prodDb, { readonly: true });
  await src.backup(copyPath);
  src.close();
}
ok('E-00a 生产库只读副本已生成（设置项只写进副本）', existsSync(copyPath));

const child: ChildProcess = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT,
  env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog: string[] = [];
child.stdout?.on('data', (b: Buffer) => serverLog.push(b.toString()));
child.stderr?.on('data', (b: Buffer) => serverLog.push(b.toString()));

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
async function call(method: string, path: string, json?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, body, ctype: res.headers.get('content-type') ?? '', text };
}

/** 13 页大纲，其中一页带「风险」标题 → 措辞段必然发起（慢 mock 才能占住闸位） */
const SECTIONS = ['项目背景', '范围与目标', '里程碑', '组织架构', '风险与应对', '沟通机制'];
function outlineJson(pages = 13) {
  return Array.from({ length: pages }, (_, i) => ({
    section: SECTIONS[i % SECTIONS.length],
    title: i === 4 ? '风险清单与应对' : `启动会页 ${i + 1}`,
    bullets: ['范围与交付物', '责任分工'],
    dataKeys: i === 4 ? ['risks'] : ['preflight'],
    layout: i === 0 ? 'cover' : 'table',
  }));
}

interface Run {
  status: number;
  ctype: string;
  gotDone: boolean;
  stages: number;
  error?: string;
}
async function stream(json: unknown, opts: { abortAfterMs?: number } = {}): Promise<Run> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  if (opts.abortAfterMs) timer = setTimeout(() => ac.abort(), opts.abortAfterMs);
  let raw = '';
  let ctype = '';
  try {
    const res = await fetch(BASE + '/plans/kickoff-ppt-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(json),
      signal: ac.signal,
    });
    ctype = res.headers.get('content-type') ?? '';
    if (!ctype.includes('text/event-stream')) {
      const text = await res.text().catch(() => '');
      let errText = text;
      try { errText = String(JSON.parse(text).error ?? text); } catch { /* 原样 */ }
      return { status: res.status, ctype, gotDone: false, stages: 0, error: errText };
    }
    const reader = res.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += new TextDecoder().decode(value);
      }
    }
  } catch {
    return { status: 0, ctype: 'text/event-stream', gotDone: raw.includes('event: done'), stages: (raw.match(/event: stage/g) ?? []).length };
  } finally {
    if (timer) clearTimeout(timer);
  }
  return { status: 200, ctype, gotDone: raw.includes('event: done'), stages: (raw.match(/event: stage/g) ?? []).length };
}
const body = (toolId: string) => ({ projectId: FIVE_PID, toolId, outline: outlineJson(13) });
const countRejected = (runs: Run[]) => runs.filter((r) => r.status === 429).length;

if (!(await waitUp())) {
  ok('E-00 隔离实例启动', false, serverLog.join('').slice(-600));
} else {
  ok('E-00 隔离实例启动', true);
  const tool = await call('POST', '/aitools', {
    name: 't02105-slow', type: 'openai-compatible', endpoint: `http://127.0.0.1:${MOCK_PORT}`,
    apiKey: 'mock-key', model: 'mock-slow', timeoutMs: 30000,
  });
  const toolId = String(tool.body?.id ?? '');
  ok('E-00b 慢响应测试工具已建（占住闸位用，零真实配额）', !!toolId, tool.body?.error);

  // E-01 默认上限 2：4 路并发 → 2 路进 SSE、2 路 429
  const four = await Promise.all([stream(body(toolId)), stream(body(toolId)), stream(body(toolId)), stream(body(toolId))]);
  ok('E-01 4 路并发 → 恰好 2 路被接受（上限 2，超限拒绝而非排队）',
    four.filter((r) => r.status === 200 && r.gotDone).length === 2 && countRejected(four) === 2,
    four.map((r) => ({ s: r.status, done: r.gotDone })));
  ok('E-02 被拒的 2 路是结构化 429 且**没有**建成 SSE 流（前端可读文案重试，R6）',
    four.filter((r) => r.status === 429).every((r) => !r.ctype.includes('event-stream') && /导出任务过多/.test(r.error ?? '')),
    four.filter((r) => r.status === 429).map((r) => ({ ctype: r.ctype, error: r.error })));
  ok('E-03 被接受的两路各自完整出稿（闸不影响在途请求的产物）',
    four.filter((r) => r.status === 200).every((r) => r.gotDone && r.stages >= 13),
    four.filter((r) => r.status === 200).map((r) => ({ done: r.gotDone, stages: r.stages })));

  // E-04 闸位归还：上一批跑完后再来 2 路仍可用（计数泄漏会在这里现形）
  const again = await Promise.all([stream(body(toolId)), stream(body(toolId))]);
  ok('E-04 批次跑完后闸位归还（再发 2 路仍可接受，不锁死）',
    again.filter((r) => r.status === 200 && r.gotDone).length === 2, again.map((r) => r.status));

  // E-05 与周报共用同一计数：占住 2 路启动会时，无 AI 的 /report/generate 也应 429
  mockDelayMs = 3_000;
  const inflight = [stream(body(toolId)), stream(body(toolId))];
  await sleep(500);
  const weekly = await call('POST', '/report/generate', { period: 'week', format: 'pptx', projectId: FIVE_PID });
  ok('E-05 共用闸得证：启动会占满 2 路时，周报四格式导出被同一计数挡下（429）',
    weekly.status === 429 && /导出任务过多/.test(String(weekly.body?.error ?? '')),
    { status: weekly.status, error: weekly.body?.error });
  const drained = await Promise.all(inflight);
  ok('E-05b 在途两路仍在闸内跑完（拒绝只发生在新请求）',
    drained.filter((r) => r.status === 200 && r.gotDone).length === 2, drained.map((r) => ({ s: r.status, done: r.gotDone })));

  // E-06 断连归还：客户端断开后 close 触发 release，闸位不该被幽灵请求长期占住
  mockDelayMs = 4_000;
  const held = stream(body(toolId));            // 占 1 路（跑完自然释放）
  const aborted = stream(body(toolId), { abortAfterMs: 700 }); // 占 1 路后由客户端断开
  await sleep(1_800);
  const afterAbort = await call('POST', '/report/generate', { period: 'week', format: 'xlsx', projectId: FIVE_PID });
  ok('E-06 断连后闸位归还：仅剩 1 路在途时周报导出可进（幽灵占用会在此现形）',
    afterAbort.status === 200, { status: afterAbort.status, ctype: afterAbort.ctype.slice(0, 40) });
  await aborted;
  await held;

  // E-07 上限热可调：副本库写 exportGateLimit.report-generate=1 → 2 路并发只放 1 路
  {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(copyPath);
    db.prepare("insert into app_settings(key,value) values('exportGateLimit.report-generate','1') " +
      'on conflict(key) do update set value=excluded.value').run();
    db.close();
  }
  mockDelayMs = 2_500;
  await sleep(200); // 让上一批的计数彻底归零
  const tmpBefore = existsSync(TMP_DIR) ? readdirSync(TMP_DIR).length : 0;
  const pair = await Promise.all([stream(body(toolId)), stream(body(toolId))]);
  ok('E-07 上限经 app_settings 即时生效（report-generate=1 → 2 路并发只放 1 路，且闸名就是它）',
    pair.filter((r) => r.status === 200 && r.gotDone).length === 1 && countRejected(pair) === 1,
    pair.map((r) => ({ s: r.status, done: r.gotDone })));
  ok('E-07b 反向证明两处同闸：调低后**启动会**这一侧被限（若两处各自一名，改这个键不会有效果）',
    pair.some((r) => r.status === 429), pair.map((r) => r.status));
  const grew = (existsSync(TMP_DIR) ? readdirSync(TMP_DIR).length : 0) - tmpBefore;
  ok('E-08 被拒请求零落盘（tmp 只多出被接受那一路的产物，不产生孤儿令牌）',
    grew === 1, { grew, before: tmpBefore });

  mockDelayMs = 0;
}

child.kill();
// 隔离目录回收：Windows 上刚 kill 的子进程还压着 sqlite 句柄，直接 rm 会 EPERM
for (let i = 0; i < 25; i++) {
  try {
    rmSync(DATA_DIR, { recursive: true, force: true });
    break;
  } catch {
    if (i === 24) lines.push('[WARN] 临时目录未回收（子进程句柄未释放）：' + DATA_DIR);
    await sleep(200);
  }
}
mock.close();
lines.unshift(`T02105 并发闸门：PASS=${pass} FAIL=${fail}`);
writeGateResults(OUT_DIR, OUT_BASE, lines.join('\n'), { port: PORT, dataDir: DATA_DIR });
process.exit(fail === 0 ? 0 : 1);
