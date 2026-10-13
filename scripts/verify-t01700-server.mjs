#!/usr/bin/env node
/** T01700 探针服务端：隔离实例（临时目录 + 端口 39913），伺服 fresh web/dist，预置项目+任务后常驻，供 CDP/Playwright 驱动。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = 39913;
const BASE = `http://127.0.0.1:${PORT}/api`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mtask-t01700-'));
const REPO = process.cwd();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHealth(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return true; } catch { /* 未就绪 */ }
    await sleep(500);
  }
  return false;
}

// 启动器按 native 模块 ABI 探测（打包.bat 会把 better-sqlite3 重编译成 Electron ABI，
// 此时 process.execPath 直跑会 ERR_DLOPEN_FAILED）——见 isolated-server-launcher.mts
const { resolveServerLauncher } = await import(pathToFileURL(path.join(REPO, 'scripts/isolated-server-launcher.mts')).href);
const LAUNCHER = resolveServerLauncher(REPO, path.join(REPO, 'server', 'src', 'index.ts'));
const server = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: REPO,
  env: { ...process.env, ...LAUNCHER.env, MTask_DATA_DIR: TMP, MTask_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
console.log(`隔离实例启动器：${LAUNCHER.label}`);
server.stdout.on('data', (d) => process.stdout.write('[srv] ' + d));
server.stderr.on('data', (d) => process.stdout.write('[srv-err] ' + d));

if (!(await waitHealth())) { console.error('server 启动超时'); process.exit(1); }

// 预置：项目 + 任务（带描述与处理结果）
const proj = await (await fetch(`${BASE}/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'T01700探针' }) })).json();
const task = await (await fetch(`${BASE}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: proj.id, title: '竞态探针任务', description: 'V0 原始描述', handleResult: 'V0 原始结果' }) })).json();
console.log('PROBE_READY ' + JSON.stringify({ port: PORT, projectId: proj.id, taskId: task.id, taskNo: task.task_no, pid: server.pid }));
// 常驻：父进程（探针驱动脚本）退出时由 taskkill 连树回收
setInterval(() => { /* keepalive */ }, 30000);
