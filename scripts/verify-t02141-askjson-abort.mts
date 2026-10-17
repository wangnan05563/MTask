/**
 * T02141 门（派生自 T02103：`AIService.askJson` 支持 AbortSignal 透传——措辞段断连不再空烧配额）。
 *
 * 分工（只补此前没人证过的那一层）：
 *   verify-t02103 C 组证的是「断连后**不残留临时文件、闸位归还**」——它断在措辞**已回**之后；
 *   verify-t02112 C 组证的是断连清理与零 AI 佐证。
 *   本门证的是中止信号**进入模型等待期**这件事：
 *     ① 客户端在措辞请求在途（模型还没吐字）时断开 → 服务端的 fetch 真的被掐（mock 侧观测到连接提前关闭，
 *        且关闭时刻远早于 mock 的 6s 应答延迟）——此前只能等满整轮响应再丢弃，白烧一次等待与配额；
 *     ② abort **不触发重试**（与 T01289「超时不重试」同口径）：mock 只收到 1 次措辞请求，而不是 2 次；
 *     ③ 该轮在 `ai_usage` 里如实记失败且原因是「任务已停止」，不是被误记成「JSON 解析失败」；
 *     ④ 能力不是空挂：kickoffService 措辞段确实把 signal 传了下去（透传链任一环断开，上面三条全成空话）。
 *   A 组另跑一次**无中止**的完整生成，证明加了 signal 后正常路径没有回归。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02141-askjson-abort.mts
 * 环境变量：`T02141_PORT`（默认随机 39500+rand300）。
 * 隔离纪律（skill 红线 8）：生产库只读副本落临时目录；端口/数据全临时；模型走进程内 mock（零真实配额）；收尾删目录。
 * 结果落 .workbuddy/t02141-gate-results-<运行标识>.txt。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.T02141_PORT ?? 39_500 + Math.floor(Math.random() * 300));
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02141-abort-'));
const BASE = `http://127.0.0.1:${PORT}/api`;
const OUT_DIR = join(ROOT, '.workbuddy');
const TMP_DIR = join(DATA_DIR, 'tmp');
process.env.MTask_DATA_DIR = DATA_DIR;

const FIVE_PID = '95f31a46-92f6-4046-8cb6-ee3c4e228a44'; // mtask五期（本特性自己的项目，资料齐备）
const MOCK_DELAY_MS = 6_000; // 措辞应答延迟：远大于「断开→掐断」的观测窗口，才分得出「等满一轮」与「即时收手」

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// =====================================================================
// mock AI：记录每个请求的到达/关闭/应答时刻——「连接被提前关闭」是本门唯一能观测到的中止事实
// =====================================================================
type MockReq = { startedAt: number; closedAt: number | null; answeredAt: number | null };
const mockReqs: MockReq[] = [];
let mockDelayMs = 0;
const mock = createServer((req, res) => {
  const entry: MockReq = { startedAt: Date.now(), closedAt: null, answeredAt: null };
  mockReqs.push(entry);
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    let user = '';
    try {
      const j = JSON.parse(body);
      user = String((j.messages ?? []).filter((m: any) => m.role === 'user').map((m: any) => m.content).join('\n'));
    } catch { /* 坏请求回空 */ }
    const reply = () => {
      if (entry.closedAt !== null || res.destroyed) return; // 连接已提前断：不再应答（否则观测点被污染）
      entry.answeredAt = Date.now();
      const want = /条数分别为 (\d+) 与 (\d+)。/.exec(user);
      const nRisks = want ? +want[1] : 2;
      const nComms = want ? +want[2] : 2;
      const items = [...user.matchAll(/^\d+\. 风险：(.+)$/gm)].map((m) => m[1].trim());
      const content = JSON.stringify({
        risks: Array.from({ length: nRisks }, (_, i) => ({
          item: (items[i] ?? `风险 ${i + 1}`).slice(0, 40),
          impact: '会上确认影响面',
          mitigation: '会上明确责任方与时限',
        })),
        comms: Array.from({ length: nComms }, (_, i) => (i === 0 ? '周会跟里程碑节点开' : '变更先登记进需求跟踪矩阵')),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    };
    if (mockDelayMs > 0) setTimeout(reply, mockDelayMs);
    else reply();
  });
  req.on('close', () => { /* 不作为观测点：keep-alive 下请求流读完即 close，与客户端是否断开无关（负控实测证伪过） */ });
  // 判别点放在**响应**上：只有「响应还没写出去，连接就断了」才是客户端中止；
  // 服务端没透进中止信号时，这条连接会一直开着等到 mock 应答——两者在此分得开，A-04~A-06 才有判别力。
  res.on('close', () => { if (!res.writableEnded && entry.closedAt === null) entry.closedAt = Date.now(); });
});
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
const MOCK_PORT = (mock.address() as { port: number }).port;

// =====================================================================
// 隔离实例：生产库只读副本 → 临时 DATA_DIR
// =====================================================================
const { resolveServerLauncher } = await import('./isolated-server-launcher.mts');
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const prodDb = join(process.env.APPDATA ?? '', 'MTask', 'data', 'mtask.db');
const Database = (await import('better-sqlite3')).default;
{
  const src = new Database(prodDb, { readonly: true });
  await src.backup(join(DATA_DIR, 'mtask.db'));
  src.close();
}
ok('A-00 生产库只读副本已生成（本门零写生产库）', existsSync(join(DATA_DIR, 'mtask.db')));
const q = <T,>(sql: string, ...a: unknown[]) => {
  // 只读句柄在 WAL 副本上易踩 -shm 权限坑；这里连的是临时目录里的副本，且不发出任何写语句
  const d = new Database(join(DATA_DIR, 'mtask.db'));
  try { return d.prepare(sql).all(...a) as T[]; } finally { d.close(); }
};

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
  try { body = JSON.parse(text); } catch { /* 二进制 */ }
  return { status: res.status, body, text };
}
async function download(token: string, fileName: string) {
  const res = await fetch(BASE + '/report/ai-download', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, filename: fileName }),
  });
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
}
/** 走 SSE；abortWhen 为真即由客户端断开（断在措辞请求在途时，才是本门要的那一幕） */
async function streamGen(path: string, body: unknown, opts: { abortWhen?: () => boolean } = {}): Promise<{
  status: number; events: Array<{ event: string; data: any }>; aborted: boolean; abortedAt: number;
}> {
  const ac = new AbortController();
  const events: Array<{ event: string; data: any }> = [];
  let aborted = false;
  let abortedAt = 0;
  let status = 0;
  const kill = () => { if (aborted) return; aborted = true; abortedAt = Date.now(); ac.abort(); };
  const poll = opts.abortWhen ? setInterval(() => { if (opts.abortWhen!()) kill(); }, 100) : null;
  try {
    const res = await fetch(BASE + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal,
    });
    status = res.status;
    const ctype = res.headers.get('content-type') ?? '';
    if (!ctype.includes('event-stream')) return { status, events, aborted, abortedAt };
    let raw = '';
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += dec.decode(value, { stream: true });
      let i = raw.indexOf('\n\n');
      while (i >= 0) {
        const chunk = raw.slice(0, i);
        raw = raw.slice(i + 2);
        const event = /^event: (.+)$/m.exec(chunk)?.[1] ?? '';
        const dataStr = /^data: (.*)$/m.exec(chunk)?.[1] ?? '{}';
        try { events.push({ event, data: JSON.parse(dataStr) }); } catch { /* 坏帧 */ }
        i = raw.indexOf('\n\n');
      }
      if (aborted) break;
    }
  } catch { /* 客户端 abort 抛 AbortError：预期内 */ }
  if (poll) clearInterval(poll);
  return { status, events, aborted, abortedAt };
}

/** 12 页标准稿（含风险页 + 沟通页，措辞段必然被调用——否则本门等于空跑） */
function baseOutline(): any[] {
  const spec: Array<[string, string, string[], string[]]> = [
    ['封面', '项目启动会', ['preflight'], []],
    ['议程', '今天讲什么', ['preflight'], ['范围与交付物', '责任分工']],
    ['项目背景', '为什么现在做', ['prdDoc'], ['业务背景', '现状痛点']],
    ['项目团队介绍', '谁负责什么', ['assignees'], ['责任分工', '协作接口人']],
    ['项目需求', '需求全景与优先级', ['reqStats', 'reqList'], ['高优先级需求', '待确认需求']],
    ['项目范围', '做什么与不做什么', ['reqList'], ['范围内', '范围外']],
    ['项目计划', '项目计划时间线', ['timeline', 'planRows'], ['阶段划分', '关键依赖']],
    ['工作量评估', '人天与报价口径', ['workload'], ['估算区间', '口径说明']],
    ['测试与质量策略', '用例覆盖与质量门槛', ['coverage'], ['覆盖率结论', '回归策略']],
    ['项目风险', '风险登记与应对', ['risks'], ['进度风险', '范围风险']],
    ['沟通管理', '例会与变更口径', [], ['周会节奏', '变更登记']],
    ['附录', '数据口径与工作空间', ['workspace', 'prdDoc'], ['取数时间', '原文索引']],
  ];
  const layoutOf = (i: number) => (i === 0 ? 'cover' : i === 1 ? 'toc' : i === 6 ? 'timeline' : i === 7 ? 'chart' : i === 11 ? 'list' : 'table');
  return spec.map(([section, title, dataKeys, bullets], i) => ({
    section, title, bullets: section === '封面' ? [] : bullets, dataKeys, layout: layoutOf(i),
  }));
}

// =====================================================================
// S 组：透传链每一环都在（断一环，A 组的行为断言就成了空话）
// =====================================================================
{
  const AIS = readFileSync(join(ROOT, 'server', 'src', 'services', 'AIService.ts'), 'utf8');
  const KICK = readFileSync(join(ROOT, 'server', 'src', 'services', 'kickoffService.ts'), 'utf8');
  const askJsonBody = AIS.slice(AIS.indexOf('async askJson<T>'), AIS.indexOf('async askStream'));
  ok('S-01 askJson 的 opts 带可选 signal（8 参上限走对象包，不破坏既有调用方）',
    /signal\?: AbortSignal;/.test(askJsonBody), askJsonBody.slice(askJsonBody.indexOf('opts?'), askJsonBody.indexOf('opts?') + 400));
  ok('S-02 askJson 把 signal 真传给 adapter.chat（只加参数不传＝空挂）',
    /adapter\.chat\([\s\S]{0,240},\s*signal\)/.test(askJsonBody));
  ok('S-03 abort 与超时同口径：不重试（break 而非 continue）——否则「停止」变成再等一轮、双份配额',
    /if \(res\.timedOut \|\| signal\?\.aborted\) break;/.test(askJsonBody));
  const adapters = ['claude', 'ollama', 'openaiCompat', 'workbuddy'];
  const unsupported = adapters.filter((n) => {
    const src = readFileSync(join(ROOT, 'server', 'src', 'adapters', `${n}.ts`), 'utf8');
    return !/async chat\([^)]*signal\?: AbortSignal/.test(src);
  });
  ok('S-04 四家适配器 chat 契约一致收 signal（任一家不吃 signal，透传就在该厂商处失效）',
    unsupported.length === 0, { unsupported });
  ok('S-05 措辞段确实传 signal：polishWording 收 signal 且 askJson opts 带上',
    /async function polishWording\([\s\S]{0,260}signal\?: AbortSignal/.test(KICK) && /\{ temperature: 0, signal \}/.test(KICK));
  ok('S-06 流式入口把自己那条 signal 递给措辞段（不是新造一个控制器）',
    /polishWording\(bundle, toolId, local, warnings, signal\)/.test(KICK));
}

// =====================================================================
// A 组：真链路上量中止行为
// =====================================================================
mkdirSync(TMP_DIR, { recursive: true });
if (!(await waitUp())) {
  ok('X-00 隔离实例启动', false, serverLog.join('').slice(-600));
} else {
  ok('X-00 隔离实例启动', true);
  const tool = await call('POST', '/aitools', {
    name: 't02141-mock', type: 'openai-compatible', endpoint: `http://127.0.0.1:${MOCK_PORT}`,
    apiKey: 'mock-key', model: 'mock-wording', timeoutMs: 20_000,
  });
  const toolId = tool.body?.id as string | undefined;
  ok('X-01 mock AI 工具已建（不触真实模型、不烧真实配额）', !!toolId, tool.body);

  const outline = baseOutline();
  const body = { projectId: FIVE_PID, toolId, outline };

  // ---- 无中止基线跑（先证明这条链路本身是通的，再谈中止）----
  const clean = await streamGen('/plans/kickoff-ppt-stream', body);
  const cleanDone = clean.events.find((e) => e.event === 'done');
  ok('A-01 基线（无中止）：措辞段正常应答并出稿（done + 页数 + 可下载）',
    !!cleanDone && Number(cleanDone.data?.pageCount ?? 0) === outline.length,
    { events: clean.events.map((e) => e.event).join(','), done: cleanDone?.data });
  const dlClean = cleanDone ? await download(String(cleanDone.data.token), String(cleanDone.data.fileName)) : null;
  ok('A-02 基线产物是 pptx 二进制（加 signal 后主路径零回归）',
    dlClean?.status === 200 && dlClean.buf.subarray(0, 2).toString() === 'PK' && dlClean.buf.length > 20_000,
    { status: dlClean?.status, bytes: dlClean?.buf.length });

  // ---- 中止跑：措辞请求在途即断开 ----
  mockDelayMs = MOCK_DELAY_MS;
  const usageBefore = q<{ n: number }>('SELECT COUNT(*) n FROM ai_usage')[0].n;
  const hitsBefore = mockReqs.length;
  const r = await streamGen('/plans/kickoff-ppt-stream', body, { abortWhen: () => mockReqs.length > hitsBefore });
  ok('A-03 客户端确实在措辞在途时断开（mock 收到过请求且客户端已 abort）',
    r.aborted && mockReqs.length > hitsBefore, { aborted: r.aborted, reqs: mockReqs.length - hitsBefore });

  await sleep(1_500); // 跨过 mock 的应答时刻：若服务端仍在等这轮，close 只会在应答后出现
  const req = mockReqs[hitsBefore] ?? { startedAt: 0, closedAt: null, answeredAt: null };
  ok('A-04 服务端把中止真的透进了模型等待期：mock 侧连接被提前关闭且从未收到应答',
    req.closedAt !== null && req.answeredAt === null,
    { closedAt: req.closedAt, answeredAt: req.answeredAt, elapsedMs: req.closedAt ? req.closedAt - req.startedAt : null });
  ok('A-05 关闭发生在应答延迟之前（等满 6s 再丢＝此前空烧的行为，必须被否证）',
    req.closedAt !== null && req.closedAt - req.startedAt < MOCK_DELAY_MS,
    { elapsedMs: req.closedAt ? req.closedAt - req.startedAt : null, mockDelayMs: MOCK_DELAY_MS });
  ok('A-06 从客户端 abort 到 mock 观测到关闭是即时的（不等整轮响应）',
    req.closedAt !== null && req.closedAt - r.abortedAt < 1_500,
    { deltaMs: req.closedAt ? req.closedAt - r.abortedAt : null });
  // 时序原始值随门留痕（这三条是「即时收手 vs 等满一轮」的唯一判别面，出问题时先看这行）
  lines.push(`[证据] A-04~A-06 观测：mock 请求=${JSON.stringify(req)} | 客户端abort后${Date.now() - r.abortedAt}ms取样 | 本轮新增请求数=${mockReqs.length - hitsBefore}`);
  ok('A-07 abort 不触发重试：mock 本轮只收到 1 次措辞请求（收 2 次＝「停止」变成再等一轮）',
    mockReqs.length - hitsBefore === 1, { hits: mockReqs.length - hitsBefore });

  const usage = q<{ kind: string; ok: number; error: string | null }>(
    'SELECT kind, ok, error FROM ai_usage ORDER BY created_at DESC LIMIT 6');
  const usageAfter = q<{ n: number }>('SELECT COUNT(*) n FROM ai_usage')[0].n;
  const stopRow = usage.find((u) => u.kind === 'ask-json' && u.ok === 0 && /任务已停止/.test(u.error ?? ''));
  ok('A-08 该轮在 ai_usage 如实记失败且原因＝任务已停止（不被误记成解析失败）',
    !!stopRow && usageAfter > usageBefore, { usageBefore, usageAfter, rows: usage.slice(0, 3) });

  ok('A-09 中止后无孤儿令牌落盘（措辞阶段收手，压根没走到落盘那一步）',
    readdirSync(TMP_DIR).length === 0, readdirSync(TMP_DIR));

  // ---- 闸位与实例健康：中止不能把共用闸锁死 ----
  mockDelayMs = 0;
  const after = await streamGen('/plans/kickoff-ppt-stream', body);
  ok('A-10 中止后闸位归还：紧随其后的完整生成仍能出稿',
    !!after.events.find((e) => e.event === 'done'), after.events.map((e) => e.event).join(','));
  const dlAfter = after.events.find((e) => e.event === 'done');
  if (dlAfter) await download(String(dlAfter.data.token), String(dlAfter.data.fileName));
  const health = await call('GET', '/health');
  ok('A-11 实例仍健康且日志无未捕获异常（abort 不能以 reject 收场）',
    health.status === 200 && !/unhandledRejection|uncaughtException/.test(serverLog.join('')),
    (serverLog.join('').match(/unhandledRejection|uncaughtException[^\n]{0,120}/) ?? []).slice(0, 2));
}

// =====================================================================
// 收口
// =====================================================================
child.kill();
mock.close();
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* Windows 句柄释放延迟 */ }

const summary = `T02141 askJson 中止门：PASS ${pass} / FAIL ${fail}\n` + lines.join('\n');
writeGateResults(OUT_DIR, 't02141-gate-results.txt', summary, { port: PORT, dataDir: DATA_DIR });
console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
