#!/usr/bin/env node
/**
 * T02307 UI 腿：真机浏览器点「AI 批量分类」，核对账户级门禁下的中止提示与忙碌态复位。
 *
 * 只断言「非真实浏览器不能回答」的产物：
 *   U-01 页面就绪：工具条按钮可点，未分类计数 = 30（目标数来自真实任务列表，不是门自报）；
 *   U-02 点击后弹出确认对话框（批量入口的真实交互前提）；
 *   U-03 运行期忙碌态可见（按钮 aria-label 切「批量分类进行中」/ spinner 出现）；
 *   U-04 收尾可见提示含「中止 / 额度·限流 / 厂商错误原文」，且不出现「未能为这些任务匹配到合适的分类」；
 *   U-05 结束后忙碌态复位（按钮回到空闲 aria-label、spinner 消失）；
 *   U-06 mock 厂商只收到 1 次请求（30 条目标没有打满）；
 *   U-07 服务端 ai_usage 增量 = 1（与实发一致）。
 *
 * 隔离纪律：临时端口 + 临时 DATA_DIR（D:），空库由服务自建，夹具经 REST 建；
 *   不碰生产实例 39877，不读生产库。Chrome 用系统安装包 + 独立 profile。
 *
 * 用法：
 *   TMP=/d/code/tmp TEMP=/d/code/tmp node node_modules/tsx/dist/cli.mjs scripts/verify-t02307-ui.mjs
 * 环境变量：T02307_UI_PORT（默认 40138，占用向后扫）、T02307_UI_CDP（默认 9360）、
 *   T02307_UI_CHROME（默认系统 Chrome）、T02307_UI_KEEP=1 保留临时目录。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP_ROOT = existsSync('D:/code/tmp') ? 'D:/code/tmp' : tmpdir();
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't02307-ui-'));
const LOG_DIR = mkdtempSync(join(TMP_ROOT, 't02307-ui-log-'));
const CHROME_PROFILE = mkdtempSync(join(TMP_ROOT, 't02307-ui-chrome-'));
const { gateShotsDir, writeGateResults } = await import(pathToFileURL(join(ROOT, 'scripts/lib/gate-results.mts')).href);
const SHOTS = gateShotsDir('t02307-ui');
const OUT_DIR = join(ROOT, '.workbuddy');
const OUT_BASE = 't02307-ui-gate-results.txt';
const PORT_BASE = Number(process.env.T02307_UI_PORT ?? 40138);
const CDP = Number(process.env.T02307_UI_CDP ?? 9360);
const CHROME = process.env.T02307_UI_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0; let skip = 0;
const lines = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; lines.push(`[PASS] ${name}`); console.log(`  [PASS] ${name}`); }
  else {
    fail += 1;
    const tail = extra !== undefined ? ` -> ${JSON.stringify(extra).toString().slice(0, 400)}` : '';
    lines.push(`[FAIL] ${name}${tail}`); console.log(`  [FAIL] ${name}${tail}`);
  }
};
const skipped = (name, why) => { skip += 1; lines.push(`[SKIP] ${name}（${why}）——不计 PASS`); console.log(`  [SKIP] ${name}（${why}）`); };
const note = (s) => { lines.push(`[INFO] ${s}`); console.log(`  · ${s}`); };

// ---------------- mock 厂商：延迟 1.2s 后回 429，制造可观测的忙碌窗口 ----------------
let vendorHits = 0;
const mock = createServer(async (req, res) => {
  vendorHits += 1;
  await sleep(1200);
  res.writeHead(429, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'You’ve reached the API rate limit for free users. Upgrade to a Token Plan.' } }));
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const MOCK = `http://127.0.0.1:${mock.address().port}`;

// ---------------- 隔离实例 ----------------
const { resolveServerLauncher } = await import(pathToFileURL(join(ROOT, 'scripts/isolated-server-launcher.mts')).href);
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
let server = null;
let BASE = '';
const serverLog = [];
for (let i = 0; i < 20 && !BASE; i += 1) {
  const port = PORT_BASE + i;
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
    cwd: ROOT,
    env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(port), MTask_DATA_DIR: DATA_DIR, MTask_LOG_DIR: LOG_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (b) => serverLog.push(String(b)));
  child.stderr.on('data', (b) => serverLog.push(String(b)));
  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 90000) {
    if (child.exitCode !== null) break;
    try {
      const r = await fetch(`${base}/api/health`);
      const ct = String(r.headers.get('content-type') ?? '');
      if (r.ok && ct.includes('application/json')) {
        const b = await r.json();
        if (b?.service === 'mtask-server') { up = true; break; }
      }
    } catch { /* 未就绪 */ }
    await sleep(500);
  }
  if (up) { server = child; BASE = base; break; }
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
}

let chrome = null;
const bye = () => {
  if (server?.pid) { try { spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ } }
  if (chrome?.pid) { try { spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ } }
};
const cleanup = () => {
  if (process.env.T02307_UI_KEEP) return;
  for (const dir of [DATA_DIR, LOG_DIR, CHROME_PROFILE]) {
    for (let i = 0; i < 8; i += 1) {
      try { rmSync(dir, { recursive: true, force: true }); break; } catch { spawnSync('cmd', ['/c', 'ping', '-n', '2', '127.0.0.1'], { stdio: 'ignore' }); }
    }
  }
};
process.on('exit', bye);
process.on('exit', cleanup);

ok('U-00 隔离实例启动并回 JSON 体检体（临时端口 + 临时库）', Boolean(server && BASE), { BASE, dataDir: DATA_DIR });
if (!server || !BASE) {
  console.log(serverLog.join('').split('\n').slice(-30).join('\n'));
  const summary = `PASS=${pass} FAIL=${fail} SKIP=${skip}`;
  const f = writeGateResults(OUT_DIR, OUT_BASE, `${summary}\n${lines.join('\n')}`, { port: PORT_BASE, dataDir: DATA_DIR, note: '服务未起' });
  console.log(`\n${summary}\n结果文件：${f}`);
  process.exit(1);
}
note(`隔离实例启动器：${LAUNCHER.label ?? LAUNCHER.exec} · BASE=${BASE}`);

const jfetch = async (method, path, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// ---------------- 夹具：项目 + 分类 + 30 条未分类任务 + mock 工具（全部走 REST） ----------------
const proj = await jfetch('POST', '/api/projects', { name: `T02307 UI 门 ${Date.now() % 100000}` });
const cat = await jfetch('POST', '/api/task-categories', { name: '开发' });
const toolName = `T02307-ui-mock-${Date.now() % 100000}`;
const tool = await jfetch('POST', '/api/aitools', {
  name: toolName, type: 'openai-compatible', purpose: 'classify',
  endpoint: `${MOCK}/429`, apiKey: 'k', model: 'm', timeoutMs: 8000,
});
let created = 0;
for (let i = 0; i < 30; i += 1) {
  const t = await jfetch('POST', '/api/tasks', { projectId: proj.body?.id, title: `UI 门未分类任务 ${i + 1}`, priority: 'normal' });
  if (t.status === 200 || t.status === 201) created += 1;
}
ok('U-00b 夹具经 REST 建齐（项目 + 分类 + 30 条未分类任务 + mock 429 工具）',
  Boolean(proj.body?.id) && Boolean(cat.body?.id) && Boolean(tool.body?.id) && created === 30,
  { proj: proj.status, cat: cat.status, tool: tool.status, created });

// ---------------- headless Chrome + CDP ----------------
ok('U-00c Chrome 可执行文件在场', existsSync(CHROME), CHROME);
if (!existsSync(CHROME)) {
  skipped('U-01..U-07 浏览器腿', '系统 Chrome 缺失');
  const summary = `PASS=${pass} FAIL=${fail} SKIP=${skip}`;
  const f = writeGateResults(OUT_DIR, OUT_BASE, `${summary}\n${lines.join('\n')}`, { port: Number(BASE.split(':').pop()), dataDir: DATA_DIR, note: 'Chrome 缺失' });
  console.log(`\n${summary}\n结果文件：${f}`);
  process.exit(1);
}
chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--no-first-run', '--disable-gpu',
  '--force-device-scale-factor=1', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  `--user-data-dir=${CHROME_PROFILE}`, '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' });

let wsUrl = '';
for (let i = 0; i < 50; i += 1) {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP}/json/list`);
    if (r.ok) { const t = (await r.json()).find((x) => x.type === 'page'); if (t) { wsUrl = t.webSocketDebuggerUrl; break; } }
  } catch { /* Chrome 还在起 */ }
  await sleep(400);
}
ok('U-00d Chrome CDP 通道就绪（系统 Chrome, headless=new）', Boolean(wsUrl), wsUrl);
if (!wsUrl) {
  skipped('U-01..U-07 浏览器腿', 'CDP 通道不可用');
  const summary = `PASS=${pass} FAIL=${fail} SKIP=${skip}`;
  const f = writeGateResults(OUT_DIR, OUT_BASE, `${summary}\n${lines.join('\n')}`, { port: Number(BASE.split(':').pop()), dataDir: DATA_DIR, note: 'CDP 不可用' });
  console.log(`\n${summary}\n结果文件：${f}`);
  process.exit(1);
}

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pend = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => { const i = ++seq; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
async function until(expr, ms = 20_000) {
  const t0 = Date.now();
  let v = null;
  while (Date.now() - t0 < ms) { v = await ev(expr); if (v) return v; await sleep(250); }
  return v;
}
let shotSeq = 0;
async function shot(name) {
  mkdirSync(SHOTS, { recursive: true });
  const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const b64 = r.result?.data;
  if (!b64) return '';
  const file = join(SHOTS, `${String(++shotSeq).padStart(2, '0')}-${name}.png`);
  writeFileSync(file, Buffer.from(b64, 'base64'));
  return file;
}
const BTN = `(()=>{const b=[...document.querySelectorAll('button')].find(x=>/^(AI 批量分类|批量分类进行中)/.test(x.getAttribute('aria-label')||''));return b?{label:b.getAttribute('aria-label'),disabled:b.disabled,text:(b.textContent||'').trim(),busy:!!b.querySelector('.aispin')}:null})()`;

await send('Page.enable');
await send('Page.navigate', { url: `${BASE}/?m=0` });
await until(`document.readyState==='complete'`, 25_000);
await sleep(1200);
await ev(`localStorage.setItem('tasks.activeProject', ${JSON.stringify(JSON.stringify(proj.body.id))});localStorage.setItem('tasks.organizeToolId', ${JSON.stringify(JSON.stringify(tool.body.id))});localStorage.setItem('mtask.guide.seen.tasks','1');true`);
await send('Page.reload', { ignoreCache: true });
await sleep(1500);

const ready = await until(`(()=>{const b=${BTN};return b&&!b.disabled&&b.text.includes('30')?b:null})()`, 30_000);
const guide = await ev(`!!document.querySelector('dialog[open]')||[...document.querySelectorAll('[role="dialog"]')].some(d=>/使用向导/.test(d.textContent||''))`);
ok('U-01 页面就绪：工具条「AI 批量分类」可点，未分类计数=30', Boolean(ready), ready);
ok('U-01b 首访向导未遮挡（已标记 seen，真实用户路径可直接操作工具条）', guide === false, { guide });
const shotBefore = await shot('ready-30-unclassified');
if (ready) {
  // 收尾提示记录器：flash 只存活 2.5s，轮询会漏，改由 MutationObserver 全量留痕
  await ev(`(()=>{window.__gateFlashes=[];const rec=()=>{const o=document.querySelector('output.flash-toast');if(o&&o.textContent&&!window.__gateFlashes.includes(o.textContent))window.__gateFlashes.push(o.textContent);};window.__gateRec=rec;new MutationObserver(rec).observe(document.body,{childList:true,subtree:true,characterData:true});rec();return true})()`);
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/^AI 批量分类/.test(x.getAttribute('aria-label')||''));b.click();return true})()`);
  const dlg = await until(`document.querySelector('[aria-label="确定：确认执行该操作"]')?true:null`, 8000);
  ok('U-02 点击「AI 批量分类」弹出确认对话框（真实批量入口交互）', Boolean(dlg));
  const shotDialog = await shot('confirm-dialog');

  if (dlg) {
    await ev(`document.querySelector('[aria-label="确定：确认执行该操作"]').click();true`);
    let sawBusy = false; let sawSpinner = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 15_000) {
      const s = await ev(BTN);
      if (s && String(s.label).includes('批量分类进行中')) sawBusy = true;
      if (s && s.busy) sawSpinner = true;
      if (sawBusy && sawSpinner) break;
      if ((await ev(`window.__gateFlashes.length`)) > 0) break;
      await sleep(120);
    }
    const shotBusy = await shot('batch-busy');
    ok('U-03 运行期忙碌态可见（aria-label 切「批量分类进行中」且 spinner 出现）', sawBusy && sawSpinner, { sawBusy, sawSpinner, shot: shotBusy });

    const gotFlash = await until(`window.__gateFlashes&&window.__gateFlashes.length>0?window.__gateFlashes:null`, 20_000);
    const flashText = Array.isArray(gotFlash) ? gotFlash[gotFlash.length - 1] : '';
    const shotFlash = await shot('abort-flash');
    ok('U-04 收尾提示含「中止/额度·限流/厂商原文」，不出现「未能为这些任务匹配到合适的分类」',
      flashText.includes('中止') && /额度|限流/.test(flashText) && flashText.includes('rate limit')
      && !flashText.includes('未能为这些任务匹配到合适的分类'), { flashText, shot: shotFlash });

    await sleep(700);
    const after = await ev(BTN);
    ok('U-05 结束后忙碌态复位（按钮回空闲 aria-label，spinner 消失）',
      Boolean(after) && !String(after.label).includes('批量分类进行中') && after.busy === false && after.disabled === false, after);

    ok('U-06 mock 厂商只收到 1 次请求（30 条目标没有打满）', vendorHits === 1, { vendorHits });
    const usage = await jfetch('GET', '/api/ai/usage?days=1');
    const row = (usage.body?.byTool ?? []).find((x) => x.tool_name === toolName && x.kind === 'classify');
    ok('U-07 服务端 ai_usage 增量 = 1（与实发一致）', Number(row?.calls ?? 0) === 1, { row, vendorHits });
    note(`截图：${[shotBefore, shotDialog, shotBusy, shotFlash].filter(Boolean).join(' ; ')}`);
  }
}

// ---------------- 收尾 ----------------
ws.close();
try { spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
chrome = null;
if (server?.pid) { try { spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ } }
server = null;
mock.closeAllConnections?.();
await new Promise((r) => mock.close(() => r()));

const summary = `PASS=${pass} FAIL=${fail} SKIP=${skip}`;
const resultsFile = writeGateResults(OUT_DIR, OUT_BASE, `${summary}\n${lines.join('\n')}`, {
  port: Number(BASE.split(':').pop()), dataDir: DATA_DIR,
  note: `CDP=${CDP} 夹具=${created} 条未分类任务 mock厂商命中=${vendorHits}`,
});
console.log(`\n${summary}`);
console.log(`结果文件：${resultsFile}`);
process.exit(fail === 0 ? 0 : 1);
