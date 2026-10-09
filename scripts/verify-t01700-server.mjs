#!/usr/bin/env node
/** T01700 探针服务端：隔离实例（临时目录 + 端口 39913），伺服 fresh web/dist，预置项目+任务后常驻，供 CDP/Playwright 驱动。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

const NODE24 = process.platform === 'win32' ? 'D:/code/nodejs24/node.exe' : process.execPath;
const server = spawn(NODE24, [path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'], {
  cwd: path.join(REPO, 'server'),
  env: { ...process.env, MTask_DATA_DIR: TMP, MTask_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32',
});
server.stdout.on('data', (d) => process.stdout.write('[srv] ' + d));
server.stderr.on('data', (d) => process.stdout.write('[srv-err] ' + d));

if (!(await waitHealth())) { console.error('server 启动超时'); process.exit(1); }

// 预置：项目 + 任务（带描述与处理结果）
const proj = await (await fetch(`${BASE}/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'T01700探针' }) })).json();
const task = await (await fetch(`${BASE}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: proj.id, title: '竞态探针任务', description: 'V0 原始描述', handleResult: 'V0 原始结果' }) })).json();
console.log('PROBE_READY ' + JSON.stringify({ port: PORT, projectId: proj.id, taskId: task.id, taskNo: task.task_no, pid: server.pid }));
// 常驻：父进程（探针驱动脚本）退出时由 taskkill 连树回收
setInterval(() => { /* keepalive */ }, 30000);
