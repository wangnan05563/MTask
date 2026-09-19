// T00779 断言：流式生成 finish_reason=length 截断检测
// 策略：① 本地 mock OpenAI 兼容流式服务（强制 finish_reason=length）→ 断言 adapter 判失败；
//      ② 隔离实例真实 AGNES + 极小 maxTokens 触发截断 → 断言 SSE 只有 error 无 done；
//      ③ 正常 maxTokens 回归 → 断言 SSE 有 done（不因新增判��而误伤）。
import { createServer } from 'node:http';

const BASE = process.argv[2] ?? 'http://127.0.0.1:39906';
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`PASS ${name} :: ${detail}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};
const api = async (m, p, b) => {
  const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => null) };
};

// ---------- ① mock 流式服务：验证 adapter 层判定 ----------
const mock = createServer((req, res) => {
  if (!req.url?.includes('/chat/completions')) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '半截PRD内容' } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise((r) => mock.listen(39999, '127.0.0.1', r));

const { getAdapter } = await import(new URL('../server/dist/adapters/index.js', import.meta.url).href);
const adapter = getAdapter('openai-compatible');
const truncated = await adapter.chatStream('sys', 'user',
  { type: 'openai-compatible', endpoint: 'http://127.0.0.1:39999/v1', apiKey: 'k', model: 'm' }, () => undefined);
check('T-1 mock 截断：ok=false', truncated.ok === false, `ok=${truncated.ok}`);
check('T-2 mock 截断：错误文案含「被截断」', (truncated.error ?? '').includes('被截断'), truncated.error?.slice(0, 80));

// 对照：正常 finish_reason=stop 应成功
const mockOk = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '完整内容' } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise((r) => mockOk.listen(39998, '127.0.0.1', r));
const ok2 = await adapter.chatStream('sys', 'user',
  { type: 'openai-compatible', endpoint: 'http://127.0.0.1:39998/v1', apiKey: 'k', model: 'm' }, () => undefined);
check('T-3 正常结束不被误判截断', ok2.ok === true && ok2.content === '完整内容', `ok=${ok2.ok} content=${ok2.content}`);
mock.close(); mockOk.close();

// ---------- ②/③ 真实链路（AGNES，极小 vs 正常 maxTokens） ----------
let key = '';
try {
  const { readFileSync } = await import('node:fs');
  key = /api_key:\s*"([^"]+)"/.exec(readFileSync(`${process.env.USERPROFILE}/.workbuddy/skills/agnes-image-2.5-flash/config.yaml`, 'utf8'))?.[1] ?? '';
} catch { /* 无 key 则跳过真实段 */ }

if (!key) {
  console.log('SKIP 真实链路段（未取到 AGNES key）');
} else {
  const proj = (await api('POST', '/api/projects', { name: `T00779-${Date.now() % 100000}` })).json;
  const mkTool = async (maxTokens, name) => (await api('POST', '/api/aitools', {
    name, type: 'openai-compatible', purpose: 'develop',
    endpoint: 'https://apihub.agnes-ai.com/v1', apiKey: key, model: 'agnes-2.5-flash',
    maxTokens, timeoutMs: 600000, remark: 'T00779 截断验证临时配置',
  })).json;
  const tiny = await mkTool(30, 'agnes-tiny-T00779');
  const norm = await mkTool(16384, 'agnes-normal-T00779');

  const runStream = async (toolId) => {
    const md = Buffer.from('# 需求\n\n请输出一份完整的售后服务 PRD，含功能需求、状态机、接口需求、异常处理、数据定义等完整章节。').toString('base64');
    const res = await fetch(`${BASE}/api/plans/prd-generate-stream?projectId=${proj.id}&toolId=${toolId}&filename=req.md`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contentBase64: md }) });
    return res.text();
  };

  const tinyText = await runStream(tiny.id);
  check('T-4 极小 maxTokens：SSE 产出 error', tinyText.includes('event: error'), tinyText.split('\n').filter((l) => l.startsWith('data:')).slice(-1)[0]?.slice(0, 90) ?? '(无)');
  check('T-5 极小 maxTokens：无 done（防半截入库）', !tinyText.includes('event: done'), '');

  const normText = await runStream(norm.id);
  check('T-6 正常 maxTokens：仍产出 done（不误伤）', normText.includes('event: done'), '');
}

console.log(`==== T00779 SUMMARY: ${pass}/${pass + fail} passed ====`);
process.exit(fail > 0 ? 1 : 0);
