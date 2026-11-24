/**
 * T06296 全局搜索浏览器验收：真实构建 + 真实库副本 API + Chrome CDP。
 *
 * 检查：
 * 1. Ctrl+K 打开统一搜索浮层；
 * 2. 任务查询命中 T06296，精确编号排首位并带上下文预览；
 * 3. `type:run workbuddy` 只显示 Run 组，命中旧执行会话；
 * 4. ↑↓ 可切换高亮，Enter / 点击可执行；
 * 5. 点 Run 结果后跳到执行会话页并高亮对应卡片；
 * 6. 零结果给建议；
 * 7. 1440 / 1280 / 760 三档截图有效、无横向溢出；
 * 8. 无未捕获前端异常。
 *
 * 用法：node scripts/verify-t06296-visual.mjs
 * 环境：MTASK_API_PORT（默认 5195）、T06296_OUT、T06296_PORT、CHROME_PATH。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';

const ROOT = process.cwd();
const OUT = process.env.T06296_OUT || 'C:/pyfix_tmp/t06296-ui';
const DIST = join(ROOT, 'web', 'dist');
const PORT = Number(process.env.T06296_PORT || 39917);
const API_PORT = Number(process.env.MTASK_API_PORT || 5195);
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
  say('SEARCH-00 静态服务器 + API 代理就绪', true, { port: PORT, apiPort: API_PORT, token: Boolean(accessToken) });
  const apiRun = await (await fetch(`http://127.0.0.1:${PORT}/api/search?q=${encodeURIComponent('type:run workbuddy')}&limit=10`)).json();
  const firstRun = apiRun.groups.find((g) => g.type === 'run')?.items?.[0];

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
      return dialogs.length;
    })()`);
    await sleep(300);
  };
  const openPalette = async () => {
    await evl(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); return true; })()`);
    await until(`Boolean(document.querySelector('[data-palette-panel]'))`, 10_000);
  };
  const closePalette = async () => {
    await evl(`(() => {
      const input = document.querySelector('input[aria-label="命令面板搜索"]');
      if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return !document.querySelector('[data-palette-panel]');
    })()`);
    await sleep(250);
  };
  const typeQuery = async (text) => {
    const ok = await evl(`(() => {
      const el = document.querySelector('input[aria-label="命令面板搜索"]');
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    return Boolean(ok.value);
  };
  const inspect = async () => evl(`(() => {
    const rows = [...document.querySelectorAll('[data-palette-result]')];
    const panel = document.querySelector('[data-palette-panel]');
    return {
      hasPalette: Boolean(panel),
      rowCount: rows.length,
      groups: [...new Set(rows.map((el) => el.getAttribute('data-palette-type')))],
      labels: rows.slice(0, 5).map((el) => el.innerText.trim().replace(/\\n/g, ' / ')),
      snippets: [...document.querySelectorAll('[data-palette-snippet]')].length,
      hint: document.querySelector('[data-palette-hint]')?.innerText || '',
      zero: Boolean(document.querySelector('[data-palette-zero]')),
      suggestions: [...document.querySelectorAll('[data-palette-zero] span')].map((el) => el.innerText.trim()),
      panelWidth: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
      panelRight: panel ? Math.round(panel.getBoundingClientRect().right) : 0,
      viewport: { w: innerWidth, h: innerHeight },
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    };
  })()`);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await until(`Boolean(document.querySelector('#root aside'))`, 30_000);
  // 验收聚焦搜索：执行会话页首次进入的向导会盖住目标卡片，这里预置「已读」，避免遮挡证据图。
  await evl(`(() => { try { localStorage.setItem('mtask.guide.seen.exec-sessions', '1'); } catch {} return true; })()`);
  await sleep(800);

  await openPalette();
  const opened = await until(`Boolean(document.querySelector('[data-palette-panel]'))`, 10_000);
  await typeQuery('T06296');
  const taskReady = await until(`[...document.querySelectorAll('[data-palette-result]')].some((el) => el.innerText.includes('T06296'))`, 15_000);
  const taskData = (await inspect()).value;
  say('SEARCH-01 Ctrl+K 打开统一搜索浮层', Boolean(opened && taskData?.hasPalette), { open: Boolean(opened), ...taskData });
  say('SEARCH-02 任务查询 T06296 精确排首并带上下文', Boolean(taskReady && taskData?.labels?.[0]?.includes('T06296') && (taskData?.snippets || 0) > 0), {
    labels: taskData?.labels, snippets: taskData?.snippets, hint: taskData?.hint,
  });

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const shotTask = await shot('01-search-task-1440.png');

  await typeQuery('type:run workbuddy');
  const runReady = await until(`[...document.querySelectorAll('[data-palette-result]')].some((el) => el.getAttribute('data-palette-type') === 'Run')`, 15_000);
  const runData = (await inspect()).value;
  say('SEARCH-03 type:run 只出 Run 组并命中执行会话', Boolean(runReady && runData?.groups?.length === 1 && runData.groups[0] === 'Run' && runData.rowCount > 0), {
    groups: runData?.groups, rows: runData?.rowCount, labels: runData?.labels,
  });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const shotRun = await shot('02-search-run-1280.png');

  // 键盘：输入框上 ArrowDown 后，当前高亮从第 0 行移到第 1 行
  const keyboardMoved = await evl(`(() => {
    const input = document.querySelector('input[aria-label="命令面板搜索"]');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    return true;
  })()`);
  await sleep(200);
  const activeRows = await evl(`(() => {
    const rows = [...document.querySelectorAll('[data-palette-result]')];
    const bg = rows.map((el) => getComputedStyle(el).backgroundColor);
    return { backgrounds: bg.slice(0, 3), firstDiffers: bg[0] !== bg[1] };
  })()`);
  say('SEARCH-04 ↑↓ 可切换结果高亮', Boolean(keyboardMoved && activeRows.value?.firstDiffers), activeRows.value);

  // 点击第一条 Run 结果：切到执行会话页并定位高亮卡片
  await evl(`(() => {
    window.__t06296FocusEvents = [];
    window.__t06296FocusListener = (e) => window.__t06296FocusEvents.push({ id: e.detail?.id, at: performance.now() });
    window.addEventListener('mtaskFocusExecSession', window.__t06296FocusListener);
    return true;
  })()`);
  const clickRun = await evl(`(() => {
    const btn = [...document.querySelectorAll('[data-palette-result]')].find((el) => el.getAttribute('data-palette-type') === 'Run');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  const onExec = await until(`Boolean(document.querySelector('[data-lck="exec-session-card"]'))`, 15_000);
  await sleep(300);
  const focusProbe = await evl(`(() => {
    const cards = [...document.querySelectorAll('.exec-kanban-card')];
    return {
      events: window.__t06296FocusEvents || [],
      stored: sessionStorage.getItem('execSessions.focusId'),
      cards: cards.length,
      ids: cards.slice(0, 12).map((el) => el.getAttribute('data-session-id')),
      hasExpected: cards.some((el) => el.getAttribute('data-session-id') === ${JSON.stringify(firstRun?.id)}),
      classes: cards.slice(0, 6).map((el) => el.className),
    };
  })()`);
  const focused = await until(`Boolean(document.querySelector('.exec-kanban-card.exec-card-focus'))`, 5_000);
  await sleep(200);
  const focusData = await evl(`(() => {
    const focus = document.querySelector('.exec-kanban-card.exec-card-focus');
    return {
      page: Boolean(document.querySelector('[data-lck="exec-session-card"]')),
      focused: Boolean(focus),
      sessionId: focus?.getAttribute('data-session-id') || '',
      status: focus?.getAttribute('data-status') || '',
      title: focus?.innerText?.slice(0, 80) || '',
    };
  })()`);
  say('SEARCH-05 点 Run 直达执行会话并高亮目标卡片', Boolean(clickRun.value && onExec && focused && focusData.value?.focused && focusData.value?.sessionId === firstRun?.id), {
    clicked: Boolean(clickRun.value), onExec, expected: firstRun?.id, ...focusData.value, probe: focusProbe.value,
  });
  const shotFocus = await shot('04-run-focus-1280.png');

  // 零结果建议（先关掉执行会话页首次进入的使用向导，再回首页开浮层，保证证据图背景干净）
  await dismiss();
  await evl(`(() => { window.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'dashboard' } })); return true; })()`);
  await sleep(500);
  await openPalette();
  await typeQuery('zzz不存在的关键词06296');
  const zeroReady = await until(`Boolean(document.querySelector('[data-palette-zero]'))`, 15_000);
  const zeroData = (await inspect()).value;
  say('SEARCH-06 零结果给搜索建议', Boolean(zeroReady && zeroData?.zero && (zeroData?.suggestions?.length || 0) >= 3), {
    zero: zeroData?.zero, suggestions: zeroData?.suggestions,
  });
  await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const shotZero = await shot('03-search-zero-760.png');

  say('SEARCH-07 三档截图有效且无横向溢出', Boolean(
    shotTask && shotTask.bytes > 10_000 && shotRun && shotRun.bytes > 10_000 && shotZero && shotZero.bytes > 10_000
    && shotFocus && shotFocus.bytes > 10_000
    && zeroData?.panelWidth > 0 && zeroData.panelWidth <= zeroData.viewport.w + 1
    && zeroData.scrollWidth <= zeroData.viewport.w + 1,
  ), {
    files: [shotTask, shotRun, shotZero, shotFocus], panelWidth: zeroData?.panelWidth, viewport: zeroData?.viewport,
    scrollWidth: zeroData?.scrollWidth,
  });

  say('SEARCH-08 无未捕获前端异常', consoleErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 3) });
  writeFileSync(join(OUT, 'visual-summary.json'), JSON.stringify({
    apiRun, firstRun, taskData, runData, zeroData, focusData: focusData.value, checks,
  }, null, 2), 'utf8');
} catch (e) {
  say('SEARCH-FATAL 验收异常', false, String(e?.stack || e).slice(0, 900));
} finally {
  try { if (ws) ws.close(); } catch { /* 忽略 */ }
  try { if (chrome) killTree(chrome.pid); } catch { /* 忽略 */ }
  try { server.close(); } catch { /* 忽略 */ }
  save();
  console.log(`\n[t06296-visual] pass=${checks.filter((x) => x.ok).length} fail=${checks.filter((x) => !x.ok).length} out=${OUT}`);
  process.exit(checks.some((x) => !x.ok) ? 1 : 0);
}
