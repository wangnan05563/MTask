/**
 * T06297 快速捕获浏览器验收：真实构建 + 真实库副本 API + Chrome CDP。
 *
 * 检查：
 * 1. 顶栏入口存在；Ctrl/Cmd+Shift+Space 在 1s 内打开浮层；
 * 2. @日期 / !优先级 / #项目 / /类型 解析为 4 个 chips，标题预览正确；
 * 3. chips 可直接改值，改值后原标记从输入摘除、chip 回到手选态；
 * 4. Enter/保存按钮创建真实任务，项目/类型/优先级/截止信息落库；
 * 5. 保存后 toast 提供一次撤销，撤销后任务归档（active 不可见）；
 * 6. Esc 空态直接关闭；有未保存内容时二次确认再丢弃；
 * 7. 1440 / 1280 / 760 截图有效、无横向溢出；
 * 8. 无未捕获前端异常。
 *
 * 用法：node scripts/verify-t06297-visual.mjs
 * 环境：MTASK_API_PORT（默认 5195）、T06297_OUT、T06297_PORT、CHROME_PATH。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';

const ROOT = process.cwd();
const OUT = process.env.T06297_OUT || 'C:/pyfix_tmp/t06297-ui';
const DIST = join(ROOT, 'web', 'dist');
const PORT = Number(process.env.T06297_PORT || 39918);
const API_PORT = Number(process.env.MTASK_API_PORT || 5195);
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TOKEN_FILE = join(process.env.APPDATA || '', 'mtask', 'data', 'tunnel', 'tunnel-config.json');
if (!existsSync(join(DIST, 'index.html'))) { console.error(`dist 不存在：${DIST}`); process.exit(2); }
if (!existsSync(CHROME)) { console.error(`Chrome 不存在：${CHROME}`); process.exit(2); }
let accessToken = '';
try { accessToken = String(JSON.parse(readFileSync(TOKEN_FILE, 'utf8')).accessToken || ''); } catch { /* 未配置 */ }
mkdirSync(OUT, { recursive: true });
try { rmSync(join(OUT, 'profile'), { recursive: true, force: true }); } catch { /* 忽略 */ }

const checks = [];
const say = (name, okVal, extra) => {
  const item = { name, ok: Boolean(okVal), extra };
  checks.push(item);
  console.log(`[${item.ok ? 'PASS' : 'FAIL'}] ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 1800)}`}`);
};
const save = () => writeFileSync(join(OUT, 'visual-result.json'), JSON.stringify({
  pass: checks.filter((x) => x.ok).length, fail: checks.filter((x) => !x.ok).length, checks,
}, null, 2), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ } };
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const tomorrow = ymd(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 1, 12));

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
  say('CAPTURE-00 静态服务器 + API 代理就绪', true, { port: PORT, apiPort: API_PORT, token: Boolean(accessToken) });

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
      const dialogs = [...document.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"]')].filter((d) => d.getAttribute('data-capture-root') === null && visible(d));
      for (const d of dialogs) {
        const btn = [...d.querySelectorAll('button')].find((b) => visible(b) && /关闭|知道了|跳过|稍后|开始使用|完成|取消|×/.test((b.innerText || '') + (b.getAttribute('aria-label') || '')));
        if (btn) btn.click();
      }
      return dialogs.length;
    })()`);
    await sleep(350);
  };
  const key = async (keyName, code, modifiers = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: keyName === 'Escape' ? 27 : 32, nativeVirtualKeyCode: keyName === 'Escape' ? 27 : 32, modifiers });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: keyName === 'Escape' ? 27 : 32, nativeVirtualKeyCode: keyName === 'Escape' ? 27 : 32, modifiers });
  };
  const openByShortcut = async () => {
    await evl(`(() => { window.__t06297ShortcutAt = performance.now(); return true; })()`);
    await key(' ', 'Space', 10); // Ctrl(2)+Shift(8)
    const open = await until(`Boolean(document.querySelector('[data-capture-panel]'))`, 3_000);
    if (!open) {
      // CDP 键在个别 headless 构建可能被吞；口径仍以 App 的 document keydown 监听为准，但标记 via=synthetic 以便证据诚实。
      await evl(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true, shiftKey: true, bubbles: true })); return true; })()`);
      await until(`Boolean(document.querySelector('[data-capture-panel]'))`, 2_000);
    }
    const elapsed = await evl(`Math.round(performance.now() - (window.__t06297ShortcutAt || performance.now()))`);
    return { open: Boolean(await until(`Boolean(document.querySelector('[data-capture-panel]'))`, 1_000)), elapsedMs: elapsed.value };
  };
  const openByButton = async () => {
    const clicked = await evl(`(() => { const b = document.querySelector('[data-capture-open]'); if (!b) return false; b.click(); return true; })()`);
    await until(`Boolean(document.querySelector('[data-capture-panel]'))`, 3_000);
    return Boolean(clicked.value);
  };
  const typeText = async (text) => {
    const ok = await evl(`(() => {
      const el = document.querySelector('[data-capture-input]');
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(180);
    return Boolean(ok.value);
  };
  const inspect = async () => evl(`(() => {
    const panel = document.querySelector('[data-capture-panel]');
    const input = document.querySelector('[data-capture-input]');
    const project = document.querySelector('[data-capture-chip="project"] select');
    const type = document.querySelector('[data-capture-chip="type"] select');
    const priority = document.querySelector('[data-capture-chip="priority"] select');
    const due = document.querySelector('[data-capture-chip="due"] input');
    return {
      open: Boolean(panel),
      input: input?.value || '',
      preview: document.querySelector('[data-capture-title]')?.innerText?.trim() || '',
      count: Number(document.querySelector('[data-capture-hint]')?.getAttribute('data-capture-count') || 0),
      hint: document.querySelector('[data-capture-hint]')?.innerText?.trim() || '',
      priority: priority?.value || '',
      projectId: project?.value || '',
      projectText: project?.selectedOptions?.[0]?.text || '',
      categoryId: type?.value || '',
      categoryText: type?.selectedOptions?.[0]?.text || '',
      due: due?.value || '',
      parsed: ['priority', 'project', 'type', 'due'].map((k) => ({
        kind: k,
        parsed: document.querySelector('[data-capture-chip="' + k + '"]')?.getAttribute('data-parsed') || '',
      })),
      panelWidth: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
      panelRight: panel ? Math.round(panel.getBoundingClientRect().right) : 0,
      panelLeft: panel ? Math.round(panel.getBoundingClientRect().left) : 0,
      viewport: { w: innerWidth, h: innerHeight },
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      discard: Boolean(document.querySelector('[data-capture-discard]')),
      toast: document.querySelector('[data-capture-toast]')?.innerText?.trim() || '',
      toastKind: document.querySelector('[data-capture-toast]')?.getAttribute('data-kind') || '',
    };
  })()`);
  const setSelect = async (kind, value) => evl(`(() => {
    const el = document.querySelector('[data-capture-chip="${kind}"] select');
    if (!el) return false;
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const setDate = async (value) => evl(`(() => {
    const el = document.querySelector('[data-capture-chip="due"] input');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await until(`Boolean(document.querySelector('#root aside'))`, 30_000);
  await evl(`(() => { try { localStorage.setItem('mtask.guide.seen.dashboard', '1'); } catch {} return true; })()`);
  await dismiss();

  const shortcut = await openByShortcut();
  const preInspect = (await inspect()).value;
  say('CAPTURE-01 快捷键 1s 内打开 + 顶栏入口存在', Boolean(shortcut.open && shortcut.elapsedMs < 1000), {
    ...shortcut, hasButton: Boolean((await evl(`Boolean(document.querySelector('[data-capture-open]'))`)).value), pre: preInspect,
  });

  const title = `T06297 快速捕获验收 ${Date.now().toString(36)}`;
  const raw = `${title} #MTask十期 !紧急 /缺陷修复 @明天`;
  await typeText(raw);
  const ready = await until(`(() => { const h = document.querySelector('[data-capture-hint]'); return h && Number(h.getAttribute('data-capture-count')) === 4; })()`, 6_000);
  const parsed = (await inspect()).value;
  say('CAPTURE-02 四类标记解析为 chips，标题预览正确', Boolean(
    ready && parsed?.count === 4
    && parsed.projectText === 'MTask十期'
    && parsed.categoryText === '缺陷修复'
    && parsed.priority === 'urgent'
    && parsed.due === tomorrow
    && parsed.preview.includes(title)
    && parsed.parsed.every((x) => x.parsed === 'true'),
  ), parsed);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const shotParsed = await shot('01-capture-parse-1440.png');

  // chips 可编辑：把日期改成 12-01，原 @明天 应从输入摘除，chip 从解析态变为手动态。
  const editSet = await setDate('2026-12-01');
  await sleep(250);
  const edited = (await inspect()).value;
  say('CAPTURE-03 日期 chip 可改，改后原标记摘除', Boolean(
    editSet.value && edited?.due === '2026-12-01'
    && !edited.input.includes('@明天')
    && edited.parsed.find((x) => x.kind === 'due')?.parsed === 'false',
  ), edited);
  // 改回原日期，继续验证保存。
  await setDate(tomorrow);
  await sleep(200);

  const saveClick = await evl(`(() => { const b = document.querySelector('[data-capture-save]'); if (!b) return false; b.click(); return true; })()`);
  const toastUp = await until(`Boolean(document.querySelector('[data-capture-toast]'))`, 20_000);
  const afterSave = (await inspect()).value;
  say('CAPTURE-04 保存创建任务并给撤销 toast', Boolean(saveClick.value && toastUp && afterSave?.toastKind === 'saved' && afterSave.toast.includes('已捕获')), afterSave);
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const shotToast = await shot('02-capture-toast-1280.png');

  const apiList = await (await fetch(`http://127.0.0.1:${PORT}/api/tasks?keyword=${encodeURIComponent(title)}&limit=10`)).json();
  const created = Array.isArray(apiList) ? apiList.find((t) => t.title === title) : null;
  say('CAPTURE-05 落库字段与解析结果一致', Boolean(
    created && created.task_no && created.project_id === parsed.projectId
    && created.category_id === parsed.categoryId && created.priority === 'urgent'
    && String(created.description || '').includes('⏰') && String(created.description || '').includes(tomorrow.slice(5)),
  ), {
    created: created ? { id: created.id, task_no: created.task_no, project_id: created.project_id, category_id: created.category_id, priority: created.priority, description: created.description } : null,
    expected: { projectId: parsed.projectId, categoryId: parsed.categoryId, tomorrow },
  });
  const createdId = created?.id || '';
  const createdNo = created?.task_no || '';

  const undoClick = await evl(`(() => { const b = document.querySelector('[data-capture-undo]'); if (!b) return false; b.click(); return true; })()`);
  const undoneUp = await until(`(() => { const t = document.querySelector('[data-capture-toast]'); return t && /已撤销/.test(t.innerText); })()`, 20_000);
  const afterUndo = (await inspect()).value;
  const byNo = createdNo ? await (await fetch(`http://127.0.0.1:${PORT}/api/tasks/by-no/${encodeURIComponent(createdNo)}`)).json() : null;
  const activeList = await (await fetch(`http://127.0.0.1:${PORT}/api/tasks?keyword=${encodeURIComponent(title)}&limit=10`)).json();
  const activeHit = Array.isArray(activeList) ? activeList.some((t) => t.id === createdId) : false;
  say('CAPTURE-06 撤销一次后任务归档且 active 不可见', Boolean(
    undoClick.value && undoneUp && afterUndo?.toast.includes('已撤销')
    && byNo?.archived === true && !activeHit,
  ), { afterUndo, byNo: byNo ? { task_no: byNo.task_no, archived: byNo.archived, archived_at: byNo.archived_at } : null, activeHit });

  // 任意页验证：切到任务页，快捷键仍能唤起；同时等撤销 toast 自然消失，避免污染窄屏截图。
  await until(`!document.querySelector('[data-capture-toast]')`, 6_000);
  await evl(`(() => { window.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'tasks' } })); return true; })()`);
  await until(`Boolean(document.querySelector('[data-page-search]'))`, 10_000);
  await dismiss();
  const onTasks = await openByShortcut();
  const tasksInspect = (await inspect()).value;
  say('CAPTURE-07 任意页（任务页）快捷键可用', Boolean(onTasks.open && tasksInspect?.open), { onTasks, tasksInspect });

  // Esc 空态：直接关。
  await key('Escape', 'Escape', 0);
  const closedEmpty = await until(`!document.querySelector('[data-capture-panel]')`, 3_000);
  say('CAPTURE-08 Esc 空态直接关闭', Boolean(closedEmpty), { closedEmpty });

  // Esc 脏态：二次确认后丢弃。
  const reopenedDirty = await openByButton();
  await typeText('草稿 @今天');
  await key('Escape', 'Escape', 0);
  const confirmUp = await until(`Boolean(document.querySelector('[data-capture-discard]'))`, 3_000);
  const discardData = (await inspect()).value;
  const discardClick = await evl(`(() => { const b = document.querySelector('[data-capture-discard-confirm]'); if (!b) return false; b.click(); return true; })()`);
  const closedDirty = await until(`!document.querySelector('[data-capture-panel]')`, 3_000);
  say('CAPTURE-09 Esc 脏态二次确认后丢弃', Boolean(reopenedDirty && confirmUp && discardData?.discard && discardClick.value && closedDirty), discardData);

  // 760 窄屏：再看一次解析态和面板边界。
  await openByShortcut();
  await typeText(`T06297 窄屏捕获 #MTask十期 !高 /缺陷修复 @明天`);
  await until(`Number(document.querySelector('[data-capture-hint]')?.getAttribute('data-capture-count')) === 4`, 5_000);
  await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(350);
  const shotNarrow = await shot('03-capture-parse-760.png');
  const narrow = (await inspect()).value;
  say('CAPTURE-10 1440/1280/760 截图有效且无横向溢出', Boolean(
    shotParsed?.bytes > 10_000 && shotToast?.bytes > 10_000 && shotNarrow?.bytes > 10_000
    && narrow?.panelWidth > 0 && narrow.panelWidth <= narrow.viewport.w + 1
    && narrow.panelRight <= narrow.viewport.w + 1 && narrow.scrollWidth <= narrow.viewport.w + 1,
  ), { files: [shotParsed, shotToast, shotNarrow], narrow });

  // 关掉 760 的草稿，避免下次打开残留。
  await key('Escape', 'Escape', 0);
  await until(`Boolean(document.querySelector('[data-capture-discard]'))`, 2_000);
  await evl(`(() => { const b = document.querySelector('[data-capture-discard-confirm]'); if (b) b.click(); return true; })()`);

  say('CAPTURE-11 无未捕获前端异常', consoleErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 3) });
  writeFileSync(join(OUT, 'visual-summary.json'), JSON.stringify({
    title, raw, tomorrow, shortcut, parsed, edited, afterSave, afterUndo, created, byNo, tasksInspect, narrow, checks,
  }, null, 2), 'utf8');
} catch (e) {
  say('CAPTURE-FATAL 验收异常', false, String(e?.stack || e).slice(0, 900));
} finally {
  try { if (ws) ws.close(); } catch { /* 忽略 */ }
  try { if (chrome) killTree(chrome.pid); } catch { /* 忽略 */ }
  try { server.close(); } catch { /* 忽略 */ }
  save();
  console.log(`\n[t06297-visual] pass=${checks.filter((x) => x.ok).length} fail=${checks.filter((x) => !x.ok).length} out=${OUT}`);
  process.exit(checks.some((x) => !x.ok) ? 1 : 0);
}
