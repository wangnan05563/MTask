#!/usr/bin/env node
/**
 * T02041（估算视图 §5.4 区间条 = P0）真机走查：CDP 驱动 headless Chrome 打开**隔离实例**的估算面板，
 * 断言只有真实浏览器能回答的问题：
 *   ① 区间条画出来的**像素位置**确实等于服务端的 O/P/E ÷ 同一基数（几何不是摆设，也不是前端第二套算式）；
 *   ② 行内改值（PATCH）后条长跟着变、刷新后仍在；
 *   ③ 「只看未复核」筛选**不改归一基数**（否则同一行的条会长短凭空变化，等于骗读者）；
 *   ④ 已落库行走 --accent、建议行走 --text-muted，明暗两套主题都跟 CSS 变量；
 *   ⑤ 里程碑组头不画区间条；空项目不画图例；
 *   ⑥ §10-1/2/13 三档视口（1920/1440/1200）与 1100 覆盖式下不产生横向滚动、文字不截断。
 *
 * T02293 判据落地：U 组只认结构/几何/库读数（面板根、工具条、区间条 role=img+4 个子元素、
 * 行标题取自夹具、筛选复选框取自工具条、P 输入取自行内第 3 个 number 框）；产品中文文案与标识符锚
 * 一律进 P 组的 `okPair` 字面腿（取证面 `git show HEAD:`）。N 组负对照：空源码、HEAD 在场性、
 * 抽干实测料、逐锚改名、okPair 契约、按类破坏行为腿。
 *
 * 用法（Chrome 用系统安装版；本仓内置 Browser 无视口不能点击/截图，见 memory）：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02041-ui.mjs
 *   环境变量：T02041_UI_PORT（默认 39934）、T02041_UI_CDP（默认 9344）
 *
 * 隔离纪律（skill 红线 8）：MTask_DATA_DIR 指临时目录、端口自配，不碰生产库与用户实例；
 * 退出连 Chrome 子进程树一起回收（taskkill /T），截图落每轮独立子目录（`MTASK_GATE_ARTIFACT_DIR/<门名>-<运行标识>/`，T02312：不再落仓库根固定名目录，防并发整图互覆）。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 临时根必须落 D:（C: 常年 0 可用，SQLITE_FULL 会伪装成产品失败）
const TMP_ROOT = existsSync('D:/code/tmp') ? 'D:/code/tmp' : tmpdir();
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't02041-ui-'));
const CHROME_PROFILE = mkdtempSync(join(TMP_ROOT, 't02041-ui-chrome-'));
if (!process.env.MTASK_GATE_ARTIFACT_DIR) process.env.MTASK_GATE_ARTIFACT_DIR = join(TMP_ROOT, 'mtask-gate-shots');
// T02312：截图不落仓库根固定名目录（并发跑门时同一步骤名整图互覆，且仓库根长期堆未纳管产物）——
// 改用 gate-results 的进程级 RUN_TAG 子目录，与本轮文本产物同标识，可按标识核对归属。
const { gateShotsDir } = await import(pathToFileURL(join(ROOT, 'scripts/lib/gate-results.mts')).href);
const { okPair } = await import(pathToFileURL(join(ROOT, 'scripts/lib/anchor-pair.mts')).href);
const SHOTS = gateShotsDir('t02041');
const PORT = Number(process.env.T02041_UI_PORT ?? 39934);
const CDP = Number(process.env.T02041_UI_CDP ?? 9344);
const CHROME = process.env.T02041_UI_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra).toString().slice(0, 360)}` : ''}`);
  }
};

/** 反模式 11：字面腿取已提交树（工作树可能躺着别的会话的过期产品文件） */
const headSource = (rel) => {
  try { return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }); } catch { return ''; }
};
const EP_HEAD = headSource('web/src/components/EstimatePanel.tsx');
const APP_HEAD = headSource('web/src/App.tsx');
const PLAN_HEAD = headSource('web/src/pages/PlanPage.tsx');
/** 运行期实测料（行为腿只读它；N 组抽干后必须全部转假） */
let EV = {};

// ---------------- 1) 夹具：临时库直写（进程内，起服务前完成） ----------------
process.env.MTask_DATA_DIR = DATA_DIR;
const { getDb, closeDb } = await import('../server/src/db/connection.ts');
const { initSchema } = await import('../server/src/db/schema.ts');
initSchema();
const T = '2026-10-11T00:00:00.000Z';
const PID = 'ui-e6';
const BARE = 'ui-e6bare';
const PID_TITLE = 'T02041-区间条走查';
const BARE_TITLE = 'T02041-空项目';
const db = getDb();
const insProj = db.prepare('INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)');
insProj.run(PID, PID_TITLE, '', T, T);
insProj.run(BARE, BARE_TITLE, '', T, T);
const insPlan = db.prepare(
  `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
     progress, status, assignee, sort_order, created_at, updated_at, kind, complexity, req_ids, deps)
   VALUES (?, ?, ?, '', ?, ?, ?, 0, 'todo', '', ?, ?, ?, ?, ?, ?, ?)`,
);
// 已落库三点故意拉开量级：16 / 4 / 6 让「同一基数归一」在像素上可分辨
const seeds = [
  ['ms-a', PID, 'M-A 需求阶段', 6, 1, 'milestone', 4, null],
  ['r-wide', PID, '实施主线', 12, 2, 'normal', 5, JSON.stringify([{ id: 'ms-a', type: 'child' }])],
  ['r-mid', PID, '窄区间任务', 4, 3, 'normal', 1, JSON.stringify([{ id: 'ms-a', type: 'child' }])],
  ['ms-b', PID, 'M-B 实施阶段', 8, 4, 'milestone', 5, null],
  ['r-degen', PID, '三点收敛', 6, 5, 'normal', 2, JSON.stringify([{ id: 'ms-b', type: 'child' }])],
  ['r-sug', PID, '仅建议行', 5, 6, 'normal', 3, JSON.stringify([{ id: 'ms-b', type: 'child' }])],
];
for (const [id, proj, title, dur, sort, kind, cx, deps] of seeds) {
  insPlan.run(id, proj, title, '2026-10-12', '2026-10-12', dur, sort, T, T, kind, cx, null, deps);
}
const insEst = db.prepare(
  `INSERT INTO estimate_items (id, project_id, plan_id, phase, unit, optimistic, likely, pessimistic, source, note, created_at, updated_at)
   VALUES (?, ?, ?, ?, 'man_day', ?, ?, ?, ?, ?, ?, ?)`,
);
// T02299(4)：三点数值与来源在这里声明一次，下面的判据（归一基数、该被筛掉的行、各档百分比）
// 全部从这份夹具数据派生——断言里不再重抄 16 / 4 / 「两条 manual」这类夹具数字（同 T02315 口径）。
const estSeeds = [
  { id: 'es-wide', planId: 'r-wide', phase: 'impl', o: 4, m: 8, p: 16, source: 'manual', note: '最大 P 行（决定归一基数）' },
  { id: 'es-mid', planId: 'r-mid', phase: 'dev', o: 2, m: 3, p: 4, source: 'rule', note: '' },
  { id: 'es-degen', planId: 'r-degen', phase: 'test', o: 6, m: 6, p: 6, source: 'manual', note: 'O=M=P 的退化区间' },
];
for (const e of estSeeds) insEst.run(e.id, PID, e.planId, e.phase, e.o, e.m, e.p, e.source, e.note, T, T);
closeDb();

const titleOf = (planId) => seeds.find((s) => s[0] === planId)[2];
/**
 * 期望区间条集合 = 夹具三点齐全的明细行 + 里程碑参考行。
 * T02041 建门时只有前者（写死 4），后来 `EstimateDerive` 让里程碑行「只出参考值、不落库、不进 Σ」，
 * 于是参考行也画条 → 4 变成恒假判据。这里把两类分开算，并另设 U-04b：
 * 多出来的条必须逐条对上「里程碑 + 服务端 skip='milestone'」，条数不许无声增长。
 */
const EXP = {
  normals: seeds.filter((s) => s[1] === PID && s[5] === 'normal').map((s) => s[2]),
  milestones: seeds.filter((s) => s[1] === PID && s[5] === 'milestone').map((s) => s[2]),
  manual: estSeeds.filter((e) => e.source === 'manual').map((e) => titleOf(e.planId)),
  base: Math.max(...estSeeds.map((e) => e.p)),
};
EXP.bars = EXP.normals.length + EXP.milestones.length;
const ALL_TITLES = [...EXP.normals, ...EXP.milestones];
const planByTitle = new Map(seeds.map((s) => [s[2], s[0]]));
const maxSeed = estSeeds.find((e) => e.p === EXP.base);
/** 归一后的期望像素：值 ÷ 基数 × 容器宽（基数由夹具声明，U-16 再用面板自己的 tooltip 对账） */
const pct = (v) => v / EXP.base;

// ---------------- 2) 隔离服务 ----------------
const { resolveServerLauncher } = await import(pathToFileURL(join(ROOT, 'scripts/isolated-server-launcher.mts')).href);
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const server = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT, env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR }, stdio: ['ignore', 'pipe', 'pipe'],
});
console.log(`隔离实例启动器：${LAUNCHER.label}`);
const serverLog = [];
server.stdout?.on('data', (b) => serverLog.push(b.toString()));
server.stderr?.on('data', (b) => serverLog.push(b.toString()));

// ---------------- 3) headless Chrome + CDP ----------------
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--no-first-run', '--disable-gpu',
  '--force-device-scale-factor=1', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  `--user-data-dir=${CHROME_PROFILE}`, '--window-size=1920,1080', 'about:blank',
], { stdio: 'ignore' });

const killTree = (pid) => { try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } };
const bye = () => { killTree(chrome.pid); killTree(server.pid); };
process.on('exit', bye);
const sleepSync = (i) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300 * (i + 1)); };
const cleanup = () => {
  if (process.env.T02041_UI_KEEP) return;
  for (const dir of [DATA_DIR, CHROME_PROFILE]) {
    for (let i = 0; i < 8; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break; } catch { sleepSync(i); }
    }
  }
};
process.on('exit', cleanup);

let serverUp = false;
for (let i = 0; i < 90; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) { serverUp = true; break; } } catch { /* */ } await sleep(500); }
ok('U-00 隔离服务启动（临时端口 + 临时库，三条已落库估算 + 一条建议行）', serverUp);
if (!serverUp) { console.log('\n服务未起来，终止'); process.exit(1); }

let wsUrl = '';
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP}/json/list`);
    if (r.ok) { const t = (await r.json()).find((x) => x.type === 'page'); if (t) { wsUrl = t.webSocketDebuggerUrl; break; } }
  } catch { /* Chrome 还在起 */ }
  await sleep(400);
}
ok('U-01 Chrome CDP 通道就绪（系统 Chrome, headless=new）', !!wsUrl, wsUrl);
if (!wsUrl) process.exit(1);

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pend = new Map();
const netLog = [];
ws.onmessage = (ev2) => {
  const m = JSON.parse(ev2.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Network.responseReceived' && /\/api\/(estimates|plans)/.test(m.params.response.url)) {
    netLog.push({ t: Date.now(), url: m.params.response.url.replace(/^https?:\/\/[^/]+/, ''), status: m.params.response.status });
  }
};
const send = (method, params = {}) => new Promise((res) => { const i = ++seq; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
async function until(expr, ms = 20_000) {
  const t0 = Date.now();
  let v = null;
  while (Date.now() - t0 < ms) {
    v = await ev(expr);
    if (v) return v;
    await sleep(300);
  }
  return v;
}
async function setViewport(width, height = 1000) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
}
const shotFiles = [];
async function shot(name) {
  mkdirSync(SHOTS, { recursive: true });
  await send('Page.bringToFront');
  for (let i = 0; i < 3; i++) {
    const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const b64 = r.result && r.result.data;
    if (b64) {
      const file = join(SHOTS, `${name}.png`);
      writeFileSync(file, Buffer.from(b64, 'base64'));
      shotFiles.push(file);
      return file;
    }
    await sleep(700);
  }
  return '';
}

/**
 * 面板定位只用语义句柄：停靠式是 aside、覆盖式是 aria-modal 的 dialog，二者都必须带
 * 批量填充工具条（role=toolbar）且正文至少含两个夹具计划标题。产品文案（「估算面板」
 * 「实际预估人月」）一概不进行为腿，只留在 P 组字面腿。
 */
const FT_JSON = JSON.stringify(ALL_TITLES);
const PJ = `const FT=${FT_JSON};
  const p=()=>[...document.querySelectorAll('aside,[role="dialog"][aria-modal="true"]')].find(d=>d.querySelector('[role="toolbar"]')&&FT.filter(t=>d.innerText.includes(t)).length>=2);`;
/** 空项目没有夹具标题，面板身份退化为「含批量填充工具条的 aside/dialog」 */
const PJ_ANY = `const p=()=>[...document.querySelectorAll('aside,[role="dialog"][aria-modal="true"]')].find(d=>d.querySelector('[role="toolbar"]'));`;
/** 面板内求值统一套 IIFE（裸 return 交给 Runtime.evaluate 是语法错误，T02040 踩过） */
const PE = (strings, ...exprs) => {
  let body = strings[0];
  exprs.forEach((e, i) => { body += String(e) + strings[i + 1]; });
  return `(() => { ${PJ}${body} })()`;
};
/** 行容器结构句柄：1 个复选 + 3 个号码框 + 1 条区间图；按标题（夹具数据）定位，不碰输入框 aria-label */
const rowOf = (title) => `const rows=[...p().querySelectorAll('div')].filter(d=>d.querySelectorAll('input[type="checkbox"]').length===1&&d.querySelectorAll('input[type="number"]').length===3&&d.querySelectorAll('[role="img"]').length===1&&d.innerText.includes(${JSON.stringify(title)}));
  rows.sort((a,b)=>a.querySelectorAll('*').length-b.querySelectorAll('*').length); const row=rows[0]||null;`;
const ROW = (title, body) => `(() => { ${PJ}${rowOf(title)}${body} })()`;
/** 取色归一（CSS 变量可能是 #rrggbb 或 rgb()，两套主题各读一次） */
const toRgb = (s) => {
  const txt = String(s ?? '');
  const m = /rgba?\(([^)]+)\)/.exec(txt);
  if (m) return m[1].split(',').slice(0, 3).map((x) => Math.round(Number(x.trim()))).join(',');
  const h = /^#?([0-9a-f]{6})$/i.exec(txt.trim());
  if (!h) return txt;
  const n = parseInt(h[1], 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
};
/**
 * 「只看未复核」在面板里是工具条内唯一的复选框（行内复选在明细区，不在工具条）。
 * 点本体并把 checked 目标态回读出来，让「没点到」变成显式失败。
 */
const FILTER = (on) => `(() => { ${PJ}const c=p().querySelector('[role="toolbar"] input[type="checkbox"]'); if(!c) return 'nochk';
  if(c.checked!==${on}) c.click(); return c.checked===${on} ? 'ok' : 'stuck'; })()`;
const rest = async (path) => (await fetch(`${BASE}/api${path}`)).json();
const idle = async (tag) => {
  const v = await until(PE`const i=[...p().querySelectorAll('input[type="number"]')]; return i.length > 0 && i.every((x) => !x.disabled) ? 1 : '';`, 25_000);
  if (v !== 1) await diag(tag);
  return v;
};
async function diag(tag) {
  const panel = await ev(PE`return p()?p().innerText.slice(-500):'no-panel';`);
  const errs = await ev(`(window.__errs||[]).slice(-3).join(' | ')`);
  const srv = serverLog.join('').split('\n').filter((l) => /estimates|error|异常/i.test(l)).slice(-4).join(' ⏎ ');
  console.log(`  [DIAG ${tag}] 面板尾部: ${String(panel).replace(/\s*\n+\s*/g, ' ⏎ ').slice(-300)}`);
  console.log(`  [DIAG ${tag}] 页面报错: ${errs || '无'}`);
  console.log(`  [DIAG ${tag}] 服务日志: ${srv || '无匹配行'}`);
  console.log(`  [DIAG ${tag}] 接口请求: ${netLog.slice(-4).map((n) => `${n.status} ${n.url}`).join(' | ') || '无'}`);
}
/**
 * 读每行区间条的**实测像素**：容器宽 + 四条线的左偏移与宽度 + 取色后的背景色。
 * 结构句柄 = role=img 且恰有 4 个直接子元素（图表 SVG 也被排除）；行标题由「向上找到
 * 1 复选 + 3 号码框 + 1 区间图」的行容器回读，不读 aria-label 文案。
 */
const GEOF = `(() => { ${PJ}
  const rowOf=(el)=>{for(let r=el.parentElement;r&&r!==p();r=r.parentElement){
    if(r.querySelectorAll('input[type="checkbox"]').length===1&&r.querySelectorAll('input[type="number"]').length===3&&r.querySelectorAll('[role="img"]').length===1)return r;}return null;};
  const out=[];
  for (const el of p().querySelectorAll('[role="img"]')) {
    if (el.tagName.toLowerCase()==='svg') continue;
    const spans=[...el.children]; if (spans.length!==4) continue;
    const c=el.getBoundingClientRect(); if (c.width<=0) continue;
    const row=rowOf(el); const txt=row?row.innerText:'';
    const kids=spans.map((k)=>{const r=k.getBoundingClientRect();
      return {left:Math.round((r.left-c.left)*100)/100,width:Math.round(r.width*100)/100,rgb:getComputedStyle(k).backgroundColor};});
    out.push({rowTitle:${FT_JSON}.find((t)=>txt.includes(t))||'', label:el.getAttribute('aria-label')||'',
      boxW:Math.round(c.width*100)/100, kids, title:el.getAttribute('title')||'',
      rowDisabled:row?[...row.querySelectorAll('input[type="number"]')].every((x)=>x.disabled):null});
  }
  return out; })()`;
const geoWait = (cond) => `(() => { const out=${GEOF}; return (${cond}) ? out : ''; })()`;
const byTitle = (rows, name) => (Array.isArray(rows) ? rows : []).find((r) => r.rowTitle === name);
/** 期望左偏移（px）：值 ÷ 基数 × 容器宽；容差 1.2px 吸收 sub-pixel 布局 */
const near = (a, b, tol = 1.2) => Math.abs(a - b) <= tol;
const numsIn = (s) => (String(s).match(/\d+(?:\.\d+)?/g) || []).map(Number);
const hasNum = (s, n) => numsIn(s).some((x) => Math.abs(x - Number(n)) <= 0.011);

const pageReady = `document.readyState==='complete' && !!document.querySelector('#root') && document.querySelector('#root').children.length>0 && (window.__errs||[]).length===0`;
const navSeam = `(() => { globalThis.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'plan' } })); return 1; })()`;
/** reload 代际：旧文档带 __gateReload=1，新文档没有——防「旧页先满足 pageReady」的假绿 */
const reloadFresh = async () => {
  await ev(`window.__gateReload = 1; return 1;`);
  const r = await send('Page.reload');
  const fresh = await until(`window.__gateReload === undefined && (${pageReady}) ? 1 : ''`, 25_000);
  return { fresh: fresh === 1, error: r.error ?? null };
};

await send('Page.enable');
await send('Network.enable');
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try {
    window.__errs = [];
    window.addEventListener('error', (e) => window.__errs.push(String(e.message)));
    if (sessionStorage.getItem('plan.projectId') == null) sessionStorage.setItem('plan.projectId', JSON.stringify(${JSON.stringify(PID)}));
    if (sessionStorage.getItem('plan.viewMode') == null) sessionStorage.setItem('plan.viewMode', JSON.stringify('timeline'));
    if (sessionStorage.getItem('plan.estimatePanelOpen') == null) sessionStorage.setItem('plan.estimatePanelOpen', JSON.stringify(true));
    localStorage.setItem('mtask.projectGuide.seen', '1');
    ['tasks', 'aitools', 'prompts', 'req', 'plan', 'report', 'history', 'queue', 'exec-sessions', 'settings']
      .forEach((t) => localStorage.setItem('mtask.guide.seen.' + t, '1'));
  } catch (e) {}`,
});
await send('Page.navigate', { url: `${BASE}/?m=0` });
ok('U-02 页面加载完成（桌面 UI，启动无 JS 报错）', await until(pageReady), '页面未就绪');
await ev(navSeam);
await setViewport(1920, 1000);
const panelUp = await until(PE`return !!p();`, 25_000);
ok('U-03 估算面板已打开（会话开键种入 + 导航 seam，无任何产品文案点击）', panelUp === true, '面板未出现');
EV.nav = true;
EV.panel = await ev(PE`const tb=p().querySelector('[role="toolbar"]');
  return {opened:true, dockRoot:p().tagName, toolbar:!!tb, toolbarCheckbox:!!tb?.querySelector('input[type="checkbox"]'), toolbarButtons:tb?tb.querySelectorAll('button').length:0};`);
// 服务端那一份数据先取到手：建议行的三点（U-11/U-31）与 E 竖线（U-08）都以它为期望值，
// 门里不重算 PERT 公式（零第二份算式），也不写死 3.5 / 5.5 / 52⁄6 这类「当时实测出来的数」。
const est0 = await rest(`/estimates?projectId=${PID}`);
const derive0 = await fetch(`${BASE}/api/estimates/derive`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ projectId: PID, dryRun: true, scope: 'all' }),
}).then((r) => r.json());
const dvByPlan = new Map((derive0.items || []).map((i) => [i.planId, i]));
const eByPlan = new Map((est0.summary?.rowRatios || []).map((r) => [r.key, r.expected]));
const persistedByPlan = new Map(estSeeds.map((e) => [e.planId, { o: e.o, p: e.p }]));
const ptsOf = (planId) => persistedByPlan.get(planId)
  ?? (dvByPlan.get(planId) ? { o: dvByPlan.get(planId).optimistic, p: dvByPlan.get(planId).pessimistic } : null);
const accentVars = await ev(PE`const cs=getComputedStyle(p());return {accent:cs.getPropertyValue('--accent').trim(),muted:cs.getPropertyValue('--text-muted').trim()};`);
const geoRaw = await until(geoWait(`out.length===${EXP.bars} && out.every((x)=>x.boxW>0&&x.rowTitle)`), 25_000);
// geo0 恒为数组：拿不满期望条数时让后面每条断言各自红，而不是 undefined 直接把门打断在 U-04 之后
const geo0 = Array.isArray(geoRaw) ? geoRaw : (await ev(GEOF) || []);
ok('U-04 夹具里三点齐全的明细行都画出区间条（含未落库的建议行），且条数不多不少',
  EXP.normals.every((t) => !!byTitle(geo0, t)) && geo0.length === EXP.bars && geo0.every((g) => !!g.rowTitle),
  { 期望: EXP.bars, 实得: geo0.length, 缺行: EXP.normals.filter((t) => !byTitle(geo0, t)), 行标题: geo0.map((g) => g.rowTitle) });
ok('U-04b 夹具明细之外的区间条只能是里程碑参考行：线色走 muted 且服务端 skip=milestone（§4.6 红线一的视觉层）',
  geo0.every((g) => {
    if (EXP.normals.includes(g.rowTitle)) return true;
    const ms = EXP.milestones.find((t) => t === g.rowTitle);
    if (!ms) return false;
    return toRgb(g.kids[0].rgb) === toRgb(accentVars.muted)
      && dvByPlan.get(planByTitle.get(ms))?.skip === 'milestone';
  }) && EXP.milestones.every((t) => !!byTitle(geo0, t)),
  { 里程碑条: geo0.filter((g) => EXP.milestones.includes(g.rowTitle)).map((g) => ({ row: g.rowTitle, rgb: g.kids[0].rgb, skip: dvByPlan.get(planByTitle.get(g.rowTitle))?.skip })) });
EV.bars = {};
EV.bars.msBarsOk = geo0.filter((g) => EXP.milestones.includes(g.rowTitle)).length === EXP.milestones.length
  && geo0.filter((g) => EXP.milestones.includes(g.rowTitle)).every((g) => toRgb(g.kids[0].rgb) === toRgb(accentVars.muted)
    && dvByPlan.get(planByTitle.get(g.rowTitle))?.skip === 'milestone');

console.log(`\n=== 归一几何：像素位置 = 服务端值 ÷ 同一基数（max P=${EXP.base}） ===`);
const W = geo0.length ? Math.max(...geo0.map((g) => g.boxW)) : NaN;
ok('U-05 各行共用同一容器宽（行间长度可比的前提）',
  geo0.length === EXP.bars && geo0.every((g) => near(g.boxW, W, 0.6)), geo0.map((g) => g.boxW));
const wide = byTitle(geo0, titleOf(maxSeed.planId));
const mid = byTitle(geo0, titleOf('r-mid'));
const degen = byTitle(geo0, titleOf('r-degen'));
const sug = byTitle(geo0, titleOf('r-sug'));
const midSeed = estSeeds.find((e) => e.planId === 'r-mid');
const sugDv = dvByPlan.get('r-sug');
const eOf = (planId) => eByPlan.get(planId);
ok('U-06 每行四条线：横线 + O 端帽 + P 端帽 + E 竖线（顺序与渲染一致）',
  geo0.every((g) => g.kids.length === 4 && g.kids[0].width > 0), geo0.map((g) => g.kids.length));
ok(`U-07 最大 P 行（P=${EXP.base}）的 P 端帽贴满容器右边缘`, wide && near(wide.kids[2].left + 1, W, 1.5), { left: wide?.kids[2].left, W });
ok(`U-08 ${titleOf(maxSeed.planId)}：O 端帽=${maxSeed.o}/${EXP.base}、E 竖线用服务端 rowRatios 那一份 E（门里不重算 PERT）`,
  !!wide && eOf(maxSeed.planId) != null && near(wide.kids[1].left, W * pct(maxSeed.o)) && near(wide.kids[3].left, W * pct(eOf(maxSeed.planId))),
  { o: wide?.kids[1].left, expectO: W * pct(maxSeed.o), e: wide?.kids[3].left, expectE: W * pct(eOf(maxSeed.planId)), serverE: eOf(maxSeed.planId) });
ok(`U-09 ${titleOf('r-mid')}：O ${midSeed.o}/${EXP.base}、P ${midSeed.p}/${EXP.base}、E 取服务端 rowRatios`,
  !!mid && near(mid.kids[1].left, W * pct(midSeed.o)) && near(mid.kids[2].left, W * pct(midSeed.p)) && near(mid.kids[3].left, W * pct(eOf('r-mid'))),
  mid && { o: mid.kids[1].left, p: mid.kids[2].left, e: mid.kids[3].left, serverE: eOf('r-mid') });
ok('U-10 三点收敛行：O=P 时两端帽重合，横线只剩最小可见宽度（不为零所以看得见）',
  degen && near(degen.kids[1].left, degen.kids[2].left, 0.6) && degen.kids[0].width >= 1 && degen.kids[0].width <= 4,
  degen && { rail: degen.kids[0].width, lo: degen.kids[1].left, hi: degen.kids[2].left });
ok(`U-11 建议行（未落库）按服务端推导响应的那份三点画：O ${sugDv?.optimistic}/${EXP.base}、P ${sugDv?.pessimistic}/${EXP.base}`,
  !!sug && sugDv != null && near(sug.kids[1].left, W * pct(sugDv.optimistic)) && near(sug.kids[2].left, W * pct(sugDv.pessimistic)),
  sug && { o: sug.kids[1].left, p: sug.kids[2].left, server: { o: sugDv?.optimistic, p: sugDv?.pessimistic } });
ok('U-12 每行 E 竖线不越出两端帽（几何层不重排三点）',
  geo0.every((g) => g.kids[1].left - 1 <= g.kids[3].left && g.kids[3].left <= g.kids[2].left + 1),
  geo0.map((g) => [g.kids[1].left, g.kids[3].left, g.kids[2].left]));

await shot('00-whisker-base16');

console.log('\n=== 语义配色与可访问性 ===');
ok('U-13 已落库行的线色 = 解析后的 --accent（不是硬编码色值）',
  wide && toRgb(wide.kids[0].rgb) === toRgb(accentVars.accent), { measured: wide?.kids[0].rgb, accent: accentVars.accent });
ok('U-14 建议行的线色 = --text-muted，且与 --accent 不同（灰显口径延伸到区间条）',
  sug && toRgb(sug.kids[0].rgb) === toRgb(accentVars.muted) && toRgb(accentVars.muted) !== toRgb(accentVars.accent),
  { measured: sug?.kids[0].rgb, muted: accentVars.muted, accent: accentVars.accent });
EV.bars.allLabelTitles = geo0.length === EXP.bars && geo0.every((g) => !!g.rowTitle && g.label.includes(g.rowTitle));
ok('U-15 每条区间条的 accessible name 都带上自己的计划标题（屏幕阅读器能分辨哪条属于哪行）',
  EV.bars.allLabelTitles, geo0.map((g) => g.label));
// tooltip 行为腿只验「读数与响应同源」：数字集合里出现该行服务端 O/P 与归一基数，不依赖文案模板
EV.bars.tipPoints = geo0.length === EXP.bars && geo0.every((g) => {
  const pts = ptsOf(planByTitle.get(g.rowTitle));
  return pts && hasNum(g.title, pts.o) && hasNum(g.title, pts.p);
});
ok('U-16 tooltip 逐行给出该行服务端的 O/P 两点（读者不必猜那条线是什么）',
  EV.bars.tipPoints, geo0.map((g) => [g.rowTitle, g.title.slice(0, 50)]));
EV.bars.tipBaseAll = geo0.length === EXP.bars && geo0.every((g) => hasNum(g.title, EXP.base));
ok('U-16b 每条区间条声明的归一基数都等于夹具最大 P（基数只有一份，行内不各算各的）',
  EV.bars.tipBaseAll, geo0.map((g) => [g.rowTitle, numsIn(g.title)]));
const msHeaders = [];
for (const msTitle of EXP.milestones) {
  msHeaders.push(await ev(PE`const b=[...p().querySelectorAll('button')].find(x=>x.innerText.includes(${JSON.stringify(msTitle)})&&!x.querySelector('input'));
    return b ? {found:true, innerImgs:b.querySelectorAll('[role="img"]').length} : null;`));
}
EV.bars.msHeaderOk = msHeaders.length === EXP.milestones.length
  && msHeaders.every((h) => h && h.found && h.innerImgs === 0);
ok('U-17 里程碑组头不画区间条（§4.6 红线一在视觉层同样生效；组头是原生 button）',
  EV.bars.msHeaderOk, msHeaders);
const legend = await ev(PE`const d=[...p().querySelectorAll('div')].find(x=>x.children.length===2
    && x.children[0].getAttribute('aria-hidden')!==null
    && x.children[0].querySelectorAll(':scope > span').length===5
    && x.children[1].tagName==='SPAN');
  return d ? {swatch:5, text:d.innerText, height:d.getBoundingClientRect().height} : null;`);
EV.bars.legendOk = !!legend && legend.swatch === 5 && String(legend.text).trim().length > 0;
EV.bars.legendExplains = !!legend && /O/.test(legend.text) && /P/.test(legend.text) && /E/.test(legend.text);
ok('U-18 图例存在：五段示意笔画 + 一段解释文字（图形不是没人能自证含义的装饰）',
  EV.bars.legendOk, legend);
EV.bars.sugOk = !!sug && toRgb(sug.kids[0].rgb) === toRgb(accentVars.muted)
  && (est0.items || []).every((i) => i.plan_id !== 'r-sug');
ok('U-18b 建议行（未落库）灰显且库里确实没有它——「未落库」不是文案声明而是可查事实',
  EV.bars.sugOk, { items: (est0.items || []).map((i) => i.plan_id) });

console.log('\n=== 筛选不改刻度 / 改值后条长跟变 ===');
const ratiosBefore = geo0.map((g) => ({ label: g.label, lo: g.kids[1].left / g.boxW, hi: g.kids[2].left / g.boxW }));
const t19 = await ev(FILTER(true));
await idle('U-19');
const geoFiltered = await ev(GEOF);
// 期望筛后条集合 = 全部条 −（夹具里 source=manual 的那几行）；里程碑参考行不是 manual，按规则留下
const expKept = EXP.bars - EXP.manual.length;
ok(`U-19 「只看未复核」筛掉 ${EXP.manual.length} 条 manual 行（区间条剩 ${expKept} 条，被筛掉的正是 manual 那几行）`,
  t19 === 'ok' && Array.isArray(geoFiltered) && geoFiltered.length === expKept
  && EXP.manual.every((t) => !byTitle(geoFiltered, t))
  && geoFiltered.every((g) => geo0.some((x) => x.label === g.label)),
  { click: t19, before: geo0.length, after: geoFiltered?.length, manual: EXP.manual, labels: (geoFiltered || []).map((g) => g.rowTitle) });
const sameRatio = (geoFiltered || []).every((g) => {
  const b = ratiosBefore.find((x) => x.label === g.label);
  return b && near(b.lo, g.kids[1].left / g.boxW, 0.005) && near(b.hi, g.kids[2].left / g.boxW, 0.005);
});
ok('U-20 筛选后仍可见行的归一比例分毫未变（基数取全部明细行，不是筛后可见行）', sameRatio,
  { before: ratiosBefore, after: (geoFiltered || []).map((g) => [g.rowTitle, g.kids[1].left / g.boxW, g.kids[2].left / g.boxW]) });
EV.filter = { ok: t19 === 'ok' && Array.isArray(geoFiltered) && geoFiltered.length === expKept
  && EXP.manual.every((t) => !byTitle(geoFiltered, t)) && sameRatio };
const t21 = await ev(FILTER(false));
await idle('U-21');
const geoBack = await until(geoWait(`out.length===${EXP.bars}`), 25_000);
ok(`U-21 关掉筛选后 ${EXP.bars} 条区间条全部回来（筛选态不破坏几何）`,
  t21 === 'ok' && Array.isArray(geoBack) && geoBack.length === EXP.bars, { click: t21, n: geoBack?.length });

// 行内改 P：窄区间任务 P 由夹具值改成 NEWP，基数应易主，两条线的长度关系整体重排。
// 输入框不按 aria-label 找：行容器内第 3 个 number 框就是 P（O/M/P 顺序在 U-24 由服务端字段反证）。
const NEWP = 60;
const midTitle = titleOf('r-mid');
const wideTitle = titleOf(maxSeed.planId);
const setP = async (title, value) => {
  const focused = await ev(ROW(title, `const el=row?row.querySelectorAll('input[type="number"]')[2]:null; if(!el) return 'missing'; el.focus(); return 'focused';`));
  if (focused !== 'focused') return focused;
  await sleep(150);
  const typed = await ev(ROW(title, `const el=row?row.querySelectorAll('input[type="number"]')[2]:null; if(!el) return 'missing';
    const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
    d.set.call(el,${JSON.stringify(String(value))}); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value;`));
  await sleep(200);
  await ev(ROW(title, `const el=row?row.querySelectorAll('input[type="number"]')[2]:null; if(!el) return 'missing';
    el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return 1;`));
  return typed;
};
await setP(midTitle, NEWP);
const after = await until(geoWait(`out.length===${EXP.bars} && (()=>{ const m=out.find(g=>g.rowTitle===${JSON.stringify(midTitle)}); const w=Math.max(...out.map(g=>g.kids[2].left)); return m&&w>0&&Math.abs(m.kids[2].left-w)<=1.5; })()`), 25_000);
const afterW = Array.isArray(after) && after.length ? Math.max(...after.map((g) => g.boxW)) : NaN;
ok(`U-22 改值后区间条按新基数重画：${midTitle} 的新 P=${NEWP} 成为基数并贴满右边缘`,
  Array.isArray(after) && near(byTitle(after, midTitle)?.kids[2].left, afterW, 1.5),
  after && { w: afterW, hi: byTitle(after, midTitle)?.kids[2].left });
ok(`U-23 原最大行（P=${EXP.base}）相对缩水到 ${EXP.base}/${NEWP}——同屏长度仍可互比`,
  Array.isArray(after) && near(byTitle(after, wideTitle)?.kids[2].left, afterW * (EXP.base / NEWP), 1.5),
  after && { hi: byTitle(after, wideTitle)?.kids[2].left, expect: afterW * (EXP.base / NEWP) });
const itemP = await rest(`/estimates?projectId=${PID}`);
const midItem = (itemP.items || []).find((i) => i.plan_id === 'r-mid');
EV.edit = { structuralOk: !!midItem && midItem.pessimistic === NEWP && midItem.source === 'manual', midItem };
ok(`U-24 改的是真落库值（服务端 pessimistic=${NEWP}，不是内存态），且该行转为 manual`,
  EV.edit.structuralOk, midItem);
await shot('01-whisker-remeasured');

// 还原，避免夹具状态影响后续断言
await setP(midTitle, midSeed.p);
await until(geoWait(`out.length===${EXP.bars} && (()=>{ const w=Math.max(...out.map(g=>g.kids[2].left)); const m=out.find(g=>g.rowTitle===${JSON.stringify(wideTitle)}); return m&&Math.abs(m.kids[2].left-w)<=1.5; })()`), 25_000);
await reloadFresh();
await ev(navSeam);
const panelBack = await until(PE`return !!p();`, 25_000);
const geoReload = panelBack
  ? await until(geoWait(`out.length===${EXP.bars} && (()=>{ const w=Math.max(...out.map(g=>g.kids[2].left)); const m=out.find(g=>g.rowTitle===${JSON.stringify(wideTitle)}); return m&&Math.abs(m.kids[2].left-w)<=1.5; })()`), 25_000)
  : null;
ok(`U-25 刷新后区间条仍在且基数回到 ${EXP.base}（写路径真落库，几何无本地缓存）`,
  Array.isArray(geoReload) && geoReload.length === EXP.bars,
  { panel: !!panelBack, n: geoReload?.length, title: String(geoReload?.[0]?.title || '').slice(0, 90) });
EV.reload = { ok: Array.isArray(geoReload) && geoReload.length === EXP.bars };

console.log('\n=== 空项目不画图例 / 三档视口 / 覆盖式 / 明暗双验 ===');
EV.viewports = [];
ok('U-26 三档视口（1920/1440/1200）面板内无横向滚动且区间条照常渲染', await (async () => {
  let allOk = true;
  for (const w of [1920, 1440, 1200]) {
    await setViewport(w, 1000);
    const r = await ev(PE`const s=p().scrollWidth - p().clientWidth;
      return { w:${w}, overflow: s > 1, n: [...p().querySelectorAll('[role="img"]')].filter(e=>e.tagName.toLowerCase()!=='svg'&&e.children.length===4).length };`);
    EV.viewports.push(r);
    if (!r || r.overflow || r.n !== EXP.bars) allOk = false;
  }
  return allOk;
})());
await setViewport(1100, 1000);
const overlay = await until(`(() => {
  const d=[...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find(x=>x.querySelector('[role="toolbar"]') && ${FT_JSON}.filter(t=>x.innerText.includes(t)).length>=2);
  return d ? {n:[...d.querySelectorAll('[role="img"]')].filter(e=>e.tagName.toLowerCase()!=='svg'&&e.children.length===4).length, overflow:d.scrollWidth-d.clientWidth>1} : '';
})()`, 15_000);
ok('U-27 <1200px 转覆盖式后区间条仍渲染、无横向滚动（§10-13 挤压复验）',
  !!overlay && overlay.n === EXP.bars && !overlay.overflow, overlay);
await shot('02-whisker-overlay-1100');
await setViewport(1920, 1000);
await ev(PE`document.documentElement.dataset.theme='dark';return 1;`);
await sleep(500);
const darkVars = await ev(PE`const cs=getComputedStyle(p());return {accent:cs.getPropertyValue('--accent').trim(),muted:cs.getPropertyValue('--text-muted').trim()};`);
const geoDark = await ev(GEOF);
EV.dark = { ok: !!darkVars && toRgb(byTitle(geoDark, wideTitle)?.kids[0].rgb) === toRgb(darkVars.accent), n: geoDark?.length };
ok('U-28 暗色主题下线色仍等于当套 --accent（配色跟变量，不跟字面量）',
  EV.dark.ok,
  { measured: toRgb(byTitle(geoDark, wideTitle)?.kids[0].rgb), accent: toRgb(darkVars.accent) });
ok('U-29 主题切换过程中没有把面板切崩（区间条数量不变、页面无 JS 报错）',
  geoDark?.length === EXP.bars && (await ev(`(window.__errs||[]).length`)) === 0,
  { n: geoDark?.length, 期望: EXP.bars, errs: await ev(`(window.__errs||[]).slice(-2)`) });
await shot('03-whisker-dark');
await ev(PE`document.documentElement.dataset.theme='light';return 1;`);

console.log('\n=== 数据同源与运维口径 ===');
const estReqs = netLog.filter((n) => /\/api\/estimates/.test(n.url));
EV.net = estReqs.length > 0 && estReqs.every((n) => n.status === 200);
ok('U-30 区间条没有第二个数据源：面板对 /api/estimates* 的请求全部 200',
  EV.net, estReqs.slice(-6));
const dv = await fetch(`${BASE}/api/estimates/derive`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ projectId: PID, dryRun: true, scope: 'all' }),
}).then((r) => r.json());
// T02299(4)：原判据把当时实测出来的 3.5 / 5.5 写死在断言里——推导档一改即恒红。
// 改为「面板画出来的位置 == 这份响应里的三点 ÷ 基数」：同源关系成立，数值随服务端动。
const sugNow = (dv.items || []).find((i) => i.planId === 'r-sug');
EV.sugSameSource = !!sug && !!sugNow && sugNow.optimistic != null && sugNow.pessimistic != null
  && near(sug.kids[1].left, W * (sugNow.optimistic / EXP.base), 1.2)
  && near(sug.kids[2].left, W * (sugNow.pessimistic / EXP.base), 1.2);
ok('U-31 建议行的区间值与服务端推导响应同源（画出的 O/P 位置就是响应里那两份值，门内不预设具体数）',
  EV.sugSameSource,
  { server: sugNow && { o: sugNow.optimistic, p: sugNow.pessimistic, skip: sugNow.skip }, drawn: sug && [sug.kids[1].left, sug.kids[2].left], W, base: EXP.base });
EV.logClean = !/estimates.*(500|异常|Error)/i.test(serverLog.join(''));
ok('U-32 服务日志无 estimates/几何相关异常',
  EV.logClean, serverLog.join('').split('\n').filter((l) => /estimates/i.test(l)).slice(-3));

// 空项目：图例解释的是一个当前并不存在的图形 —— 一条区间都画不出来时不该渲染图例。
// 切项目走真实项目选择器（展开按钮的唯一结构性特征是 aria-haspopup=listbox；两侧项目名都是夹具数据）：
// 选中空项目 → PlanPage 的 projectId 变更 → 面板按新项目重取数，不是门里手改存储绕过应用。
const pickTrigger = await ev(`(() => {
  const b=[...document.querySelectorAll('button[aria-haspopup="listbox"]')].find((x)=>x.innerText.includes(${JSON.stringify(PID_TITLE)}));
  if(!b) return 'no-trigger'; b.click(); return 'opened'; })()`);
const pickRow = await until(`(() => {
  const row=[...document.querySelectorAll('[role="button"][aria-pressed]')].find((x)=>x.innerText.includes(${JSON.stringify(BARE_TITLE)}));
  if(!row) return ''; row.click(); return 'clicked'; })()`, 10_000);
const switchedToBare = await until(`sessionStorage.getItem('plan.projectId') === JSON.stringify(${JSON.stringify(BARE)}) ? 1 : ''`, 15_000);
const emptyProbe = `(() => { ${PJ_ANY} if(!p()) return null;
  const bars=[...p().querySelectorAll('[role="img"]')].filter(e=>e.tagName.toLowerCase()!=='svg'&&e.children.length===4);
  const legend=[...p().querySelectorAll('div')].find(x=>x.children.length===2&&x.children[0].getAttribute('aria-hidden')!==null&&x.children[0].querySelectorAll(':scope > span').length===5&&x.children[1].tagName==='SPAN');
  return {bars:bars.length, legend:!!legend, toolbar:!!p().querySelector('[role="toolbar"]'),
    ss:sessionStorage.getItem('plan.projectId'), panelText:p().innerText.slice(0,200)}; })()`;
const emptyReady = await until(`(() => { const r=${emptyProbe}; return r && r.toolbar && r.bars===0 && !r.legend ? 1 : ''; })()`, 25_000);
const bare = await ev(emptyProbe);
EV.empty = { ok: pickTrigger === 'opened' && pickRow === 'clicked' && switchedToBare === 1 && emptyReady === 1
  && !!bare && bare.toolbar && bare.bars === 0 && !bare.legend, pick: { pickTrigger, pickRow, switchedToBare, emptyReady }, bare };
if (!EV.empty.ok) console.log(`  [DIAG U-33] ${JSON.stringify({ bare, pick: EV.empty.pick, net: netLog.slice(-8).map((n) => `${n.status} ${n.url}`) }).slice(0, 1200)}`);
ok('U-33 空项目：项目选择器切到空项目后面板照常打开、0 条区间、不画图例（图例不解释不存在的图形）',
  EV.empty.ok, bare);
// 切换是应用自己写回的会话态（useStorageState 落盘），刷新也必须还在——不靠门里手改 sessionStorage。
const emptyReload = await reloadFresh();
await ev(navSeam);
const bareAfterReload = await until(`(() => { const r=${emptyProbe}; return r && r.toolbar && r.bars===0 && !r.legend ? 1 : ''; })()`, 25_000);
EV.empty.persisted = emptyReload.fresh && bareAfterReload === 1;
ok('U-33b 空项目选择刷新后保持（应用写回的会话态跨 reload 生效，仍 0 条区间、无图例）',
  EV.empty.persisted, { reload: emptyReload, afterReload: bareAfterReload });
await shot('04-empty');

// ---------------- 4) P 组：文案/标识符锚配对（行为失守⇒FAIL；行为在而锚失配⇒FAIL 交人判定） ----------------
console.log('\n=== P 组：文案/标识符锚配对（行为失守⇒FAIL；行为在而锚失配⇒FAIL 交人判定） ===');
const ANCHORS = {
  navSeam: { needle: 'mtaskNavigate', src: APP_HEAD },
  panelKey: { needle: 'plan.estimatePanelOpen', src: PLAN_HEAD },
  panelAria: { needle: 'aria-label="估算面板"', src: PLAN_HEAD },
  toolbarAria: { needle: 'aria-label="估算批量填充工具条"', src: EP_HEAD },
  barLabel: { needle: 'aria-label={`区间条 ', src: EP_HEAD },
  barTipPoints: { needle: 'O ${num(row.optimistic)} —— P ${num(row.pessimistic)}', src: EP_HEAD },
  barTipBase: { needle: '横向刻度按明细行最大 P=${num(geom.scaleMax)} 归一', src: EP_HEAD },
  sugNote: { needle: '推导建议值，未落库、不进 Σ', src: EP_HEAD },
  msNote: { needle: '不进 Σ', src: EP_HEAD },
  filterLabel: { needle: '只看未复核', src: EP_HEAD },
  legendAria: { needle: 'aria-label="区间条图例"', src: EP_HEAD },
  legendMarkers: { needle: '端点 O / P', src: EP_HEAD },
  legendFull: { needle: '区间条：端点 O / P，粗竖线 E', src: EP_HEAD },
  pointO: { needle: '乐观 O', src: EP_HEAD },
  pointM: { needle: '最可能 M', src: EP_HEAD },
  pointP: { needle: '悲观 P', src: EP_HEAD },
  emptyLegendGate: { needle: 'whiskerLegendShown(whisker.size)', src: EP_HEAD },
};
const P_SPECS = [
  { id: 'P-01', anchors: ['navSeam'], behavior: () => EV.nav === true },
  { id: 'P-02', anchors: ['panelKey'], behavior: () => EV.panel?.opened === true },
  { id: 'P-03', anchors: ['panelAria'], behavior: () => EV.panel?.dockRoot === 'ASIDE' },
  { id: 'P-04', anchors: ['toolbarAria'], behavior: () => EV.panel?.toolbar === true && EV.panel?.toolbarCheckbox === true && EV.panel?.toolbarButtons > 0 },
  { id: 'P-05', anchors: ['barLabel'], behavior: () => EV.bars?.allLabelTitles === true },
  { id: 'P-06', anchors: ['barTipPoints'], behavior: () => EV.bars?.tipPoints === true },
  { id: 'P-07', anchors: ['barTipBase'], behavior: () => EV.bars?.tipBaseAll === true },
  { id: 'P-08', anchors: ['sugNote'], behavior: () => EV.bars?.sugOk === true },
  { id: 'P-09', anchors: ['msNote'], behavior: () => EV.bars?.msHeaderOk === true && EV.bars?.msBarsOk === true },
  { id: 'P-10', anchors: ['filterLabel'], behavior: () => EV.filter?.ok === true },
  { id: 'P-11', anchors: ['legendAria'], behavior: () => EV.bars?.legendOk === true },
  { id: 'P-12', anchors: ['legendMarkers', 'legendFull'], behavior: () => EV.bars?.legendExplains === true },
  { id: 'P-13', anchors: ['pointO', 'pointM', 'pointP'], behavior: () => EV.edit?.structuralOk === true },
  { id: 'P-14', anchors: ['emptyLegendGate'], behavior: () => EV.empty?.ok === true },
];
const literalOf = (spec, override) => spec.anchors.every((k) => {
  const a = ANCHORS[k];
  return (override === undefined ? a.src : override).includes(a.needle);
});
const P_LABEL = {
  'P-01': '导航 seam 真的把应用切到计划页并打开面板（字面腿：App 监听器名）',
  'P-02': '面板开合会话键种入后抽屉真的打开（字面腿：PlanPage 会话键名）',
  'P-03': '停靠式面板根是 aside 且带工具条（字面腿：PlanPage aria-label）',
  'P-04': '批量工具条存在，含筛选复选框与至少一个批量按钮（字面腿：工具条 aria-label）',
  'P-05': '区间条的 accessible name 带上行标题（字面腿：aria-label 模板）',
  'P-06': 'tooltip 逐行写出行服务端 O/P（字面腿：三点模板）',
  'P-07': 'tooltip 声明归一基数=夹具最大 P（字面腿：基数模板）',
  'P-08': '未落库建议行灰显且库里无该行（字面腿：建议值说明）',
  'P-09': '里程碑组头无图形、参考条走 muted/skip=milestone（字面腿：组头说明）',
  'P-10': '筛选真的隐藏 manual 行且不改归一比例（字面腿：筛选标签）',
  'P-11': '图例由五段示意笔画 + 解释文字构成（字面腿：图例 aria-label）',
  'P-12': '图例解释 O/P/E 三件套（字面腿：两段图例文案）',
  'P-13': '行内第 3 个号码框就是服务端 pessimistic 字段（字面腿：O/M/P 标签）',
  'P-14': '空项目 0 条区间且不画图例（字面腿：图例渲染守卫函数）',
};
for (const spec of P_SPECS) {
  okPair(ok, `${spec.id} ${P_LABEL[spec.id]}`, spec.behavior, () => literalOf(spec), () => ({ spec: spec.id, anchors: spec.anchors }));
}

// ---------------- 5) N 组：负对照 ----------------
console.log('\n=== N 组：负对照 ===');
const withEV = (obj, fn) => { const saved = EV; EV = obj; try { return fn(); } finally { EV = saved; } };
ok('N-01 空源码探针：14 条字面腿喂空串后全部为假（没有不承重的正则）',
  P_SPECS.every((s) => literalOf(s, '') === false));
ok('N-01b HEAD 文本在场性：17 个锚点在已提交树里逐字命中',
  Object.values(ANCHORS).every((a) => a.src.includes(a.needle)) && Object.values(ANCHORS).every((a) => a.src.length > 0),
  Object.entries(ANCHORS).filter(([, a]) => !a.src.includes(a.needle)).map(([k]) => k));
ok('N-02 敏感度探针：抽干运行期实测料后 14 条行为腿全部转假——行为腿确实在读实测，不是恒真',
  P_SPECS.every((s) => withEV({}, s.behavior) === false),
  P_SPECS.filter((s) => withEV({}, s.behavior) !== false).map((s) => s.id));
ok('N-02b 还原实证：实测料回填后同一批行为腿重新为真（N-02 的红不是恒红）',
  P_SPECS.every((s) => s.behavior() === true),
  P_SPECS.filter((s) => s.behavior() !== true).map((s) => s.id));
const renamed = [];
for (const [key, a] of Object.entries(ANCHORS)) {
  const tampered = a.src.split(a.needle).join('⟪改名⟫');
  const spec = P_SPECS.find((s) => s.anchors.includes(key));
  renamed.push({ key, spec: spec?.id, selfProof: tampered !== a.src, gone: !tampered.includes(a.needle), literalFalse: spec ? literalOf(spec, tampered) === false : false });
}
ok('N-03 改名模拟：17 个锚点逐个从 HEAD 副本中抹掉后，字面判据各自转假（且每条自证 tampered !== original）',
  renamed.every((r) => r.selfProof && r.gone && r.literalFalse && r.spec), renamed.filter((r) => !(r.selfProof && r.gone && r.literalFalse && r.spec)));
{
  const rec = [];
  const recOk = (name, cond, extra) => rec.push({ name, cond, extra });
  okPair(recOk, '契约-行为假', () => false, () => true);
  okPair(recOk, '契约-字面假', () => true, () => false);
  okPair(recOk, '契约-双真', () => true, () => true);
  ok('N-04 okPair 落地：行为失守记「行为失守」、锚子失配记「字面锚点失配」、两者齐绿才判绿',
    rec.length === 3 && rec[0].cond === false && /行为失守/.test(rec[0].extra?.红因)
    && rec[1].cond === false && /字面锚点失配/.test(rec[1].extra?.红因) && rec[2].cond === true, rec);
}
const BEHAVIOR_OF = Object.fromEntries(P_SPECS.map((s) => [s.id, s.behavior]));
const MUTATIONS = [
  ['P-01', '导航 seam 失效', (e) => { e.nav = false; }],
  ['P-02', '会话开键失效', (e) => { e.panel.opened = false; }],
  ['P-03', '停靠根不是 aside', (e) => { e.panel.dockRoot = 'DIV'; }],
  ['P-04', '工具条/筛选复选缺失', (e) => { e.panel.toolbar = false; }],
  ['P-05', '条 aria 与行标题脱钩', (e) => { e.bars.allLabelTitles = false; }],
  ['P-06', 'tooltip 三点缺值', (e) => { e.bars.tipPoints = false; }],
  ['P-07', 'tooltip 基数失配', (e) => { e.bars.tipBaseAll = false; }],
  ['P-08', '建议行不再灰显或已落库', (e) => { e.bars.sugOk = false; }],
  ['P-09', '里程碑组头混入图形', (e) => { e.bars.msHeaderOk = false; }],
  ['P-10', '筛选不动行/改了归一比例', (e) => { e.filter.ok = false; }],
  ['P-11', '图例缺失', (e) => { e.bars.legendOk = false; }],
  ['P-12', '图例不解释三点', (e) => { e.bars.legendExplains = false; }],
  ['P-13', 'P 输入与 pessimistic 字段错位', (e) => { e.edit.structuralOk = false; }],
  ['P-14', '空项目仍画图例', (e) => { e.empty.ok = false; }],
];
const mutResults = [];
for (const [id, name, mutate] of MUTATIONS) {
  const e = structuredClone(EV);
  mutate(e);
  mutResults.push({ id, name, turnedFalse: withEV(e, BEHAVIOR_OF[id]) === false });
}
ok('N-05 破坏形态反证：14 类实测料被改写后对应行为腿各自转假（导航/面板/工具条/标签/提示/建议/里程碑/筛选/图例/输入映射/空态）',
  mutResults.every((r) => r.turnedFalse), mutResults.filter((r) => !r.turnedFalse));

console.log(`\n结果：PASS=${pass} FAIL=${fail}｜截图：${shotFiles.join('、') || '无'}`);
process.exit(fail === 0 ? 0 : 1);
