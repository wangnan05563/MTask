#!/usr/bin/env node
/**
 * T02039（估算视图 E4 首段）真机走查：CDP 驱动 headless Chrome 打开**隔离实例**的时间线 + 估算面板，
 * 逐条取 PRD §10 里只能靠浏览器验收的口径（10-1 开合态刷新保持 / 10-2 全部计划行带来源徽标 /
 * 10-5 空态一键填充 / 10-13 1200·1440·1920 三档无横向滚动条、节点不重叠、文字不截断 + <1200 转覆盖式）。
 *
 * 为什么单独一个脚本：verify-t02039-estimate-e4a.mts 能把取数与「零计算」断言到逐字，
 * 但停靠宽度挤压、matchMedia 形态切换、会话态刷新保持都是**渲染层**的事，只有真实浏览器说得清。
 *
 * T02293 改判（`docs/验收门判据规约.md`）：
 *  - U 组只留行为/几何/库/DOM 结构判据（宽度带、开合、写入行数、会话键、视口溢出）；
 *  - 产品中文文案一律降级为 S 组的 `okPair` 字面腿，取证面 `git show HEAD:`（反模式 11），
 *    行为失守与「文字改了但功能还在」两种红因分开落账；
 *  - 期望数字全部由门内夹具/服务端读数派生（不写死 6/4/20.83）；
 *  - N 组负对照：空源码探针、HEAD 在场性、逐锚改名模拟、抽干实测料、okPair 契约、行为腿篡改。
 *
 * 用法（Chrome 用系统安装版；本仓内置 Browser 无视口不能点击/截图，见 memory）：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02039-e4-ui.mjs
 *   环境变量：T02039_UI_PORT（默认 39931）、T02039_UI_CDP（默认 9341）、T02039_UI_KEEP=1 保留截图目录
 *
 * 隔离纪律（skill 红线 8）：MTask_DATA_DIR 指临时目录、端口自配，不碰生产库与用户实例；
 * 临时根优先落 D:（C: 常年 0 可用会假性 SQLITE_FULL）；退出连 Chrome 子进程树一起回收（taskkill /T），
 * 截图落每轮独立子目录（`MTASK_GATE_ARTIFACT_DIR/<门名>-<运行标识>/`，T02312）。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP_ROOT = existsSync('D:/code/tmp') ? 'D:/code/tmp' : tmpdir();
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't02039-e4ui-'));
const CHROME_PROFILE = mkdtempSync(join(TMP_ROOT, 't02039-chrome-'));
const { gateShotsDir, writeGateResults } = await import(pathToFileURL(join(ROOT, 'scripts/lib/gate-results.mts')).href);
const { okPair } = await import(pathToFileURL(join(ROOT, 'scripts/lib/anchor-pair.mts')).href);
// 截图根同样落 D:（gateShotsDir 默认 tmpdir()，本机 TMP 指 C: 常年 0 可用）
if (!process.env.MTASK_GATE_ARTIFACT_DIR) process.env.MTASK_GATE_ARTIFACT_DIR = join(TMP_ROOT, 'mtask-gate-shots');
const SHOTS = gateShotsDir('t02039');
const OUT_DIR = join(ROOT, '.workbuddy');
const OUT_BASE = 't02039-e4-ui-gate-results.txt';
const PORT = Number(process.env.T02039_UI_PORT ?? 39931);
const CDP = Number(process.env.T02039_UI_CDP ?? 9341);
const CHROME = process.env.T02039_UI_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0;
const lines = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; lines.push(`[PASS] ${name}`); console.log(`  [PASS] ${name}`); } else {
    fail += 1;
    const tail = extra !== undefined ? ` -> ${JSON.stringify(extra).toString().slice(0, 400)}` : '';
    lines.push(`[FAIL] ${name}${tail}`);
    console.log(`  [FAIL] ${name}${tail}`);
  }
};

/** 反模式 11：字面腿取已提交树（工作树可能躺着别的会话的过期产品文件） */
function headSource(rel) {
  try { return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }); } catch { return ''; }
}
const SRC = {
  app: headSource('web/src/App.tsx'),
  plan: headSource('web/src/pages/PlanPage.tsx'),
  ep: headSource('web/src/components/EstimatePanel.tsx'),
  guide: headSource('web/src/pages/ProjectGuide.tsx'),
  timeline: headSource('web/src/components/PlanTimeline.tsx'),
  dialogs: headSource('web/src/ui/dialogs.tsx'),
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
// T02315：期望值由夹具自身派生（门内自证），不在判据里写死「6」「4」「2」。
// 归档行 u-arch 不在可见口径内，故排除。
const visibleSeeds = seeds.filter(([id]) => id !== 'u-arch');
const FIXTURE = {
  rows: visibleSeeds.length,                                              // 可见计划行 = 应带来源徽标的行数
  milestones: visibleSeeds.filter((s) => s[4] === 'milestone').length,    // 分组表头数
  normals: visibleSeeds.filter((s) => s[4] === 'normal').length,          // 「按规则推导」应写入的行数
  cxValues: visibleSeeds.filter((s) => s[4] === 'normal' && s[5] != null).map((s) => String(s[5])),
};
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
      shotFiles.push(file);
      return file;
    }
    lastShotError = JSON.stringify(r.error || r).slice(0, 200);
    await sleep(700);
  }
  return '';
}

/** 运行期实测料：S 组行为腿只读它（反模式 14：实测组跑完再统一发射） */
const EV = { ran: false };
const S_SPECS = [];

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

// 导航按钮只作为点击入口（驱动）；文案本身进 S-01 的字面腿
const navProbe = await until(`(() => {
  const btns = [...document.querySelectorAll('button')];
  const b = btns.find(x => x.textContent.trim() === '项目管理');
  return b ? { buttons: btns.length } : null;
})()`);
EV.nav = { buttons: navProbe?.buttons ?? 0, clicked: false };
ok('U-02 页面加载完成（桌面 UI：导航按钮组在场）', !!navProbe && EV.nav.buttons >= 5, navProbe);
EV.nav.clicked = (await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '项目管理');
  b?.click();
  return !!b;
})()`)) === true;
S_SPECS.push({
  L: 'S-01 导航「项目管理」可点且落到时间线（行为腿：按钮组在场 + 点击后节点数与夹具一致）',
  anchors: ['项目管理'], src: SRC.app, srcLbl: 'web/src/App.tsx',
  behavior: (e) => e.nav?.buttons >= 5 && e.nav.clicked === true && e.timeline?.nodes === FIXTURE.rows,
  literal: (src) => src.length > 0 && src.includes('项目管理'),
});
EV.timeline = { visible: !!(await until(`!!document.querySelector('[aria-label="计划时间线"] [data-tl="ms"]')`)) };
ok('U-03 时间线视图已渲染（viewMode 会话态生效，含里程碑节点）', EV.timeline.visible);
const tlCount = await ev(`document.querySelectorAll('[data-tl="ms"],[data-tl="item"]').length`);
EV.timeline.nodes = tlCount;
ok(`U-04 时间线可见节点=未归档计划数（${FIXTURE.rows} 条，归档行不在）`, tlCount === FIXTURE.rows, tlCount);
// 向导是原生 <dialog open>：结构化探针不依赖文案（文案进 S-03 字面腿）
EV.guideAbsent = (await until(`!document.querySelector('dialog[open]')`, 5_000)) === true;
ok('U-04b 无首次向导浮层遮挡（原生 dialog 未打开）', EV.guideAbsent === true);
S_SPECS.push({
  L: 'S-02 时间线区域 aria-label「计划时间线」（行为腿：区域在场且节点数=夹具可见行）',
  anchors: ['计划时间线'], src: SRC.timeline, srcLbl: 'web/src/components/PlanTimeline.tsx',
  behavior: (e) => e.timeline?.visible === true && e.timeline?.nodes === FIXTURE.rows,
  literal: (src) => src.length > 0 && src.includes('计划时间线'),
});
S_SPECS.push({
  L: 'S-03 向导标题「认识「项目管理」」（行为腿：走查全程未弹原生 dialog）',
  anchors: ['认识「项目管理」'], src: SRC.guide, srcLbl: 'web/src/pages/ProjectGuide.tsx',
  behavior: (e) => e.guideAbsent === true,
  literal: (src) => src.length > 0 && src.includes('认识「项目管理」'),
});

// ---------------- 4) 面板开合（§10-1） ----------------
// 先显式定视口：不设的话 headless 窗口宽度含滚动条，与声明宽度的对账会漂几 px，断言就成了猜
await setViewport(1920, 1000);
const closedByDefault = (await until(`(() => !document.querySelector('aside[aria-label="估算面板"]'))()`, 3000)) === true;
const toggleFound = (await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.title || '').includes('打开估算面板')); b?.click(); return !!b; })()`)) === true;
ok('U-05 默认关闭：时间线旁无估算面板，工具条开关可点', closedByDefault && toggleFound, { closedByDefault, toggleFound });
const panelGeom = await until(`(() => {
  const a = document.querySelector('aside[aria-label="估算面板"]');
  if (!a) return '';
  return JSON.stringify({ box: Math.round(a.getBoundingClientRect().width), inner: a.clientWidth, vw: window.innerWidth });
})()`);
const geom = panelGeom ? JSON.parse(panelGeom) : null;
EV.panel = { initiallyClosed: closedByDefault, toggleFound, opened: !!geom, geom, docked: false };
// T02315/T02293：停靠宽度以**设计带宽**为行为判据（下限 300：低于它区间条与徽标列会截断；
// 上限 760：再宽会把 1200 断点下的时间线挤没，U-18 要求时间线可视宽度）。具体常量值由 S-05 的字面腿
// 与实现声明对账——设计调整时行为腿照样成立，只有声明与渲染脱节才红。
const geomOk = !!geom && Math.abs(geom.box - geom.inner) <= 2
  && geom.box >= 300 && geom.box <= 760 && geom.vw >= 1900;
ok('U-06 工具条按钮打开面板（1920 停靠为 aside，宽度落设计带宽 [300,760] 且内外宽一致）',
  geomOk, { geom });
const rateProbe = await until(`(() => {
  const a = document.querySelector('aside[aria-label="估算面板"]');
  if (!a) return null;
  const m = a.innerText.match(/([\\d.]+)\\s*人天\\/人月/);
  return m ? { dom: Number(m[1]), text: m[0] } : null;
})()`);
const estServer = await (await fetch(`${BASE}/api/estimates?projectId=${PID}`)).json().catch(() => null);
EV.rate = {
  server: Number(estServer?.params?.config?.manDaysPerManMonth),
  dom: rateProbe?.dom ?? null,
  text: rateProbe?.text ?? '',
};
ok('U-07 面板数据加载完成（汇总卡的人天/人月读数与服务端 params 同值，非门内写死）',
  Number.isFinite(EV.rate.server) && EV.rate.server > 0 && EV.rate.dom === EV.rate.server,
  { server: EV.rate.server, dom: EV.rate.dom, text: EV.rate.text });
S_SPECS.push({
  L: 'S-04 工具条「打开估算面板 / 收起估算面板」与 aside aria-label「估算面板」（行为腿：默认关→开→dock→收起+会话键）',
  anchors: ['打开估算面板', '收起估算面板', '估算面板'], src: SRC.plan, srcLbl: 'web/src/pages/PlanPage.tsx',
  behavior: (e) => e.panel?.initiallyClosed === true && e.panel?.opened === true
    && e.panel?.docked === true && e.closed?.asideGone === true && e.closed?.session === 'false',
  literal: (src) => src.length > 0 && src.includes('打开估算面板') && src.includes('收起估算面板') && src.includes('估算面板'),
});
S_SPECS.push({
  L: 'S-05 停靠宽度常量 ESTIMATE_PANEL_WIDTH（行为腿：带宽/内外宽；字面腿：声明值与 DOM 实测宽 ±2）',
  anchors: ['ESTIMATE_PANEL_WIDTH'], src: SRC.ep, srcLbl: 'web/src/components/EstimatePanel.tsx',
  behavior: (e) => !!e.panel?.geom && Math.abs(e.panel.geom.box - e.panel.geom.inner) <= 2
    && e.panel.geom.box >= 300 && e.panel.geom.box <= 760 && e.panel.geom.vw >= 1900
    && e.panel?.tlW > 400,
  literal: (src, e) => {
    const m = src.match(/export const ESTIMATE_PANEL_WIDTH\s*=\s*(\d+)/);
    return !!m && !!e.panel?.geom && Math.abs(e.panel.geom.box - Number(m[1])) <= 2;
  },
});
S_SPECS.push({
  L: 'S-06 汇总卡单位「人天/人月」（行为腿：DOM 读=服务端 params；字面腿：源码含单位且渲染串精确）',
  anchors: ['人天/人月'], src: SRC.ep, srcLbl: 'web/src/components/EstimatePanel.tsx',
  behavior: (e) => Number.isFinite(e.rate?.server) && e.rate.server > 0 && e.rate.dom === e.rate.server,
  literal: (src, e) => src.length > 0 && src.includes('人天/人月')
    && Number.isFinite(e.rate?.server) && String(e.rate?.text ?? '').includes(`${e.rate.server} 人天/人月`),
});
const mode1920 = await ev(`(() => {
  const tl = document.querySelector('[aria-label="计划时间线"]');
  const a = document.querySelector('aside[aria-label="估算面板"]');
  return { tlW: Math.round(tl.getBoundingClientRect().width), aside: !!a, dialog: !!document.querySelector('[role="dialog"][aria-modal="true"]') };
})()`);
EV.panel.docked = !!mode1920?.aside && !mode1920?.dialog;
EV.panel.tlW = mode1920?.tlW ?? 0;
ok('U-08 分栏共存：面板按声明宽度挤压时间线，但时间线仍有可视宽度且未退化成抽屉',
  EV.panel.docked && EV.panel.tlW > 400, mode1920);

// ---------------- 5) 空态一键填充（§10-5） ----------------
const emptyProbe = await until(`(() => {
  const a = document.querySelector('aside[aria-label="估算面板"]');
  if (!a) return null;
  const btn = [...a.querySelectorAll('button')].find(b => b.textContent.includes('按规则推导'));
  return btn ? { introPresent: a.innerText.includes('尚未录入估算'), fillBtn: true } : null;
})()`);
EV.empty = { introPresent: emptyProbe?.introPresent === true, fillBtn: !!emptyProbe };
ok('U-09 空态：服务端无估算行且「按规则推导」入口可点（文案进 S-07 字面腿）',
  EV.empty.fillBtn && Array.isArray(estServer?.items) && estServer.items.length === 0,
  { empty: EV.empty, serverItems: estServer?.items?.length });
S_SPECS.push({
  L: 'S-07 空态文案「尚未录入估算」+ 入口「按规则推导」（行为腿：入口可点且点后弹确认）',
  anchors: ['尚未录入估算', '按规则推导'], src: SRC.ep, srcLbl: 'web/src/components/EstimatePanel.tsx',
  behavior: (e) => e.empty?.fillBtn === true && e.confirm?.opened === true,
  literal: (src, e) => src.length > 0 && src.includes('尚未录入估算') && src.includes('按规则推导')
    && e.empty?.introPresent === true,
});
await ev(`(() => { const a = document.querySelector('aside[aria-label="估算面板"]'); [...a.querySelectorAll('button')].find(b => b.textContent.includes('按规则推导'))?.click(); return 1; })()`);
// 确认弹窗正文要在点掉之前抓（点完就卸载了）；确认按钮口径与 T01698 探针一致
const confirmProbe = await until(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || '') === '确定：确认执行该操作');
  if (!b) return null;
  const box = b.closest('[role="dialog"]') || (b.parentElement && b.parentElement.parentElement);
  return { text: (box && box.innerText ? box.innerText : '').slice(0, 600) };
})()`);
EV.confirm = { opened: !!confirmProbe, text: confirmProbe?.text ?? '' };
ok('U-10 写入前弹项目确认框（非原生 confirm；确认按钮在场）', EV.confirm.opened, EV.confirm.text.slice(0, 200));
S_SPECS.push({
  L: 'S-08 推导确认文案「写入 N 行」「k=…」（行为腿：确认框在场且点击后写入行数=夹具普通行数；字面腿：N 与库内同源）',
  anchors: ['k='], src: SRC.ep, srcLbl: 'web/src/components/EstimatePanel.tsx',
  behavior: (e) => e.confirm?.opened === true && e.write?.rows === FIXTURE.normals,
  literal: (src, e) => src.length > 0 && src.includes('k=')
    && String(e.confirm?.text ?? '').includes(`写入 ${FIXTURE.normals} 行`)
    && String(e.confirm?.text ?? '').includes('k='),
});
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || '') === '确定：确认执行该操作'); b?.click(); return !!b; })()`);
const toastText = await until(`(() => { const o = document.querySelector('output.flash-toast'); const t = o ? o.textContent.trim() : ''; return t || null; })()`, 15_000);
EV.write = { toastText: String(toastText ?? '') };
ok('U-11 确认后回传 toast（界面反馈在场）', EV.write.toastText.length > 0, EV.write.toastText);
const restAfter = await (await fetch(`${BASE}/api/estimates?projectId=${PID}`)).json();
EV.write.rows = restAfter.items.length;
EV.write.allRule = restAfter.items.every((i) => i.source === 'rule');
ok(`U-12 界面写入 = 服务端真落库（items ${FIXTURE.normals} 行、全 source=rule、里程碑未落）`,
  EV.write.rows === FIXTURE.normals && EV.write.allRule && !restAfter.items.some((i) => i.plan_id === 'ms-a'),
  { n: EV.write.rows, sources: restAfter.items.map((i) => [i.plan_id, i.source]) });
S_SPECS.push({
  L: 'S-09 写入 toast「已按规则推导写入」（行为腿：toast 在场且库内行数=夹具普通行数）',
  anchors: ['已按规则推导写入'], src: SRC.ep, srcLbl: 'web/src/components/EstimatePanel.tsx',
  behavior: (e) => e.write?.toastText.length > 0 && e.write?.rows === FIXTURE.normals,
  literal: (src, e) => src.length > 0 && src.includes('已按规则推导写入')
    && String(e.write?.toastText ?? '').includes('已按规则推导写入'),
});

// ---------------- 6) 全部计划行带来源徽标（§10-2） ----------------
const rowInfo = await ev(`(() => {
  const a = document.querySelector('aside[aria-label="估算面板"]');
  const txt = a.innerText;
  const titles = ${JSON.stringify(visibleSeeds.map((s) => s[1]))};
  const badges = [...a.querySelectorAll('span[title]')].map(s => s.textContent.trim()).filter(t => /人工|规则|默认|未录入/.test(t));
  const cxVals = ${JSON.stringify(FIXTURE.cxValues)}.filter(v => txt.includes('复杂度 ' + v));
  return {
    allTitles: titles.every(t => txt.includes(t)),
    badgeCount: badges.length,
    ruleBadges: badges.filter(t => t === '规则').length,
    // T02315：里程碑折叠表头自 S6819 起是原生 button（隐式 role，无显式 role 属性），
    // 改为「原生 + 显式」并集，并按可访问语义（阶段折叠 title）圈定表头，避免把工具条按钮算进来。
    groups: [...a.querySelectorAll('button,[role="button"]')]
      .filter(b => /阶段明细/.test(b.getAttribute('title') || '')).length,
    sigmaMarks: [...a.querySelectorAll('*')].filter(e => !e.children.length && e.textContent.trim() === '不进 Σ').length,
    reqNo: txt.includes('REQ-001'),
    cxAll: cxVals.length === ${FIXTURE.cxValues.length},
    cxSeen: cxVals,
  };
})()`);
EV.badges = rowInfo;
ok('U-13 明细覆盖全部可见计划（每条可见计划行各一枚来源徽标）',
  rowInfo.allTitles && rowInfo.badgeCount === FIXTURE.rows, rowInfo);
ok('U-14 里程碑折叠表头数=夹具里程碑数（「不进 Σ」标注数进 S-11 字面腿）',
  rowInfo.groups === FIXTURE.milestones, rowInfo);
ok('U-15 需求编号列与复杂度列出自现成接口（REQ-001 反查 + plan.complexity 投影）',
  rowInfo.reqNo && rowInfo.cxAll, rowInfo);
S_SPECS.push({
  L: 'S-10 来源徽标文案「规则」（行为腿：每个可见计划行都有徽标；字面腿：规则徽标数=写入行数）',
  anchors: ["label: '规则'"], src: SRC.ep, srcLbl: 'web/src/components/EstimatePanel.tsx',
  behavior: (e) => e.badges?.allTitles === true && e.badges?.badgeCount === FIXTURE.rows,
  literal: (src, e) => src.length > 0 && src.includes("label: '规则'")
    && e.badges?.ruleBadges === e.write?.rows,
});
S_SPECS.push({
  L: 'S-11 里程碑标注「不进 Σ」（行为腿：折叠表头数=夹具里程碑数；字面腿：标注数=里程碑数）',
  anchors: ['不进 Σ'], src: SRC.ep, srcLbl: 'web/src/components/EstimatePanel.tsx',
  behavior: (e) => e.badges?.groups === FIXTURE.milestones,
  literal: (src, e) => src.length > 0 && src.includes('不进 Σ')
    && e.badges?.sigmaMarks === FIXTURE.milestones,
});
S_SPECS.push({
  L: 'S-12 复杂度列「复杂度 N」（行为腿：夹具带复杂度的行逐个显示；字面腿：源码含列模板）',
  anchors: ['复杂度 '], src: SRC.ep, srcLbl: 'web/src/components/EstimatePanel.tsx',
  behavior: (e) => e.badges?.reqNo === true && e.badges?.cxAll === true,
  literal: (src) => src.length > 0 && src.includes('复杂度 '),
});
S_SPECS.push({
  L: 'S-13 阶段折叠 title「阶段明细」（行为腿：表头数=夹具里程碑数）',
  anchors: ['阶段明细'], src: SRC.ep, srcLbl: 'web/src/components/EstimatePanel.tsx',
  behavior: (e) => e.badges?.groups === FIXTURE.milestones,
  literal: (src) => src.length > 0 && src.includes('阶段明细'),
});

// ---------------- 7) 刷新保持（§10-1 会话级） ----------------
// 刷新后 tab 回到默认页（App 的 tab 是内存态，不持久化），所以要重新进入项目管理页——
// 这正是 §10-1 的口径：面板开合跟着会话走，跨刷新/跨切页都在，而不是跟着某一次挂载。
await send('Page.navigate', { url: `${BASE}/?m=0` });
await until(`[...document.querySelectorAll('button')].some(x => x.textContent.trim() === '项目管理')`, 25_000);
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '项目管理'); b?.click(); return !!b; })()`);
// 恢复判据要连面板内容一起等：刷新后 aside 先在场、行数据随后到位，
// 只判 aside 在场会把「取数中」的空壳当成恢复成功。
const reopened = await until(`(() => {
  const a = document.querySelector('aside[aria-label="估算面板"]');
  if (!a) return null;
  const headers = [...a.querySelectorAll('button,[role="button"]')]
    .filter(b => /阶段明细/.test(b.getAttribute('title') || '')).length;
  return headers === ${FIXTURE.milestones}
    ? { session: sessionStorage.getItem('plan.estimatePanelOpen'), headers }
    : null;
})()`, 25_000);
// 失败时给可读证据（是 aside 没回来、还是回来了但表头没齐），否则本条只留一个 null
const reopenDiag = reopened ?? await ev(`(() => {
  const a = document.querySelector('aside[aria-label="估算面板"]');
  return {
    asidePresent: !!a,
    session: sessionStorage.getItem('plan.estimatePanelOpen'),
    headers: a ? [...a.querySelectorAll('button,[role="button"]')]
      .filter(b => /阶段明细/.test(b.getAttribute('title') || '')).length : null,
  };
})()`);
EV.persist = { reopened: !!reopened, ...(reopened ?? {}), diag: reopenDiag };
ok('U-16 刷新并重新进入页面后面板仍打开：开合态由 sessionStorage 恢复（分组表头一并重现）',
  !!reopened && reopened.session === 'true' && reopened.headers === FIXTURE.milestones, reopenDiag);
const persist = await ev(`JSON.stringify({
  session: sessionStorage.getItem('plan.estimatePanelOpen'),
  local: localStorage.getItem('plan.estimatePanelOpen'),
})`);
EV.persist.sessionKey = JSON.parse(persist).session;
EV.persist.localKey = JSON.parse(persist).local;
ok('U-17 口径为「会话级」而非跨会话：sessionStorage 有值、localStorage 无值',
  persist === JSON.stringify({ session: 'true', local: null }), persist);

// ---------------- 8) §10-13 三档视口 + 窄屏转覆盖式 ----------------
const clipExpr = `(() => {
  // 只认带面板内容的模态层：用**夹具计划标题**识别抽屉正文（产品文案不进几何探针，
  // 任何无关浮层都喂不成假绿），不靠某个标题串猜身份。
  const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')];
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
    dialogCount: dialogs.length,
    drawerW: Math.round(a.getBoundingClientRect().width),
    fixtureTitles: ${JSON.stringify(visibleSeeds.map((s) => s[1]))}.filter((t) => a.textContent.includes(t)).length,
  };
})()`;
EV.viewports = [];
for (const w of [1920, 1440, 1200]) {
  await setViewport(w, 1000);
  await sleep(600);
  const r = await until(`(() => { const x = (${clipExpr}); return x.innerW === ${w} ? x : null; })()`, 12_000);
  EV.viewports.push({ w, ...(r ?? {}) });
  ok(`U-18[${w}] ${w}px 走查：停靠式、无横向滚动条、时间线节点不重叠、面板内文字不截断`,
    r && r.aside && !r.dialog && !r.hScroll && !r.panelHScroll && r.overlap === 0 && r.clipped.length === 0 && r.tlW > 300, r);
  await shot(`viewport-${w}`);
}
await setViewport(1100, 900);
await sleep(600);
const narrow = await until(`(() => {
  const x = (${clipExpr});
  return x.innerW === 1100 && !x.aside && x.dialog && x.fixtureTitles === ${FIXTURE.rows} ? x : null;
})()`, 12_000);
EV.narrow = narrow ?? null;
ok('U-19 1100px（<1200）自动转覆盖式抽屉：aside 退场、唯一模态层接管（正文含全部夹具计划行，宽度落设计带宽），且无横向滚动条',
  narrow && narrow.dialog && narrow.dialogCount === 1 && narrow.fixtureTitles === FIXTURE.rows
  && narrow.drawerW >= 300 && narrow.drawerW <= 760 && !narrow.aside
  && !narrow.hScroll && narrow.clipped.length === 0, narrow);
await shot('viewport-1100-overlay');
// 覆盖式不应抢走时间线宽度（抽屉浮在之上）
const overlayTl = await ev(`Math.round(document.querySelector('[aria-label="计划时间线"]').getBoundingClientRect().width)`);
EV.overlayTlW = overlayTl;
ok('U-20 覆盖式下时间线回到全宽（抽屉叠加而非挤压）', overlayTl > 700, overlayTl);

// 关闭态：再点工具条按钮收起
await setViewport(1440, 1000);
await sleep(500);
const closeClicked = (await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.title || '').includes('收起估算面板')); b?.click(); return !!b; })()`)) === true;
const asideGone = (await until(`(() => !document.querySelector('aside[aria-label="估算面板"]'))()`, 8000)) === true;
const sessionAfterClose = await ev(`sessionStorage.getItem('plan.estimatePanelOpen')`);
EV.closed = { toggleFound: closeClicked, asideGone, session: sessionAfterClose };
ok('U-21 工具条再次点击收起面板（开/合同一按钮，状态回写 sessionStorage）',
  closeClicked && asideGone && sessionAfterClose === 'false', EV.closed);
await shot('viewport-1440-closed');
ok('U-22 走查截图取证齐全（三档停靠 + 覆盖式 + 收起态）', shotFiles.length === 5, { shotFiles, lastShotError });
S_SPECS.push({
  L: 'S-14 确认框按钮 aria-label「确定：确认执行该操作」（行为腿：点击确认后真落库 N 行）',
  anchors: ['确定：确认执行该操作'], src: SRC.dialogs, srcLbl: 'web/src/ui/dialogs.tsx',
  behavior: (e) => e.confirm?.opened === true && e.write?.rows === FIXTURE.normals,
  literal: (src, e) => src.length > 0 && src.includes('确定：确认执行该操作') && e.confirm?.opened === true,
});
EV.ran = true;

// =====================================================================
// S 组：产品中文文案一律降级为 okPair 字面腿（判据 3）
//   行为腿＝上面真机量到的结构/几何/库/会话键；字面腿＝已提交树里的文案与渲染串。
//   红因分开：行为失守 ⇒ 立刻修功能；行为在而锚失配 ⇒ 人来判定改锚还是改码。
// =====================================================================
console.log('\n=== S 组：文案锚配对（行为失守⇒FAIL；行为在而锚失配⇒FAIL 交人判定） ===');
for (const it of S_SPECS) {
  okPair(ok, it.L,
    () => it.behavior(EV),
    () => it.literal(it.src, EV),
    () => ({ 锚点: it.anchors, 取证: it.srcLbl, 字面命中: it.anchors.map((a) => it.src.includes(a)) }));
}

// =====================================================================
// N 组：负对照（判据 4 + 反模式 19/20）——每条都要能真的翻红
// =====================================================================
console.log('\n=== N 组：负对照 ===');
{
  // N-01 永真式探针（反模式 20）：字面腿喂空源码必须为假
  const vacuous = S_SPECS.filter((it) => { try { return it.literal('', EV) === true; } catch { return false; } });
  ok(`N-01 空源码探针：${S_SPECS.length} 条字面腿喂空串后全部为假（没有不承重的正则）`,
    S_SPECS.length >= 12 && vacuous.length === 0, { 条数: S_SPECS.length, 仍为真: vacuous.map((v) => v.L) });

  // N-01b 反向：真 HEAD 文本必须命中，否则字面腿是拿不存在的词恒红
  const missing = S_SPECS.filter((it) => it.src.length < 200 || it.anchors.some((a) => !it.src.includes(a)));
  ok(`N-01b HEAD 文本在场性：${S_SPECS.length} 组锚点在已提交树里逐字命中`,
    missing.length === 0 && Object.values(SRC).every((s) => s.length > 200),
    { 未命中: missing.map((m) => ({ L: m.L, 锚: m.anchors.filter((a) => !m.src.includes(a)) })), 源码长度: Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, v.length])) });

  // N-02 敏感度探针（反模式 20）：抽掉运行期实测料后，行为腿必须全部转假
  const empty = {};
  const stillGreen = S_SPECS.filter((it) => { try { return it.behavior(empty) === true; } catch { return false; } });
  ok(`N-02 敏感度探针：抽干运行期实测料后 ${S_SPECS.length} 条行为腿全部转假——行为腿确实在读实测，不是恒真`,
    S_SPECS.length >= 12 && stillGreen.length === 0, { 仍为真: stillGreen.map((v) => v.L) });
  const backGreen = S_SPECS.filter((it) => it.behavior(EV) !== true);
  ok('N-02b 还原实证：实测料回填后同一批行为腿重新为真（N-02 的红不是恒红）',
    backGreen.length === 0, { 还原后仍为假: backGreen.map((v) => v.L) });

  // N-03 改名模拟（逐锚点）：把锚点从 HEAD 副本里删掉——先自证副本≠原件，再要求同一条字面判据转假
  const n3Bad = [];
  for (const it of S_SPECS) {
    for (const a of it.anchors) {
      const tampered = it.src.split(a).join('§§');
      if (tampered === it.src) { n3Bad.push({ L: it.L, 锚: a, 因: '篡改未落地（副本==原件，等于没有牙）' }); continue; }
      let flipped = false;
      try { flipped = it.literal(tampered, EV) === false; } catch { flipped = true; }
      if (!flipped) n3Bad.push({ L: it.L, 锚: a, 因: '抹掉锚后字面腿仍为真' });
    }
  }
  const anchorCount = new Set(S_SPECS.flatMap((it) => it.anchors)).size;
  ok(`N-03 改名模拟：${anchorCount} 个锚点逐个从 HEAD 副本中抹掉后，字面判据各自转假（且每条自证 tampered !== original）`,
    anchorCount >= 12 && n3Bad.length === 0, { 锚点数: anchorCount, 失牙: n3Bad });

  // N-04 okPair 契约有牙：两种红因分得开、都绿才判绿
  const spy = [];
  okPair((n, c, e) => spy.push({ n, c, e }), 'N-04a 行为失守夹具', () => false, () => true);
  okPair((n, c, e) => spy.push({ n, c, e }), 'N-04b 锚点失配夹具', () => true, () => false);
  okPair((n, c, e) => spy.push({ n, c, e }), 'N-04c 双侧齐全', () => true, () => true);
  const reason = (x) => String(x?.e?.红因 ?? '');
  ok('N-04 okPair 落地：行为失守记「行为失守」、锚子失配记「字面锚点失配」、两者齐绿才判绿',
    spy.length === 3 && spy[0].c === false && reason(spy[0]).includes('行为失守') && !reason(spy[0]).includes('字面锚点')
    && spy[1].c === false && reason(spy[1]).includes('字面锚点失配') && spy[2].c === true,
    spy.map((s) => ({ 条: s.n, 判: s.c, 红因: reason(s).slice(0, 40) })));

  // N-05 行为腿的牙（判据 4）：把实测料按三类破坏形态各改一份，同一组 behavior 必须点名那条为假
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const t1 = clone(EV); t1.panel.geom.box += 40;
  const b1 = S_SPECS.find((it) => it.anchors.includes('ESTIMATE_PANEL_WIDTH'))?.behavior(t1) === false;
  const t2 = clone(EV); t2.rate.dom = (t2.rate.dom ?? 0) + 1;
  const b2 = S_SPECS.find((it) => it.anchors.includes('人天/人月'))?.behavior(t2) === false;
  const t3 = clone(EV); t3.write.rows = 0;
  const b3 = S_SPECS.find((it) => it.anchors.includes('已按规则推导写入'))?.behavior(t3) === false;
  ok('N-05 破坏形态反证：停靠宽漂 40px / 汇总读数与 params 差 1 / 写入行清零，三条行为腿各自转假',
    b1 && b2 && b3, { 宽度腿: b1, 读数腿: b2, 写入腿: b3 });
}

// 截图/结果收口
console.log(`\n截图：${SHOTS}`);
const resultFile = writeGateResults(OUT_DIR, OUT_BASE, `PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`,
  { port: PORT, dataDir: DATA_DIR });
console.log(`结果：${resultFile}`);
// 回收顺序：先收 Chrome 进程树（CrashpadMetrics 被占用时 rmSync 会 EBUSY），再删临时目录；
// 临时目录删不掉不影响结论，留痕即可（都在 D:/code/tmp 下，不是生产数据）。
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
