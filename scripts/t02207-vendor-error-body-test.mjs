// T02207 断言：AI 调用失败必须带出「厂商错误体原文 + 状态码」，并对 402/401/403 给定向提示。
// 策略：
//   ① 本地 mock 厂商（覆盖各家错误体形状：OpenAI `{error:{message}}`、`error` 为字符串、
//      硅基流动 `{code,message}`、网关 HTML/纯文本、未知形状）→ 直调 server/dist 的 adapter，
//      断言 chat / chatStream / testConnection / listModels 四条通道文案同口径，且既有 404 提示不回归；
//   ② 传 BASE（隔离实例）时走真实链路：建工具 → `/api/ai/simplify` 触发失败调用 →
//      断言 HTTP 响应文案与 `ai_usage.error` 均含厂商原文 + 状态码（验收口径的落库面）。
// 用法：
//   npm run build:server && node scripts/t02207-vendor-error-body-test.mjs        # 只跑 ①段
//   T02207_CHAIN=1 node scripts/t02207-vendor-error-body-test.mjs <baseUrl>       # ①+②（②只可对隔离实例）
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] ?? '';
const MOCK_PORT = Number(process.env.T02207_MOCK_PORT ?? 39977);
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`PASS ${name} :: ${String(detail).slice(0, 120)}`); }
  else { fail++; console.log(`FAIL ${name} :: ${String(detail).slice(0, 300)}`); }
};
const has = (s, ...subs) => subs.every((x) => (s ?? '').includes(x));

// ---------- mock 厂商：按路径前缀决定回什么形状 ----------
const CASES = {
  '/402': { status: 402, type: 'application/json', body: JSON.stringify({ code: 100103, message: 'balance insufficient, please recharge' }) },
  '/401': { status: 401, type: 'application/json', body: JSON.stringify({ error: { message: 'Missing Authentication header' } }) },
  '/403': { status: 403, type: 'application/json', body: JSON.stringify({ error: 'invalid_api_key' }) },
  '/404': { status: 404, type: 'application/json', body: JSON.stringify({ error: { message: 'Requested channel not found' } }) },
  '/429': { status: 429, type: 'application/json', body: JSON.stringify({ error: { message: 'Free Key: Rate limit reached' } }) },
  '/html': { status: 503, type: 'text/html', body: '<html><body>Gateway Blocked by policy</body></html>' },
  '/plain': { status: 502, type: 'text/plain', body: 'Bad Gateway from edge proxy' },
  '/unknown': { status: 400, type: 'application/json', body: JSON.stringify({ foo: 'bar' }) },
  '/ok': { status: 200, type: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'OK-CONTENT' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }) },
  '/emptyok': { status: 200, type: 'application/json', body: '{}' },
};
const mock = createServer((req, res) => {
  const key = Object.keys(CASES).find((k) => (req.url ?? '').startsWith(k));
  if (!key) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"mock: no such case"}}'); return; }
  const c = CASES[key];
  res.writeHead(c.status, { 'Content-Type': c.type });
  res.end(c.body);
});
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

const distEntry = join(HERE, '..', 'server', 'dist', 'adapters', 'index.js');
if (!existsSync(distEntry)) {
  console.log(`FAIL 前置：未找到 ${distEntry}（先跑 npm run build:server）`);
  process.exit(1);
}
const { getAdapter } = await import(pathToFileURL(distEntry).href);
const adapter = getAdapter('openai-compatible');
const cfg = (k) => ({ type: 'openai-compatible', endpoint: `http://127.0.0.1:${MOCK_PORT}${k}`, apiKey: 'k', model: 'm', timeoutMs: 8000 });

// ---------- ① 非流式实调（缺陷本体：只剩裸 HTTP 402 的那条通道） ----------
const r402 = await adapter.chat('s', 'u', cfg('/402'));
check('A-1 402 带出厂商 message 原文', has(r402.error, 'balance insufficient'), r402.error);
check('A-2 402 带出厂商 code', has(r402.error, '100103'), r402.error);
check('A-3 402 附状态码', has(r402.error, 'HTTP 402'), r402.error);
check('A-4 402 定向提示（计费门禁、重试无效）', has(r402.error, '计费'), r402.error);

const r401 = await adapter.chat('s', 'u', cfg('/401'));
check('A-5 401 带出 OpenAI 形状原文', has(r401.error, 'Missing Authentication header', 'HTTP 401'), r401.error);
const r403 = await adapter.chat('s', 'u', cfg('/403'));
check('A-6 403（error 为字符串）带出原文与密钥提示', has(r403.error, 'invalid_api_key', 'HTTP 403', '密钥'), r403.error);

const rHtml = await adapter.chat('s', 'u', cfg('/html'));
check('A-7 HTML 错误体带出原文（不再被 JSON 解析异常顶替）',
  has(rHtml.error, 'Gateway Blocked by policy', 'HTTP 503') && !/Unexpected token|JSON\.parse|is not valid JSON/.test(rHtml.error ?? ''), rHtml.error);
const rPlain = await adapter.chat('s', 'u', cfg('/plain'));
check('A-8 纯文本错误体带出原文', has(rPlain.error, 'Bad Gateway from edge proxy', 'HTTP 502'), rPlain.error);
const rUnknown = await adapter.chat('s', 'u', cfg('/unknown'));
check('A-9 未知 JSON 形状回退原始文本', has(rUnknown.error, '{"foo":"bar"}', 'HTTP 400'), rUnknown.error);

const r404 = await adapter.chat('s', 'u', cfg('/404'));
check('A-10 404 原文 + 既有 Base URL 排障提示不回归', has(r404.error, 'Requested channel not found', 'Base URL 路径不对'), r404.error);
const r429 = await adapter.chat('s', 'u', cfg('/429'));
check('A-11 429 保留厂商原文', has(r429.error, 'Free Key: Rate limit reached', 'HTTP 429'), r429.error);
check('A-12 429 不误挂 402 计费提示', !(r429.error ?? '').includes('计费'), r429.error);

const rOk = await adapter.chat('s', 'u', cfg('/ok'));
check('A-13 成功路径不被改写', rOk.ok === true && rOk.content === 'OK-CONTENT', `ok=${rOk.ok} content=${rOk.content} usage=${JSON.stringify(rOk.usage)}`);
const rEmpty = await adapter.chat('s', 'u', cfg('/emptyok'));
check('A-14 200 空正文按「内容为空」判失败（不再是解析异常）',
  rEmpty.ok === false && has(rEmpty.error, 'AI 返回内容为空'), rEmpty.error);

// ---------- ①b 其余三条通道：口径必须一致 ----------
const s402 = await adapter.chatStream('s', 'u', cfg('/402'), () => undefined);
check('A-15 流式通道 402 带出原文 + 状态码 + 定向提示',
  has(s402.error, 'balance insufficient', '402', '计费'), s402.error);
const t402 = await adapter.testConnection(cfg('/402'));
check('A-16 连接测试通道 402 同口径（与实调不再不一致）',
  has(t402.message, 'balance insufficient', '402', '计费'), t402.message);
const m402 = await adapter.listModels(cfg('/402'));
check('A-17 模型列表通道 402 同口径', has(m402.message, 'balance insufficient', '402'), m402.message);

// ---------- ①c 落库可读性：AIService.recordUsage 把 error 截到 300 字符，
//           原文上限 200 + 状态码 + 定向提示必须整体塞得下，否则用量面板看到的是被砍掉的提示 ----------
const allErrors = [r402, r401, r403, rHtml, rPlain, rUnknown, r404, r429, rEmpty, s402].map((r) => r.error ?? '');
const tooLong = allErrors.filter((e) => e.length > 300);
check('A-18 失败文案不超 ai_usage.error 的 300 字符截断线',
  tooLong.length === 0, `最长=${Math.max(...allErrors.map((e) => e.length))} 超限=${tooLong.length}`);

// ---------- ② 真实链路（隔离实例）：HTTP 响应文案 + ai_usage 落库 ----------
// 需要显式放行：这段会**建 AI 工具并写 ai_usage**，只能对着隔离实例跑。
// 因此除 BASE 外还必须带 T02207_CHAIN=1——`npm run test:api http://127.0.0.1:39877` 之类的
// 生产回归调用绝不会误改用户的 AI 配置（跑完会删掉自建工具）。
if (BASE && process.env.T02207_CHAIN === '1') {
  const api = async (m, p, b) => {
    const r = await fetch(BASE + p, {
      method: m,
      headers: { 'Content-Type': 'application/json' },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const tool = await api('POST', '/api/aitools', {
    name: `T02207-mock-${Date.now() % 100000}`, type: 'openai-compatible', purpose: 'simplify',
    endpoint: `http://127.0.0.1:${MOCK_PORT}/402`, apiKey: 'k', model: 'm', timeoutMs: 8000,
  });
  const toolId = tool.json?.id;
  check('C-1 隔离实例建 mock 工具', !!toolId, JSON.stringify(tool.json).slice(0, 150));
  if (toolId) {
    const simp = await api('POST', '/api/ai/simplify', { toolId, title: '一条标题', description: '一段详情内容' });
    const msg = JSON.stringify(simp.json);
    check('C-2 /ai/simplify 响应含厂商原文与状态码', has(msg, 'balance insufficient', 'HTTP 402'), msg.slice(0, 240));
    const usage = await api('GET', '/api/ai/usage?days=1');
    const row = (usage.json?.recent ?? []).find((x) => x.tool_name?.startsWith('T02207-mock'));
    check('C-3 ai_usage.error 落库含厂商原文与状态码', has(row?.error, 'balance insufficient', 'HTTP 402'), JSON.stringify(row));
    check('C-4 ai_usage 记为失败行（ok=0）', row?.ok === 0, JSON.stringify(row));
    await api('DELETE', `/api/aitools/${toolId}`);
  }
} else {
  console.log('SKIP ②真实链路段（需隔离实例并同时给 BASE + T02207_CHAIN=1：'
    + 'MTask_PORT/MTask_DATA_DIR 指 D: 起实例，再 `T02207_CHAIN=1 node scripts/t02207-vendor-error-body-test.mjs http://127.0.0.1:<port>`）');
}

// 收尾：先断连接再关服，让事件循环自然排空后按 exitCode 退出。
// 直接 process.exit() 会在 Windows 上撞 libuv 断言（`UV_HANDLE_CLOSING`）并把退出码变成 127，
// 让套件「全绿却报失败」。
mock.closeAllConnections?.();
mock.close();
process.exitCode = fail === 0 ? 0 : 1;
console.log(`\n==== T02207 vendor-error-body SUMMARY: ${pass}/${pass + fail} passed ====`);
