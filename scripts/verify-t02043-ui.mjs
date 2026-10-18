#!/usr/bin/env node
/**
 * T02043（估算视图 §5.2 第 4 段「导出区」· E6）真机走查：CDP 驱动 headless Chrome 打开**隔离实例**的
 * 估算面板，只断言「非真实浏览器不能回答」的问题：
 *   ① 点「导出 Excel」真的发出 GET /api/estimates/export-xlsx 并真的产生一次下载（件名与字节来自服务端，
 *      不是前端拼的第二套命名——下载名逐字等于服务端写进快照的 filename）；
 *   ② 下载体是真 xlsx（PK 头 + 正确 MIME + 体积），客户版/内部版 radio 与「只导已估算行」真的进 query；
 *   ③ §5.2「O>M 标红、导出禁用」在有行内录入错误时成立，且禁用期间点不出请求；
 *   ④ §6.3 快照留痕与 §7 两条对比在界面上出数，数字与服务端 compare 响应同源、与手算 ΔE 一致；
 *   ⑤ 「N 行为系统推导值，未人工复核」用的是 rule+default 口径（不是只数 default）；
 *   ⑥ 三档视口与 <1200px 覆盖式下导出区不产生横向滚动。
 *
 * T02293 判据落地：U 组只认结构句柄（导出区 = 恰含 2 枚 radio 的 section；Excel = 该 section 第 1 个
 * button；受众 = radio DOM 序 0/1，映射由服务端快照 audience 反证；scope = section 内唯一带 label 的
 * checkbox；快照勾选 = 不带 label 的 checkbox；对比 = 勾两条后 section 第 4 个 button；差异区 = 唯一
 * fieldset；行内错误 = 面板唯一 role=alert；行容器 = 含夹具标题且恰 3 个号码框的 div，输入按 DOM 序
 * O/M/P）、网络请求 query、服务端快照 payload / compare 响应体、下载 Blob 字节与件名。产品中文文案与
 * 标识符锚一律进 P 组的 `okPair` 字面腿（取证面 `git show HEAD:`）。N 组负对照：空源码、HEAD 在场性、
 * 抽干实测料、逐锚改名、okPair 契约、按类破坏行为腿。
 *
 * 用法（Chrome 用系统安装版；本仓内置 Browser 无视口不能点击/截图，见 memory）：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02043-ui.mjs
 *   环境变量：T02043_UI_PORT（默认 39936）、T02043_UI_CDP（默认 9346）
 *
 * 隔离纪律（skill 红线 8）：MTask_DATA_DIR 指临时目录、端口自配，不碰生产库与用户实例；
 * 下载在页面内拦截（不写盘），截图落每轮独立子目录（`MTASK_GATE_ARTIFACT_DIR/<门名>-<运行标识>/`，T02312：不再落仓库根固定名目录，防并发整图互覆）。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 临时根必须落 D:（C: 常年 0 可用，SQLITE_FULL 会伪装成产品失败）
const TMP_ROOT = existsSync('D:/code/tmp') ? 'D:/code/tmp' : tmpdir();
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't02043-ui-'));
const CHROME_PROFILE = mkdtempSync(join(TMP_ROOT, 't02043-ui-chrome-'));
if (!process.env.MTASK_GATE_ARTIFACT_DIR) process.env.MTASK_GATE_ARTIFACT_DIR = join(TMP_ROOT, 'mtask-gate-shots');
// T02312：截图不落仓库根固定名目录（并发跑门时同一步骤名整图互覆，且仓库根长期堆未纳管产物）——
// 改用 gate-results 的进程级 RUN_TAG 子目录，与本轮文本产物同标识，可按标识核对归属。
const { gateShotsDir } = await import(pathToFileURL(join(ROOT, 'scripts/lib/gate-results.mts')).href);
const { okPair } = await import(pathToFileURL(join(ROOT, 'scripts/lib/anchor-pair.mts')).href);
const SHOTS = gateShotsDir('t02043');
const PORT = Number(process.env.T02043_UI_PORT ?? 39936);
const CDP = Number(process.env.T02043_UI_CDP ?? 9346);
const CHROME = process.env.T02043_UI_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra).toString().slice(0, 400)}` : ''}`);
  }
};

/** 反模式 11：字面腿取已提交树（工作树可能躺着别的会话的过期产品文件） */
const headSource = (rel) => {
  try { return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }); } catch { return ''; }
};
const EP_HEAD = headSource('web/src/components/EstimatePanel.tsx');
const PLAN_HEAD = headSource('web/src/pages/PlanPage.tsx');
const APP_HEAD = headSource('web/src/App.tsx');
const COPY_HEAD = headSource('server/src/services/estimateCopy.ts');
const ROUTES_HEAD = headSource('server/src/routes/estimates.ts');
/** 运行期实测料（行为腿只读它；N 组抽干后必须全部转假） */
let EV = {};

// ---------------- 1) 夹具：临时库直写（进程内，起服务前完成） ----------------
process.env.MTask_DATA_DIR = DATA_DIR;
const { getDb, closeDb } = await import('../server/src/db/connection.ts');
const { initSchema } = await import('../server/src/db/schema.ts');
initSchema();
const T = '2026-10-11T00:00:00.000Z';
const PID = 'ui-e6x';
const PNAME = 'T02043-导出区走查';
const DEVM = '导出走查主行'; // 将被行内改 M 的那一行，用标题在面板里定位
const db = getDb();
db.prepare('INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
  .run(PID, PNAME, '', T, T);
const insPlan = db.prepare(
  `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
     progress, status, assignee, sort_order, created_at, updated_at, kind, complexity, req_ids, deps)
   VALUES (?, ?, ?, '', '2026-10-12', '2026-10-12', ?, 0, 'todo', '', ?, ?, ?, ?, ?, null, ?)`,
);
// 三点取「E 是整数」的组合：改 M 6→7.5 时 dev 阶段 ΔE 恰为 1 人天，界面上的差值可手算复核
const seeds = [
  ['ms-1', 'M1 基座', 8, 1, 'milestone', 4, null],
  ['r-a', DEVM, 12, 2, 'normal', 3, JSON.stringify([{ id: 'ms-1', type: 'child' }])],
  ['r-b', '规则推导行', 6, 3, 'normal', 2, JSON.stringify([{ id: 'ms-1', type: 'child' }])],
  ['r-c', '默认建议行', 4, 4, 'normal', 1, JSON.stringify([{ id: 'ms-1', type: 'child' }])],
  ['r-d', '尚未估算行', 5, 5, 'normal', 2, JSON.stringify([{ id: 'ms-1', type: 'child' }])],
];
for (const [id, title, dur, sort, kind, cx, deps] of seeds) insPlan.run(id, PID, title, dur, sort, T, T, kind, cx, deps);
const insEst = db.prepare(
  `INSERT INTO estimate_items (id, project_id, plan_id, phase, unit, optimistic, likely, pessimistic, source, note, created_at, updated_at)
   VALUES (?, ?, ?, ?, 'man_day', ?, ?, ?, ?, ?, ?, ?)`,
);
insEst.run('e-a', PID, 'r-a', 'dev', 3, 6, 9, 'manual', '', T, T);
insEst.run('e-b', PID, 'r-b', 'dev', 2, 4, 6, 'rule', '', T, T);
insEst.run('e-c', PID, 'r-c', 'req', 1, 2, 3, 'default', '', T, T);
// 未估算行 r-d 故意没有 estimate_items：scope=all 时它成行但三点留空
db.prepare("INSERT INTO app_settings (key, value) VALUES ('estimate.hideCoefsForClient', '1')").run();
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
  if (process.env.T02043_UI_KEEP) return;
  for (const dir of [DATA_DIR, CHROME_PROFILE]) {
    for (let i = 0; i < 8; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break; } catch { sleepSync(i); }
    }
  }
};
process.on('exit', cleanup);

let serverUp = false;
for (let i = 0; i < 90; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) { serverUp = true; break; } } catch { /* */ } await sleep(500); }
ok('E-00 隔离服务启动（临时端口 + 临时库，三条已估算 + 一条未估算，客户版折叠开关已置 1）', serverUp);
if (!serverUp) {
  // 起不来时最缺的就是「为什么」：把子进程输出原样吐出来，否则下一轮还是盲跑
  console.log(`\n—— 服务日志（${DATA_DIR}）——\n${serverLog.join('').split('\n').slice(-40).join('\n')}`);
  console.log('\n服务未起来，终止');
  process.exit(1);
}

let wsUrl = '';
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP}/json/list`);
    if (r.ok) { const t = (await r.json()).find((x) => x.type === 'page'); if (t) { wsUrl = t.webSocketDebuggerUrl; break; } }
  } catch { /* Chrome 还在起 */ }
  await sleep(400);
}
ok('E-01 Chrome CDP 通道就绪（系统 Chrome, headless=new）', !!wsUrl, wsUrl);
if (!wsUrl) process.exit(1);

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pend = new Map();
const netLog = [];
let compareBody = null;
const send = (method, params = {}) => new Promise((res) => { const i = ++seq; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (ev2) => {
  const m = JSON.parse(ev2.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method !== 'Network.responseReceived') return;
  const u = m.params.response.url;
  if (/\/api\/estimates/.test(u)) netLog.push({ url: u.replace(/^https?:\/\/[^/]+/, ''), status: m.params.response.status });
  // §7 对比：抓**页面自己发出的那次**响应体，界面数字必须与它同源（不靠门里另发一条 REST 重放）
  if (/\/api\/estimates\/snapshots\?/.test(u) && /[?&]compare=/.test(u)) {
    send('Network.getResponseBody', { requestId: m.params.requestId }).then((r) => {
      const raw = r?.result?.body ?? '';
      compareBody = { url: u, status: m.params.response.status, body: r?.result?.base64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw };
    }).catch(() => { /* 响应体取不到时行为腿自然转假 */ });
  }
};
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
/** 反模式 23：超时返回 null（不是空串），调用方按类型守卫判定 */
async function until(expr, ms = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await ev(expr);
    if (v) return v;
    await sleep(300);
  }
  return null;
}
async function waitNode(fn, ms = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await sleep(200);
  }
  return null;
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
 * 批量填充工具条（role=toolbar）且正文至少含两个夹具计划标题。产品文案一概不进行为腿。
 */
const FT_JSON = JSON.stringify([DEVM, '规则推导行']);
const PJ = `const FT=${FT_JSON};
  const p=()=>[...document.querySelectorAll('aside,[role="dialog"][aria-modal="true"]')].find(d=>d.querySelector('[role="toolbar"]')&&FT.filter(t=>d.textContent.includes(t)).length>=2)||null;
  const rg=()=>{const q=p();if(!q)return null;return [...q.querySelectorAll('section')].find(s=>s.querySelectorAll('input[type="radio"]').length===2&&s.querySelector('input[type="checkbox"]'))||null;};
  const radios=()=>rg()?[...rg().querySelectorAll('input[type="radio"]')]:[];
  const scopeCb=()=>rg()?rg().querySelector('label input[type="checkbox"]'):null;
  const snapCbs=()=>rg()?[...rg().querySelectorAll('input[type="checkbox"]')].filter(c=>!c.closest('label')):[];
  const snapRows=()=>snapCbs().map(c=>[...rg().querySelectorAll('div')].find(d=>d.contains(c)&&d.querySelectorAll(':scope > input[type="checkbox"]').length===1)).filter(Boolean);
  const row=(t)=>{const q=p();if(!q)return null;return [...q.querySelectorAll('div')].find(d=>d.querySelectorAll('input[type="number"]').length===3&&d.textContent.includes(t))||null;};
  const cluster=()=>{const rs=radios();return rs.length?rs[0].closest('label').parentElement:null;};`;
/** 面板内求值统一套 IIFE（裸 return 交给 Runtime.evaluate 是语法错误，T02040 踩过） */
const PE = (strings, ...exprs) => {
  let body = strings[0];
  exprs.forEach((e, i) => { body += String(e) + strings[i + 1]; });
  return `(() => { ${PJ}${body} })()`;
};
const EXP = PE`const b=rg()&&rg().querySelectorAll('button')[0]; if(!b)return 'nobtn';
  b.scrollIntoView({block:'center'}); b.click(); return 'clicked';`;
/** radio / checkbox 控件本体不是 button（T02041 的假绿教训：找不到按钮会静默返回并让断言空过） */
const setAudience = (client) => PE`const rs=radios(); const r=rs[${client ? 0 : 1}];
  if(!r) return 'noradio'; if(!r.checked) r.click(); return r.checked?'ok':'stuck';`;
const setOnlyEstimated = (on) => PE`const c=scopeCb(); if(!c) return 'nochk';
  if(c.checked!==${on}) c.click(); return c.checked===${on}?'ok':'stuck';`;
/** 快照行勾选框：导出区里不带 label 的 checkbox，DOM 序即服务端倒序 */
const pickSnap = (i) => PE`const cs=snapCbs(); const c=cs[${i}]; if(!c) return 'none';
  if(!c.checked) c.click(); return 'ok';`;
const SNAP_STATE = PE`const cs=snapCbs(); return { n: cs.length, picked: cs.map((c)=>c.checked) };`;
/** 快照行 = 直接子复选 + 四段 span（时间戳 / 格式 / 受众 / 人月）；按结构位置读，不靠文案 */
const SNAP_INFO = PE`const rows=snapRows();
  return { n: rows.length,
    mm: rows.map(r=>{const sp=[...r.querySelectorAll(':scope > span')];return sp.length?sp[sp.length-1].textContent.trim():'';}),
    aud: rows.map(r=>{const sp=[...r.querySelectorAll(':scope > span')];return sp.length>=3?sp[2].textContent.trim():'';}),
    audColor: rows.map(r=>{const sp=[...r.querySelectorAll(':scope > span')];return sp.length>=3?getComputedStyle(sp[2]).color:'';}) };`;
/** 差异区 = 导出区唯一 fieldset：首子为表头、末子为合计、中间每行两段 span（阶段名 / 差值） */
const DIFF_INFO = PE`const g=rg()&&rg().querySelector('fieldset'); if(!g)return null;
  const kids=[...g.children]; if(kids.length<2)return null;
  const phases=kids.slice(1,-1).map(el=>[...el.querySelectorAll('span')].map(s=>s.textContent.trim()));
  const total=[...kids[kids.length-1].querySelectorAll('span')].map(s=>s.textContent.trim());
  return { phases, total };`;
/** 行内输入：行容器按夹具标题定位，号码框 DOM 序 = O / M / P（POINT_FIELDS 单源顺序） */
const setRowPoint = (title, idx, val) => PE`const r=row(${JSON.stringify(title)}); const ins=r?[...r.querySelectorAll('input[type="number"]')]:[]; const el=ins[${idx}];
  if(!el) return 'missing'; el.focus(); const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
  d.set.call(el,${JSON.stringify(String(val))}); el.dispatchEvent(new Event('input',{bubbles:true}));
  el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return el.value;`;
const rest = async (path) => (await fetch(`${BASE}/api${path}`)).json();
const reqOf = (n) => {
  if (!n) return null;
  try {
    const u = new URL(`http://x${n.url}`);
    return { status: n.status, audience: u.searchParams.get('audience'), scope: u.searchParams.get('scope') };
  } catch { return { status: n.status }; }
};
const exportReqs = () => netLog.filter((n) => /export-xlsx/.test(n.url));
const payloadOf = (snap) => { try { return typeof snap?.payload === 'string' ? JSON.parse(snap.payload) : (snap?.payload ?? null); } catch { return null; } };
const firstNum = (s) => { const m = String(s ?? '').match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : NaN; };
const approx = (a, b, eps = 1e-6) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps;
async function diag(tag) {
  const panel = await ev(PE`return rg()?rg().textContent.slice(-600):'no-region';`);
  const errs = await ev(`(window.__errs||[]).slice(-3).join(' | ')`);
  const srv = serverLog.join('').split('\n').filter((l) => /estimates|error|异常/i.test(l)).slice(-4).join(' ⏎ ');
  console.log(`  [DIAG ${tag}] 导出区尾部: ${String(panel).replace(/\s*\n+\s*/g, ' ⏎ ').slice(-400)}`);
  console.log(`  [DIAG ${tag}] 页面报错: ${errs || '无'}`);
  console.log(`  [DIAG ${tag}] 服务日志: ${srv || '无匹配行'}`);
  console.log(`  [DIAG ${tag}] 接口请求: ${netLog.slice(-5).map((n) => `${n.status} ${n.url}`).join(' | ') || '无'}`);
}

await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try {
    window.__errs = []; window.__dl = []; window.__blobs = [];
    window.addEventListener('error', (e) => window.__errs.push(String(e.message)));
    const oc = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b) => { window.__blobs.push(b); return oc(b); };
    const ac = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.hasAttribute('download')) { window.__dl.push(this.getAttribute('download')); return; }
      return ac.call(this);
    };
    sessionStorage.setItem('plan.projectId', JSON.stringify(${JSON.stringify(PID)}));
    sessionStorage.setItem('plan.viewMode', JSON.stringify('timeline'));
    sessionStorage.setItem('plan.estimatePanelOpen', JSON.stringify(true));
    localStorage.setItem('mtask.projectGuide.seen', '1');
    ['tasks', 'aitools', 'prompts', 'req', 'plan', 'report', 'history', 'queue', 'exec-sessions', 'settings']
      .forEach((t) => localStorage.setItem('mtask.guide.seen.' + t, '1'));
  } catch (e) {}`,
});
await send('Page.navigate', { url: `${BASE}/?m=0` });
const pageReady = await until(`document.readyState==='complete' && document.querySelectorAll('button').length>0 ? 1 : ''`, 30_000);
/** 导航走应用自己的对外 seam（App 监听 mtaskNavigate），不点产品文案按钮 */
const navSeam = `(() => { globalThis.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'plan' } })); return 1; })()`;
let panelUp = null;
for (let i = 0; i < 20; i++) {
  await ev(navSeam);
  panelUp = await until(PE`return p() ? 1 : '';`, 1_500);
  if (panelUp) break;
}
ok('E-02 页面加载并经导航 seam 打开计划页', pageReady === 1, { pageReady });
if (!panelUp) await diag('panel');
ok('E-03 估算面板已打开（会话态种入开键，面板句柄=工具条+两个夹具标题）', panelUp === 1);
if (!panelUp) {
  console.log('\n面板未打开，终止');
  process.exit(1);
}
await setViewport(1920, 1000);
await until(PE`return rg() ? 1 : '';`, 25_000);

EV.page = { ready: pageReady === 1 ? 1 : 0, nav: panelUp === 1 ? 1 : 0 };

console.log('\n=== 导出区落地形态（§5.2 第 4 段） ===');
const shape = await ev(PE`const r=rg(); if(!r) return null; const rs=radios();
  return { radios: rs.length, sameName: new Set(rs.map(x=>x.name)).size===1 && !!rs[0].name,
    scopeLabeled: !!scopeCb(), exportButtons: r.querySelectorAll('button').length };`);
EV.panel = { root: 1, toolbar: (await ev(PE`return p()&&p().querySelector('[role="toolbar"]') ? 1 : 0;`)) === 1 ? 1 : 0, ...(shape ?? {}) };

const initUi = await ev(PE`const rs=radios(); const c=scopeCb(); const b=rg()&&rg().querySelectorAll('button')[0];
  return { clientChecked: !!rs[0]&&rs[0].checked, internalChecked: !!rs[1]&&rs[1].checked,
    scopeChecked: !!c&&c.checked, excelEnabled: !!b&&!b.disabled, uiRows: snapRows().length };`);
const snapList0 = await rest(`/estimates/snapshots?projectId=${PID}`);
EV.initial = { ...(initUi ?? {}), snapRows: (snapList0.snapshots ?? []).length };

await ev(setAudience(true));
await sleep(800);
EV.fold = { clientSpans: await ev(PE`return cluster()?cluster().querySelectorAll(':scope > span').length:-1;`) };
await ev(setAudience(false));
await sleep(800);
EV.fold.internalSpans = await ev(PE`return cluster()?cluster().querySelectorAll(':scope > span').length:-1;`);
await shot('00-export-region-initial');

console.log('\n=== 内部版导出：请求、真实下载与件名同源 ===');
const n0 = exportReqs().length;
await ev(EXP);
const dl1 = await until(`window.__dl.length>=1 ? 1 : ''`, 30_000);
if (!dl1) await diag('x1');
const req1 = reqOf(exportReqs()[n0]);
const dlInfo1 = await ev(`(() => { const n=window.__dl.length; const out=[];
  for (let i=0;i<n;i++) out.push({ name: window.__dl[i], blobs: !!window.__blobs[i] });
  return out; })()`);
const blob1 = await ev(`(async () => { const b=window.__blobs[window.__blobs.length-1];
  if(!b) return null; const buf=await b.arrayBuffer(); const u8=new Uint8Array(buf.slice(0,4));
  return { type: b.type, size: buf.byteLength, head: Array.from(u8).map((x)=>x.toString(16).padStart(2,'0')).join('') }; })()`);
// toast 寿命短：先抓它，再去做快照 REST 往返
const srvNameHint = String(dlInfo1?.[0]?.name ?? '');
const toastTexts = await until(`(() => { const t=[...document.querySelectorAll('.flash-toast')].map(x=>x.textContent).join(' | ');
  return t.includes(${JSON.stringify(srvNameHint)}) ? t : ''; })()`, 10_000);
const snapList1 = await rest(`/estimates/snapshots?projectId=${PID}`);
const snap1 = (snapList1.snapshots ?? [])[0];
const srvName1 = snap1?.filename;
const payload1 = payloadOf(snap1);
const srvNameForWait = String(srvName1 ?? '');
const note1 = await until(PE`const f=${JSON.stringify(srvNameForWait)};
  const ds=[...rg().querySelectorAll('div')].filter(d=>d.textContent.includes(f));
  ds.sort((a,b)=>a.querySelectorAll('*').length-b.querySelectorAll('*').length);
  return ds[0]?ds[0].textContent:'';`, 20_000);
await until(PE`return snapRows().length===1 ? 1 : '';`, 20_000);
const uiSnap1 = await ev(SNAP_INFO);
const estAll = await rest(`/estimates?projectId=${PID}`);
EV.x1 = {
  req: req1, dlName: dlInfo1?.[0]?.name ?? null, srvName: srvName1 ?? null, blob: blob1,
  toast: toastTexts ?? '', note: note1 ?? '', uiSnap: uiSnap1, payload: payload1,
  nonManual: (estAll.items ?? []).filter((i) => i.source !== 'manual').length, items: (estAll.items ?? []).length,
};
await shot('01-export-internal-done');

console.log('\n=== 行内改值 → 客户版导出 → 只导已估算行 ===');
await ev(setRowPoint(DEVM, 1, '7.5')); // O/M/P DOM 序的中间框就是 M
let itemA = null;
for (let i = 0; i < 60 && !(itemA?.likely === 7.5); i++) {
  const r = await rest(`/estimates?projectId=${PID}`);
  itemA = (r.items ?? []).find((x) => x.plan_id === 'r-a') ?? null;
  if (!(itemA?.likely === 7.5)) await sleep(300);
}
EV.edit = { likely: itemA?.likely ?? null, source: itemA?.source ?? null };
await until(PE`const i=[...p().querySelectorAll('input[type="number"]')]; return i.length>0 && i.every((x)=>!x.disabled) ? 1 : '';`, 25_000);

await ev(setAudience(true));
await sleep(500);
const n1 = exportReqs().length;
await ev(EXP);
await until(`window.__dl.length>=2 ? 1 : ''`, 30_000);
const req2 = reqOf(exportReqs()[n1]);
const snapList2 = await rest(`/estimates/snapshots?projectId=${PID}`);
const snap2 = (snapList2.snapshots ?? [])[0];
const srvName2 = snap2?.filename;
const payload2 = payloadOf(snap2);
await until(PE`return snapRows().length===2 ? 1 : '';`, 20_000);
const uiSnap2 = await ev(SNAP_INFO);
const dlInfo2 = await ev(`window.__dl.slice()`);
EV.x2 = {
  req: req2, dlName: dlInfo2?.[1] ?? null, srvName: srvName2 ?? null, payloadAudience: payload2?.audience ?? null,
  uiSnap: uiSnap2, snapAudiences: (snapList2.snapshots ?? []).slice(0, 2).map((s) => payloadOf(s)?.audience ?? null),
};

const n2 = exportReqs().length;
await ev(setOnlyEstimated(true));
await sleep(400);
await ev(EXP);
await until(`window.__dl.length>=3 ? 1 : ''`, 30_000);
const req3 = reqOf(exportReqs()[n2]);
const snapList3 = await rest(`/estimates/snapshots?projectId=${PID}`);
const snap3 = (snapList3.snapshots ?? [])[0];
const payload3 = payloadOf(snap3);
await until(PE`return snapRows().length===3 ? 1 : '';`, 20_000);
const uiSnap3 = await ev(SNAP_INFO);
EV.x3 = {
  req: req3, payloadScope: payload3?.scope ?? null, uiSnap: uiSnap3,
  checkCount: (await ev(SNAP_STATE))?.n ?? null,
  timestamps: (snapList3.snapshots ?? []).slice(0, 3).map((s) => s.created_at),
};
await ev(setOnlyEstimated(false));
await shot('02-three-snapshots');

console.log('\n=== §7 两条对比在界面上出数 ===');
await ev(pickSnap(2)); // 最早一条（内部版，改值前）
await ev(pickSnap(1)); // 客户版（改值后）
const picked = await ev(SNAP_STATE);
await until(PE`return rg()&&rg().querySelectorAll('button').length>=4 ? 1 : '';`, 10_000);
const btnCount = await ev(PE`return rg()?rg().querySelectorAll('button').length:null;`);
await ev(PE`const bs=rg().querySelectorAll('button'); if(bs.length!==4) return 'bad'; bs[3].click(); return 'clicked';`);
const fieldsetReady = await until(PE`return rg()&&rg().querySelector('fieldset') ? 1 : '';`, 25_000);
if (!fieldsetReady) await diag('compare');
const diff = await ev(DIFF_INFO);
const cmpNet = await waitNode(() => compareBody, 20_000);
let cmpJson = null;
try { cmpJson = cmpNet?.body ? JSON.parse(cmpNet.body) : null; } catch { cmpJson = null; }
const srvPhases = cmpJson?.compare?.diff?.phases ?? null;
const srvTotal = cmpJson?.compare?.diff?.totals?.actualManMonths ?? null;
const uiPhases = (diff?.phases ?? []).map(([label, deltaText]) => ({ label, delta: firstNum(deltaText), plus: String(deltaText).trim().startsWith('+') }));
const totalText = diff?.total?.[1] ?? '';
EV.cmp = {
  btnCount, picked, fieldset: fieldsetReady === 1,
  uiPhases, uiTotalNum: firstNum(totalText), uiTotalPlus: String(totalText).trim().startsWith('+'),
  serverPhases: srvPhases, serverTotal: srvTotal, compareStatus: cmpNet?.status ?? null,
  compareBodyPresent: !!cmpNet?.body,
};
await shot('03-snapshot-compare');

await ev(pickSnap(0));
await sleep(500);
const picked3 = await ev(SNAP_STATE);
EV.cmp.thirdPicked = picked3?.picked ?? null;

console.log('\n=== §5.2 行内错误态：导出禁用 ===');
const bad400Before = netLog.filter((n) => n.status === 400).length;
await ev(setRowPoint(DEVM, 2, '1')); // P<O，服务端应拒
const alertText = await until(PE`const a=p().querySelector('[role="alert"]'); return a?a.textContent:'';`, 20_000);
const bad400After = netLog.filter((n) => n.status === 400).length;
const disState = await ev(PE`const b=rg()&&rg().querySelectorAll('button')[0]; return b?{dis:b.disabled,title:b.title}:null;`);
await shot('04-rowerror-export-disabled');
const expBefore = exportReqs().length;
await ev(EXP);
await sleep(1_200);
const expAfter = exportReqs().length;
await ev(setRowPoint(DEVM, 2, '9')); // 改回合法值
const recovered = await until(PE`const a=p()&&p().querySelector('[role="alert"]');
  const b=rg()&&rg().querySelectorAll('button')[0];
  return !a && b && !b.disabled ? 1 : '';`, 25_000);
EV.err = {
  alertText: alertText ?? '', status400: bad400After - bad400Before,
  disabled: disState?.dis === true, title: disState?.title ?? '',
  exportCountBefore: expBefore, exportCountAfter: expAfter, recovered: recovered === 1 ? 1 : 0,
};

console.log('\n=== 视口与健壮性 ===');
const widths = [];
for (const w of [1920, 1440, 1200]) {
  await setViewport(w, 1000);
  widths.push(await ev(PE`const r=rg(); const b=r&&r.querySelectorAll('button')[0];
    return r?{w:${w}, wide:r.scrollWidth-r.clientWidth>1, btn:!!b}:null;`));
}
await setViewport(1100, 1000);
const overlayProbe = `(() => {
  const FT=${FT_JSON};
  const d=[...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find(x=>x.querySelector('[role="toolbar"]')&&FT.filter(t=>x.textContent.includes(t)).length>=2);
  if(!d) return null;
  const s=[...d.querySelectorAll('section')].find(z=>z.querySelectorAll('input[type="radio"]').length===2);
  if(!s) return null;
  const b=s.querySelectorAll('button')[0];
  return { wide: s.scrollWidth-s.clientWidth>1, btn: !!b };
})()`;
const overlay = await until(overlayProbe, 20_000);
await shot('05-export-overlay-1100');
await setViewport(1920, 1000);
const jsErrors = await ev(`(window.__errs||[]).slice(-5)`);
const apiBad = netLog.filter((n) => /export-xlsx|snapshots/.test(n.url) && n.status >= 500).length;
const logErr = /estimates.*(500|异常|Error)/i.test(serverLog.join(''));
EV.vp = { widths, overlay };
EV.health = { jsErrors: Array.isArray(jsErrors) ? jsErrors : ['probe-null'], apiBad, logErr };

// ---------------- 4) U 组：行为腿（只读 EV；N 组抽干后必须全部转假） ----------------
const D_E = (3 + 4 * 7.5 + 9) / 6 - (3 + 4 * 6 + 9) / 6; // 手算 = 1 人天
const D_MM = (D_E / 20.83) * 1.23;
const BEHAVIOR = [];
const beh = (id, label, fn, extra) => BEHAVIOR.push({ id, label, fn, extra });
beh('E-04', '导出区结构：2 枚同名 radio + 1 枚带 label 的 scope 勾选 + 3 枚导出按钮',
  () => EV.panel?.root === 1 && EV.panel?.toolbar === 1 && EV.panel?.radios === 2 && EV.panel?.sameName === true
    && EV.panel?.scopeLabeled === true && EV.panel?.exportButtons === 3, EV.panel);
beh('E-05', '初始态：radio[1] 选中、scope 未勾、Excel 可用、快照 0 行',
  () => EV.initial?.clientChecked === false && EV.initial?.internalChecked === true && EV.initial?.scopeChecked === false
    && EV.initial?.excelEnabled === true && EV.initial?.snapRows === 0 && EV.initial?.uiRows === 0, EV.initial);
beh('E-06', '客户版折叠提示的节点只在客户受众出现（内部受众 0 个直接 span）',
  () => EV.fold?.clientSpans === 1 && EV.fold?.internalSpans === 0, EV.fold);
beh('E-07', 'Excel 导出请求 audience=internal & scope=all 且 200',
  () => EV.x1?.req?.status === 200 && EV.x1?.req?.audience === 'internal' && EV.x1?.req?.scope === 'all', EV.x1?.req);
beh('E-08', '下载件名逐字等于服务端快照 filename（前端没有第二套命名）',
  () => !!EV.x1?.dlName && EV.x1.dlName === EV.x1.srvName, { dl: EV.x1?.dlName, srv: EV.x1?.srvName });
beh('E-09', '下载体是真 xlsx（PK 头 + 表格 MIME + 体积过 5KB）',
  () => EV.x1?.blob?.head === '504b0304'
    && EV.x1.blob.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    && EV.x1.blob.size > 5000, EV.x1?.blob);
beh('E-10', '导出成功 toast 带服务端件名',
  () => !!EV.x1?.srvName && String(EV.x1?.toast ?? '').includes(EV.x1.srvName), EV.x1?.toast);
beh('E-11', '快照留痕 1 行，行内人月数 = 服务端 payload 的 actualManMonths（界面保留两位小数）',
  () => EV.x1?.uiSnap?.n === 1 && approx(firstNum(EV.x1?.uiSnap?.mm?.[0]), EV.x1?.payload?.actualManMonths?.expected, 0.005),
  { ui: EV.x1?.uiSnap, payload: EV.x1?.payload?.actualManMonths });
beh('E-12', '未复核行数 = rule+default 两条，且「本次件」标注用服务端 payload 的那个数',
  () => EV.x1?.payload?.unreviewed === 2 && EV.x1?.nonManual === 2
    && String(EV.x1?.note ?? '').includes('2') && String(EV.x1?.note ?? '').includes(String(EV.x1?.srvName ?? '!')),
  { unreviewed: EV.x1?.payload?.unreviewed, nonManual: EV.x1?.nonManual, note: EV.x1?.note });
beh('E-13', '行内第 2 个号码框（M）改 7.5 真落库且 source 转 manual',
  () => EV.edit?.likely === 7.5 && EV.edit?.source === 'manual', EV.edit);
beh('E-14', '客户版导出：radio[0] 选择真的进 query 且服务端快照 audience=client',
  () => EV.x2?.req?.status === 200 && EV.x2.req.audience === 'client' && EV.x2.payloadAudience === 'client', { req: EV.x2?.req, payload: EV.x2?.payloadAudience });
beh('E-15', '客户版件名 = 服务端 filename，且与内部版件名不同',
  () => !!EV.x2?.srvName && EV.x2.dlName === EV.x2.srvName && EV.x2.srvName !== EV.x1?.srvName,
  { client: EV.x2?.srvName, internal: EV.x1?.srvName });
beh('E-16', '两条快照行分别对应服务端的 client/internal，受众单元着色可区分',
  () => EV.x2?.uiSnap?.n === 2 && EV.x2.snapAudiences?.[0] === 'client' && EV.x2.snapAudiences?.[1] === 'internal'
    && EV.x2.uiSnap.audColor?.[0] !== EV.x2.uiSnap.audColor?.[1], { snap: EV.x2?.uiSnap, aud: EV.x2?.snapAudiences });
beh('E-17', '「只导已估算行」勾选真的进 query 且服务端快照 scope=estimated_only',
  () => EV.x3?.req?.status === 200 && EV.x3.req.scope === 'estimated_only' && EV.x3.payloadScope === 'estimated_only', { req: EV.x3?.req, payload: EV.x3?.payloadScope });
beh('E-18', '三条快照各有独立勾选，时间戳互不相同（倒序配对不靠运气）',
  () => EV.x3?.uiSnap?.n === 3 && EV.x3.checkCount === 3 && new Set(EV.x3.timestamps ?? []).size === 3, { n: EV.x3?.uiSnap?.n, ts: EV.x3?.timestamps });
beh('E-19', '勾选两条后导出区恰好多出 1 枚按钮（对比入口）',
  () => EV.cmp?.btnCount === 4 && EV.cmp?.picked?.picked?.filter(Boolean).length === 2, { btnCount: EV.cmp?.btnCount, picked: EV.cmp?.picked });
beh('E-20', '差异区逐阶段差值与页面自己那次 compare 响应逐项一致（同源，不是前端第二套算式）',
  () => (EV.cmp?.uiPhases?.length ?? 0) > 0 && EV.cmp.uiPhases.length === (EV.cmp?.serverPhases?.length ?? -1)
    && EV.cmp.uiPhases.every((p, i) => approx(p.delta, EV.cmp.serverPhases[i]?.expected?.delta)
      && p.plus === (EV.cmp.serverPhases[i].expected.delta > 0)),
  { ui: EV.cmp?.uiPhases, srv: EV.cmp?.serverPhases });
beh('E-21', '开发阶段 Δ = +1 人天（手算），且全部阶段里只有它非零',
  () => {
    const srv = EV.cmp?.serverPhases ?? []; const idx = srv.findIndex((p) => p.phase === 'dev');
    return idx >= 0 && approx(srv[idx]?.expected?.delta, D_E) && approx(EV.cmp?.uiPhases?.[idx]?.delta, D_E)
      && srv.filter((p) => Math.abs(p.expected?.delta ?? 0) > 1e-9).length === 1;
  }, { D_E, ui: EV.cmp?.uiPhases, srv: EV.cmp?.serverPhases });
beh('E-22', '实际预估人月合计差 = Δ人天 ÷ 20.83 × 1.23（手算），带正号',
  () => approx(EV.cmp?.serverTotal, D_MM, 1e-4) && approx(EV.cmp?.uiTotalNum, EV.cmp?.serverTotal, 0.01)
    && EV.cmp?.uiTotalPlus === true, { D_MM, srv: EV.cmp?.serverTotal, ui: EV.cmp?.uiTotalNum });
beh('E-23', '第三条勾选挤掉最早一条（至多两条，不给额外步骤）',
  () => EV.cmp?.thirdPicked?.[0] === true && EV.cmp?.thirdPicked?.[1] === true && EV.cmp?.thirdPicked?.[2] === false, EV.cmp?.thirdPicked);
beh('E-24', '录入 P<O 被服务端 400 拒绝，行内错误条点名该夹具行',
  () => (EV.err?.status400 ?? 0) >= 1 && String(EV.err?.alertText ?? '').includes(DEVM), { status400: EV.err?.status400, alert: EV.err?.alertText });
beh('E-25', '错误态下 Excel 按钮 disabled（title 文案由 P 组字面腿配对）',
  () => EV.err?.disabled === true, { dis: EV.err?.disabled, title: EV.err?.title });
beh('E-26', '禁用期间点按钮不产生任何 export-xlsx 请求',
  () => Number.isFinite(EV.err?.exportCountBefore) && Number.isFinite(EV.err?.exportCountAfter)
    && EV.err.exportCountAfter === EV.err.exportCountBefore, { before: EV.err?.exportCountBefore, after: EV.err?.exportCountAfter });
beh('E-27', '改回合法值后错误条消失、导出按钮恢复可用',
  () => EV.err?.recovered === 1, EV.err);
beh('E-28', '三档视口（1920/1440/1200）导出区无横向滚动、按钮仍在',
  () => (EV.vp?.widths?.length ?? 0) === 3 && EV.vp.widths.every((r) => r && !r.wide && r.btn), EV.vp?.widths);
beh('E-29', '<1200px 覆盖式 dialog 里导出区照常可用且无横向滚动',
  () => !!EV.vp?.overlay && EV.vp.overlay.btn === true && EV.vp.overlay.wide === false, EV.vp?.overlay);
beh('E-30', '全程页面无 JS 异常', () => Array.isArray(EV.health?.jsErrors) && EV.health.jsErrors.length === 0, EV.health?.jsErrors);
beh('E-31', '导出/快照接口无 5xx，服务日志无 estimates 异常',
  () => EV.health?.apiBad === 0 && EV.health?.logErr === false, EV.health);

console.log('\n=== U 组：行为腿 ===');
for (const b of BEHAVIOR) ok(`${b.id} ${b.label}`, b.fn(), b.extra);

// ---------------- 5) P 组：文案/标识符锚配对（行为失守⇒FAIL；行为在而锚失配⇒FAIL 交人判定） ----------------
console.log('\n=== P 组：文案/标识符锚配对（行为失守⇒FAIL；行为在而锚失配⇒FAIL 交人判定） ===');
const ANCHORS = {
  navSeam: { needle: 'mtaskNavigate', src: APP_HEAD },
  panelKey: { needle: 'plan.estimatePanelOpen', src: PLAN_HEAD },
  panelAria: { needle: 'aria-label="估算面板"', src: PLAN_HEAD },
  exportAria: { needle: 'aria-label="估算导出区"', src: EP_HEAD },
  excelAria: { needle: 'aria-label="导出 Excel 文件"', src: EP_HEAD },
  audienceName: { needle: 'name="estimate-audience"', src: EP_HEAD },
  clientLabel: { needle: '客户版', src: EP_HEAD },
  internalLabel: { needle: '内部版', src: EP_HEAD },
  onlyEstimated: { needle: '只导已估算行', src: EP_HEAD },
  scopeQuery: { needle: "scope: (estimatedOnly ? 'estimated_only' : 'all')", src: EP_HEAD },
  foldHint: { needle: '系数分项将折叠（参数页开关）', src: EP_HEAD },
  foldSetting: { needle: 'hideCoefsForClient', src: EP_HEAD },
  emptySnapshots: { needle: '还没有导出记录', src: EP_HEAD },
  recentHeader: { needle: '最近导出（', src: EP_HEAD },
  compareEntry: { needle: '对比所选两条', src: EP_HEAD },
  rowErrorAria: { needle: 'aria-label="行内录入错误提示"', src: EP_HEAD },
  disabledTitle: { needle: '有行未通过录入校验（§5.2：导出禁用），先修正', src: EP_HEAD },
  diffAria: { needle: 'aria-label="两次导出差异"', src: EP_HEAD },
  unreviewedNote: { needle: ' · 内含「${unreviewed} 行为系统推导值，未人工复核」标注', src: EP_HEAD },
  exportToast: { needle: '已导出 ${r.filename}', src: EP_HEAD },
  pointOrder: { needle: "POINT_FIELDS = ['optimistic', 'likely', 'pessimistic']", src: EP_HEAD },
  pointLabels: { needle: "optimistic: '乐观 O', likely: '最可能 M', pessimistic: '悲观 P'", src: EP_HEAD },
  audienceFn: { needle: 'const snapshotAudienceLabel = (aud: unknown, format: string): string', src: EP_HEAD },
  fileNameBase: { needle: "ESTIMATE_FILE_BASE = '工作量评估'", src: COPY_HEAD },
  fileNameClient: { needle: "ESTIMATE_FILE_CLIENT_MARK = '-客户版'", src: COPY_HEAD },
  snapshotHeader: { needle: 'X-Estimate-Snapshot', src: ROUTES_HEAD },
};
const B = Object.fromEntries(BEHAVIOR.map((b) => [b.id, b.fn]));
const P_SPECS = [
  { id: 'P-01', anchors: ['panelKey', 'panelAria'], behavior: B['E-04'] },
  { id: 'P-02', anchors: ['navSeam'], behavior: () => EV.page?.nav === 1 },
  { id: 'P-03', anchors: ['exportAria', 'excelAria'], behavior: B['E-04'] },
  { id: 'P-04', anchors: ['audienceName', 'clientLabel', 'internalLabel'], behavior: B['E-14'] },
  { id: 'P-05', anchors: ['onlyEstimated', 'scopeQuery'], behavior: B['E-17'] },
  { id: 'P-06', anchors: ['foldHint', 'foldSetting'], behavior: B['E-06'] },
  { id: 'P-07', anchors: ['emptySnapshots'], behavior: () => EV.initial?.snapRows === 0 && EV.initial?.uiRows === 0 },
  { id: 'P-08', anchors: ['recentHeader'], behavior: B['E-11'] },
  { id: 'P-09', anchors: ['compareEntry'], behavior: B['E-19'] },
  { id: 'P-10', anchors: ['rowErrorAria'], behavior: B['E-24'] },
  { id: 'P-11', anchors: ['disabledTitle'], behavior: B['E-25'] },
  { id: 'P-12', anchors: ['diffAria'], behavior: () => EV.cmp?.fieldset === true },
  { id: 'P-13', anchors: ['unreviewedNote'], behavior: B['E-12'] },
  { id: 'P-14', anchors: ['exportToast'], behavior: B['E-10'] },
  { id: 'P-15', anchors: ['fileNameBase', 'fileNameClient', 'snapshotHeader'], behavior: () => B['E-08']() && B['E-15']() },
  { id: 'P-16', anchors: ['pointOrder', 'pointLabels'], behavior: B['E-13'] },
  { id: 'P-17', anchors: ['audienceFn'], behavior: B['E-16'] },
];
const literalOf = (spec, override) => spec.anchors.every((k) => {
  const a = ANCHORS[k];
  return (override === undefined ? a.src : override).includes(a.needle);
});
const P_LABEL = {
  'P-01': '估算面板的会话开键与 aria 句柄在 HEAD 中逐字存在，且面板结构腿在跑',
  'P-02': '导航 seam（App 监听 mtaskNavigate）字面在场，且面板确实经它打开',
  'P-03': '导出区 aria 与 Excel 按钮 aria 字面在场，且结构与按钮序行为腿在跑',
  'P-04': '受众 radio 的 name/客户版/内部版字面在场，且 radio[0] 真的出 client 件',
  'P-05': '「只导已估算行」文案与 scope 三元字面在场，且勾选真的进 query',
  'P-06': '折叠提示文案与 hideCoefsForClient 开关字面在场，且节点只随客户受众出现',
  'P-07': '快照空态文案字面在场，且初始快照 0 行',
  'P-08': '「最近导出（」字面在场，且初始导出后恰 1 行',
  'P-09': '「对比所选两条」字面在场，且勾两条后确实多出对比入口',
  'P-10': '行内错误条 aria 字面在场，且服务端 400 时点名夹具行',
  'P-11': '导出禁用 title 文案字面在场，且错误态按钮真 disabled',
  'P-12': '差异区 aria 字面在场，且点对比后 fieldset 真出现',
  'P-13': '未复核标注模板字面在场，且界面用的是服务端 payload 的行数',
  'P-14': '导出 toast 模板字面在场，且 toast 带服务端件名',
  'P-15': '件名前缀/客户版标记/快照响应头字面在场，且下载名逐字等于服务端 filename',
  'P-16': '三点字段顺序与 O/M/P 标签字面在场，且第 2 框确实写 likely 字段',
  'P-17': '快照受众标签函数字面在场，且两行受众与服务端 audience 一一对应',
};
for (const spec of P_SPECS) {
  okPair(ok, `${spec.id} ${P_LABEL[spec.id]}`, spec.behavior, () => literalOf(spec), () => ({ spec: spec.id, anchors: spec.anchors }));
}

// ---------------- 6) N 组：负对照 ----------------
console.log('\n=== N 组：负对照 ===');
const withEV = (obj, fn) => { const saved = EV; EV = obj; try { return fn(); } finally { EV = saved; } };
ok('N-01 空源码探针：17 条字面腿喂空串后全部为假（没有不承重的正则）',
  P_SPECS.every((s) => literalOf(s, '') === false));
ok('N-01b HEAD 文本在场性：26 个锚点在已提交树里逐字命中',
  Object.values(ANCHORS).every((a) => a.src.length > 0 && a.src.includes(a.needle)),
  Object.entries(ANCHORS).filter(([, a]) => !a.src.includes(a.needle)).map(([k]) => k));
ok('N-02 敏感度探针：抽干运行期实测料后全部行为腿转假——行为腿确实在读实测，不是恒真',
  BEHAVIOR.every((b) => withEV({}, b.fn) === false),
  BEHAVIOR.filter((b) => withEV({}, b.fn) !== false).map((b) => b.id));
ok('N-02b 还原实证：实测料回填后同一批行为腿重新为真（N-02 的红不是恒红）',
  BEHAVIOR.every((b) => b.fn() === true),
  BEHAVIOR.filter((b) => b.fn() !== true).map((b) => b.id));
const renamed = [];
for (const [key, a] of Object.entries(ANCHORS)) {
  const tampered = a.src.split(a.needle).join('⟪改名⟫');
  const spec = P_SPECS.find((s) => s.anchors.includes(key));
  renamed.push({ key, spec: spec?.id, selfProof: tampered !== a.src, gone: !tampered.includes(a.needle), literalFalse: spec ? literalOf(spec, tampered) === false : false });
}
ok('N-03 改名模拟：26 个锚点逐个从 HEAD 副本中抹掉后，字面判据各自转假（且每条自证 tampered !== original）',
  renamed.every((r) => r.selfProof && r.gone && r.literalFalse && r.spec),
  renamed.filter((r) => !(r.selfProof && r.gone && r.literalFalse && r.spec)));
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
const MUTATIONS = {
  'E-04': (e) => { e.panel.exportButtons = 2; },
  'E-05': (e) => { e.initial.internalChecked = false; },
  'E-06': (e) => { e.fold.internalSpans = 1; },
  'E-07': (e) => { e.x1.req.status = 500; },
  'E-08': (e) => { e.x1.dlName = 'x.xlsx'; },
  'E-09': (e) => { e.x1.blob.head = '00000000'; },
  'E-10': (e) => { e.x1.toast = ''; },
  'E-11': (e) => { e.x1.uiSnap.n = 2; },
  'E-12': (e) => { e.x1.payload.unreviewed = 1; },
  'E-13': (e) => { e.edit.likely = 6; },
  'E-14': (e) => { e.x2.req.audience = 'internal'; },
  'E-15': (e) => { e.x2.dlName = 'x.xlsx'; },
  'E-16': (e) => { e.x2.uiSnap.audColor = ['rgb(1,2,3)', 'rgb(1,2,3)']; },
  'E-17': (e) => { e.x3.req.scope = 'all'; },
  'E-18': (e) => { e.x3.timestamps = ['a', 'a', 'b']; },
  'E-19': (e) => { e.cmp.btnCount = 3; },
  'E-20': (e) => { e.cmp.uiPhases = []; },
  'E-21': (e) => { e.cmp.serverPhases.find((p) => p.phase === 'dev').expected.delta = 0.5; },
  'E-22': (e) => { e.cmp.uiTotalNum = 0.07; },
  'E-23': (e) => { e.cmp.thirdPicked = [true, false, false]; },
  'E-24': (e) => { e.err.alertText = ''; },
  'E-25': (e) => { e.err.disabled = false; },
  'E-26': (e) => { e.err.exportCountAfter = e.err.exportCountBefore + 1; },
  'E-27': (e) => { e.err.recovered = 0; },
  'E-28': (e) => { e.vp.widths[0].wide = true; },
  'E-29': (e) => { e.vp.overlay = { wide: true, btn: true }; },
  'E-30': (e) => { e.health.jsErrors = ['boom']; },
  'E-31': (e) => { e.health.apiBad = 1; },
};
const mutResults = BEHAVIOR.map((b) => {
  const mutate = MUTATIONS[b.id];
  if (!mutate) return { id: b.id, name: b.label, turnedFalse: 'no-mutation' };
  const e = structuredClone(EV);
  mutate(e);
  return { id: b.id, name: b.label, turnedFalse: withEV(e, b.fn) === false };
});
ok('N-05 破坏形态反证：28 类实测料被改写后对应行为腿各自转假（结构/请求/件名/载荷/对比/错误态/视口/健康）',
  mutResults.every((r) => r.turnedFalse === true), mutResults.filter((r) => r.turnedFalse !== true));

console.log(`\n结果：PASS=${pass} FAIL=${fail}｜截图：${shotFiles.join('、') || '无'}`);
process.exit(fail === 0 ? 0 : 1);
