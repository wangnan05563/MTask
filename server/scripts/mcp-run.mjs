/**
 * MCP 冒烟编排器：后台启动一个隔离的 server 实例，跑 mcp-smoke.mjs 后自动回收。
 * 用于本地验证 MCP 端点（开发端口默认 39876，避免与用户运行中的打包 App 端口 39877 冲突）。
 *
 * 用法：
 *   node mcp-run.mjs [--port 39876] [--data <目录>] [--token <访问令牌>]
 *
 * 说明：用 child_process.spawn 派生 node 子进程并 stdio 透传，保证服务是直接子进程，
 * 结束时可精确 kill，不残留孤儿进程（避免之前 PowerShell Start-Process 管理的坑）。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
};

// String.raw 避免 Windows 路径的反斜杠转义，路径含义一目了然
const NODE = arg('node') ?? String.raw`C:\Users\hspcadmin\.workbuddy\binaries\node\versions\22.22.2\node.exe`;
const ROOT = 'D:/code/otherProjects/26_MTask';
const PORT = arg('port') ?? '39876';
const DATA = arg('data') ?? `${ROOT}/logs/mcp-run/data`;
const TOKEN = arg('token');
const LOGFILE = arg('log') ?? `${ROOT}/logs/mcp-run/server.log`;
const URL = `http://127.0.0.1:${PORT}/api/mcp`;

// 服务输出写文件，便于失败时复盘（stdio 透传在部分环境不显示子进程输出）
import { openSync, writeSync, closeSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
mkdirSync(dirname(LOGFILE), { recursive: true });
const logFd = openSync(LOGFILE, 'w');
const log = (s) => writeSync(logFd, s);

const server = spawn(NODE, [`${ROOT}/server/dist/index.js`], {
  env: { ...process.env, MTask_PORT: PORT, MTask_DATA_DIR: DATA },
  shell: false,
});
server.stdout.on('data', (d) => log(d));
server.stderr.on('data', (d) => log(d));
server.on('error', (e) => log(`[spawn error] ${e.message}\n`));
server.on('exit', (c) => log(`[server exit ${c}]\n`));

const waitReady = async (timeoutMs = 25000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return true;
    } catch { /* 服务未就绪，重试 */ }
    await sleep(500);
  }
  return false;
};

let code = 1;
try {
  const ready = await waitReady();
  console.log(`[mcp-run] server ready=${ready} at ${URL}`);
  if (!ready) {
    closeSync(logFd);
    console.log('--- server.log ---');
    console.log(existsSync(LOGFILE) ? readFileSync(LOGFILE, 'utf8') : '(no log)');
    console.log('--- end ---');
    throw new Error('server did not become ready');
  }
  const smokeArgs = [TOKEN ? ['--url', URL, '--token', TOKEN] : ['--url', URL]].flat();
  const smoke = spawn(NODE, [`${ROOT}/server/scripts/mcp-smoke.mjs`, ...smokeArgs], { stdio: 'inherit', shell: false });
  code = await new Promise((resolve) => smoke.on('exit', (c) => resolve(c ?? 1)));
} catch (e) {
  console.error('[mcp-run] error:', e.message);
} finally {
  server.kill('SIGKILL');
  try { closeSync(logFd); } catch {}
}

console.log(`[mcp-run] smoke exit=${code}`);
process.exit(code);