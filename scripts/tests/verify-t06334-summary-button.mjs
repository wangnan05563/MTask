/**
 * T06334 任务菜单 AI 梳理摘要按钮验收 —— 位置/纯图标/UI 库组件/悬浮提示/点击展开/响应式/截图。
 *
 * 隔离运行：临时后端（默认 39933）+ 临时数据目录 + 全新项目/任务；生产 :39877 全程不触碰。
 * 用法：node scripts/tests/verify-t06334-summary-button.mjs
 * 前置：npm run build:web（默认读取 web/dist）。
 * 产出默认：D:/tmp/t06334-summary
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = join(import.meta.dirname, '..', '..');
const OUT = process.env.T06334_OUT || 'D:/tmp/t06334-summary';
const DIST = process.env.T06334_DIST || join(ROOT, 'web', 'dist');
const PORT = Number(process.env.T06334_PORT || 39933);
const BASE = `http://127.0.0.1:${PORT}`;
const CDP_PORT = Number(process.env.T06334_CDP_PORT || 9337);
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const AXE = process.env.AXE_PATH || 'D:/tmp/t06309-axe/node_modules/axe-core/axe.min.js';
const RUN_ID = Date.now().toString(36);

if (!existsSync(join(DIST, 'index.html'))) { console.error(`dist 不存在，请先构建：${DIST}`); process.exit(2); }
if (!existsSync(CHROME)) { console.error(`Chrome 不存在：${CHROME}`); process.exit(2); }
const hasAxe = existsSync(AXE);
const axeSource = hasAxe ? readFileSync(AXE, 'utf8') : '';

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'data'), { recursive: true });
const reportFile = join(OUT, 'report.txt');
appendFileSync(reportFile, '', 'utf8');

const checks = [];
const say = (name, okVal, extra) => {
  const item = { name, ok: Boolean(okVal), extra };
  checks.push(item);
  const line = `[${item.ok ? 'PASS' : 'FAIL'}] ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 1600)}`}`;
  console.log(line);
  appendFileSync(reportFile, `${line}\n`, 'utf8');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killTree = (pid) => {
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
    return;
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
};
const pngSize = (buf) => {
  if (buf.length < 24 || buf.subarray(1, 4).toString() !== 'PNG') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
};
const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

/* T03645 同款 ABI 探针：工作区 better-sqlite3 可能被 Electron/Node 来回翻，选能加载的那个入口 */
const sqliteAbiProbe = (bin, runAsNode) => {
  try {
    execFileSync(bin, ['-e', 'require("better-sqlite3")'], {
      cwd: ROOT, stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: runAsNode ? '1' : '' },
    });
    return true;
  } catch { return false; }
};
const usePlainNode = sqliteAbiProbe(process.execPath, false);
const ELECTRON_BIN = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const NODE_BIN = usePlainNode ? process.execPath : (existsSync(ELECTRON_BIN) ? ELECTRON_BIN : process.execPath);
const RUN_AS_NODE = usePlainNode || !existsSync(ELECTRON_BIN) ? {} : { ELECTRON_RUN_AS_NODE: '1' };

const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : null;
};

const serverEntry = process.env.T06334_SERVER || join(ROOT, 'server', 'dist', 'index.js');
const serverLog = join(OUT, 'server.log');
const server = spawn(NODE_BIN, [serverEntry], {
  cwd: ROOT,
  env: { ...process.env, ...RUN_AS_NODE, MTask_DATA_DIR: join(OUT, 'data'), MTask_BASE_URL: BASE, MTask_PORT: String(PORT), MTASK_STATIC_DIR: DIST },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => appendFileSync(serverLog, String(d), 'utf8'));
server.stderr.on('data', (d) => appendFileSync(serverLog, String(d), 'utf8'));
process.on('exit', () => killTree(server.pid));

let PROJECT_ID = '';
let TASK_ID = '';
let chrome = null;
let ws = null;
try {
  const booted = await (async () => {
    for (let i = 0; i < 320; i += 1) {
      try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch { /* 还没起 */ }
      await sleep(1500);
    }
    return false;
  })();
  say('T06334-00 隔离后端就绪（生产 :39877 未被触碰）', booted, { port: PORT, dist: DIST, log: serverLog });
  if (!booted) throw new Error('后端未启动');

  const project = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: `T06334 摘要按钮验收 ${RUN_ID}` }) });
  PROJECT_ID = project.id;
  const summaryText = '这是用于验收 AI 梳理摘要按钮的任务摘要：梳理目标、边界与可复核证据，确认图标按钮位于描述展开之前，并且仅通过悬浮提示表达功能。';
  const task = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      projectId: PROJECT_ID,
      title: 'T06334 摘要按钮布局验收任务',
      description: '该任务同时具备描述与 AI 梳理摘要，用于验证摘要图标位于描述展开按钮前方；点击摘要图标只切换摘要正文，不展开描述。',
      priority: 'high',
    }),
  });
  TASK_ID = task.id;
  await api(`/api/tasks/${TASK_ID}`, { method: 'PATCH', body: JSON.stringify({ aiSummary: summaryText }) });
  await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ projectId: PROJECT_ID, title: 'T06334 无摘要对照任务', description: '无摘要任务不显示摘要图标。', priority: 'normal' }),
  });
  say('T06334-01 隔离夹具创建（摘要任务 + 无摘要对照）', Boolean(TASK_ID) && Boolean(PROJECT_ID), { projectId: PROJECT_ID, taskId: TASK_ID, summaryLength: summaryText.length });

  chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(OUT, `profile-${RUN_ID}`)}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1280,1000', '--disable-features=Translate', 'about:blank',
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
  const shot = async (name, selector) => {
    let clip;
    if (selector) {
      const rect = await evl(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
      })()`);
      if (!rect.value) return null;
      clip = { ...rect.value, scale: 1 };
    }
    const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) });
    if (!r?.data) return null;
    const buf = Buffer.from(r.data, 'base64');
    writeFileSync(join(OUT, name), buf);
    return { bytes: buf.length, sha: sha(buf), size: pngSize(buf), clip };
  };

  await send('Page.enable');
  await send('Runtime.enable');
  if (hasAxe) await send('Page.addScriptToEvaluateOnNewDocument', { source: axeSource });
  await send('Page.navigate', { url: `${BASE}/` });
  const appReady = await until(`Boolean(document.querySelector('#root aside'))`, 30_000);
  say('T06334-02 生产构建加载成功', Boolean(appReady));

  await evl(`(() => {
    localStorage.setItem('tasks.activeProject', ${JSON.stringify(JSON.stringify(PROJECT_ID))});
    localStorage.setItem('mtask.guide.seen.tasks', '1');
    sessionStorage.setItem('tasks.viewMode', JSON.stringify('list'));
    sessionStorage.removeItem('tasks.summaryExpanded');
    window.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'tasks' } }));
    return true;
  })()`);
  const taskReady = await until(`Boolean(document.querySelector('[data-ttask-id="${TASK_ID}"]'))`, 30_000);
  const pageDebug = await evl(`(() => ({
    href: location.href,
    body: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 500),
    taskRows: document.querySelectorAll('[data-ttask-id]').length,
    allTaskItems: document.querySelectorAll('.task-item').length,
    viewToggle: Boolean(document.querySelector('[data-t06302="view-toggle"]')),
    activeProject: localStorage.getItem('tasks.activeProject'),
    viewMode: sessionStorage.getItem('tasks.viewMode'),
  }))()`);
  say('T06334-03 任务行加载', Boolean(taskReady), pageDebug.value);

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
  say('T06334-04 首次使用向导不遮挡验收', Boolean(guideGone.value), { guide: guideClose.value });

  const initial = await evl(`(() => {
    const row = document.querySelector('[data-ttask-id="${TASK_ID}"]');
    const sum = row?.querySelector('[data-t06334="summary-toggle"]');
    const desc = [...(row?.querySelectorAll('button') || [])].find((b) => (b.getAttribute('aria-label') || '').startsWith('展开：展开查看'));
    const control = [...document.querySelectorAll('li')].find((li) => !li.querySelector('[data-t06334="summary-toggle"]') && /无摘要对照/.test(li.innerText || ''));
    if (!row || !sum) return { row: Boolean(row), sum: Boolean(sum), desc: Boolean(desc) };
    const sr = sum.getBoundingClientRect();
    const dr = desc?.getBoundingClientRect();
    const order = desc ? Boolean(sum.compareDocumentPosition(desc) & Node.DOCUMENT_POSITION_FOLLOWING) : false;
    return {
      row: true, sum: true, desc: true,
      text: (sum.innerText || '').trim(),
      className: sum.className,
      variant: sum.getAttribute('data-variant'),
      size: sum.getAttribute('data-size'),
      width: Math.round(sr.width), height: Math.round(sr.height),
      ariaLabel: sum.getAttribute('aria-label'), title: sum.getAttribute('title'),
      expanded: sum.getAttribute('aria-expanded'), panel: Boolean(row.querySelector('[data-t06334="summary-panel"]')),
      order, sameRow: dr ? Math.abs(sr.top - dr.top) <= 2 : false, gap: dr ? Math.round(dr.left - sr.right) : -1,
      descSection: Boolean(row.closest('li')?.querySelector('#task-desc-${TASK_ID}')),
      controlHasSummary: Boolean(control?.querySelector('[data-t06334="summary-toggle"]')),
      transition: getComputedStyle(sum).transitionDuration + ' ' + getComputedStyle(sum).transitionProperty,
      focusable: sum.tabIndex >= 0 && sum.tagName === 'BUTTON',
    };
  })()`);
  const v = initial.value || {};
  say('T06334-05 摘要按钮为纯图标且不再包含文字标签', v.sum && v.text === '' && /mt-icon-btn/.test(v.className || ''), { text: v.text, className: v.className, size: `${v.width}x${v.height}` });
  say('T06334-06 摘要按钮复用 Design System 的 ghost/sm IconButton', v.variant === 'ghost' && v.size === 'sm' && v.width === 24 && v.height === 24, { variant: v.variant, size: v.size, box: `${v.width}x${v.height}` });
  say('T06334-07 摘要按钮位于描述「展开」之前且保持在标题行', v.order === true && v.sameRow === true && v.gap >= 0 && v.gap <= 16, { order: v.order, sameRow: v.sameRow, gap: v.gap });
  say('T06334-08 悬浮提示同时包含功能名称与简短说明', /^AI梳理摘要：/.test(v.ariaLabel || '') && v.ariaLabel === v.title && (v.title || '').length <= 30, { ariaLabel: v.ariaLabel, title: v.title, length: (v.title || '').length });
  say('T06334-09 初始为收起态且不渲染摘要正文', v.expanded === 'false' && v.panel === false && v.descSection === false, { expanded: v.expanded, panel: v.panel, descSection: v.descSection });
  say('T06334-10 无摘要任务不出现该按钮', v.controlHasSummary === false, { controlHasSummary: v.controlHasSummary });
  say('T06334-11 图标按钮具备点击过渡与可聚焦语义', /transform/.test(v.transition || '') && v.focusable === true, { transition: v.transition, focusable: v.focusable });

  const clickOpen = await evl(`(() => {
    const row = document.querySelector('[data-ttask-id="${TASK_ID}"]');
    const sum = row?.querySelector('[data-t06334="summary-toggle"]');
    if (!sum) return { ok: false };
    sum.click();
    return { ok: true };
  })()`);
  const opened = await until(`(() => {
    const row = document.querySelector('[data-ttask-id="${TASK_ID}"]');
    const container = row?.closest('li');
    const sum = row?.querySelector('[data-t06334="summary-toggle"]');
    const panel = container?.querySelector('[data-t06334="summary-panel"]');
    return sum?.getAttribute('aria-expanded') === 'true' && panel ? { text: (panel.innerText || '').trim(), descSection: Boolean(container?.querySelector('#task-desc-${TASK_ID}')) } : null;
  })()`, 5_000);
  say('T06334-12 点击图标展开摘要正文且不联动描述展开', Boolean(clickOpen.value?.ok) && Boolean(opened) && /这是用于验收 AI 梳理摘要按钮的任务摘要/.test(opened?.text || '') && opened?.descSection === false, { opened });
  const labelOpen = await evl(`(() => {
    const sum = document.querySelector('[data-ttask-id="${TASK_ID}"] [data-t06334="summary-toggle"]');
    return { label: sum?.getAttribute('aria-label'), expanded: sum?.getAttribute('aria-expanded') };
  })()`);
  say('T06334-13 展开后提示与 aria-expanded 同步为收起态', /^AI梳理摘要：收起任务摘要$/.test(labelOpen.value?.label || '') && labelOpen.value?.expanded === 'true', labelOpen.value);

  const lightShot = await shot('summary-expanded-light.png', `li:has([data-ttask-id="${TASK_ID}"])`);
  say('T06334-14 light 展开态行截图有效', Boolean(lightShot && lightShot.bytes > 10_000 && lightShot.size?.width >= 500 && lightShot.size?.height >= 80), lightShot);

  const measureLayout = `(() => {
    const row = document.querySelector('[data-ttask-id="${TASK_ID}"]');
    const sum = row?.querySelector('[data-t06334="summary-toggle"]');
    const desc = [...(row?.querySelectorAll('button') || [])].find((b) => (b.getAttribute('aria-label') || '').startsWith('展开：展开查看') || (b.getAttribute('aria-label') || '').startsWith('收起：收起任务描述'));
    const sr = sum?.getBoundingClientRect();
    const dr = desc?.getBoundingClientRect();
    return {
      sum: Boolean(sum), desc: Boolean(desc),
      order: desc ? Boolean(sum.compareDocumentPosition(desc) & Node.DOCUMENT_POSITION_FOLLOWING) : false,
      sameRow: dr ? Math.abs(sr.top - dr.top) <= 2 : false,
      gap: dr ? Math.round(dr.left - sr.right) : -1,
      inside: dr ? sr.left >= 0 && dr.right <= window.innerWidth : false,
      width: window.innerWidth,
    };
  })()`;
  const responsiveRows = [];
  for (const width of [1440, 1024]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await sleep(450);
    const measured = await evl(measureLayout);
    responsiveRows.push(measured.value);
  }
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(300);
  say('T06334-15 1440/1024 宽度下摘要图标仍位于展开前且不重叠', responsiveRows.length === 2 && responsiveRows.every((r) => r?.sum && r?.desc && r.order && r.sameRow && r.gap >= 0 && r.gap <= 16 && r.inside), responsiveRows);

  await evl(`document.documentElement.setAttribute('data-theme', 'dark'); true`);
  await sleep(350);
  const darkShot = await shot('summary-expanded-dark.png', `li:has([data-ttask-id="${TASK_ID}"])`);
  say('T06334-16 dark 展开态行截图有效', Boolean(darkShot && darkShot.bytes > 10_000 && darkShot.size?.width >= 500 && darkShot.size?.height >= 80), darkShot);
  await evl(`document.documentElement.setAttribute('data-theme', 'light'); true`);
  await sleep(300);

  let contrast = null;
  if (hasAxe) {
    contrast = await evl(`(async () => {
      const row = document.querySelector('[data-ttask-id="${TASK_ID}"]');
      const res = await axe.run(row || document, { runOnly: { type: 'rule', values: ['color-contrast'] } });
      return { count: res.violations.length, nodes: res.violations.reduce((n, v) => n + v.nodes.length, 0), first: res.violations[0]?.nodes?.[0]?.target };
    })()`);
  }
  say('T06334-17 摘要按钮与展开行 color-contrast 门禁', Boolean(hasAxe) && contrast?.value?.count === 0, contrast?.value ?? 'axe 缺失');

  const clickClose = await evl(`(() => {
    const row = document.querySelector('[data-ttask-id="${TASK_ID}"]');
    const sum = row?.querySelector('[data-t06334="summary-toggle"]');
    if (!sum) return { ok: false };
    sum.click();
    return { ok: true };
  })()`);
  const closed = await until(`(() => {
    const row = document.querySelector('[data-ttask-id="${TASK_ID}"]');
    const sum = row?.querySelector('[data-t06334="summary-toggle"]');
    return sum?.getAttribute('aria-expanded') === 'false' && !row.querySelector('[data-t06334="summary-panel"]') ? { label: sum.getAttribute('aria-label') } : null;
  })()`, 3_000);
  say('T06334-18 再次点击可收起摘要并移除正文', Boolean(clickClose.value?.ok) && Boolean(closed) && /^AI梳理摘要：展开查看任务摘要$/.test(closed?.label || ''), closed);

  const finalDb = await api(`/api/tasks?projectId=${encodeURIComponent(PROJECT_ID)}`);
  const finalTask = (finalDb || []).find((t) => t.id === TASK_ID);
  say('T06334-19 纯前端交互不改任务数据', finalTask?.ai_summary?.includes('这是用于验收 AI 梳理摘要按钮的任务摘要') && finalTask?.description?.includes('该任务同时具备描述与 AI 梳理摘要'), { aiSummaryLength: (finalTask?.ai_summary || '').length, description: finalTask?.description });

  say('T06334-20 页面无运行时异常', runtimeErrors.length === 0, runtimeErrors.slice(-3));
} catch (e) {
  say('T06334-FATAL 测试异常', false, String(e?.stack || e).slice(0, 1200));
} finally {
  try { if (ws) ws.close(); } catch { /* 忽略 */ }
  try { if (chrome) killTree(chrome.pid); } catch { /* 忽略 */ }
  try { killTree(server.pid); } catch { /* 忽略 */ }
  const summary = { generatedAt: new Date().toISOString(), project: PROJECT_ID, task: TASK_ID, pass: checks.filter((x) => x.ok).length, fail: checks.filter((x) => !x.ok).length, checks };
  writeFileSync(join(OUT, 'result.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\n[t06334-summary] pass=${summary.pass} fail=${summary.fail} out=${OUT}`);
  process.exit(summary.fail ? 1 : 0);
}
