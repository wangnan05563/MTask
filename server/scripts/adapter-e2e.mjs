/**
 * 适配器端到端联调验证：真实运行适配器 TS 代码（HTTP 调用/解析/错误/超时路径），
 * 对接本地 mock AI 服务器（见 mock-ai-server.mjs），断言请求格式与回执解析。
 * 用法：先启动 mock 服务器，再运行本脚本：
 *   node scripts/mock-ai-server.mjs        # 终端 1
 *   node --experimental-strip-types scripts/adapter-e2e.mjs   # 终端 2
 * Node 22.6+ 支持 --experimental-strip-types 直接运行 TS（适配器仅 type-only import，无运行时依赖）。
 */
import { OpenAICompatAdapter } from '../src/adapters/openaiCompat.ts';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import { OllamaAdapter } from '../src/adapters/ollama.ts';
import { WorkBuddyAdapter } from '../src/adapters/workbuddy.ts';

const BASE = process.env.MOCK_BASE ?? 'http://127.0.0.1:18990';
let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

/** 读取 mock 服务器记录的最后一次请求（用于断言请求格式） */
async function lastReq() {
  const r = await fetch(`${BASE}/__last`);
  return r.json();
}

const context = {
  taskId: 't-001',
  title: '实现登录页',
  description: '需要邮箱+密码登录，校验后跳转首页',
  projectName: '冒烟项目',
};

async function main() {
  console.log('== AI 适配器 mock 联调 ==\n');

  // ---- OpenAI 兼容 ----
  console.log('[1] OpenAI 兼容适配器');
  const oa = new OpenAICompatAdapter();
  const t1 = await oa.testConnection({ endpoint: BASE });
  check('testConnection 成功', t1.ok, JSON.stringify(t1));

  const r1 = await oa.send(context, { endpoint: BASE, model: 'deepseek-chat', maxTokens: 256, temperature: 0.5 });
  check('send 成功', r1.ok, JSON.stringify(r1));
  check('回执含 mock 标记', r1.content?.includes('[mock-openai]'));
  check('回执含任务标题', r1.content?.includes('实现登录页'));

  const req1 = await lastReq();
  check('请求路径 /v1/chat/completions', req1.path === '/v1/chat/completions', req1.path);
  check('请求体含 model', req1.body?.model === 'deepseek-chat');
  check('请求体首条为 system 提示', req1.body?.messages?.[0]?.role === 'system');
  check('请求体含 temperature/max_tokens', req1.body?.temperature === 0.5 && req1.body?.max_tokens === 256);
  check('用户消息含任务标题', String(JSON.stringify(req1.body?.messages) ?? '').includes('实现登录页'));

  const rErr = await oa.send(context, { endpoint: BASE, model: 'mock-error' });
  check('上游 500 → ok=false', rErr.ok === false);
  check('错误信息透传', rErr.error?.includes('mock upstream error'), rErr.error);

  const rSlow = await oa.send(context, { endpoint: BASE, model: 'mock-slow', timeoutMs: 500 });
  check('超时 → ok=false', rSlow.ok === false);
  check('超时错误信息可读', /timeout|超时/i.test(rSlow.error ?? ''), rSlow.error);

  // ---- Claude ----
  console.log('\n[2] Claude 适配器');
  const cl = new ClaudeAdapter();
  const t2 = await cl.testConnection({ endpoint: BASE, apiKey: 'sk-test-abc' });
  check('testConnection 成功', t2.ok, JSON.stringify(t2));
  const req2 = await lastReq();
  check('Claude 请求带 x-api-key 头', req2.headers?.['x-api-key'] === 'sk-test-abc');
  check('Claude 请求带 anthropic-version 头', !!req2.headers?.['anthropic-version']);

  const rCl = await cl.send(context, { endpoint: BASE, apiKey: 'sk-test-abc', model: 'claude-3-5-sonnet' });
  check('send 成功', rCl.ok, JSON.stringify(rCl));
  check('回执含 mock-claude', rCl.content?.includes('[mock-claude]'));
  const reqCl = await lastReq();
  check('Claude 请求体含 system 字段', !!reqCl.body?.system);
  check('Claude 请求体 messages 为用户消息', reqCl.body?.messages?.[0]?.role === 'user');
  check('Claude 请求体含 max_tokens', typeof reqCl.body?.max_tokens === 'number');

  const rClErr = await cl.send(context, { endpoint: BASE, apiKey: 'sk-test-abc', model: 'mock-error' });
  check('Claude 400 → ok=false', rClErr.ok === false, rClErr.error);

  // ---- Ollama ----
  console.log('\n[3] Ollama 适配器');
  const ol = new OllamaAdapter();
  const t3 = await ol.testConnection({ endpoint: BASE });
  check('testConnection 成功', t3.ok, JSON.stringify(t3));

  const rOl = await ol.send(context, { endpoint: BASE, model: 'qwen2.5-coder:7b' });
  check('send 成功', rOl.ok, JSON.stringify(rOl));
  check('回执含 mock-ollama', rOl.content?.includes('[mock-ollama]'));
  const reqOl = await lastReq();
  check('Ollama 请求路径 /api/chat', reqOl.path === '/api/chat');
  check('Ollama stream=false', reqOl.body?.stream === false);
  check('Ollama 请求体含模型名', reqOl.body?.model === 'qwen2.5-coder:7b');

  const rOlErr = await ol.send(context, { endpoint: BASE, model: 'mock-error' });
  check('Ollama 500 → ok=false', rOlErr.ok === false, rOlErr.error);

  // ---- WorkBuddy 回调适配器 ----
  console.log('\n[4] WorkBuddy 回调适配器');
  const wb = new WorkBuddyAdapter();
  const wbEndpoint = `${BASE}/mock/workbuddy`;
  const t4 = await wb.testConnection({ endpoint: wbEndpoint });
  check('testConnection 成功', t4.ok, JSON.stringify(t4));

  const rWb = await wb.send(context, { endpoint: wbEndpoint });
  check('send 成功', rWb.ok, JSON.stringify(rWb));
  check('回执含 mock-workbuddy', rWb.content?.includes('[mock-workbuddy]'));
  const reqWb = await lastReq();
  check('请求 action=send', reqWb.body?.action === 'send');
  check('请求含任务标题', String(reqWb.body?.taskTitle ?? '').includes('实现登录页'));
  check('请求上下文含项目名', String(reqWb.body?.user ?? '').includes('冒烟项目'));

  const rWbAcc = await wb.send({ ...context, title: 'accepted 任务' }, { endpoint: wbEndpoint });
  check('accepted → ok=true 占位', rWbAcc.ok === true, JSON.stringify(rWbAcc));
  check('accepted 回执标注待回调', rWbAcc.content?.includes('待回调'));

  const rWbErr = await wb.chat('sys', '内容 mock-error 触发错误', { endpoint: wbEndpoint });
  check('chat 上游 400 → ok=false', rWbErr.ok === false, rWbErr.error);
  check('错误信息透传', rWbErr.error?.includes('mock workbuddy error'), rWbErr.error);

  const listWb = await wb.listModels({ endpoint: wbEndpoint });
  check('listModels 不支持返回 ok=false', listWb.ok === false, JSON.stringify(listWb));

  // ---- WorkBuddy 异步提交 + 轮询 ----
  console.log('\n[5] WorkBuddy 异步提交与轮询');
  const sr = await wb.submit(context, { endpoint: wbEndpoint });
  check('submit 受理成功', sr.ok === true, JSON.stringify(sr));
  check('submit 返回 accepted', sr.accepted === true);
  check('submit 携带 ticket', typeof sr.ticket === 'string' && sr.ticket.length > 0, String(sr.ticket));
  const reqSb = await lastReq();
  check('submit 动作 send_submit', reqSb.body?.action === 'send_submit');

  const pr = await wb.poll(sr.ticket ?? 'tkt-x', { endpoint: wbEndpoint });
  check('poll 成功回执', pr.status === 'success', JSON.stringify(pr));
  check('poll 回执含 mock-workbuddy', pr.content?.includes('[mock-workbuddy]'));

  const prRun = await wb.poll('running-1', { endpoint: wbEndpoint });
  check('poll running 保持等待', prRun.status === 'running', JSON.stringify(prRun));

  const prFail = await wb.poll('fail-1', { endpoint: wbEndpoint });
  check('poll failed → status=failed', prFail.status === 'failed', JSON.stringify(prFail));
  check('poll 失败信息透传', prFail.error?.includes('mock poll failed'), prFail.error);

  const srErr = await wb.submit({ ...context, title: 'submit-error 任务' }, { endpoint: wbEndpoint });
  check('submit 上游错误 → ok=false', srErr.ok === false, srErr.error);
  check('submit 错误透传', srErr.error?.includes('mock submit error'), srErr.error);

  console.log(`\n== 结果：通过 ${pass} / 失败 ${fail} ==`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('联调异常:', e); process.exit(1); });
