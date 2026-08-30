/**
 * 零依赖 Mock AI 服务器：模拟 OpenAI 兼容 / Claude / Ollama 三种协议端点。
 * 用途：让 MTask 真实适配器代码（HTTP 链路）在无外网/无 API Key 环境下联调验证。
 * 特殊触发（通过 body.model）：
 *   - mock-error：返回 500/400 错误
 *   - mock-slow：延迟 2500ms 响应（测超时）
 * GET /__last 返回最后一次请求记录（method/path/headers/body），供 e2e 断言请求格式。
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 18990);

let lastRequest = { method: null, path: null, headers: null, body: null };

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : null); } catch { resolve(data); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const body = req.method === 'POST' ? await readBody(req) : null;

  // /__last 返回上一次「真实请求」的记录（自身不写入，避免自我污染）
  if (url.pathname === '/__last') return send(res, 200, lastRequest);
  lastRequest = { method: req.method, path: url.pathname, headers: req.headers, body };

  // 连接测试端点
  if (url.pathname === '/v1/models') return send(res, 200, { object: 'list', data: [{ id: 'mock-model' }] });
  if (url.pathname === '/api/tags') return send(res, 200, { models: [{ name: 'mock:latest' }] });

  // OpenAI 兼容 /chat/completions
  if (url.pathname === '/v1/chat/completions') {
    if (body?.model === 'mock-error') return send(res, 500, { error: { message: 'mock upstream error' } });
    if (body?.model === 'mock-slow') {
      setTimeout(() => send(res, 200, { choices: [{ message: { content: 'delayed' } }] }), 2500);
      return;
    }
    const userMsg = body?.messages?.findLast?.((m) => m.role === 'user')?.content ?? '';
    const title = String(userMsg).split('\n')[1] ?? '未知';
    return send(res, 200, { choices: [{ message: { content: `[mock-openai] 已处理任务: ${title}` } }] });
  }

  // Claude /v1/messages
  if (url.pathname === '/v1/messages') {
    if (body?.model === 'mock-error') return send(res, 400, { error: { message: 'mock claude error' } });
    return send(res, 200, { content: [{ type: 'text', text: `[mock-claude] 模型=${body?.model}` }] });
  }

  // Ollama /api/chat
  if (url.pathname === '/api/chat') {
    if (body?.model === 'mock-error') return send(res, 500, { error: 'mock ollama error' });
    return send(res, 200, { message: { content: '[mock-ollama] 本地推理结果' } });
  }

  // WorkBuddy 中继 mock 端点：遵循 workbuddy 适配器的约定 JSON 契约
  if (url.pathname === '/mock/workbuddy') {
    if (body?.action === 'ping') return send(res, 200, { ok: true, message: 'mock workbuddy ok' });
    // 异步提交：默认返回受理+ticket；user 含 submit-error 时报错
    if (body?.action === 'send_submit') {
      if (String(body?.user ?? '').includes('submit-error')) return send(res, 400, { ok: false, error: 'mock submit error' });
      return send(res, 200, { ok: true, accepted: true, ticket: `tkt-${Date.now()}` });
    }
    // 异步轮询：按 ticket 关键字区分 running / failed / success
    if (body?.action === 'send_poll') {
      const t = String(body?.ticket ?? '');
      if (t.includes('fail')) return send(res, 200, { status: 'failed', error: 'mock poll failed' });
      if (t.includes('running')) return send(res, 200, { status: 'running' });
      return send(res, 200, { status: 'success', content: `[mock-workbuddy] poll done: ${t}` });
    }
    // 触发异步占位：user 内容含 accepted
    if (String(body?.user ?? '').includes('accepted')) return send(res, 200, { ok: true, accepted: true });
    // 触发错误：user 内容含 mock-error
    if (String(body?.user ?? '').includes('mock-error')) return send(res, 400, { ok: false, error: 'mock workbuddy error' });
    const title = String(body?.taskTitle ?? '') || (String(body?.user ?? '').split('\n')[1] ?? '未知');
    return send(res, 200, { ok: true, content: `[mock-workbuddy] 已派发: ${title}` });
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => console.log(`[mock-ai] listening on http://127.0.0.1:${PORT}`));
