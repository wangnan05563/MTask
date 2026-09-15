#!/usr/bin/env node
/**
 * T00620 验证脚本：AI 处理状态的终态与中断兜底
 *
 * 在**隔离环境**（临时数据目录 + 独立端口）起一个 MTask server，端到端验证两项修复：
 * 1) 读取待办任务自动置 running 只在「从未处理过」时发生 —— 写 unread / ''（已读清空）后
 *    再读**不再回弹 running**（原缺陷：任务处理完仍显示转圈）；
 * 2) running 超时惰性过期 —— 把 ai_state_at 回拨到阈值之前，读取列表即自动置 **failed**
 *    （覆盖 Agent 进程被杀/会话中断导致的永久转圈）。
 *
 * 用法：node scripts/verify-ai-state.js
 * 依赖：server 需已 build（dist）或走 tsx；本脚本用 npx tsx 起 src/index.ts。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 39911;
const BASE = `http://127.0.0.1:${PORT}/api`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mtask-aistate-'));
const REPO = path.resolve(__dirname, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function check(name, cond, extra) {
  const flag = cond ? 'PASS' : 'FAIL';
  if (!cond) failures += 1;
  console.log(`  [${flag}] ${name}${extra ? ' → ' + extra : ''}`);
}

async function waitHealth(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch (_) { /* 未就绪，继续等 */ }
    await sleep(500);
  }
  return false;
}

// --- 极简 MCP 客户端（streamable HTTP） ---
let sessionId = '';
async function mcp(method, params, id) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  // 响应可能是 SSE（data: {...}）或纯 JSON
  const line = text.split('\n').find((l) => l.startsWith('data: ')) || text;
  const body = JSON.parse(line.replace(/^data: /, ''));
  return body;
}

async function callTool(name, args, id) {
  const body = await mcp('tools/call', { name, arguments: args }, id);
  const content = body?.result?.content?.[0]?.text ?? '';
  try { return JSON.parse(content); } catch { return content; }
}

(async () => {
  console.log(`[setup] 临时数据目录: ${TMP}`);
  const server = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsx', 'src/index.ts'],
    {
      cwd: path.join(REPO, 'server'),
      env: { ...process.env, MTask_DATA_DIR: TMP, MTask_PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
  const logs = [];
  server.stdout.on('data', (d) => logs.push(String(d)));
  server.stderr.on('data', (d) => logs.push(String(d)));

  try {
    if (!(await waitHealth())) throw new Error('服务启动超时：\n' + logs.join(''));

    // 准备：项目 + 待办任务（直接写库更稳：REST 建项目 → REST 建任务）
    const proj = await (await fetch(`${BASE}/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'AI 状态验证项目' }),
    })).json();
    const task = await (await fetch(`${BASE}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: proj.id, title: '验证：状态终态与超时兜底' }),
    })).json();
    const taskNo = task.task_no;
    console.log(`[setup] 任务 ${taskNo}（${task.id}）已创建`);

    await mcp('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '1.0' },
    }, 1);
    await mcp('notifications/initialized', {}, 2);

    console.log('\n[场景1] 仅查看不再自动转圈；显式 markRunning 才置 running（T00620）');
    let t = await callTool('mtask_get_task', { taskNo }, 3);
    check('仅查看不置 running', t.ai_state === '', `ai_state='${t.ai_state}'`);
    t = await callTool('mtask_get_task', { taskNo, markRunning: true }, 31);
    check('markRunning:true 显式置 running', t.ai_state === 'running', `ai_state=${t.ai_state}`);
    check('记录状态时间戳', !!t.ai_state_at, `ai_state_at=${t.ai_state_at}`);

    console.log('\n[场景2] 处理完成写 unread → 再读不回弹 running（本次修复）');
    await callTool('mtask_write_task_status', { taskNo, state: 'unread' }, 4);
    t = await callTool('mtask_get_task', { taskNo }, 5);
    check('unread 不被读取抹掉', t.ai_state === 'unread', `ai_state=${t.ai_state}`);

    console.log('\n[场景3] 用户已读清空（置空串）→ 再读不回弹 running');
    await fetch(`${BASE}/tasks/${task.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aiState: '' }),
    });
    t = await callTool('mtask_get_task', { taskNo }, 6);
    check('已读清空后保持空', t.ai_state === '', `ai_state='${t.ai_state}'`);
    check('已读清空后仍保留处理痕迹（ai_state_at）', !!t.ai_state_at);

    console.log('\n[场景4] 中断兜底：running 超时 → 自动 failed（本次修复）');
    await callTool('mtask_write_task_status', { taskNo, state: 'running' }, 7);
    // 回拨 ai_state_at 到阈值之前（默认 10 分钟；回拨 30 分钟）
    const Database = require(path.join(REPO, 'node_modules', 'better-sqlite3'));
    const dbf = path.join(TMP, 'mtask.db');
    const db = new Database(dbf);
    const backdated = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    db.prepare('UPDATE tasks SET ai_state = ?, ai_state_at = ? WHERE id = ?').run('running', backdated, task.id);
    const before = db.prepare('SELECT ai_state, ai_state_at FROM tasks WHERE id = ?').get(task.id);
    console.log(`  （已回拨 ai_state_at → ${before.ai_state_at}）`);
    db.close();

    // 列表读取触发惰性过期
    const listed = await (await fetch(`${BASE}/tasks?projectId=${proj.id}`)).json();
    const row = Array.isArray(listed) ? listed.find((x) => x.task_no === taskNo) : null;
    check('超时 running 自动置 failed', row && row.ai_state === 'failed', `ai_state=${row && row.ai_state}`);

    const db2 = new Database(dbf);
    const persisted = db2.prepare('SELECT ai_state FROM tasks WHERE id = ?').get(task.id);
    db2.close();
    check('失败态已落库（非仅返回值）', persisted.ai_state === 'failed', `db=${persisted.ai_state}`);

    console.log('\n[场景5] failed 是稳定终态：再读不回弹 running');
    t = await callTool('mtask_get_task', { taskNo }, 8);
    check('failed 不被读取抹掉', t.ai_state === 'failed', `ai_state=${t.ai_state}`);

    console.log(`\n结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'}`);
  } catch (e) {
    failures += 1;
    console.error('[error]', e.message);
    console.error('[server logs]\n' + logs.join(''));
  } finally {
    server.kill();
    await sleep(500);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* 忽略清理失败 */ }
    process.exit(failures === 0 ? 0 : 1);
  }
})();
