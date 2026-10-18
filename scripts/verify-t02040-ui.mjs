#!/usr/bin/env node
/**
 * T02040（估算视图 §5.3 + E5）真机走查：CDP 驱动 headless Chrome 打开**隔离实例**的估算面板，
 * 逐条取只能靠浏览器验收的口径：
 *   §10-3 行内改值即时刷新（汇总卡跟着变）+ 刷新后仍在（真落库，不是内存态）；
 *   §10-4 `O>M` 行内标红 + 底部提示条逐行点名，且服务端原值分毫未动（判据只有一份）；
 *   §10-5 批量三模式 dryRun 预览行数 = 写入行数、撤销条「已填充 N 行 · 撤销」、
 *          「只看未复核」筛选、统一值表单的 O/M/P 预览、里程碑行不参与；
 *   §10-13 窄视口转覆盖式后新工具条不产生横向滚动（E4 的三档视口守卫在写路径落地后复验）。
 *
 * 为什么单独一个脚本：verify-t02040-estimate-e4b.mts 能把 PATCH/batch/onlyRule 的**接口语义**断到逐字，
 * 但「哪个格子变红」「撤销条是否出现在顶部」「确认弹窗写了哪句行数」是渲染层的事，只有真实浏览器说得清。
 *
 * T02293 判据落地：U 组只认结构/几何/库读数（面板根、工具条、fieldset、output、role=alert 等语义句柄，
 * 以及服务端响应与库内行）；产品中文文案与标识符锚一律进 P 组的 `okPair` 字面腿（取证面 `git show HEAD:`）。
 * N 组负对照：空源码、HEAD 在场性、抽干实测料、逐锚改名、okPair 契约、按类破坏行为腿。
 *
 * 用法（Chrome 用系统安装版；本仓内置 Browser 无视口不能点击/截图，见 memory）：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02040-ui.mjs
 *   环境变量：T02040_UI_PORT（默认 39933）、T02040_UI_CDP（默认 9343）
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
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't02040-ui-'));
const CHROME_PROFILE = mkdtempSync(join(TMP_ROOT, 't02040-ui-chrome-'));
if (!process.env.MTASK_GATE_ARTIFACT_DIR) process.env.MTASK_GATE_ARTIFACT_DIR = join(TMP_ROOT, 'mtask-gate-shots');
// T02312：截图不落仓库根固定名目录（并发跑门时同一步骤名整图互覆，且仓库根长期堆未纳管产物）——
// 改用 gate-results 的进程级 RUN_TAG 子目录，与本轮文本产物同标识，可按标识核对归属。
const { gateShotsDir } = await import(pathToFileURL(join(ROOT, 'scripts/lib/gate-results.mts')).href);
const { okPair } = await import(pathToFileURL(join(ROOT, 'scripts/lib/anchor-pair.mts')).href);
const SHOTS = gateShotsDir('t02040');
const PORT = Number(process.env.T02040_UI_PORT ?? 39933);
const CDP = Number(process.env.T02040_UI_CDP ?? 9343);
const CHROME = process.env.T02040_UI_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
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
const EV = {};

// ---------------- 1) 夹具：临时库直写（进程内，起服务前完成） ----------------
process.env.MTask_DATA_DIR = DATA_DIR;
const { getDb, closeDb } = await import('../server/src/db/connection.ts');
const { initSchema } = await import('../server/src/db/schema.ts');
initSchema();
const T = '2026-10-11T00:00:00.000Z';
const PID = 'ui-e5';
const db = getDb();
db.prepare('INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
  .run(PID, 'T02040-行内录入走查', '', T, T);
const insPlan = db.prepare(
  `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
     progress, status, assignee, sort_order, created_at, updated_at, kind, complexity, req_ids, deps)
   VALUES (?, ?, ?, '', ?, ?, ?, 0, 'todo', '', ?, ?, ?, ?, ?, ?, ?)`,
);
// 故意**不预置任何估算行**：面板首屏是空态，行内录入要走「建议行首次落库」那条分支
const seeds = [
  ['ms-a', 'M-A 需求阶段', 6, 1, 'milestone', 4, [], null],
  ['u-cx', '需求分析', 5, 2, 'normal', 3, ['rq-1'], JSON.stringify([{ id: 'ms-a', type: 'child' }])],
  ['u-case', '系统设计', 4, 3, 'normal', null, ['rq-1'], JSON.stringify([{ id: 'ms-a', type: 'child' }])],
  ['ms-b', 'M-B 实施阶段', 8, 4, 'milestone', 5, [], null],
  ['u-dur', '开发联调', 7, 5, 'normal', null, [], JSON.stringify([{ id: 'ms-b', type: 'child' }])],
  ['u-cx2', '测试执行', 3, 6, 'normal', 2, [], JSON.stringify([{ id: 'ms-b', type: 'child' }])],
];
for (const [id, title, dur, sort, kind, cx, reqs, deps] of seeds) {
  insPlan.run(id, PID, title, '2026-10-12', '2026-10-12', dur, sort, T, T, kind, cx,
    reqs.length ? JSON.stringify(reqs) : null, deps);
}
db.prepare(`INSERT INTO prd_requirements (id, project_id, req_no, title, content, source_ref, priority, status, sort_order, created_at, updated_at)
   VALUES (?, ?, ?, ?, '', '', 'normal', 'todo', 0, ?, ?)`).run('rq-1', PID, 'REQ-001', '行内录入取证需求', T, T);
[['tc-1', 'P0'], ['tc-2', 'P1'], ['tc-3', 'P2']].forEach(([id, pri], i) => {
  db.prepare(`INSERT INTO test_cases (id, project_id, req_id, case_no, title, priority, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, PID, 'rq-1', `C-${i + 1}`, `用例${i + 1}`, pri, T, T);
});
closeDb();

const NORM_TITLES = seeds.filter((s) => s[4] === 'normal').map((s) => s[1]);
const MS_TITLES = seeds.filter((s) => s[4] === 'milestone').map((s) => s[1]);
const ALL_TITLES = seeds.map((s) => s[1]);
const seedById = (id) => seeds.find((s) => s[0] === id);

// ---------------- 2) 隔离服务 ----------------
const { resolveServerLauncher } = await import(pathToFileURL(join(ROOT, 'scripts/isolated-server-launcher.mts')).href);
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const server = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT, env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR }, stdio: ['ignore', 'pipe', 'pipe'],
});
console.log(`隔离实例启动器：${LAUNCHER.label}`);
/** 断言失败时唯一能区分「前端没发请求」与「服务端拒了」的证据，故留在日志里而不是丢弃 */
const serverLog = [];
server.stdout?.on('data', (b) => serverLog.push(b.toString()));
server.stderr?.on('data', (b) => serverLog.push(b.toString()));

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
const sleepSync = (i) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300 * (i + 1)); };
const cleanup = () => {
  if (process.env.T02040_UI_KEEP) return;
  // 回收是 taskkill 异步杀的：库文件可能还被上一秒的服务进程占着，重试几轮再认输（不影响结论）
  for (const dir of [DATA_DIR, CHROME_PROFILE]) {
    for (let i = 0; i < 8; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break; } catch { sleepSync(i); }
    }
  }
};
process.on('exit', cleanup);

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
/** 面板对 /api/estimates* 的每一次请求（含状态码与响应体尾部）——批量按钮「没弹确认」时，只有它能区分「预览返回 0 行」与「请求抛错」 */
const netLog = [];
const netBodies = new Map();
ws.onmessage = (event) => {
  const m = JSON.parse(event.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Network.responseReceived' && /\/api\/estimates/.test(m.params.response.url)) {
    netLog.push({ rid: m.params.requestId, url: m.params.response.url.replace(/^https?:\/\/[^/]+/, ''), status: m.params.response.status });
  }
  if (m.method === 'Network.loadingFinished' && netBodies.size < 60) {
    send('Network.getResponseBody', { requestId: m.params.requestId }).then((r) => {
      const body = r.result?.body;
      if (body) netBodies.set(m.params.requestId, body.slice(0, 4000));
    });
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

// 面板根节点：停靠态是 aside，<1200px 是覆盖式 dialog。判据 1：用门内夹具计划名 + 工具条结构定位，
// 不依赖产品 aria-label 文案（文案改动只该让 P 组字面腿红，不该让整条走查找不到面板）。
// 注意不能要求 4 个夹具标题同时在场：「只看未复核」会隐藏 manual 行（剩 3 个），故阈值取 ≥2。
const PJ = `const FT=${JSON.stringify(NORM_TITLES)};const p=()=>[...document.querySelectorAll('aside,[role="dialog"][aria-modal="true"]')].find(d=>d.querySelector('[role="toolbar"]')&&FT.filter(t=>d.innerText.includes(t)).length>=2);`;
/** 面板内求值统一套 IIFE：`PJ` 只是 `p()` 的定义，裸 `return` 交给 Runtime.evaluate 是语法错误 */
const PE = (strings, ...exprs) => {
  let body = strings[0];
  exprs.forEach((e, i) => { body += String(e) + strings[i + 1]; });
  return `(() => { ${PJ}${body} })()`;
};
/** 明细行三格按「夹具标题前缀 + DOM 顺序」取：0=O 1=M 2=P（点列顺序由 POINT_FIELDS 固定），不认产品文案后缀 */
const inP = (title, idx) => `[...p().querySelectorAll('input[type="number"]')].filter(i=>(i.getAttribute('aria-label')||'').startsWith(${JSON.stringify(title)}))[${idx}]`;
/** 点面板里的按钮（按可见文案），返回执行结果字符串；这些文案在 P 组各有字面锚点 */
const clickBtn = (text) => `(() => { ${PJ}const b=[...p().querySelectorAll('button')].find(x=>x.textContent.trim().includes(${JSON.stringify(text)})); if(!b) return 'nobtn'; b.click(); return 'clicked'; })()`;
const rest = async (path) => (await fetch(`${BASE}/api${path}`)).json();
// 项目内的 askConfirm 用 mountDialog 追加一个 body 直挂容器（无 role=dialog），
// 故按「点击前记录 body.children.length，之后出现含 ≥2 按钮的直挂容器」结构定位，不认按钮文案。
const bodyKids = () => ev('document.body.children.length');
const readConfirmExpr = (base) => `(() => {
  const kids=[...document.body.children];
  for (let i=kids.length-1;i>=${base};i--){ const d=kids[i]; if(d && d.querySelectorAll('button').length>=2) return d.innerText; }
  return '';
})()`;
const clickConfirmExpr = (base) => `(() => {
  const kids=[...document.body.children];
  for (let i=kids.length-1;i>=${base};i--){ const d=kids[i]; const bs=d?[...d.querySelectorAll('button')]:[]; if(bs.length>=2){ bs.at(-1).click(); return true; } }
  return false;
})()`;
/** 明细格计数（标题前缀取自夹具；统一值表单的 number 输入没有 aria-label，不会混进来） */
const cellsExpr = `[...p().querySelectorAll('input[type="number"]')].filter(i=>{const l=i.getAttribute('aria-label')||'';return ${JSON.stringify(ALL_TITLES)}.some(t=>l.startsWith(t));})`;
const cellsCount = () => ev(PE`return ${cellsExpr}.length;`);
const cellsLabels = () => ev(PE`return ${cellsExpr}.map(i=>i.getAttribute('aria-label'));`);
/** 断言失败时的现场：面板尾部文本 + 页面 JS 报错 + 服务日志尾部，用来区分「前端没发请求」与「服务端拒了」 */
async function diag(tag) {
  const panel = await ev(PE`return p()?p().innerText.slice(-500):'no-panel';`);
  const errs = await ev(`(window.__errs||[]).slice(-3).join(' | ')`);
  const srv = serverLog.join('').split('\n').filter((l) => /estimates|error|异常/i.test(l)).slice(-5).join(' ⏎ ');
  console.log(`  [DIAG ${tag}] 面板尾部: ${String(panel).replace(/\s*\n+\s*/g, ' ⏎ ').slice(-320)}`);
  console.log(`  [DIAG ${tag}] 页面报错: ${errs || '无'}`);
  console.log(`  [DIAG ${tag}] 服务日志: ${srv || '无匹配行'}`);
  const recent = netLog.slice(-4).map((n) => `${n.status} ${n.url}`).join(' | ');
  console.log(`  [DIAG ${tag}] 接口请求: ${recent || '无'}`);
  const last = netLog.at(-1);
  if (last) console.log(`  [DIAG ${tag}] 响应体: ${String(netBodies.get(last.rid) ?? '(未取到)').replace(/\s+/g, ' ').slice(0, 260)}`);
}

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
ok('U-02 页面加载完成（桌面 UI）', await until(`!!document.querySelector('nav button')`, 25_000), 'nav 未渲染');
// 判据 1：走产品自身的全局导航 seam 切到项目管理 tab，不去按菜单文案找按钮
await ev(`(() => { globalThis.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'plan' } })); return 1; })()`);
await setViewport(1920, 1000);
const panelOpened = await until(PE`return !!p();`, 25_000);
EV.nav = { dispatch: true, panelOpen: panelOpened === true };
ok('U-03 估算面板已打开（会话态种入开键 + 导航 seam；走查专注写路径）', panelOpened === true, '面板未出现');
const sumText = () => ev(PE`return p().innerText.slice(0,400);`);
const panelText = () => ev(PE`return p()?p().innerText:'';`);

// ---------------- 4) 空态 + 行内录入首次落库（§10-3） ----------------
const api0 = await rest(`/estimates?projectId=${PID}`);
EV.emptyRows0 = (api0.items ?? []).length;
EV.apiSummaryBefore = api0.summary;
// 空态行为：0 条估算行时出现「虚线入口块 + 按钮」这一结构，首行落库后消失
EV.emptyCta = await until(PE`const box=[...p().querySelectorAll('div')].find(d=>getComputedStyle(d).borderTopStyle==='dashed'&&!!d.querySelector('button'));
  return box?{block:true,button:box.querySelector('button').textContent.trim().length>0}:'';`, 20_000) || null;
ok('U-04 空态（服务端 0 条估算行）：面板出现独立的虚线入口块（内含按钮），不拿建议值冒充已录入',
  EV.emptyRows0 === 0 && !!EV.emptyCta && EV.emptyCta.block === true && EV.emptyCta.button === true,
  { rows: EV.emptyRows0, cta: EV.emptyCta });
if (!EV.emptyCta) await diag('U-04');
// 记录编辑前徽标的实测色（行为腿不认「人工」二字，认它真的换了来源色）
const badgeProbe = (title) => PE`const el=${inP(title,1)}; if(!el) return '';
  const box=el.parentElement.parentElement;
  const s=[...box.querySelectorAll('span')].find(x=>{const st=getComputedStyle(x);return x.textContent.trim()&&st.borderTopWidth==='1px'&&st.borderTopStyle!=='none';});
  return s?{text:s.textContent.trim(),color:getComputedStyle(s).borderTopColor}:'';`;
EV.badgeBefore = await ev(badgeProbe('需求分析'));
const sumBefore = await sumText();
await ev(clickBtn('全选可见'));
const selCount = await until(PE`const tb=p().querySelector('[role="toolbar"]');
  const s=tb?[...tb.querySelectorAll('span')].map(x=>x.textContent.trim()).find(t=>/\\d/.test(t)):'';
  return s?(s.match(/(\\d+)/)||[])[1]:'';`);
EV.selCount = Number(selCount || 0);
// 结构判据：逐行找到「同容器内恰有 3 个号码格」的复选框——普通行选中、里程碑行未选且禁用。
// 计数文案只做旁证，作用域由夹具行本身的勾选态证明（不靠文案里的数字）。
const selState = await until(PE`const rows=${JSON.stringify(ALL_TITLES)};
  const out=rows.map((t)=>{
    const inp=[...p().querySelectorAll('input[type="number"]')].find(i=>String(i.getAttribute('aria-label')||'').startsWith(t));
    if(!inp) return {t,found:false};
    let box=inp.parentElement;
    while(box&&box!==p()){
      const ins=[...box.querySelectorAll('input[type="number"]')];
      const cb=box.querySelector('input[type="checkbox"]');
      if(cb&&ins.length===3) return {t,found:true,checked:cb.checked,disabled:cb.disabled};
      box=box.parentElement;
    }
    return {t,found:false};
  });
  return out.every(x=>x.found)?out:'';`);
EV.selState = selState || null;
ok('U-05 「全选可见」作用域=4 条普通计划（里程碑行不参与批量填充）',
  EV.selCount === 4 && Array.isArray(selState)
  && selState.filter((x) => NORM_TITLES.includes(x.t)).every((x) => x.checked === true && x.disabled === false)
  && selState.filter((x) => MS_TITLES.includes(x.t)).every((x) => x.checked === false && x.disabled === true),
  { count: selCount, state: selState });

// 行内编辑：聚焦 → 原生赋值 + input 事件（React 受控框只有走原生 setter 才收到 onChange）→ Enter
async function typePoint(title, idx, v) {
  const s1 = await ev(`(() => { ${PJ}const el=${inP(title, idx)}; if(!el) return 'missing'; el.focus(); return 'focused'; })()`);
  await sleep(150);
  const s2 = await ev(`(() => { ${PJ}const el=${inP(title, idx)}; const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
    d.set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value; })()`);
  await sleep(200);
  const s3 = await ev(`(() => { ${PJ}const el=${inP(title, idx)}; el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return 'sent'; })()`);
  return { s1, s2, s3 };
}
const typed = await typePoint('需求分析', 1, '4');
ok('U-06 三列是真正的 input[type=number]（受控框可聚焦、可输入、值回显）', typed.s1 === 'focused' && typed.s2 === '4' && typed.s3 === 'sent', typed);
const itemAfterPatch = await until(`(async () => { const r = await fetch('${BASE}/api/estimates?projectId=${PID}'); const j = await r.json(); return j.items.find(i=>i.plan_id==='u-cx') || null; })()`, 20_000);
ok('U-07 建议行首次落库：M=4 且 O/P 继承推导值（3.5/5.5=3.5×1.6 落 0.5 网格，面板不猜数、由服务端建行）',
  itemAfterPatch && itemAfterPatch.likely === 4 && itemAfterPatch.optimistic === 3.5 && itemAfterPatch.pessimistic === 5.5,
  itemAfterPatch);
if (!itemAfterPatch) await diag('U-07');
ok('U-07b 人工改过即转 manual：PATCH 不给 source 也由服务端补（复核率按它出数）',
  itemAfterPatch && itemAfterPatch.source === 'manual' && itemAfterPatch.phase === 'req', itemAfterPatch);
EV.emptyCtaGone = (await until(PE`return ![...p().querySelectorAll('div')].some(d=>getComputedStyle(d).borderTopStyle==='dashed'&&!!d.querySelector('button')) ? 1 : '';`, 20_000)) === 1;
const apiAfterPatch = await rest(`/estimates?projectId=${PID}`);
EV.summaryP50Before = EV.apiSummaryBefore?.quote?.p50ManMonth;
EV.summaryP50After = apiAfterPatch.summary?.quote?.p50ManMonth;
const sumAfterPatch = await until(PE`return p().innerText.slice(0,400)!==${JSON.stringify(sumBefore)} ? p().innerText.slice(0,400) : '';`, 20_000);
EV.summaryPanelChanged = typeof sumAfterPatch === 'string' && sumAfterPatch !== '';
ok('U-08 改值即时刷新：汇总卡读数随服务端重算变了（面板读数与服务端 summary 同步变化，面板没有本地一套 E）',
  EV.summaryPanelChanged && EV.summaryP50After !== EV.summaryP50Before,
  { before: EV.summaryP50Before, after: EV.summaryP50After, panelChanged: String(sumAfterPatch).slice(0, 80) });
// 行为腿：该行徽标颜色真的从「默认」来源色换成了 manual 来源色（不认「人工」二字）
EV.badgeAfter = await until(badgeProbe('需求分析'), 20_000);
ok('U-08b 该行徽标随落库来源换色（默认来源色 → manual 来源色；重取的是响应，不是内存态）',
  !!EV.badgeBefore && !!EV.badgeAfter && EV.badgeBefore.color !== EV.badgeAfter.color && EV.badgeAfter.text.length > 0,
  { before: EV.badgeBefore, after: EV.badgeAfter });
if (!EV.badgeAfter) await diag('U-08b');

// ---------------- 5) 刷新后仍在（§10-3 落库口径） ----------------
await send('Page.navigate', { url: `${BASE}/?m=0` });
await until(`!!document.querySelector('nav button')`, 25_000);
await ev(`(() => { globalThis.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'plan' } })); return 1; })()`);
await setViewport(1920, 1000);
const valAfterReload = await until(PE`const el=${inP('需求分析', 1)};return el&&el.value==='4'?1:'';`, 25_000);
EV.nav.reloadPanelOpen = valAfterReload === 1;
ok('U-09 刷新重进后 M 仍是 4：行内录入真落库（不是面板会话内的临时态）', valAfterReload === 1, valAfterReload);
await shot('01-panel-inline-edit');

// ---------------- 6) O>M：行内标红 + 底部提示条，且原值不动（§10-4） ----------------
const badType = await typePoint('需求分析', 0, '99');
// 行为腿：输入格落 --danger 主题 token、面板出现 role=alert、告警里的行数=当前违规行数（1，夹具可推）
const alertInfo = await until(PE`const el=${inP('需求分析',0)};
  if(!el) return '';
  const alert=[...p().querySelectorAll('[role="alert"]')].find(a=>a.innerText.trim());
  const probe=document.createElement('span'); probe.style.color='var(--danger)'; document.body.appendChild(probe);
  const want=getComputedStyle(probe).color; probe.remove();
  const styled=String(el.getAttribute('style')||'').includes('var(--danger)')||getComputedStyle(el).borderTopColor===want;
  return alert?{alert:alert.innerText.trim().slice(0,200), styled, n:(alert.innerText.match(/(\\d+)/)||[])[1]}:'';`, 20_000);
ok('U-10 被拒的行落 --danger 主题 token + 面板出现 role=alert 且点名行数=1（文案由 P 组字面腿钉）',
  !!alertInfo && alertInfo.styled === true && String(alertInfo.n) === '1', { badType, redInfo: alertInfo });
if (!(alertInfo && alertInfo.styled)) await diag('U-10');
ok('U-10b 红色来自 var(--danger)（样式与主题变量单源，不硬编码色值）', alertInfo && alertInfo.styled === true, alertInfo);
const stillThere = await rest(`/estimates?projectId=${PID}`);
const ucxRow = stillThere.items.find((i) => i.plan_id === 'u-cx');
EV.redInfo = { ...(alertInfo || {}), dbUntouched: !!ucxRow && ucxRow.optimistic === 3.5 && ucxRow.likely === 4 };
ok('U-10c 被拒后库里分毫未动（O 仍 3.5、M 仍 4）——判据只有一份，前端不预筛',
  EV.redInfo.dbUntouched === true, ucxRow);
const afterReject = await ev(PE`const el=${inP('需求分析', 0)};return el?el.value:'missing';`);
ok('U-10d 输入框保留用户刚打的 99（不静默吞掉被拒值，也不回填成旧数骗人）', afterReject === '99', afterReject);
await shot('02-reject-o-gt-m');
// 还原成合法值：错误态应随写入成功自动消掉（结构信号：面板内不再有 role=alert）
await typePoint('需求分析', 0, '3.5');
EV.errorCleared = await until(PE`return !p().querySelector('[role="alert"]') ? 1 : '';`, 20_000);
ok('U-11 改回合法值后错误条消失（错误态不是常驻装饰）', EV.errorCleared === 1, EV.errorCleared);

/** 面板批量按钮在请求在途（busy）时禁用：等正常明细格全部可编辑再点，避免点到禁用按钮空转。
 *  里程碑格设计上恒禁用，故只拿普通计划行的格子做 busy 探针。 */
const idle = async (tag) => {
  const v = await until(PE`const i=${cellsExpr}.filter(x=>${JSON.stringify(NORM_TITLES)}.some(t=>(x.getAttribute('aria-label')||'').startsWith(t)));
    return i.length > 0 && i.every((x) => !x.disabled) ? 1 : '';`, 25_000);
  if (v !== 1) await diag(tag);
  return v;
};

// ---------------- 7) 批量按规则推导：预览行数=写入行数 + 撤销（§10-5） ----------------
await idle('U-12');
await ev(clickBtn('全选可见'));
await until(PE`const tb=p().querySelector('[role="toolbar"]');
  const s=tb?[...tb.querySelectorAll('span')].map(x=>x.textContent.trim()).find(t=>/\\d/.test(t)):'';
  return s&&Number((s.match(/(\\d+)/)||[])[1])>0?1:'';`);
// 独立 oracle：门直接调 dryRun 预览，拿到服务端的可写/跳过行数（不读确认框文案）
const derivePreview = await (await fetch(`${BASE}/api/estimates/batch`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ projectId: PID, mode: 'derive', scope: 'all', dryRun: true, planIds: seeds.filter((s) => s[4] === 'normal').map((s) => s[0]), onlyRule: 'caseWeight' }),
})).json();
EV.batch = {
  previewWritable: derivePreview.writableCount,
  previewSkipped: (derivePreview.skipped ?? []).length,
  confirmShown: false,
  db: null,
};
const batchBodyBase = await bodyKids();
await ev(clickBtn('按用例加权重推'));
const confirmText = await until(readConfirmExpr(batchBodyBase));
EV.batch.confirmShown = typeof confirmText === 'string' && confirmText.trim().length > 0;
EV.batch.confirmText = typeof confirmText === 'string' ? confirmText.slice(0, 600) : '';
EV.batch.confirmNums = (String(confirmText || '').match(/\d+(?:\.\d+)?/g) || []).map(Number);
ok('U-12 批量填充走项目内确认对话框（body 直挂确认层，非原生 confirm）且 dryRun 预览给出可写 1 行 / 跳过 3 行',
  EV.batch.confirmShown && EV.batch.previewWritable === 1 && EV.batch.previewSkipped === 3,
  { confirm: EV.batch.confirmText.slice(0, 240), preview: { writable: EV.batch.previewWritable, skipped: EV.batch.previewSkipped } });
if (!EV.batch.confirmShown) await diag('U-12');
await ev(clickConfirmExpr(batchBodyBase));
const dbAfterBatch = await until(`(async () => {
  const r = await fetch('${BASE}/api/estimates?projectId=${PID}');
  const j = await r.json();
  return j.items.length === 2 ? j.items.map((i) => i.plan_id) : null;
})()`, 20_000);
EV.batch.db = dbAfterBatch;
ok('U-13 确认后服务端真写入 1 行（u-case）——预览可写行数=实际写入行数（toast 文案由 P 组字面腿钉）',
  Array.isArray(dbAfterBatch) && dbAfterBatch.includes('u-case') && EV.batch.previewWritable === 1, dbAfterBatch);
ok('U-13c 点击真的打到了批量接口（POST /api/estimates/batch 200）——按钮有文案没接线这类问题只有网络层看得见',
  netLog.some((n) => n.url.includes('/estimates/batch') && n.status === 200), netLog.slice(-6));
const caseItem = await rest(`/estimates?projectId=${PID}`);
const uCase = caseItem.items.find((i) => i.plan_id === 'u-case');
ok('U-13b 被写的只有自然择档为用例档的行（u-case），其余三行不因「换个档硬凑」而落库',
  uCase && caseItem.items.length === 2, { written: uCase && [uCase.optimistic, uCase.likely, uCase.pessimistic], all: caseItem.items.map((i) => i.plan_id) });
const undoBar = await until(PE`const bar=[...p().querySelectorAll('output')].find(o=>o.querySelector('button'));
  return bar?{text:bar.innerText.trim().slice(0,160), n:(bar.innerText.match(/(\\d+)/)||[])[1]}:'';`, 20_000);
EV.undo = { barN: undoBar ? Number(undoBar.n) : null, afterCount: null, uCaseGone: null };
ok('U-14 顶部出现撤销条且条上的行数=本次写入行数（1；文案由 P 组字面腿钉）',
  !!undoBar && EV.undo.barN === 1, undoBar);
await ev(PE`const bar=[...p().querySelectorAll('output')].find(o=>o.querySelector('button')); const b=bar?bar.querySelector('button'):null; b?.click(); return !!b;`);
const afterUndoItems = await until(`(async () => {
  const r = await fetch('${BASE}/api/estimates?projectId=${PID}');
  const j = await r.json();
  return j.items.length === 1 ? j.items.map((i) => i.plan_id) : null;
})()`, 20_000);
EV.undo.afterCount = Array.isArray(afterUndoItems) ? afterUndoItems.length : null;
EV.undo.uCaseGone = Array.isArray(afterUndoItems) && !afterUndoItems.includes('u-case');
ok('U-15 点撤销：新建的 u-case 按删除回滚，服务端回到 1 行（toast 文案由 P 组字面腿钉）',
  Array.isArray(afterUndoItems) && afterUndoItems[0] === 'u-cx', afterUndoItems);
const afterUndo = await rest(`/estimates?projectId=${PID}`);
ok('U-15b 撤销后只剩 u-cx 一行，u-case 回到「建议值」态（未落库）',
  afterUndo.items.length === 1 && afterUndo.items[0].plan_id === 'u-cx', afterUndo.items.map((i) => i.plan_id));
await shot('03-batch-derive-undo');

// ---------------- 8) 统一值模式 + 撤销还原 source ----------------
await idle('U-16');
await ev(clickBtn('全选可见'));
await until(PE`const tb=p().querySelector('[role="toolbar"]');
  const s=tb?[...tb.querySelectorAll('span')].map(x=>x.textContent.trim()).find(t=>/\\d/.test(t)):'';
  return s&&Number((s.match(/(\\d+)/)||[])[1])>0?1:'';`);
await ev(clickBtn('统一值'));
const uniformForm = await until(PE`const fs=[...p().querySelectorAll('fieldset')].find(f=>f.querySelectorAll('input[type="number"]').length===3);
  return fs?1:'';`);
EV.uniform = { form: uniformForm === 1, prefill: null, ratio: null, previewNums: null, afterRows: null, dbVals: null, dbSources: null, undoN: null };
ok('U-16 「统一值…」展开表单（M + 两个倍率；结构信号：面板内含恰好 3 个 number 输入的 fieldset）', EV.uniform.form, uniformForm);
const mulPrefill = await ev(PE`const fs=[...p().querySelectorAll('fieldset')].find(f=>f.querySelectorAll('input[type="number"]').length===3);
  const els=fs?[...fs.querySelectorAll('input[type="number"]')]:[];
  return { m: els[0]?.value, oMul: els[1]?.value, pMul: els[2]?.value };`);
const cfgMeta = await rest(`/estimates?projectId=${PID}`);
EV.uniform.prefill = mulPrefill;
EV.uniform.ratio = cfgMeta.params.config.ruleRatio;
ok('U-16b 倍率预取自动态参数（面板不内置一套经验值）',
  mulPrefill.oMul === String(cfgMeta.params.config.ruleRatio.oMul) && mulPrefill.pMul === String(cfgMeta.params.config.ruleRatio.pMul),
  { mulPrefill, ratio: cfgMeta.params.config.ruleRatio });
// 输入 M=3、倍率 0.8/1.4；期望三点由门内独立算（落 0.5 网格）：O 2.5 / M 3 / P 4
const grid05 = (x) => Math.round(x / 0.5) * 0.5;
const WANT_PTS = { m: 3, oMul: 0.8, pMul: 1.4, optimistic: grid05(3 * 0.8), likely: grid05(3), pessimistic: grid05(3 * 1.4) };
await ev(PE`const fs=[...p().querySelectorAll('fieldset')].find(f=>f.querySelectorAll('input[type="number"]').length===3);
  const els=[...fs.querySelectorAll('input[type="number"]')];
  const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
  const want=[${JSON.stringify(String(WANT_PTS.m))},${JSON.stringify(String(WANT_PTS.oMul))},${JSON.stringify(String(WANT_PTS.pMul))}];
  els.slice(0,3).forEach((el,i)=>{ d.set.call(el, want[i]); el.dispatchEvent(new Event('input',{bubbles:true})); });
  return 1;`);
EV.uniform.previewNums = await until(PE`const fs=[...p().querySelectorAll('fieldset')].find(f=>f.querySelectorAll('input[type="number"]').length===3);
  if(!fs) return '';
  const sp=[...fs.querySelectorAll('span')].find(s=>{const t=s.textContent.trim();return !t.includes('写入')&&(t.match(/\\d+(?:\\.\\d+)?/g)||[]).length>=3;});
  if(!sp) return '';
  const nums=(sp.textContent.match(/\\d+(?:\\.\\d+)?/g)||[]).map(Number);
  return nums.length>=3?nums:'';`, 15_000);
ok('U-17 表单实时预览三点与门内独立算式一致（M=3、倍率 0.8/1.4 → 2.5/3/4，落 0.5 网格）',
  Array.isArray(EV.uniform.previewNums) && EV.uniform.previewNums.slice(0, 3).join('/') === [WANT_PTS.optimistic, WANT_PTS.likely, WANT_PTS.pessimistic].join('/'),
  { preview: EV.uniform.previewNums, want: WANT_PTS });
// 点表单自己的「写入」按钮（表单按钮序：写入 → 取消）
const uniformBodyBase = await bodyKids();
await ev(PE`const fs=[...p().querySelectorAll('fieldset')].find(f=>f.querySelectorAll('input[type="number"]').length===3);
  const b=fs?fs.querySelector('button'):null; b?.click(); return !!b;`);
const uniConfirm = await until(readConfirmExpr(uniformBodyBase));
EV.uniform.confirm = typeof uniConfirm === 'string' ? uniConfirm.slice(0, 600) : '';
ok('U-18 统一值确认框出现，并把三点点明（文案与「转人工」措辞由 P 组字面腿钉）',
  typeof uniConfirm === 'string' && uniConfirm.trim().length > 0, (uniConfirm || '').slice(0, 200));
await ev(clickConfirmExpr(uniformBodyBase));
const uniformRows = await until(`(async () => {
  const r = await fetch('${BASE}/api/estimates?projectId=${PID}');
  const j = await r.json();
  if (j.items.length !== 4) return null;
  return j.items.map((i) => ({ id: i.plan_id, o: i.optimistic, m: i.likely, p: i.pessimistic, src: i.source }));
})()`, 20_000);
EV.uniform.afterRows = Array.isArray(uniformRows) ? uniformRows.length : null;
EV.uniform.dbVals = Array.isArray(uniformRows) ? uniformRows.map((r) => [r.o, r.m, r.p]) : null;
EV.uniform.dbSources = Array.isArray(uniformRows) ? [...new Set(uniformRows.map((r) => r.src))] : null;
ok('U-18b 批量写入 4 行（覆盖人工行 + 新建 3 行）',
  Array.isArray(uniformRows) && uniformRows.length === 4, uniformRows);
const uniVals = await until(PE`const want=${JSON.stringify(NORM_TITLES)};
  return want.map(t=>{ const els=${cellsExpr}.filter(i=>(i.getAttribute('aria-label')||'').startsWith(t));
    return els.slice(0,3).map(e=>e.value); });`, 20_000);
ok('U-19 四行的三点都变成 2.5/3/4（面板把服务端写入值重取上屏，不是本地填的假数）',
  Array.isArray(uniVals) && uniVals.length === 4 && uniVals.every((v) => v.join('/') === '2.5/3/4'), uniVals);
const uniformUndoBar = await until(PE`const bar=[...p().querySelectorAll('output')].find(o=>o.querySelector('button'));
  return bar?{n:(bar.innerText.match(/(\\d+)/)||[])[1]}:'';`, 20_000);
EV.uniform.undoN = uniformUndoBar ? Number(uniformUndoBar.n) : null;
ok('U-20 统一值写入后撤销条报 4 行（撤销入口与写入行数同源）', EV.uniform.undoN === 4, uniformUndoBar);
await ev(PE`const bar=[...p().querySelectorAll('output')].find(o=>o.querySelector('button')); const b=bar?bar.querySelector('button'):null; b?.click(); return !!b;`);
const uniUndoRows = await until(`(async () => {
  const r = await fetch('${BASE}/api/estimates?projectId=${PID}');
  const j = await r.json();
  return j.items.length === 1 ? j.items : null;
})()`, 20_000);
EV.uniform.undoRows = Array.isArray(uniUndoRows) ? uniUndoRows.map((r) => r.plan_id) : null;
ok('U-20b 撤销统一值：3 行新建估算按删除回滚，1 行还原到写入前快照（3.5/4/5.5、manual、req）',
  Array.isArray(uniUndoRows) && uniUndoRows.length === 1 && uniUndoRows[0].plan_id === 'u-cx'
  && uniUndoRows[0].optimistic === 3.5 && uniUndoRows[0].likely === 4 && uniUndoRows[0].pessimistic === 5.5
  && uniUndoRows[0].source === 'manual' && uniUndoRows[0].phase === 'req',
  uniUndoRows);
await shot('04-uniform-undo');

// ---------------- 9) 只看未复核筛选 + 里程碑不参与 ----------------
// 期望格数全部由夹具派生（2 里程碑 + 4 普通）×3；红线一约束的是可写性，不是「有没有一份参考读数」。
const EXP_CELLS = ALL_TITLES.length * 3;
await idle('U-21');
const filterBefore = await cellsCount();
await ev(PE`const tb=p().querySelector('[role="toolbar"]'); const cb=tb?tb.querySelector('input[type="checkbox"]'):null; cb?.click(); return !!cb;`);
const manNow = ((await rest(`/estimates?projectId=${PID}`)).items || []).filter((i) => i.source === 'manual').map((i) => seedById(i.plan_id)?.[1]).filter(Boolean);
const expAfter = EXP_CELLS - manNow.length * 3;
const filterAfter = await until(PE`const n=${cellsExpr}.length; return n===${expAfter}?{n,labels:${cellsExpr}.map(i=>i.getAttribute('aria-label'))}:'';`, 15_000);
EV.filter = {
  before: filterBefore,
  after: filterAfter ? filterAfter.n : null,
  manual: manNow,
  hidden: manNow.every((t) => !(filterAfter?.labels ?? []).some((l) => String(l).startsWith(t))),
};
ok(`U-21 「只看未复核」把已复核（manual）行整行摘出列表：${EXP_CELLS} 个数字格 → ${expAfter} 个，摘掉的正是那 ${manNow.length} 条 manual 行`,
  filterBefore === EXP_CELLS && !!filterAfter && filterAfter.n === expAfter && EV.filter.hidden, EV.filter);
await ev(PE`const tb=p().querySelector('[role="toolbar"]'); const cb=tb?tb.querySelector('input[type="checkbox"]'):null; cb?.click(); return !!cb;`);
await until(PE`return ${cellsExpr}.length===${EXP_CELLS}?'1':''`, 15_000);
const msGuard = await ev(PE`const all=${cellsExpr};
  const isMs=(el)=>${JSON.stringify(MS_TITLES)}.some(ti=>String(el.getAttribute('aria-label')||'').startsWith(ti));
  const ms=all.filter(isMs), norm=all.filter((el)=>!isMs(el));
  return { msCells: ms.length, msDisabled: ms.length>0 && ms.every(i=>i.disabled),
    normCells: norm.length, normEnabled: norm.length>0 && norm.every(i=>!i.disabled), n: all.length,
    msLabels: ms.map(i=>({ l: i.getAttribute('aria-label'), d: i.disabled })) };`);
EV.msGuard = msGuard;
ok('U-22 里程碑只给**只读**参考格（存在但禁用）；明细格全部可编辑（红线一管的是可写性，不是有没有读数）',
  msGuard.msCells === MS_TITLES.length * 3 && msGuard.msDisabled === true
  && msGuard.normCells === NORM_TITLES.length * 3 && msGuard.normEnabled === true && msGuard.n === EXP_CELLS, msGuard);

// ---------------- 10) 窄视口：写路径新增的工具条不撑破覆盖式（§10-13 回归） ----------------
await setViewport(1100, 900);
const narrow = await until(PE`if(!p()) return ''; const a=p();
  const leaves=[...a.querySelectorAll('*')].filter(e=>!e.children.length && e.textContent.trim());
  const de=document.documentElement;
  return { docked: a.tagName==='ASIDE', overlay: !!a.closest('[role="dialog"][aria-modal="true"]'),
    panelHScroll: a.scrollWidth > a.clientWidth + 1, hScroll: de.scrollWidth > de.clientWidth + 1,
    clipped: leaves.filter(e=>e.scrollWidth > e.clientWidth + 1).map(e=>e.textContent.trim().slice(0,20)),
    toolbar: !!a.querySelector('[role="toolbar"]') };`, 20_000);
EV.narrow = narrow;
ok('U-23 覆盖式下面板仍无横向滚动、无文字截断，工具条随抽屉一起收窄',
  narrow && narrow.overlay === true && narrow.docked === false && !narrow.panelHScroll && !narrow.hScroll
  && narrow.clipped.length === 0 && narrow.toolbar === true, narrow);
await shot('05-overlay-narrow');
await setViewport(1920, 1000);
const logCheck = await rest(`/estimates?projectId=${PID}`);
ok('U-24 走查收尾：估算行仍只 1 条（所有伪写入都被撤销），明细可读',
  logCheck.items.length === 1 && Array.isArray(logCheck.summary.rowRatios), { items: logCheck.items.length });
ok('U-25 走查截图取证齐全（行内录入/被拒标红/批量撤销/统一值撤销/覆盖式）', shotFiles.length === 5, shotFiles);

// =====================================================================
// P 组：保留的产品文案 / 标识符锚一律 okPair（判据 3）
//   行为腿＝上面真机量到的结构/库/接口读数；字面腿＝已提交树里的文案与标识符。
//   红因分开：行为失守 ⇒ 立刻修功能；行为在而锚失配 ⇒ 人来判定改锚还是改码。
// =====================================================================
console.log('\n=== P 组：文案/标识符锚配对（行为失守⇒FAIL；行为在而锚失配⇒FAIL 交人判定） ===');
const P_SPECS = [
  { id: 'P-01', L: 'P-01 导航 seam「mtaskNavigate」真的把应用切到计划页且面板打开（字面腿：App.tsx 监听器名）',
    anchors: ['mtaskNavigate'], src: APP_HEAD, srcLbl: 'web/src/App.tsx',
    behavior: (e) => e.nav?.dispatch === true && e.nav?.panelOpen === true },
  { id: 'P-02', L: 'P-02 面板开合会话键「plan.estimatePanelOpen」种入后抽屉真的打开（字面腿：PlanPage 会话键名）',
    anchors: ['plan.estimatePanelOpen'], src: PLAN_HEAD, srcLbl: 'web/src/pages/PlanPage.tsx',
    behavior: (e) => e.nav?.panelOpen === true },
  { id: 'P-03', L: 'P-03 空态入口（行为：0 条估算行时出现虚线入口块、首行落库后消失；字面腿：空态文案）',
    anchors: ['尚未录入估算'], src: EP_HEAD, srcLbl: 'web/src/components/EstimatePanel.tsx',
    behavior: (e) => e.emptyRows0 === 0 && e.emptyCta?.block === true && e.emptyCtaGone === true },
  { id: 'P-04', L: 'P-04 「全选可见」选中全部 4 条普通行（行为：4 条普通行勾选、2 条里程碑未选且禁用；字面腿：按钮与计数文案）',
    anchors: ['全选可见', '已选 {selRows.length} 行'], src: EP_HEAD, srcLbl: 'web/src/components/EstimatePanel.tsx',
    behavior: (e) => e.selCount === 4 && Array.isArray(e.selState)
      && e.selState.filter((x) => NORM_TITLES.includes(x.t)).length === 4
      && e.selState.filter((x) => NORM_TITLES.includes(x.t)).every((x) => x.checked === true && x.disabled === false)
      && e.selState.filter((x) => MS_TITLES.includes(x.t)).every((x) => x.checked === false && x.disabled === true) },
  { id: 'P-05', L: 'P-05 「按用例加权重推」真的写入 u-case（行为：库内 2 行含 u-case；字面腿：档位按钮词）',
    anchors: ['按用例加权重推'], src: EP_HEAD, srcLbl: 'web/src/components/EstimatePanel.tsx',
    behavior: (e) => e.batch?.confirmShown === true && e.batch?.db?.length === 2 && e.batch.db.includes('u-case') },
  { id: 'P-06', L: 'P-06 dryRun 预览行数=写入行数（行为：门内直调预览 1 可写 / 3 跳过，库内只多 1 行；字面腿：确认框可写入/跳过文案）',
    anchors: ['行可写入', '行不属于该档'], src: EP_HEAD, srcLbl: 'web/src/components/EstimatePanel.tsx',
    behavior: (e) => e.batch?.previewWritable === 1 && e.batch?.previewSkipped === 3 && e.batch?.db?.length === 2 },
  { id: 'P-07', L: 'P-07 撤销条报写入行数并真回滚（行为：条上 1 行、撤销后库 1 行；字面腿：撤销条文案）',
    anchors: ['已填充 {last.count} 行 · 撤销'], src: EP_HEAD, srcLbl: 'web/src/components/EstimatePanel.tsx',
    behavior: (e) => e.undo?.barN === 1 && e.undo?.afterCount === 1 },
  { id: 'P-08', L: 'P-08 撤销 toast 的「还原/删除」两条通道（行为：u-case 被删、u-cx 保留；字面腿：toast 模板）',
    anchors: ['已撤销「', '还原 ${restored} 行', '删除 ${removed} 行新建估算'], src: EP_HEAD, srcLbl: 'web/src/components/EstimatePanel.tsx',
    behavior: (e) => e.undo?.afterCount === 1 && e.undo?.uCaseGone === true },
  { id: 'P-09', L: 'P-09 统一值表单「写入 N 行」触发 4 行写入（行为：库内 4 行；字面腿：入口与按钮文案）',
    anchors: ['统一值…', '写入 {selRows.length} 行'], src: EP_HEAD, srcLbl: 'web/src/components/EstimatePanel.tsx',
    behavior: (e) => e.uniform?.form === true && e.uniform?.afterRows === 4 },
  { id: 'P-10', L: 'P-10 统一值预览三点=门内独立算式（行为：预览读数 2.5/3/4；字面腿：预览模板）',
    anchors: ['O ${num(pts.optimistic)} / M ${num(pts.likely)} / P ${num(pts.pessimistic)}'], src: EP_HEAD, srcLbl: 'web/src/components/EstimatePanel.tsx',
    behavior: (e) => Array.isArray(e.uniform?.previewNums) && e.uniform.previewNums.slice(0, 3).join('/') === '2.5/3/4' },
  { id: 'P-11', L: 'P-11 统一值确认框点明「转人工」且四行真落 manual（行为：库内 4 行三点 2.5/3/4、来源全 manual；字面腿：确认措辞）',
    anchors: ['转「人工」'], src: EP_HEAD, srcLbl: 'web/src/components/EstimatePanel.tsx',
    behavior: (e) => e.uniform?.afterRows === 4 && e.uniform?.dbSources?.length === 1 && e.uniform.dbSources[0] === 'manual'
      && (e.uniform.dbVals ?? []).every((v) => v.join('/') === '2.5/3/4') },
  { id: 'P-12', L: 'P-12 统一值写入后撤销条报 4 行（行为：条上 4 行；字面腿：写入 toast 模板）',
    anchors: ['已填充 ${w.written} 行'], src: EP_HEAD, srcLbl: 'web/src/components/EstimatePanel.tsx',
    behavior: (e) => e.uniform?.afterRows === 4 && e.uniform?.undoN === 4 },
  { id: 'P-13', L: 'P-13 「只看未复核」隐藏 manual 行（行为：18→15 格且需求分析被摘出；字面腿：筛选标签词）',
    anchors: ['只看未复核'], src: EP_HEAD, srcLbl: 'web/src/components/EstimatePanel.tsx',
    behavior: (e) => e.filter?.before === 18 && e.filter?.after === 15 && e.filter?.hidden === true },
  { id: 'P-14', L: 'P-14 里程碑格只读（行为：2×3 格全禁用、4×3 普通格全可编辑；字面腿：组头「不进 Σ」）',
    anchors: ['不进 Σ'], src: EP_HEAD, srcLbl: 'web/src/components/EstimatePanel.tsx',
    behavior: (e) => e.msGuard?.msCells === 6 && e.msGuard?.msDisabled === true
      && e.msGuard?.normCells === 12 && e.msGuard?.normEnabled === true && e.msGuard?.n === 18 },
  { id: 'P-15', L: 'P-15 被拒行标红且库内原值未动（行为：role=alert 计数 1、O 仍 3.5/M 仍 4；字面腿：校验提示文案）',
    anchors: ['行不满足录入校验（O≤M≤P），导出前须修正'], src: EP_HEAD, srcLbl: 'web/src/components/EstimatePanel.tsx',
    behavior: (e) => e.redInfo?.styled === true && String(e.redInfo?.n) === '1' && e.redInfo?.dbUntouched === true },
  { id: 'P-16', L: 'P-16 规则批量写入 toast 的档名与行数同源（行为：库内 2 行含 u-case；字面腿：toast 模板）',
    anchors: ['已${BATCH_RULE_LABEL[mode]}写入 ${w.written ?? 0} 行'], src: EP_HEAD, srcLbl: 'web/src/components/EstimatePanel.tsx',
    behavior: (e) => e.batch?.db?.length === 2 && e.batch?.db?.includes('u-case') === true },
  { id: 'P-17', L: 'P-17 统一值倍率预填自动态参数（行为：表单预填=服务端 ruleRatio；字面腿：ruleRatio 取数点）',
    anchors: ['data?.params.config.ruleRatio'], src: EP_HEAD, srcLbl: 'web/src/components/EstimatePanel.tsx',
    behavior: (e) => !!e.uniform?.prefill && !!e.uniform?.ratio
      && e.uniform.prefill.oMul === String(e.uniform.ratio.oMul) && e.uniform.prefill.pMul === String(e.uniform.ratio.pMul) },
];
const literalOf = (it, src) => src.length > 0 && it.anchors.every((a) => src.includes(a));
for (const it of P_SPECS) {
  okPair(ok, it.L, () => it.behavior(EV) === true, () => literalOf(it, it.src),
    () => ({ 锚点: it.anchors, 取证: it.srcLbl, 字面命中: it.anchors.map((a) => it.src.includes(a)), 实测: it.id === 'P-03' ? { cta: EV.emptyCta, gone: EV.emptyCtaGone } : undefined }));
}

// =====================================================================
// N 组：负对照（判据 4 + 反模式 19/20）——每条都要能真的翻红
// =====================================================================
console.log('\n=== N 组：负对照 ===');
{
  // N-01 永真式探针（反模式 20）：字面腿喂空源码必须为假
  const vacuous = P_SPECS.filter((it) => { try { return literalOf(it, '') === true; } catch { return false; } });
  ok(`N-01 空源码探针：${P_SPECS.length} 条字面腿喂空串后全部为假（没有不承重的正则）`,
    P_SPECS.length >= 15 && vacuous.length === 0, { 条数: P_SPECS.length, 仍为真: vacuous.map((v) => v.id) });

  // N-01b 反向：真 HEAD 文本必须命中，否则字面腿是拿不存在的词恒红
  const missing = P_SPECS.filter((it) => it.src.length < 200 || it.anchors.some((a) => !it.src.includes(a)));
  ok(`N-01b HEAD 文本在场性：${P_SPECS.length} 组锚点在已提交树里逐字命中`,
    missing.length === 0, { 未命中: missing.map((m) => ({ id: m.id, 锚: m.anchors.filter((a) => !m.src.includes(a)) })),
      源码长度: { EP: EP_HEAD.length, APP: APP_HEAD.length, PLAN: PLAN_HEAD.length } });

  // N-02 敏感度探针：抽掉运行期实测料后，行为腿必须全部转假
  const stillGreen = P_SPECS.filter((it) => { try { return it.behavior({}) === true; } catch { return false; } });
  ok(`N-02 敏感度探针：抽干运行期实测料后 ${P_SPECS.length} 条行为腿全部转假——行为腿确实在读实测，不是恒真`,
    P_SPECS.length >= 15 && stillGreen.length === 0, { 仍为真: stillGreen.map((v) => v.id) });
  const backGreen = P_SPECS.filter((it) => it.behavior(EV) !== true);
  ok('N-02b 还原实证：实测料回填后同一批行为腿重新为真（N-02 的红不是恒红）',
    backGreen.length === 0, { 还原后仍为假: backGreen.map((v) => v.id) });

  // N-03 改名模拟（逐锚点）：先自证副本≠原件，再要求同一条字面判据转假
  const n3Bad = [];
  let anchorN = 0;
  for (const it of P_SPECS) {
    for (const a of it.anchors) {
      anchorN += 1;
      const tampered = it.src.split(a).join('§§');
      if (tampered === it.src) { n3Bad.push({ id: it.id, 锚: a, 因: '篡改未落地（副本==原件，等于没有牙）' }); continue; }
      if (literalOf(it, tampered) !== false) n3Bad.push({ id: it.id, 锚: a, 因: '抹掉锚后字面腿仍为真' });
    }
  }
  ok(`N-03 改名模拟：${anchorN} 个锚点逐个从 HEAD 副本中抹掉后，字面判据各自转假（且每条自证 tampered !== original）`,
    anchorN >= 15 && n3Bad.length === 0, { 锚点数: anchorN, 失牙: n3Bad });

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

  // N-05 行为腿的牙：把实测料按不同破坏形态各改一份，对应行为腿必须转假
  const clone = () => JSON.parse(JSON.stringify(EV));
  const spec = (id) => P_SPECS.find((it) => it.id === id);
  const muts = [];
  const add = (id, mutate) => { const e = clone(); mutate(e); muts.push({ id, flipped: spec(id).behavior(e) === false }); };
  add('P-01', (e) => { e.nav.panelOpen = false; });
  add('P-03', (e) => { e.emptyCtaGone = false; });
  add('P-04', (e) => { e.selState.find((x) => x.t === '需求分析').checked = false; });
  add('P-05', (e) => { e.batch.db = ['u-cx']; });
  add('P-06', (e) => { e.batch.previewWritable = 2; });
  add('P-07', (e) => { e.undo.afterCount = 2; });
  add('P-09', (e) => { e.uniform.afterRows = 3; });
  add('P-10', (e) => { e.uniform.previewNums = [2.5, 3, 5]; });
  add('P-11', (e) => { e.uniform.dbSources = ['manual', 'rule']; });
  add('P-12', (e) => { e.uniform.undoN = 3; });
  add('P-13', (e) => { e.filter.after = 18; });
  add('P-14', (e) => { e.msGuard.msDisabled = false; });
  add('P-15', (e) => { e.redInfo.n = 2; });
  add('P-17', (e) => { e.uniform.prefill.oMul = '9'; });
  ok(`N-05 破坏形态反证：${muts.length} 类实测料被改写后对应行为腿各自转假（计数/库行/预览/来源/筛选/只读/告警/倍率）`,
    muts.length === 14 && muts.every((m) => m.flipped === true), muts);
}

// 截图/结果收口
console.log(`\n截图：${SHOTS}`);
ws.close();
bye();
cleanup();
console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
