/**
 * T02307 回归门：AI 批量分类的账户级门禁熔断与失败分流。
 *
 * 拦的缺陷（生产 39877 只读取证）：厂商 402 额度耗尽 / 429 免费限流时，批量循环把注定失败的
 * 请求一条不落地打完（实测 69 次全失败、~340ms/次），收尾文案却说「未能为这些任务匹配到合适分类」。
 *
 * 判据（按 `docs/验收门判据规约.md` 四条）：
 *  1. 打在行为/产物上：纯函数返回值 + 隔离实例的 `/tasks/classify` 实发次数 + mock 厂商收到次数
 *     + `GET /api/ai/usage` 的 `byTool` 增量；不读产品源码文本。
 *  2. 门内自造数据：隔离端口 + 隔离 DATA_DIR，空库由服务自建；AI 工具经 `POST /api/aitools` 建、
 *     跑完删除；mock 厂商是门自己的 HTTP 服务。
 *  3. 无字面锚点（不适用 okPair）。
 *  4. 负对照：同一判据喂 `enableBreaker:false`（模拟熔断被移除）必须翻红——实发请求打满 30 条，
 *     且 ai_usage 增量同为 30，证明判据不是空转。
 *
 * 用法：
 *   TMP=/d/code/tmp TEMP=/d/code/tmp node node_modules/tsx/dist/cli.mjs scripts/verify-t02307-classify-breaker.mts
 * 环境变量：T02307_PORT（默认 40137，被占用向后扫）、T02307_MOCK_PORT（默认 0=临时端口）、
 *   T02307_TMP_ROOT（默认 D:/code/tmp，勿指 C:）。
 */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, openSync, closeSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveServerLauncher } from './isolated-server-launcher.mts';
import { writeGateResults } from './lib/gate-results.mts';
import {
  MAX_CONSECUTIVE_FAILURES, classifyResultMessage, createClassifyStore, runClassifyBatch,
  type ClassifyResponse, type ClassifyStoreState,
} from '../web/src/pages/tasksClassifyBatch.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP_ROOT = process.env.T02307_TMP_ROOT || 'D:/code/tmp';
mkdirSync(TMP_ROOT, { recursive: true });
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't02307-'));
const LOG_DIR = mkdtempSync(join(TMP_ROOT, 't02307-log-'));

let pass = 0, fail = 0, skip = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${extra === undefined ? '' : ` -> ${JSON.stringify(extra).slice(0, 300)}`}`); }
};
const skipped = (name: string, why: string) => { skip += 1; console.log(`  [SKIP] ${name} -> ${why}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const targets = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, title: `任务${i}`, priority: n % 2 ? 'normal' : 'high' }));

// ---------- mock 厂商：按端点前缀回 429/402；每次请求计数 ----------
let vendorHits = 0;
const hitsByPath: Record<string, number> = {};
const mock = createServer((req, res) => {
  const url = req.url ?? '';
  const key = url.startsWith('/429') ? '/429' : url.startsWith('/402') ? '/402' : 'other';
  vendorHits += 1;
  hitsByPath[key] = (hitsByPath[key] ?? 0) + 1;
  if (key === '/429') {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'You’ve reached the API rate limit for free users. Upgrade to a Token Plan.' } }));
    return;
  }
  if (key === '/402') {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 100103, message: 'Insufficient user quota, remaining: $-0.001438' }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"error":{"message":"mock: no such case"}}');
});
await new Promise<void>((r) => mock.listen(Number(process.env.T02307_MOCK_PORT ?? 0), '127.0.0.1', () => r()));
const mockPort = (mock.address() as { port: number }).port;

/** 纯函数腿：注入 post，直接驱动批量循环 */
const mockPost = (behavior: (n: number) => ClassifyResponse) => {
  let calls = 0;
  return {
    calls: () => calls,
    post: async () => { calls += 1; return behavior(calls); },
  };
};

console.log('=== P 组：纯函数腿（三态分流 + 熔断 + 文案） ===');
{
  // P-01/02/03：429 首次命中即停
  const store = createClassifyStore();
  const p = mockPost(() => { throw new Error('You’ve reached the API rate limit for free users.'); });
  await runClassifyBatch({ target: targets(30), toolId: 'x', categories: [{ id: 'c1', name: '开发' }], store, post: p.post, patch: async () => undefined, isActive: () => true });
  ok('P-01 429 账户门禁：30 条目标只发 1 次请求即熔断', p.calls() === 1 && store.fail === 1 && store.aborted === true && store.done === true, { calls: p.calls(), store });
  ok('P-02 熔断原因保留厂商原文', String(store.abortReason).includes('rate limit'), store.abortReason);
  const msg429 = classifyResultMessage(store, ['开发']);
  ok('P-03 收尾文案含「中止/额度/限流」与厂商原文，不再说「无合适分类」',
    msg429.includes('中止') && /额度|限流/.test(msg429) && msg429.includes('rate limit') && !msg429.includes('未能为这些任务匹配到合适分类'), msg429);
}
{
  // P-04：402 额度耗尽同样首次即停
  const store = createClassifyStore();
  const p = mockPost(() => { throw new Error('Insufficient user quota, remaining: $-0.001438'); });
  await runClassifyBatch({ target: targets(30), toolId: 'x', categories: [{ id: 'c1', name: '开发' }], store, post: p.post, patch: async () => undefined, isActive: () => true });
  ok('P-04 402 额度耗尽：首次即熔断且原因含 quota', p.calls() === 1 && store.aborted === true && String(store.abortReason).includes('quota'), { calls: p.calls(), reason: store.abortReason });
}
{
  // P-05：非账户级门禁的连续失败同样熔断（K=3）
  const store = createClassifyStore();
  const p = mockPost(() => { throw new Error('socket hang up'); });
  await runClassifyBatch({ target: targets(30), toolId: 'x', categories: [{ id: 'c1', name: '开发' }], store, post: p.post, patch: async () => undefined, isActive: () => true });
  ok(`P-05 连续 ${MAX_CONSECUTIVE_FAILURES} 次厂商失败即熔断（实发=K）`, p.calls() === MAX_CONSECUTIVE_FAILURES && store.fail === MAX_CONSECUTIVE_FAILURES && store.aborted === true, { calls: p.calls(), store });
}
{
  // P-06：成功命中会重置连续失败计数
  const seq = ['fail', 'fail', 'ok', 'fail', 'fail', 'fail'];
  const store = createClassifyStore();
  let patched = 0;
  const p = mockPost((n) => {
    if (seq[n - 1] === 'ok') return { ok: true, categoryId: 'c1', priority: 'high' };
    throw new Error('transient network error');
  });
  await runClassifyBatch({ target: targets(30), toolId: 'x', categories: [{ id: 'c1', name: '开发' }], store, post: p.post, patch: async () => { patched += 1; }, isActive: () => true });
  ok('P-06 中间成功命中后连续失败重新计数（6 次才熔断，hit=1）', p.calls() === 6 && store.hit === 1 && patched === 1 && store.aborted === true, { calls: p.calls(), store, patched });
}
{
  // P-07：真·无匹配不打熔断，30 条照常跑完
  const store = createClassifyStore();
  const p = mockPost(() => ({ ok: true, categoryId: null }));
  await runClassifyBatch({ target: targets(30), toolId: 'x', categories: [{ id: 'c1', name: '开发' }], store, post: p.post, patch: async () => undefined, isActive: () => true });
  const msg = classifyResultMessage(store, ['开发', '测试']);
  ok('P-07 30 条均判定无匹配：不熔断，文案走「无合适分类」', p.calls() === 30 && store.none === 30 && store.aborted === false && msg.includes('无合适分类') && !msg.includes('中止'), { calls: p.calls(), store, msg });
}
{
  // P-08：全部命中：hit/patch 各 30 次
  const store = createClassifyStore();
  let patched = 0;
  const p = mockPost(() => ({ ok: true, categoryId: 'c1', priority: 'high' }));
  await runClassifyBatch({ target: targets(30), toolId: 'x', categories: [{ id: 'c1', name: '开发' }], store, post: p.post, patch: async () => { patched += 1; }, isActive: () => true });
  const msg = classifyResultMessage(store, []);
  ok('P-08 全部命中：30 次分类 + 30 次 PATCH，文案为完成', p.calls() === 30 && patched === 30 && store.hit === 30 && store.aborted === false && msg.includes('批量分类完成'), { calls: p.calls(), patched, store, msg });
}
{
  // P-09：外部复位（切页取消）即中止，不误报熔断
  const store = createClassifyStore();
  const p = mockPost(() => ({ ok: true, categoryId: 'c1' }));
  await runClassifyBatch({ target: targets(30), toolId: 'x', categories: [{ id: 'c1', name: '开发' }], store, post: p.post, patch: async () => undefined, isActive: () => p.calls() < 2 });
  ok('P-09 外部复位：发满 2 次后停，aborted=false（取消不是熔断）', p.calls() === 2 && store.aborted === false && store.done === true, { calls: p.calls(), store });
}
{
  // P-10：负对照——关掉熔断，同一判据必须翻红
  const store = createClassifyStore();
  const p = mockPost(() => { throw new Error('You’ve reached the API rate limit for free users.'); });
  await runClassifyBatch({ target: targets(30), toolId: 'x', categories: [{ id: 'c1', name: '开发' }], store, post: p.post, patch: async () => undefined, isActive: () => true, enableBreaker: false });
  const criterion = (calls: number) => calls <= 1;
  ok('P-10 负对照：移除熔断后实发打满 30 条，P-01 判据翻红（判据有牙）',
    p.calls() === 30 && criterion(p.calls()) === false && store.aborted === false, { calls: p.calls(), store });
}

// ---------- 隔离实例 + mock 厂商：真实链路（HTTP + ai_usage） ----------
console.log('\n=== I 组：隔离实例真实链路（/tasks/classify 实发次数 + ai_usage 增量） ===');
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
let child: ChildProcess | null = null;
let BASE = '';
const logFd = openSync(join(LOG_DIR, 'server.log'), 'a');
const basePort = Number(process.env.T02307_PORT ?? 40137);
for (let i = 0; i < 20 && !BASE; i += 1) {
  const port = basePort + i;
  const c = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
    cwd: ROOT,
    env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(port), MTask_DATA_DIR: DATA_DIR, MTask_LOG_DIR: LOG_DIR },
    stdio: ['ignore', logFd, logFd],
  });
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 90000) {
    if (c.exitCode !== null) break;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/projects`);
      if (r.ok) { ready = true; break; }
    } catch { /* 未就绪 */ }
    await sleep(500);
  }
  if (ready) { child = c; BASE = `http://127.0.0.1:${port}`; break; }
  try { spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
}
const server = LAUNCHER.label ?? `${LAUNCHER.exec}`;
console.log(`  隔离实例启动器：${server} · BASE=${BASE || '(未起)'}`);

const jfetch = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};

if (!child || !BASE) {
  skipped('I-01..I-05 真实链路', `隔离实例未起（端口 ${basePort} 起 20 格均未就绪），环境缺口如实留痕`);
  skipped('N-01 真实链路负对照', '同上');
} else {
  try {
    const mkTool = async (suffix: '/429' | '/402') => {
      const name = `T02307-mock-${suffix.slice(1)}-${Date.now() % 100000}`;
      const r = await jfetch('POST', '/api/aitools', {
        name, type: 'openai-compatible', purpose: 'classify',
        endpoint: `http://127.0.0.1:${mockPort}${suffix}`, apiKey: 'k', model: 'm', timeoutMs: 8000,
      });
      return { id: String(r.body?.id ?? ''), name, status: r.status };
    };
    const usageCalls = async (toolName: string) => {
      const u = await jfetch('GET', '/api/ai/usage?days=1');
      const row = (u.body?.byTool ?? []).find((x: any) => x.tool_name === toolName && x.kind === 'classify');
      return Number(row?.calls ?? 0);
    };
    let classifyCalls = 0;
    const realPost = async (path: string, body: unknown): Promise<ClassifyResponse> => {
      classifyCalls += 1;
      const r = await fetch(BASE + '/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((b as { error?: string }).error ?? `HTTP ${r.status}`);
      return b as ClassifyResponse;
    };
    const patch = async () => { throw new Error('失败场景不应触达 PATCH'); };

    // I-01..I-03：429 真实链路
    const t429 = await mkTool('/429');
    ok('I-00 隔离实例建 mock 429 工具', Boolean(t429.id) && t429.status === 201, t429);
    if (t429.id) {
      const v0 = vendorHits; const c0 = classifyCalls; const u0 = await usageCalls(t429.name);
      const store = createClassifyStore();
      await runClassifyBatch({ target: targets(30), toolId: t429.id, categories: [{ id: 'c1', name: '开发' }], store, post: realPost, patch, isActive: () => true });
      const dVendor = vendorHits - v0; const dCalls = classifyCalls - c0; const dUsage = (await usageCalls(t429.name)) - u0;
      ok('I-01 429 真实链路：30 条目标实发 /tasks/classify = 1（不是 30）', dCalls === 1 && dVendor === dCalls && store.fail === 1 && store.aborted === true, { dCalls, dVendor, store });
      ok('I-02 ai_usage 增量与实发请求一致（不重复记账）', dUsage === dCalls, { dUsage, dCalls });
      const msg = classifyResultMessage(store, ['开发']);
      ok('I-03 收尾文案含额度/限流与厂商原文，且不出现「无合适分类」', /额度|限流/.test(msg) && msg.includes('rate limit') && !msg.includes('未能为这些任务匹配到合适分类'), msg);

      // N-01：真实链路负对照——同一判据，熔断移除后必须打满 30
      const v1 = vendorHits; const c1 = classifyCalls; const u1 = await usageCalls(t429.name);
      const neg = createClassifyStore();
      await runClassifyBatch({ target: targets(30), toolId: t429.id, categories: [{ id: 'c1', name: '开发' }], store: neg, post: realPost, patch, isActive: () => true, enableBreaker: false });
      const ndVendor = vendorHits - v1; const ndCalls = classifyCalls - c1; const ndUsage = (await usageCalls(t429.name)) - u1;
      ok('N-01 负对照真实链路：熔断移除后实发打满 30，I-01 判据（≤1）翻红', ndCalls === 30 && ndVendor === 30 && ndUsage === 30 && !(ndCalls <= 1), { ndCalls, ndVendor, ndUsage });
      await jfetch('DELETE', `/api/aitools/${t429.id}`);
    }

    // I-04..I-05：402 真实链路
    const t402 = await mkTool('/402');
    ok('I-04 隔离实例建 mock 402 工具', Boolean(t402.id) && t402.status === 201, t402);
    if (t402.id) {
      const v0 = vendorHits; const c0 = classifyCalls; const u0 = await usageCalls(t402.name);
      const store = createClassifyStore();
      await runClassifyBatch({ target: targets(30), toolId: t402.id, categories: [{ id: 'c1', name: '开发' }], store, post: realPost, patch, isActive: () => true });
      const dVendor = vendorHits - v0; const dCalls = classifyCalls - c0; const dUsage = (await usageCalls(t402.name)) - u0;
      const msg = classifyResultMessage(store, ['开发']);
      ok('I-05 402 真实链路：实发=1、ai_usage=1、文案含 quota/额度且非「无合适分类」',
        dCalls === 1 && dVendor === 1 && dUsage === 1 && store.aborted === true && msg.includes('quota') && !msg.includes('未能为这些任务匹配到合适分类'), { dCalls, dVendor, dUsage, store, msg });
      await jfetch('DELETE', `/api/aitools/${t402.id}`);
    }
  } finally {
    if (child?.pid) {
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
    }
    await sleep(800);
  }
}

// ---------- 收尾 ----------
mock.closeAllConnections?.();
await new Promise<void>((r) => mock.close(() => r()));
try { closeSync(logFd); } catch { /* ignore */ }
try { rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* 隔离目录留待人工清理 */ }
try { rmSync(LOG_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* 同上 */ }

const summary = `PASS=${pass} FAIL=${fail} SKIP=${skip}`;
const resultsFile = writeGateResults(join(ROOT, '.workbuddy'), 't02307-classify-breaker-gate-results.txt', summary, { port: BASE || basePort, dataDir: DATA_DIR, note: server });
console.log(`\n${summary}`);
console.log(`结果文件：${resultsFile}`);
process.exitCode = fail === 0 ? 0 : 1;
