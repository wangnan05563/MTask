/**
 * T06325 UI 实测：通道主标签不再暴露 B0/A/D。
 *
 * 隔离后端（临时 DATA_DIR、独立端口、生产 web/dist）+ Chrome CDP：
 * - 任务详情派发菜单：CodeBuddy 网关 / MCP 就绪池 / 人工确认，且无代号主标签；
 * - 设置 → 派发策略：状态卡与口径说明使用同一套可读名称；
 * - 队列 → 派发记录：入口说明不再出现 B0/A；
 * - 执行会话页：说明使用 CodeBuddy 网关，不再出现 B0 派发。
 *
 * 用法：node scripts/tests/verify-t06325-ui.mjs [--port 39886] [--out D:/tmp/mtask-t06325/ui]
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(arg('--port', '39886'));
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = arg('--out', 'D:/tmp/mtask-t06325/ui');
const DATA = join(OUT, 'data');
const CHROME = arg('--chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const checks = [];
const save = () => writeFileSync(join(OUT, 'cdp-t06325.json'), JSON.stringify({ pass: checks.filter((x) => x.ok).length, fail: checks.filter((x) => !x.ok).length, checks }, null, 2), 'utf8');
const say = (name, okVal, extra) => {
  const item = { name, ok: Boolean(okVal), extra };
  checks.push(item);
  console.log(`[${item.ok ? 'PASS' : 'FAIL'}] ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 900)}`}`);
};
const BANNED = /（B0）|（A）|（D）|B0\s*=\s*CodeBuddy|Agent 就绪池|人工处理（|B0 派发/;
const clean = (text) => {
  const hit = String(text ?? '').match(BANNED)?.[0] ?? '';
  return { ok: !hit, hit };
};

if (!existsSync(join(ROOT, 'web', 'dist', 'index.html'))) { console.error('web/dist/index.html 缺失'); process.exit(2); }
if (!existsSync(CHROME)) { console.error(`Chrome 不存在：${CHROME}`); process.exit(2); }
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const log = (s) => appendFileSync(join(OUT, 'ui-run.log'), `${s}\n`, 'utf8');
log(`T06325 UI start ${new Date().toISOString()}`);

let server = null;
let chrome = null;
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** better-sqlite3 的 ABI 可能与当前 node 不一致；沿用 T03705 的 electron-as-node 兜底 */
function pickLauncher() {
  for (const c of [
    { exec: process.execPath, env: {}, label: 'node' },
    { exec: join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), env: { ELECTRON_RUN_AS_NODE: '1' }, label: 'electron-as-node' },
  ]) {
    try {
      execFileSync(c.exec, ['-e', "new (require('better-sqlite3'))(':memory:').close();"], { cwd: ROOT, env: { ...process.env, ...c.env }, stdio: 'pipe', timeout: 30_000 });
      return c;
    } catch { /* 换下一个 */ }
  }
  throw new Error('没有可用的启动器（原生模块加载全失败）');
}

try {
  const launcher = pickLauncher();
  log(`launcher=${launcher.label}`);
  server = spawn(launcher.exec, [TSX, join(ROOT, 'server', 'src', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, ...launcher.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA, MTASK_STATIC_DIR: join(ROOT, 'web', 'dist') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => appendFileSync(join(OUT, 'server.log'), String(d), 'utf8'));
  server.stderr.on('data', (d) => appendFileSync(join(OUT, 'server.log'), String(d), 'utf8'));

  let booted = false;
  for (let i = 0; i < 300 && !booted; i += 1) {
    try { booted = (await fetch(`${BASE}/api/health`)).ok; } catch { /* 启动中 */ }
    if (!booted) await sleep(1500);
  }
  say('UI-00 隔离后端就绪（不触碰生产 39877）', booted, { port: PORT, data: DATA });
  if (!booted) throw new Error('隔离后端未启动');

  const japi = async (path, init = {}) => {
    const r = await fetch(`${BASE}${path}`, { headers: { 'Content-Type': 'application/json' }, ...init });
    const text = await r.text();
    if (!r.ok) throw new Error(`${path} → ${r.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
  const project = await japi('/api/projects', { method: 'POST', body: JSON.stringify({ name: `T06325 通道命名 ${Date.now() % 100000}`, description: 'UI 实测' }) });
  const task = await japi('/api/tasks', { method: 'POST', body: JSON.stringify({ projectId: project.id, title: '派发通道命名 UI 验证任务' }) });
  const taskNo = task.task_no ?? '';
  say('UI-01 隔离项目与待办任务已创建', Boolean(project.id && task.id && taskNo), { projectId: project.id, taskNo });

  chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(OUT, 'profile')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1500,1200', '--disable-features=Translate', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const cdpPort = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome 30s 内未报出调试端口')), 30_000);
    const on = (d) => { buf += String(d); const m = /ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser/.exec(buf); if (m) { clearTimeout(timer); resolve(Number(m[1])); } };
    chrome.stderr.on('data', on); chrome.stdout.on('data', on);
    chrome.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome 提前退出 code=${code} ${buf.slice(-300)}`)); });
  });

  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const target = targets.find((x) => x.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP 连接失败')); });
  let seq = 0;
  const waits = new Map();
  const jsErrors = [];
  ws.onmessage = (message) => {
    const msg = JSON.parse(String(message.data));
    if (msg.method === 'Runtime.exceptionThrown') jsErrors.push(String(msg.params?.exceptionDetails?.exception?.description ?? '').slice(0, 240));
    if (msg.id !== undefined && waits.has(msg.id)) { waits.get(msg.id)(msg); waits.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; waits.set(id, (msg) => resolve(msg.error ? { __err: msg.error.message } : msg.result)); ws.send(JSON.stringify({ id, method, params })); });
  const evl = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.__err) return { __err: r.__err };
    if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 300) };
    return { value: r.result?.value };
  };
  const clickSel = async (sel) => {
    const rect = await evl(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
    if (!rect.value || rect.value.w < 1 || rect.value.h < 1) return false;
    const { x, y } = rect.value;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return true;
  };
  /** 标题按钮双击空白处：x 取 78%，避开文字选区（选区非空时抽屉不会打开） */
  const doubleClickTitle = async (sel) => {
    const rect = await evl(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return { x: r.left + r.width * 0.78, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
    if (!rect.value || rect.value.w < 1 || rect.value.h < 1) return false;
    const { x, y } = rect.value;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 2 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 2 });
    return true;
  };
  const clickFind = async (jsLocator) => {
    const rect = await evl(`(() => { const el = ${jsLocator}; if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
    if (!rect.value || rect.value.w < 1 || rect.value.h < 1) return false;
    const { x, y } = rect.value;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return true;
  };
  const pressEsc = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  };
  const until = async (expression, ms = 20_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const r = await evl(expression); if (r.value) return r.value; await sleep(250); }
    return null;
  };
  const text = async (sel) => (await evl(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? el.innerText : ''; })()`)).value ?? '';
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r?.data) writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'));
  };
  const dismissWizard = async () => {
    for (let i = 0; i < 3; i += 1) {
      if (!(await evl(`Boolean(document.querySelector('dialog[open]'))`)).value) return true;
      await pressEsc(); await sleep(300);
      await clickFind(`(() => [...document.querySelectorAll('button')].find((b) => /跳过|知道了/.test(b.innerText)))()`);
      await sleep(200);
    }
    return !(await evl(`Boolean(document.querySelector('dialog[open]'))`)).value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: `${BASE}/` });
  await sleep(900);
  // 任务页的项目选择来自 localStorage（深链只负责切页，不负责选项目）；先写持久化键再进页面
  await evl(`(() => {
    localStorage.setItem('tasks.activeProject', JSON.stringify(${JSON.stringify(project.id)}));
    localStorage.setItem('settings.tab', JSON.stringify('dispatch'));
    for (const k of ['tasks','aitools','prompts','req','plan','report','queue','exec-sessions','settings']) localStorage.setItem('mtask.guide.seen.' + k, '1');
    return true;
  })()`);
  await send('Page.navigate', { url: `${BASE}/#/project/${project.id}/tasks` });
  await sleep(1500);
  await dismissWizard();
  const ready = await until(`document.body.innerText.includes(${JSON.stringify(taskNo)})`, 25_000);
  let switched = false;
  if (!ready) {
    // 兜底：通过「切换项目」下拉显式选到本隔离项目（避免首页默认落 sys-inbox）
    await clickFind(`(() => document.querySelector('[aria-label="切换项目"]'))()`);
    await sleep(400);
    switched = await clickFind(`(() => [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === ${JSON.stringify(`切换到项目 ${project.name}`)}))()`);
    await sleep(600);
  }
  const taskVisible = ready || Boolean(await until(`document.body.innerText.includes(${JSON.stringify(taskNo)})`, 15_000));
  say('UI-02 任务页可通过深链定位隔离任务', taskVisible, { taskNo, switched });
  await shot('01-task-list-1500.png');

  // 任务详情派发菜单：行内「更多操作」→「查看详细信息」打开抽屉（标题双击会进编辑态，不用它）
  // 行尾工具条仅在悬浮时完全显现，坐标点击在 headless 下不稳；用原生 click 触发 React onClick 保证可重复
  const moreOpened = (await evl(`(() => { const b = document.querySelector('[data-t05712="more-trigger"]'); if (!b) return false; b.click(); return true; })()`)).value === true;
  await until(`Boolean(document.querySelector('[data-t05712="more-menu"]'))`, 5_000);
  const detailClicked = moreOpened && (await evl(`(() => { const b = document.querySelector('[data-t05712="item-detail"]'); if (!b) return false; b.click(); return true; })()`)).value === true;
  const drawerOpen = detailClicked && Boolean(await until(`(() => { const d = document.querySelector('dialog[aria-modal="true"]'); if (!d) return false; const r = d.getBoundingClientRect(); return r.width > 200 && r.left < innerWidth - 100; })()`, 8_000));
  say('UI-03 更多操作可打开任务详情抽屉', drawerOpen);
  await sleep(400);
  await shot('02a-drawer-open.png');
  // 注意：不能在这里调用 dismissWizard —— 抽屉本身是原生 <dialog open>，Escape 会把它关掉
  // 抽屉内按钮可能被自身滚动容器/遮罩拦截坐标，改用原生 click() 触发 React onClick；仍验证实际面板渲染
  const dispatchOpened = (await evl(`(() => { const el = document.querySelector('[aria-label="派发任务"]'); if (!el) return false; el.click(); return true; })()`)).value === true;
  await sleep(300);
  await shot('02b-after-dispatch-click.png');
  const panelReady = dispatchOpened && Boolean(await until(`Boolean(document.querySelector('[role="dialog"][aria-label="任务派发"]'))`, 12_000));
  say('UI-04 派发菜单可展开', panelReady);
  const menuText = await text('[role="dialog"][aria-label="任务派发"]');
  say('UI-05 派发菜单含三通道主名', ['CodeBuddy 网关', 'MCP 就绪池', '人工确认'].every((n) => menuText.includes(n)), menuText.slice(0, 500));
  const menuClean = clean(menuText);
  say('UI-06 派发菜单无代号主标签', menuClean.ok, menuClean.hit);
  say('UI-07 派发菜单说明可读', menuText.includes('自动派发') || menuText.includes('CodeBuddy 网关失败'), menuText.slice(0, 500));
  await shot('02-dispatch-menu-1500.png');
  await pressEsc(); await sleep(300);

  // 设置 → 派发策略
  await clickFind(`(() => [...document.querySelectorAll('nav button')].find((b) => (b.getAttribute('aria-label') || b.innerText || '').trim() === '设置'))()`);
  await sleep(600);
  await dismissWizard();
  const settingsClicked = await clickFind(`(() => document.querySelector('[data-tab="dispatch"]') ?? [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === '派发策略'))()`);
  const policyReady = settingsClicked && Boolean(await until(`Boolean(document.querySelector('[data-dispatch-policy="1"]'))`, 15_000));
  say('UI-08 设置页可切到派发策略', policyReady);
  const policyText = await text('[data-dispatch-policy="1"]');
  say('UI-09 派发策略状态卡含三通道主名', ['CodeBuddy 网关', 'MCP 就绪池', '人工确认'].every((n) => policyText.includes(n)), policyText.slice(0, 700));
  const policyClean = clean(policyText);
  say('UI-10 派发策略页无代号主标签', policyClean.ok, policyClean.hit);
  say('UI-11 口径说明不再显示 B0/A/D 赋值', !/B0\s*=\s*CodeBuddy/.test(policyText), policyText.slice(0, 700));
  await shot('03-policy-1500.png');

  // 队列 → 派发记录
  await clickFind(`(() => [...document.querySelectorAll('nav button')].find((b) => (b.getAttribute('aria-label') || b.innerText || '').trim() === '队列'))()`);
  await sleep(600);
  await dismissWizard();
  const queueClicked = await clickFind(`(() => [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').startsWith('派发记录')))()`);
  await sleep(500);
  const queueText = (await evl(`document.body.innerText`)).value ?? '';
  say('UI-12 队列派发记录入口可进入', queueClicked && queueText.includes('派发记录'), queueText.slice(0, 500));
  say('UI-13 派发记录说明不含 B0/A 代号', !/B0\/A 派发|B0\/A/.test(queueText), queueText.match(/B0\/A[^\n]*/)?.[0] ?? '');
  await shot('04-dispatch-records-1500.png');

  // 执行会话说明
  await clickFind(`(() => [...document.querySelectorAll('nav button')].find((b) => (b.getAttribute('aria-label') || b.innerText || '').trim() === '执行会话'))()`);
  await sleep(600);
  await dismissWizard();
  const execText = (await evl(`document.body.innerText`)).value ?? '';
  say('UI-14 执行会话页说明使用 CodeBuddy 网关', execText.includes('CodeBuddy 网关派发不在这里显示'), execText.slice(0, 500));
  say('UI-15 执行会话页无 B0 派发旧文案', !execText.includes('B0 派发'), execText.match(/B0 派发[^\n]*/)?.[0] ?? '');
  await shot('05-exec-sessions-1500.png');

  say('UI-16 页面无 JS 异常', jsErrors.length === 0, jsErrors);
  save();
  const failed = checks.filter((x) => !x.ok);
  console.log(`\nT06325 UI: ${checks.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) process.exitCode = 1;
} catch (error) {
  say('UI-ERR 驱动异常', false, String(error?.stack ?? error).slice(0, 500));
  save();
  process.exitCode = 2;
} finally {
  try { if (chrome?.pid) killTree(chrome.pid); } catch { /* ignore */ }
  try { if (server?.pid) killTree(server.pid); } catch { /* ignore */ }
}
