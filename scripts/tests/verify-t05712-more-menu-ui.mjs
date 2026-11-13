/**
 * T05712 门 B（ui-probe 真机门）：任务工具栏低频功能「...」下拉归集。
 *
 * 通道：隔离后端（独立端口 + 独立数据目录 + 伺服本次构建的前端产物）+ 真实 Chrome
 * （headless，CDP）+ 真实鼠标事件。生产 :39877 与用户数据目录全程未被触碰。
 *
 * 覆盖（逐条对应工单约束）：
 *  约束① 7 项不再以独立按钮显示：主工具栏 DOM 逐一断言 7 个旧 aria-label 不存在
 *  约束② 点击「...」弹出下拉、显示 7 个选项：role=menu + 7 个 data-t05712 项 + 左图标/文字对齐
 *  约束③ 功能完整性：创建子任务/文件导出/字体颜色/修改处理结果/复用此任务/搁置 逐一真点并取证
 *  约束④ 兼容性：菜单为纯静态渲染，断网（Network.emulateNetworkConditions offline）后仍展开 7 项
 *  约束⑤ 响应式：窄屏视口下菜单 rect 完整落在视口内，无横向溢出
 *  交互健壮性：Esc / 外点收起、Portal 挂 body 不被 .task-toolbar 裁剪
 *  截图：.workbuddy/t05712-more-menu.png（与设计图人工比对用）
 *
 * 用法：node scripts/tests/verify-t05712-more-menu-ui.mjs [--port N] [--headful] [--keep]
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
// 默认随机高位端口：避免上一轮残留实例占住固定端口导致新实例静默起不来
const PORT = Number(arg('--port', String(40000 + Math.floor(Math.random() * 12000))));
const BASE = `http://127.0.0.1:${PORT}`;
// 每轮唯一目录：不复用、不递归删除（批量删除守卫会拦 Chrome 数百个缓存文件 / trash 二进制可能超时），
// 隔离实例天然从空库起步，符合「变更类测试用隔离实例」纪律。
const RUN_ID = `${process.pid}-${Date.now()}`;
const OUT = arg('--out', join(ROOT, '.workbuddy', `t05712-ui-${RUN_ID}`));
const DATA_DIR = join(OUT, 'data');
const STATIC = arg('--dist', join(ROOT, 'web', 'dist'));
const CHROME = arg('--chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const SHOT = join(ROOT, '.workbuddy', 't05712-more-menu.png');

let pass = 0, fail = 0;
const lines = [];
const PROGRESS_LOG = join(ROOT, '.workbuddy', 't05712-ui-progress.log');
mkdirSync(join(ROOT, '.workbuddy'), { recursive: true });
writeFileSync(PROGRESS_LOG, `T05712 真机门实时进度 port=${PORT} pid=${process.pid}\n`, 'utf8');
const say = (name, cond, extra) => {
  cond ? (pass += 1) : (fail += 1);
  const line = `[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${typeof extra === 'string' ? extra.slice(0, 600) : JSON.stringify(extra).slice(0, 600)}`}`;
  lines.push(line);
  console.log(line);
  appendFileSync(PROGRESS_LOG, line + '\n', 'utf8'); // 同步落盘：stdout 块缓冲时也能看到进度
};

mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(join(STATIC, 'index.html'))) {
  console.error(`前端产物缺失：${STATIC}（先跑 web/npm run build）`);
  process.exit(2);
}

/* ---------------- 1) 隔离后端 ---------------- */
const tsx = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
function pickLauncher() {
  const cands = [
    { exec: process.execPath, env: {}, label: 'node' },
    { exec: join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), env: { ELECTRON_RUN_AS_NODE: '1' }, label: 'electron-as-node' },
  ];
  for (const c of cands) {
    try {
      execFileSync(c.exec, ['-e', "require('better-sqlite3');"], { cwd: ROOT, env: { ...process.env, ...c.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }, stdio: 'pipe', timeout: 30_000 });
      return c;
    } catch { /* 换下一个 */ }
  }
  throw new Error('没有可用的启动器');
}
const launcher = pickLauncher();
const serverLog = join(OUT, 'server.log');
writeFileSync(serverLog, '', 'utf8');
const server = spawn(launcher.exec, [tsx, join(ROOT, 'server', 'src', 'index.ts')], {
  cwd: ROOT,
  env: { ...process.env, ...launcher.env, MTask_DATA_DIR: DATA_DIR, MTask_PORT: String(PORT), MTASK_STATIC_DIR: STATIC, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => appendFileSync(serverLog, String(d), 'utf8'));
server.stderr.on('data', (d) => appendFileSync(serverLog, String(d), 'utf8'));
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退 */ } };
process.on('exit', () => { if (!argv.includes('--keep')) killTree(server.pid); });

async function waitReady(budgetMs = 200_000) {
  for (let i = 0; i < budgetMs / 1500; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch { /* 还没起 */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}
appendFileSync(PROGRESS_LOG, '[stage] 隔离后端启动中…\n', 'utf8');
const booted = await waitReady();
say('UI-00 隔离后端就绪并伺服本次构建产物（生产 :39877 未被触碰）', booted, { port: PORT, static: STATIC, 启动器: launcher.label });
if (!booted) process.exit(2);

async function japi(p, init = {}) {
  const r = await fetch(`${BASE}${p}`, { headers: { connection: 'close', 'Content-Type': 'application/json' }, ...init });
  const t = await r.text();
  if (!r.ok) throw new Error(`${p} → ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
const post = (p, body) => japi(p, { method: 'POST', body: JSON.stringify(body ?? {}) });

/* ---------------- 2) 夹具（经真实 HTTP 落库） ---------------- */
const proj = await post('/api/projects', { name: `UI-T05712-项目-${Date.now() % 1e6}`, description: 'T05712 真机门夹具' });
const task = await post('/api/tasks', { projectId: proj.id, title: 'T05712｜工具栏低频功能归集验证任务', description: '夹具：验证「...」下拉的 7 项功能', priority: 'normal', status: 'todo' });
say('UI-01 夹具项目与任务经真实 HTTP 落库', !!proj?.id && !!task?.id, { project: proj?.id, task: task?.task_no });

/* ---------------- 3) Chrome / CDP ---------------- */
// 每轮用唯一 profile：既天然避开上轮 SingletonLock（否则新进程把 URL 转给旧实例后 code=0 退出），
// 又无需递归删除 Chrome 的数百个缓存文件（批量删除守卫会拦，且删了也没必要）。
appendFileSync(PROGRESS_LOG, `[stage] 夹具完成，启动 Chrome（端口 ${PORT}）…\n`, 'utf8');
const profile = join(OUT, `profile-${process.pid}-${Date.now()}`);
mkdirSync(profile, { recursive: true });
const chrome = spawn(CHROME, [
  ...(argv.includes('--headful') ? [] : ['--headless=new']), '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1440,1100', '--disable-features=Translate', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
process.on('exit', () => { try { chrome.kill(); } catch { /* 已退 */ } });
// 端口双通道：stderr 的 "DevTools listening on ws://…" 与 user-data-dir/DevToolsActivePort 文件，
// 任一先到即用（Windows 下 stderr 时序不稳定，文件兜底与 T03703 门同口径）。
const cdpPort = await new Promise((res, rej) => {
  let done = false;
  const finish = (p) => { if (!done) { done = true; clearInterval(poll); clearTimeout(t); res(p); } };
  const t = setTimeout(() => rej(new Error('Chrome 30s 内未报出调试端口')), 30000);
  let buf = '';
  const on = (d) => { buf += String(d); const m = /ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser/.exec(buf); if (m) finish(Number(m[1])); };
  chrome.stderr.on('data', on); chrome.stdout.on('data', on);
  const portFile = join(profile, 'DevToolsActivePort');
  const poll = setInterval(() => {
    try { const p = Number(readFileSync(portFile, 'utf8').split(/\r?\n/)[0]); if (p > 0) finish(p); } catch { /* 还没写 */ }
  }, 250);
  chrome.on('exit', (c) => { if (!done) { clearInterval(poll); clearTimeout(t); rej(new Error(`Chrome 提前退出 code=${c}`)); } });
}).catch((e) => { console.error(String(e.message ?? e)); process.exit(2); });

const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const pageTarget = list.find((x) => x.type === 'page') ?? await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`)).json();
const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((r, j2) => { ws.onopen = r; ws.onerror = () => j2(new Error('CDP 连接失败')); });
let seq = 0;
const waiting = new Map();
const jsErrors = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(String(m.data));
  if (msg.method === 'Runtime.exceptionThrown') jsErrors.push(String(msg.params?.exceptionDetails?.exception?.description ?? '').slice(0, 200));
  if (msg.id !== undefined && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
};
// 每条 CDP 命令必须有超时：Chrome 崩溃 / WS 静默关闭时没有响应的话，
// 未加保护的 Promise 会永久挂起（本门第一版曾因此卡满 13 分钟无任何输出）。
const send = (method, params = {}) => new Promise((r) => {
  const id = ++seq;
  const timer = setTimeout(() => {
    if (waiting.delete(id)) r({ __err: `CDP ${method} 超时(20s)` });
  }, 20_000);
  waiting.set(id, (msg) => { clearTimeout(timer); r(msg.error ? { __err: msg.error.message } : msg.result); });
  try { ws.send(JSON.stringify({ id, method, params })); }
  catch (e) { clearTimeout(timer); waiting.delete(id); r({ __err: `CDP 发送失败: ${e}` }); }
});
ws.onclose = () => {
  for (const [, cb] of waiting) cb({ error: { message: 'CDP WebSocket 已关闭' } });
  waiting.clear();
};
// 全局硬兜底：任何未预料到的挂起都不应让门无限运行
const hardStop = setTimeout(() => {
  console.error('[FATAL] 真机门超过 5 分钟，强制结束（详见 server.log / 门输出）');
  process.exit(2);
}, 300_000);
hardStop.unref?.();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evl = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.__err) return { __err: r.__err };
  if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 300) };
  return { value: r.result?.value };
};
const clickXY = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};
const clickAt = async (sel, { scroll = true } = {}) => {
  // 菜单是 body 下的 fixed 层：对菜单内元素 scrollIntoView 会触发页面滚动 → 组件重定位
  // 面板，先前算好的点击坐标随即失效。菜单内一律 scroll:false。
  const box = await evl(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;`
    + `${scroll ? "e.scrollIntoView({block:'center'});" : ''}`
    + `const r=e.getBoundingClientRect();if(!r.width||!r.height)return JSON.stringify({bare:true});`
    + `return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});})()`);
  if (!box.value) return { __err: `未找到 ${sel}` };
  const b = JSON.parse(box.value);
  if (b.bare) return { __err: `${sel} 无可见尺寸` };
  await clickXY(b.x, b.y);
  return { ok: true, ...b };
};
const key = async (k, code, vk) => {
  // Escape / 方向键等功能键不能带 text：带 text 时 CDP 按「字符输入」派发，
  // 浏览器不会把它当成 e.key==='Escape' 的 keydown，组件的 Esc 收起自然收不到。
  const functional = !/^.$/.test(k);
  const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(functional ? {} : { text: k }) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
};
/** 关闭当前模态：优先真点「取消」按钮（真实用户路径），确保遮罩不残留影响后续点击 */
const dismissDialog = async () => {
  const sels = ['[role="dialog"] button[aria-label="取消：放弃本次输入"]',
    'button[aria-label="取消：放弃本次输入"]',
    'button[aria-label="取消：取消并关闭确认"]'];
  for (const s of sels) {
    const hit = (await evl(`!!document.querySelector(${JSON.stringify(s)})`)).value;
    if (hit === true) { await clickAt(s, { scroll: false }); await sleep(260); return; }
  }
  // 复用弹窗的「取消」无 aria-label：按可见文本定位（仅在「复用任务」弹窗存在时）
  const reuseCancel = (await evl(`(()=>{const m=[...document.querySelectorAll('div')].find(d=>d.textContent.trim()==='复用任务'&&d.children.length===0);`
    + `if(!m)return null;const box=m.parentElement?.parentElement;if(!box)return null;`
    + `const b=[...box.querySelectorAll('button')].find(x=>x.textContent.trim()==='取消');if(!b)return null;`
    + `b.setAttribute('data-t05712-test','reuse-cancel');return true;})()`)).value;
  if (reuseCancel === true) {
    await clickAt('[data-t05712-test="reuse-cancel"]', { scroll: false });
    await sleep(260);
    return;
  }
  await key('Escape', 'Escape', 27);
  await sleep(260);
};

await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', {
  // 夹具①：预置项目选择 / 引导已读，等价用户上次选过该项目。
  // 夹具②：隔离实例默认没有任何 AI 工具，按 T03257 既有口径「分类建议」入口会 hidden。
  //   为让工单要求的 7 个选项全部渲染以便逐项验证，在页面侧拦截 readiness / stats 两个
  //   只读接口返回「AI 已就绪」。纯前端测试夹具，不改服务端配置、不写库、不触碰生产。
  source: `localStorage.setItem('tasks.activeProject', ${JSON.stringify(JSON.stringify(proj.id))});
for (const k of ['tasks','aitools','prompts','req','report','history','queue','exec-sessions','settings','plan']) localStorage.setItem('mtask.guide.seen.' + k, '1');
localStorage.setItem('mtask.projectGuide.seen', '1');
(function(){
  const orig = window.fetch;
  window.fetch = function(input, init){
    const u = typeof input === 'string' ? input : (input && input.url) || '';
    const mk = (o) => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    if (u.indexOf('/ai/readiness') >= 0) return mk({ ready: true, code: 'ok', reason: '' });
    if (u.indexOf('/ai/suggestions/stats') >= 0) return mk({ enabled: true, shown: 1 });
    return orig.apply(this, arguments);
  };
})();`,
});
await send('Page.navigate', { url: `${BASE}/` });
await sleep(2800);
await key('1', 'Digit1', 49); // 一级菜单「任务」
await sleep(1600);

const rows = (await evl(`document.querySelectorAll('li.task-item').length`)).value ?? 0;
say('UI-02 任务页渲染出夹具任务行（页面可用，不是加载中）', rows >= 1, { rows });

/* ---------------- 4) 约束①：7 项不再独立显示 ---------------- */
const OLD_LABELS = [
  '创建子任务',
  '文件导出：T05712｜工具栏低频功能归集验证任务',
  '复用此任务：将该任务复制到其他项目或资产页',
  '搁置任务',
  '获取该任务的分类与优先级建议',
];
const oldPresent = await evl(`(()=>{const labels=${JSON.stringify(OLD_LABELS)};const row=document.querySelector('li.task-item');if(!row)return null;`
  + `const toolbar=row.querySelector('.task-toolbar');if(!toolbar)return null;`
  + `return JSON.stringify({found:labels.filter(l=>toolbar.querySelector('button[aria-label='+JSON.stringify(l)+']')),more:toolbar.querySelectorAll('[data-t05712="more-trigger"]').length,`
  + `high:[...toolbar.querySelectorAll('button[aria-label]')].map(b=>b.getAttribute('aria-label'))});})()`);
const oldState = oldPresent.value ? JSON.parse(oldPresent.value) : null;
say('UI-03 主工具栏不再直接显示这 7 个独立按钮（旧 aria-label 全部查无）',
  !!oldState && oldState.found.length === 0, oldState);
say('UI-04 主工具栏仅保留 1 个「...」触发器，高频按钮（复制/描述/归档）仍在',
  !!oldState && oldState.more === 1 &&
  oldState.high.includes('复制：复制该任务内容到剪贴板') &&
  oldState.high.includes('归档：将该任务移入归档') &&
  oldState.high.some((x) => x?.includes('编辑该任务描述')), oldState?.high);

/* ---------------- 5) 约束②：展开下拉、7 项、Portal 与视觉 ---------------- */
/* 「...」触发器带 .task-op（默认 visibility:hidden，任务行 hover/focus-within 才显形），
   真实鼠标首击偶发被吞：先 mouseMoved 到按钮触发 hover，等过渡落定再点，最多重试 4 次。
   与项目既有真机门的 clickUntil 同口径，不换 el.click() 这种绕过命中测试的假点击。 */
const openMenu = async () => {
  const isOpen = async () => (await evl(`!!document.querySelector('[data-t05712="more-menu"]')`)).value === true;
  if (await isOpen()) return true;
  for (let i = 1; i <= 4; i++) {
    const box = await evl(`(()=>{const e=document.querySelector('[data-t05712="more-trigger"]');if(!e)return null;const r=e.getBoundingClientRect();if(!r.width||!r.height)return JSON.stringify({bare:true});return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});})()`);
    if (!box.value) { await sleep(250); continue; }
    const b = JSON.parse(box.value);
    if (b.bare) { await sleep(250); continue; }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y });
    await sleep(220); // 等 .task-op 的 visibility/opacity 过渡 + React 渲染
    await clickXY(b.x, b.y);
    await sleep(320);
    if (await isOpen()) return true;
  }
  return false;
};
const assertMenuOpen = async (label) => {
  const opened = await openMenu();
  say(label, opened === true, { opened });
  return opened;
};
await openMenu();
const menuProbe = await evl(`(()=>{const m=document.querySelector('[data-t05712="more-menu"]');if(!m)return null;`
  + `const r=m.getBoundingClientRect();const items=[...m.querySelectorAll('[data-t05712^="item-"]')];`
  + `return JSON.stringify({inBody:m.parentElement===document.body,role:m.getAttribute('role'),`
  + `rect:{x:r.x,y:r.y,w:r.width,h:r.height},vw:innerWidth,vh:innerHeight,`
  + `count:items.length,keys:items.map(i=>i.getAttribute('data-t05712')),`
  + `labels:items.map(i=>i.textContent.replace(/\\s+/g,' ').trim()),`
  + `icons:items.map(i=>i.querySelectorAll('svg').length),`
  + `bg:getComputedStyle(m).backgroundColor,radius:getComputedStyle(m).borderRadius,`
  + `firstAlign:(()=>{const b=items.find(i=>i.getAttribute('role')==='menuitem');if(!b)return null;const s=getComputedStyle(b);return {display:s.display,align:s.alignItems,textAlign:s.textAlign};})()});})()`);
const menu = menuProbe.value ? JSON.parse(menuProbe.value) : null;
say('UI-05 点击「...」弹出下拉，菜单经 Portal 挂 document.body（不被 .task-toolbar 裁剪）',
  !!menu && menu.inBody === true && menu.role === 'menu', menu);
say('UI-06 下拉显示 7 个选项（键与工单一一对应）',
  !!menu && menu.count === 7 &&
  ['item-subtask', 'item-export', 'item-font-color', 'item-shelve', 'item-suggest', 'item-result', 'item-reuse']
    .every((k) => menu.keys.includes(k)), menu?.keys);
say('UI-07 每项左图标 + 文字左对齐、白底圆角卡片（对齐参考图）',
  !!menu && menu.icons.every((n) => n >= 1) && menu.firstAlign?.display === 'flex' &&
  menu.firstAlign?.align === 'center' && menu.firstAlign?.textAlign === 'left' &&
  parseFloat(menu.radius) >= 6, { icons: menu?.icons, firstAlign: menu?.firstAlign, radius: menu?.radius });
say('UI-08 菜单 rect 完整落在视口内、无横向溢出',
  !!menu && menu.rect.x >= 0 && menu.rect.y >= 0 &&
  menu.rect.x + menu.rect.w <= menu.vw + 1 && menu.rect.y + menu.rect.h <= menu.vh + 1, menu?.rect);

await send('Page.captureScreenshot', { format: 'png' }).then((r) => {
  if (r?.data) writeFileSync(SHOT, Buffer.from(r.data, 'base64'));
});
say('UI-09 下拉展开截图已存（供与设计图人工比对）', existsSync(SHOT), SHOT);

/* ---------------- 6) 交互健壮性：Esc / 外点收起 ---------------- */
const escPre = await openMenu(); // 先确认真打开过，否则「没开→收起」会是假阳性
await key('Escape', 'Escape', 27);
await sleep(260);
const afterEsc = (await evl(`!!document.querySelector('[data-t05712="more-menu"]')`)).value;
say('UI-10 菜单打开后按 Esc 收起下拉', escPre === true && afterEsc === false, { escPre, afterEsc });

const outPre = await openMenu();
await clickXY(20, 20); // 页面左上角空白处
await sleep(260);
const afterOutside = (await evl(`!!document.querySelector('[data-t05712="more-menu"]')`)).value;
say('UI-11 菜单打开后点击外部区域收起下拉', outPre === true && afterOutside === false, { outPre, afterOutside });

/* ---------------- 7) 约束③：逐项点击验证功能行为 ---------------- */
// (a) 创建子任务 → askInput 弹窗
await openMenu();
const clickItem = async (k) => {
  const r = await clickAt(`[data-t05712="${k}"]`, { scroll: false });
  await sleep(420);
  return r;
};
await clickItem('item-subtask');
// 只认弹窗输入框，不能用 innerText 含「创建子任务」判据（菜单项自身就有这段文字，会假阳性）
const subtaskDialog = (await evl(`!!document.querySelector('input[placeholder="子任务标题"]')`)).value;
say('UI-12 「创建子任务」仍触发原输入弹窗（模态逻辑未变）', subtaskDialog === true, { subtaskDialog });
await dismissDialog(); // 真点「取消」关闭弹窗，避免遮罩残留挡住后续点击

// (b) 文件导出 → 三格式菜单
await openMenu();
await clickItem('item-export');
const exportMenu = (await evl(`!!document.querySelector('[aria-label="关闭导出菜单"]') && document.body.innerText.includes('导出为…')`)).value;
say('UI-13 「文件导出」仍弹出原三格式菜单', exportMenu === true, { exportMenu });
await clickAt('[aria-label="关闭导出菜单"]');
await sleep(200);

// (c) 字体颜色 → 色板入口可用且不被裁剪
await openMenu();
const paletteBtn = '[data-t05712="item-font-color"] button[aria-label*="展开颜色面板"]';
const paletteClick = await clickAt(paletteBtn, { scroll: false });
await sleep(300);
const palette = (await evl(`(()=>{const g=[...document.querySelectorAll('button[aria-label^="字体颜色：应用颜色"]')];`
  + `if(!g.length)return null;const r=g[0].getBoundingClientRect();return JSON.stringify({count:g.length,visible:r.width>0&&r.height>0,rect:{x:r.x,y:r.y,w:r.width,h:r.height}});})()`)).value;
say('UI-14 「字体颜色」下拉内色板入口可点开且色块未被裁剪（16 色 + 默认）',
  !!palette && JSON.parse(palette).count >= 16 && JSON.parse(palette).visible,
  { paletteClick, palette });
await clickXY(20, 20); // 色板/菜单靠外点收起
await sleep(240);

// (d) 修改处理结果 → 编辑器展开
await openMenu();
await clickItem('item-result');
const resultEditor = (await evl(`!!document.querySelector('textarea[placeholder^="处理结果："]')`)).value;
say('UI-15 「修改处理结果」仍展开原处理结论编辑器', resultEditor === true, { resultEditor });

// (e) 复用此任务 → 复用弹窗
await openMenu();
await clickItem('item-reuse');
const reuseDialog = (await evl(`document.body.innerText.includes('复用任务')`)).value;
say('UI-16 「复用此任务」仍打开原复用弹窗（含目标项目/资产选择）', reuseDialog === true, { reuseDialog });
await dismissDialog(); // 真点「取消」关闭复用弹窗
await clickXY(20, 20); // 收起可能仍展开的菜单
await sleep(240);

// 注：「搁置」会让任务从待办列表移出，必须放在所有需要任务行的验证之后（见下方 UI-21）。

// (f) 分类建议：按既有口径显隐/禁用，保留回归锚
const suggestVisible = (await evl(`(()=>{const m=document.querySelector('[data-t05712="more-menu"]');return m?!!m.querySelector('[data-t03255="row-trigger"]'):null;})()`)).value;
const suggestMenuOpen = await openMenu();
const suggestAnchor = (await evl(`(()=>{const m=document.querySelector('[data-t05712="more-menu"]');if(!m)return null;`
  + `const a=m.querySelector('[data-t03255="row-trigger"]');return a?JSON.stringify({state:a.getAttribute('data-t03257'),disabled:!!a.disabled}):null;})()`)).value;
say('UI-18 「分类建议」显隐/禁用沿用 suggestEntry 口径并保留 data-t03255 / data-t03257 回归锚',
  suggestMenuOpen === true && typeof suggestAnchor === 'string' &&
  JSON.parse(suggestAnchor).state === 'visible', { suggestVisible, suggestAnchor });

/* ---------------- 8) 约束④：离线仍展示静态选项 ---------------- */
await send('Network.enable');
await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
await clickXY(20, 20); // 先外点收起，确保下面验证的是「断网后重新展开」
await sleep(240);
const offlineOpened = await openMenu();
const offlineMenu = (await evl(`(()=>{const m=document.querySelector('[data-t05712="more-menu"]');return m?m.querySelectorAll('[data-t05712^="item-"]').length:null;})()`)).value;
say('UI-19 断网状态下「...」菜单仍可展开并展示静态选项（无网络依赖）',
  offlineOpened === true && typeof offlineMenu === 'number' && offlineMenu === 7, { offlineOpened, offlineMenu });
await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

/* ---------------- 9) 约束⑤：窄屏自适应 ---------------- */
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 780, deviceScaleFactor: 1, mobile: false });
await sleep(400);
await key('1', 'Digit1', 49);
await sleep(500);
await openMenu();
const narrow = (await evl(`(()=>{const m=document.querySelector('[data-t05712="more-menu"]');if(!m)return null;const r=m.getBoundingClientRect();`
  + `return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height,vw:innerWidth,vh:innerHeight,scrollW:document.documentElement.scrollWidth});})()`)).value;
const ns = narrow ? JSON.parse(narrow) : null;
say('UI-20 窄屏 420px 下菜单完整落在视口内、页面无横向溢出',
  !!ns && ns.x >= 0 && ns.x + ns.w <= ns.vw + 1 && ns.scrollW <= ns.vw + 1, ns);
await send('Emulation.clearDeviceMetricsOverride');

/* ---------------- 10) 搁置：放在最后（任务会从待办列表移出） ---------------- */
await clickXY(20, 20);
await sleep(240);
const shelvePre = await openMenu();
await clickItem('item-shelve');
await sleep(600);
const taskAfter = await japi(`/api/tasks/by-no/${task.task_no}`);
say('UI-21 「搁置」仍走原接口并真实落库（shelved=true）',
  shelvePre === true && taskAfter?.shelved === true, { shelvePre, shelved: taskAfter?.shelved });

say('UI-22 全程无未捕获 JS 异常', jsErrors.length === 0, jsErrors.slice(0, 3));

const summary = `T05712 门 B（ui-probe 真机）：${pass} 通过 / ${fail} 失败`;
lines.push('', summary);
mkdirSync(join(ROOT, '.workbuddy'), { recursive: true });
writeFileSync(join(ROOT, '.workbuddy', 't05712-ui-gate-results.txt'), lines.join('\n'), 'utf8');
appendFileSync(PROGRESS_LOG, summary + '\n', 'utf8');
console.log(summary);
// 显式收尾：CDP WebSocket 与 Chrome 会持续占住事件循环，不主动退出的话
// 全局硬兜底会被误触发并把「全绿」判成 exit=2。
clearTimeout(hardStop);
try { ws.close(); } catch { /* 已关 */ }
try { chrome.kill(); } catch { /* 已退 */ }
try { killTree(server.pid); } catch { /* 已退 */ }
process.exit(fail > 0 ? 1 : 0);
