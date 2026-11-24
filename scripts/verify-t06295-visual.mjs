/**
 * T06295 收件箱浏览器验收：真实构建 + 真实库副本 API + Chrome CDP。
 *
 * 检查：
 * 1. 收件箱页面真实渲染（分类页签、列表行、行内动作、转入项目选择）；
 * 2. 顶栏收件箱角标数字与 `/api/inbox/summary` 的 open 数一致；
 * 3. 页面打开后 POST /inbox/read 生效，unread 归零但 open 不变；
 * 4. 1440 / 1280 / 760 三档无横向溢出，截图落盘；
 * 5. 分类切换（AI 失败）只显示对应条目；
 * 6. 无未捕获前端异常。
 *
 * 用法：node scripts/verify-t06295-visual.mjs
 * 环境：MTASK_API_PORT（默认 5194）、T06295_OUT、T06295_PORT、CHROME_PATH。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';

const ROOT = process.cwd();
const OUT = process.env.T06295_OUT || 'C:/pyfix_tmp/t06295-ui';
const DIST = join(ROOT, 'web', 'dist');
const PORT = Number(process.env.T06295_PORT || 39916);
const API_PORT = Number(process.env.MTASK_API_PORT || 5194);
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
  say('INBOX-00 静态服务器 + API 代理就绪', true, { port: PORT, apiPort: API_PORT, token: Boolean(accessToken) });
  const apiSummary = await (await fetch(`http://127.0.0.1:${PORT}/api/inbox/summary`)).json();

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
    const bell = document.querySelector('button[data-open-count]');
    const rows = [...document.querySelectorAll('.mt-inbox-row')];
    return {
      hasPage: Boolean(document.querySelector('.mt-inbox-page')),
      hasHeader: Boolean(document.querySelector('.mt-page-header h1')?.innerText.includes('收件箱')),
      hasFilter: Boolean(document.querySelector('.mt-page-filter')),
      tabs: [...document.querySelectorAll('.mt-inbox-tab')].map((el) => el.innerText.trim()),
      tabCount: document.querySelectorAll('.mt-inbox-tab').length,
      tabsVisible: [...document.querySelectorAll('.mt-inbox-tab')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth;
      }).length,
      rows: rows.length,
      types: [...new Set(rows.map((el) => el.getAttribute('data-type')))],
      unreadRows: rows.filter((el) => el.getAttribute('data-unread') === 'true').length,
      actionButtons: [...new Set([...document.querySelectorAll('.mt-inbox-row-actions button')].map((b) => b.innerText.trim()))],
      targetOptions: [...document.querySelectorAll('.mt-inbox-target select option')].map((o) => o.innerText.trim()).filter(Boolean),
      totalText: document.querySelector('.mt-inbox-total')?.innerText || '',
      hintText: document.querySelector('.mt-inbox-hint')?.innerText || '',
      bellOpen: Number(bell?.getAttribute('data-open-count') || -1),
      bellText: bell?.innerText.trim() || '',
      emptyState: Boolean(document.querySelector('.mt-empty')),
      viewport: { w: innerWidth, h: innerHeight },
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      textLen: (root?.innerText || '').length,
      firstTitle: document.querySelector('.mt-inbox-row-title')?.innerText || '',
      firstMeta: document.querySelector('.mt-inbox-row-meta')?.innerText || '',
    };
  })()`);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__t06295T0 = performance.now();' });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await until(`Boolean(document.querySelector('#root aside'))`, 30_000);
  await evl(`(() => { window.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'inbox' } })); return true; })()`);
  const ready = await until(`Boolean(document.querySelector('.mt-inbox-page') && document.querySelectorAll('.mt-inbox-row').length >= 6)`, 25_000);
  const elapsed = (await evl(`Math.round(performance.now() - (window.__t06295T0 || performance.now()))`)).value;
  await sleep(1200);
  await dismiss();
  const data = (await inspect()).value;
  const apiAfter = await (await fetch(`http://127.0.0.1:${PORT}/api/inbox/summary`)).json();
  say('INBOX-01 收件箱首屏渲染（真实构建 + 真实库副本 API）', Boolean(ready && data?.hasPage && data?.hasHeader && data?.hasFilter && data?.rows >= 6), {
    ready, ...data, elapsedMs: elapsed,
  });
  say('INBOX-02 五个分类页签与行内动作齐备', data?.tabCount === 5 && (data?.actionButtons || []).some((b) => b.includes('打开任务') || b.includes('转任务'))
    && (data?.actionButtons || []).some((b) => b.includes('认领')) && (data?.actionButtons || []).some((b) => b.includes('忽略')), {
    tabCount: data?.tabCount, tabs: data?.tabs, actions: data?.actionButtons,
  });
  say('INBOX-03 顶栏角标 = open 数', (data?.bellOpen === apiSummary.counts.open) && apiAfter.counts.open === apiSummary.counts.open, {
    bell: data?.bellOpen, apiBefore: apiSummary.counts.open, apiAfter: apiAfter.counts.open,
  });
  say('INBOX-04 打开页面清未读：unread=0、open 不变', apiAfter.counts.unread === 0 && data?.unreadRows === 0, {
    unread: apiAfter.counts.unread, unreadRows: data?.unreadRows,
  });
  say('INBOX-05 列表带真实任务行与项目/转入项目选择', data?.firstTitle.length > 0 && (data?.targetOptions || []).length >= 2, {
    firstTitle: data?.firstTitle, firstMeta: data?.firstMeta, targetOptions: data?.targetOptions,
  });

  const sizes = [['1440', 1440, 1000], ['1280', 1280, 900], ['760', 760, 1000]];
  for (const [name, width, height] of sizes) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await evl(`window.scrollTo(0, 0); true`);
    await sleep(400);
    const info = await inspect();
    const img = await shot(`0${sizes.findIndex((x) => x[0] === name) + 1}-inbox-${name}.png`);
    const noOverflow = (info.value?.scrollWidth || 0) <= (info.value?.viewport?.w || width) + 1;
    say(`INBOX-view-${name} 无横向溢出且截图有效`, Boolean(img && img.bytes > 10_000 && noOverflow && info.value?.hasPage && info.value?.rows >= 6 && info.value?.tabsVisible === 5), {
      file: img?.file, bytes: img?.bytes, overflow: (info.value?.scrollWidth || 0) - (info.value?.viewport?.w || width),
      rows: info.value?.rows, tabs: info.value?.tabCount, tabsVisible: info.value?.tabsVisible,
    });
  }

  // 分类筛选：切到 AI 失败，只留对应 type
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evl(`(() => {
    const btn = [...document.querySelectorAll('.mt-inbox-tab')].find((el) => el.innerText.includes('AI 失败'));
    if (btn) btn.click();
    return Boolean(btn);
  })()`);
  const filtered = await until(`Boolean(document.querySelector('.mt-inbox-row[data-type="ai_failed"]')) && [...document.querySelectorAll('.mt-inbox-row')].every((el) => el.getAttribute('data-type') === 'ai_failed')`, 10_000);
  const fdata = (await inspect()).value;
  say('INBOX-06 分类筛选 AI 失败只显示该分类', Boolean(filtered) && fdata?.types?.length === 1 && fdata.types[0] === 'ai_failed', {
    filtered, rows: fdata?.rows, types: fdata?.types, total: fdata?.totalText,
  });
  await evl(`(() => { const btn = [...document.querySelectorAll('.mt-inbox-tab')].find((el) => el.innerText.trim().startsWith('全部')); if (btn) btn.click(); return true; })()`);
  await until(`document.querySelectorAll('.mt-inbox-row').length >= 6`, 10_000);

  say('INBOX-07 无未捕获前端异常', consoleErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 3) });
  writeFileSync(join(OUT, 'visual-summary.json'), JSON.stringify({
    elapsedMs: elapsed, apiBefore: apiSummary.counts, apiAfter: apiAfter.counts, data, filtered: fdata, checks,
  }, null, 2), 'utf8');
} catch (e) {
  say('INBOX-FATAL 验收异常', false, String(e?.stack || e).slice(0, 900));
} finally {
  try { if (ws) ws.close(); } catch { /* 忽略 */ }
  try { if (chrome) killTree(chrome.pid); } catch { /* 忽略 */ }
  try { server.close(); } catch { /* 忽略 */ }
  save();
  console.log(`\n[t06295-visual] pass=${checks.filter((x) => x.ok).length} fail=${checks.filter((x) => !x.ok).length} out=${OUT}`);
  process.exit(checks.some((x) => !x.ok) ? 1 : 0);
}
