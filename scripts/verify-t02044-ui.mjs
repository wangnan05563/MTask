#!/usr/bin/env node
/**
 * T02044（估算视图 §5.2 第 4 段「导出区」· E7 PDF）真机走查：CDP 驱动 headless Chrome 打开**隔离实例**
 * 的估算面板，只断言「非真实浏览器不能回答」的问题：
 *   ① 导出区里两枚 PDF 按钮真的各自发出一次 GET /api/estimates/export-pdf，且 query 里的 audience
 *      各归各（internal / client），不跟受众 radio 走；
 *   ② 下载体是真 PDF（%PDF- 魔数 + %%EOF + application/pdf + 体积），件名逐字等于服务端写进快照的
 *      filename（前端没有第二套命名口径，§6.3）；
 *   ③ §10-9「一次出两版对照」：两版件名互为「-客户版-」关系、各写一条快照、报价数相同、件体量不同；
 *   ④ §5.2「有行未通过校验 → 导出禁用」对 PDF 两枚同样成立，禁用期间点不出请求；
 *   ⑤ 导出中（exporting）三枚按钮一起禁用，被点的那枚文案进入忙碌态、结束后复位（共用一条并发闸）；
 *   ⑥ PDF 与 xlsx 的留痕在「最近导出」同一处可读，format 可区分，受众标签与服务端 payload 一一对应；
 *   ⑦ 三档视口与 <1200px 覆盖式下导出区不产生横向滚动。
 *
 * T02293 判据落地：U 组只认结构句柄（导出区 = 恰含 2 枚 radio 的 section；Excel = 第 1 个 button、
 * PDF 内部/客户 = 第 2/3 个 button；受众 = radio DOM 序 0=客户、1=内部，映射由服务端快照 audience 反证；
 * scope = section 内唯一带 label 的 checkbox；快照行 = 直接子 checkbox + 4 段 span；行内错误 = 面板唯一
 * role=alert；行容器 = 含夹具标题且恰 3 个号码框的 div，输入按 DOM 序 O/M/P）、网络 query、服务端快照
 * payload、下载 Blob 字节与件名、按钮状态迁移。产品中文文案与标识符锚一律进 P 组的 `okPair` 字面腿
 * （取证面 `git show HEAD:`）。N 组负对照：空源码、HEAD 在场性、抽干实测料、逐锚改名、okPair 契约、
 * 按类破坏行为腿。
 *
 * 用法（Chrome 用系统安装版；本仓内置 Browser 无视口不能点击/截图，见 memory）：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02044-ui.mjs
 *   环境变量：T02044_UI_PORT（默认 39938）、T02044_UI_CDP（默认 9348）
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
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't02044-ui-'));
const CHROME_PROFILE = mkdtempSync(join(TMP_ROOT, 't02044-ui-chrome-'));
if (!process.env.MTASK_GATE_ARTIFACT_DIR) process.env.MTASK_GATE_ARTIFACT_DIR = join(TMP_ROOT, 'mtask-gate-shots');
// T02312：截图不落仓库根固定名目录（并发跑门时同一步骤名整图互覆，且仓库根长期堆未纳管产物）——
// 改用 gate-results 的进程级 RUN_TAG 子目录，与本轮文本产物同标识，可按标识核对归属。
const { gateShotsDir } = await import(pathToFileURL(join(ROOT, 'scripts/lib/gate-results.mts')).href);
const { okPair } = await import(pathToFileURL(join(ROOT, 'scripts/lib/anchor-pair.mts')).href);
const SHOTS = gateShotsDir('t02044');
const PORT = Number(process.env.T02044_UI_PORT ?? 39938);
const CDP = Number(process.env.T02044_UI_CDP ?? 9348);
const CHROME = process.env.T02044_UI_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
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
const T = '2026-10-12T00:00:00.000Z';
const PID = 'ui-e7p';
const PNAME = 'T02044-E7走查';
const DEVM = 'E7走查主行';
const db = getDb();
db.prepare('INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
  .run(PID, PNAME, '', T, T);
const insPlan = db.prepare(
  `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
     progress, status, assignee, sort_order, created_at, updated_at, kind, complexity, req_ids, deps)
   VALUES (?, ?, ?, '', '2026-10-12', '2026-10-12', ?, 0, 'todo', '', ?, ?, ?, ?, ?, null, ?)`,
);
const seeds = [
  ['ms-1', 'M1 基座', 8, 1, 'milestone', 4, null],
  ['r-a', DEVM, 12, 2, 'normal', 3, JSON.stringify([{ id: 'ms-1', type: 'child' }])],
  ['r-b', '推导行乙', 6, 3, 'normal', 2, JSON.stringify([{ id: 'ms-1', type: 'child' }])],
  ['r-c', '未估算行丙', 5, 4, 'normal', 2, JSON.stringify([{ id: 'ms-1', type: 'child' }])],
];
for (const [id, title, dur, sort, kind, cx, deps] of seeds) insPlan.run(id, PID, title, dur, sort, T, T, kind, cx, deps);
const insEst = db.prepare(
  `INSERT INTO estimate_items (id, project_id, plan_id, phase, unit, optimistic, likely, pessimistic, source, note, created_at, updated_at)
   VALUES (?, ?, ?, ?, 'man_day', ?, ?, ?, ?, ?, ?, ?)`,
);
insEst.run('e-a', PID, 'r-a', 'dev', 3, 6, 9, 'manual', '', T, T);
insEst.run('e-b', PID, 'r-b', 'req', 2, 4, 6, 'rule', '', T, T);
db.prepare("INSERT INTO app_settings (key, value) VALUES ('estimate.reviewer', '王南')").run();
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
  if (process.env.T02044_UI_KEEP) return;
  for (const dir of [DATA_DIR, CHROME_PROFILE]) {
    for (let i = 0; i < 8; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break; } catch { sleepSync(i); }
    }
  }
};
process.on('exit', cleanup);

let serverUp = false;
for (let i = 0; i < 90; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) { serverUp = true; break; } } catch { /* */ } await sleep(500); }
ok('U-00 隔离服务启动（临时端口 + 临时库，2 条已估算 + 1 条未估算，署名已置夹具值）', serverUp);
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
ok('U-01 Chrome CDP 通道就绪（系统 Chrome, headless=new）', !!wsUrl, wsUrl);
if (!wsUrl) process.exit(1);

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pend = new Map();
const netLog = [];
const send = (method, params = {}) => new Promise((res) => { const i = ++seq; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (ev2) => {
  const m = JSON.parse(ev2.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method !== 'Network.responseReceived') return;
  const u = m.params.response.url;
  if (/\/api\/estimates/.test(u)) netLog.push({ url: u.replace(/^https?:\/\/[^/]+/, ''), status: m.params.response.status });
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
const FT_JSON = JSON.stringify([DEVM, '推导行乙']);
const PJ = `const FT=${FT_JSON};
  const p=()=>[...document.querySelectorAll('aside,[role="dialog"][aria-modal="true"]')].find(d=>d.querySelector('[role="toolbar"]')&&FT.filter(t=>d.textContent.includes(t)).length>=2)||null;
  const rg=()=>{const q=p();if(!q)return null;return [...q.querySelectorAll('section')].find(s=>s.querySelectorAll('input[type="radio"]').length===2&&s.querySelector('input[type="checkbox"]'))||null;};
  const radios=()=>rg()?[...rg().querySelectorAll('input[type="radio"]')]:[];
  const scopeCb=()=>rg()?rg().querySelector('label input[type="checkbox"]'):null;
  const snapCbs=()=>rg()?[...rg().querySelectorAll('input[type="checkbox"]')].filter(c=>!c.closest('label')):[];
  const snapRows=()=>snapCbs().map(c=>[...rg().querySelectorAll('div')].find(d=>d.contains(c)&&d.querySelectorAll(':scope > input[type="checkbox"]').length===1)).filter(Boolean);
  const row=(t)=>{const q=p();if(!q)return null;return [...q.querySelectorAll('div')].find(d=>d.querySelectorAll('input[type="number"]').length===3&&d.textContent.includes(t))||null;};
  const btns=()=>rg()?[...rg().querySelectorAll('button')]:[];`;
/** 面板内求值统一套 IIFE（裸 return 交给 Runtime.evaluate 是语法错误，T02040 踩过） */
const PE = (strings, ...exprs) => {
  let body = strings[0];
  exprs.forEach((e, i) => { body += String(e) + strings[i + 1]; });
  return `(() => { ${PJ}${body} })()`;
};
/** 需要页内轮询（捕捉短命忙碌态）时用 async IIFE */
const PEA = (strings, ...exprs) => {
  let body = strings[0];
  exprs.forEach((e, i) => { body += String(e) + strings[i + 1]; });
  return `(async () => { ${PJ}${body} })()`;
};
/** PDF 按钮按结构序取：0=Excel、1=PDF 内部版、2=PDF 客户版（导出区无对比按钮时） */
const PDF_EXPORT = (idx) => PE`const bs=btns(); const b=bs[${idx}]; if(!b)return 'nobtn';
  if(b.disabled)return 'disabled'; b.scrollIntoView({block:'center'}); b.click(); return 'clicked';`;
/** 禁用态也点：证明 disabled 本身拦住请求，而不是门里先 if 跳过 */
const PDF_FORCE = (idx) => PE`const b=btns()[${idx}]; if(!b)return 'nobtn';
  b.click(); return b.disabled?'disabled-clicked':'enabled-clicked';`;
const setOnlyEstimated = (on) => PE`const c=scopeCb(); if(!c)return 'nochk';
  if(c.checked!==${on}) c.click(); return c.checked===${on}?'ok':'stuck';`;
const SNAP_INFO = PE`const rows=snapRows();
  return { n: rows.length,
    fmt: rows.map(r=>{const sp=[...r.querySelectorAll(':scope > span')];return sp.length>=2?sp[1].textContent.trim():'';}),
    aud: rows.map(r=>{const sp=[...r.querySelectorAll(':scope > span')];return sp.length>=3?sp[2].textContent.trim():'';}),
    audColor: rows.map(r=>{const sp=[...r.querySelectorAll(':scope > span')];return sp.length>=3?getComputedStyle(sp[2]).color:'';}),
    mm: rows.map(r=>{const sp=[...r.querySelectorAll(':scope > span')];return sp.length?sp[sp.length-1].textContent.trim():'';}) };`;
/** 行内输入：行容器按夹具标题定位，号码框 DOM 序 = O / M / P（POINT_FIELDS 单源顺序） */
const setRowPoint = (title, idx, val) => PE`const r=row(${JSON.stringify(title)}); const ins=r?[...r.querySelectorAll('input[type="number"]')]:[]; const el=ins[${idx}];
  if(!el) return 'missing'; el.focus(); const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
  d.set.call(el,${JSON.stringify(String(val))}); el.dispatchEvent(new Event('input',{bubbles:true}));
  el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return el.value;`;
const DL_INFO = `(() => { const out=[];
  for (let i=0;i<window.__dl.length;i++) out.push({ name: window.__dl[i], has: !!window.__blobs[i] });
  return out; })()`;
/** 读第 n 次下载的 Blob：PDF 看前 5 字节 `%PDF-`（十六进制 255044462d）+ 尾 1024 字节里要有 %%EOF */
const READ_BLOB_AT = (i) => `(async () => { const b=window.__blobs[${i}]; if(!b) return null;
  const buf=await b.arrayBuffer(); const u8=new Uint8Array(buf);
  const head=Array.from(u8.slice(0,5)).map((x)=>x.toString(16).padStart(2,'0')).join('');
  const tail=Array.from(u8.slice(-1024)).map((x)=>String.fromCharCode(x)).join('');
  return { type: b.type, size: buf.byteLength, head, eof: tail.includes('%%EOF') }; })()`;
const rest = async (path) => (await fetch(`${BASE}/api${path}`)).json();
const reqOf = (n) => {
  if (!n) return null;
  try {
    const u = new URL(`http://x${n.url}`);
    return { status: n.status, audience: u.searchParams.get('audience'), scope: u.searchParams.get('scope') };
  } catch { return { status: n.status }; }
};
const pdfReqs = () => netLog.filter((n) => /export-pdf/.test(n.url));
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
ok('U-02 页面加载并经导航 seam 打开计划页', pageReady === 1, { pageReady });
if (!panelUp) await diag('panel');
ok('U-03 估算面板已打开（会话态种入开键，面板句柄=工具条+两个夹具标题）', panelUp === 1);
if (!panelUp) {
  console.log('\n面板未打开，终止');
  process.exit(1);
}
await setViewport(1920, 1000);
await until(PE`return rg() ? 1 : '';`, 25_000);

EV.page = { ready: pageReady === 1 ? 1 : 0, nav: panelUp === 1 ? 1 : 0 };

console.log('\n=== §5.2 第 4 段：PDF 两枚按钮的落地形态 ===');
const shape = await ev(PE`const r=rg(); if(!r) return null; const rs=radios(); const bs=[...r.querySelectorAll('button')];
  return { radios: rs.length, sameName: new Set(rs.map(x=>x.name)).size===1 && !!rs[0].name,
    scopeLabeled: !!scopeCb(), exportButtons: bs.length,
    pdfPair: bs.length>=3 && !!bs[1].textContent.trim() && !!bs[2].textContent.trim()
      && bs[1].textContent.trim()!==bs[2].textContent.trim() };`);
EV.panel = { root: 1, toolbar: (await ev(PE`return p()&&p().querySelector('[role="toolbar"]') ? 1 : 0;`)) === 1 ? 1 : 0, ...(shape ?? {}) };
const tips = await ev(PE`const bs=btns();
  return { idleInternalTitle: bs[1]?.title ?? '', idleClientTitle: bs[2]?.title ?? '',
    idleInternalLabel: bs[1]?.textContent.trim() ?? '', idleClientLabel: bs[2]?.textContent.trim() ?? '' };`);
EV.tips = tips ?? {};
const initUi = await ev(PE`const rs=radios(); const c=scopeCb(); const bs=btns();
  return { clientChecked: !!rs[0]?.checked, internalChecked: !!rs[1]?.checked, scopeChecked: !!c?.checked,
    allEnabled: bs.length===3 && bs.every(b=>!b.disabled), uiSnapRows: snapRows().length };`);
const snapList0 = await rest(`/estimates/snapshots?projectId=${PID}`);
EV.initial = { ...(initUi ?? {}), snapRows: (snapList0.snapshots ?? []).length };
await shot('00-pdf-buttons-initial');

console.log('\n=== 内部版 PDF：请求、真件与件名同源 ===');
const n0 = pdfReqs().length;
await ev(PDF_EXPORT(1));
const got1 = await until(`window.__dl.length>=1 ? 1 : ''`, 45_000);
if (!got1) await diag('pdf-internal');
// toast 寿命短：先抓它，再去做快照 REST 往返
const toast1 = await until(`(() => { const t=[...document.querySelectorAll('.flash-toast')].map(x=>x.textContent).join(' | ');
  return t || ''; })()`, 10_000);
const req1 = reqOf(pdfReqs()[n0]);
const dlInfo1 = await ev(DL_INFO);
const blob1 = await ev(READ_BLOB_AT(0));
const snapList1 = await rest(`/estimates/snapshots?projectId=${PID}`);
const snap1 = (snapList1.snapshots ?? [])[0];
const srvName1 = snap1?.filename;
const payload1 = payloadOf(snap1);
await until(PE`return snapRows().length===1 ? 1 : '';`, 20_000);
const uiSnap1 = await ev(SNAP_INFO);
EV.x1 = {
  req: req1, dlName: dlInfo1?.[0]?.name ?? null, srvName: srvName1 ?? null, blob: blob1,
  toast: toast1 ?? '', snapFormat: snap1?.format ?? null, payload: payload1, uiSnap: uiSnap1,
  snapAudience: payload1?.audience ?? null,
};
await shot('01-internal-pdf-done');

console.log('\n=== §10-9：一次出两版对照（脱敏藏依据、不改报价数） ===');
const n1 = pdfReqs().length;
await ev(PDF_EXPORT(2));
const got2 = await until(`window.__dl.length>=2 ? 1 : ''`, 45_000);
if (!got2) await diag('pdf-client');
const radioAfterClient = await ev(PE`const rs=radios(); return { c0: !!rs[0]?.checked, c1: !!rs[1]?.checked };`);
const req2 = reqOf(pdfReqs()[n1]);
const dlInfo2 = await ev(DL_INFO);
const blob2 = await ev(READ_BLOB_AT(1));
const snapList2 = await rest(`/estimates/snapshots?projectId=${PID}`);
const snap2 = (snapList2.snapshots ?? [])[0];
const srvName2 = snap2?.filename;
const payload2 = payloadOf(snap2);
await until(PE`return snapRows().length===2 ? 1 : '';`, 20_000);
const uiSnap2 = await ev(SNAP_INFO);
EV.x2 = {
  req: req2, radio: radioAfterClient, dlName: dlInfo2?.[1]?.name ?? null, srvName: srvName2 ?? null,
  blob: blob2, payload: payload2, payloadAudience: payload2?.audience ?? null, uiSnap: uiSnap2,
  snapAudiences: (snapList2.snapshots ?? []).slice(0, 2).map((s) => payloadOf(s)?.audience ?? null),
};
await shot('02-two-pdf-versions');

console.log('\n=== §5.2 行内错误态：三枚按钮一起禁用 ===');
const badBefore = netLog.filter((n) => n.status === 400).length;
await ev(setRowPoint(DEVM, 2, '1')); // P<O，服务端应拒
const alertText = await until(PE`const a=p().querySelector('[role="alert"]'); return a?a.textContent:'';`, 20_000);
const badAfter = netLog.filter((n) => n.status === 400).length;
const errState = await ev(PE`const bs=btns(); return bs.length>=3
  ? { allDisabled: bs.slice(0,3).every(b=>b.disabled), ti: bs[1].title, tc: bs[2].title } : null;`);
const reqBefore = pdfReqs().length;
const dlBefore = (await ev(DL_INFO)).length;
await ev(PDF_FORCE(1));
await ev(PDF_FORCE(2));
await sleep(1_200);
const reqAfter = pdfReqs().length;
const dlAfter = (await ev(DL_INFO)).length;
await shot('03-rowerror-pdf-disabled');
await ev(setRowPoint(DEVM, 2, '9')); // 改回合法值
const recovered = await until(PE`const a=p().querySelector('[role="alert"]'); const bs=btns();
  return !a && bs.length>=3 && bs.slice(0,3).every(b=>!b.disabled) ? 1 : '';`, 25_000);
EV.err = {
  status400: badAfter - badBefore, alertText: alertText ?? '',
  allDisabled: errState?.allDisabled === true, blockedTitles: { internal: errState?.ti ?? '', client: errState?.tc ?? '' },
  reqBefore, reqAfter, dlBefore, dlAfter, recovered: recovered === 1 ? 1 : 0,
};
await shot('04-rowerror-recovered');

console.log('\n=== 范围筛选 / 并发闸 / 视口 ===');
await ev(setOnlyEstimated(true));
await sleep(400);
const n2 = pdfReqs().length;
await ev(PDF_EXPORT(1));
await until(`window.__dl.length>=3 ? 1 : ''`, 45_000);
const req3 = reqOf(pdfReqs()[n2]);
const snapList3 = await rest(`/estimates/snapshots?projectId=${PID}`);
const payload3 = payloadOf((snapList3.snapshots ?? [])[0]);
EV.scope = { req: req3, payloadScope: payload3?.scope ?? null };
await ev(setOnlyEstimated(false));

// 并发闸：点内部版后立刻观察忙碌态，另一枚与 Excel 应同时被禁用
const nAll = pdfReqs().length;
await ev(PDF_EXPORT(1));
const mid = await ev(PEA`const idle=${JSON.stringify(tips?.idleInternalLabel ?? '')};
  for (let i=0;i<220;i++){
    const bs=btns(); const b=bs[1], c=bs[2], x=bs[0];
    if (b && (b.disabled || b.textContent.trim()!==idle)) {
      return { label:b.textContent.trim(), otherDisabled:!!c&&c.disabled, excelDisabled:!!x&&x.disabled };
    }
    await new Promise(r=>setTimeout(r,40));
  }
  return null;`);
const finished = await until(PE`const bs=btns();
  return bs.length>=3 && bs.slice(0,3).every(b=>!b.disabled)
    && bs[1].textContent.trim()===${JSON.stringify(tips?.idleInternalLabel ?? '')}
    && bs[2].textContent.trim()===${JSON.stringify(tips?.idleClientLabel ?? '')} ? 1 : '';`, 45_000);
const finalState = await ev(PE`const bs=btns(); return bs.length>=3
  ? { l1: bs[1].textContent.trim(), l2: bs[2].textContent.trim(), allEnabled: bs.slice(0,3).every(b=>!b.disabled) } : null;`);
const reqsSlice = pdfReqs().slice(nAll);
EV.mid = {
  label: mid?.label ?? null, idleLabel: tips?.idleInternalLabel ?? '',
  otherDisabled: mid?.otherDisabled === true, excelDisabled: mid?.excelDisabled === true,
  finished: finished === 1 ? 1 : 0, final: finalState,
};
EV.reqs = { before: nAll, after: pdfReqs().length, statuses: reqsSlice.map((r) => r.status) };

const widths = [];
for (const w of [1920, 1440, 1200]) {
  await setViewport(w, 1000);
  widths.push(await ev(PE`const r=rg(); const bs=btns();
    return r?{w:${w}, wide:r.scrollWidth-r.clientWidth>1, btn:!!bs[1]&&!!bs[2]}:null;`));
}
await setViewport(1100, 1000);
const overlayProbe = `(() => {
  const FT=${FT_JSON};
  const d=[...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find(x=>x.querySelector('[role="toolbar"]')&&FT.filter(t=>x.textContent.includes(t)).length>=2);
  if(!d) return null;
  const s=[...d.querySelectorAll('section')].find(z=>z.querySelectorAll('input[type="radio"]').length===2);
  if(!s) return null;
  const bs=s.querySelectorAll('button');
  return { wide: s.scrollWidth-s.clientWidth>1, btn: bs.length>=3 };
})()`;
const overlay = await until(overlayProbe, 20_000);
await shot('05-pdf-overlay-1100');
await setViewport(1920, 1000);
const jsErrors = await ev(`(window.__errs||[]).slice(-5)`);
const apiBad = netLog.filter((n) => /export-pdf|snapshots/.test(n.url) && n.status >= 500).length;
const logErr = /estimates.*(500|异常|Error)/i.test(serverLog.join(''));
EV.vp = { widths, overlay };
EV.health = { jsErrors: Array.isArray(jsErrors) ? jsErrors : ['probe-null'], apiBad, logErr };

// ---------------- 4) U 组：行为腿（只读 EV；N 组抽干后必须全部转假） ----------------
const BEHAVIOR = [];
const beh = (id, label, fn, extra) => BEHAVIOR.push({ id, label, fn, extra });
beh('E-04', '导出区结构：2 枚同名 radio + 1 枚带 label 的 scope 勾选 + 3 枚按钮，PDF 两枚文案各不同',
  () => EV.panel?.root === 1 && EV.panel?.toolbar === 1 && EV.panel?.radios === 2 && EV.panel?.sameName === true
    && EV.panel?.scopeLabeled === true && EV.panel?.exportButtons === 3 && EV.panel?.pdfPair === true, EV.panel);
beh('E-05', '两枚 PDF 的 idle title 与按钮文案各自非空且互不相同（各版说清各版）',
  () => !!EV.tips?.idleInternalTitle && !!EV.tips?.idleClientTitle
    && EV.tips.idleInternalTitle !== EV.tips.idleClientTitle
    && !!EV.tips?.idleInternalLabel && !!EV.tips?.idleClientLabel
    && EV.tips.idleInternalLabel !== EV.tips.idleClientLabel, EV.tips);
beh('E-06', '初始态：radio[1] 选中、scope 未勾、三枚按钮可用、快照 0 行',
  () => EV.initial?.clientChecked === false && EV.initial?.internalChecked === true && EV.initial?.scopeChecked === false
    && EV.initial?.allEnabled === true && EV.initial?.uiSnapRows === 0 && EV.initial?.snapRows === 0, EV.initial);
beh('E-07', '内部版 PDF 请求 audience=internal & scope=all 且 200',
  () => EV.x1?.req?.status === 200 && EV.x1?.req?.audience === 'internal' && EV.x1?.req?.scope === 'all', EV.x1?.req);
beh('E-08', '内部版下载件名逐字等于服务端快照 filename（前端没有第二套命名）',
  () => !!EV.x1?.dlName && EV.x1.dlName === EV.x1.srvName, { dl: EV.x1?.dlName, srv: EV.x1?.srvName });
beh('E-09', '内部版件名以 .pdf 结尾且含夹具项目名（件名由服务端 assembler 产出）',
  () => { const n = String(EV.x1?.dlName ?? ''); return !!n && /\.pdf$/.test(n) && n.includes(PNAME); }, EV.x1?.dlName);
beh('E-10', '内部版下载体是真 PDF（%PDF- 头 + %%EOF 尾 + application/pdf + 体积过 4KB）',
  () => EV.x1?.blob?.head === '255044462d' && EV.x1.blob.eof === true
    && String(EV.x1.blob.type).includes('application/pdf') && EV.x1.blob.size > 4000, EV.x1?.blob);
beh('E-11', '导出成功 toast 带服务端件名',
  () => !!EV.x1?.srvName && String(EV.x1?.toast ?? '').includes(EV.x1.srvName), EV.x1?.toast);
beh('E-12', '内部版快照留痕 format=pdf（与 xlsx 同一张表、可事后区分）',
  () => EV.x1?.snapFormat === 'pdf', { format: EV.x1?.snapFormat, filename: EV.x1?.srvName });
beh('E-13', '内部版快照 payload 的未复核行数 = rule 的 1 行（与导出侧同源）',
  () => EV.x1?.payload?.unreviewed === 1, { unreviewed: EV.x1?.payload?.unreviewed });
beh('E-14', '客户版 PDF 自带 audience=client，且受众 radio 仍是内部版（不跟 radio 走）',
  () => EV.x2?.req?.status === 200 && EV.x2.req.audience === 'client'
    && EV.x2?.radio?.c1 === true && EV.x2?.radio?.c0 === false, { req: EV.x2?.req, radio: EV.x2?.radio });
beh('E-15', '客户版件名 = 服务端 filename、与内部版不同，且快照 audience=client',
  () => !!EV.x2?.srvName && EV.x2.dlName === EV.x2.srvName && EV.x2.srvName !== EV.x1?.srvName
    && EV.x2?.payloadAudience === 'client',
  { client: EV.x2?.srvName, internal: EV.x1?.srvName, aud: EV.x2?.payloadAudience });
beh('E-16', '客户版同样是渲染完成的真 PDF（脱敏不改变件能不能打开）',
  () => EV.x2?.blob?.head === '255044462d' && EV.x2.blob.eof === true
    && String(EV.x2.blob.type).includes('application/pdf') && EV.x2.blob.size > 3000, EV.x2?.blob);
beh('E-17', '两版快照的实际预估人月相同（§10-9「报价数不变」在出件路径上成立）',
  () => approx(EV.x1?.payload?.actualManMonths?.expected, EV.x2?.payload?.actualManMonths?.expected)
    && Number.isFinite(EV.x1?.payload?.actualManMonths?.expected),
  { internal: EV.x1?.payload?.actualManMonths, client: EV.x2?.payload?.actualManMonths });
beh('E-18', '两版件体量不同且差 >300 字节（不是同一份字节的两次改名）',
  () => Number.isFinite(EV.x1?.blob?.size) && Number.isFinite(EV.x2?.blob?.size)
    && EV.x1.blob.size !== EV.x2.blob.size && Math.abs(EV.x1.blob.size - EV.x2.blob.size) > 300,
  { i: EV.x1?.blob?.size, c: EV.x2?.blob?.size });
beh('E-19', '快照列表 2 行、格式列一致非空、受众列互异且与服务端 [client, internal] 对应',
  () => EV.x2?.uiSnap?.n === 2 && !!EV.x2.uiSnap.fmt?.[0] && EV.x2.uiSnap.fmt[0] === EV.x2.uiSnap.fmt[1]
    && !!EV.x2.uiSnap.aud?.[0] && EV.x2.uiSnap.aud[0] !== EV.x2.uiSnap.aud[1]
    && EV.x2?.snapAudiences?.[0] === 'client' && EV.x2?.snapAudiences?.[1] === 'internal',
  { ui: EV.x2?.uiSnap, srv: EV.x2?.snapAudiences });
beh('E-20', '录入 P<O 被服务端 400 拒绝，行内错误条点名该夹具行',
  () => (EV.err?.status400 ?? 0) >= 1 && String(EV.err?.alertText ?? '').includes(DEVM),
  { status400: EV.err?.status400, alert: EV.err?.alertText });
beh('E-21', '错误态下 PDF 两枚与 Excel 一同 disabled（禁用面覆盖 E7 新增按钮）',
  () => EV.err?.allDisabled === true, EV.err);
beh('E-22', '错误态下两枚 PDF 的 title 相同且都不同于 idle title（禁用成因可区分）',
  () => !!EV.err?.blockedTitles?.internal && EV.err.blockedTitles.internal === EV.err.blockedTitles.client
    && EV.err.blockedTitles.internal !== EV.tips?.idleInternalTitle
    && EV.err.blockedTitles.client !== EV.tips?.idleClientTitle,
  { blocked: EV.err?.blockedTitles, idle: EV.tips });
beh('E-23', '禁用期间对两枚 PDF 直接 click 也不产生 export-pdf 请求、不触发下载',
  () => Number.isFinite(EV.err?.reqBefore) && Number.isFinite(EV.err?.reqAfter)
    && EV.err.reqAfter === EV.err.reqBefore
    && Number.isFinite(EV.err?.dlBefore) && Number.isFinite(EV.err?.dlAfter)
    && EV.err.dlAfter === EV.err.dlBefore,
  { reqBefore: EV.err?.reqBefore, reqAfter: EV.err?.reqAfter, dlBefore: EV.err?.dlBefore, dlAfter: EV.err?.dlAfter });
beh('E-24', '改回合法值后错误条消失、三枚按钮恢复可用',
  () => EV.err?.recovered === 1, EV.err);
beh('E-25', '「只导已估算行」的勾选对 PDF 生效（query 与快照 payload 都是 estimated_only）',
  () => EV.scope?.req?.status === 200 && EV.scope.req.scope === 'estimated_only'
    && EV.scope.payloadScope === 'estimated_only', EV.scope);
beh('E-26', '导出中：被点的内部版文案进入忙碌态，另一枚 PDF 与 Excel 同时被并发闸禁用',
  () => !!EV.mid?.label && EV.mid.label !== EV.mid.idleLabel
    && EV.mid.otherDisabled === true && EV.mid.excelDisabled === true, EV.mid);
beh('E-27', '导出结束后三枚按钮恢复可用、两枚 PDF 文案回到各自 idle 值（闸会释放）',
  () => EV.mid?.finished === 1 && EV.mid?.final?.allEnabled === true
    && EV.mid.final.l1 === EV.mid.idleLabel && EV.mid.final.l2 === EV.tips?.idleClientLabel,
  { mid: EV.mid, idleClient: EV.tips?.idleClientLabel });
beh('E-28', '并发闸下每次点 PDF 只对应一次请求且全部 200（没有重复发件）',
  () => Number.isFinite(EV.reqs?.before) && Number.isFinite(EV.reqs?.after)
    && EV.reqs.after === EV.reqs.before + 1
    && (EV.reqs.statuses?.length ?? 0) === 1 && EV.reqs.statuses[0] === 200,
  EV.reqs);
beh('E-29', '三档视口（1920/1440/1200）导出区无横向滚动、PDF 两枚仍在',
  () => (EV.vp?.widths?.length ?? 0) === 3 && EV.vp.widths.every((r) => r && !r.wide && r.btn), EV.vp?.widths);
beh('E-30', '<1200px 覆盖式 dialog 里导出区照常可用且无横向滚动',
  () => !!EV.vp?.overlay && EV.vp.overlay.btn === true && EV.vp.overlay.wide === false, EV.vp?.overlay);
beh('E-31', '全程页面无 JS 异常', () => Array.isArray(EV.health?.jsErrors) && EV.health.jsErrors.length === 0, EV.health?.jsErrors);
beh('E-32', 'PDF/快照接口无 5xx，服务日志无 estimates 异常',
  () => EV.health?.apiBad === 0 && EV.health?.logErr === false, EV.health);

console.log('\n=== U 组：行为腿 ===');
for (const b of BEHAVIOR) ok(`${b.id} ${b.label}`, b.fn(), b.extra);

// ---------------- 5) P 组：文案/标识符锚配对（行为失守⇒FAIL；行为在而锚失配⇒FAIL 交人判定） ----------------
console.log('\n=== P 组：文案/标识符锚配对（行为失守⇒FAIL；行为在而锚失配⇒FAIL 交人判定） ===');
const ANCHORS = {
  exportAria: { needle: 'aria-label="估算导出区"', src: EP_HEAD },
  audienceName: { needle: 'name="estimate-audience"', src: EP_HEAD },
  clientLabel: { needle: '客户版', src: EP_HEAD },
  internalLabel: { needle: '内部版', src: EP_HEAD },
  onlyEstimated: { needle: '只导已估算行', src: EP_HEAD },
  scopeQuery: { needle: "scope: (estimatedOnly ? 'estimated_only' : 'all')", src: EP_HEAD },
  excelAria: { needle: 'aria-label="导出 Excel 文件"', src: EP_HEAD },
  pdfInternalAria: { needle: 'aria-label="导出 PDF 内部版"', src: EP_HEAD },
  pdfClientAria: { needle: 'aria-label="导出 PDF 客户版"', src: EP_HEAD },
  pdfInternalIdle: { needle: '导出 PDF（内部版）', src: EP_HEAD },
  pdfClientIdle: { needle: '导出 PDF（客户版）', src: EP_HEAD },
  pdfInternalTitle: { needle: 'PDF 内部版：含系数分项、σ/P50/P84 区间、自检与备注三条（汇报/预览用，正式交付以 Excel 为准）', src: EP_HEAD },
  pdfClientTitle: { needle: 'PDF 客户版：服务端组装阶段就不写系数分项、σ/置信区间、备注三条与附加 sheet 名，报价数与内部版一致', src: EP_HEAD },
  pdfD4Note: { needle: 'PDF 为预览件，正式交付以 Excel 为准（裁决 D4）', src: EP_HEAD },
  exportingLabel: { needle: '导出中…', src: EP_HEAD },
  blockedTitle: { needle: '有行未通过录入校验（§5.2：导出禁用），先修正', src: EP_HEAD },
  rowErrorAria: { needle: 'aria-label="行内录入错误提示"', src: EP_HEAD },
  recentHeader: { needle: '最近导出（', src: EP_HEAD },
  audienceFn: { needle: 'const snapshotAudienceLabel = (aud: unknown, format: string): string', src: EP_HEAD },
  exportToast: { needle: '已导出 ${r.filename}', src: EP_HEAD },
  pointOrder: { needle: "POINT_FIELDS = ['optimistic', 'likely', 'pessimistic']", src: EP_HEAD },
  pointLabels: { needle: "optimistic: '乐观 O', likely: '最可能 M', pessimistic: '悲观 P'", src: EP_HEAD },
  fileNameBase: { needle: "ESTIMATE_FILE_BASE = '工作量评估'", src: COPY_HEAD },
  fileNameClientMark: { needle: "ESTIMATE_FILE_CLIENT_MARK = '-客户版'", src: COPY_HEAD },
  pdfRoute: { needle: "'/export-pdf'", src: ROUTES_HEAD },
  snapshotHeader: { needle: 'X-Estimate-Snapshot', src: ROUTES_HEAD },
  pdfFormat: { needle: "ESTIMATE_ARTIFACT_FORMATS = ['xlsx', 'pdf']", src: ROUTES_HEAD },
};
const B = Object.fromEntries(BEHAVIOR.map((b) => [b.id, b.fn]));
const P_SPECS = [
  { id: 'P-01', anchors: ['exportAria', 'excelAria'], behavior: B['E-04'] },
  { id: 'P-02', anchors: ['audienceName', 'clientLabel', 'internalLabel'], behavior: B['E-14'] },
  { id: 'P-03', anchors: ['onlyEstimated', 'scopeQuery'], behavior: B['E-25'] },
  { id: 'P-04', anchors: ['pdfInternalAria', 'pdfClientAria', 'pdfInternalIdle', 'pdfClientIdle'], behavior: () => B['E-04']() && B['E-05']() },
  { id: 'P-05', anchors: ['pdfInternalTitle', 'pdfClientTitle'], behavior: B['E-05'] },
  { id: 'P-06', anchors: ['pdfD4Note'], behavior: B['E-04'] },
  { id: 'P-07', anchors: ['exportingLabel'], behavior: B['E-26'] },
  { id: 'P-08', anchors: ['blockedTitle'], behavior: B['E-22'] },
  { id: 'P-09', anchors: ['rowErrorAria'], behavior: B['E-20'] },
  { id: 'P-10', anchors: ['recentHeader', 'audienceFn'], behavior: B['E-19'] },
  { id: 'P-11', anchors: ['exportToast'], behavior: B['E-11'] },
  { id: 'P-12', anchors: ['pointOrder', 'pointLabels'], behavior: B['E-20'] },
  { id: 'P-13', anchors: ['fileNameBase', 'fileNameClientMark'], behavior: () => B['E-09']() && B['E-15']() },
  { id: 'P-14', anchors: ['pdfRoute', 'snapshotHeader', 'pdfFormat'], behavior: () => B['E-07']() && B['E-12']() },
];
const literalOf = (spec, override) => spec.anchors.every((k) => {
  const a = ANCHORS[k];
  return (override === undefined ? a.src : override).includes(a.needle);
});
const P_LABEL = {
  'P-01': '导出区 aria 与 Excel 按钮 aria 字面在场，且导出区结构腿在跑',
  'P-02': '受众 radio 的 name/客户版/内部版字面在场，且 radio[0] 真的导出 client 版',
  'P-03': '「只导已估算行」与 scope 三元字面在场，且勾选真的进 query 与 payload',
  'P-04': '两枚 PDF 的 aria 与按钮文案字面在场，且两枚按钮结构序与 idle 文案互异',
  'P-05': '两版 PDF 的 title 字面在场，且两版 title 真的各说各版、非空',
  'P-06': '裁决 D4 的「PDF 为预览件…」字面在场，且导出区结构腿在跑',
  'P-07': '「导出中…」字面在场，且被点按钮在导出期间真的离开 idle 文案',
  'P-08': '导出禁用 title 字面在场，且错误态两枚 PDF 的 title 真的同值且异于 idle',
  'P-09': '行内错误条 aria 字面在场，且服务端 400 时点名夹具行',
  'P-10': '「最近导出（」与受众标签函数字面在场，且受众列与服务端 audience 对应',
  'P-11': '导出 toast 模板字面在场，且 toast 带服务端件名',
  'P-12': '三点字段顺序与 O/M/P 标签字面在场，且第 3 框确实写 P 字段并触发 400',
  'P-13': '件名前缀/客户版标记字面在场，且两版下载名逐字等于服务端 filename 且互异',
  'P-14': 'PDF 路由/快照响应头/格式白名单字面在场，且请求真的打到 export-pdf 且留存 format=pdf',
};
for (const spec of P_SPECS) {
  okPair(ok, `${spec.id} ${P_LABEL[spec.id]}`, spec.behavior, () => literalOf(spec), () => ({ spec: spec.id, anchors: spec.anchors }));
}

// ---------------- 6) N 组：负对照 ----------------
console.log('\n=== N 组：负对照 ===');
const withEV = (obj, fn) => { const saved = EV; EV = obj; try { return fn(); } finally { EV = saved; } };
ok('N-01 空源码探针：14 条字面腿喂空串后全部为假（没有不承重的正则）',
  P_SPECS.every((s) => literalOf(s, '') === false));
ok('N-01b HEAD 文本在场性：27 个锚点在已提交树里逐字命中',
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
ok('N-03 改名模拟：27 个锚点逐个从 HEAD 副本中抹掉后，字面判据各自转假（且每条自证 tampered !== original）',
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
  'E-05': (e) => { e.tips.idleClientTitle = e.tips.idleInternalTitle; },
  'E-06': (e) => { e.initial.internalChecked = false; },
  'E-07': (e) => { e.x1.req.status = 500; },
  'E-08': (e) => { e.x1.dlName = 'x.pdf'; },
  'E-09': (e) => { e.x1.dlName = 'x.txt'; },
  'E-10': (e) => { e.x1.blob.head = '00000000'; },
  'E-11': (e) => { e.x1.toast = ''; },
  'E-12': (e) => { e.x1.snapFormat = 'xlsx'; },
  'E-13': (e) => { e.x1.payload.unreviewed = 0; },
  'E-14': (e) => { e.x2.req.audience = 'internal'; },
  'E-15': (e) => { e.x2.dlName = e.x1.dlName; },
  'E-16': (e) => { e.x2.blob.eof = false; },
  'E-17': (e) => { e.x2.payload.actualManMonths.expected += 1; },
  'E-18': (e) => { e.x2.blob.size = e.x1.blob.size; },
  'E-19': (e) => { e.x2.uiSnap.aud = ['x', 'x']; },
  'E-20': (e) => { e.err.alertText = ''; },
  'E-21': (e) => { e.err.allDisabled = false; },
  'E-22': (e) => { e.err.blockedTitles.client = e.tips.idleClientTitle; },
  'E-23': (e) => { e.err.reqAfter = e.err.reqBefore + 1; },
  'E-24': (e) => { e.err.recovered = 0; },
  'E-25': (e) => { e.scope.req.scope = 'all'; },
  'E-26': (e) => { e.mid.label = e.mid.idleLabel; },
  'E-27': (e) => { e.mid.final.l1 = 'x'; },
  'E-28': (e) => { e.reqs.statuses = [200, 500]; },
  'E-29': (e) => { e.vp.widths[0].wide = true; },
  'E-30': (e) => { e.vp.overlay = { wide: true, btn: true }; },
  'E-31': (e) => { e.health.jsErrors = ['boom']; },
  'E-32': (e) => { e.health.apiBad = 1; },
};
const mutResults = BEHAVIOR.map((b) => {
  const mutate = MUTATIONS[b.id];
  if (!mutate) return { id: b.id, name: b.label, turnedFalse: 'no-mutation' };
  const e = structuredClone(EV);
  mutate(e);
  return { id: b.id, name: b.label, turnedFalse: withEV(e, b.fn) === false };
});
ok('N-05 破坏形态反证：29 类实测料被改写后对应行为腿各自转假（结构/请求/件名/载荷/快照/错误态/并发闸/视口/健康）',
  mutResults.every((r) => r.turnedFalse === true), mutResults.filter((r) => r.turnedFalse !== true));

console.log(`\n结果：PASS=${pass} FAIL=${fail}｜截图：${shotFiles.join('、') || '无'}`);
process.exit(fail === 0 ? 0 : 1);
