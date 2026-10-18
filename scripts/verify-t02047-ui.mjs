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
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_T0 = Date.now();
// 反模式 1/临时盘红线：TMP 若指 C: 会假性 SQLITE_FULL，门自己的临时根优先 D:/code/tmp
const TMP_ROOT = existsSync('D:/code/tmp') ? 'D:/code/tmp' : tmpdir();
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't02047-ui-'));
const CHROME_PROFILE = mkdtempSync(join(TMP_ROOT, 't02047-ui-chrome-'));
// T02312：截图不落仓库根固定名目录（并发跑门时同一步骤名整图互覆，且仓库根长期堆未纳管产物）——
// 改用 gate-results 的进程级 RUN_TAG 子目录，与本轮文本产物同标识，可按标识核对归属。
const { gateShotsDir } = await import(pathToFileURL(join(ROOT, 'scripts/lib/gate-results.mts')).href);
const { okPair } = await import(pathToFileURL(join(ROOT, 'scripts/lib/anchor-pair.mts')).href);
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
/** 环境缺口诚实留痕：只记不判，绝不把量不到的腿算 PASS */
const skipped = (name, why) => {
  skip += 1;
  console.log(`  [SKIP] ${name}（${why}）——不计 PASS`);
};

/**
 * 反模式 11：字面腿一律取**已提交树**（`git show HEAD:<rel>`），工作树里可能躺着别的会话的过期文件。
 * T02293 判据 3：保留的产品文案锚一律配 okPair 行为腿，行为失守⇒红因「行为失守」，
 * 行为在而锚失配⇒红因「字面锚点失配（行为在）」交人判定。
 */
function headSource(rel) {
  try { return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8' }); } catch { return ''; }
}
const PLAN_REL = 'web/src/pages/PlanPage.tsx';
const EP_REL = 'web/src/components/EstimatePanel.tsx';
const APP_REL = 'web/src/App.tsx';
const PLAN_HEAD = headSource(PLAN_REL);
const EP_HEAD = headSource(EP_REL);
const APP_HEAD = headSource(APP_REL);
const literalOn = (src, anchors) => src.length > 0 && anchors.every((a) => src.includes(a));

/** 运行期实测料：只有真跑过浏览器才回填；S 组行为腿只读它，N 组抽干后必须全假 */
const EV = { ran: false };
const evSet = (k, v) => { EV[k] = v; };
// S 组条目（顶部声明，早退路径也能诚实留痕）
const S_SPECS = [
  { L: 'S-01 导航入口「项目管理」', anchors: ['项目管理'], src: APP_HEAD, SRCLBL: APP_REL,
    behavior: (e) => e.nav === true },
  { L: 'S-02 估算面板开关文案（含 ⤡/⤢ 方向字形）', anchors: ["估算面板 {estimateOpen ? '⤡' : '⤢'}"], src: PLAN_HEAD, SRCLBL: PLAN_REL,
    behavior: (e) => !!e.toggle && e.toggle.found === true && e.toggle.opened === true },
  { L: 'S-03 窗口化自述「明细已载入 N 行 / 仅渲染视口附近 M 行」', anchors: ['明细已载入 ', '仅渲染视口附近 '], src: EP_HEAD, SRCLBL: EP_REL,
    behavior: (e) => !!e.v12 && e.v12.total > 0 && e.v12.painted > 0 && e.v12.painted < e.v12.total && e.v12.inputs === e.v12.painted * 3 },
  { L: 'S-04 视图切换标签「列表 / 甘特 / 时间线」', anchors: ['列表', '甘特', '时间线'], src: PLAN_HEAD, SRCLBL: PLAN_REL,
    behavior: (e) => !!e.viewSwitch && e.viewSwitch.list === true && e.viewSwitch.gantt === true && e.viewSwitch.back === true },
];

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

const PJ = `const p=()=>[...document.querySelectorAll('aside,[role="dialog"][aria-modal="true"]')]
    .find(d=>d.querySelectorAll('input[type="number"]').length>0 && d.querySelector('[role="toolbar"]'))||null;
  const numsIn=()=>p()?[...p().querySelectorAll('input[type="number"]')]:[];
  const sumCards=()=>{ const el=p(); if(!el) return []; const head=el.firstElementChild; if(!head) return [];
    const row=[...head.querySelectorAll('div')].find(d=>d.children.length===3
      && [...d.children].every(c=>c.children.length===1 && c.firstElementChild && c.firstElementChild.children.length>=2));
    return row?[...row.children].map(c=>c.firstElementChild):[]; };
  const toggle=()=>[...document.querySelectorAll('button')].find(b=>/[\\u2921\\u2922]/.test(b.textContent))||null;
  const navBtn=(i)=>{ const n=document.querySelector('nav'); if(!n) return null; const bs=n.querySelectorAll('button.nav-btn'); return bs.length>i?bs[i]:null; };
  const viewBtn=(i)=>{ const fs=[...document.querySelectorAll('fieldset')].find(f=>[...f.children].filter(c=>c.tagName==='BUTTON').length===3
      && !f.closest('aside,[role="dialog"][aria-modal="true"]'));
    return fs?[...fs.children].filter(c=>c.tagName==='BUTTON')[i]:null; };`;
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
  // 导航按结构定位：nav 内第 5 枚 .nav-btn（TABS 顺序里 plan）——文案只作人路，不作断言对象
  const nav = await until(`(() => { const n=document.querySelector('nav'); if(!n) return 0; return n.querySelectorAll('button.nav-btn').length>=5?1:0; })()`);
  if (!nav) return false;
  await ev(`(() => { const b=document.querySelectorAll('nav button.nav-btn')[4]; if(!b) return 0; b.click(); return 1; })()`);
  // 开关按方向字形定位（结构句柄）；文案只用于人路导航，不作为断言对象
  return until(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/[\\u2921\\u2922]/.test(x.textContent)); return !!b; })()`);
}

group('V-10 §9 性能·500 行面板首屏渲染（浏览器侧那一半）');
const navOk = await gotoApp(BIG, 'timeline', false);
evSet('nav', navOk === true);
ok('V-10a 页面加载（500 行项目，面板初始关闭）', navOk, 'nav 未出现');
await setViewport(1440, 1000);
const toggleFound = await until(PE`const b=toggle(); return b?{found:1,txt:b.textContent.trim()}:'notoggle';`);
evSet('toggle', { found: !!toggleFound && toggleFound.found === 1, opened: false, text: toggleFound?.txt ?? null });
ok('V-10b 时间线视图已就位（面板开关按方向字形定位，不认产品文案）',
  !!toggleFound && toggleFound.found === 1, toggleFound);
const firstPaint = await ev(`(async () => {
  ${PJ.replace(/\n\s*/g, ' ')}
  const btn=toggle();
  if(!btn) return { notoggle: 1 };
  const t0=performance.now();
  btn.click();
  const got = await new Promise((res) => {
    const tOut = setTimeout(() => res({ timeout: 1, ms: performance.now() - t0, inputs: p() ? p().querySelectorAll('input[type="number"]').length : -1 }), 20000);
    const chk = () => {
      const el = p();
      const inputs = el ? el.querySelectorAll('input[type="number"]').length : 0;
      if (el && inputs > 0) {
        requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(tOut); res({ ms: performance.now() - t0, inputs, rows: inputs / 3 }); }));
      } else requestAnimationFrame(chk);
    };
    requestAnimationFrame(chk);
  });
  return got; })()`);
if (firstPaint && !firstPaint.timeout && firstPaint.inputs > 0) EV.toggle.opened = true;
ok('V-11 §9 性能：500 行明细下「面板首屏渲染」<500ms（点击到两帧绘制完成，含取数）',
  firstPaint && !firstPaint.timeout && firstPaint.ms < 500, firstPaint);
// 第二次开合：数据已在缓存里，量的是纯重排/重绘——两数之差就是「500 行 × 3 输入框全量挂载」的净成本，
// 也是判断该不该上窗口化渲染的依据（只报一个总数说不清瓶颈在取数还是在渲染）
const repaint = await ev(`(async () => {
  ${PJ.replace(/\\n\\s*/g, ' ')}
  const btn=toggle();
  if(!btn) return { notoggle: 1 };
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
// T02299(3)：T02121 给明细段加了虚拟滚动（EstimatePanel.tsx:27 阈值 120，>120 行只渲染窗内），
// 旧判据「渲染录入行数 == 服务端明细条数」与 §9 性能红线（V-11 首屏 <500ms）互斥，永无复绿可能。
// 改判为三条同时成立，期望值全部来自服务端与面板自己的窗口化说明行，门里不写死 500/20 这类规模数字：
//   ① 面板自述「共 N 行」== 服务端明细条数（窗口化不缩口径）；
//   ② 实渲染行数 == 面板自述窗内行数 M（窗口数学与 DOM 一致，M 由面板自己声明、非门猜）；
//   ③ M < N 且 N 越过阈值 → 证明确实走的是窗口化路径且规模到位（不是数到 3 就交差）。
const v12 = await (async () => {
  const d = await rest(`/estimates?projectId=${BIG}`);
  const live = d.items.filter((i) => i.plan_kind !== 'milestone' && i.optimistic !== null);
  // 窗口化说明行按结构定位：虚拟列表（含数字录入框的 ul）的下一个兄弟节点；数字序为「总数 / 阈值 / 窗内数」
  const declared = await ev(PE`const el = p(); if (!el) return null;
    const ul = [...el.querySelectorAll('ul')].find((u) => u.querySelector('input[type="number"]'));
    const cap = ul && ul.nextElementSibling; if (!cap) return null;
    const ns = (String(cap.innerText).match(/\\d+/g) || []).map(Number);
    return ns.length >= 2 ? { total: ns[0], inWindow: ns[ns.length - 1], seq: ns } : null;`);
  const painted = firstPaint?.rows ?? 0;
  const inputs = firstPaint?.inputs ?? 0;
  evSet('v12', { total: live.length, painted, inputs });
  return { expected: live.length, painted, inputs, declared };
})();
console.log(`  [INFO] 服务端明细 ${v12.expected} 行 / 面板自述 ${v12.declared ? `共 ${v12.declared.total} 行、窗内 ${v12.declared.inWindow} 行` : '无窗口化说明行'} / 实渲染 ${v12.painted} 行（${v12.inputs} 个数字输入）`);
// 行为腿只看 DOM 与服务的规模关系；面板自述文案的解析结果只作证据（文案变更由 S-03 字面腿判定）
ok('V-12 窗口化确已触发：500 行明细下实渲染行数 >0 且 < 总行数，每个渲染行恰 3 个数字格（不再要求全量渲染）',
  v12.expected === 500 && v12.painted > 0 && v12.painted < v12.expected
  && v12.inputs === v12.painted * 3, v12);
if (v12.declared) {
  ok('V-12b 面板自述总行数 == 服务端明细条数，自述窗内行数 == DOM 实渲染行数（窗口数学与 DOM 一致）',
    v12.declared.total === v12.expected && v12.declared.inWindow === v12.painted, v12);
} else {
  skipped('V-12b 面板自述窗口数一致性', '窗口化自述文案未解析到——文案变更/改写在 S-03 字面腿判定，不把文案问题冒充行为失守');
}
let v13evidence = {};
ok('V-13 500 行下汇总卡读数 == 服务端 summary（按卡片结构定位，不认卡片文案）',
  await (async () => {
    const d = await rest(`/estimates?projectId=${BIG}`);
    const shown = await until(PE`const cs=sumCards(); if(cs.length<2) return '';
      const nums=(el)=>{ const main=el.children[1]||el; return (String(main.innerText).match(/-?\\d+(?:\\.\\d+)?/g)||[]).map(Number); };
      return {cards:cs.length, c0:nums(cs[0]), c1:nums(cs[1])};`, 20_000);
    const has = (arr, v) => Array.isArray(arr) && arr.some((x) => Math.abs(x - v) <= 0.011);
    v13evidence = { ...shown, serverP50: d.summary.quote.p50ManMonth, serverP84: d.summary.quote.p84ManMonth, serverIdeal: d.summary.idealManMonths.expected };
    return !!shown && shown.cards >= 2 && has(shown.c0, d.summary.quote.p50ManMonth)
      && has(shown.c0, d.summary.quote.p84ManMonth) && has(shown.c1, d.summary.idealManMonths.expected);
  })(), v13evidence);
await shot('v13-500rows-1440');

group('V-20 §10-13 三档视口 + 1100 覆盖式');
const vpProbe = () => ev(`(() => {
  ${PJ.replace(/\n\s*/g, ' ')}
  const el = p(); if (!el) return { nopanel: 1 };
  const r = el.getBoundingClientRect();
  const de = document.documentElement;
  const hscroll = de.scrollWidth > de.clientWidth + 1;
  const cards = (() => { const cs=sumCards(); return [cs[0], cs[2]].filter(Boolean); })();
  const rects = cards.map((x) => x.getBoundingClientRect());
  const overlap = rects.length > 1 && rects[0].left < rects[1].right && rects[1].left < rects[0].right && rects[0].top < rects[1].bottom && rects[1].top < rects[0].bottom;
  const ins = [...el.querySelectorAll('input[type="number"]')];
  const clipped = ins.filter((i) => { const b = i.getBoundingClientRect(); return b.right > r.right + 1 || b.left < r.left - 1; }).length;
  const tlWrap = window.__tlCol || el.closest('div[style*="display: flex"]')?.firstElementChild;
  if (tlWrap) window.__tlCol = tlWrap;
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
  await ev(`(() => { ${PJ.replace(/\n\s*/g, ' ')} const b=toggle(); if(!b) return 0; b.click(); return 1; })()`);
  await sleep(800);
  const closed = await ev(`(() => { const tl=window.__tlCol; return tl?Math.round(tl.getBoundingClientRect().width):-1; })()`);
  await ev(`(() => { ${PJ.replace(/\n\s*/g, ' ')} const b=toggle(); if(!b) return 0; b.click(); return 1; })()`);
  await sleep(600);
  // 抽屉开时锁 body 滚动 → 页面滚动条消失（Windows 15px），关闭后又回来；
  // 这两态差的是滚动条不是面板挤压，docked 挤压是数百 px 量级，故留 24px 容差仍保牙。
  return { panelOn: before, panelOff: closed, vp: s1100.innerW, delta: closed - before };
})();
ok('V-25 覆盖式下时间线主列宽度未被面板挤占（开态不窄于视口 60%，关闭态不因滚动条回落而窄于开态 24px 以上）',
  v25.panelOn > 0 && v25.panelOff > 0 && v25.panelOn >= v25.vp * 0.6 && v25.delta >= -24, v25);
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
    const cur = await ev(PE`const a=document.activeElement; if(!a) return null;
      return { tag:a.tagName, label:a.getAttribute('aria-label')||'', text:(a.textContent||'').trim().slice(0,12), inPanel: p()?p().contains(a):false };`);
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
evSet('kb', { ok: !!kb && kb.inputs >= visEn.length && visEn.length === 15, reached: kb?.inputs ?? null, need: visEn.length });
const unnamed = (inv || []).filter((x) => x.vis && !x.dis && !x.aria && !x.wrap);
ok('V-32 面板内每个可见录入控件都有可被读出的名字（aria-label，或包裹 label 的隐式名——两者皆无才算无名）',
  unnamed.length === 0, { unnamed, 无aria但靠label命名: (inv || []).filter((x) => x.vis && !x.aria && x.wrap).map((x) => x.wrap) });
// T02299(2)：66eb5cd（Sonar 治理）把面板三处 <div role="status"> 换成 <output aria-label=…>，
// <output> 的隐式 ARIA role 就是 status（读屏语义未丢，属等价重构），但只认显式属性的
// `[role="status"]` 恒为 0 → V-33 永红。选择器改「显式属性 + 原生等价元素」并集
// （与 memory 里 button,[role=button] 同一处理方式）；不回退他人的等价重构。
const roles = await ev(PE`const q=(s)=>p().querySelectorAll(s).length;
  return { aside: p().tagName.toLowerCase(), toolbar: q('[role="toolbar"]'), status: q('[role="status"], output'),
    img: q('[role="img"][aria-label]'), group: q('[role="group"]'), alert: q('[role="alert"]') };`);
ok('V-33 面板常驻语义标注在 DOM 上成立（aside + toolbar/status + 区间条 role=img 带 aria-label）',
  !!roles && roles.aside === 'aside' && roles.toolbar >= 1 && roles.status >= 1 && roles.img >= 1, roles);
// T02316：给 T02297 的静态字宽估算门补一条**真机度量校准**（零估算）。
// 静态门 verify-t02297-svg-bounds.mts 判「龙卷风图 σ 数值不越 viewBox」用的是估算字宽
// （CJK 1.0×字号、其余 0.55×字号），首轮曾因此假红过一次；本条用 `getBBox()` 量实际渲染宽度，
// viewBox 宽从各 SVG 自身属性读（不写死 480），越界即说明标签预留不再成立。
// T02293：不再按 aria-label 中文名挑龙卷风图，改为扫描面板内所有含数字标签的 SVG（更强的全量判据）。
const sigma = await ev(PE`
  const isNum = (s) => s.length > 0 && [...s].every((ch) => (ch >= '0' && ch <= '9') || ch === '.');
  const scan = [...p().querySelectorAll('svg')].map((svg) => {
    const vb = (svg.getAttribute('viewBox') || '').trim().split(' ').filter(Boolean).map(Number);
    const vbW = vb.length >= 3 ? vb[2] : NaN;
    const got = [...svg.querySelectorAll('text')]
      .map((t) => ({ text: (t.textContent || '').trim(), b: t.getBBox() }))
      .filter((x) => isNum(x.text))
      .map((x) => ({ text: x.text, x: +x.b.x.toFixed(2), width: +x.b.width.toFixed(2), right: +(x.b.x + x.b.width).toFixed(2) }));
    return { vbW, fontSize: svg.querySelector('text') ? getComputedStyle(svg.querySelector('text')).fontSize : null,
      count: got.length, maxRight: got.length ? Math.max(...got.map((g) => g.right)) : null,
      over: got.filter((g) => !(g.right <= vbW + 0.01)),
      worst: got.length ? got.find((g) => g.right === Math.max(...got.map((k) => k.right))) : null };
  }).filter((s) => s.count > 0);
  return { svgs: scan.length, labels: scan.reduce((a, s) => a + s.count, 0), bad: scan.filter((s) => !Number.isFinite(s.vbW) || s.over.length > 0), sample: scan.slice(0, 3) };`);
if (sigma && sigma.sample?.length) {
  for (const s of sigma.sample.filter((x) => x.worst)) {
    const est = (s.worst.text.length * 0.55 * (parseFloat(s.fontSize) || 9));
    console.log(`  [INFO] SVG 数字标签真机度量 vs T02297 静态估算：实测宽 ${s.worst.width} / 估算宽 ${est.toFixed(2)} / 差 ${(s.worst.width - est).toFixed(2)}px（viewBox 宽 ${s.vbW}，最右界 ${s.maxRight}，字号 ${s.fontSize}）`);
  }
}
ok('V-34 真机度量：面板内所有带数字标签的 SVG，其数字右界 ≤ 各自 viewBox 宽（T02297 静态估算的度量校准）',
  !!sigma && sigma.svgs > 0 && sigma.labels >= 3 && sigma.bad.length === 0, sigma);
await shot('v3x-keyboard-1440');

group('V-40 §12-R6 视图切换与刷新不动面板开合态');
const readSum = () => ev(PE`const cs=sumCards(); return cs.length?cs[0].innerText.replace(/\\s+/g,' '):'';`);
const r0 = await readSum();
const switchTo = async (idx) => {
  await ev(PE`const b=viewBtn(${idx}); if(!b) return 'nobtn'; b.click(); return 'clicked';`);
  await sleep(700);
  return ev(PE`return { view: sessionStorage.getItem('plan.viewMode'), open: sessionStorage.getItem('plan.estimatePanelOpen'),
    panel: !!p() };`);
};
evSet('viewSwitch', { list: false, gantt: false, back: false });
const vList = await switchTo(0);
evSet('viewSwitch', { ...EV.viewSwitch, list: !!(vList && /"list"/.test(vList.view) && vList.open === 'true') });
ok('V-41 切到列表视图：viewMode 变了而 estimatePanelOpen 没被改写（会话键分区）',
  vList && /"list"/.test(vList.view) && vList.open === 'true', vList);
const vGantt = await switchTo(1);
evSet('viewSwitch', { ...EV.viewSwitch, gantt: !!(vGantt && /"gantt"/.test(vGantt.view) && vGantt.open === 'true') });
ok('V-42 切到甘特视图同样只动 viewMode；页面不报错',
  vGantt && /"gantt"/.test(vGantt.view) && vGantt.open === 'true', vGantt);
await shot('v42-gantt');
const vBack = await switchTo(2);
evSet('viewSwitch', { ...EV.viewSwitch, back: !!(vBack && /"timeline"/.test(vBack.view)) && await until(PE`return !!p();`, 15000) === true });
ok('V-43 回时间线：面板自动回到打开态（开合态由键决定，不由视图决定）',
  vBack && /"timeline"/.test(vBack.view) && await until(PE`return !!p();`, 15000), vBack);
const r1 = await readSum();
ok('V-44 三圈切换后汇总读数不变（切换视图不重算、不掉数）', r0 && r0 === r1, { r0, r1 });
await ev(`(() => { location.reload(); return 1; })()`);
// T02299(3)：失败证据必须能定性——原写法把 back/same 折进 .then 后只回传 sessionStorage，
// 红的时候看不出是「面板没回来」还是「读数变了」。状态整个留住再判。
const v45 = await (async () => {
  await sleep(1500);
  await until(PE`return !!navBtn(4);`, 30000);
  await ev(PE`const b=navBtn(4); if(!b) return 0; b.click(); return 1;`);
  const back = await until(PE`return !!p();`, 20000);
  // aside 在场 ≠ 卡已出数：刷新后 summary 还要一轮请求，readSum 立刻取会拿到空串。
  // 等到读数非空再比，超时把「等了多久仍为空」如实写进证据（真丢数与拿太早可区分）。
  const waitFrom = Date.now();
  const rr = await until(PE`const cs=sumCards(); const s=cs.length?cs[0].innerText.replace(/\\s+/g,' '):''; return /\\d/.test(s)?s:'';`, 20000);
  const open = await ev(PE`return sessionStorage.getItem('plan.estimatePanelOpen');`);
  return { back, same: rr === r1, rr, r1, open, waitMs: Date.now() - waitFrom,
    aside: await ev(PE`return !!p();`) };
})();
ok('V-45 刷新后面板仍开且读数一致（§10-1「刷新后保持」）',
  !!v45.back && v45.same === true, v45);
await shot('v45-after-reload');

group('V-90 全程无脚本错误与服务端 5xx');
const pageErrs = await ev(`window.__errs || ['no-hook']`);
console.log(`  [INFO] window.__errs=${JSON.stringify(pageErrs).slice(0, 300)}`);
ok('V-91 页面无未捕获错误（window.__errs 为空）',
  Array.isArray(pageErrs) && (pageErrs.length === 0 || pageErrs[0] === 'no-hook'), pageErrs);
ok('V-92 走查期间无 /api 5xx 响应', netFail.length === 0, netFail.slice(0, 5));

// =====================================================================
// S 组：保留的产品文案锚一律降级为 okPair 的字面腿（T02293 判据 3）
//   行为腿＝真机量到的结构/状态（只读 EV）；字面腿＝已提交树里的文案
// =====================================================================
console.log('\n=== S 组：保留文案锚配对（行为失守⇒FAIL；行为在而锚失配⇒FAIL 交人判定） ===');
EV.ran = true;
for (const sp of S_SPECS) {
  okPair(ok, sp.L,
    () => sp.behavior(EV),
    () => literalOn(sp.src, sp.anchors),
    () => ({ 锚点: sp.anchors, 取证: sp.SRCLBL, 字面命中: sp.anchors.map((a) => sp.src.includes(a)),
      实测字段: Object.keys(EV).filter((k) => EV[k] != null).length }));
}

console.log('\n=== N 组：负对照（T02293 判据 4） ===');
{
  const vacuous = S_SPECS.filter((sp) => literalOn('', sp.anchors) === true);
  ok(`N-01 空源码探针：${S_SPECS.length} 条字面腿喂空串后全部为假（没有不承重的字面腿）`,
    S_SPECS.length === 4 && vacuous.length === 0, { 失配条目: vacuous.map((v) => v.L) });
  const missing = S_SPECS.filter((sp) => literalOn(sp.src, sp.anchors) !== true);
  ok(`N-01b HEAD 文本在场性：${S_SPECS.length} 组锚点在已提交树里逐字命中（不是拿不存在的老词比）`,
    missing.length === 0 && PLAN_HEAD.length > 400 && EP_HEAD.length > 400 && APP_HEAD.length > 400,
    { 未命中: missing.map((m) => ({ L: m.L, 锚: m.anchors.filter((a) => !m.src.includes(a)) })),
      PLAN_HEAD长度: PLAN_HEAD.length, EP_HEAD长度: EP_HEAD.length, APP_HEAD长度: APP_HEAD.length });
  const keep = { ...EV };
  for (const k of Object.keys(EV)) delete EV[k];
  const stillGreen = S_SPECS.filter((sp) => { try { return sp.behavior(EV) === true; } catch { return false; } }).map((sp) => sp.L);
  for (const [k, v] of Object.entries(keep)) EV[k] = v;
  ok(`N-02 敏感度探针：抽干运行期实测料（自证字段数清成 0）后 ${S_SPECS.length} 条行为腿全部转假——行为腿确实在读实测`,
    Object.keys(keep).length >= 6 && stillGreen.length === 0, { 清空后仍为真: stillGreen, 还原字段数: Object.keys(EV).length });
  const backFalse = S_SPECS.filter((sp) => sp.behavior(EV) !== true).map((sp) => sp.L);
  ok('N-02b 还原实证：实测料回填后同一批行为腿重新为真（N-02 的红不是恒红）', backFalse.length === 0, { 还原后仍为假: backFalse });
  const anchorSet = [...new Set(S_SPECS.flatMap((sp) => sp.anchors))];
  const n3Bad = [];
  for (const a of anchorSet) {
    const owner = S_SPECS.find((sp) => sp.anchors.includes(a));
    const tampered = owner.src.split(a).join('§§');
    if (tampered === owner.src) { n3Bad.push({ 锚: a, 因: '篡改未落地（副本==原件，等于没有牙）' }); continue; }
    if (literalOn(owner.src, [a]) !== true || literalOn(tampered, [a]) !== false) n3Bad.push({ 锚: a, 因: '同一条判据未按预期翻转' });
  }
  ok(`N-03 改名模拟：${anchorSet.length} 个锚点逐个从 HEAD 副本中抹掉后，字面判据各自转假（且每条自证 tampered !== original）`,
    anchorSet.length >= 6 && n3Bad.length === 0, { 锚点数: anchorSet.length, 失牙: n3Bad });
  const spy = [];
  okPair((n, c, e) => spy.push({ n, c, e }), 'N-04a 行为失守夹具', () => false, () => true);
  okPair((n, c, e) => spy.push({ n, c, e }), 'N-04b 锚点失配夹具', () => true, () => false);
  okPair((n, c, e) => spy.push({ n, c, e }), 'N-04c 双侧齐全', () => true, () => true);
  const reason = (x) => String(x?.e?.红因 ?? '');
  ok('N-04 okPair 落地：行为失守记「行为失守」、锚子失配记「字面锚点失配」、两者齐绿才判绿（两条红不是同一种红）',
    spy.length === 3 && spy[0].c === false && reason(spy[0]).includes('行为失守') && !reason(spy[0]).includes('字面锚点')
    && spy[1].c === false && reason(spy[1]).includes('字面锚点失配') && spy[2].c === true,
    spy.map((s) => ({ 条: s.n, 判: s.c, 红因: reason(s).slice(0, 40) })));
  const mut = (f) => { const e = JSON.parse(JSON.stringify(EV)); f(e); return e; };
  const broken = [];
  const cases = [
    ['S-01', mut((e) => { e.nav = false; })],
    ['S-02', mut((e) => { e.toggle = { found: false, opened: false }; })],
    ['S-03', mut((e) => { e.v12 = { total: 5, painted: 5, inputs: 15 }; })],
    ['S-04', mut((e) => { e.viewSwitch = { list: false, gantt: true, back: true }; })],
  ];
  for (const [id, e] of cases) {
    const sp = S_SPECS.find((s) => s.L.startsWith(id));
    if (!sp || sp.behavior(e) !== false) broken.push(id);
  }
  ok('N-05 破坏形态反证：四类实测料被改写（导航失败/开关失败/窗口化全量渲染/视图切换失败）后对应行为腿各自转假',
    broken.length === 0, { 未转假: broken });
}

console.log(`\n[INFO] 服务就绪耗时 ${upMs}ms（含夹具库首启）；截图 ${shotFiles.length} 张 → ${SHOTS}`);
console.log(`\nPASS=${pass} FAIL=${fail} SKIP=${skip}`);
process.exit(fail === 0 ? 0 : 1);
