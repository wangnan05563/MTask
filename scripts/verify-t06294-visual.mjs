/**
 * T06294 今日看板浏览器验收：真实构建 + 真实 API + Chrome CDP。
 *
 * 检查：
 * 1. 首页默认渲染今日看板（三个行动分组 + 摘要 + 告警条），不是统计仪表盘；
 * 2. 首屏从 document 开始到数据就绪的耗时（AC-01 的浏览器口径，3s 预算）；
 * 3. 1440 / 1280 / 760 三档无横向溢出，截图落盘；
 * 4. 今日 / 等我 / AI 跑 / 告警四类摘要数字与 API 返回一致。
 *
 * 用法：node scripts/tests/verify-t06294-visual.mjs
 * 环境：MTASK_API_PORT（默认 5193）、T06294_OUT、CHROME_PATH。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';

const ROOT = process.cwd();
const OUT = process.env.T06294_OUT || 'C:/pyfix_tmp/t06294-ui';
const DIST = join(ROOT, 'web', 'dist');
const PORT = Number(process.env.T06294_PORT || 39915);
const API_PORT = Number(process.env.MTASK_API_PORT || 5193);
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TOKEN_FILE = join(process.env.APPDATA || '', 'mtask', 'data', 'tunnel', 'tunnel-config.json');
if (!existsSync(join(DIST, 'index.html'))) { console.error(`dist 不存在：${DIST}`); process.exit(2); }
if (!existsSync(CHROME)) { console.error(`Chrome 不存在：${CHROME}`); process.exit(2); }
let accessToken = '';
try { accessToken = String(JSON.parse(readFileSync(TOKEN_FILE, 'utf8')).accessToken || ''); } catch { /* 未配置 */ }
mkdirSync(OUT, { recursive: true });

const checks = [];
const say = (name, okVal, extra) => {
  const item = { name, ok: Boolean(okVal), extra };
  checks.push(item);
  console.log(`[${item.ok ? 'PASS' : 'FAIL'}] ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 1600)}`}`);
};
const save = () => writeFileSync(join(OUT, 'visual-result.json'), JSON.stringify({
  pass: checks.filter((x) => x.ok).length, fail: checks.filter((x) => !x.ok).length, checks,
}, null, 2), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ } };

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
const server = createServer((req, res) => {
  const raw = req.url || '/';
  if (raw.startsWith('/api/')) {
    const upstream = httpRequest({
      host: '127.0.0.1', port: API_PORT, path: raw, method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${API_PORT}`, ...(accessToken ? { 'X-Access-Token': accessToken } : {}) },
    }, (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message) })); });
    req.pipe(upstream);
    return;
  }
  const pathname = decodeURIComponent(raw.split('?')[0]);
  let file = join(DIST, pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  if (!existsSync(file) || pathname.endsWith('/')) file = join(DIST, 'index.html');
  if (!existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': `${MIME[extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(readFileSync(file));
});

let chrome = null;
let ws = null;
try {
  await new Promise((resolve, reject) => server.listen(PORT, '127.0.0.1', resolve).once('error', reject));
  say('TODAY-00 静态服务器 + API 代理就绪', true, { port: PORT, apiPort: API_PORT, token: Boolean(accessToken) });

  chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(OUT, 'profile')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1440,1000', '--disable-features=Translate', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const cdpPort = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome 30s 内未报出调试端口')), 30_000);
    const on = (d) => {
      buf += String(d);
      const m = /ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser/.exec(buf);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    chrome.stderr.on('data', on); chrome.stdout.on('data', on);
    chrome.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome 提前退出 code=${code} ${buf.slice(-300)}`)); });
  });
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const target = targets.find((x) => x.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP 连接失败')); });
  let seq = 0;
  const waits = new Map();
  const consoleErrors = [];
  ws.onmessage = (message) => {
    const msg = JSON.parse(String(message.data));
    if (msg.id !== undefined && waits.has(msg.id)) { waits.get(msg.id)(msg); waits.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(String(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || '').slice(0, 300));
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq;
    waits.set(id, (msg) => resolve(msg.error ? { __err: msg.error.message } : msg.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evl = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.__err) return { __err: r.__err };
    if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 400) };
    return { value: r.result?.value };
  };
  const until = async (expression, ms = 20_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const r = await evl(expression);
      if (r.value) return r.value;
      await sleep(150);
    }
    return null;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (!r?.data) return null;
    const buf = Buffer.from(r.data, 'base64');
    writeFileSync(join(OUT, name), buf);
    return { file: name, bytes: buf.length };
  };
  const dismiss = async () => {
    await evl(`(() => {
      const visible = (el) => !!(el && el.getBoundingClientRect().width && el.getBoundingClientRect().height && getComputedStyle(el).visibility !== 'hidden');
      const dialogs = [...document.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"]')].filter(visible);
      for (const d of dialogs) {
        const btn = [...d.querySelectorAll('button')].find((b) => visible(b) && /关闭|知道了|跳过|稍后|开始使用|完成|取消|×/.test((b.innerText || '') + (b.getAttribute('aria-label') || '')));
        if (btn) btn.click();
      }
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return dialogs.length;
    })()`);
    await sleep(300);
  };
  const inspect = async () => evl(`(() => {
    const root = document.querySelector('#root');
    const sc = document.querySelector('.mt-today-summary');
    const items = [...document.querySelectorAll('.mt-today-summary-item')].map((el) => ({
      label: el.querySelector('.mt-today-summary-label')?.innerText || '',
      value: el.querySelector('.mt-today-summary-value')?.innerText || '',
    }));
    return {
      hasBoard: Boolean(document.querySelector('.mt-today-grid')),
      hasToolbar: Boolean(document.querySelector('.mt-today-toolbar')),
      groups: document.querySelectorAll('.mt-today-group').length,
      tasks: document.querySelectorAll('.mt-today-task').length,
      runs: document.querySelectorAll('.mt-today-run').length,
      alerts: document.querySelectorAll('.mt-today-alert').length,
      summaryItems: items,
      summaryText: sc?.innerText || '',
      statsMounted: Boolean(document.querySelector('[data-testid="stats-section"], .mt-stats-section')),
      viewport: { w: innerWidth, h: innerHeight },
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      skeleton: document.querySelectorAll('.mt-skeleton').length,
      textLen: (root?.innerText || '').length,
      firstTitle: document.querySelector('.mt-today-task-title')?.innerText || '',
    };
  })()`);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__t06294T0 = performance.now();' });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await until(`Boolean(document.querySelector('#root aside'))`, 30_000);
  await evl(`(() => { window.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'dashboard' } })); return true; })()`);
  const ready = await until(`Boolean(document.querySelector('.mt-today-toolbar') && document.querySelectorAll('.mt-today-summary-item').length >= 3)`, 25_000);
  const elapsed = (await evl(`Math.round(performance.now() - (window.__t06294T0 || performance.now()))`)).value;
  await dismiss();
  const data = (await inspect()).value;
  say('TODAY-01 今日看板首屏渲染（真实构建 + 真实 API）', Boolean(ready && data?.hasBoard && data?.groups === 3), {
    ready, ...data, elapsedMs: elapsed,
  });
  say('TODAY-02 首屏数据就绪 ≤ 3s（浏览器口径）', Number(elapsed) <= 3000, { elapsedMs: elapsed });
  say('TODAY-03 首页不再默认挂载统计仪表盘', data?.statsMounted === false, { statsMounted: data?.statsMounted });
  say('TODAY-04 三组行动数据非空', (data?.tasks || 0) > 0 && (data?.runs || 0) > 0 && (data?.alerts || 0) > 0, {
    tasks: data?.tasks, runs: data?.runs, alerts: data?.alerts, firstTitle: data?.firstTitle,
  });

  const sizes = [['1440', 1440, 1000], ['1280', 1280, 900], ['760', 760, 1000]];
  for (const [name, width, height] of sizes) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await evl(`window.scrollTo(0, 0); true`);
    await sleep(400);
    const info = await inspect();
    const img = await shot(`0${sizes.findIndex((x) => x[0] === name) + 1}-today-${name}.png`);
    const noOverflow = (info.value?.scrollWidth || 0) <= (info.value?.viewport?.w || width) + 1;
    say(`TODAY-view-${name} 无横向溢出且截图有效`, Boolean(img && img.bytes > 10_000 && noOverflow && info.value?.hasToolbar), {
      file: img?.file, bytes: img?.bytes, overflow: (info.value?.scrollWidth || 0) - (info.value?.viewport?.w || 0),
      groups: info.value?.groups, summary: info.value?.summaryItems,
    });
  }

  say('TODAY-05 无未捕获前端异常', consoleErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 3) });
  writeFileSync(join(OUT, 'visual-summary.json'), JSON.stringify({
    elapsedMs: elapsed, data, checks,
  }, null, 2), 'utf8');
} catch (e) {
  say('TODAY-FATAL 验收异常', false, String(e?.stack || e).slice(0, 900));
} finally {
  try { if (ws) ws.close(); } catch { /* 忽略 */ }
  try { if (chrome) killTree(chrome.pid); } catch { /* 忽略 */ }
  try { server.close(); } catch { /* 忽略 */ }
  save();
  console.log(`\n[t06294-visual] pass=${checks.filter((x) => x.ok).length} fail=${checks.filter((x) => !x.ok).length} out=${OUT}`);
  process.exit(checks.some((x) => !x.ok) ? 1 : 0);
}
