#!/usr/bin/env node
/**
 * T01674 键盘探针：项目管理页 Tab 序列可达 Excel 导入入口 + 焦点环可见。
 *
 * T02293 判据落地：
 *  - 行为腿只认结构：真实 Tab 序列能聚焦 `input[type=file][accept*=".xlsx"]`，且聚焦后容器
 *    （closest label）显示可见焦点环（outline solid ≥1px + opacity≈1 + visibility:visible）；
 *  - 入口定位不读中文文案：预种向导已读键避开遮罩，经产品跨页事件 `mtaskNavigate` 切页；
 *    命中判据不看 aria-label，运行期可访问名仅作证据；
 *  - 保留的产品字面锚「导入 Excel」进 `okPair` 字面腿（取证面 `git show HEAD:`），行为腿为上述
 *    Tab 可达性；红时区分「行为失守」与「字面锚点失配（行为在）」；
 *  - N 组负对照：空源码、逐字改名、行为假契约、file→text/缺 accept 结构破坏、焦点环三形态破坏。
 *
 * 前置：无外部常驻服务——门内自起隔离实例（临时 DATA_DIR + 端口，伺服 web/dist），退出回收。
 * 用法：node scripts/verify-t01674-keyboard.mjs
 *   环境变量：T01674_PORT（默认 39913）、T01674_CDP（默认 9337）、T01674_CHROME（Chrome 可执行文件）
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 临时根必须落 D:（C: 常年 0 可用，SQLITE_FULL 会伪装成产品失败）
const TMP_ROOT = existsSync('D:/code/tmp') ? 'D:/code/tmp' : tmpdir();
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't01674-data-'));
const CHROME_PROFILE = mkdtempSync(join(TMP_ROOT, 't01674-chrome-'));
const PORT = Number(process.env.T01674_PORT ?? 39913);
const CDP = Number(process.env.T01674_CDP ?? 9337);
const CHROME = process.env.T01674_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { resolveServerLauncher } = await import(pathToFileURL(join(ROOT, 'scripts/isolated-server-launcher.mts')).href);
const { okPair } = await import(pathToFileURL(join(ROOT, 'scripts/lib/anchor-pair.mts')).href);

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra).toString().slice(0, 400)}` : ''}`);
  }
};

// 字面腿取证面固定 HEAD（反模式 11：不读工作树，避免并发 WIP 冒充已提交口径）
const headSource = (rel) => {
  try {
    return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return '';
  }
};
const SRC = headSource('web/src/pages/PlanPage.tsx');
// 字面锚必须落在「包住 .xlsx file input 的 label」上，而不是任意按钮上的同名文案
const literalOf = (src) => /<label[^>]*aria-label="导入 Excel"[^>]*>[\s\S]{0,600}?<input type="file" accept="\.xlsx"/.test(src);

// 结构判据（负对照复用）：只认 input 类型与 accept 事实，不认可访问名文案
const isExcelFileInput = (r) => !!r && r.tag === 'INPUT' && r.type === 'file' && /\.xlsx/i.test(r.accept || '');
const ringOk = (r) => !!r && r.label === true && r.outlineStyle === 'solid'
  && Number.parseFloat(r.outlineWidth) >= 1 && Number(r.opacity) >= 0.99 && r.visibility === 'visible';

const killTree = (pid) => {
  if (!pid) return;
  try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
};
let chrome = null;
let server = null;
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  killTree(chrome?.pid);
  killTree(server?.pid);
  for (const dir of [CHROME_PROFILE, DATA_DIR]) {
    for (let i = 0; i < 8; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * (i + 1)); }
    }
  }
};
process.on('exit', cleanup);

// ---------------- 1) 隔离实例（临时库 + 临时端口，不动生产数据） ----------------
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
server = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT,
  env: { ...process.env, ...LAUNCHER.env, MTask_DATA_DIR: DATA_DIR, MTask_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout?.on('data', (b) => serverLog.push(b.toString()));
server.stderr?.on('data', (b) => serverLog.push(b.toString()));
console.log(`隔离实例启动器：${LAUNCHER.label}`);

let serverUp = false;
for (let i = 0; i < 180; i++) {
  try { if ((await fetch(`${BASE}/api/health`)).ok) { serverUp = true; break; } } catch { /* 未就绪 */ }
  await sleep(500);
}
if (!serverUp) {
  console.log(`\n—— 服务日志（${DATA_DIR}）——\n${serverLog.join('').split('\n').slice(-40).join('\n')}`);
  ok('U-00 隔离服务启动（临时 DATA_DIR + 临时端口）', false);
  console.log(`\n结果：PASS=${pass} FAIL=${fail}`);
  process.exit(1);
}
ok('U-00 隔离服务启动（临时 DATA_DIR + 临时端口）', true);

const projResp = await fetch(`${BASE}/api/projects`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'T01674键盘探针' }),
});
ok('U-01 夹具项目创建（项目管理页有可见上下文）', projResp.ok);

// ---------------- 2) headless Chrome + CDP ----------------
chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--no-first-run', '--disable-gpu',
  `--user-data-dir=${CHROME_PROFILE}`, 'about:blank',
], { stdio: 'ignore' });
let targets = null;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://127.0.0.1:${CDP}/json/list`); if (r.ok) { targets = await r.json(); break; } } catch { /* 未就绪 */ }
  await sleep(400);
}
const page = targets?.find((t) => t.type === 'page');
if (!page) {
  ok('U-02 headless Chrome 与 CDP 就绪', false);
  console.log(`\n结果：PASS=${pass} FAIL=${fail}`);
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
ok('U-02 headless Chrome 与 CDP 就绪', true);
await send('Page.enable');

// 预种向导已读键：不点「跳过」文案，也不让遮罩吞掉 Tab
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try {
    for (const k of ['mtask.guide.seen.tasks','mtask.guide.seen.aitools','mtask.guide.seen.prompts','mtask.guide.seen.req',
      'mtask.guide.seen.report','mtask.guide.seen.history','mtask.guide.seen.queue','mtask.guide.seen.exec-sessions',
      'mtask.guide.seen.settings']) localStorage.setItem(k, '1');
    localStorage.setItem('mtask.projectGuide.seen', '1');
  } catch { /* 隐私模式：忽略 */ }`,
});
await send('Page.navigate', { url: BASE });

let shellReady = false;
for (let i = 0; i < 80; i++) {
  shellReady = (await ev(`!!document.querySelector('nav')`)) === true;
  if (shellReady) break;
  await sleep(250);
}
ok('U-03 应用外壳渲染（nav 就绪）', shellReady);

// 经产品跨页事件切到项目管理 Tab（不依赖导航按钮文案/类名/序号）
const switched = await ev(`(() => {
  globalThis.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'plan' } }));
  return true;
})()`);
let inputReady = false;
for (let i = 0; i < 80; i++) {
  inputReady = (await ev(`!!document.querySelector('input[type="file"][accept*=".xlsx"]')`)) === true;
  if (inputReady) break;
  await sleep(250);
}
const dialogOpen = await ev(`(() => {
  const d = [...document.querySelectorAll('dialog[open]')].find((x) => x.getClientRects().length > 0);
  return d ? String(d.innerText || d.getAttribute('aria-label') || 'dialog').slice(0, 40) : '';
})()`);
ok('U-04 项目管理页就绪且无向导/模态遮挡（Tab 不会被焦点陷阱吞掉）',
  switched === true && inputReady && dialogOpen === '', { switched, inputReady, dialogOpen });

// ---------------- 3) 真 Tab 序列（CDP Input 域） ----------------
let hit = -1;
let hitInfo = null;
const focused = [];
for (let i = 0; i < 150; i++) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  const info = await ev(`(() => {
    const ae = document.activeElement;
    if (!ae) return null;
    const lbl = ae.closest('label');
    return {
      tag: ae.tagName,
      type: ae.getAttribute('type') || '',
      accept: ae.getAttribute('accept') || '',
      labelAria: lbl ? (lbl.getAttribute('aria-label') || '') : '',
      selfAria: ae.getAttribute('aria-label') || '',
    };
  })()`);
  if (isExcelFileInput(info)) { hit = i + 1; hitInfo = info; break; }
  if (i < 12) focused.push(info ? `${info.tag}|${info.type}|${info.labelAria || info.selfAria}` : 'none');
}

// 等 opacity 0→1 过渡（0.2s）走完，避免读到中间态
await sleep(600);
const ring = hit > 0 ? await ev(`(() => {
  const ae = document.activeElement;
  const lbl = ae ? ae.closest('label') : null;
  if (!lbl) return { label: false };
  const cs = getComputedStyle(lbl);
  return {
    label: true,
    outlineStyle: cs.outlineStyle,
    outlineWidth: cs.outlineWidth,
    opacity: cs.opacity,
    visibility: cs.visibility,
  };
})()`) : null;

okPair(ok,
  'S-01 项目管理页「导入 Excel」入口字面锚（行为腿：真实 Tab 序列可达 .xlsx file input）',
  () => hit > 0,
  () => literalOf(SRC),
  () => ({ 命中Tab次数: hit, 运行期可访问名: hitInfo ? (hitInfo.labelAria || hitInfo.selfAria) : '', 源码锚: literalOf(SRC), 前几站: focused.join(' ; ') }));

ok('V-02 命中后焦点环可见：容器 outline solid ≥1px、opacity≈1、visibility:visible（未被 op-hidden 藏掉）',
  ringOk(ring), ring);

// ---------------- 4) 负对照（每条改判的牙齿） ----------------
ok('N-01 空源码负对照：字面腿转假（行为腿仍真，红因应为字面锚点失配）', literalOf('') === false,
  { empty: literalOf('') });

{
  const tampered = SRC.replace(/aria-label="导入 Excel"/g, 'aria-label="⟪改名⟫"');
  ok('N-02 改名模拟：HEAD 副本抹掉「导入 Excel」后字面腿转假（自证 tampered !== original）',
    SRC.length > 0 && tampered !== SRC && literalOf(SRC) === true && literalOf(tampered) === false,
    { srcLen: SRC.length, changed: tampered !== SRC, before: literalOf(SRC), after: literalOf(tampered) });
}

{
  const rec = [];
  const recOk = (name, cond, extra) => rec.push({ name, cond, extra });
  okPair(recOk, '契约-空源码', () => true, () => literalOf(''));
  okPair(recOk, '契约-行为假', () => false, () => true);
  okPair(recOk, '契约-双真', () => true, () => true);
  ok('N-03 okPair 落地：行为失守记「行为失守」、空源码记「字面锚点失配」、两侧齐真才绿',
    rec.length === 3 && rec[0].cond === false && /字面锚点失配/.test(rec[0].extra?.红因)
    && rec[1].cond === false && /行为失守/.test(rec[1].extra?.红因) && rec[2].cond === true, rec);
}

ok('N-04 结构破坏模拟：同 accept 的 text input、缺 accept 的 file input 均不判为 Excel 导入入口；正样本仍真',
  isExcelFileInput({ tag: 'INPUT', type: 'text', accept: '.xlsx' }) === false
  && isExcelFileInput({ tag: 'INPUT', type: 'file', accept: '' }) === false
  && isExcelFileInput({ tag: 'INPUT', type: 'file', accept: '.xlsx' }) === true);

ok('N-05 焦点环破坏模拟：outline none / opacity 0 / 无 label 三种形态各自转假',
  ringOk({ label: true, outlineStyle: 'none', outlineWidth: '2px', opacity: '1', visibility: 'visible' }) === false
  && ringOk({ label: true, outlineStyle: 'solid', outlineWidth: '2px', opacity: '0', visibility: 'visible' }) === false
  && ringOk({ label: false }) === false
  && ringOk({ label: true, outlineStyle: 'solid', outlineWidth: '2px', opacity: '1', visibility: 'visible' }) === true);

try { ws.close(); } catch { /* 已关闭 */ }
console.log(`\n结果：PASS=${pass} FAIL=${fail}`);
killTree(chrome?.pid);
killTree(server?.pid);
await sleep(1000);
cleanup();
process.exit(fail === 0 ? 0 : 1);
