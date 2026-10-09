#!/usr/bin/env node
/**
 * T01664：打包桌面壳复验探针（固化自 T01569 临时脚本 .t1569-probe.mjs，40 断言）。
 * 对安装包解包目录（dist-win-unpacked/MTask.exe 等）做全链 UI 复验：
 * 抽屉入口/三关闭+焦点归还/五标签页/就地编辑落库/附件放大收起/标题框选/用例面板 accent 边框/
 * 时间线折叠与跳转/移动半屏放大/better-sqlite3 ABI 健康。退出码非 0 即失败，可直接作发版验收门。
 *
 * 用法：node scripts/verify-packaged-shell.mjs [--shell <MTask.exe>] [--user-data <dir>]
 *        [--cdp <port>] [--port <backendPort>] [--shots <dir>] [--filter <断言名子串>]
 *   --shell    解包壳可执行文件路径（默认 ./.t1569-app2/MTask.exe；npm run dist 产物按 dist.js 输出调整）
 *   --user-data userData 目录（默认系统临时目录下每轮全新——绝不触碰用户生产库与默认目录）
 *   --cdp/--port  CDP 与后端端口（默认按时间戳派生的空闲段）
 *   --shots    截图输出目录（默认 .verify-shell-shots/<tag>/）
 *   --filter   仅统计/报告名称含该子串的断言（步骤仍全跑；退出码按过滤集判定）
 *
 * 里程碑成员/依赖复验夹具已带显式 child 依赖（与 T01621 两视图一致口径配套）。
 * 每轮全新 userData + 全新端口：上一轮若异常退出会留下孤儿壳，复用同名端口/数据目录时
 * REST 夹具与 CDP 附着目标可能落到不同实例上，复验结论就不可信（实测坑）。
 * 后端已有 DELETE /projects/:id（级联删任务、收件箱保护）——结尾 best-effort 清理夹具项目。
 */
import { spawn } from 'child_process';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';

const argv = process.argv.slice(2);
const argOf = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };

const EXE = argOf('shell', path.join(process.cwd(), '.t1569-app2', 'MTask.exe'));
const RUN_TAG = String(Date.now()).slice(-6);
const USER_DATA = argOf('user-data', path.join(os.tmpdir(), 'mtask-shell-verify-' + RUN_TAG));
const CDP = Number(argOf('cdp', String(9300 + Number(RUN_TAG.slice(-3)) % 90)));
const PORT = Number(argOf('port', String(40000 + Number(RUN_TAG.slice(-3)) % 900)));
const SHOTS_DIR = argOf('shots', path.join(process.cwd(), '.verify-shell-shots', RUN_TAG));
const FILTER = argOf('filter', '');
const API = `http://127.0.0.1:${PORT}/api`;
const TOKEN = String(Date.now()).slice(-6);
const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAJUlEQVR4nGP8z8DAwMDAwMDAxMDAwMDExIChGRoYMDQAMjEDGo3vGkMAAAAASUVORK5CYII=';
const results = [];
const shots = [];
const ok = (n, p, i) => {
  results.push({ n, p, i });
  console.log((p ? 'PASS ' : 'FAIL ') + n + ' :: ' + JSON.stringify(i).slice(0, 300));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiCall(method, path, body) {
  const res = await fetch(API + path, {
    method, headers: { 'Content-Type': 'application/json', 'X-Access-Token': 'probe' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

if (!existsSync(EXE)) throw new Error(`未找到解包壳：${EXE}`);
// ⚠ ELECTRON_RUN_AS_NODE：WorkBuddy 等 Electron 宿主的终端会向子进程传播该变量，
// 继承它会让打包壳（Electron）被当纯 node 执行——打印 bad option 后 exit 9，后端永不就绪（T01664 实测）。
// 必须从壳进程环境中剥离；MTask_PORT 经 env 下发不受影响。
const shellEnv = { ...process.env, MTask_PORT: String(PORT) };
delete shellEnv.ELECTRON_RUN_AS_NODE;
const shell = spawn(EXE, [`--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${CDP}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1440,900'],
  { stdio: 'ignore', env: shellEnv });
// 无论正常收尾还是异常退出都要回收壳进程：遗留孤儿壳会占住端口与解包目录（本轮踩过）
const bye = () => { try { shell.kill(); } catch { /* */ } };
process.on('exit', bye);
process.on('uncaughtException', (e) => { console.log('UNCAUGHT: ' + (e && e.message)); bye(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.log('REJECT: ' + (e && e.message)); bye(); process.exit(1); });

async function waitServer() {
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(`${API}/projects`, { headers: { 'X-Access-Token': 'probe' } }); if (r.ok) return true; } catch { /* */ }
    await sleep(500);
  }
  return false;
}
const srvUp = await waitServer();
ok('E0 打包壳内后端服务就绪', srvUp, {});
if (!srvUp) { shell.kill(); throw new Error('后端未就绪'); }

const proj = await apiCall('POST', '/projects', { name: `T1569打包复验${TOKEN}`, description: 'T01569 打包态桌面壳复验项目' });
const PROJECT = proj.id;
const PROJ_NAME = proj.name; // 记录项目名称用于 UI 匹配
const task = await apiCall('POST', '/tasks', {
  projectId: PROJECT, title: `T1569复验抽屉就地编辑${TOKEN}`, description: '原始描述：待就地编辑改写',
  handleResult: '原始处理结果：待就地编辑改写', priority: 'high', status: 'todo',
});
const TASK_ID = task.id ?? task.task?.id;
await apiCall('POST', `/tasks/${TASK_ID}/images`, { data: PNG1, mimeType: 'image/png' });
const mk = async (title, kind, startDate, durationDays) => {
  const r = await apiCall('POST', '/plans', { projectId: PROJECT, title, kind, startDate, durationDays });
  return r.id ?? r.plan?.id;
};
const MS = await mk('T1569复验阶段里程碑', 'milestone', '2026-03-02', 12);
const PL = await mk('T1569复验已关联任务', 'normal', '2026-03-06', 3);
await apiCall('POST', `/plans/${PL}/create-todo`);
await apiCall('PATCH', `/plans/${PL}`, { deps: JSON.stringify([{ id: MS, type: 'child' }]) });
console.log(`夹具：P=${PROJECT} T=${TASK_ID} MS=${MS}`);
const getTask = async () => (await apiCall('GET', `/tasks?projectId=${PROJECT}&limit=500`)).find((x) => x.id === TASK_ID) ?? {};

let ws;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) {
      ws = new WebSocket(page.webSocketDebuggerUrl);
      // T01664：ws open 无超时会永久挂起（实测一轮卡死 38min）——15s 超时后关闭重试
      await new Promise((res, rej) => {
        const t = setTimeout(() => { try { ws.close(); } catch { /* */ } rej(new Error('ws open timeout')); }, 15000);
        ws.addEventListener('open', () => { clearTimeout(t); res(); });
        ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('ws error')); });
      });
      break;
    }
  } catch { /* 未就绪/超时：继续重试 */ }
  await sleep(400);
}
if (!ws) { shell.kill(); throw new Error('CDP page target 未出现'); }
let seq = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
async function R(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) throw new Error('页面异常 ' + JSON.stringify(r.result.exceptionDetails.exception?.description || '').slice(0, 240));
  return r.result?.result?.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result) { mkdirSync(SHOTS_DIR, { recursive: true }); writeFileSync(path.join(SHOTS_DIR, `${name}.png`), Buffer.from(r.result.data, 'base64')); shots.push(name); }
}
async function waitUntil(expr, ms = 15000, every = 300) {
  const t0 = Date.now();
  for (;;) { const v = await R(expr); if (v === true) return true; if (Date.now() - t0 > ms) return false; await sleep(every); }
}
async function mouse(x, y, type) { await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); }
async function clickEl(selExpr) {
  const isElem = await R(`(() => { const el = ${selExpr}; return el instanceof HTMLElement; })()`);
  if (isElem !== true) return false;
  await R(`(() => { const el = ${selExpr}; if (el instanceof HTMLElement) el.scrollIntoView({ block: 'center' }); return true; })()`);
  await sleep(120);
  const p = await R(`(() => { const el = ${selExpr}; if (!(el instanceof HTMLElement)) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  if (!p) return false;
  await mouse(p.x, p.y, 'mousePressed'); await mouse(p.x, p.y, 'mouseReleased');
  return true;
}
async function clickPoint(x, y) { await mouse(x, y, 'mouseMoved'); await mouse(x, y, 'mousePressed'); await mouse(x, y, 'mouseReleased'); }
// tap：直接在页面上下文调用 el.click()。CDP 坐标点击在打包壳里对 portal/绝对定位层不稳定
// （实测：项目下拉与抽屉入口坐标点击无效果，click() 生效），故交互断言统一走 tap。
async function tap(selExpr) {
  return R(`(() => { const el = ${selExpr}; if (el && typeof el.click === 'function') { el.click(); return true; } return false; })()`);
}
// typeInto：走原生 value setter + input 事件。Input.insertText 依赖节点已有焦点，
// 而 tap() 触发的 click 不一定把焦点交给 textarea（React 受控组件），实测文本静默丢失。
async function typeInto(selExpr, text) {
  return R(`(() => {
    const el = ${selExpr};
    if (!el) return false;
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc.set.call(el, String(el.value) + ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}
async function pressKey(key, vk) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}
async function dismissGuide() {
  const sel = `(() => { const d = document.querySelector('dialog[open]'); return d ? d.querySelector('button[aria-label="跳过向导"]') : null; })()`;
  if (await R(`!!${sel}`) === true) { await clickEl(sel); await sleep(500); return true; }
  return false;
}

const DIALOG = `(() => [...document.querySelectorAll('[role="dialog"]')].find((d) => d.parentElement && d.parentElement.getAttribute('aria-hidden') === 'false'))()`;
const drawerTitle = `(() => { const d = ${DIALOG}; if (!d) return ''; const lid = d.getAttribute('aria-labelledby'); const h = lid ? document.getElementById(lid) : null; return h ? h.textContent : ''; })()`;
const TABS = `(() => { const d = ${DIALOG}; if (!d) return []; return [...d.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label')).filter((l) => ['描述','处理结果','AI 摘要','时间线','关联计划'].includes(l)); })()`;
const taR = `(() => { const d=${DIALOG}; return d ? d.querySelector('textarea') : null; })()`;
async function clickNav(label) { return clickEl(`(() => [...document.querySelectorAll('nav button, header button, button')].find((b) => (b.textContent || '').trim() === '${label}'))()`); }

await sleep(5000);
const pageUrl = await R('location.href');
ok('E1 附着目标即安装包 renderer（app:// 自定义协议）', String(pageUrl).includes('app://'), { href: String(pageUrl).slice(-80) });

// ---------------- 关键：在任务页通过 UI 选择夹具项目 ----------------
// 1. 直接导航到任务页（TasksPage 已挂载，项目列表会自动加载）
await clickNav('任务');
await sleep(4000); // 等首屏渲染 + 项目列表加载
await dismissGuide();

// 2. 通过 REST API 获取项目列表，找到我们的夹具项目
const projList = await apiCall('GET', '/projects');
const fixtureProj = projList.find(p => p.id === PROJECT);
ok('F0a 夹具项目在列表中', !!fixtureProj, { name: fixtureProj?.name });
// 全新 userData 起壳：项目数应只有收件箱 + 夹具。数量异常=附着到了别的实例，结论不可信
ok('E2a 附着实例为本轮全新数据目录', projList.length <= 3, { projectCount: projList.length });
if (!fixtureProj) { console.log('ABORT: 夹具项目不存在'); shell.kill(); process.exit(1); }

// 3. 点击"切换项目"按钮打开下拉菜单
const projBtn = `(() => document.querySelector('button[aria-label="切换项目"]'))()`;
if (await R(`!!${projBtn}`) !== true) {
  // T01664 现场诊断：按钮缺失时 dump 页面状态（向导遮罩/卸载/导航落点）
  console.log('F0b-DIAG dialogs=' + await R('document.querySelectorAll("dialog").length')
    + ' wizardSkip=' + await R(`!!document.querySelector('button[aria-label="跳过向导"]')`)
    + ' navTask=' + await R(`(() => [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === '任务'))()`)
    + ' body=' + JSON.stringify(await R('document.body.innerText.slice(0, 260)')));
}
await waitUntil(`!!${projBtn}`, 20000); // T01664：冷启动竞态容错（首启工具栏可能晚于固定等待出现）
ok('F0b 任务页存在项目选择按钮', await R(`!!${projBtn}`) === true, {});
await clickEl(projBtn);
await sleep(1500); // 等待下拉菜单完全展开

// 4. 定位夹具项目选项：选项按钮带 title="项目名：待办 N 条…"，DOM 顺序是 UI 排序（置顶优先），
//    与 API 顺序不同，故按 title 精确匹配而非索引/文本
const optSel = `(() => document.querySelector('button[aria-pressed][title*="${PROJ_NAME}"]'))()`;
const optFound = await R(`!!${optSel}`);
ok('F0c 下拉选项中找到夹具项目', optFound === true, { optFound, expectedName: PROJ_NAME });
if (optFound === true) {
  const clicked = await R(`(() => { const btn = ${optSel}; if (btn) { btn.click(); return true; } return false; })()`);
  console.log('点击项目选项结果：' + clicked);
  await sleep(3500); // 等 UI 更新 + 任务数据请求完成
}

const apAfter = await R(`localStorage.getItem('tasks.activeProject')`);
const actualProj = String(apAfter).replace(/^"|"$/g, '');
console.log('选择后 activeProject = ' + actualProj);
ok('F0d activeProject 已更新为夹具项目', actualProj === PROJECT, { expected: PROJECT, actual: actualProj });

// 5. 等待任务列表渲染
await waitUntil(`document.querySelectorAll('.task-item').length > 0`, 20000);

const itemCount = await R(`document.querySelectorAll('.task-item').length`);
ok('A0 夹具待办行在列表中可见', Number(itemCount) > 0, { itemCount });
if (Number(itemCount) === 0) { console.log('ABORT'); shell.kill(); process.exit(1); }

const entrySel = `(() => { const item = [...document.querySelectorAll('.task-item')].find((x) => (x.textContent || '').includes('T1569复验抽屉就地编辑')); return item ? item.querySelector('[aria-label^="展开详情抽屉"]') : null; })()`;

ok('A1 任务行存在「展开详情抽屉」入口', await R(`!!${entrySel}`) === true, {});

// openDrawer：先把真实鼠标移到入口上（行工具栏靠 :hover / :focus-within 撑开，未 hover 时
// visibility:hidden 会让 el.focus() 静默失败，prevFocus 就被捕获成 body），再 focus+click。
// 这对齐真实用户动线：鼠标悬停→点击入口→关闭后焦点归还入口。
async function openDrawer() {
  const p = await R(`(() => { const el=${entrySel}; if(!el) return null; const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}; })()`);
  if (p) await mouse(p.x, p.y, 'mouseMoved');
  await sleep(150);
  const r = await R(`(() => { const el=${entrySel}; if(!el) return false; const okFocus = (el.focus(), document.activeElement === el); el.click(); return okFocus; })()`);
  await waitUntil(`!!${DIALOG}`, 6000);
  return r;
}
console.log('抽屉入口点击结果：' + (await openDrawer()));
await sleep(300);

// 等待抽屉完全打开（aria-hidden="false" 的 dialog 出现）
const drawerOpened = await waitUntil(`!!${DIALOG}`, 8000);
ok('A2 抽屉已打开', drawerOpened === true, {});
if (!drawerOpened) { console.log('ABORT: 抽屉未打开'); shell.kill(); process.exit(1); }

ok('A3 抽屉打开且标题正确', (await R(`(${drawerTitle}||'').includes('T1569复验抽屉就地编辑')`)) === true, { t: await R(drawerTitle) });
const five = await R(TABS);
ok('A4 抽屉五标签页齐全', five.length === 5, { five });
await shot('a-drawer-desc');

// ---------------- 三种关闭方式 + 焦点归还（必须排在任何「保存」之前）----------------
// SlideOver 在打开瞬间捕获 prevFocus=触发按钮；而保存会刷新列表并重建该行 DOM，
// prevFocus 就成了游离节点，此时再验焦点归还测的是重渲染而非关闭逻辑（口径问题，非缺陷）。
const panelLeft = await R(`(() => { const d=${DIALOG}; return d ? Math.round(d.getBoundingClientRect().left) : -1; })()`);
const vp = await R(`({w: window.innerWidth, h: window.innerHeight})`);
const mx = Math.max(6, panelLeft - 40);
await clickPoint(mx, Math.round(vp.h * 0.5));
await sleep(800);
ok('D1a 遮罩点按关闭', await R(`!${DIALOG}`) === true, {});
const d1Focus = await R(`(() => { const a=document.activeElement; const b=${entrySel}; return { same: !!a && a===b, active: a ? (a.getAttribute('aria-label') || a.tagName) : 'none' }; })()`);
ok('D1b 焦点归还触发按钮', d1Focus.same === true, d1Focus);

await openDrawer();
await tap(`(() => { const d=${DIALOG}; return d ? d.querySelector('button[aria-label="关闭抽屉"]') : null; })()`);
await waitUntil(`!${DIALOG}`, 8000); // T01664：等抽屉真正关上（固定 sleep 在慢机会误报，实测毛刺）
ok('D2 ✕ 关闭 + 焦点归还', await R(`!${DIALOG}`) === true && await R(`(() => { const a=document.activeElement; const b=${entrySel}; return !!a && a===b; })()`) === true, {});

await openDrawer();
await pressKey('Escape', 27); await sleep(800);
ok('D3 ESC 关闭 + 焦点归还', await R(`!${DIALOG}`) === true && await R(`(() => { const a=document.activeElement; const b=${entrySel}; return !!a && a===b; })()`) === true, {});

// ---------------- 描述就地编辑 → 落库 ----------------
await openDrawer();
ok('A5a 描述页有原描述和编辑入口', await R(`(() => { const d=${DIALOG}; return !!d && (d.textContent||'').includes('原始描述') && (d.textContent||'').includes('编辑描述'); })()`) === true, {});
await tap(`(() => { const d=${DIALOG}; return d ? [...d.querySelectorAll('button')].find((b)=>(b.textContent||'').includes('编辑描述')) : null; })()`);
await sleep(400);
const taDesc = `(() => { const d=${DIALOG}; return d ? d.querySelector('textarea[aria-label="编辑任务描述"]') : null; })()`;
ok('A5b 进入就地编辑态', await R(`!!${taDesc}`) === true, {});
console.log('typeInto 结果：' + await typeInto(taDesc, '\n\n打包态就地编辑写入（T01569）'));
await sleep(400);
const taVal = await R(`(() => { const el=${taDesc}; return el ? String(el.value).slice(-30) : 'NF'; })()`);
console.log('编辑框尾字符：' + JSON.stringify(taVal));
await tap(`(() => { const d=${DIALOG}; return d ? [...d.querySelectorAll('button')].find((b)=>(b.textContent||'').includes('保存')) : null; })()`);
await waitUntil(`(() => { const d=${DIALOG}; return !!d && (d.textContent||'').includes('打包态就地编辑写入'); })()`, 10000);
const after = await getTask();
console.log('保存后 API description 尾部：' + JSON.stringify(String(after.description ?? '').slice(-30)));
ok('A5c 描述保存落库', String(after.description ?? '').includes('打包态就地编辑写入'), {});

// ---------------- 抽屉附件点击放大（T01563 / 复验发现 flex 宽度塌陷）----------------
const thumbBtn = `(() => { const d=${DIALOG}; return d ? d.querySelector('button[aria-label*="放大预览"]') : null; })()`;
const thumbSel = `(() => { const b=${thumbBtn}; return b ? b.querySelector('img') : null; })()`;
ok('C1a 抽屉附件区渲染缩略图', await R(`!!${thumbSel}`) === true, {});
const beforeW = await R(`(() => { const el=${thumbSel}; return el ? Math.round(el.getBoundingClientRect().width) : -1; })()`);
await tap(thumbBtn);
await sleep(500);
const afterW = await R(`(() => { const el=${thumbSel}; return el ? Math.round(el.getBoundingClientRect().width) : -1; })()`);
const panelW = await R(`(() => { const d=${DIALOG}; return d ? Math.round(d.getBoundingClientRect().width) : -1; })()`);
console.log(`放大态尺寸：img=${afterW} 抽屉宽=${panelW}`);
ok('C1b 点击缩略图 → 放大', afterW > beforeW * 2, { beforeW, afterW, panelW });
await shot('c-attach-zoom');
await tap(thumbBtn); await sleep(400); // 收起，回到缩略图态
ok('C1c 再点同一张 → 收起', await R(`(() => { const el=${thumbSel}; return el ? Math.round(el.getBoundingClientRect().width) : -1; })()`) < 200, {});

// ---------------- 标题可框选（T01533）：先关抽屉，行内标题才可见 ----------------
await pressKey('Escape', 27); await sleep(700);
const titleSel = `(() => { const item=[...document.querySelectorAll('.task-item')].find((x)=>(x.textContent||'').includes('T1569复验抽屉就地编辑')); if (!item) return null; return [...item.querySelectorAll('span[role="button"]')].find((b)=>(b.textContent||'').includes('T1569复验抽屉就地编辑')); })()`;
ok('E2 T01533 标题 user-select=text', String(await R(`(() => { const b=${titleSel}; return b ? getComputedStyle(b).userSelect : 'NF'; })()`)).startsWith('text'), { v: await R(`(() => { const b=${titleSel}; return b ? getComputedStyle(b).userSelect : 'NF'; })()`) });
const tb = await R(`(() => { const b=${titleSel}; if(!b) return null; const r=b.getBoundingClientRect(); return {x1:Math.round(r.left+3),x2:Math.round(r.right-3),y:Math.round(r.top+r.height/2)}; })()`);
if (!tb) { console.log('ABORT: 标题元素定位失败'); shell.kill(); process.exit(1); }
await R(`document.getSelection().removeAllRanges(); true`);
await mouse(tb.x1, tb.y, 'mouseMoved');
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tb.x1, y: tb.y, button: 'left', clickCount: 1 });
for (let x = tb.x1; x <= tb.x2; x += 12) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: tb.y, button: 'left', buttons: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tb.x2, y: tb.y, button: 'left', clickCount: 1 });
await sleep(400);
ok('E3 T01533 标题可真实框选', String(await R(`(() => String(document.getSelection()||''))()`)).includes('T1569复验抽屉就地编辑'), {});
await shot('d-title-select');

await R(`document.getSelection().removeAllRanges(); true`);
await openDrawer();
await tap(`(() => { const d=${DIALOG}; return d ? [...d.querySelectorAll('button')].find((b)=>b.getAttribute('aria-label')==='处理结果') : null; })()`);
await sleep(600);
await tap(`(() => { const d=${DIALOG}; return d ? [...d.querySelectorAll('button')].find((b)=>(b.textContent||'').includes('编辑 / 回传结果')||(b.textContent||'').includes('编辑结果')) : null; })()`);
await sleep(600);
if (await R(`!!${taR}`) === true) {
  console.log('结果框 typeInto：' + await typeInto(taR, '\n打包态结果编辑写入（T01569）'));
  await sleep(400);
  await tap(`(() => { const d=${DIALOG}; return d ? [...d.querySelectorAll('button')].find((b)=>(b.textContent||'').includes('保存')) : null; })()`);
  await sleep(1800);
  const t2 = await getTask();
  console.log('保存后 API handle_result 尾部：' + JSON.stringify(String(t2.handle_result ?? t2.handleResult ?? '').slice(-30)));
  ok('A7c 结果就地编辑保存落库', String(t2.handle_result ?? t2.handleResult ?? '').includes('打包态结果编辑写入'), {});
} else {
  ok('A7c 结果就地编辑保存落库', false, { reason: '未进入结果编辑态' });
}
await shot('h-result-saved');

await pressKey('Escape', 27); await sleep(600);
// 关闭可能残留的行内编辑态：确保抽屉已关
await R(`(() => { const d=${DIALOG}; return !d; })()`);
await tap(`(() => [...document.querySelectorAll('nav button, header button, button')].find((b) => (b.textContent || '').trim() === '项目管理'))()`);
await sleep(2000);
await dismissGuide();

// 计划页作用域是 sessionStorage 的 plan.projectId（与任务页不同键），需在此重新选到夹具项目
const planProjBtn = `(() => document.querySelector('button[aria-label="选择项目"]'))()`;
ok('G0a 计划页存在项目选择按钮', await R(`!!${planProjBtn}`) === true, {});
await tap(planProjBtn);
await sleep(1500);
const planOptSel = `(() => document.querySelector('button[aria-pressed][title*="${PROJ_NAME}"]'))()`;
ok('G0b 计划页下拉含夹具项目', await R(`!!${planOptSel}`) === true, {});
await tap(planOptSel);
await sleep(2500);
const planProjName = await R(`(() => { const b=${planProjBtn}; return b ? (b.textContent||'').trim().slice(0, 30) : 'NF'; })()`);
console.log('计划页当前项目按钮文本：' + planProjName);
ok('G0c 计划页已切到夹具项目', String(planProjName).includes(PROJ_NAME.slice(0, 12)), { planProjName });

const tcSel = `(() => document.querySelector('button[aria-label="测试用例"]'))()`;
ok('F1a 计划页存在测试用例入口', await R(`!!${tcSel}`) === true, {});
await tap(tcSel); await sleep(1500);
const panelSel = `document.querySelector('section[aria-label="测试用例面板"]')`;
const accent = await R(`(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())()`);
const caseBorder = await R(`(() => { const s=${panelSel}; if(!s) return null; const c=getComputedStyle(s); return { w: parseFloat(c.borderTopWidth), style: c.borderTopStyle, color: c.borderTopColor }; })()`);
// 打包壳存在设备缩放，1px 边框实测会渲染为 0.667px；断言按「约 1px + solid + 颜色等于 --accent」而非字面 '1px solid'
const accentRgb = await R(`(() => { const d=document.createElement('div'); d.style.color='${accent}'; document.body.appendChild(d); const v=getComputedStyle(d).color; d.remove(); return v; })()`);
const borderOk = !!caseBorder && caseBorder.w > 0.5 && caseBorder.w < 1.5 && caseBorder.style === 'solid' && caseBorder.color === accentRgb;
ok('F1b T01534 用例面板为 accent 边框', borderOk, { caseBorder, accent, accentRgb });
await shot('e-case-panel');

const tlBtn = `(() => { const b=[...document.querySelectorAll('fieldset[aria-label="视图切换"] button')].find((x)=>(x.textContent||'').trim()==='时间线'); return b||null; })()`;
ok('F2a 计划页存在时间线视图切换', await R(`!!${tlBtn}`) === true, {});
await tap(tlBtn); await sleep(1500);
ok('F2b 切到时间线视图', await R(`!!document.querySelector('[aria-label="计划时间线"]')`) === true, {});
const badgeN = await R(`document.querySelectorAll('[data-tl="jump-linked"]').length`);
const collapseN = await R(`document.querySelectorAll('[data-tl="collapse"]').length`);
ok('F2c T01577 角标随包生效', Number(badgeN) > 0, { badgeN });
ok('F2d T01576 折叠控件随包生效', Number(collapseN) > 0, { collapseN });
await shot('f-timeline');

// ---------------- M 移动端半屏（本轮同因修复的第二处，必须实测）----------------
// resolveUiMode() 只在 touch && small 时自动进移动布局，桌面壳里压视口不生效——
// 走显式偏好 mtask.uiMode='mobile' 并整页重载（同一 CDP target，重载后继续驱动）
await R(`(() => { localStorage.setItem('mtask.uiMode','mobile'); return true; })()`);
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 860, deviceScaleFactor: 1, mobile: true });
await R('location.reload()');
await sleep(7000);
await dismissGuide();
const isMobileShell = await R(`(() => !!document.querySelector('header select'))()`);
ok('M0 已切到移动端布局', isMobileShell === true, {});
// 项目不能靠预设 mtask.mobile.lastProject：MobileHome 开机用 note-project / list[0] 覆写它（137-146 行），
// 会把列表落在别的项目上。改走真实用户路径——驱动头部 <select> 切到夹具项目（React 受控 select 需原生 setter + change）
await R(`(() => { const s=document.querySelector('header select'); if(!s) return false; const d=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value'); d.set.call(s, ${JSON.stringify(PROJECT)}); s.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
await sleep(2500);
// HalfSheet 用原生 <dialog open aria-label="任务详情">（ui.tsx:68），implicit role 而非 role 属性，
// 故不能用 [role="dialog"] 选择器（那是桌面 SlideOver 的写法）
const MOBILE_SHEET = `(() => { const d=document.querySelector('dialog[aria-label="任务详情"]'); return d && d.open ? d : null; })()`;
const mEntry = `(() => { const b=[...document.querySelectorAll('button[aria-label^="任务详情："]')].find(x=>(x.getAttribute('aria-label')||'').includes('T1569复验抽屉就地编辑')); return b||null; })()`;
await waitUntil(`!!${mEntry}`, 15000);
const mDiag = await R(`(() => { const s=document.querySelector('header select'); return { sel: s ? s.value : 'NF', rows: document.querySelectorAll('button[aria-label^="任务详情："]').length }; })()`);
ok('M1 移动布局下夹具待办可见', await R(`!!${mEntry}`) === true, mDiag);
await tap(mEntry);
await sleep(1200);
ok('M2 半屏详情已打开', await R(`!!${MOBILE_SHEET}`) === true, {
  dialogs: await R(`document.querySelectorAll('dialog').length`),
  sheetLabel: await R(`(() => { const d=document.querySelector('dialog'); return d ? d.getAttribute('aria-label') : null; })()`),
});
const mThumbBtn = `(() => { const d=${MOBILE_SHEET}; return d ? d.querySelector('button[aria-label*="放大预览"]') : null; })()`;
const mThumbSel = `(() => { const b=${mThumbBtn}; return b ? b.querySelector('img') : null; })()`;
ok('M3 半屏附件缩略图渲染', await R(`!!${mThumbSel}`) === true, {});
const mBefore = await R(`(() => { const el=${mThumbSel}; return el ? Math.round(el.getBoundingClientRect().width) : -1; })()`);
await tap(mThumbBtn);
await sleep(600);
const mAfter = await R(`(() => { const el=${mThumbSel}; return el ? Math.round(el.getBoundingClientRect().width) : -1; })()`);
const mSheetW = await R(`(() => { const d=${MOBILE_SHEET}; return d ? Math.round(d.getBoundingClientRect().width) : -1; })()`);
console.log(`半屏放大：img ${mBefore} → ${mAfter}（半屏宽 ${mSheetW}）`);
ok('M4 半屏点击缩略图 → 放大', mAfter > 0 && mBefore > 0 && mAfter > mBefore * 2, { mBefore, mAfter, mSheetW });
await shot('g-mobile-zoom');
await send('Emulation.clearDeviceMetricsOverride');
await sleep(400);

const logPath = `${USER_DATA}/server-startup.log`;
const startup = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
const health = await apiCall('GET', `/projects`).then((r) => (Array.isArray(r) ? r.length : -1)).catch(() => -1);
ok('E4 better-sqlite3 正常加载（Electron ABI 生效）', health > 0 && (startup ? !/ERR_DLOPEN_FAILED|NODE_MODULE_VERSION/.test(startup) : true), { health, logBytes: startup.length });

// best-effort 清理夹具项目（后端 DELETE /projects/:id 级联删任务；userData 本就每轮全新）
try { await apiCall('DELETE', `/projects/${PROJECT}`); console.log('夹具项目已清理：' + PROJ_NAME); } catch (e) { console.log('夹具项目清理失败（不影响结论）：' + String(e.message).slice(0, 120)); }

const counted = FILTER ? results.filter((r) => r.n.includes(FILTER)) : results;
const fail = counted.filter((r) => r.p !== true);
console.log(`VERIFY-SHELL total=${counted.length} fail=${fail.length} shots=${shots.join(',')} userData=${USER_DATA}${FILTER ? ` filter=${FILTER}` : ''}`);
if (fail.length) console.log('FAILED: ' + fail.map((f) => f.n).join(' | '));
shell.kill();
process.exit(fail.length ? 1 : 0);
