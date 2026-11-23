/**
 * T06309 UI 实测：全局异常兜底在真实浏览器里可见、可聚焦、可重试。
 *
 * 静态 harness 由独立 esbuild 打包，Node 起临时静态服务器 + Chrome CDP：
 * 1) 初始渲染异常 → 兜底面板出现，焦点进入面板，按钮可键盘聚焦；
 * 2) 点「重试当前页面」→ 恢复正常；
 * 3) 异步 throw / Promise rejection → 全局提示条出现并可关闭；
 * 4) Failed to fetch 网络异常 → 不接管、不出提示条。
 *
 * 用法：node scripts/tests/verify-t06309-ui.mjs [--port 39891] [--out D:/tmp/t06309-ui]
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(arg('--port', '39891'));
const OUT = arg('--out', 'D:/tmp/t06309-ui');
const CHROME = arg('--chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const AXE = arg('--axe', 'D:/tmp/t06309-axe/node_modules/axe-core/axe.min.js');
const EB = join(ROOT, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe');

if (!existsSync(EB)) { console.error(`esbuild 不存在：${EB}`); process.exit(2); }
if (!existsSync(CHROME)) { console.error(`Chrome 不存在：${CHROME}`); process.exit(2); }
const hasAxe = existsSync(AXE);
const axeSource = hasAxe ? readFileSync(AXE, 'utf8') : '';

mkdirSync(OUT, { recursive: true });
const checks = [];
const say = (name, okVal, extra) => {
  const item = { name, ok: Boolean(okVal), extra };
  checks.push(item);
  console.log(`[${item.ok ? 'PASS' : 'FAIL'}] ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 900)}`}`);
};
const save = () => writeFileSync(join(OUT, 'cdp-t06309.json'), JSON.stringify({ pass: checks.filter((x) => x.ok).length, fail: checks.filter((x) => !x.ok).length, checks }, null, 2), 'utf8');
const log = (s) => appendFileSync(join(OUT, 'ui-run.log'), `${s}\n`, 'utf8');

const run = (args) => execFileSync(EB, args, { cwd: OUT, stdio: 'pipe', timeout: 120_000 });
try {
  run([join(OUT, 'src', 'main.tsx'), '--bundle', '--platform=browser', '--format=iife', '--jsx=automatic',
    '--define:process.env.NODE_ENV="production"', `--outfile=${join(OUT, 'dist', 'main.js')}`]);
  say('UI-00 harness 打包成功', existsSync(join(OUT, 'dist', 'main.js')) && existsSync(join(OUT, 'dist', 'main.css')));
} catch (e) {
  say('UI-00 harness 打包失败', false, String(e.stderr || e.message).slice(0, 500));
  save();
  process.exit(1);
}

const FILES = {
  '/': join(OUT, 'index.html'),
  '/index.html': join(OUT, 'index.html'),
  '/main.js': join(OUT, 'dist', 'main.js'),
  '/main.css': join(OUT, 'dist', 'main.css'),
};
const server = createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];
  const file = FILES[path];
  if (!file || !existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
  res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(readFileSync(file));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ } };
let chrome = null;
let ws = null;

try {
  await new Promise((resolve, reject) => server.listen(PORT, '127.0.0.1', resolve).once('error', reject));
  say('UI-01 临时静态服务器就绪', true, { port: PORT });
  log(`T06309 UI start ${new Date().toISOString()} port=${PORT}`);

  chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(OUT, 'profile')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1280,900', '--disable-features=Translate', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const cdpPort = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome 30s 内未报出调试端口')), 30_000);
    const on = (d) => {
      buf += String(d);
      const m = /ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser/.exec(buf);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    chrome.stderr.on('data', on);
    chrome.stdout.on('data', on);
    chrome.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome 提前退出 code=${code} ${buf.slice(-300)}`)); });
  });

  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const target = targets.find((x) => x.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP 连接失败')); });
  let seq = 0;
  const waits = new Map();
  ws.onmessage = (message) => {
    const msg = JSON.parse(String(message.data));
    if (msg.id !== undefined && waits.has(msg.id)) { waits.get(msg.id)(msg); waits.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq;
    waits.set(id, (msg) => resolve(msg.error ? { __err: msg.error.message } : msg.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evl = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.__err) return { __err: r.__err };
    if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 300) };
    return { value: r.result?.value };
  };
  const until = async (expression, ms = 20_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const r = await evl(expression);
      if (r.value) return r.value;
      await sleep(200);
    }
    return null;
  };
  const text = async (sel) => (await evl(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? el.innerText : ''; })()`)).value ?? '';
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r?.data) writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'));
  };
  const axeScan = async (label) => {
    if (!hasAxe) {
      say(label, false, { reason: `axe-core 缺失：${AXE}` });
      return null;
    }
    const result = await evl(`(async () => {
      const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } });
      return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length }));
    })()`);
    if (result.__err) {
      say(label, false, { error: result.__err });
      return null;
    }
    const bad = (result.value ?? []).filter((v) => v.impact === 'serious' || v.impact === 'critical');
    say(label, bad.length === 0, { seriousOrCritical: bad, totalViolations: (result.value ?? []).length });
    return result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?crash=1` });
  await sleep(800);
  if (hasAxe) {
    const injected = await evl(`${axeSource}\n;typeof axe === 'object'`);
    say('UI-01b axe-core 注入成功', injected.value === true, injected.__err);
  }

  const fallbackReady = await until(`Boolean(document.querySelector('[data-t06309="error-boundary"]'))`, 15_000);
  const fallbackInfo = await evl(`(() => {
    const el = document.querySelector('[data-t06309="error-boundary"]');
    if (!el) return null;
    return {
      role: el.getAttribute('role'), live: el.getAttribute('aria-live'), tabIndex: el.tabIndex,
      text: el.innerText, active: document.activeElement === el,
      focusedTag: document.activeElement?.tagName ?? '',
      width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height,
      overflowX: document.documentElement.scrollWidth - window.innerWidth
    };
  })()`);
  say('UI-02 初始渲染异常触发兜底面板', Boolean(fallbackReady) && Boolean(fallbackInfo.value), fallbackInfo.value);
  say('UI-03 兜底面板 role=alert + assertive', fallbackInfo.value?.role === 'alert' && fallbackInfo.value?.live === 'assertive');
  say('UI-04 兜底面板覆盖视口且无横向溢出', (fallbackInfo.value?.width ?? 0) >= 1200 && (fallbackInfo.value?.overflowX ?? 99) <= 1);
  say('UI-05 焦点自动进入兜底面板', fallbackInfo.value?.active === true);
  const btnInfo = await evl(`(() => {
    const btns = [...document.querySelectorAll('[data-t06309="error-boundary"] button')];
    return btns.map((b) => ({ text: b.innerText, focusable: b.tabIndex >= 0, height: b.getBoundingClientRect().height }));
  })()`);
  say('UI-06 兜底面板提供两个可键盘聚焦动作', (btnInfo.value?.length ?? 0) === 2 && btnInfo.value.every((b) => b.focusable && b.height >= 32), btnInfo.value);
  say('UI-07 兜底面板文案可读', (fallbackInfo.value?.text ?? '').includes('页面遇到异常') && (fallbackInfo.value?.text ?? '').includes('重试当前页面') && (fallbackInfo.value?.text ?? '').includes('重新加载应用'));
  await shot('01-error-boundary.png');

  const primaryFocus = await evl(`(() => { const b = document.querySelector('[data-t06309="error-boundary"] button'); if (!b) return null; b.focus(); return document.activeElement === b; })()`);
  say('UI-08 兜底按钮可接受键盘焦点', primaryFocus.value === true);
  await axeScan('UI-09a 兜底面板 axe 无 serious/critical');

  await evl(`(() => { const b = [...document.querySelectorAll('[data-t06309="error-boundary"] button')].find((x) => x.innerText.includes('重试当前页面')); b?.click(); return true; })()`);
  const recovered = await until(`!document.querySelector('[data-t06309="error-boundary"]') && Boolean(document.querySelector('#stable'))`, 10_000);
  say('UI-09b 点重试后恢复正常渲染', Boolean(recovered));

  await evl(`document.querySelector('#async')?.click()`);
  const asyncToast = await until(`Boolean(document.querySelector('[data-t06309="global-error-toast"]'))`, 10_000);
  const asyncInfo = await evl(`(() => {
    const el = document.querySelector('[data-t06309="global-error-toast"]');
    if (!el) return null;
    return { role: el.getAttribute('role'), live: el.getAttribute('aria-live'), text: el.innerText, active: document.activeElement === el };
  })()`);
  say('UI-10 异步 throw 触发全局提示条', Boolean(asyncToast) && (asyncInfo.value?.text ?? '').includes('T06309 async boom'), asyncInfo.value);
  say('UI-11 提示条 role=alert + assertive', asyncInfo.value?.role === 'alert' && asyncInfo.value?.live === 'assertive');
  say('UI-12 提示条获得焦点', asyncInfo.value?.active === true);
  await axeScan('UI-12b 全局提示条 axe 无 serious/critical');
  await shot('02-global-error-toast.png');

  await evl(`(() => { const b = [...document.querySelectorAll('[data-t06309="global-error-toast"] button')].find((x) => x.innerText.includes('关闭')); b?.click(); return true; })()`);
  const toastGone = await until(`!document.querySelector('[data-t06309="global-error-toast"]')`, 5_000);
  say('UI-13 提示条可手动关闭', Boolean(toastGone));

  await evl(`document.querySelector('#network')?.click()`);
  await sleep(900);
  const networkToast = await evl(`Boolean(document.querySelector('[data-t06309="global-error-toast"]'))`);
  say('UI-14 Failed to fetch 不进入全局提示', networkToast.value === false);

  await evl(`document.querySelector('#promise')?.click()`);
  const promiseToast = await until(`Boolean(document.querySelector('[data-t06309="global-error-toast"]'))`, 10_000);
  const promiseText = await text('[data-t06309="global-error-toast"]');
  say('UI-15 Promise rejection 触发全局提示', Boolean(promiseToast) && promiseText.includes('T06309 promise boom'));
} catch (e) {
  say('UI-FATAL 测试异常', false, String(e?.stack || e).slice(0, 700));
} finally {
  try { if (ws) ws.close(); } catch { /* 忽略 */ }
  try { if (chrome) killTree(chrome.pid); } catch { /* 忽略 */ }
  try { server.close(); } catch { /* 忽略 */ }
  save();
  console.log(`\n[t06309-ui] pass=${checks.filter((x) => x.ok).length} fail=${checks.filter((x) => !x.ok).length}`);
  process.exit(checks.some((x) => !x.ok) ? 1 : 0);
}
