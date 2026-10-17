#!/usr/bin/env node
/**
 * T02047（估算视图 §9「性能与验收测试」）真机走查：CDP 驱动系统 Chrome 打开**隔离实例**的估算面板，
 * 只断言命令层门（verify-t02047-acceptance.mts）拿不到的那四类问题：
 *   ① §9 性能行的浏览器侧那一半——500 行明细下「面板首屏渲染 <500ms」是渲染事实，不是接口耗时；
 *   ② §10-13 三档视口（1200/1440/1920）+ 1100 覆盖式：docked 分栏挤压与 SlideOver 转换；
 *   ③ §9 可访问性：键盘 Tab 能否走遍全部录入控件、aria 语义在 DOM 上真的存在；
 *   ④ §12-R6：视图切换（列表↔甘特↔时间线）与刷新不得改写面板开合态（会话键分区的运行时证明）。
 *
 * 用法：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02047-ui.mjs
 *   环境变量：T02047_UI_PORT / T02047_UI_CDP（缺省随机，避开 Windows 动态端口保留区）、T02047_UI_KEEP=1 保留临时目录
 *
 * 隔离纪律（skill 红线 8）：MTask_DATA_DIR 指临时目录、端口自配，不碰生产库与用户实例；截图落每轮独立子目录（`MTASK_GATE_ARTIFACT_DIR/<门名>-<运行标识>/`，T02312：不再落仓库根固定名目录，防并发整图互覆）。
 * 本仓内置 Browser 无视口不能点击/截图（见 memory），故走 CDP + headless=new。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_T0 = Date.now();
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02047-ui-'));
const CHROME_PROFILE = mkdtempSync(join(tmpdir(), 't02047-ui-chrome-'));
// T02312：截图不落仓库根固定名目录（并发跑门时同一步骤名整图互覆，且仓库根长期堆未纳管产物）——
// 改用 gate-results 的进程级 RUN_TAG 子目录，与本轮文本产物同标识，可按标识核对归属。
const { gateShotsDir } = await import(pathToFileURL(join(ROOT, 'scripts/lib/gate-results.mts')).href);
const SHOTS = gateShotsDir('t02047');
const rndPort = (base) => base + Math.floor(Math.random() * 400);
const PORT = Number(process.env.T02047_UI_PORT ?? rndPort(39100));
const CDP = Number(process.env.T02047_UI_CDP ?? rndPort(9400));
const CHROME = process.env.T02047_UI_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0; let skip = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); return true; }
  fail += 1;
  console.log(`  [FAIL] ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra).toString().slice(0, 600)}` : ''}`);
  return false;
};
const group = (t) => console.log(`\n=== ${t} ===`);

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shift = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return ymd(d); };
const TODAY = shift(0);
const FAR = shift(60);

// ---------------- 1) 夹具：临时库直写（进程内，起服务前完成） ----------------
process.env.MTask_DATA_DIR = DATA_DIR;
const { getDb, closeDb } = await import('../server/src/db/connection.ts');
const { initSchema } = await import('../server/src/db/schema.ts');
initSchema();
const T = new Date().toISOString();
const db = getDb();
const insProj = db.prepare('INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)');
const insPlan = db.prepare(
  `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
     progress, status, assignee, sort_order, created_at, updated_at, kind, complexity, req_ids, deps)
   VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, null, ?)`,
);
const insEst = db.prepare(
  `INSERT INTO estimate_items (id, project_id, plan_id, phase, unit, optimistic, likely, pessimistic, source, note, created_at, updated_at)
   VALUES (?, ?, ?, ?, 'man_day', ?, ?, ?, ?, '', ?, ?)`,
);

/** 500 行项目：性能面的规模（无里程碑，面板要一次渲染全部明细） */
const BIG = 'ui-500';
insProj.run(BIG, 'T02047-500行性能走查', '', T, T);
const PHASES = ['req', 'design', 'dev', 'impl', 'common', 'onsite'];
const txBig = db.transaction(() => {
  for (let i = 0; i < 500; i++) {
    const id = `b-${i}`;
    insPlan.run(id, BIG, `B500-${i + 1} 功能点说明（长标题走查：含中英文与标点，用于截断判定）`,
      TODAY, shift(10 + (i % 20)), 3 + (i % 7), 20, 'doing', i + 1, T, T, 'normal', (i % 5) + 1, null);
    const m = 2 + (i % 6);
    insEst.run(`eb-${i}`, BIG, id, PHASES[i % 6], m, m + 2, m + 6, i % 3 === 0 ? 'manual' : 'rule', T, T);
  }
});
txBig();

/** 小项目：键盘可达 / 视图切换 / 覆盖式（里程碑 + 依赖 + 未估算行都齐） */
const KB = 'ui-kb';
insProj.run(KB, 'T02047-视口键盘与切换走查', '', T, T);
const DEP = JSON.stringify([{ id: 'k-ms', type: 'child' }]);
const kbPlans = [
  ['k-ms', 'K1 交付里程碑', 6, 40, 'doing', 'milestone', null],
  ['k-1', '键盘行一 需求分析', 5, 0, 'todo', 'normal', 3],
  ['k-2', '键盘行二 系统设计', 4, 0, 'todo', 'normal', 2],
  ['k-3', '键盘行三 开发实施', 8, 0, 'doing', 'normal', 4],
  ['k-4', '键盘行四 集成测试', 3, 0, 'todo', 'normal', 2],
  ['k-5', '键盘行五 现场支持', 2, 0, 'todo', 'normal', 1],
];
kbPlans.forEach(([id, title, dur, prog, st, kind, cx], i) => {
  insPlan.run(id, KB, title, TODAY, shift(dur + i), dur, prog, st, i + 1, T, T, kind, cx ?? null, kind === 'normal' ? DEP : null);
});
[['k-1', 'req', 4, 6, 10, 'manual'], ['k-2', 'design', 3, 5, 9, 'rule'],
  ['k-3', 'dev', 6, 8, 16, 'manual'], ['k-4', 'impl', 2, 3, 4, 'rule'],
  ['k-5', 'onsite', 2, 2, 6, 'default']].forEach(([pid, ph, o, m, p, src]) => {
  insEst.run(`ek-${pid}`, KB, pid, ph, o, m, p, src, T, T);
});
closeDb();

// ---------------- 2) 隔离服务 ----------------
const { resolveServerLauncher } = await import(pathToFileURL(join(ROOT, 'scripts/isolated-server-launcher.mts')).href);
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const server = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT, env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
console.log(`隔离实例启动器：${LAUNCHER.label}`);
const serverLog = [];
let serverExit = 'running';
server.on('exit', (code, signal) => { serverExit = `code=${code} signal=${signal}`; });
server.on('error', (e) => serverLog.push(`spawn-error: ${e.message}`));
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
  if (process.env.T02047_UI_KEEP) return;
  for (const dir of [DATA_DIR, CHROME_PROFILE]) {
    for (let i = 0; i < 8; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break; } catch { sleepSync(i); }
    }
  }
};
process.on('exit', cleanup);

group('V-00 环境');
// 本机实测（本轮四次撞墙，含此前全绿的 T02046 门在同机同时段也起不来）：隔离服务冷启动慢是**机器负载**
// （同机数十个 node/chrome 进程，tsx 转译 + 夹具库首建被拖到 4 分钟以上），不是代码坏了。
// 就绪窗口给 600s 并把实际耗时留成证据——窗口不足会把环境问题读成产品缺陷（§12-R7 的断言能力边界）。
let serverUp = false; let upMs = 0;
for (let i = 0; i < 1200; i++) {
  try { if ((await fetch(`${BASE}/api/health`)).ok) { serverUp = true; upMs = Date.now() - SCRIPT_T0; break; } } catch { /* */ }
  await sleep(500);
}
ok('V-01 隔离服务启动（临时端口 + 临时库：500 行项目 + 6 计划走查项目）', serverUp,
  serverUp ? undefined : { exit: serverExit, port: PORT, log: serverLog.join('').slice(-600) });
if (!serverUp) { console.log(`\nPASS=${pass} FAIL=${fail} SKIP=${skip}\n服务未起来，终止`); process.exit(1); }

// 发布新鲜度（skill 红线 7）：UI 测的必须是当前前端构建，否则走查结论对着旧包
const newestMtime = (dir, test) => {
  let best = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (test(e.name)) best = Math.max(best, statSync(p).mtimeMs);
    }
  };
  try { walk(dir); } catch { /* */ }
  return best;
};
const distM = newestMtime(join(ROOT, 'web', 'dist'), (n) => n.endsWith('.js'));
const srcM = newestMtime(join(ROOT, 'web', 'src'), (n) => /\.(ts|tsx)$/.test(n));
ok('V-02 web 构建不早于前端源码（走查对象是当前包而不是旧包）', distM > 0 && distM >= srcM,
  { distM, srcM, distAgeMin: Math.round((Date.now() - distM) / 60000) });

let wsUrl = '';
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP}/json/list`);
    if (r.ok) { const t = (await r.json()).find((x) => x.type === 'page'); if (t) { wsUrl = t.webSocketDebuggerUrl; break; } }
  } catch { /* Chrome 还在起 */ }
  await sleep(400);
}
ok('V-03 Chrome CDP 通道就绪（系统 Chrome, headless=new）', !!wsUrl, wsUrl);
if (!wsUrl) process.exit(1);

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pend = new Map();
const errs = [];
const netFail = [];
ws.onmessage = (ev2) => {
  const m = JSON.parse(ev2.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Network.responseReceived' && /\/api\//.test(m.params.response.url) && m.params.response.status >= 500) {
    netFail.push({ url: m.params.response.url, status: m.params.response.status });
  }
};
const send = (method, params = {}) => new Promise((res) => { const i = ++seq; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
async function until(expr, ms = 25_000) {
  const t0 = Date.now(); let v = null;
  while (Date.now() - t0 < ms) { v = await ev(expr); if (v) return v; await sleep(300); }
  return v;
}
async function setViewport(width, height = 1000) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
}
const shotFiles = [];
async function shot(name) {
  mkdirSync(SHOTS, { recursive: true });
  await send('Page.bringToFront');
  for (let i = 0; i < 3; i++) {
    const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const b64 = r.result && r.result.data;
    if (b64) { const file = join(SHOTS, `${name}.png`); writeFileSync(file, Buffer.from(b64, 'base64')); shotFiles.push(file); return file; }
    await sleep(700);
  }
  return '';
}
const rest = async (p) => (await fetch(`${BASE}/api${p}`)).json();

const PJ = `const p=()=>document.querySelector('aside[aria-label="估算面板"]')
    ||[...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find(d=>d.innerText.includes('实际预估人月'));
  const dlg=()=>document.querySelector('[role="dialog"][aria-modal="true"]');
  const numsIn=()=>[...p().querySelectorAll('input[type="number"]')];
  const card=(t)=>[...p().querySelectorAll('div')].filter(x=>x.children.length===0&&x.textContent.trim().startsWith(t)).map(x=>x.parentElement);
  const tl=()=>document.querySelector('main')||[...document.querySelectorAll('div')].find(d=>d.querySelector('[aria-label="时间线视图"], [data-tl="1"]'));`;
const PE = (strings, ...exprs) => {
  let body = strings[0];
  exprs.forEach((e, i) => { body += String(e) + strings[i + 1]; });
  return `(() => { ${PJ}${body} })()`;
};

await send('Page.enable');
await send('Network.enable');
const bootSeed = (pid, viewMode, panelOpen) => `try {
    window.__errs = [];
    window.addEventListener('error', (e) => window.__errs.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) => window.__errs.push('reject:' + String(e.reason)));
    sessionStorage.setItem('plan.projectId', JSON.stringify(${JSON.stringify(pid)}));
    sessionStorage.setItem('plan.viewMode', JSON.stringify(${JSON.stringify(viewMode)}));
    sessionStorage.setItem('plan.estimatePanelOpen', JSON.stringify(${JSON.stringify(panelOpen)}));
    localStorage.setItem('mtask.projectGuide.seen', '1');
    ['tasks', 'aitools', 'prompts', 'req', 'plan', 'report', 'history', 'queue', 'exec-sessions', 'settings']
      .forEach((t) => localStorage.setItem('mtask.guide.seen.' + t, '1'));
  } catch (e) {}`;
let seeded = '';
async function gotoApp(pid, viewMode, panelOpen, fresh = true) {
  const src = bootSeed(pid, viewMode, panelOpen);
  if (fresh || src !== seeded) { await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: '' }).catch(() => {}); await send('Page.navigate', { url: 'about:blank' }); await sleep(300); seeded = (await send('Page.addScriptToEvaluateOnNewDocument', { source: src })).result.identifier; }
  await send('Page.navigate', { url: `${BASE}/?m=0` });
  const nav = await until(`[...document.querySelectorAll('button')].some(x=>x.textContent.trim()==='项目管理')`);
  if (!nav) return false;
  // 应用默认落在「待办」页（`?m=0` 不是模块索引），面板在项目管理页内——不点进去，后面全是空转
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '项目管理'); b?.click(); return 1; })()`);
  return until(`[...document.querySelectorAll('button')].some(x=>x.textContent.trim()==='估算面板 ⤡'||x.textContent.trim()==='估算面板 ⤢')`);
}

group('V-10 §9 性能·500 行面板首屏渲染（浏览器侧那一半）');
ok('V-10a 页面加载（500 行项目，面板初始关闭）', await gotoApp(BIG, 'timeline', false), 'nav 未出现');
await setViewport(1440, 1000);
ok('V-10b 时间线视图已就位（面板开关在同排 toggle 里）',
  await until(PE`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('估算面板')); return b?{found:1,txt:b.textContent.trim()}:'notoggle';`)
    .then((s) => !!s && s.found === 1), '开关按钮未找到');
const firstPaint = await ev(`(async () => {
  ${PJ.replace(/\n\s*/g, ' ')}
  const btn=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('估算面板'));
  const t0=performance.now();
  btn.click();
  const got = await new Promise((res) => {
    const tOut = setTimeout(() => res({ timeout: 1, ms: performance.now() - t0, inputs: p() ? p().querySelectorAll('input[type="number"]').length : -1 }), 20000);
    const chk = () => {
      const el = p();
      const inputs = el ? el.querySelectorAll('input[type="number"]').length : 0;
      if (el && inputs > 0) {
        requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(tOut); res({ ms: performance.now() - t0, inputs, rows: el.querySelectorAll('input[aria-label$="（人天）"]').length / 3 }); }));
      } else requestAnimationFrame(chk);
    };
    requestAnimationFrame(chk);
  });
  return got; })()`);
ok('V-11 §9 性能：500 行明细下「面板首屏渲染」<500ms（点击到两帧绘制完成，含取数）',
  firstPaint && !firstPaint.timeout && firstPaint.ms < 500, firstPaint);
// 第二次开合：数据已在缓存里，量的是纯重排/重绘——两数之差就是「500 行 × 3 输入框全量挂载」的净成本，
// 也是判断该不该上窗口化渲染的依据（只报一个总数说不清瓶颈在取数还是在渲染）
const repaint = await ev(`(async () => {
  ${PJ.replace(/\\n\\s*/g, ' ')}
  const btn=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('估算面板'));
  btn.click();
  await new Promise((r) => setTimeout(r, 600));
  const t0=performance.now();
  btn.click();
  return await new Promise((res) => {
    const chk = () => { const el=p(); if (el && el.querySelectorAll('input[type="number"]').length>0) {
      requestAnimationFrame(()=>requestAnimationFrame(()=>res({ ms: performance.now()-t0, inputs: el.querySelectorAll('input[type="number"]').length })));
    } else requestAnimationFrame(chk); };
    requestAnimationFrame(chk);
  }); })()`);
console.log(`  [INFO] 首开 ${firstPaint?.ms?.toFixed(0)}ms（含取数） / 二次开（数据已在缓存） ${repaint?.ms?.toFixed(0)}ms / 面板内输入框 ${repaint?.inputs} 个`);
ok('V-12 规模确实到位：面板渲染出的录入行数与服务端明细条数一致（不是数到 3 就交差）',
  await (async () => {
    const d = await rest(`/estimates?projectId=${BIG}`);
    const live = d.items.filter((i) => i.plan_kind !== 'milestone' && i.optimistic !== null);
    return { expected: live.length, painted: firstPaint?.rows ?? 0, inputs: firstPaint?.inputs ?? 0 };
  })()
    .then((s) => { console.log(`  [INFO] 服务端明细 ${s.expected} 行 / 面板录入 ${s.painted} 行 / 数字输入 ${s.inputs} 个`); return s.expected > 0 && s.inputs === s.expected * 3; }),
  '录入框数与明细行数不匹配（面板可能有虚拟化或漏渲染）');
let v13evidence = {};
ok('V-13 500 行下面板「实际预估人月」卡读数 == 服务端 actualManMonths.expected（规模与口径都不改变出数）',
  await (async () => {
    const d = await rest(`/estimates?projectId=${BIG}`);
    const shown = await until(PE`const one=(t)=>{const c=card(t); return c.length?c[0].innerText.replace(/\\s+/g,' '):'nocard';};
      return {act: one('实际预估人月'), ideal: one('理想人月')};`, 20_000);
    const firstNum = (s) => { const m = /([\d.]+)/.exec(String(s || '').split('P84').pop()); return m ? Number(m[1]) : NaN; };
    const got = firstNum(shown && shown.act);
    v13evidence = { ...shown, serverActual: d.summary.actualManMonths.expected, serverIdeal: d.summary.idealManMonths.expected, coefSum: d.summary.coefSum, parsedP50: got };
    return Number.isFinite(got) && Math.abs(got - d.summary.actualManMonths.expected) <= 0.011;
  })(), v13evidence);
await shot('v13-500rows-1440');

group('V-20 §10-13 三档视口 + 1100 覆盖式');
const vpProbe = () => ev(`(() => {
  ${PJ.replace(/\n\s*/g, ' ')}
  const el = p(); if (!el) return { nopanel: 1 };
  const r = el.getBoundingClientRect();
  const de = document.documentElement;
  const hscroll = de.scrollWidth > de.clientWidth + 1;
  const cards = card('实际预估人月').concat(card('Σ估算比例（I40）'));
  const rects = cards.map((x) => x.getBoundingClientRect());
  const overlap = rects.length > 1 && rects[0].left < rects[1].right && rects[1].left < rects[0].right && rects[0].top < rects[1].bottom && rects[1].top < rects[0].bottom;
  const ins = [...el.querySelectorAll('input[type="number"]')];
  const clipped = ins.filter((i) => { const b = i.getBoundingClientRect(); return b.right > r.right + 1 || b.left < r.left - 1; }).length;
  const tlWrap = el.closest('div[style*="display: flex"]')?.firstElementChild;
  const tr = tlWrap ? tlWrap.getBoundingClientRect() : null;
  const tlSqueezed = tr ? Math.round(tr.width) : -1;
  const tlHscroll = tlWrap ? tlWrap.scrollWidth > tlWrap.clientWidth + 1 : false;
  return { innerW: window.innerWidth, panelLeft: Math.round(r.left), panelRight: Math.round(r.right), panelW: Math.round(r.width),
    hscroll, clipped, overlap, mode: el.tagName.toLowerCase() === 'aside' ? 'docked' : 'overlay', tlSqueezed, tlHscroll,
    docOverflowRight: Math.round(de.scrollWidth - de.clientWidth) };
})()`);
for (const w of [1920, 1440, 1200]) {
  await setViewport(w, 1000);
  const s = await vpProbe();
  ok(`V-2${w === 1920 ? 1 : w === 1440 ? 2 : 3} ${w}px：docked 面板完整可见、页面不横向溢出、汇总卡不重叠、录入框不被裁切`,
    s && !s.nopanel && s.mode === 'docked' && !s.hscroll && !s.overlap && s.clipped === 0 && s.panelRight <= s.innerW + 1, s);
  await shot(`v2x-docked-${w}`);
}
await setViewport(1100, 1000);
const s1100 = await vpProbe();
ok('V-24 1100px 覆盖式：<1200px 转 SlideOver 抽屉，不再用分栏挤压时间线',
  s1100 && s1100.mode === 'overlay' && !s1100.hscroll && s1100.clipped === 0, s1100);
const v25 = await (async () => {
  const before = s1100.tlSqueezed;
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('估算面板')); b?.click(); return 1; })()`);
  await sleep(800);
  const closed = await ev(`(() => { const tlWrap=[...document.querySelectorAll('div[style*="display: flex"]')].map(d=>d.firstElementChild).find(e=>e&&e.innerText&&e.innerText.includes('时间线')); return tlWrap?Math.round(tlWrap.getBoundingClientRect().width):-1; })()`);
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('估算面板')); b?.click(); return 1; })()`);
  await sleep(600);
  return { panelOn: before, panelOff: closed };
})();
ok('V-25 覆盖式下时间线主列宽度未被面板挤占（关面板后两态宽度都测到且不小于开面板时）',
  v25.panelOn > 0 && v25.panelOff > 0 && v25.panelOff >= v25.panelOn, v25);
await shot('v24-overlay-1100');

group('V-30 §9 可访问性·键盘 Tab 走遍录入控件');
ok('V-30a 页面加载（走查项目，时间线 + 面板开）', await gotoApp(KB, 'timeline', true), 'nav 未出现');
await setViewport(1440, 1000);
ok('V-30b 面板已打开（小项目 5 条明细）', await until(PE`return !!p();`), '面板未出现');
// 先清点面板内全部数字录入框的可达性事实（aria-label / 可见 / 禁用 / 包裹 label / 所属 role）——
// 「Tab 走不到」有两种完全不同的解释（面板漏标 vs 折叠表单里的框本就不该被 Tab 到），没有这份清点就只能猜
const inv = await ev(PE`return [...p().querySelectorAll('input[type="number"]')].map((i) => ({
    aria: i.getAttribute('aria-label') || '',
    vis: !!i.offsetParent && i.getBoundingClientRect().height > 0,
    dis: !!i.disabled,
    wrap: i.closest('label') ? i.closest('label').innerText.trim().slice(0, 16) : '',
    role: i.closest('[role]') ? i.closest('[role]').getAttribute('role') : ''
  }));`);
const visEn = (inv || []).filter((x) => x.vis && !x.dis);
console.log(`  [INFO] 面板录入框清点：总 ${(inv || []).length} / 可见且未禁用 ${visEn.length} / 无 aria-label ${(inv || []).filter((x) => !x.aria).length}` +
  ` / 隐藏或禁用 ${(inv || []).filter((x) => !x.vis || x.dis).length}` +
  `；无名样例 ${JSON.stringify((inv || []).filter((x) => !x.aria).slice(0, 4))}`);
ok('V-30c 清点可取得（面板内确有数字录入框，且可见集非空）',
  Array.isArray(inv) && inv.length >= 15 && visEn.length > 0, { total: (inv || []).length, visEn: visEn.length });
const kb = await (async () => {
  await ev(PE`const n=[...p().querySelectorAll('input[type="number"]')].filter(i=>i.offsetParent&&!i.disabled); n[0].focus(); return {focused:document.activeElement===n[0], total:n.length};`);
  const seen = [];
  for (let i = 0; i < 120; i++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    const cur = await ev(`(() => { const a=document.activeElement; if(!a) return null;
      return { tag:a.tagName, label:a.getAttribute('aria-label')||'', text:(a.textContent||'').trim().slice(0,12), inPanel: !!a.closest('aside[aria-label="估算面板"]') }; })()`);
    if (!cur) break;
    const key = cur.tag + ':' + (cur.label || cur.text) + ':' + (cur.inPanel ? 'in' : 'out');
    if (!seen.find((x) => x.key === key)) seen.push({ key, ...cur });
    if (seen.filter((x) => x.tag === 'INPUT' && x.inPanel).length >= visEn.length) break;
  }
  const inPanelInputs = seen.filter((x) => x.tag === 'INPUT' && x.inPanel);
  return { total: seen.length, inputs: inPanelInputs.length };
})();
ok('V-31 §9 可访问性：从首个可见录入框起 Tab 走遍面板内全部**可见且未禁用**的数字录入控件',
  !!kb && kb.inputs >= visEn.length && visEn.length === 15, { reached: kb?.inputs, need: visEn.length, tabs: kb?.total });
const unnamed = (inv || []).filter((x) => x.vis && !x.dis && !x.aria && !x.wrap);
ok('V-32 面板内每个可见录入控件都有可被读出的名字（aria-label，或包裹 label 的隐式名——两者皆无才算无名）',
  unnamed.length === 0, { unnamed, 无aria但靠label命名: (inv || []).filter((x) => x.vis && !x.aria && x.wrap).map((x) => x.wrap) });
const roles = await ev(PE`const q=(s)=>p().querySelectorAll(s).length;
  return { aside: p().tagName.toLowerCase(), toolbar: q('[role="toolbar"]'), status: q('[role="status"]'),
    img: q('[role="img"][aria-label]'), group: q('[role="group"]'), alert: q('[role="alert"]') };`);
ok('V-33 面板常驻语义标注在 DOM 上成立（aside + toolbar/status + 区间条 role=img 带 aria-label）',
  !!roles && roles.aside === 'aside' && roles.toolbar >= 1 && roles.status >= 1 && roles.img >= 1, roles);
await shot('v3x-keyboard-1440');

group('V-40 §12-R6 视图切换与刷新不动面板开合态');
const readSum = () => ev(PE`const c=card('实际预估人月'); return c.length?c[0].innerText.replace(/\\s+/g,' '):'';`);
const r0 = await readSum();
const switchTo = async (label) => {
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(label)}); b?.click(); return 1; })()`);
  await sleep(700);
  return ev(`(() => ({ view: sessionStorage.getItem('plan.viewMode'), open: sessionStorage.getItem('plan.estimatePanelOpen'),
    panel: !!document.querySelector('aside[aria-label="估算面板"]') || !!document.querySelector('[role="dialog"][aria-modal="true"]') }))()`);
};
const vList = await switchTo('列表');
ok('V-41 切到列表视图：viewMode 变了而 estimatePanelOpen 没被改写（会话键分区）',
  vList && /"list"/.test(vList.view) && vList.open === 'true', vList);
const vGantt = await switchTo('甘特');
ok('V-42 切到甘特视图同样只动 viewMode；页面不报错',
  vGantt && /"gantt"/.test(vGantt.view) && vGantt.open === 'true', vGantt);
await shot('v42-gantt');
const vBack = await switchTo('时间线');
ok('V-43 回时间线：面板自动回到打开态（开合态由键决定，不由视图决定）',
  vBack && /"timeline"/.test(vBack.view) && await until(PE`return !!p();`, 15000), vBack);
const r1 = await readSum();
ok('V-44 三圈切换后汇总读数不变（切换视图不重算、不掉数）', r0 && r0 === r1, { r0, r1 });
await ev(`(() => { location.reload(); return 1; })()`);
ok('V-45 刷新后面板仍开且读数一致（§10-1「刷新后保持」）',
  await (async () => {
    await sleep(1500);
    await until(`[...document.querySelectorAll('button')].some(x=>x.textContent.trim()==='项目管理')`, 30000);
    await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '项目管理'); b?.click(); return 1; })()`);
    const back = await until(PE`return !!p();`, 20000);
    const rr = await readSum();
    return { back, same: rr === r1, rr };
  })().then((s) => s.back && s.same), await ev(PE`return {open:sessionStorage.getItem('plan.estimatePanelOpen')};`));
await shot('v45-after-reload');

group('V-90 全程无脚本错误与服务端 5xx');
const pageErrs = await ev(`window.__errs || ['no-hook']`);
console.log(`  [INFO] window.__errs=${JSON.stringify(pageErrs).slice(0, 300)}`);
ok('V-91 页面无未捕获错误（window.__errs 为空）',
  Array.isArray(pageErrs) && (pageErrs.length === 0 || pageErrs[0] === 'no-hook'), pageErrs);
ok('V-92 走查期间无 /api 5xx 响应', netFail.length === 0, netFail.slice(0, 5));

console.log(`\n[INFO] 服务就绪耗时 ${upMs}ms（含夹具库首启）；截图 ${shotFiles.length} 张 → ${SHOTS}`);
console.log(`\nPASS=${pass} FAIL=${fail} SKIP=${skip}`);
process.exit(fail === 0 ? 0 : 1);
