#!/usr/bin/env node
/**
 * T02039（估算视图 E4 首段）真机走查：CDP 驱动 headless Chrome 打开**隔离实例**的时间线 + 估算面板，
 * 逐条取 PRD §10 里只能靠浏览器验收的口径（10-1 开合态刷新保持 / 10-2 全部计划行带来源徽标 /
 * 10-5 空态一键填充 / 10-13 1200·1440·1920 三档无横向滚动条、节点不重叠、文字不截断 + <1200 转覆盖式）。
 *
 * 为什么单独一个脚本：verify-t02039-estimate-e4a.mts 能把取数与「零计算」断言到逐字，
 * 但停靠宽度挤压、matchMedia 形态切换、会话态刷新保持都是**渲染层**的事，只有真实浏览器说得清。
 *
 * 用法（Chrome 用系统安装版；本仓内置 Browser 无视口不能点击/截图，见 memory）：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02039-e4-ui.mjs
 *   环境变量：T02039_UI_PORT（默认 39931）、T02039_UI_CDP（默认 9341）、T02039_UI_KEEP=1 保留截图目录
 *
 * 隔离纪律（skill 红线 8）：MTask_DATA_DIR 指临时目录、端口自配，不碰生产库与用户实例；
 * 退出连 Chrome 子进程树一起回收（taskkill /T），截图落 .t02039-shots/。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02039-e4ui-'));
const CHROME_PROFILE = mkdtempSync(join(tmpdir(), 't02039-chrome-'));
const SHOTS = join(ROOT, '.t02039-shots');
const PORT = Number(process.env.T02039_UI_PORT ?? 39931);
const CDP = Number(process.env.T02039_UI_CDP ?? 9341);
const CHROME = process.env.T02039_UI_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra).toString().slice(0, 300)}` : ''}`);
  }
};

// ---------------- 1) 夹具：临时库直写（进程内，起服务前完成） ----------------
process.env.MTask_DATA_DIR = DATA_DIR;
const { getDb, closeDb } = await import('../server/src/db/connection.ts');
const { initSchema } = await import('../server/src/db/schema.ts');
initSchema();
const T = '2026-10-11T00:00:00.000Z';
const PID = 'ui-e4';
const db = getDb();
db.prepare('INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
  .run(PID, 'T02039-面板走查', '', T, T);
const insPlan = db.prepare(
  `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
     progress, status, assignee, sort_order, created_at, updated_at, kind, complexity, req_ids, deps)
   VALUES (?, ?, ?, '', ?, ?, ?, 0, 'todo', '', ?, ?, ?, ?, ?, ?, ?)`,
);
// [id, title, dur, sort, kind, complexity, reqIds, deps]
const seeds = [
  ['ms-a', 'M-A 需求阶段', 6, 1, 'milestone', 4, [], null],
  ['u-cx', '需求分析', 5, 2, 'normal', 3, ['rq-1'], JSON.stringify([{ id: 'ms-a', type: 'child' }])],
  ['u-case', '系统设计', 4, 3, 'normal', null, ['rq-1'], JSON.stringify([{ id: 'ms-a', type: 'child' }])],
  ['ms-b', 'M-B 实施阶段', 8, 4, 'milestone', 5, [], null],
  ['u-dur', '开发联调', 7, 5, 'normal', null, [], JSON.stringify([{ id: 'ms-b', type: 'child' }])],
  ['u-cx2', '测试执行', 3, 6, 'normal', 2, [], JSON.stringify([{ id: 'ms-b', type: 'child' }])],
  ['u-arch', '归档行不应出现', 4, 7, 'normal', 3, [], null],
];
for (const [id, title, dur, sort, kind, cx, reqs, deps] of seeds) {
  insPlan.run(id, PID, title, '2026-10-12', '2026-10-12', dur, sort, T, T, kind, cx,
    reqs.length ? JSON.stringify(reqs) : null, deps);
}
db.prepare('UPDATE plan_tasks SET archived = 1, archived_at = ? WHERE id = ?').run(T, 'u-arch');
db.prepare(`INSERT INTO prd_requirements (id, project_id, req_no, title, content, source_ref, priority, status, sort_order, created_at, updated_at)
   VALUES (?, ?, ?, ?, '', '', 'normal', 'todo', 0, ?, ?)`).run('rq-1', PID, 'REQ-001', '面板需求编号列', T, T);
[['tc-1', 'P0'], ['tc-2', 'P1'], ['tc-3', 'P2']].forEach(([id, pri], i) => {
  db.prepare(`INSERT INTO test_cases (id, project_id, req_id, case_no, title, priority, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, PID, 'rq-1', `C-${i + 1}`, `用例${i + 1}`, pri, T, T);
});
closeDb();

// ---------------- 2) 隔离服务 ----------------
const { resolveServerLauncher } = await import(pathToFileURL(join(ROOT, 'scripts/isolated-server-launcher.mts')).href);
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const server = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT, env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR }, stdio: 'ignore',
});
console.log(`隔离实例启动器：${LAUNCHER.label}`);

// ---------------- 3) headless Chrome + CDP ----------------
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--no-first-run', '--disable-gpu',
  '--force-device-scale-factor=1', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  `--user-data-dir=${CHROME_PROFILE}`,
  '--window-size=1920,1080', 'about:blank',
], { stdio: 'ignore' });

const killTree = (pid) => { try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } };
const bye = () => { killTree(chrome.pid); killTree(server.pid); };
process.on('exit', bye);

let serverUp = false;
for (let i = 0; i < 90; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) { serverUp = true; break; } } catch { /* */ } await sleep(500); }
ok('U-00 隔离服务启动（临时端口 + 临时库）', serverUp);
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
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++seq; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
/** 轮询到条件成立（返回最后一次求值结果）——SPA 渲染与 fetch 回填都需要时间，不用固定 sleep 赌 */
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
let lastShotError = '';
async function shot(name) {
  mkdirSync(SHOTS, { recursive: true });
  await send('Page.bringToFront');
  // headless 下切视口后首帧可能还没合成，重试两轮再认输
  for (let i = 0; i < 3; i++) {
    // CDP 回包是整条消息，截图在 result.data（读 r.data 会静默拿到 undefined）
    const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const b64 = r.result && r.result.data;
    if (b64) {
      const file = join(SHOTS, `${name}.png`);
      writeFileSync(file, Buffer.from(b64, 'base64'));
      shotFiles.push(`${name}.png`);
      return file;
    }
    lastShotError = JSON.stringify(r.error || r).slice(0, 200);
    await sleep(700);
  }
  return '';
}

await send('Page.enable');
// 会话态注入：只种「项目 + 时间线视图」，**故意不种面板开合键**——§10-1 要验的就是它自己记住。
// 向导（首次进入自动弹出）在走查里是纯噪声：它盖住面板会让截图失去意义，故预先标记为已看。
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try {
    sessionStorage.setItem('plan.projectId', JSON.stringify(${JSON.stringify(PID)}));
    sessionStorage.setItem('plan.viewMode', JSON.stringify('timeline'));
    localStorage.setItem('mtask.projectGuide.seen', '1');
    ['tasks', 'aitools', 'prompts', 'req', 'plan', 'report', 'history', 'queue', 'exec-sessions', 'settings']
      .forEach((t) => localStorage.setItem('mtask.guide.seen.' + t, '1'));
  } catch (e) {}`,
});
await send('Page.navigate', { url: `${BASE}/?m=0` });
ok('U-02 页面加载完成（桌面 UI）', await until(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '项目管理');
  return !!b;
})()`), 'nav 按钮缺失');

// 进入项目管理 → 时间线渲染（viewMode 由注入的会话态直接生效）
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '项目管理'); b?.click(); return 1; })()`);
ok('U-03 时间线视图已渲染（viewMode 会话态生效，含里程碑节点）',
  await until(`!!document.querySelector('[aria-label="计划时间线"] [data-tl="ms"]')`));
const tlCount = await ev(`document.querySelectorAll('[data-tl="ms"],[data-tl="item"]').length`);
ok('U-04 时间线可见节点=未归档计划数（6 条：2 里程碑 + 4 普通，归档行不在）', tlCount === 6, tlCount);
ok('U-04b 无首次向导浮层遮挡（走查取证看的是面板本身）',
  await until(`!document.body.innerText.includes('认识「项目管理」')`, 5_000));

// ---------------- 4) 面板开合（§10-1） ----------------
// 先显式定视口：不设的话 headless 窗口宽度含滚动条，420 的对账会漂几 px，断言就成了猜
await setViewport(1920, 1000);
ok('U-05 默认关闭：时间线旁无估算面板', await until(`(() => !document.querySelector('aside[aria-label="估算面板"]'))()`, 3000));
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.title || '').includes('打开估算面板')); b?.click(); return !!b; })()`);
const panelGeom = await until(`(() => {
  const a = document.querySelector('aside[aria-label="估算面板"]');
  if (!a) return '';
  return JSON.stringify({ box: Math.round(a.getBoundingClientRect().width), inner: a.clientWidth, vw: window.innerWidth });
})()`);
ok('U-06 工具条按钮打开面板（1920 停靠为 aside，列宽 420 ± 2 内含 box-sizing 差异）',
  !!panelGeom && (() => {
    const g = JSON.parse(panelGeom);
    return Math.abs(g.box - 420) <= 2 && Math.abs(g.inner - 420) <= 2 && g.vw >= 1900;
  })(), panelGeom);
ok('U-07 面板数据加载完成（汇总卡读数 20.83 人天/人月 来自服务端 params）',
  await until(`document.querySelector('aside[aria-label="估算面板"]').innerText.includes('20.83 人天/人月')`));
const mode1920 = await ev(`(() => {
  const tl = document.querySelector('[aria-label="计划时间线"]');
  const a = document.querySelector('aside[aria-label="估算面板"]');
  return { tlW: Math.round(tl.getBoundingClientRect().width), aside: !!a, dialog: !!document.querySelector('[role="dialog"][aria-modal="true"]') };
})()`);
ok('U-08 分栏共存：面板 420 挤压时间线，但时间线仍有可视宽度且未退化成抽屉',
  mode1920.aside && !mode1920.dialog && mode1920.tlW > 400, mode1920);

// ---------------- 5) 空态一键填充（§10-5） ----------------
ok('U-09 空态：一条估算都没有时给出「按规则推导」入口',
  await until(`(() => {
    const a = document.querySelector('aside[aria-label="估算面板"]');
    return !!a && a.innerText.includes('尚未录入估算') && [...a.querySelectorAll('button')].some(b => b.textContent.includes('按规则推导'));
  })()`));
await ev(`(() => { const a = document.querySelector('aside[aria-label="估算面板"]'); [...a.querySelectorAll('button')].find(b => b.textContent.includes('按规则推导'))?.click(); return 1; })()`);
// 确认弹窗正文要在点掉之前抓（点完就卸载了）；确认按钮口径与 T01698 探针一致
const confirmText = await until(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || '') === '确定：确认执行该操作');
  if (!b) return '';
  const box = b.closest('[role="dialog"]') || (b.parentElement && b.parentElement.parentElement);
  const txt = box ? box.innerText : '';
  return txt.length > 20 ? txt : '';
})()`);
ok('U-10 写入前 askConfirm 二次确认（项目对话框，非原生 confirm）+ 文案点明行数与 k 取值',
  typeof confirmText === 'string' && confirmText.includes('写入 4 行') && confirmText.includes('k='),
  (confirmText || '').slice(0, 200));
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || '') === '确定：确认执行该操作'); b?.click(); return !!b; })()`);
const toast = await until(`document.body.innerText.includes('已按规则推导写入')`, 15_000);
ok('U-11 确认后落库并回传 toast（按钮文案的行数与服务端写入行数同源）', toast === true, toast);
const restAfter = await (await fetch(`${BASE}/api/estimates?projectId=${PID}`)).json();
ok('U-12 界面写入 = 服务端真落库（items 4 行、全 source=rule、里程碑未落）',
  restAfter.items.length === 4 && restAfter.items.every((i) => i.source === 'rule') && !restAfter.items.some((i) => i.plan_id === 'ms-a'),
  { n: restAfter.items.length, sources: restAfter.items.map((i) => [i.plan_id, i.source]) });

// ---------------- 6) 全部计划行带来源徽标（§10-2） ----------------
const rowInfo = await ev(`(() => {
  const a = document.querySelector('aside[aria-label="估算面板"]');
  const txt = a.innerText;
  const titles = ['需求分析', '系统设计', '开发联调', '测试执行'];
  const badges = [...a.querySelectorAll('span[title]')].map(s => s.textContent.trim()).filter(t => /人工|规则|默认|未录入/.test(t));
  return {
    allTitles: titles.every(t => txt.includes(t)),
    badgeCount: badges.length,
    ruleBadges: badges.filter(t => t === '规则').length,
    milestoneIn: txt.includes('M-A 需求阶段') && txt.includes('不进 Σ'),
    reqNo: txt.includes('REQ-001'),
    cx: txt.includes('复杂度 3'),
    groups: [...a.querySelectorAll('[role="button"]')].length,
  };
})()`);
ok('U-13 明细覆盖全部可见计划（4 普通行全部在列 + 徽标各就各位）',
  rowInfo.allTitles && rowInfo.ruleBadges === 4 && rowInfo.badgeCount === 4, rowInfo);
ok('U-14 里程碑行常驻并显式标注「不进 Σ」（分组复用时间线口径，未另造第三套）',
  rowInfo.milestoneIn && rowInfo.groups === 2, rowInfo);
ok('U-15 需求编号列与复杂度列出自现成接口（REQ-001 反查 + plan.complexity 投影）',
  rowInfo.reqNo && rowInfo.cx, rowInfo);

// ---------------- 7) 刷新保持（§10-1 会话级） ----------------
// 刷新后 tab 回到默认页（App 的 tab 是内存态，不持久化），所以要重新进入项目管理页——
// 这正是 §10-1 的口径：面板开合跟着会话走，跨刷新/跨切页都在，而不是跟着某一次挂载。
await send('Page.navigate', { url: `${BASE}/?m=0` });
await until(`[...document.querySelectorAll('button')].some(x => x.textContent.trim() === '项目管理')`, 25_000);
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '项目管理'); b?.click(); return !!b; })()`);
ok('U-16 刷新并重新进入页面后面板仍打开：开合态由 sessionStorage 恢复',
  await until(`!!document.querySelector('aside[aria-label="估算面板"] [role="button"]')`, 25_000));
const persist = await ev(`JSON.stringify({
  session: sessionStorage.getItem('plan.estimatePanelOpen'),
  local: localStorage.getItem('plan.estimatePanelOpen'),
})`);
ok('U-17 口径为「会话级」而非跨会话：sessionStorage 有值、localStorage 无值',
  persist === JSON.stringify({ session: 'true', local: null }), persist);

// ---------------- 8) §10-13 三档视口 + 窄屏转覆盖式 ----------------
const clipExpr = `(() => {
  // dialog 只认「正文含估算面板读数」的那个 —— 否则任何浮层（向导/抽屉）都能把断言喂成假绿
  const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
    .filter(d => d.innerText.includes('实际预估人月'));
  const a = document.querySelector('aside[aria-label="估算面板"]') || dialogs[0];
  if (!a) return { missing: true };
  const leaves = [...a.querySelectorAll('*')].filter(e => e.children.length === 0 && e.textContent.trim());
  const clipped = leaves.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent.trim().slice(0, 24));
  const de = document.documentElement;
  const nodes = [...document.querySelectorAll('[data-tl="ms"],[data-tl="item"]')].filter(n => n.offsetParent !== null)
    .map(n => n.getBoundingClientRect());
  let overlap = 0;
  for (let i = 1; i < nodes.length; i++) if (nodes[i].top < nodes[i - 1].bottom - 1) overlap++;
  return {
    innerW: window.innerWidth,
    hScroll: de.scrollWidth > de.clientWidth + 1,
    panelHScroll: a.scrollWidth > a.clientWidth + 1,
    clipped, overlap,
    tlW: Math.round((document.querySelector('[aria-label="计划时间线"]') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width),
    aside: !!document.querySelector('aside[aria-label="估算面板"]'),
    dialog: dialogs.length > 0,
  };
})()`;
for (const w of [1920, 1440, 1200]) {
  await setViewport(w, 1000);
  await sleep(600);
  const r = await until(`(() => { const x = (${clipExpr}); return x.innerW === ${w} ? x : null; })()`, 12_000);
  ok(`U-18[${w}] ${w}px 走查：停靠式、无横向滚动条、时间线节点不重叠、面板内文字不截断`,
    r && r.aside && !r.dialog && !r.hScroll && !r.panelHScroll && r.overlap === 0 && r.clipped.length === 0 && r.tlW > 300, r);
  await shot(`viewport-${w}`);
}
await setViewport(1100, 900);
await sleep(600);
const narrow = await until(`(() => {
  const x = (${clipExpr});
  return x.innerW === 1100 && !x.aside && x.dialog ? x : null;
})()`, 12_000);
ok('U-19 1100px（<1200）自动转覆盖式抽屉：aside 退场、dialog 接管，且仍不产生横向滚动条',
  narrow && narrow.dialog && !narrow.aside && !narrow.hScroll && narrow.clipped.length === 0, narrow);
await shot('viewport-1100-overlay');
// 覆盖式不应抢走时间线宽度（抽屉浮在之上）
const overlayTl = await ev(`Math.round(document.querySelector('[aria-label="计划时间线"]').getBoundingClientRect().width)`);
ok('U-20 覆盖式下时间线回到全宽（抽屉叠加而非挤压）', overlayTl > 700, overlayTl);

// 关闭态：再点工具条按钮收起
await setViewport(1440, 1000);
await sleep(500);
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.title || '').includes('收起估算面板')); b?.click(); return !!b; })()`);
ok('U-21 工具条再次点击收起面板（开/合同一按钮，状态回写 sessionStorage）',
  await until(`(() => !document.querySelector('aside[aria-label="估算面板"]'))()`, 8000)
  && (await ev(`sessionStorage.getItem('plan.estimatePanelOpen')`)) === 'false');
await shot('viewport-1440-closed');
ok('U-22 走查截图取证齐全（三档停靠 + 覆盖式 + 收起态）', shotFiles.length === 5, { shotFiles, lastShotError });

console.log(`\n截图：${SHOTS}`);
// 回收顺序：先收 Chrome 进程树（CrashpadMetrics 被占用时 rmSync 会 EBUSY），再删临时目录；
// 临时目录删不掉不影响结论，留痕即可（都在 %TEMP% 下，不是生产数据）。
ws.close();
killTree(chrome.pid);
killTree(server.pid);
await sleep(2_500);
const rmdir = (p) => { try { rmSync(p, { recursive: true, force: true }); } catch (e) { console.log(`  [清理留痕] ${p} 未删净：${e.code}`); } };
if (!process.env.T02039_UI_KEEP) rmSync(SHOTS, { recursive: true, force: true });
await rmdir(CHROME_PROFILE);
await rmdir(DATA_DIR);
console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
