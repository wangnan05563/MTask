/**
 * MCP 冒烟编排器：后台启动一个隔离的 server 实例，跑冒烟脚本后自动回收。
 * 用于本地验证 MCP 端点（开发端口默认 39876，避免与用户运行中的打包 App 端口 39877 冲突）。
 *
 * 用法：
 *   node mcp-run.mjs [--port 39876] [--data <目录>] [--token <访问令牌>] [--script <客户端脚本>] [--node <node路径>]
 *
 * 运行时自动探测（历史缺陷：曾硬编码 .workbuddy node 22.22.2 绝对路径，目录改名即失效）：
 *  依次尝试候选 runner 拉起 server/dist——--node 指定路径 → .workbuddy versions 下现行 node →
 *  当前 node → repo electron.exe（ELECTRON_RUN_AS_NODE=1）。打包后 better-sqlite3 是 Electron ABI，
 *  任何本地 node 直跑都会 ERR_DLOPEN_FAILED，此时自动回落到 electron runner（与 m1-regression 同基准）。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, openSync, writeSync, closeSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = arg('port') ?? '39876';
const DATA = arg('data') ?? join(ROOT, 'logs', 'mcp-run', 'data');
const TOKEN = arg('token');
const URL = `http://127.0.0.1:${PORT}/api/mcp`;
const LOGFILE = arg('log') ?? join(ROOT, 'logs', 'mcp-run', 'server.log');
const SERVER_ENTRY = join(ROOT, 'server', 'dist', 'index.js');

// 服务输出写文件，便于失败时复盘（stdio 透传在部分环境不显示子进程输出）
mkdirSync(dirname(LOGFILE), { recursive: true });
let logFd = openSync(LOGFILE, 'w');
const log = (s) => writeSync(logFd, s);

/** .workbuddy 的 node 版本目录名随升级变化（22.22.2 → 22.22.2-3），按 current 链接优先、目录名倒序回落探测 */
function discoverWorkbuddyNode() {
  const versionsDir = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.workbuddy', 'binaries', 'node', 'versions');
  if (!existsSync(versionsDir)) return null;
  const pick = (p) => (existsSync(p) ? p : null);
  const cur = pick(join(versionsDir, 'current', 'node.exe'));
  if (cur) return cur;
  try {
    const dir = readdirSync(versionsDir).filter((d) => /^\d/.test(d)).sort().reverse()
      .map((d) => pick(join(versionsDir, d, 'node.exe'))).find(Boolean);
    return dir ?? null;
  } catch { return null; }
}

/** 候选运行时：显式 --node → workbuddy 现行 node → 当前 node → electron(RUN_AS_NODE) */
function candidateRunners() {
  const list = [];
  const pushNode = (exe, label) => { if (exe && existsSync(exe)) list.push({ kind: 'node', exe, label }); };
  pushNode(arg('node'), '--node');
  pushNode(discoverWorkbuddyNode(), 'workbuddy-node');
  pushNode(process.execPath, 'process.execPath');
  const electronExe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (existsSync(electronExe)) list.push({ kind: 'electron', exe: electronExe, label: 'electron(RUN_AS_NODE)' });
  return list;
}

function spawnInstance(runner) {
  const env = { ...process.env, MTask_PORT: PORT, MTask_DATA_DIR: DATA };
  if (runner.kind === 'electron') env.ELECTRON_RUN_AS_NODE = '1';
  return spawn(runner.exe, [SERVER_ENTRY], { cwd: ROOT, env, shell: false });
}

async function waitReady(child, timeoutMs = 25000) {
  const t0 = Date.now();
  let exited = null;
  child.on('exit', (c) => { exited = c; });
  while (Date.now() - t0 < timeoutMs) {
    if (exited !== null) return { ready: false, exited };
    try {
      const h = TOKEN ? { 'X-Access-Token': TOKEN } : undefined;
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { headers: h });
      if (r.ok) return { ready: true };
    } catch { /* 服务未就绪，重试 */ }
    await sleep(500);
  }
  return { ready: false, reason: 'timeout' };
}

const runners = candidateRunners();
if (!runners.length) {
  console.error('[mcp-run] 无可用运行时（node 与 repo electron.exe 均未找到）');
  process.exit(1);
}

let server = null;
let ready = false;
for (const runner of runners) {
  closeSync(logFd);
  logFd = openSync(LOGFILE, 'w'); // 每个候选重置日志，ABI 失败输出可被下一个候选判读前读取
  console.log(`[mcp-run] 尝试 runner=${runner.label} (${runner.exe})`);
  server = spawnInstance(runner);
  server.stdout.on('data', (d) => log(d));
  server.stderr.on('data', (d) => log(d));
  server.on('error', (e) => log(`[spawn error] ${e.message}\n`));
  const res = await waitReady(server);
  if (res.ready) { ready = true; console.log(`[mcp-run] server 就绪 via ${runner.label}`); break; }
  const dlopen = /ERR_DLOPEN_FAILED/.test(readFileSync(LOGFILE, 'utf8'));
  console.log(`[mcp-run] runner=${runner.label} 未就绪${dlopen ? '（原生模块 ABI 不匹配）' : '（' + (res.exited !== null ? `exit=${res.exited}` : res.reason) + '）'}，尝试下一个候选`);
  try { server.kill('SIGKILL'); } catch { /* 已退出 */ }
}

let code = 1;
try {
  console.log(`[mcp-run] server ready=${ready} at ${URL}`);
  if (!ready) {
    console.log('--- server.log ---');
    console.log(readFileSync(LOGFILE, 'utf8') || '(no log)');
    console.log('--- end ---');
    throw new Error('server did not become ready');
  }
  // 默认跑轻量冒烟 mcp-smoke.mjs；可用 --script 指定其它客户端脚本（如 mcp-full-test.mjs）
  // 客户端为纯 JS（MCP SDK），无原生模块，直接用当前 node
  const script = arg('script') ?? join(ROOT, 'server', 'scripts', 'mcp-smoke.mjs');
  const smokeArgs = [TOKEN ? ['--url', URL, '--token', TOKEN] : ['--url', URL]].flat();
  const smoke = spawn(process.execPath, [script, ...smokeArgs], { stdio: 'inherit', shell: false });
  code = await new Promise((res2) => smoke.on('exit', (c) => res2(c ?? 1)));
} catch (e) {
  console.error('[mcp-run] error:', e.message);
} finally {
  if (server) { try { server.kill('SIGKILL'); } catch { /* noop */ } }
  try { closeSync(logFd); } catch { /* 已关 */ }
}

console.log(`[mcp-run] smoke exit=${code}`);
process.exit(code);
