#!/usr/bin/env node
/**
 * T01700 定向 CDP 探针（Chrome headless + 原生 WebSocket）：
 * S5 抽屉打开态跟随外部写入（props-follow 不被守卫误伤）
 * S6 编辑态草稿不被在途刷新吞掉 + 取消后展示最新
 * S7 抽屉保存 → 服务端落库 + 刷新后不回退（applyTaskPatch 时间戳抬升 + 版本守卫）
 * 前置：.workbuddy/t01700-server.mjs 已启动（端口 39913，伺服 fresh dist）。
 * 用法：node .workbuddy/t01700-probe.mjs <taskId>
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CDP = 9333;
const APP = 'http://127.0.0.1:39913';
const API = 'http://127.0.0.1:39913/api';
const TASK_ID = process.argv[2] ?? '';
if (!TASK_ID) { console.error('用法: node t01700-probe.mjs <taskId>'); process.exit(1); }

let failures = 0;
const check = (n, p, i) => { if (!p) failures++; console.log(`  [${p ? 'PASS' : 'FAIL'}] ${n}${i ? ' → ' + String(i).slice(0, 220) : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 't01700-chrome-'))}`, 'about:blank',
], { stdio: 'ignore' });
const bye = () => { try { spawn('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } };
process.on('exit', bye);

async function waitCdp() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${CDP}/json/list`); if (r.ok) return await r.json(); } catch { /* */ }
    await sleep(400);
  }
  throw new Error('CDP 未就绪');
}
const targets = await waitCdp();
const page = targets.find((t) => t.type === 'page');
if (!page?.webSocketDebuggerUrl) throw new Error('无 page target');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let rpcId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params = {}) {
  return new Promise((res) => { const id = ++rpcId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
}
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error('page 异常: ' + JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
}

await send('Page.enable');
// 探针可重复：先把手写痕迹重置回 V0（上轮 S7 会把描述改成 V3）
await fetch(`${API}/tasks/${TASK_ID}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: 'V0 原始描述', handleResult: 'V0 原始结果' }) });
await sleep(300);
await send('Page.navigate', { url: APP });
await sleep(4000);

// step1：跳过使用向导遮罩（若在），等目标行渲染（探针任务预置在默认项目「收件箱」，无需切项目）
const s1 = await evalJs(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 10; i++) {
    const skip = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '跳过');
    if (!skip) break;
    skip.click(); await sleep(300);
  }
  for (let i = 0; i < 25; i++) {
    if (document.querySelector('[data-ttask-id="${TASK_ID}"]')) return 'row-ok';
    await sleep(400);
  }
  return 'row-missing';
})()`);
check('S1 任务行渲染', s1 === 'row-ok', s1);

// step2：点行内抽屉按钮，等抽屉出现
const s2 = await evalJs(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // data-ttask-id 在行内层 div 上，抽屉按钮在同级 task-toolbar 子树——按「同一 li 内」匹配
  const btn = [...document.querySelectorAll('button')].find(b =>
    (b.getAttribute('aria-label') || '').startsWith('展开详情抽屉')
    && b.closest('li')?.querySelector('[data-ttask-id="${TASK_ID}"]'));
  if (!btn) return 'btn-missing';
  btn.click();
  for (let i = 0; i < 20; i++) {
    const dlg = document.querySelector('div[role="dialog"][aria-modal="true"]');
    if (dlg && dlg.textContent.includes('竞态探针任务')) return 'drawer-ok';
    await sleep(300);
  }
  return 'drawer-missing';
})()`);
check('S2 抽屉打开（含 V0 描述）', s2 === 'drawer-ok', s2);
const v0 = await evalJs(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 10; i++) {
    if (document.querySelector('div[role="dialog"][aria-modal="true"]')?.textContent.includes('V0 原始描述')) return true;
    await sleep(300);
  }
  return false;
})()`);
check('S2b 抽屉正文=V0', v0 === true, v0);

// step3（S5）：外部 PATCH → 手动触发 visibilitychange 轮询 → 抽屉应跟随到 V1
await fetch(`${API}/tasks/${TASK_ID}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: 'V1 外部改' }) });
await evalJs(`document.dispatchEvent(new Event('visibilitychange'))`);
await sleep(4500);
const s5 = await evalJs(`document.querySelector('div[role="dialog"][aria-modal="true"]')?.textContent.includes('V1 外部改')`);
check('S5 抽屉打开态跟随外部写入', s5 === true, s5);

// step4（S6）：进入编辑态输草稿 → 外部再改 V2 → 草稿不被吞；取消后展示 V2
const s6a = await evalJs(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const dlg = document.querySelector('div[role="dialog"][aria-modal="true"]');
  const editBtn = [...dlg.querySelectorAll('button')].find(b => b.textContent.includes('编辑描述'));
  if (!editBtn) return 'editbtn-missing';
  editBtn.click();
  for (let i = 0; i < 10; i++) {
    const ta = dlg.querySelector('textarea');
    if (ta) {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(ta, 'V1 外部改 草稿X');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return 'draft-ok';
    }
    await sleep(200);
  }
  return 'textarea-missing';
})()`);
check('S6a 进入编辑态并输入草稿', s6a === 'draft-ok', s6a);
await fetch(`${API}/tasks/${TASK_ID}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: 'V2 外部再改' }) });
await evalJs(`document.dispatchEvent(new Event('visibilitychange'))`);
await sleep(4500);
const s6b = await evalJs(`document.querySelector('div[role="dialog"][aria-modal="true"] textarea')?.value`);
check('S6b 编辑态草稿不被在途刷新吞掉', typeof s6b === 'string' && s6b.includes('草稿X'), JSON.stringify(s6b));
const s6c = await evalJs(`(async () => {
  const dlg = document.querySelector('div[role="dialog"][aria-modal="true"]');
  const cancel = [...dlg.querySelectorAll('button')].find(b => b.textContent.includes('取消'));
  if (!cancel) return 'cancel-missing';
  cancel.click();
  await new Promise(r => setTimeout(r, 400));
  return dlg.textContent.includes('V2 外部再改') ? 'latest-ok' : 'stale';
})()`);
check('S6c 取消编辑后展示最新值', s6c === 'latest-ok', s6c);

// step5（S7）：抽屉保存 → 服务端落库 + 刷新不回退
const s7 = await evalJs(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const dlg = document.querySelector('div[role="dialog"][aria-modal="true"]');
  const editBtn = [...dlg.querySelectorAll('button')].find(b => b.textContent.includes('编辑描述'));
  editBtn.click();
  for (let i = 0; i < 10; i++) {
    const ta = dlg.querySelector('textarea');
    if (ta) {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(ta, 'V3 本地保存');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      break;
    }
    await sleep(200);
  }
  const save = [...dlg.querySelectorAll('button')].find(b => b.textContent.includes('保存'));
  save.click();
  await sleep(1200);
  return 'saved';
})()`);
const serverList = await (await fetch(`${API}/tasks?projectId=sys-inbox&archived=false`)).json();
const serverTask = Array.isArray(serverList) ? serverList.find((t) => t.id === TASK_ID) : null;
check('S7a 抽屉保存落库', s7 === 'saved' && serverTask?.description === 'V3 本地保存', serverTask?.description);
await evalJs(`document.dispatchEvent(new Event('visibilitychange'))`);
await sleep(4500);
const s7b = await evalJs(`document.querySelector('div[role="dialog"][aria-modal="true"]')?.textContent.includes('V3 本地保存')`);
check('S7b 刷新后抽屉仍显示本地保存值（不回退）', s7b === true, s7b);

console.log(failures === 0 ? '\n探针全绿 ✔' : `\n${failures} 项失败 ✘`);
ws.close();
process.exit(failures === 0 ? 0 : 1);
