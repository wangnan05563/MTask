/**
 * T02105 门：并发闸集成（PRD §3.5 FR-5 / §5 R6 / 技术方案 §2.3）。
 * 本文件为 T02293「按 `docs/验收门判据规约.md` 四条硬判据改判」版。
 *
 * 改判前的问题（S-01~S-07）：判据打在源码文本上——`/export const REPORT_GATE = 'report-generate'/.test(源码)`、
 * `/exportGate\(REPORT_GATE, undefined, \{ defer: true \}\)/.test(路由段)`、`/res\.status\(429\)\.json\(\{ error: '导出任务过多，请稍后再试' \}\)/.test(源码)`、
 * `/EXPORT_GATE_LIMIT = 2/.test(源码)`、`/res\.once\('finish', release\)/.test(源码)` 等，等价重构一改写法门即恒红，
 * 而「两处是否真的共用同一计数」「断连是否真的归还闸位」这些真风险看不见。改判为：
 *
 *  H 组 门进程直调产品 `exportGate` 中间件（fake req/res + `gateSnapshot` 实测进行中计数）——
 *       上限默认 2、超限结构化 429 且 `error` 非空中文、finish/close 双向归还、defer 让 next 异步、
 *       逐请求读 app_settings、同名即同计数。全是**返回值与内存态**，与源码文本无关。
 *  E 组 隔离实例 + 本地慢 mock 真并发：超限 429 不建 SSE、闸位归还、启动会与周报**跨端点共用同一计数**
 *       （这才是 FR-5 立论的行为证据）、上限经 app_settings 热可调、被拒零落盘。夹具经
 *       `POST /projects` + `POST /plans/prd-requirements` 真建，不再依赖生产项目 FIVE_PID 那一行。
 *  S 组 路由接线字面锚（`okPair`）：kickoff 与周报确实挂 REPORT_GATE——只在 H/E 行为侧为绿时参与判绿。
 *  N 组 负对照：换不同闸名不互相顶、把 next 同步调用冒充 defer、把 error 换成空/英文、剥掉源码里的
 *       REPORT_GATE import——逐条证明 H/E/S 判据在行为被破坏时确实变红（判据 4）。
 *
 * 判据口径：产品代码字面锚一律取 `git show HEAD:<path>`（工作树可能躺着并发 WIP，反模式 11）；
 * 门夹具自造（隔离 DATA_DIR + 空库经产品 initSchema 自建 + 门内真建项目/需求），生产实例与生产库零接触。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02105-kickoff-gate.mts
 * 环境变量：`T02105_PORT`（默认随机 39900+rand200，被占用时改传）、`T02105_TMP_ROOT`（默认 D:/code/tmp，必须落可写盘）。
 * 结果落 .workbuddy/t02105-gate-results-<运行标识>.txt（口径见 scripts/lib/gate-results.mts）。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';
import { okPair } from './lib/anchor-pair.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.T02105_PORT ?? 39_900 + Math.floor(Math.random() * 200));
const BASE = `http://127.0.0.1:${PORT}/api`;
const OUT_DIR = join(ROOT, '.workbuddy');
const OUT_BASE = 't02105-gate-results.txt';

// 临时根落 D:（本机 C: 常年 0 可用，指过去会假性 SQLITE_FULL 把绿判成红）——定完数据目录再 import 产品模块
const TMP_ROOT = process.env.T02105_TMP_ROOT ?? 'D:/code/tmp';
mkdirSync(TMP_ROOT, { recursive: true });
process.env.TMP = TMP_ROOT;
process.env.TEMP = TMP_ROOT;
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't02105-gate-'));
process.env.MTask_DATA_DIR = DATA_DIR; // ⚠ 先定隔离库：门进程直调 exportGate→getSetting→getDb 都指到这里，绝不连生产库
const TMP_DIR = join(DATA_DIR, 'tmp');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const skippedList: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};
const skipped = (range: string, why: string) => {
  skippedList.push(`${range}：${why}`);
  lines.push(`[SKIP] ${range} —— ${why}（不计 PASS）`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 字面锚一律读**已提交树**（plans.ts/index.ts 工作树可能是并发 WIP，反模式 11） */
const gitCache = new Map<string, string | null>();
function headSource(rel: string): string | null {
  if (gitCache.has(rel)) return gitCache.get(rel);
  let out: string | null = null;
  try { out = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8' }); }
  catch { out = null; }
  gitCache.set(rel, out);
  return out;
}

// =====================================================================
// H 组：门进程直调产品 `exportGate` 中间件（返回值 + gateSnapshot 内存态即判据）
// =====================================================================
const EG = await import('../server/src/util/export-gate.ts') as Record<string, any>;
const AS = await import('../server/src/services/AppSettings.ts') as Record<string, any>;
const CN = (await import('../server/src/db/schema.ts')) as Record<string, any>;
const DB = (await import('../server/src/db/connection.ts')) as Record<string, any>;
CN.initSchema(); // 产品自建隔离库（含 app_settings 表），门不复制生产库
const { exportGate, gateSnapshot, EXPORT_GATE_LIMIT, REPORT_GATE } = EG;

/** fake Express res：status()/json() 记账，once('finish'/'close') 走 EventEmitter——足以驱动中间件 */
function fakeRes(): any {
  const r: any = new EventEmitter();
  r.statusCode = 0;
  r.body = undefined;
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (o: unknown) => { r.body = o; return r; };
  return r;
}
/** 触发一次闸请求：返回是否放行（next 被调）+ 拒绝时的 status/body */
function hitGate(mw: (req: any, res: any, next: any) => void) {
  const res = fakeRes();
  let nextCount = 0;
  mw({} as any, res, () => { nextCount += 1; });
  return { res, get admitted() { return nextCount > 0; }, rejected: res.statusCode === 429, status: res.statusCode, body: res.body, nextCount };
}
const rejectJudge = (h: ReturnType<typeof hitGate>) => h.rejected && typeof h.body?.error === 'string' && h.body.error.length > 0 && /[\u4e00-\u9fa5]/.test(h.body.error);
let uid = 0;
const uniq = (p: string) => `${p}-${process.pid}-${uid++}`;

{
  ok('H-00 产品 exportGate/gateSnapshot/REPORT_GATE 运行期可取（门进程直调，不重抄源码）',
    typeof exportGate === 'function' && typeof gateSnapshot === 'function' && typeof REPORT_GATE === 'string' && REPORT_GATE.length > 0,
    { REPORT_GATE, EXPORT_GATE_LIMIT });

  ok('H-01 默认上限就是 2（读运行期常量值，而非源码文本）', EXPORT_GATE_LIMIT === 2, EXPORT_GATE_LIMIT);

  // 上限 2：前 2 路放行、第 3 路结构化拒绝
  {
    const name = uniq('h-limit');
    const mw = exportGate(name);
    const a = hitGate(mw), b = hitGate(mw), c = hitGate(mw);
    ok('H-02 同一闸前 2 路放行、第 3 路拒绝（超限拒绝而非排队），进行中计数恰为 2',
      a.admitted && b.admitted && c.rejected && (gateSnapshot() as Record<string, number>)[name] === 2,
      { a: a.status, b: b.status, c: c.status, snapshot: gateSnapshot() });
    ok('H-03 超限返回 429 且 error 字段非空含中文（结构化可读文案，R6）', rejectJudge(c),
      { status: c.status, body: c.body });
    a.res.emit('finish'); b.res.emit('finish'); // 归还，别污染后续
  }

  // finish 归还
  {
    const name = uniq('h-finish');
    const mw = exportGate(name, 1);
    const a = hitGate(mw);
    const held = (gateSnapshot() as Record<string, number>)[name] === 1;
    a.res.emit('finish');
    ok('H-04 res 触发 finish 后进行中计数归还（跑完可用）',
      held && !((gateSnapshot() as Record<string, number>)[name] > 0), { 占位时: held, 归还后: gateSnapshot()[name] ?? 0 });
  }
  // close（断连）归还
  {
    const name = uniq('h-close');
    const mw = exportGate(name, 1);
    const a = hitGate(mw);
    const held = (gateSnapshot() as Record<string, number>)[name] === 1;
    a.res.emit('close');
    ok('H-05 res 触发 close（客户端提前断开）后进行中计数归还（异常/断连不锁死闸门）',
      held && !((gateSnapshot() as Record<string, number>)[name] > 0), { 占位时: held, 归还后: gateSnapshot()[name] ?? 0 });
  }
  // defer：next 异步；非 defer：next 同步
  {
    const name = uniq('h-defer');
    const deferred = exportGate(name, 5, { defer: true });
    const res = fakeRes();
    let calledSync = false;
    deferred({} as any, res, () => { calledSync = true; });
    const syncDuringCall = calledSync; // defer=true 时，中间件返回的那一刻 next 还没被调
    res.emit('finish');
    const nameN = uniq('h-nodefer');
    const plain = exportGate(nameN, 5); // 默认非 defer
    let calledSync2 = false;
    plain({} as any, fakeRes(), () => { calledSync2 = true; });
    ok('H-06 defer=true 令 next 推迟到 setImmediate（同步检查那刻未放行，事件循环得以先收下后续请求），非 defer 立即放行',
      syncDuringCall === false && calledSync2 === true, { defer同步放行: syncDuringCall, 非defer同步放行: calledSync2 });
  }
  // 逐请求读 app_settings
  {
    const name = uniq('h-setting');
    AS.setSetting(`exportGateLimit.${name}`, '1');
    const mw = exportGate(name); // 仍传默认上限 2，但 app_settings 说 1
    const a = hitGate(mw), b = hitGate(mw);
    ok('H-07 上限逐请求读 app_settings（exportGateLimit.<name>=1 → 同闸第 2 路即拒，无需改码重启）',
      a.admitted && b.rejected, { a: a.status, b: b.status });
    a.res.emit('finish');
  }
  // 同名即同计数
  {
    const name = uniq('h-shared');
    const mwA = exportGate(name, 2);
    const mwB = exportGate(name, 2); // 「另一处端点」用同一个闸名
    const a1 = hitGate(mwA), b1 = hitGate(mwB), b2 = hitGate(mwB);
    ok('H-08 两处中间件同闸名 → 共用同一计数（A 占 1、B 占 1、再来第 3 路拒；各自一名则不会互顶）',
      a1.admitted && b1.admitted && b2.rejected && (gateSnapshot() as Record<string, number>)[name] === 2,
      { snapshot: gateSnapshot()[name] });
    a1.res.emit('finish'); b1.res.emit('finish');
  }
}

// =====================================================================
// mock：慢响应把闸位「占住」，跨端点并发窗口才测得出来
// =====================================================================
let mockDelayMs = 1_200;
const mock = createServer((req, res) => {
  let raw = '';
  req.on('data', (c: Buffer) => (raw += c.toString()));
  req.on('end', () => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { total_tokens: 1 } }));
    }, mockDelayMs);
  });
});
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
const MOCK_PORT = (mock.address() as { port: number }).port;

// =====================================================================
// E 组：隔离实例（空库经产品 initSchema 自建 + 门内真建夹具，不碰生产）
// =====================================================================
const { resolveServerLauncher } = await import('./isolated-server-launcher.mts');
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
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
    method, headers: { 'Content-Type': 'application/json' },
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
interface Run { status: number; ctype: string; gotDone: boolean; stages: number; error?: string; }
async function stream(json: unknown, opts: { abortAfterMs?: number } = {}): Promise<Run> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  if (opts.abortAfterMs) timer = setTimeout(() => ac.abort(), opts.abortAfterMs);
  let raw = '';
  let ctype = '';
  try {
    const res = await fetch(BASE + '/plans/kickoff-ppt-stream', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json), signal: ac.signal,
    });
    ctype = res.headers.get('content-type') ?? '';
    if (!ctype.includes('text/event-stream')) {
      const text = await res.text().catch(() => '');
      let errText = text;
      try { errText = String(JSON.parse(text).error ?? text); } catch { /* 原样 */ }
      return { status: res.status, ctype, gotDone: false, stages: 0, error: errText };
    }
    const reader = res.body?.getReader();
    if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; raw += new TextDecoder().decode(value); }
  } catch {
    return { status: 0, ctype: 'text/event-stream', gotDone: raw.includes('event: done'), stages: (raw.match(/event: stage/g) ?? []).length };
  } finally {
    if (timer) clearTimeout(timer);
  }
  return { status: 200, ctype, gotDone: raw.includes('event: done'), stages: (raw.match(/event: stage/g) ?? []).length };
}
const countRejected = (runs: Run[]) => runs.filter((r) => r.status === 429).length;

if (!(await waitUp())) {
  ok('E-00 隔离实例启动', false, serverLog.join('').slice(-600));
  skipped('E/S/N 其余组', '隔离实例未启动，跨端点共用计数的行为判据无法取数（不以源码文本冒充 PASS）');
} else {
  ok('E-00 隔离实例启动', true);

  // 门内真建夹具项目 + 3 条需求（让预检 P2 过关＝不被 guardKickoffBlocked 拦下），不再依赖生产 FIVE_PID 那一行
  const proj = await call('POST', '/projects', { name: `T02105 夹具项目 ${Date.now()}` });
  const FIVE_PID = String(proj.body?.id ?? '');
  const reqs = await Promise.all([1, 2, 3].map((i) => call('POST', '/plans/prd-requirements', { projectId: FIVE_PID, title: `夹具需求 ${i}` })));
  const preflight = await call('GET', `/plans/kickoff-preflight?projectId=${FIVE_PID}`);
  ok('E-00a 门内经 POST /projects + POST /prd-requirements 真建夹具项目，预检不被「资料不足」拦下（判据 2：门自造数据）',
    proj.status === 201 && FIVE_PID.length > 0 && reqs.every((r) => r.status === 200) && preflight.body?.blocked === false,
    { projStatus: proj.status, reqStatuses: reqs.map((r) => r.status), blocked: preflight.body?.blocked, missingHard: preflight.body?.missingHard });

  // 分母腿：kickoff-ppt-stream 路由确实注册（缺 projectId → 处理器回 400，而非未注册时的 404）——
  // 没有这条，「E-05 的 429」可能是「路由根本不存在」造成的假绿
  const denom = await call('POST', '/plans/kickoff-ppt-stream', { projectId: '', toolId: '' });
  ok('E-00c 分母腿：kickoff-ppt-stream 路由已注册（空 body 命中处理器回 400，不是 404 未注册）',
    denom.status === 400, { status: denom.status });

  const tool = await call('POST', '/aitools', {
    name: 't02105-slow', type: 'openai-compatible', endpoint: `http://127.0.0.1:${MOCK_PORT}`,
    apiKey: 'mock-key', model: 'mock-slow', timeoutMs: 30000,
  });
  const toolId = String(tool.body?.id ?? '');
  ok('E-00b 慢响应测试工具已建（占住闸位用，零真实配额）', !!toolId, tool.body?.error);

  const body = (tid: string) => ({ projectId: FIVE_PID, toolId: tid, outline: outlineJson(13) });

  // E-01~E-03 默认上限 2：4 路并发 → 2 路进 SSE、2 路 429
  const four = await Promise.all([stream(body(toolId)), stream(body(toolId)), stream(body(toolId)), stream(body(toolId))]);
  ok('E-01 4 路并发 → 恰好 2 路被接受（上限 2，超限拒绝而非排队）',
    four.filter((r) => r.status === 200 && r.gotDone).length === 2 && countRejected(four) === 2,
    four.map((r) => ({ s: r.status, done: r.gotDone })));
  ok('E-02 被拒的 2 路是结构化 429 且**没有**建成 SSE 流（前端可读文案重试，R6）',
    four.filter((r) => r.status === 429).every((r) => !r.ctype.includes('event-stream') && typeof r.error === 'string' && r.error.length > 0),
    four.filter((r) => r.status === 429).map((r) => ({ ctype: r.ctype, error: r.error })));
  ok('E-03 被接受的两路各自完整出稿（闸不影响在途请求的产物）',
    four.filter((r) => r.status === 200).every((r) => r.gotDone && r.stages >= 13),
    four.filter((r) => r.status === 200).map((r) => ({ done: r.gotDone, stages: r.stages })));

  // E-04 闸位归还：上一批跑完后再来 2 路仍可用（计数泄漏会在这里现形）
  const again = await Promise.all([stream(body(toolId)), stream(body(toolId))]);
  ok('E-04 批次跑完后闸位归还（再发 2 路仍可接受，不锁死）',
    again.filter((r) => r.status === 200 && r.gotDone).length === 2, again.map((r) => r.status));

  // E-05 跨端点共用同一计数：占住 2 路启动会时，无 AI 的 /report/generate 也应 429（这才是 FR-5 立论）
  mockDelayMs = 3_000;
  const inflight = [stream(body(toolId)), stream(body(toolId))];
  await sleep(500);
  const weekly = await call('POST', '/report/generate', { period: 'week', format: 'pptx', projectId: FIVE_PID });
  ok('E-05 共用闸得证：启动会占满 2 路时，周报四格式导出被同一计数挡下（429）',
    weekly.status === 429 && typeof weekly.body?.error === 'string' && weekly.body.error.length > 0,
    { status: weekly.status, error: weekly.body?.error });
  const drained = await Promise.all(inflight);
  ok('E-05b 在途两路仍在闸内跑完（拒绝只发生在新请求）',
    drained.filter((r) => r.status === 200 && r.gotDone).length === 2, drained.map((r) => ({ s: r.status, done: r.gotDone })));

  // E-06 断连归还：客户端断开后 close 触发 release，闸位不该被幽灵请求长期占住
  mockDelayMs = 4_000;
  const held = stream(body(toolId));
  const aborted = stream(body(toolId), { abortAfterMs: 700 });
  await sleep(1_800);
  const afterAbort = await call('POST', '/report/generate', { period: 'week', format: 'xlsx', projectId: FIVE_PID });
  ok('E-06 断连后闸位归还：仅剩 1 路在途时周报导出可进（幽灵占用会在此现形）',
    afterAbort.status === 200, { status: afterAbort.status, ctype: afterAbort.ctype.slice(0, 40) });
  await aborted;
  await held;

  // E-07 上限热可调：隔离库写 exportGateLimit.report-generate=1 → 2 路并发只放 1 路
  {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(join(DATA_DIR, 'mtask.db'));
    db.prepare("insert into app_settings(key,value) values('exportGateLimit.report-generate','1') " +
      'on conflict(key) do update set value=excluded.value').run();
    db.close();
  }
  mockDelayMs = 2_500;
  await sleep(200);
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

  // ---------------- S 组：路由接线字面锚（okPair，行为侧=刚测到的跨端点共用/热调） ----------------
  okPair(ok,
    'S-01 周报与启动会都挂 REPORT_GATE 同一闸（行为=占满启动会时周报 429；字面=两处源码引 REPORT_GATE 而非端点专名）',
    () => weekly.status === 429 && pair.some((r) => r.status === 429),
    () => {
      const gate = headSource('server/src/util/export-gate.ts') ?? '';
      const index = headSource('server/src/routes/index.ts') ?? '';
      const plans = headSource('server/src/routes/plans.ts') ?? '';
      return /export const REPORT_GATE = 'report-generate'/.test(gate) &&
        /exportGate\(REPORT_GATE\)/.test(index) && !/exportGate\('report-generate'/.test(index) &&
        /exportGate\(REPORT_GATE, undefined, \{ defer: true \}\)/.test(plans) && !/exportGate\('kickoff-ppt-stream'/.test(plans);
    },
    () => ({ weekly: weekly.status, pair: pair.map((r) => r.status) }));

  okPair(ok,
    'S-02 启动会端点 defer 在位（行为：E-06 断连后闸位归还 + defer 令后续请求得以抵达闸门；字面：路由段 defer:true）',
    () => afterAbort.status === 200,
    () => {
      const plans = headSource('server/src/routes/plans.ts') ?? '';
      const cut = plans.indexOf("planApi.post('/kickoff-ppt-stream'");
      const seg = cut < 0 ? '' : plans.slice(cut, plans.indexOf('\nplanApi.', cut + 10));
      return /defer: true/.test(seg);
    },
    () => ({ afterAbortStatus: afterAbort.status }));

  const rejectedHttp = four.find((r) => r.status === 429);
  okPair(ok,
    'S-03 拒绝文案沿用仓内既有中文 429（行为：被拒那一路给出非空含中文 error；字面：export-gate 里那句文案）',
    () => !!rejectedHttp && typeof rejectedHttp.error === 'string' && /[\u4e00-\u9fa5]/.test(rejectedHttp.error),
    () => /res\.status\(429\)\.json\(\{ error: '导出任务过多，请稍后再试' \}\)/.test(headSource('server/src/util/export-gate.ts') ?? ''),
    () => ({ httpError: rejectedHttp?.error }));

  mockDelayMs = 0;

  // =================================================================
  // N 组：负对照（判据 4）——把行为真破坏掉，要求同一判据转红
  // =================================================================
  {
    // N-01：H-08 的「同名即同计数」有牙齿——换成两个不同名，占满一个不该顶另一个
    const nA = uniq('n-diff-a'), nB = uniq('n-diff-b');
    const mwA = exportGate(nA, 1), mwB = exportGate(nB, 1);
    const a = hitGate(mwA), b = hitGate(mwB);
    ok('N-01 计数隔离有牙齿：两处用**不同**闸名时各占各的（A 满不影响 B 放行）——反证 H-08 的同名相顶不是恒真',
      a.admitted && b.admitted && !b.rejected, { a: a.status, b: b.status });
    a.res.emit('finish'); b.res.emit('finish');

    // N-02：defer 判别有牙齿——把「defer」用非 defer 中间件冒充，同步放行判据必须识破
    {
      const name = uniq('n-defer');
      const fake = exportGate(name, 5); // 没有 defer
      let syncCalled = false;
      fake({} as any, fakeRes(), () => { syncCalled = true; });
      ok('N-02 defer 判别有牙齿：非 defer 中间件在同步检查那刻就放行（若 H-06 只是恒真，这里会误判 defer 生效）',
        syncCalled === true, { 非defer同步放行: syncCalled });
    }

    // N-03：H-03 的中文 error 判别有牙齿——把 error 换成空串/英文，同一 rejectJudge 必须判否
    {
      const zh = { rejected: true, body: { error: '导出任务过多' }, status: 429, admitted: false, nextCount: 0 } as unknown as ReturnType<typeof hitGate>;
      const en = { rejected: true, body: { error: 'Too many requests' }, status: 429, admitted: false, nextCount: 0 } as unknown as ReturnType<typeof hitGate>;
      const empty = { rejected: true, body: {}, status: 429, admitted: false, nextCount: 0 } as unknown as ReturnType<typeof hitGate>;
      ok('N-03 文案判别有牙齿：rejectJudge 认中文非空 error、拒英文/空 error（S-03/H-03 不是「只要 429 就算过」）',
        rejectJudge(zh) === true && rejectJudge(en) === false && rejectJudge(empty) === false,
        { 中文: rejectJudge(zh), 英文: rejectJudge(en), 空: rejectJudge(empty) });
    }

    // N-04：S-01 字面腿有牙齿——从 HEAD 源码副本里剥掉 REPORT_GATE import / 塞回端点专名，同一字面判据必须转假
    {
      const gate = headSource('server/src/util/export-gate.ts') ?? '';
      const index = headSource('server/src/routes/index.ts') ?? '';
      const plans = headSource('server/src/routes/plans.ts') ?? '';
      const leg = (g: string, i: string, p: string) =>
        /export const REPORT_GATE = 'report-generate'/.test(g) && /exportGate\(REPORT_GATE\)/.test(i) &&
        !/exportGate\('report-generate'/.test(i) && /exportGate\(REPORT_GATE, undefined, \{ defer: true \}\)/.test(p) && !/exportGate\('kickoff-ppt-stream'/.test(p);
      const tamperedPlans = plans.replace(/exportGate\(REPORT_GATE, undefined, \{ defer: true \}\)/, "exportGate('kickoff-ppt-stream', undefined, { defer: true })");
      ok('N-04 S-01 字面腿有牙齿：把启动会那处改成端点专名（各自一名＝违背 FR-5），同一字面判据必须转假（真接线为真）',
        leg(gate, index, plans) === true && leg(gate, index, tamperedPlans) === false,
        { 原样: leg(gate, index, plans), 篡改后: leg(gate, index, tamperedPlans) });
    }
  }
}

child.kill();
// 门进程自己 initSchema()/getSetting 打开过隔离库（better-sqlite3 单例句柄），Windows 上不先关掉
// 就会一直压着 mtask.db 句柄，下面的 rmSync 必 EPERM——先 closeDb 释放本进程的句柄
try { DB.closeDb(); } catch { /* 已关闭或未开 */ }
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
lines.unshift(`T02105 并发闸门：PASS=${pass} FAIL=${fail}${skippedList.length ? ` SKIP=${skippedList.length}` : ''}`);
writeGateResults(OUT_DIR, OUT_BASE, lines.join('\n') + (skippedList.length ? `\n跳过项：\n${skippedList.join('\n')}\n` : ''), { port: PORT, dataDir: DATA_DIR });
console.log(`PASS=${pass} FAIL=${fail}${skippedList.length ? ` SKIP=${skippedList.length}` : ''}`);
process.exit(fail === 0 ? 0 : 1);
