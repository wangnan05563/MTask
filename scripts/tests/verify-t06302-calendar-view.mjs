/**
 * T06302 日历视图验收 —— 月/周切换 / 拖拽改期 / 未排期分组 / 无甘特 / 持久化 / 截图证据。
 *
 * 隔离运行：临时后端（默认 39932）+ 临时数据目录 + 全新项目/任务；生产 :39877 全程不触碰。
 * 用法：node scripts/tests/verify-t06302-calendar-view.mjs
 * 前置：npm run build:web（默认读取 web/dist）。
 * 产出默认：D:/tmp/t06302-calendar
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = join(import.meta.dirname, '..', '..');
const OUT = process.env.T06302_OUT || 'D:/tmp/t06302-calendar';
const DIST = process.env.T06302_DIST || join(ROOT, 'web', 'dist');
const PORT = Number(process.env.T06302_PORT || 39932);
const BASE = `http://127.0.0.1:${PORT}`;
const CDP_PORT = Number(process.env.T06302_CDP_PORT || 9336);
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
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ } };
const pngSize = (buf) => {
  if (buf.length < 24 || buf.subarray(1, 4).toString() !== 'PNG') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
};
const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDaysStr = (s, n) => {
  const d = new Date(`${s}T00:00:00`);
  d.setDate(d.getDate() + n);
  return ymd(d);
};

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
const listTasks = () => api(`/api/tasks?projectId=${encodeURIComponent(PROJECT_ID)}`);
const taskById = async (id) => (await listTasks()).find((t) => t.id === id) ?? null;
const waitDue = async (id, expected, ms = 5_000) => {
  let last = null;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    last = await taskById(id);
    if ((last?.due_date ?? null) === expected) return last;
    await sleep(200);
  }
  return last;
};

const serverEntry = join(ROOT, 'server', 'dist', 'index.js');
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
  say('T06302-00 隔离后端就绪（生产 :39877 未被触碰）', booted, { port: PORT, dist: DIST, log: serverLog });
  if (!booted) throw new Error('后端未启动');

  // 夹具：一个全新项目 + 4 个任务（1 个已完成），不写生产库
  const project = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: `T06302 日历验收 ${RUN_ID}` }) });
  PROJECT_ID = project.id;
  const seed = [
    { title: 'T06302 日历排期 Alpha（紧急）', priority: 'urgent' },
    { title: 'T06302 日历排期 Beta（高）', priority: 'high' },
    { title: 'T06302 日历排期 Gamma（普通）', priority: 'normal' },
    { title: 'T06302 日历排期 Delta（已完成）', priority: 'low' },
  ];
  const created = [];
  for (const item of seed) created.push(await api('/api/tasks', { method: 'POST', body: JSON.stringify({ projectId: PROJECT_ID, ...item }) }));
  await api(`/api/tasks/${created[3].id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
  say('T06302-01 隔离夹具创建（项目 1 + 任务 4）', created.length === 4 && created.every((t) => t.due_date === null), { projectId: PROJECT_ID, tasks: created.map((t) => ({ id: t.id, no: t.task_no, due: t.due_date })) });

  const badDate = await fetch(`${BASE}/api/tasks/${created[0].id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dueDate: '2026-02-30' }),
  });
  const badBody = await badDate.json().catch(() => ({}));
  say('T06302-02 非法改期日期在 API 边界拒收（400）', badDate.status === 400 && /不存在/.test(String(badBody.error)), { status: badDate.status, body: badBody });

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
  const clickByLabel = async (label) => evl(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').trim() === ${JSON.stringify(label)});
    if (!btn) return false;
    btn.click();
    return true;
  })()`);

  await send('Page.enable');
  await send('Runtime.enable');
  if (hasAxe) await send('Page.addScriptToEvaluateOnNewDocument', { source: axeSource });
  await send('Page.navigate', { url: `${BASE}/` });
  const appReady = await until(`Boolean(document.querySelector('#root aside'))`, 30_000);
  say('T06302-03 生产构建加载成功', Boolean(appReady));

  await evl(`(() => {
    localStorage.setItem('tasks.activeProject', ${JSON.stringify(JSON.stringify(PROJECT_ID))});
    localStorage.setItem('mtask.guide.seen.tasks', '1');
    sessionStorage.setItem('tasks.viewMode', JSON.stringify('list'));
    sessionStorage.removeItem('tasks.calendarMode');
    sessionStorage.removeItem('tasks.calendarAnchor');
    window.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'tasks' } }));
    return true;
  })()`);
  const tasksReady = await until(`Boolean(document.querySelector('[data-t06302="view-toggle"]'))`, 30_000);
  say('T06302-04 任务页视图切换入口加载', Boolean(tasksReady));
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
  say('T06302-04b 首次使用向导不遮挡验收', Boolean(guideGone.value), { guide: guideClose.value });
  const toggleInfo = await evl(`(() => {
    const box = document.querySelector('[data-t06302="view-toggle"]');
    const buttons = [...(box?.querySelectorAll('button') || [])];
    return {
      count: buttons.length,
      labels: buttons.map((b) => b.getAttribute('aria-label')),
      visible: Boolean(box && box.getBoundingClientRect().width && box.getBoundingClientRect().height && getComputedStyle(box).visibility !== 'hidden'),
    };
  })()`);
  say('T06302-05 视图切换常驻且含日历入口', toggleInfo.value?.count >= 4 && toggleInfo.value?.visible && ['列表视图', '看板视图', '表格视图', '日历视图'].every((x) => (toggleInfo.value?.labels || []).includes(x)), toggleInfo.value);

  const switched = await clickByLabel('日历视图');
  const calendarReady = await until(`Boolean(document.querySelector('[data-t06302="calendar"]'))`, 20_000);
  const gridReady = await until(`(() => {
    const cal = document.querySelector('[data-t06302="calendar"]');
    return Boolean(cal && cal.querySelectorAll('[data-t06302="day-cell"]').length === 42 && cal.querySelectorAll('[data-t06302="task-card"]').length >= 3);
  })()`, 20_000);
  say('T06302-06 日历视图渲染', Boolean(switched.value) && Boolean(calendarReady) && Boolean(gridReady));

  const monthInfo = await evl(`(() => {
    const cal = document.querySelector('[data-t06302="calendar"]');
    const cells = [...(cal?.querySelectorAll('[data-t06302="day-cell"]') || [])];
    const cards = [...(cal?.querySelectorAll('[data-t06302="task-card"]') || [])];
    const scheduledCards = cells.reduce((n, c) => n + c.querySelectorAll('[data-t06302="task-card"]').length, 0);
    return {
      mode: cal?.querySelector('[data-t06302="grid"]')?.getAttribute('data-mode'),
      weekdayCount: cal?.querySelectorAll('[data-t06302="weekday"]').length,
      cellCount: cells.length,
      unscheduledCount: cal?.querySelector('[data-t06302="unscheduled-count"]')?.innerText,
      totalCards: cards.length,
      scheduledCards,
      unscheduledCards: cal?.querySelector('[data-t06302="unscheduled"]')?.querySelectorAll('[data-t06302="task-card"]').length,
      range: cal?.querySelector('[data-t06302="range-label"]')?.innerText,
      monthPressed: cal?.querySelector('[data-t06302="mode-month"]')?.getAttribute('aria-pressed'),
    };
  })()`);
  const today = ymd(new Date());
  const expectedMonth = `${new Date().getFullYear()}年${new Date().getMonth() + 1}月`;
  say('T06302-07 月视图为 7×6 网格、默认月并被选中', monthInfo.value?.mode === 'month' && monthInfo.value?.weekdayCount === 7 && monthInfo.value?.cellCount === 42 && monthInfo.value?.monthPressed === 'true' && monthInfo.value?.range === expectedMonth, monthInfo.value);

  say('T06302-08 未排期任务单独分组（待办页签 3 项全部未排期）', monthInfo.value?.unscheduledCards === 3 && monthInfo.value?.scheduledCards === 0 && /3/.test(monthInfo.value?.unscheduledCount || ''), { unscheduledCards: monthInfo.value?.unscheduledCards, scheduledCards: monthInfo.value?.scheduledCards, label: monthInfo.value?.unscheduledCount });

  const noGantt = await evl(`(() => {
    const cal = document.querySelector('[data-t06302="calendar"]');
    const text = cal?.innerText || '';
    return { hasGanttText: /甘特/.test(text), ganttNodes: cal?.querySelectorAll('[class*="gantt"], [data-testid*="gantt"]').length || 0 };
  })()`);
  say('T06302-09 日历视图不出现甘特图', noGantt.value?.hasGanttText === false && noGantt.value?.ganttNodes === 0, noGantt.value);

  // 拖拽：未排期 → 今天
  const firstId = created[0].id;
  const drag1 = await evl(`(() => {
    const cal = document.querySelector('[data-t06302="calendar"]');
    const src = [...cal.querySelectorAll('[data-t06302="task-card"]')].find((b) => b.dataset.taskId === ${JSON.stringify(firstId)});
    const dst = cal.querySelector('[data-t06302="day-cell"][data-date="${today}"]');
    if (!src || !dst) return { ok: false, src: Boolean(src), dst: Boolean(dst) };
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return { ok: true, target: dst.getAttribute('data-date'), sourceTitle: (src.innerText || '').replace(/\s+/g, ' ').slice(0, 80) };
  })()`);
  await sleep(500);
  const afterDrag1 = await until(`(() => {
    const cal = document.querySelector('[data-t06302="calendar"]');
    const day = cal?.querySelector('[data-t06302="day-cell"][data-date="${today}"]');
    return {
      inDay: day?.querySelectorAll('[data-t06302="task-card"]').length || 0,
      unscheduled: cal?.querySelector('[data-t06302="unscheduled-count"]')?.innerText || '',
    };
  })()`, 5_000);
  const db1 = await waitDue(firstId, today);
  say('T06302-10 拖拽未排期任务到日期格并落库', Boolean(drag1.value?.ok) && (afterDrag1?.inDay || 0) === 1 && db1?.due_date === today, { drag: drag1.value, ui: afterDrag1, due: db1?.due_date });

  // 拖拽：今天 → 后天（跨日期格）
  const nextDate = addDaysStr(today, 2);
  const drag2 = await evl(`(() => {
    const cal = document.querySelector('[data-t06302="calendar"]');
    const src = [...cal.querySelectorAll('[data-t06302="task-card"]')].find((b) => b.dataset.taskId === ${JSON.stringify(firstId)});
    const dst = cal.querySelector('[data-t06302="day-cell"][data-date="${nextDate}"]');
    if (!src || !dst) return { ok: false, src: Boolean(src), dst: Boolean(dst) };
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return { ok: true, target: dst.getAttribute('data-date') };
  })()`);
  await sleep(500);
  const db2 = await waitDue(firstId, nextDate);
  const ui2 = await evl(`(() => {
    const cal = document.querySelector('[data-t06302="calendar"]');
    const day = cal?.querySelector('[data-t06302="day-cell"][data-date="${nextDate}"]');
    const old = cal?.querySelector('[data-t06302="day-cell"][data-date="${today}"]');
    return { inTarget: day?.querySelectorAll('[data-t06302="task-card"]').length || 0, inOld: old?.querySelectorAll('[data-t06302="task-card"]').length || 0 };
  })()`);
  say('T06302-11 日历格之间拖拽改期且旧格清空', Boolean(drag2.value?.ok) && db2?.due_date === nextDate && (ui2.value?.inTarget || 0) === 1 && (ui2.value?.inOld || 0) === 0, { drag: drag2.value, due: db2?.due_date, ui: ui2.value });

  // 键盘改期：Alt+→ 再挪一天
  const keyboardTarget = addDaysStr(nextDate, 1);
  const keyMove = await evl(`(() => {
    const card = [...document.querySelectorAll('[data-t06302="task-card"]')].find((b) => b.dataset.taskId === ${JSON.stringify(firstId)});
    if (!card) return false;
    card.focus();
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(500);
  const db3 = await waitDue(firstId, keyboardTarget);
  say('T06302-12 键盘 Alt+→ 可改期（+1 天）', Boolean(keyMove.value) && db3?.due_date === keyboardTarget, { due: db3?.due_date, expected: keyboardTarget });

  // 周视图
  const weekClick = await clickByLabel('周视图');
  await sleep(350);
  const weekInfo = await evl(`(() => {
    const cal = document.querySelector('[data-t06302="calendar"]');
    const cells = [...(cal?.querySelectorAll('[data-t06302="day-cell"]') || [])];
    return {
      mode: cal?.querySelector('[data-t06302="grid"]')?.getAttribute('data-mode'),
      weekPressed: cal?.querySelector('[data-t06302="mode-week"]')?.getAttribute('aria-pressed'),
      cells: cells.length,
      weekdayCount: cal?.querySelectorAll('[data-t06302="weekday"]').length,
      range: cal?.querySelector('[data-t06302="range-label"]')?.innerText,
      first: cells[0]?.getAttribute('data-date'),
      last: cells[6]?.getAttribute('data-date'),
      cards: cal?.querySelectorAll('[data-t06302="day-cell"] [data-t06302="task-card"]').length,
    };
  })()`);
  say('T06302-13 周视图切换为 7 列且范围连续', Boolean(weekClick.value) && weekInfo.value?.mode === 'week' && weekInfo.value?.weekPressed === 'true' && weekInfo.value?.cells === 7 && weekInfo.value?.weekdayCount === 7 && /～/.test(weekInfo.value?.range || '') && weekInfo.value?.last === addDaysStr(weekInfo.value?.first || today, 6), weekInfo.value);
  const weekShot = await shot('calendar-week-light.png', '[data-t06302="calendar"]');
  say('T06302-14 light 周视图截图有效', Boolean(weekShot && weekShot.bytes > 20_000 && weekShot.size?.width >= 800), weekShot);

  // 回到月视图
  await clickByLabel('月视图');
  await sleep(350);
  const monthBack = await evl(`Boolean(document.querySelector('[data-t06302="grid"][data-mode="month"]'))`);
  say('T06302-15 可返回月视图', Boolean(monthBack.value));

  // 月视图 light 截图（含已排期卡片）
  const lightShot = await shot('calendar-month-light.png', '[data-t06302="calendar"]');
  say('T06302-16 light 月视图截图有效', Boolean(lightShot && lightShot.bytes > 20_000 && lightShot.size?.width >= 800), lightShot);

  // 拖回未排期
  const dragBack = await evl(`(() => {
    const cal = document.querySelector('[data-t06302="calendar"]');
    const src = [...cal.querySelectorAll('[data-t06302="task-card"]')].find((b) => b.dataset.taskId === ${JSON.stringify(firstId)});
    const dst = cal.querySelector('[data-t06302="unscheduled"]');
    if (!src || !dst) return { ok: false, src: Boolean(src), dst: Boolean(dst) };
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return { ok: true };
  })()`);
  await sleep(500);
  const db4 = await waitDue(firstId, null);
  const unschedInfo = await evl(`(() => {
    const cal = document.querySelector('[data-t06302="calendar"]');
    return { count: cal?.querySelector('[data-t06302="unscheduled-count"]')?.innerText, cards: cal?.querySelectorAll('[data-t06302="unscheduled"] [data-t06302="task-card"]').length || 0 };
  })()`);
  say('T06302-17 拖回未排期即清空排期', Boolean(dragBack.value?.ok) && db4?.due_date === null && (unschedInfo.value?.cards || 0) === 3, { due: db4?.due_date, ui: unschedInfo.value });

  // 再排一次，刷新验证持久化
  const persistTarget = today;
  await evl(`(() => {
    const cal = document.querySelector('[data-t06302="calendar"]');
    const src = [...cal.querySelectorAll('[data-t06302="task-card"]')].find((b) => b.dataset.taskId === ${JSON.stringify(firstId)});
    const dst = cal.querySelector('[data-t06302="day-cell"][data-date="${persistTarget}"]');
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return true;
  })()`);
  await sleep(600);
  const beforeReload = await waitDue(firstId, persistTarget);
  await send('Page.reload', { ignoreCache: false });
  await until(`Boolean(document.querySelector('#root aside'))`, 30_000);
  await evl(`window.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'tasks' } })); true`);
  const calendarAfterReload = await until(`(() => {
    const cal = document.querySelector('[data-t06302="calendar"]');
    const day = cal?.querySelector('[data-t06302="day-cell"][data-date="${persistTarget}"]');
    return Boolean(day && day.querySelectorAll('[data-t06302="task-card"]').length >= 1);
  })()`, 30_000);
  const reloadInfo = await evl(`(() => {
    const cal = document.querySelector('[data-t06302="calendar"]');
    return {
      mode: cal?.querySelector('[data-t06302="grid"]')?.getAttribute('data-mode'),
      session: sessionStorage.getItem('tasks.viewMode'),
      inDay: cal?.querySelector('[data-t06302="day-cell"][data-date="${persistTarget}"]')?.querySelectorAll('[data-t06302="task-card"]').length || 0,
      unscheduled: cal?.querySelector('[data-t06302="unscheduled-count"]')?.innerText || '',
    };
  })()`);
  say('T06302-18 刷新后视图保持且改期结果持久', Boolean(calendarAfterReload) && JSON.stringify(reloadInfo.value?.session || '').includes('calendar') && reloadInfo.value?.inDay === 1 && beforeReload?.due_date === persistTarget && /2/.test(reloadInfo.value?.unscheduled || ''), { reload: reloadInfo.value, due: beforeReload?.due_date });

  // 已完成页签复用日历
  const doneClick = await evl(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /^已完成/.test((b.innerText || '').trim()));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await sleep(500);
  const doneCalendar = await evl(`(() => {
    const cal = document.querySelector('[data-t06302="calendar"]');
    const doneCard = [...(cal?.querySelectorAll('[data-t06302="task-card"]') || [])].find((b) => b.dataset.done === 'true');
    return { exists: Boolean(cal), cards: cal?.querySelectorAll('[data-t06302="task-card"]').length || 0, hasDone: Boolean(doneCard) };
  })()`);
  say('T06302-19 已完成页签同样提供日历视图', Boolean(doneClick.value) && Boolean(doneCalendar.value?.exists) && (doneCalendar.value?.cards || 0) > 0 && Boolean(doneCalendar.value?.hasDone), doneCalendar.value);
  const todoClick = await evl(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /^待办/.test((b.innerText || '').trim()));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await sleep(450);
  say('T06302-20 待办页签可返回', Boolean(todoClick.value));

  await evl(`document.documentElement.setAttribute('data-theme', 'dark'); true`);
  await sleep(350);
  const darkShot = await shot('calendar-month-dark.png', '[data-t06302="calendar"]');
  say('T06302-21 dark 月视图截图有效', Boolean(darkShot && darkShot.bytes > 20_000 && darkShot.size?.width >= 800), darkShot);
  await evl(`document.documentElement.setAttribute('data-theme', 'light'); true`);
  await sleep(300);

  let contrast = null;
  if (hasAxe) {
    contrast = await evl(`(async () => {
      const res = await axe.run(document, { runOnly: { type: 'rule', values: ['color-contrast'] } });
      return { count: res.violations.length, nodes: res.violations.reduce((n, v) => n + v.nodes.length, 0), first: res.violations[0]?.nodes?.[0]?.target };
    })()`);
  }
  say('T06302-22 日历视图 color-contrast 门禁', Boolean(hasAxe) && contrast?.value?.count === 0, contrast?.value ?? 'axe 缺失');

  const finalDb = await waitDue(firstId, persistTarget);
  say('T06302-23 改期只写 due_date，不影响状态/标题', finalDb?.due_date === persistTarget && finalDb?.status === 'todo' && /Alpha/.test(finalDb?.title || ''), { due: finalDb?.due_date, status: finalDb?.status, title: finalDb?.title });

  say('T06302-24 页面无运行时异常', runtimeErrors.length === 0, runtimeErrors.slice(-3));
} catch (e) {
  say('T06302-FATAL 测试异常', false, String(e?.stack || e).slice(0, 1200));
} finally {
  try { if (ws) ws.close(); } catch { /* 忽略 */ }
  try { if (chrome) killTree(chrome.pid); } catch { /* 忽略 */ }
  try { killTree(server.pid); } catch { /* 忽略 */ }
  const summary = { generatedAt: new Date().toISOString(), project: PROJECT_ID, pass: checks.filter((x) => x.ok).length, fail: checks.filter((x) => !x.ok).length, checks };
  writeFileSync(join(OUT, 'result.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\n[t06302-calendar] pass=${summary.pass} fail=${summary.fail} out=${OUT}`);
  process.exit(summary.fail ? 1 : 0);
}
