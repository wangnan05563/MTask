// T01346 隔离验证：openaiCompat baseUrl 版本段补齐口径 + 404 可操作提示
// 起本地 http 服务记录真实请求路径，不联网、不触碰生产库。
import * as http from 'node:http';
import { OpenAICompatAdapter } from '../server/src/adapters/openaiCompat';

const seen: string[] = [];
const okServer = http.createServer((req, res) => {
  seen.push(req.url ?? '');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
});
const notFoundServer = http.createServer((_req, res) => {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

const listen = (s: http.Server, port: number) => new Promise<void>((r) => s.listen(port, '127.0.0.1', r));

let fail = 0;
const check = (name: string, cond: boolean, extra?: string) => {
  if (!cond) fail++;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${extra ? ' → ' + extra : ''}`);
};

async function main() {
  await listen(okServer, 18991);
  await listen(notFoundServer, 18992);
  const ad = new OpenAICompatAdapter();
  const base = 'http://127.0.0.1:18991';

  const cases: Array<[string, string]> = [
    [`${base}`, '/v1/chat/completions'],
    [`${base}/`, '/v1/chat/completions'],
    [`${base}/v1`, '/v1/chat/completions'],
    [`${base}/v1/`, '/v1/chat/completions'],
    [`${base}/api/paas/v4`, '/api/paas/v4/chat/completions'], // 智谱：修复核心
    [`${base}/api/paas/v4/`, '/api/paas/v4/chat/completions'],
    [`${base}/v1beta`, '/v1beta/chat/completions'],
    [`${base}/v2`, '/v2/chat/completions'],
  ];
  for (const [endpoint, want] of cases) {
    seen.length = 0;
    const r = await ad.chat('s', 'u', { endpoint, model: 'm', timeoutMs: 5000 });
    check(`endpoint=${endpoint.replace(base, '<base>') || '<base>'} → ${want}`,
      r.ok === true && seen[0] === want, `实际 ${seen[0] ?? '(无请求)'}`);
  }

  // 404 提示：应带可操作说明而非裸状态码
  const r404 = await ad.chat('s', 'u', { endpoint: 'http://127.0.0.1:18992/v1', model: 'm', timeoutMs: 5000 });
  check('404 时 ok=false', r404.ok === false);
  check('404 文案含可操作提示', (r404.error ?? '').includes('404 多为') && (r404.error ?? '').includes('版本段'), r404.error ?? '');

  okServer.close();
  notFoundServer.close();
  console.log(fail === 0 ? '\nALL PASS' : `\nHAS FAILURE (${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
