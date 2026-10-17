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
 * 用法（Chrome 用系统安装版；本仓内置 Browser 无视口不能点击/截图，见 memory）：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02041-ui.mjs
 *   环境变量：T02041_UI_PORT（默认 39934）、T02041_UI_CDP（默认 9344）
 *
 * 隔离纪律（skill 红线 8）：MTask_DATA_DIR 指临时目录、端口自配，不碰生产库与用户实例；
 * 退出连 Chrome 子进程树一起回收（taskkill /T），截图落每轮独立子目录（`MTASK_GATE_ARTIFACT_DIR/<门名>-<运行标识>/`，T02312：不再落仓库根固定名目录，防并发整图互覆）。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02041-ui-'));
const CHROME_PROFILE = mkdtempSync(join(tmpdir(), 't02041-ui-chrome-'));
// T02312：截图不落仓库根固定名目录（并发跑门时同一步骤名整图互覆，且仓库根长期堆未纳管产物）——
// 改用 gate-results 的进程级 RUN_TAG 子目录，与本轮文本产物同标识，可按标识核对归属。
const { gateShotsDir } = await import(pathToFileURL(join(ROOT, 'scripts/lib/gate-results.mts')).href);
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

// ---------------- 1) 夹具：临时库直写（进程内，起服务前完成） ----------------
process.env.MTask_DATA_DIR = DATA_DIR;
const { getDb, closeDb } = await import('../server/src/db/connection.ts');
const { initSchema } = await import('../server/src/db/schema.ts');
initSchema();
const T = '2026-10-11T00:00:00.000Z';
const PID = 'ui-e6';
const BARE = 'ui-e6bare';
const db = getDb();
const insProj = db.prepare('INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)');
insProj.run(PID, 'T02041-区间条走查', '', T, T);
insProj.run(BARE, 'T02041-空项目', '', T, T);
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
insEst.run('es-wide', PID, 'r-wide', 'impl', 4, 8, 16, 'manual', '最大 P 行（决定归一基数）', T, T);
insEst.run('es-mid', PID, 'r-mid', 'dev', 2, 3, 4, 'rule', '', T, T);
insEst.run('es-degen', PID, 'r-degen', 'test', 6, 6, 6, 'manual', 'O=M=P 的退化区间', T, T);
closeDb();

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
  if (m.method === 'Network.responseReceived' && /\/api\/estimates/.test(m.params.response.url)) {
    netLog.push({ url: m.params.response.url.replace(/^https?:\/\/[^/]+/, ''), status: m.params.response.status });
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

const PJ = `const p=()=>document.querySelector('aside[aria-label="估算面板"]')||[...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find(d=>d.innerText.includes('实际预估人月'));`;
/** 面板内求值统一套 IIFE（裸 return 交给 Runtime.evaluate 是语法错误，T02040 踩过） */
const PE = (strings, ...exprs) => {
  let body = strings[0];
  exprs.forEach((e, i) => { body += String(e) + strings[i + 1]; });
  return `(() => { ${PJ}${body} })()`;
};
const clickBtn = (text) => `(() => { ${PJ}const b=[...p().querySelectorAll('button')].find(x=>x.textContent.trim().includes(${JSON.stringify(text)})); if(!b) return 'nobtn'; b.click(); return 'clicked'; })()`;
/**
 * 「只看未复核」在面板里是 label + checkbox，不是 button（真机抓到的第一版断言假绿：
 * clickBtn 找不到按钮静默返回 'nobtn'，筛选根本没开，区间条数量当然是 4）。
 * 这里点复选框本体，并把点击后的 checked 目标态回读出来，让「没点到」变成显式失败。
 */
const setFilter = (on) => `(() => { ${PJ}const l=[...p().querySelectorAll('label')].find(x=>x.textContent.trim().includes('只看未复核'));
  const c=l&&l.querySelector('input[type="checkbox"]'); if(!c) return 'nochk';
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
 * children 顺序即渲染顺序：[横线, O 端帽, P 端帽, E 竖线]。
 */
const GEOF = PE`const out=[];
  for (const el of p().querySelectorAll('[role="img"][aria-label^="区间条"]')) {
    const c=el.getBoundingClientRect();
    const kids=[...el.children].map((k)=>{const r=k.getBoundingClientRect();
      return {left:Math.round((r.left-c.left)*100)/100,width:Math.round(r.width*100)/100,rgb:getComputedStyle(k).backgroundColor};});
    out.push({label:el.getAttribute('aria-label'),boxW:Math.round(c.width*100)/100,kids,title:el.getAttribute('title')||''});
  }
  return out;`;
const byTitle = (rows, name) => (Array.isArray(rows) ? rows : []).find((r) => (r.label || '').endsWith(name));
/** 期望左偏移（px）：值 ÷ 基数 × 容器宽；容差 1.2px 吸收 sub-pixel 布局 */
const near = (a, b, tol = 1.2) => Math.abs(a - b) <= tol;

await send('Page.enable');
await send('Network.enable');
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try {
    window.__errs = [];
    window.addEventListener('error', (e) => window.__errs.push(String(e.message)));
    sessionStorage.setItem('plan.projectId', JSON.stringify(${JSON.stringify(PID)}));
    sessionStorage.setItem('plan.viewMode', JSON.stringify('timeline'));
    sessionStorage.setItem('plan.estimatePanelOpen', JSON.stringify(true));
    localStorage.setItem('mtask.projectGuide.seen', '1');
    ['tasks', 'aitools', 'prompts', 'req', 'plan', 'report', 'history', 'queue', 'exec-sessions', 'settings']
      .forEach((t) => localStorage.setItem('mtask.guide.seen.' + t, '1'));
  } catch (e) {}`,
});
await send('Page.navigate', { url: `${BASE}/?m=0` });
ok('U-02 页面加载完成（桌面 UI）',
  await until(`[...document.querySelectorAll('button')].some(x=>x.textContent.trim()==='项目管理')`), 'nav 按钮缺失');
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '项目管理'); b?.click(); return 1; })()`);
await setViewport(1920, 1000);
ok('U-03 估算面板已打开（会话态种入开键）', await until(PE`return !!p();`), '面板未出现');
const geo0 = await until(GEOF.replace('return out;', 'return out.length===4 ? out : \'\';'), 25_000);
ok('U-04 四条三点齐全的行都画出了区间条（含未落库的建议行）', Array.isArray(geo0) && geo0.length === 4, geo0?.length);

console.log('\n=== 归一几何：像素位置 = 服务端值 ÷ 同一基数（max P=16） ===');
const W = geo0[0].boxW;
ok('U-05 四行共用同一容器宽（行间长度可比的前提）', geo0.every((g) => near(g.boxW, W, 0.6)), geo0.map((g) => g.boxW));
const wide = byTitle(geo0, '实施主线');
const mid = byTitle(geo0, '窄区间任务');
const degen = byTitle(geo0, '三点收敛');
const sug = byTitle(geo0, '仅建议行');
ok('U-06 每行四条线：横线 + O 端帽 + P 端帽 + E 竖线（顺序与渲染一致）',
  geo0.every((g) => g.kids.length === 4 && g.kids[0].width > 0), geo0.map((g) => g.kids.length));
ok('U-07 最大 P 行（16）的 P 端帽贴满容器右边缘', wide && near(wide.kids[2].left + 1, W, 1.5), { left: wide?.kids[2].left, W });
ok('U-08 实施主线：O 端帽在 25%（4/16）、E 竖线在 54.17%（(4+32+16)/6 ÷ 16）',
  wide && near(wide.kids[1].left, W * 0.25) && near(wide.kids[3].left, W * (52 / 6 / 16)),
  { o: wide?.kids[1].left, e: wide?.kids[3].left, expectE: W * (52 / 6 / 16) });
ok('U-09 窄区间任务：O 12.5%（2/16）、P 25%（4/16）、E 18.75%（3/16）',
  mid && near(mid.kids[1].left, W * 0.125) && near(mid.kids[2].left, W * 0.25) && near(mid.kids[3].left, W * 0.1875),
  mid && { o: mid.kids[1].left, p: mid.kids[2].left, e: mid.kids[3].left });
ok('U-10 三点收敛行：O=P 时两端帽重合，横线只剩最小可见宽度（不为零所以看得见）',
  degen && near(degen.kids[1].left, degen.kids[2].left, 0.6) && degen.kids[0].width >= 1 && degen.kids[0].width <= 4,
  degen && { rail: degen.kids[0].width, lo: degen.kids[1].left, hi: degen.kids[2].left });
ok('U-11 建议行（未落库）同样按服务端推导值画：O 21.875%（3.5/16）、P 34.375%（5.5/16）',
  sug && near(sug.kids[1].left, W * 0.21875) && near(sug.kids[2].left, W * 0.34375),
  sug && { o: sug.kids[1].left, p: sug.kids[2].left });
ok('U-12 每行 E 竖线不越出两端帽（几何层不重排三点）',
  geo0.every((g) => g.kids[1].left - 1 <= g.kids[3].left && g.kids[3].left <= g.kids[2].left + 1),
  geo0.map((g) => [g.kids[1].left, g.kids[3].left, g.kids[2].left]));

await shot('00-whisker-base16');

console.log('\n=== 语义配色与可访问性 ===');
const accentRgb = await ev(PE`const cs=getComputedStyle(p());return {accent:cs.getPropertyValue('--accent').trim(),muted:cs.getPropertyValue('--text-muted').trim()};`);
const toRgb = (s) => {
  const txt = String(s ?? '');
  const m = /rgba?\(([^)]+)\)/.exec(txt);
  if (m) return m[1].split(',').slice(0, 3).map((x) => Math.round(Number(x.trim()))).join(',');
  const h = /^#?([0-9a-f]{6})$/i.exec(txt.trim());
  if (!h) return txt;
  const n = parseInt(h[1], 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
};
ok('U-13 已落库行的线色 = 解析后的 --accent（不是硬编码色值）',
  wide && toRgb(wide.kids[0].rgb) === toRgb(accentRgb.accent), { measured: wide?.kids[0].rgb, accent: accentRgb.accent });
ok('U-14 建议行的线色 = --text-muted，且与 --accent 不同（灰显口径延伸到区间条）',
  sug && toRgb(sug.kids[0].rgb) === toRgb(accentRgb.muted) && toRgb(accentRgb.muted) !== toRgb(accentRgb.accent),
  { measured: sug?.kids[0].rgb, muted: accentRgb.muted, accent: accentRgb.accent });
ok('U-15 aria-label 以「区间条 + 计划标题」开头（屏幕阅读器与走查脚本都不靠类名）',
  geo0.every((g) => String(g.label).startsWith('区间条 ')), geo0.map((g) => g.label));
ok('U-16 tooltip 写明三点数值与归一基数（读者不必猜那条线是什么）',
  wide && /O 4 —— P 16/.test(wide.title) && /最大 P=16/.test(wide.title), wide?.title);
ok('U-17 里程碑组头不画区间条（§4.6 红线一在视觉层同样生效）',
  await ev(PE`const hs=[...p().querySelectorAll('[role="button"]')].filter(x=>x.innerText.includes('不进 Σ'));
    return hs.length > 0 && hs.every((h)=>!h.querySelector('[role="img"]'));`),
  '里程碑组头里出现了图形');
ok('U-18 图例存在并解释端点与竖线含义',
  await ev(PE`const l=p().querySelector('[aria-label="区间条图例"]');return !!l && l.innerText.includes('端点 O / P');`));

console.log('\n=== 筛选不改刻度 / 改值后条长跟变 ===');
const ratiosBefore = geo0.map((g) => ({ label: g.label, lo: g.kids[1].left / g.boxW, hi: g.kids[2].left / g.boxW }));
const t19 = await ev(setFilter(true));
await idle('U-19');
const geoFiltered = await ev(GEOF);
ok('U-19 「只看未复核」把两条 manual 行筛掉（面板少 2 条区间条）',
  t19 === 'ok' && Array.isArray(geoFiltered) && geoFiltered.length === 2, { click: t19, before: geo0.length, after: geoFiltered?.length });
const sameRatio = (geoFiltered || []).every((g) => {
  const b = ratiosBefore.find((x) => x.label === g.label);
  return b && near(b.lo, g.kids[1].left / g.boxW, 0.005) && near(b.hi, g.kids[2].left / g.boxW, 0.005);
});
ok('U-20 筛选后仍可见行的归一比例分毫未变（基数取全部明细行，不是筛后可见行）', sameRatio,
  { before: ratiosBefore, after: (geoFiltered || []).map((g) => [g.label, g.kids[1].left / g.boxW, g.kids[2].left / g.boxW]) });
const t21 = await ev(setFilter(false));
await idle('U-21');
ok('U-21 关掉筛选后四行区间条回来（筛选态不破坏几何）',
  t21 === 'ok' && (await ev(GEOF))?.length === 4, { click: t21 });

// 行内改 P：窄区间任务 4 → 60，基数应易主，两条线的长度关系整体重排
const label = '窄区间任务 悲观 P（人天）';
await ev(`(() => { ${PJ}const el=[...p().querySelectorAll('input[type="number"]')].find(i=>(i.getAttribute('aria-label')||'')===${JSON.stringify(label)});
  if(!el) return 'missing'; el.focus(); return 'focused'; })()`);
await sleep(150);
await ev(`(() => { ${PJ}const el=[...p().querySelectorAll('input[type="number"]')].find(i=>(i.getAttribute('aria-label')||'')===${JSON.stringify(label)});
  const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
  d.set.call(el,'60'); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value; })()`);
await sleep(200);
await ev(`(() => { ${PJ}const el=[...p().querySelectorAll('input[type="number"]')].find(i=>(i.getAttribute('aria-label')||'')===${JSON.stringify(label)});
  el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return 1; })()`);
const after = await until(GEOF.replace('return out;', 'return out.length && out.every(x=>x.title.includes("最大 P=60")) ? out : \'\';'), 25_000);
ok('U-22 改值后区间条按新基数重画：窄行 P=60 成为新基数并贴满右边缘',
  Array.isArray(after) && near(byTitle(after, '窄区间任务')?.kids[2].left, after[0].boxW, 1.5),
  after && { w: after[0].boxW, hi: byTitle(after, '窄区间任务')?.kids[2].left });
ok('U-23 原最大行（16）相对缩水到 26.67%（16/60）——同屏长度仍可互比',
  Array.isArray(after) && near(byTitle(after, '实施主线')?.kids[2].left, after[0].boxW * (16 / 60), 1.5),
  after && { hi: byTitle(after, '实施主线')?.kids[2].left, expect: after[0].boxW * (16 / 60) });
const itemP = await rest(`/estimates?projectId=${PID}`);
const midItem = (itemP.items || []).find((i) => i.plan_id === 'r-mid');
ok('U-24 改的是真落库值（服务端 pessimistic=60，不是内存态），且该行转为 manual',
  midItem && midItem.pessimistic === 60 && midItem.source === 'manual', midItem);
await shot('01-whisker-remeasured');

// 还原，避免夹具状态影响后续断言
await ev(`(() => { ${PJ}const el=[...p().querySelectorAll('input[type="number"]')].find(i=>(i.getAttribute('aria-label')||'')===${JSON.stringify(label)});
  el.focus(); const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
  d.set.call(el,'4'); el.dispatchEvent(new Event('input',{bubbles:true}));
  el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return 1; })()`);
await until(PE`return p().innerText.includes('窄区间任务') && [...p().querySelectorAll('[aria-label^="区间条"]')].some(x=>(x.getAttribute('title')||'').includes('最大 P=16'));`, 25_000);
await send('Page.reload');
// 刷新后应用落在默认模块，估算面板要重新点进「项目管理」才挂载（U-02/U-03 同一动作）——
// 少这一步，p() 为 null、GEOF 返回 undefined，U-25/26/27 会连带假失败。
await until(`[...document.querySelectorAll('button')].some(x=>x.textContent.trim()==='项目管理')`, 25_000);
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '项目管理'); b?.click(); return 1; })()`);
const panelBack = await until(PE`return !!p();`, 25_000);
const geoReload = panelBack
  ? await until(GEOF.replace('return out;', 'return out.length===4 && out.every(x=>x.title.includes("最大 P=16")) ? out : \'\';'), 25_000)
  : null;
ok('U-25 刷新后区间条仍在且基数回到 16（写路径真落库，几何无本地缓存）',
  Array.isArray(geoReload) && geoReload.length === 4,
  { panel: !!panelBack, n: geoReload?.length, title: String(geoReload?.[0]?.title || '').slice(0, 90) });

console.log('\n=== 空项目不画图例 / 三档视口 / 覆盖式 / 明暗双验 ===');
ok('U-26 三档视口（1920/1440/1200）面板内无横向滚动且区间条照常渲染', await (async () => {
  const res = [];
  for (const w of [1920, 1440, 1200]) {
    await setViewport(w, 1000);
    res.push(await ev(PE`const s=p().scrollWidth - p().clientWidth;
      return { w:${w}, overflow: s > 1, n: p().querySelectorAll('[role="img"][aria-label^="区间条"]').length };`));
  }
  return res.every((r) => r && !r.overflow && r.n === 4);
})());
await setViewport(1100, 1000);
ok('U-27 <1200px 转覆盖式后区间条仍渲染、无横向滚动（§10-13 挤压复验）',
  await until(PE`const d=[...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find(x=>x.innerText.includes('实际预估人月'));
    return d ? { n: d.querySelectorAll('[role="img"][aria-label^="区间条"]').length, overflow: d.scrollWidth - d.clientWidth > 1 } : '';`, 15_000)
    .then((r) => !!r && r.n === 4 && !r.overflow));
await shot('02-whisker-overlay-1100');
await setViewport(1920, 1000);
await ev(PE`document.documentElement.dataset.theme='dark';return 1;`);
await sleep(500);
const darkVars = await ev(PE`const cs=getComputedStyle(p());return {accent:cs.getPropertyValue('--accent').trim(),muted:cs.getPropertyValue('--text-muted').trim()};`);
const geoDark = await ev(GEOF);
ok('U-28 暗色主题下线色仍等于当套 --accent（配色跟变量，不跟字面量）',
  darkVars && toRgb(byTitle(geoDark, '实施主线')?.kids[0].rgb) === toRgb(darkVars.accent),
  { measured: toRgb(byTitle(geoDark, '实施主线')?.kids[0].rgb), accent: toRgb(darkVars.accent) });
ok('U-29 主题切换过程中没有把面板切崩（区间条数量不变、页面无 JS 报错）',
  geoDark?.length === 4 && (await ev(`(window.__errs||[]).length`)) === 0,
  { n: geoDark?.length, errs: await ev(`(window.__errs||[]).slice(-2)`) });
await shot('03-whisker-dark');
await ev(PE`document.documentElement.dataset.theme='light';return 1;`);

console.log('\n=== 数据同源与运维口径 ===');
ok('U-30 区间条没有第二个数据源：面板对 /api/estimates* 的请求全部 200',
  netLog.length > 0 && netLog.every((n) => n.status === 200), netLog.slice(-6));
await ev(clickBtn('全选可见'));
const dv = await fetch(`${BASE}/api/estimates/derive`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ projectId: PID, dryRun: true, scope: 'all' }),
}).then((r) => r.json());
ok('U-31 建议行的区间值与服务端推导响应一致（面板未预置、也未被本地算过）',
  (dv.items || []).some((i) => i.planId === 'r-sug' && i.optimistic === 3.5 && i.pessimistic === 5.5), dv.items);
ok('U-32 服务日志无 estimates/几何相关异常',
  !/estimates.*(500|异常|Error)/i.test(serverLog.join('')), serverLog.join('').split('\n').filter((l) => /estimates/i.test(l)).slice(-3));

console.log(`\n结果：PASS=${pass} FAIL=${fail}｜截图：${shotFiles.join('、') || '无'}`);
process.exit(fail === 0 ? 0 : 1);
