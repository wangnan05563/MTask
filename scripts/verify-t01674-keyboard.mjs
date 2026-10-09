#!/usr/bin/env node
/** T01674 键盘探针：项目管理页 Tab 序列可达「导入 Excel」+ 焦点环。前置：t01700-server.mjs 常驻（39913，fresh dist）。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--remote-debugging-port=9337', '--headless=new', '--no-first-run', '--disable-gpu', `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 't01674-'))}`, 'about:blank'], { stdio: 'ignore' });
let targets;
for (let i = 0; i < 30; i++) { try { const r = await fetch('http://127.0.0.1:9337/json/list'); if (r.ok) { targets = await r.json(); break; } } catch { /* */ } await sleep(400); }
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:39913' });
await sleep(4500);

// 进项目管理页（有计划工具栏的项目），跳过向导
await ev(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 10; i++) { const s = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '跳过'); if (!s) break; s.click(); await sleep(250); }
  const nav = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '项目管理');
  if (nav) nav.click();
  await sleep(1200);
  return 'nav-ok';
})()`);

// 真 Tab 循环（CDP Input 域），最多 150 次，记录是否命中「导入 Excel」
let hit = -1;
const focused = [];
for (let i = 0; i < 150; i++) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  const info = await ev(`(() => {
    const ae = document.activeElement;
    if (!ae) return 'none';
    const lbl = ae.closest('label');
    const al = lbl?.getAttribute('aria-label') || ae.getAttribute('aria-label') || '';
    return ae.tagName + '|' + (ae.type || '') + '|' + al;
  })()`);
  if (typeof info === 'string' && info.includes('导入 Excel') && info.startsWith('INPUT|file')) { hit = i + 1; break; }
  if (i < 12) focused.push(info);
}
console.log(hit > 0 ? `  [PASS] Tab ${hit} 次命中「导入 Excel」file input → ${focused.length ? '前几站: ' + focused.join(' ; ') : ''}` : `  [FAIL] Tab 150 次未命中 → 前几站: ${focused.join(' ; ')}`);
await sleep(600); // 等 opacity 0→1 过渡（0.2s）走完，避免读到过渡中间态
const ring = await ev(`(() => {
  const ae = document.activeElement;
  const lbl = ae?.closest('label');
  if (!lbl) return 'no-label';
  const cs = getComputedStyle(lbl);
  return 'outline=' + cs.outlineStyle + '/' + cs.outlineWidth + ' opacity=' + cs.opacity + ' visibility=' + cs.visibility;
})()`);
console.log(hit > 0 ? `  [${/outline=solid/.test(ring) && !/opacity=0/.test(ring) ? 'PASS' : 'FAIL'}] 命中后焦点环/显隐 → ${ring}` : `  [SKIP] 焦点环未测`);
process.exit(hit > 0 ? 0 : 1);
