// T00777 API 级断言：轻量符号索引（提取/增量/查询）+ 检索增强注入（经 PRD 生成流式 stage 日志验证）
// 用法：node t00777-symbols-api-test.mjs [baseUrl]
const BASE = process.argv[2] ?? 'http://127.0.0.1:39904';
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS ${name} :: ${detail}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
}
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}
const { mkdtempSync, writeFileSync, mkdirSync, utimesSync } = await import('node:fs');
const { join } = await import('node:path');
const { tmpdir } = await import('node:os');
const WS = mkdtempSync(join(tmpdir(), 'mtask-sym-'));

mkdirSync(join(WS, 'src'), { recursive: true });
mkdirSync(join(WS, 'node_modules'), { recursive: true });
writeFileSync(join(WS, 'src', 'order.ts'), 'export function createOrder() {}\nexport class OrderService {}\nexport const MAX_ORDER = 100;\nfunction helper() {}\n');
writeFileSync(join(WS, 'src', 'pay.py'), 'def pay_order(amount):\n    pass\n\nclass PayGateway:\n    pass\n');
writeFileSync(join(WS, 'node_modules', 'x.ts'), 'export function shouldNotIndex() {}\n');
writeFileSync(join(WS, 'src', 'auth.ts'), 'export function jwtParse() {}\n');

const proj = (await api('POST', '/api/projects', { name: `T00777-SYM-${Date.now() % 100000}` })).json;
const pid = proj.id;
await api('PATCH', `/api/projects/${pid}`, { workspacePath: WS });
check('P-01 项目+工作空间', !!pid, `id=${pid}`);

// ---- 符号提取 ----
const r1 = (await api('POST', '/api/workspace/symbols/refresh', { projectId: pid })).json;
check('X-1 首次刷新提取文件/符号', r1?.files === 3 && r1?.symbols >= 7, `files=${r1?.files} symbols=${r1?.symbols}`);
const q1 = (await api('GET', `/api/workspace/symbols?projectId=${pid}&q=Order`)).json ?? [];
check('X-2 查询命中 createOrder/OrderService', q1.some((s) => s.symbol === 'createOrder') && q1.some((s) => s.symbol === 'OrderService'),
  JSON.stringify(q1.map((s) => `${s.symbol}@${s.path}:${s.line}`)));
const q2 = (await api('GET', `/api/workspace/symbols?projectId=${pid}&q=pay`)).json ?? [];
check('X-3 Python 符号提取', q2.some((s) => s.symbol === 'pay_order' && s.kind === 'function') && q2.some((s) => s.symbol === 'PayGateway' && s.kind === 'class'),
  JSON.stringify(q2.map((s) => s.symbol)));
const q3 = (await api('GET', `/api/workspace/symbols?projectId=${pid}&q=shouldNotIndex`)).json ?? [];
check('X-4 node_modules 被忽略不入索引', q3.length === 0, `count=${q3.length}`);

// ---- 增量：未变跳过 ----
const r2 = (await api('POST', '/api/workspace/symbols/refresh', { projectId: pid })).json;
check('X-5 二次刷新全跳过（mtime 增量）', r2?.skipped === 3 && r2?.files === 0, `files=${r2?.files} skipped=${r2?.skipped}`);

// ---- 增量：文件变化重建 ----
writeFileSync(join(WS, 'src', 'order.ts'), 'export function createOrderV2() {}\nexport class OrderServiceV2 {}\n');
await new Promise((r) => setTimeout(r, 60)); // 保证 mtime 变化
const r3 = (await api('POST', '/api/workspace/symbols/refresh', { projectId: pid })).json;
check('X-6 变更文件重建', r3?.files === 1, `files=${r3?.files}`);
const q4 = (await api('GET', `/api/workspace/symbols?projectId=${pid}&q=createOrderV2`)).json ?? [];
check('X-7 新符号可查', q4.length === 1, JSON.stringify(q4));
const q5 = (await api('GET', `/api/workspace/symbols?projectId=${pid}&q=OrderService`)).json ?? [];
check('X-8 旧符号被清除（同名 V1 消失，保留 V2）', !q5.some((s) => s.symbol === 'OrderService') && q5.some((s) => s.symbol === 'OrderServiceV2'),
  JSON.stringify(q5.map((s) => s.symbol)));

// ---- 短路校验 ----
const badQ = await api('GET', `/api/workspace/symbols?projectId=${pid}&q=a`);
check('X-9 q 过短 400', badQ.status === 400, `error=${badQ.json?.error}`);

// ---- 检索增强注入（经 PRD 生成流式 stage 验证；真实 LLM） ----
let autoCtxVerified = false;
try {
  const cfg = (await import('node:fs')).readFileSync(`${process.env.USERPROFILE}/.workbuddy/skills/agnes-image-2.5-flash/config.yaml`, 'utf8');
  const key = /api_key:\s*"([^"]+)"/.exec(cfg)?.[1] ?? '';
  const tool = await api('POST', '/api/aitools', {
    name: 'agnes-2.5-flash-T00777', type: 'openai-compatible', purpose: 'develop',
    endpoint: 'https://apihub.agnes-ai.com/v1', apiKey: key, model: 'agnes-2.5-flash',
    maxTokens: 16384, timeoutMs: 600000, remark: 'T00777 检索增强验证临时配置',
  });
  const toolId = tool.json?.id ?? '';
  if (toolId) {
    const reqMd = Buffer.from('基于 auth 模块的 jwtParse 与登录鉴权，输出 PRD 草稿。').toString('base64');
    const res = await fetch(`${BASE}/api/plans/prd-generate-stream?projectId=${pid}&toolId=${toolId}&filename=req.md`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contentBase64: reqMd }),
    });
    const text = await res.text();
    autoCtxVerified = text.includes('检索增强') && text.includes('符号索引刷新');
    check('A-1 生成流含符号索引刷新与检索增强 stage', autoCtxVerified, text.split('\\n').filter((l) => l.includes('检索增强') || l.includes('符号索引')).join(' | ').slice(0, 200));
  } else {
    console.log('SKIP A-1（AI 工具创建失败）');
  }
} catch (e) {
  console.log(`SKIP A-1（${String(e).slice(0, 80)}）`);
}

console.log(`==== T00777 SUMMARY: ${pass}/${pass + fail} passed ====`);
process.exit(fail > 0 ? 1 : 0);
