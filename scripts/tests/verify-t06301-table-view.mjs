/**
 * T06301 表格视图验收 —— 视图切换 / 列宽拖拽 / 表头冻结 / 详情抽屉 / 截图证据。
 *
 * 用法：node scripts/tests/verify-t06301-table-view.mjs
 * 前置：npm run build:web；本地后端可访问（默认 39877，可用 MTASK_API_PORT 覆盖）。
 * 产出默认：D:/tmp/t06301-table
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';

const ROOT = process.cwd();
const OUT = process.env.T06301_OUT || 'D:/tmp/t06301-table';
const DIST = join(ROOT, 'web', 'dist');
const PORT = Number(process.env.T06301_PORT || 39921);
const CDP_PORT = Number(process.env.T06301_CDP_PORT || 9335);
const API_PORT = Number(process.env.MTASK_API_PORT || 39877);
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const AXE = process.env.AXE_PATH || 'D:/tmp/t06309-axe/node_modules/axe-core/axe.min.js';
const TOKEN_FILE = join(process.env.APPDATA || '', 'mtask', 'data', 'tunnel', 'tunnel-config.json');
const PROJECT_ID = process.env.T06301_PROJECT || '586ae8c6-2e08-4180-86ba-732f1fab5006';
const RUN_ID = Date.now().toString(36);

if (!existsSync(join(DIST, 'index.html'))) { console.error(`dist 不存在，请先构建：${DIST}`); process.exit(2); }
if (!existsSync(CHROME)) { console.error(`Chrome 不存在：${CHROME}`); process.exit(2); }
const hasAxe = existsSync(AXE);
const axeSource = hasAxe ? readFileSync(AXE, 'utf8') : '';
let accessToken = '';
try { accessToken = String(JSON.parse(readFileSync(TOKEN_FILE, 'utf8')).accessToken || ''); } catch { /* 未配置令牌 */ }

mkdirSync(OUT, { recursive: true });
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
const server = createServer((req, res) => {
  const raw = req.url || '/';
  if (raw.startsWith('/api/')) {
    const upstream = httpRequest({
      host: '127.0.0.1', port: API_PORT, path: raw, method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${API_PORT}`, ...(accessToken ? { 'X-Access-Token': accessToken } : {}) },
    }, (up) => { res.writeHead(up.statusCode || 502, up.headers); up.pipe(res); });
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

const checks = [];
const say = (name, okVal, extra) => {
  const item = { name, ok: Boolean(okVal), extra };
  checks.push(item);
  console.log(`[${item.ok ? 'PASS' : 'FAIL'}] ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 1400)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ } };
const pngSize = (buf) => {
  if (buf.length < 24 || buf.subarray(1, 4).toString() !== 'PNG') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
};
const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

let chrome = null;
let ws = null;
try {
  await new Promise((resolve, reject) => server.listen(PORT, '127.0.0.1', resolve).once('error', reject));
  say('T06301-00 静态服务器 / API 代理就绪', true, { port: PORT, apiPort: API_PORT, token: Boolean(accessToken) });

  chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(OUT, `profile-${RUN_ID}`)}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1280,900', '--disable-features=Translate', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let chromeTail = '';
  chrome.stderr.on('data', (d) => { chromeTail = (chromeTail + String(d)).slice(-400); });
  chrome.stdout.on('data', (d) => { chromeTail = (chromeTail + String(d)).slice(-400); });
  let targets = null;
  for (let i = 0; i < 120 && !targets; i += 1) {
    await sleep(500);
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) targets = await res.json();
    } catch { /* 尚未就绪 */ }
  }
  if (!targets) throw new Error(`Chrome 20s 内未开放调试端口 ${CDP_PORT}：${chromeTail}`);
  const target = targets.find((x) => x.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP 连接失败')); });
  let seq = 0;
  const waits = new Map();
  const runtimeErrors = [];
  ws.onmessage = (message) => {
    const msg = JSON.parse(String(message.data));
    if (msg.id !== undefined && waits.has(msg.id)) { waits.get(msg.id)(msg); waits.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') runtimeErrors.push(String(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || '').slice(0, 300));
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
      await sleep(250);
    }
    return null;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (!r?.data) return null;
    const buf = Buffer.from(r.data, 'base64');
    writeFileSync(join(OUT, name), buf);
    return { bytes: buf.length, sha: sha(buf), size: pngSize(buf) };
  };
  const clickByLabel = async (label) => evl(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').trim() === ${JSON.stringify(label)});
    if (!btn) return false;
    btn.click();
    return true;
  })()`);

  await send('Page.enable');
  await send('Runtime.enable');
  if (hasAxe) await send('Page.addScriptToEvaluateOnNewDocument', { source: axeSource });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  const appReady = await until(`Boolean(document.querySelector('#root aside'))`, 30_000);
  say('T06301-01 生产构建加载成功', Boolean(appReady));

  await evl(`(() => {
    localStorage.setItem('tasks.activeProject', ${JSON.stringify(JSON.stringify(PROJECT_ID))});
    localStorage.setItem('mtask.guide.seen.tasks', '1');
    sessionStorage.setItem('tasks.viewMode', JSON.stringify('list'));
    window.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'tasks' } }));
    return true;
  })()`);
  const tasksReady = await until(`Boolean(document.querySelector('[data-t06301="view-toggle"]'))`, 30_000);
  say('T06301-02 任务页视图切换入口加载', Boolean(tasksReady));
  const guideClose = await evl(`(() => {
    const guide = document.querySelector('dialog[open][aria-label*="使用向导"]');
    if (!guide) return 'none';
    const skip = [...guide.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '跳过' || (b.getAttribute('aria-label') || '') === '跳过');
    if (!skip) return 'no-skip';
    skip.click();
    return 'skipped';
  })()`);
  await sleep(350);
  const guideGone = await evl(`!document.querySelector('dialog[open][aria-label*="使用向导"]')`);
  say('T06301-02b 首次使用向导不遮挡验收', Boolean(guideGone.value), { guide: guideClose.value });
  const toggleInfo = await evl(`(() => {
    const box = document.querySelector('[data-t06301="view-toggle"]');
    const buttons = [...(box?.querySelectorAll('button') || [])];
    return {
      count: buttons.length,
      labels: buttons.map((b) => b.getAttribute('aria-label')),
      visible: Boolean(box && box.getBoundingClientRect().width && box.getBoundingClientRect().height && getComputedStyle(box).visibility !== 'hidden'),
    };
  })()`);
  say('T06301-03 视图切换常驻且含列表/看板/表格三项', (toggleInfo.value?.count || 0) >= 3 && toggleInfo.value?.visible && ['列表视图', '看板视图', '表格视图'].every((x) => (toggleInfo.value?.labels || []).includes(x)), toggleInfo.value);

  const switchedTable = await clickByLabel('表格视图');
  const tableReady = await until(`(() => {
    const wrap = document.querySelector('[data-t06301="table"] .mt-table-wrap');
    return Boolean(wrap && wrap.querySelectorAll('[data-t06301="row-title"]').length > 0);
  })()`, 25_000);
  say('T06301-04 表格视图渲染任务行', Boolean(switchedTable.value) && Boolean(tableReady));

  const tableInfo = await evl(`(() => {
    const wrap = document.querySelector('[data-t06301="table"] .mt-table-wrap');
    const table = wrap?.querySelector('.mt-table');
    const headers = [...(table?.querySelectorAll('th') || [])].map((th) => (th.innerText || '').trim());
    const rows = [...(table?.querySelectorAll('tbody tr') || [])];
    return {
      headers,
      rowCount: rows.length,
      firstText: (rows[0]?.innerText || '').replace(/\\s+/g, ' ').slice(0, 160),
      resizableHeaders: [...(table?.querySelectorAll('th[data-resizable="true"]') || [])].length,
      badgesPerFirstRow: rows[0]?.querySelectorAll('.mt-badge').length || 0,
    };
  })()`);
  const headersOk = ['编号', '任务', '状态', '优先级', '分类', '更新时间', '操作'].every((x) => (tableInfo.value?.headers || []).includes(x));
  say('T06301-05 表格列齐备且行内徽标不堆叠', headersOk && (tableInfo.value?.rowCount || 0) > 0 && (tableInfo.value?.resizableHeaders || 0) >= 6 && (tableInfo.value?.badgesPerFirstRow || 0) <= 2, tableInfo.value);

  const sticky = await evl(`(() => {
    const wrap = document.querySelector('[data-t06301="table"] .mt-table-wrap');
    const th = wrap?.querySelector('th');
    if (!wrap || !th) return null;
    const wrapTop = wrap.getBoundingClientRect().top;
    const before = th.getBoundingClientRect().top;
    wrap.scrollTop = 160;
    return { wrapTop, before, scrollTop: wrap.scrollTop, scrollHeight: wrap.scrollHeight, clientHeight: wrap.clientHeight, position: getComputedStyle(th).position };
  })()`);
  await sleep(180);
  const stickyAfter = await evl(`(() => {
    const wrap = document.querySelector('[data-t06301="table"] .mt-table-wrap');
    const th = wrap?.querySelector('th');
    return { after: th.getBoundingClientRect().top, scrollTop: wrap.scrollTop };
  })()`);
  const stickyOk = sticky.value?.position === 'sticky'
    && sticky.value?.scrollHeight > sticky.value?.clientHeight + 40
    && Math.abs((stickyAfter.value?.after ?? 999) - (sticky.value?.before ?? 0)) <= 2
    && Math.abs((stickyAfter.value?.after ?? 999) - (sticky.value?.wrapTop ?? 0)) <= 3;
  say('T06301-06 表头在内容区滚动时冻结', stickyOk, { ...sticky.value, ...stickyAfter.value });

  const dragResult = await evl(`(() => {
    const th = document.querySelector('[data-column-key="task_no"]');
    const handle = th?.querySelector('.mt-table__resize');
    if (!th || !handle) return null;
    const r = handle.getBoundingClientRect();
    const startX = r.left + r.width / 2;
    const startY = r.top + r.height / 2;
    const before = th.getBoundingClientRect().width;
    handle.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
      clientX: startX, clientY: startY, button: 0, buttons: 1,
    }));
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, pointerId: 1, pointerType: 'mouse',
      clientX: startX + 80, clientY: startY, button: 0, buttons: 1,
    }));
    window.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, pointerId: 1, pointerType: 'mouse',
      clientX: startX + 80, clientY: startY, button: 0, buttons: 0,
    }));
    return { before, startX, startY };
  })()`);
  await sleep(220);
  const afterResize = await evl(`(() => {
    const th = document.querySelector('[data-column-key="task_no"]');
    return { width: th?.getBoundingClientRect().width, styleWidth: th?.parentElement?.querySelector('col')?.style.width };
  })()`);
  say('T06301-07 列宽可拖拽（+80px）', Boolean(dragResult.value) && (afterResize.value?.width || 0) >= (dragResult.value?.before || 0) + 60, { before: dragResult.value, after: afterResize.value });

  const resetResize = await evl(`(() => {
    const handle = document.querySelector('[data-column-key="task_no"] .mt-table__resize');
    if (!handle) return false;
    handle.focus();
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    return true;
  })()`);
  await sleep(160);
  const afterReset = await evl(`(() => {
    const th = document.querySelector('[data-column-key="task_no"]');
    return { width: th?.getBoundingClientRect().width };
  })()`);
  say('T06301-08 列宽键盘 Home 恢复默认', Boolean(resetResize.value) && Math.abs((afterReset.value?.width || 0) - (dragResult.value?.before || 0)) <= 2, { before: dragResult.value?.before, reset: afterReset.value?.width });

  const drawerClick = await evl(`(() => {
    const btn = document.querySelector('[data-t06301="row-title"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  const drawerOpen = await until(`(() => {
    const dialogs = [...document.querySelectorAll('dialog[open][aria-modal="true"]')];
    return Boolean(dialogs.find((d) => {
      if (!d.getAttribute('aria-labelledby')) return false;
      const cs = getComputedStyle(d.parentElement);
      return cs.visibility === 'visible' && d.getBoundingClientRect().width > 200;
    }));
  })()`, 10_000);
  say('T06301-09 行标题可打开详情抽屉', Boolean(drawerClick.value) && Boolean(drawerOpen));
  const drawerTitle = await evl(`(() => {
    const dialogs = [...document.querySelectorAll('dialog[open][aria-modal="true"]')];
    const d = dialogs.find((x) => {
      if (!x.getAttribute('aria-labelledby')) return false;
      const cs = getComputedStyle(x.parentElement);
      return cs.visibility === 'visible' && x.getBoundingClientRect().width > 200;
    });
    return { text: (d?.innerText || '').replace(/\\s+/g, ' ').slice(0, 120), open: Boolean(d) };
  })()`);
  await evl(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await sleep(350);
  const drawerClosed = await evl(`(() => {
    const dialogs = [...document.querySelectorAll('dialog[open][aria-modal="true"]')];
    return !dialogs.find((d) => {
      if (!d.getAttribute('aria-labelledby')) return false;
      const cs = getComputedStyle(d.parentElement);
      return cs.visibility === 'visible' && d.getBoundingClientRect().width > 200;
    });
  })()`);
  say('T06301-10 Esc 可关闭详情抽屉', Boolean(drawerClosed.value) && /T06334|任务菜单/.test(drawerTitle.value?.text || ''), drawerTitle.value);

  const lightShot = await shot('table-light.png');
  say('T06301-11 light 表格截图有效', Boolean(lightShot && lightShot.bytes > 20_000 && lightShot.size?.width >= 1200), lightShot);

  await evl(`document.documentElement.setAttribute('data-theme', 'dark'); true`);
  await sleep(350);
  const darkShot = await shot('table-dark.png');
  say('T06301-12 dark 表格截图有效', Boolean(darkShot && darkShot.bytes > 20_000 && darkShot.size?.width >= 1200), darkShot);
  await evl(`document.documentElement.setAttribute('data-theme', 'light'); true`);
  await sleep(250);

  let contrast = null;
  if (hasAxe) {
    contrast = await evl(`(async () => {
      const res = await axe.run(document, { runOnly: { type: 'rule', values: ['color-contrast'] } });
      return { count: res.violations.length, nodes: res.violations.reduce((n, v) => n + v.nodes.length, 0), first: res.violations[0]?.nodes?.[0]?.target };
    })()`);
  }
  say('T06301-13 表格视图 color-contrast 门禁', Boolean(hasAxe) && contrast?.value?.count === 0, contrast?.value ?? 'axe 缺失');

  const listOk = await clickByLabel('列表视图');
  await sleep(250);
  const listVisible = await evl(`Boolean(document.querySelector('ul[data-t03215-window]'))`);
  const boardOk = await clickByLabel('看板视图');
  await sleep(250);
  const boardVisible = await evl(`Boolean([...document.querySelectorAll('h4')].find((h) => (h.innerText || '').includes('待办（')))`);
  const tableBack = await clickByLabel('表格视图');
  await sleep(250);
  const tableVisible = await evl(`Boolean(document.querySelector('[data-t06301="table"] .mt-table'))`);
  say('T06301-14 列表 / 看板 / 表格三视图可往返切换', Boolean(listOk.value) && Boolean(listVisible.value) && Boolean(boardOk.value) && Boolean(boardVisible.value) && Boolean(tableBack.value) && Boolean(tableVisible.value), { listVisible: listVisible.value, boardVisible: boardVisible.value, tableVisible: tableVisible.value });

  const finalInfo = await evl(`(() => {
    const wrap = document.querySelector('[data-t06301="table"] .mt-table-wrap');
    const table = wrap?.querySelector('.mt-table');
    return {
      mode: sessionStorage.getItem('tasks.viewMode'),
      rowCount: table?.querySelectorAll('tbody tr').length || 0,
      headerSticky: getComputedStyle(table?.querySelector('th')).position,
      activeTab: [...document.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.innerText).filter(Boolean).slice(0, 3),
    };
  })()`);
  say('T06301-15 表格视图会话级保持', (finalInfo.value?.mode || '').includes('table') && (finalInfo.value?.rowCount || 0) > 0, finalInfo.value);

  const doneTabClick = await evl(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /^已完成/.test((b.innerText || '').trim()));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await sleep(600);
  const doneTable = await evl(`(() => {
    const table = document.querySelector('[data-t06301="table"] .mt-table');
    const rows = [...(table?.querySelectorAll('tbody tr') || [])];
    return { rowCount: rows.length, first: (rows[0]?.innerText || '').replace(/\\s+/g, ' ').slice(0, 120) };
  })()`);
  say('T06301-16 已完成页签表格可用', Boolean(doneTabClick.value) && (doneTable.value?.rowCount || 0) > 0 && /已完成/.test(doneTable.value?.first || ''), doneTable.value);

  const shelvedTabClick = await evl(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /^搁置/.test((b.innerText || '').trim()));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await sleep(500);
  const shelvedTable = await evl(`(() => {
    const table = document.querySelector('[data-t06301="table"] .mt-table');
    const empty = table?.querySelector('.mt-table__empty');
    return { rowCount: table?.querySelectorAll('tbody tr').length || 0, emptyText: (empty?.innerText || '').slice(0, 80), hasEmpty: Boolean(empty) };
  })()`);
  say('T06301-17 搁置页签空态可读', Boolean(shelvedTabClick.value) && Boolean(shelvedTable.value?.hasEmpty) && /暂无搁置任务/.test(shelvedTable.value?.emptyText || ''), shelvedTable.value);

  const todoTabBack = await evl(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /^待办/.test((b.innerText || '').trim()));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await sleep(500);
  const todoTableBack = await evl(`(() => {
    const table = document.querySelector('[data-t06301="table"] .mt-table');
    return { rowCount: table?.querySelectorAll('tbody tr').length || 0, first: (table?.querySelector('tbody tr')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 80) };
  })()`);
  say('T06301-18 待办页签可返回且表格续用', Boolean(todoTabBack.value) && (todoTableBack.value?.rowCount || 0) > 0, todoTableBack.value);

  say('T06301-19 页面无运行时异常', runtimeErrors.length === 0, runtimeErrors.slice(-3));
} catch (e) {
  say('T06301-FATAL 测试异常', false, String(e?.stack || e).slice(0, 800));
} finally {
  try { if (ws) ws.close(); } catch { /* 忽略 */ }
  try { if (chrome) killTree(chrome.pid); } catch { /* 忽略 */ }
  try { server.close(); } catch { /* 忽略 */ }
  const summary = { generatedAt: new Date().toISOString(), project: PROJECT_ID, pass: checks.filter((x) => x.ok).length, fail: checks.filter((x) => !x.ok).length, checks };
  writeFileSync(join(OUT, 'result.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\n[t06301-table] pass=${summary.pass} fail=${summary.fail} out=${OUT}`);
  process.exit(summary.fail ? 1 : 0);
}
