#!/usr/bin/env node
/**
 * T01698 移动端探针：半屏详情「结果历史 diff/回滚」全链路——
 * 打开任务详情 → 结果历史面板出现 → 回滚 → 二次确认 → 正文回旧版 + 服务端落库。
 * 移动端 UI 由 matchMedia(max-width:820px) 触发 → Chrome 400x850 窗口。
 * 前置：自起隔离 server（端口 39916，fresh dist）；用完连树回收。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 39916, API = `http://127.0.0.1:${PORT}/api`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mtask-t01698-'));
let failures = 0;
const check = (n, p, i) => { if (!p) failures++; console.log(`  [${p ? 'PASS' : 'FAIL'}] ${n}${i ? ' → ' + String(i).slice(0, 200) : ''}`); };

// ---- 隔离 server + 夹具（覆盖写入产生一条历史 V0）
const server = spawn('D:/code/nodejs24/node.exe', [path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'], { cwd: path.join(process.cwd(), 'server'), env: { ...process.env, MTask_DATA_DIR: TMP, MTask_PORT: String(PORT) }, stdio: 'ignore', shell: process.platform === 'win32' });
for (let i = 0; i < 60; i++) { try { const r = await fetch(`${API}/health`); if (r.ok) break; } catch { /* */ } await sleep(500); }
// POST /tasks 不接受 handleResult（创建即带结果本就无「被覆盖前」留档）——先建空结果，两次 PATCH 造两层历史
const task = await (await fetch(`${API}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'sys-inbox', title: '移动端回滚探针', description: 'x' }) })).json();
await fetch(`${API}/tasks/${task.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handleResult: 'V0 旧结果' }) });
await fetch(`${API}/tasks/${task.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handleResult: 'V1 新结果' }) });

// ---- Chrome 移动视口
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--remote-debugging-port=9338', '--headless=new', '--no-first-run', '--disable-gpu', '--window-size=400,850', `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 't01698-'))}`, 'about:blank'], { stdio: 'ignore' });
const bye = () => { try { spawn('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } try { spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } };
process.on('exit', bye);
let targets;
for (let i = 0; i < 30; i++) { try { const r = await fetch('http://127.0.0.1:9338/json/list'); if (r.ok) { targets = await r.json(); break; } } catch { /* */ } await sleep(400); }
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?m=1` }); // ?m=1 强制移动端 UI（resolveUiMode）
await sleep(5000);

// 1) 移动端首页 → 点开任务详情
const s1 = await ev(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 15; i++) {
    const btn = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '').startsWith('任务详情：移动端回滚探针'));
    if (btn) { btn.click(); return 'opened'; }
    await sleep(400);
  }
  return 'row-missing';
})()`);
check('S1 移动端任务详情打开', s1 === 'opened', s1);
const s2 = await ev(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 15; i++) {
    if (document.body.textContent.includes('结果历史（2）')) return 'panel-ok';
    await sleep(400);
  }
  return 'panel-missing';
})()`);
check('S2 结果历史面板出现（2 条留档）', s2 === 'panel-ok', s2);

// 2) 选定对比版本（回滚按钮在选中 diffWith 后才出现）→ 回滚 → 二次确认
const s3 = await ev(`(() => {
  const sel = document.querySelector('select[aria-label="选择历史版本对比"]');
  if (!sel || sel.options.length < 2) return 'select-missing';
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  set.call(sel, sel.options[1].value);
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return 'selected';
})()`);
check('S3a 选定历史对比版本', s3 === 'selected', s3);
await sleep(300);
const s3b = await ev(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => (b.title || '').includes('回滚到该版本'));
  if (!btn) return 'rollback-btn-missing';
  btn.click(); return 'clicked';
})()`);
check('S3 触发回滚', s3b === 'clicked', s3b);
await sleep(600);
const s4 = await ev(`(() => {
  const ok = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '') === '确定：确认执行该操作');
  if (!ok) return 'confirm-missing';
  ok.click(); return 'confirmed';
})()`);
check('S4 二次确认（askConfirm 项目对话框）', s4 === 'confirmed', s4);
await sleep(2000);
const s5 = await ev(`document.body.textContent.includes('V0 旧结果')`);
check('S5 半屏正文回到旧版 V0', s5 === true, s5);
const serverList = await (await fetch(`${API}/tasks?projectId=sys-inbox&archived=false`)).json();
const sv = Array.isArray(serverList) ? serverList.find((t) => t.id === task.id) : null;
check('S6 服务端落库=V0', sv?.handle_result === 'V0 旧结果', sv?.handle_result);

console.log(failures === 0 ? '\n移动端探针全绿 ✔' : `\n${failures} 项失败 ✘`);
ws.close();
process.exit(failures === 0 ? 0 : 1);
