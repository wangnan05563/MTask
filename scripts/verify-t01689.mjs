#!/usr/bin/env node
/**
 * T01689 验证脚本：mtask_list_plans 增补 deps / reqIds / complexity + withDeps/withReqAnchors 计数。
 * 隔离环境（临时数据目录 + 独立端口 39912）：MCP 建项目/计划 → PATCH deps → sqlite 兜 req_ids（隔离夹具）
 * → 断言完整模式/brief 模式字段与 meta 计数 → 32 条计划全量响应不截断实测。
 * 用法：node scripts/verify-t01689.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = 39912;
const BASE = `http://127.0.0.1:${PORT}/api`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mtask-t01689-'));
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra) {
  const flag = cond ? 'PASS' : 'FAIL';
  if (!cond) failures += 1;
  console.log(`  [${flag}] ${name}${extra ? ' → ' + extra : ''}`);
}

async function waitHealth(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return true; } catch { /* 未就绪 */ }
    await sleep(500);
  }
  return false;
}

let sessionId = '';
let rpcId = 0;
async function mcpRaw(payload) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(payload),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  // SSE 单帧可能被拆成多个 data: 片段（T01490/T00978 教训）：累积后整体解析
  const frames = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
  let latest;
  try { latest = JSON.parse(frames || text); } catch { latest = undefined; }
  return latest;
}
async function mcpInit() {
  const body = await mcpRaw({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify-t01689', version: '1.0' },
  } });
  await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return body;
}
async function callTool(name, args) {
  const body = await mcpRaw({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });
  if (body?.error) throw new Error('rpc error: ' + JSON.stringify(body.error).slice(0, 300));
  if (body?.result?.isError) throw new Error('tool error: ' + JSON.stringify(body.result).slice(0, 300));
  // ok(text, meta) 结构：content[0].text 是给 LLM 的 JSON 字符串，meta 全量在 structuredContent（含 plans/count）
  const sc = body?.result?.structuredContent;
  if (sc && Object.keys(sc).length > 0) return sc;
  const content = body?.result?.content?.[0]?.text ?? '';
  try { return JSON.parse(content); } catch { throw new Error('content 非 JSON: ' + String(content).slice(0, 200)); }
}

// 工作区 better-sqlite3 当前为 Node24 ABI（T01569 打包链遗留），node22 加载会 ERR_DLOPEN_FAILED——
// 优先用 D:/code/nodejs24 启动服务端；回退当前 node（ABI 匹配时）。
// 启动器按 native 模块 ABI 探测（打包.bat 会把 better-sqlite3 重编译成 Electron ABI，
// 此时 process.execPath 直跑会 ERR_DLOPEN_FAILED）——见 isolated-server-launcher.mts
const { resolveServerLauncher } = await import(pathToFileURL(path.join(REPO, 'scripts/isolated-server-launcher.mts')).href);
const LAUNCHER = resolveServerLauncher(REPO, path.join(REPO, 'server', 'src', 'index.ts'));
const server = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: REPO, env: { ...process.env, ...LAUNCHER.env, MTask_DATA_DIR: TMP, MTask_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
console.log(`隔离实例启动器：${LAUNCHER.label}`);
const logs = [];
server.stdout.on('data', (d) => logs.push(String(d)));
server.stderr.on('data', (d) => logs.push(String(d)));

try {
  if (!(await waitHealth())) throw new Error('服务启动超时：\n' + logs.join(''));
  await mcpInit(); // MCP 会话握手（initialize + initialized），否则 tools/call 报 no valid session

  // 1) 建项目
  const projRes = await fetch(`${BASE}/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'T01689验证' }),
  });
  const proj = await projRes.json();
  check('建项目成功', !!proj.id, proj.id ?? JSON.stringify(proj).slice(0, 120));

  // 2) MCP 建 32 条计划（首条里程碑；带 complexity）
  const items = [];
  for (let i = 0; i < 32; i++) {
    items.push({
      title: i === 0 ? 'M1 里程碑' : `W1.${i} 工作项`,
      kind: i === 0 ? 'milestone' : 'normal',
      complexity: (i % 5) + 1,
    });
  }
  const created = await callTool('mtask_create_plans', { projectId: proj.id, items });
  check('批量建计划 32 条', created.inserted === 32 && Array.isArray(created.ids) && created.ids.length === 32,
    `inserted=${created.inserted}`);

  // 3) deps：REST PATCH（body {deps: JSON字符串}）
  const depsPatch = await fetch(`${BASE}/plans/${created.ids[1]}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deps: JSON.stringify([{ id: created.ids[0], type: 'serial' }]) }),
  });
  check('PATCH deps 成功', depsPatch.ok, `HTTP ${depsPatch.status}`);

  // 4) req_ids：隔离夹具直写 plan_tasks（仅测试库，非生产回写）
  const Database = require('better-sqlite3');
  const db = new Database(path.join(TMP, 'mtask.db'));
  db.prepare('UPDATE plan_tasks SET req_ids = ? WHERE id = ?')
    .run(JSON.stringify(['REQ-001', 'REQ-002']), created.ids[2]);
  db.close();

  // 5) 完整模式断言
  const full = await callTool('mtask_list_plans', { projectId: proj.id });
  check('完整模式 count=32', full.count === 32, `count=${full.count}（响应 ${JSON.stringify(full).length} 字节，未截断）`);
  const p1 = full.plans.find((p) => p.id === created.ids[1]);
  const p2 = full.plans.find((p) => p.id === created.ids[2]);
  const p0 = full.plans.find((p) => p.id === created.ids[0]);
  check('deps 解析为数组结构', Array.isArray(p1.deps) && p1.deps.length === 1 && p1.deps[0].id === created.ids[0] && p1.deps[0].type === 'serial',
    JSON.stringify(p1.deps));
  check('reqIds 解析为数组', Array.isArray(p2.reqIds) && p2.reqIds.join(',') === 'REQ-001,REQ-002', JSON.stringify(p2.reqIds));
  check('complexity 露出（数值）', typeof p0.complexity === 'number' && p0.complexity >= 1 && p0.complexity <= 5, `p0.complexity=${p0.complexity}`);
  check('旧字段保留（只增不改名）', 'id' in p0 && 'title' in p0 && 'startDate' in p0 && 'durationDays' in p0 && 'progress' in p0 && 'status' in p0 && 'assignee' in p0 && 'linkedTaskNo' in p0, '');
  check('meta.withDeps=1', full.withDeps === 1, `withDeps=${full.withDeps}`);
  check('meta.withReqAnchors=1', full.withReqAnchors === 1, `withReqAnchors=${full.withReqAnchors}`);

  // 6) brief 模式断言
  const brief = await callTool('mtask_list_plans', { projectId: proj.id, brief: true });
  const b1 = brief.plans.find((p) => p.id === created.ids[1]);
  const b2 = brief.plans.find((p) => p.id === created.ids[2]);
  check('brief count=32', brief.count === 32, `count=${brief.count}`);
  check('brief 回 depsCount', b1.depsCount === 1, `depsCount=${b1.depsCount}`);
  check('brief 回 reqIdsCount', b2.reqIdsCount === 2, `reqIdsCount=${b2.reqIdsCount}`);
  check('brief 不回全量 deps/reqIds（省体量）', !('deps' in b1) && !('reqIds' in b2), '');
  check('brief meta 计数', brief.withDeps === 1 && brief.withReqAnchors === 1, `withDeps=${brief.withDeps}, withReqAnchors=${brief.withReqAnchors}`);

  console.log(failures === 0 ? '\n全部断言通过 ✔' : `\n${failures} 项断言失败 ✘`);
} catch (e) {
  failures += 1;
  console.error('验证脚本异常:', e?.message ?? e);
  console.error((logs.join('')).slice(-1500));
} finally {
  server.kill('SIGTERM');
  await sleep(800);
  // Windows shell:true 下 kill 只杀 shell 不杀子进程——按 PID 连树强杀，防端口残留（实测坑）
  if (process.platform === 'win32' && server.pid) {
    try { spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
    await sleep(500);
  }
  try { server.kill('SIGKILL'); } catch { /* 已退出 */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 文件占用：留待系统清理 */ }
}
process.exit(failures === 0 ? 0 : 1);
