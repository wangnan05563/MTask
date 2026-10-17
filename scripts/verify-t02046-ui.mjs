#!/usr/bin/env node
/**
 * T02046（估算视图 §7「数据联动与变更影响」· E9）真机走查：CDP 驱动系统 Chrome 打开**隔离实例**的估算面板，
 * 只断言「非真实浏览器不能回答」的四类问题：
 *   ① §7 提示条四行按服务端 `checks` 出数（初始无快照时「建议重导」那一行确实不出现，不是长亮）；
 *   ② 行级徽标（偏差比值 / 超排期）逐行落在服务端点名的那一行，比值与阈值都是服务端下发的字符串；
 *   ③ **已收口里程碑的只读徽标 + 「解锁改写」在界面上摸得到**——本轮修复的正是这条可达性
 *      （`groupTimelinePhases` 把里程碑放在 `group.milestone` 而不是 `items`，明细段若只 map items，
 *      §7 只读判据的 UI 出口就是死码）；解锁后写入真的带 `unlock:true` 并被服务端放行，取消解锁即回只读，
 *      且已解锁的里程碑行仍不参与批量填充（§4.6 红线一）；
 *   ④ 影响试算零写入（界面数字 = 服务端同 payload 重放的数字，Δ% 不在前端算）；
 *      上次导出后变更提示由 UI 驱动走完整一圈（导出 → 行内改 M → 点名该计划 → 再导出 → 归零）。
 *
 * 用法（本仓内置 Browser 无视口不能点击/截图，见 memory）：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02046-ui.mjs
 *   环境变量：T02046_UI_PORT（默认 39946）、T02046_UI_CDP（默认 9356）
 *
 * 隔离纪律（skill 红线 8）：MTask_DATA_DIR 指临时目录、端口自配，不碰生产库与用户实例；
 * 下载在页面内拦截（不写盘），截图落每轮独立子目录（`MTASK_GATE_ARTIFACT_DIR/<门名>-<运行标识>/`，T02312：不再落仓库根固定名目录，防并发整图互覆）。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02046-ui-'));
const CHROME_PROFILE = mkdtempSync(join(tmpdir(), 't02046-ui-chrome-'));
// T02312：截图不落仓库根固定名目录（并发跑门时同一步骤名整图互覆，且仓库根长期堆未纳管产物）——
// 改用 gate-results 的进程级 RUN_TAG 子目录，与本轮文本产物同标识，可按标识核对归属。
const { gateShotsDir } = await import(pathToFileURL(join(ROOT, 'scripts/lib/gate-results.mts')).href);
const SHOTS = gateShotsDir('t02046');
const PORT = Number(process.env.T02046_UI_PORT ?? 39946);
const CDP = Number(process.env.T02046_UI_CDP ?? 9356);
const CHROME = process.env.T02046_UI_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra).toString().slice(0, 500)}` : ''}`);
  }
};

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shift = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return ymd(d); };
const TODAY = shift(0);
const FAR = shift(40);   // 剩余排期宽裕：只验偏差比值，不掺进「超排期」
const TIGHT = shift(2);  // 剩余排期紧张：E > 剩余工作日 → pressure

// ---------------- 1) 夹具：临时库直写（进程内，起服务前完成） ----------------
process.env.MTask_DATA_DIR = DATA_DIR;
const { getDb, closeDb } = await import('../server/src/db/connection.ts');
const { initSchema } = await import('../server/src/db/schema.ts');
initSchema();
const T = new Date().toISOString();
const PID = 'ui-e9x';
const PNAME = 'T02046-变更影响走查';
const MS_DONE = 'M1 已交付里程碑';
const MS_OPEN = 'M2 在途里程碑';
const R_HIGH = '偏差-偏大行';
const R_LOW = '偏差-偏小行';
const R_OK = '偏差-正常行';
const R_TIGHT = '排期压力行';
const db = getDb();
db.prepare('INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
  .run(PID, PNAME, '', T, T);
const insPlan = db.prepare(
  `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
     progress, status, assignee, sort_order, created_at, updated_at, kind, complexity, req_ids, deps)
   VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, null, ?)`,
);
// 每条 10 个字段：id / 标题 / start / end / 排期工作日 / 进度 / 状态 / kind / 复杂度 / deps
// duration_days 只喂「偏差比值 = E ÷ 排期工作日」，end_date 只喂「剩余排期」——两条判据分开布点才能互证
const DEP = (ms) => JSON.stringify([{ id: ms, type: 'child' }]);
const plans = [
  ['ms-done', MS_DONE, TODAY, FAR, 6, 100, 'done', 'milestone', null, null],
  ['ms-open', MS_OPEN, TODAY, FAR, 4, 40, 'doing', 'milestone', null, null],
  ['r-high', R_HIGH, TODAY, FAR, 2, 0, 'doing', 'normal', 3, DEP('ms-done')],   // E15/2=7.5 → high
  ['r-low', R_LOW, TODAY, FAR, 20, 0, 'todo', 'normal', 2, DEP('ms-done')],     // E2/20=0.1 → low
  ['r-ok', R_OK, TODAY, FAR, 5, 0, 'todo', 'normal', 2, DEP('ms-done')],        // E4/5=0.8 → 无徽标
  ['r-tight', R_TIGHT, TODAY, TIGHT, 10, 0, 'todo', 'normal', 3, DEP('ms-done')], // 比值 1.0 不偏差，但 E10 > 剩余 ~2 → 超排期
  ['r-unest', '未估算行', TODAY, FAR, 5, 0, 'todo', 'normal', 1, DEP('ms-open')],
];
plans.forEach(([id, title, s, e, dur, prog, st, kind, cx, deps], i) => {
  insPlan.run(id, PID, title, s, e, dur, prog, st, i + 1, T, T, kind, cx ?? null, deps ?? null);
});
const insEst = db.prepare(
  `INSERT INTO estimate_items (id, project_id, plan_id, phase, unit, optimistic, likely, pessimistic, source, note, created_at, updated_at)
   VALUES (?, ?, ?, 'dev', 'man_day', ?, ?, ?, 'manual', '', ?, ?)`,
);
// 里程碑也留估算行：§7 的只读判定**只对已收口里程碑成立**，没有这条行就没有可走的解锁路径
insEst.run('e-ms', PID, 'ms-done', 3, 5, 9, T, T);
insEst.run('e-ms-open', PID, 'ms-open', 2, 3, 4, T, T);
insEst.run('e-high', PID, 'r-high', 10, 15, 20, T, T);
insEst.run('e-low', PID, 'r-low', 1, 2, 3, T, T);
insEst.run('e-ok', PID, 'r-ok', 3, 4, 5, T, T);
insEst.run('e-tight', PID, 'r-tight', 8, 10, 12, T, T);
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
  if (process.env.T02046_UI_KEEP) return;
  for (const dir of [DATA_DIR, CHROME_PROFILE]) {
    for (let i = 0; i < 8; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break; } catch { sleepSync(i); }
    }
  }
};
process.on('exit', cleanup);

let serverUp = false;
for (let i = 0; i < 90; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) { serverUp = true; break; } } catch { /* */ } await sleep(500); }
ok('V-00 隔离服务启动（临时端口 + 临时库：2 条里程碑 + 4 条已估算计划 + 1 条未估算，日历为空）', serverUp);
if (!serverUp) {
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
ok('V-01 Chrome CDP 通道就绪（系统 Chrome, headless=new）', !!wsUrl, wsUrl);
if (!wsUrl) process.exit(1);

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pend = new Map();
const reqLog = [];   // 写通道取证：method + url + 请求体（`unlock` 是否真随写请求发出，只能在这里看）
const getLog = [];   // 出件取证：export-xlsx / what-if 的状态码
ws.onmessage = (ev2) => {
  const m = JSON.parse(ev2.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const { method, url, postData } = m.params.request;
    if (/\/api\/(estimates|plans)/.test(url)) {
      reqLog.push({ method, url: url.replace(/^https?:\/\/[^/]+/, ''), body: postData ?? '' });
    }
  }
  if (m.method === 'Network.responseReceived' && /\/api\/(estimates|plans)/.test(m.params.response.url)) {
    getLog.push({ url: m.params.response.url.replace(/^https?:\/\/[^/]+/, ''), status: m.params.response.status });
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

const PJ = `const p=()=>document.querySelector('aside[aria-label="估算面板"]')||[...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find(d=>d.innerText.includes('实际预估人月'));
  const hint=()=>p()&&p().querySelector('[aria-label="估算变更影响提示"]');
  const inp=(t,f)=>{const lbl=t+' '+({'optimistic':'乐观 O','likely':'最可能 M','pessimistic':'悲观 P'}[f])+'（人天）';
    return [...p().querySelectorAll('input[type="number"]')].find(i=>(i.getAttribute('aria-label')||'')===lbl);};
  const row=t=>{const i=inp(t,'optimistic');return i?i.closest('div[style*="border-bottom"]'):null;};
  const badges=r=>[...(r||{querySelectorAll(){return[];}}).querySelectorAll('span')].map(x=>x.textContent.trim());`;
/** 面板内求值统一套 IIFE（裸 return 交给 Runtime.evaluate 是语法错误，T02040 踩过） */
const PE = (strings, ...exprs) => {
  let body = strings[0];
  exprs.forEach((e, i) => { body += String(e) + strings[i + 1]; });
  return `(() => { ${PJ}${body} })()`;
};
const rest = async (path) => (await fetch(`${BASE}/api${path}`)).json();
/** 面板数据是异步刷新的：改完直接读会读到上一轮，所以每条断言都用 until 等自己那一条成立 */
async function diag(tag, expr) {
  const panel = await ev(PE`return p()?p().innerText.slice(0,900):'no-panel';`);
  const errs = await ev(`(window.__errs||[]).slice(-3).join(' | ')`);
  const srv = serverLog.join('').split('\n').filter((l) => /estimates|error|异常/i.test(l)).slice(-4).join(' ⏎ ');
  console.log(`  [DIAG ${tag}] 断言现场: ${String(expr).slice(0, 300)}`);
  console.log(`  [DIAG ${tag}] 面板首段: ${String(panel).replace(/\s*\n+\s*/g, ' ⏎ ').slice(0, 360)}`);
  console.log(`  [DIAG ${tag}] 页面报错: ${errs || '无'}`);
  console.log(`  [DIAG ${tag}] 服务日志: ${srv || '无匹配行'}`);
  console.log(`  [DIAG ${tag}] 接口: ${getLog.slice(-4).map((n) => `${n.status} ${n.url}`).join(' | ') || '无'}`);
}
/** 原生 setter + input 事件（React 受控 input 直接改 .value 不触发 onChange，T02041 实证） */
const typeInto = async (locatorExpr, value) => {
  await ev(`(() => { ${PJ}const el=${locatorExpr}; if(!el) return 'missing'; el.scrollIntoView({block:'center'}); el.focus(); return 'focused'; })()`);
  await sleep(120);
  await ev(`(() => { ${PJ}const el=${locatorExpr};
    const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
    d.set.call(el,${JSON.stringify(String(value))}); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value; })()`);
  await sleep(150);
};
const pressEnter = async (locatorExpr) => {
  await ev(`(() => { ${PJ}const el=${locatorExpr};
    el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return 1; })()`);
};
const clickLabeled = (text) => PE`const b=[...p().querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(text)});
  if(!b) return 'nobtn'; b.scrollIntoView({block:'center'}); b.click(); return 'clicked';`;

const num = (s) => Number(String(s).replace(/[^\d.\-]/g, ''));
const near = (a, b, tol = 0.011) => Math.abs(a - b) <= tol;

await send('Page.enable');
await send('Network.enable');
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
ok('V-02 页面加载完成（桌面 UI）',
  await until(`[...document.querySelectorAll('button')].some(x=>x.textContent.trim()==='项目管理')`), 'nav 按钮缺失');
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '项目管理'); b?.click(); return 1; })()`);
await setViewport(1920, 1000);
ok('V-03 估算面板已打开（时间线视图 + 面板开键种入）', await until(PE`return !!p();`), '面板未出现');

console.log('\n=== §7 提示条：四行按服务端 checks 出数（初始无快照 → 「建议重导」那行不出现） ===');
const snap0 = await rest(`/estimates?projectId=${PID}`);
ok('V-10 提示条存在且含「排期与估算不一致 / 偏差超阈值 / 已收口只读」三行（都来自 checks 计数）',
  await until(PE`const h=hint(); if(!h) return ''; return {t:h.innerText.replace(/\\s+/g,' '),
    pressure: h.innerText.includes('排期与估算不一致'), drift: h.innerText.includes('偏差超阈值'),
    locked: h.innerText.includes('服务端已置只读')};`, 25_000)
    .then(async (s) => {
      if (!s || !s.pressure || !s.drift || !s.locked) { await diag('V-10', ''); return false; }
      const c = (await rest(`/estimates?projectId=${PID}`)).checks.drift;
      return s.pressure && s.drift && s.locked && new RegExp(`${c.high + c.low} 行的 E 与排期偏差超阈值`).test(s.t)
        && new RegExp(`${c.pressure} 行估算人天超过剩余排期工作日`).test(s.t)
        && new RegExp(`${c.locked} 行属于已收口里程碑`).test(s.t);
    }));
ok('V-11 初始态没有「建议重导」那行（一条导出都没做过，提示不能凭空长亮）',
  await ev(PE`const h=hint(); return h && !h.innerText.includes('建议重导') && !h.innerText.includes('上次导出');`) === true,
  await ev(PE`return hint()?hint().innerText.replace(/\\s+/g,' '):'no-hint';`));

console.log('\n=== 行级偏差徽标 / 超排期徽标：逐行点名与服务端 drift 同一份 ===');
const items0 = snap0.items;
const byPlan = (id) => items0.find((i) => i.plan_id === id);
const driftOf = (id) => byPlan(id)?.drift ?? {};
ok('V-20 服务端点名的高/低偏差行就是面板上带「偏差」徽标的两行（7.5 与 0.1）',
  await until(PE`const out={}; for (const t of ${JSON.stringify([R_HIGH, R_LOW, R_OK, R_TIGHT])}) {
      const r=row(t); if(!r) return 'norow:'+t; out[t]=badges(r).filter(x=>x.startsWith('偏差 ')).map(x=>x.slice(3)); }
    return Object.values(out).every((v)=>v.length<=1) && out[${JSON.stringify(R_HIGH)}][0] && out[${JSON.stringify(R_LOW)}][0] ? out : 'empty:'+JSON.stringify(out);`, 25_000)
    .then(async (s) => {
      if (!s || typeof s !== 'object') { await diag('V-20', String(s)); return false; }
      const h = driftOf('r-high'); const l = driftOf('r-low');
      const okh = String(h.ratio) === s[R_HIGH][0] && h.flag === 'high';
      const okl = String(l.ratio) === s[R_LOW][0] && l.flag === 'low';
      const noOk = s[R_OK].length === 0 && driftOf('r-ok').flag == null;
      const noTight = s[R_TIGHT].length === 0 && driftOf('r-tight').flag == null;
      if (!(okh && okl && noOk && noTight)) await diag('V-20b', JSON.stringify({ s, h, l }));
      return okh && okl && noOk && noTight;
    }));
ok('V-21 偏差徽标 title 里的阈值是服务端下发的（>1.5 / <0.67 与 checks.drift.thresholds 逐字相同）',
  await ev(PE`const r=row(${JSON.stringify(R_HIGH)}); const b=[...r.querySelectorAll('span')].find(x=>x.textContent.trim().startsWith('偏差 '));
    return b.getAttribute('title');`).then((t) => {
    const th = snap0.checks.drift.thresholds;
    return typeof t === 'string' && t.includes(`> ${th.high}`) && t.includes(`< ${th.low}`);
  }), await ev(PE`const r=row(${JSON.stringify(R_HIGH)}); return [...r.querySelectorAll('span')].find(x=>x.textContent.trim().startsWith('偏差 ')).getAttribute('title');`));
ok('V-22 「超排期」徽标只落在 E > 剩余排期工作日的行，且 title 复述服务端比值与今日',
  await (async () => {
    const titles = await ev(PE`const out={}; for (const t of ${JSON.stringify([R_HIGH, R_LOW, R_OK, R_TIGHT, MS_DONE])}) {
      const r=row(t); if(!r) return 'norow:'+t; out[t]=[...r.querySelectorAll('span')].filter(x=>x.textContent.trim()==='超排期').map(x=>x.getAttribute('title')); }
    return out;`);
    if (typeof titles === 'string') { await diag('V-22', titles); return false; }
    const tight = (titles[R_TIGHT] ?? [])[0] ?? '';
    const d = driftOf('r-tight');
    const onlyTight = Object.entries(titles).every(([k, v]) => (k === R_TIGHT ? v.length === 1 : v.length === 0));
    const counts = Object.values(titles).reduce((s, v) => s + v.length, 0) === snap0.checks.drift.pressure;
    const body = tight.includes(`剩余排期工作日 ${d.remainingWorkdays}`) && tight.includes(snap0.checks.drift.today);
    if (!(onlyTight && counts && body)) await diag('V-22b', JSON.stringify({ titles, d, press: snap0.checks.drift.pressure }));
    return onlyTight && counts && body;
  })());
await shot('00-drift-badges');

console.log('\n=== 里程碑收口只读：可达性 + 解锁写入带 unlock + 取消解锁 + 批量口径 ===');
// 这一组是本轮修复的正题：徽标与按钮在源码里一直存在，但里程碑行进不了明细渲染列表的话就永远点不到
ok('V-30 已收口里程碑的估算行出现在分组体里，且带着「已收口·只读」徽标（面板全文只此一行有它）',
  await until(PE`const r=row(${JSON.stringify(MS_DONE)}); if(!r) return 'no-row';
    return badges(r).includes('已收口·只读') ? 1 : 'no-badge:' + badges(r).join(',');`, 25_000) === 1,
  await ev(PE`const r=row(${JSON.stringify(MS_DONE)}); return r ? badges(r).join(',') : 'no-row';`));
ok('V-30b 全面板「已收口·只读」徽标数 == checks.drift.locked（判定单源，面板不额外多标一行）',
  await ev(PE`return [...p().querySelectorAll('span')].filter(x=>x.textContent.trim()==='已收口·只读'||x.textContent.trim()==='已解锁').length;`) === snap0.checks.drift.locked);
ok('V-31 只读行的三个输入框都禁用，title 说明「已收口 → 只读」并指向「解锁改写」',
  await ev(PE`const i=['optimistic','likely','pessimistic'].map(f=>inp(${JSON.stringify(MS_DONE)},f));
    if(i.some(x=>!x)) return 'noinput';
    return i.every(x=>x.disabled) && i.every(x=>(x.getAttribute('title')||'').includes('已收口') && (x.getAttribute('title')||'').includes('解锁改写'));`) === true);
ok('V-32 未收口里程碑行不带只读徽标，但输入框仍禁用且写明「不落估算」（§4.6 红线一，两种禁用理由不混）',
  await ev(PE`const r=row(${JSON.stringify(MS_OPEN)}); if(!r) return 'no-row';
    const i=['optimistic','likely','pessimistic'].map(f=>inp(${JSON.stringify(MS_OPEN)},f));
    return { badge: badges(r).some(x=>x==='已收口·只读'), dis: i.every(x=>x.disabled), t: i[0].getAttribute('title')||'' };`)
    .then((s) => s && s.badge === false && s.dis === true && s.t.includes('不落估算')),
  await ev(PE`const r=row(${JSON.stringify(MS_OPEN)}); return r?{badges:badges(r).join(','),title:(inp(${JSON.stringify(MS_OPEN)},'optimistic')||{}).title}:null;`));

const patchBefore = reqLog.length;
const unlockClick = await ev(clickLabeled('解锁改写'));
ok('V-33 只读行右侧有「解锁改写」按钮且点得动（可达性修复的直接证据）',
  unlockClick === 'clicked' && await until(PE`const r=row(${JSON.stringify(MS_DONE)});
    return badges(r).includes('已解锁') && !badges(r).includes('已收口·只读') ? 1 : '';`, 12_000) === 1, unlockClick);
ok('V-34 解锁后该行三个输入框放开、title 注明「本行已显式解锁，写入带 unlock」，但勾选框仍禁用（解锁 ≠ 进批量填充）',
  await ev(PE`const i=['optimistic','likely','pessimistic'].map(f=>inp(${JSON.stringify(MS_DONE)},f));
    const c=row(${JSON.stringify(MS_DONE)}).querySelector('input[type="checkbox"]');
    return i.every(x=>!x.disabled) && i.every(x=>(x.getAttribute('title')||'').includes('已显式解锁')) && c.disabled === true;`) === true);
await typeInto(`inp(${JSON.stringify(MS_DONE)},'likely')`, 6);
await pressEnter(`inp(${JSON.stringify(MS_DONE)},'likely')`);
await sleep(1_800);
ok('V-35 解锁后改 M 真的发出带 unlock 的写请求并被服务端放行（200 落在同一条 URL 上，不是面板自己放行）',
  await (async () => {
    const hit = reqLog.slice(patchBefore).find((r) => r.method === 'PATCH' && /estimates/.test(r.url));
    const res = getLog.filter((n) => n.url === hit?.url).pop();
    const item = (await rest(`/estimates?projectId=${PID}`)).items.find((i) => i.plan_id === 'ms-done');
    // 三点值按行内录入的原样（字符串）送出、由服务端统一收口成数值（§8 PATCH 语义），`unlock` 是布尔标志
    const sent = !!hit && /"unlock"\s*:\s*true/.test(hit.body) && /"likely"\s*:\s*"?6"?[,}]/.test(hit.body);
    if (!sent || item?.likely !== 6 || res?.status !== 200) {
      await diag('V-35', `hit=${JSON.stringify(hit)} res=${JSON.stringify(res)} likely=${item?.likely} `
        + `reqTail=${JSON.stringify(reqLog.slice(-3))}`);
    }
    return sent && item?.likely === 6 && res?.status === 200;
  })());
ok('V-35b 已收口里程碑被改写后仍是「已解锁」标记（解锁只在会话内、不改全局开关，也不留 per-row 例外）',
  await ev(PE`const r=row(${JSON.stringify(MS_DONE)}); return badges(r).includes('已解锁') && [...r.querySelectorAll('button')].some(b=>b.textContent.trim()==='取消解锁');`) === true);
await ev(clickLabeled('取消解锁'));
ok('V-36 「取消解锁」把该行收回只读（徽标回位 + 输入框再禁用）',
  await until(PE`const r=row(${JSON.stringify(MS_DONE)});
    return badges(r).includes('已收口·只读') && ['optimistic','likely','pessimistic'].every(f=>inp(${JSON.stringify(MS_DONE)},f).disabled) ? 1 : '';`, 12_000) === 1);
ok('V-37 两条里程碑行都不给勾选，普通任务行给（§4.6 红线一与只读态是两条独立判据）',
  await ev(PE`const c=row(${JSON.stringify(MS_DONE)})?.querySelector('input[type="checkbox"]');
    const cOpen=row(${JSON.stringify(MS_OPEN)})?.querySelector('input[type="checkbox"]');
    const cNorm=row(${JSON.stringify(R_HIGH)})?.querySelector('input[type="checkbox"]');
    return c && cOpen && cNorm ? (c.disabled === true && cOpen.disabled === true && cNorm.disabled === false) : '';`) === true);
await shot('01-milestone-readonly-unlock');

console.log('\n=== 折叠语义未破：段体（含里程碑行）随组头收起，组头常驻 ===');
const collapse = PE`const h=[...p().querySelectorAll('[role="button"]')].find(x=>x.textContent.includes(${JSON.stringify(MS_DONE)}));
  if(!h) return 'noheader'; h.click(); return 'clicked';`;
const headWas = await ev(PE`return [...p().querySelectorAll('[role="button"]')].filter(x=>x.textContent.includes('不进 Σ')).length;`);
await ev(collapse);
ok('V-38 折叠该里程碑后段内任务行与里程碑自己的估算行一起收起，组头仍常驻（与 T01576 口径一致）',
  await until(PE`return row(${JSON.stringify(R_HIGH)}) === null && row(${JSON.stringify(MS_DONE)}) === null
    && [...p().querySelectorAll('[role="button"]')].some(x=>x.textContent.includes(${JSON.stringify(MS_DONE)})) ? 1 : '';`, 12_000) === 1);
await ev(collapse);
ok('V-39 展开回来后徽标与只读行都在（折叠不丢 §7 判定，也不重复计数）',
  await until(PE`const r=row(${JSON.stringify(MS_DONE)}); return r && badges(r).includes('已收口·只读') && row(${JSON.stringify(R_HIGH)}) ? 1 : '';`, 12_000) === 1
    && await ev(PE`return [...p().querySelectorAll('[role="button"]')].filter(x=>x.textContent.includes('不进 Σ')).length;`) === headWas);

console.log('\n=== 影响试算（零写入）===');
await ev(clickLabeled('影响试算…'));
ok('V-40 「影响试算…」展开表单（四档系数 + 试算按钮初始禁用）',
  await until(PE`const f=p().querySelector('[aria-label="影响试算表单"]'); if(!f) return '';
    return { coefs: [...f.querySelectorAll('input[type="number"]')].length, dis: [...f.querySelectorAll('button')].find(b=>b.textContent.trim()==='试算').disabled,
      tip: f.innerText.includes('先改一个系数或某行 P') };`, 12_000)
    .then((s) => s && s.coefs >= 4 && s.dis === true && s.tip === true),
  await ev(PE`const f=p().querySelector('[aria-label="影响试算表单"]'); return f?f.innerText.replace(/\\s+/g,' ').slice(0,220):'no-form';`));
const FORM_INPUT = `[...p().querySelector('[aria-label="影响试算表单"]').querySelectorAll('input[type="number"]')][0]`;
await typeInto(FORM_INPUT, 0.1);
ok('V-41 改一个系数后「试算」解禁（未改任何东西时不给点，避免一次空试算被当成结果）',
  await until(PE`const f=p().querySelector('[aria-label="影响试算表单"]');
    return [...f.querySelectorAll('button')].find(b=>b.textContent.trim()==='试算').disabled === false ? 1 : '';`, 10_000) === 1);
const summaryBeforeTrial = (await rest(`/estimates?projectId=${PID}`)).summary;
const whatIfAt = reqLog.length;
await ev(PE`const f=p().querySelector('[aria-label="影响试算表单"]');
  const b=[...f.querySelectorAll('button')].find(x=>x.textContent.trim()==='试算'); b.click(); return 'clicked';`);
await sleep(1_200);
const trialReq = reqLog.slice(whatIfAt).find((r) => /what-if/.test(r.url));
ok('V-42 点「试算」只发一条 POST /what-if，请求体里只带改过的那一档系数（不发整份参数、不发全表行）',
  !!trialReq && trialReq.method === 'POST'
  && Object.keys(JSON.parse(trialReq.body).coefs).length === 1
  && (JSON.parse(trialReq.body).rows ?? []).length === 0, trialReq ? trialReq.body.slice(0, 200) : { tail: reqLog.slice(-3) });
ok('V-43 结果块出的「实际预估人月 X → Y」X == 服务端当前值、Y == 用同一 payload 重放服务端所得（面板不自己算 Δ%）',
  await until(PE`const r=p().querySelector('[aria-label="影响试算结果"]'); return r?r.innerText.replace(/\\s+/g,' '):'';`, 20_000)
    .then(async (t) => {
      if (!t) { await diag('V-43', ''); return false; }
      const m = /实际预估人月 ([\d.]+) → ([\d.]+)/.exec(t);
      const body = JSON.parse(trialReq.body);
      const replay = await (await fetch(`${BASE}/api/estimates/what-if?projectId=${PID}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })).json();
      const x = m?.[1]; const y = m?.[2];
      const isBefore = near(num(x), summaryBeforeTrial.actualManMonths.expected);
      // `what-if` 响应里的 before/after 侧只回四项读数（`whatIfSide`），人月本身就是数字而非 {expected} 结构
      const isAfter = near(num(y), replay.after.actualManMonths);
      const deltaText = (() => {
        const dm = /Δ\s*([-+]?\d+(?:\.\d+)?)/.exec(t);
        return !!dm && near(Number(dm[1]), replay.delta.actualManMonths, 0.011);
      })();
      if (!(isBefore && isAfter && deltaText)) {
        await diag('V-43b', `text=${t.slice(0, 200)} | x=${x} y=${y} `
          + `serverBefore=${summaryBeforeTrial.actualManMonths.expected} replayAfter=${replay.after?.actualManMonths} `
          + `replayDelta=${replay.delta?.actualManMonths} replayErr=${replay.error ?? ''}`);
      }
      return isBefore && isAfter && deltaText;
    }));
ok('V-44 结果块写明「未写入任何数据（written=0）」，且服务端汇总前后一模一样（试算真的零写入）',
  await ev(PE`return p().querySelector('[aria-label="影响试算结果"]').innerText.includes('本次试算未写入任何数据（服务端 written=0）');`) === true
  && (await rest(`/estimates?projectId=${PID}`)).summary.actualManMonths.expected === summaryBeforeTrial.actualManMonths.expected,
  await rest(`/estimates?projectId=${PID}`));
await shot('02-whatif-result');

console.log('\n=== 上次导出后变更提示：由界面走完整一圈 ===');
ok('V-50 面板点「导出 Excel」真的出件（下载名来自服务端，提示条仍无「建议重导」）',
  await (async () => {
    await ev(PE`const b=p().querySelector('[aria-label="导出 Excel 文件"]'); if(!b) return 'nobtn'; b.scrollIntoView({block:'center'}); b.click(); return 'clicked';`);
    const dl = await until(PE`return window.__dl.length > 0 && window.__blobs[window.__blobs.length-1] ? { name: window.__dl[0], size: window.__blobs[0].size } : '';`, 30_000);
    if (!dl) { await diag('V-50', ''); return false; }
    const h = await ev(PE`return hint() ? hint().innerText.includes('建议重导') : 'no-hint';`);
    if (h !== false) await diag('V-50b', h);
    return /\.xlsx$/i.test(dl.name) && dl.size > 3000 && h === false;
  })());
await sleep(1_300); // 时间戳同毫秒时字符串比较不判为「变更」，间隔开才符合真实操作节奏
const beforeEdit = (await rest(`/estimates?projectId=${PID}`)).checks.changedSinceExport.count;
await typeInto(`inp(${JSON.stringify(R_OK)},'likely')`, 5);
await pressEnter(`inp(${JSON.stringify(R_OK)},'likely')`);
ok('V-51 导出后在面板里改一行 M → 提示条点名「上次导出后 1 条计划已变化 → 建议重导」，title 写明改了哪一侧',
  await until(PE`const h=hint(); if(!h) return ''; const t=h.innerText.replace(/\\s+/g,' ');
    return t.includes('上次导出后 1 条计划已变化 → 建议重导') ? { t, tip: [...h.querySelectorAll('div')].map(x=>x.getAttribute('title')||'').join(' ') } : '';`, 25_000)
    .then((s) => {
      if (!s) return false;
      const named = s.tip.includes(R_OK) && s.tip.includes('estimate');
      if (!named) void diag('V-51', JSON.stringify(s).slice(0, 400));
      return beforeEdit === 0 && named;
    }));
await shot('03-reimport-hint');
const again = await ev(PE`const b=p().querySelector('[aria-label="导出 Excel 文件"]'); b.click(); return 'clicked';`);
ok('V-52 再导一次后该提示归零（取最近一条快照，不是长亮也不是回到最早那条）',
  await until(PE`const h=hint(); return h && !h.innerText.includes('建议重导') ? 1 : '';`, 30_000) === 1, again);
ok('V-52b 归零后其余 §7 行仍在（提示条只摘掉「建议重导」这一条，不是整条隐藏）',
  await ev(PE`const h=hint(); return h && h.innerText.includes('服务端已置只读') && h.innerText.includes('偏差超阈值');`) === true);

console.log('\n=== 卫生：无 JS 报错 / 三档视口无横向滚动 / 服务日志干净 ===');
ok('V-60 全程无页面 JS 错误', await ev(`(window.__errs||[]).length === 0 ? 1 : (window.__errs||[]).slice(-3).join(' | ')`) === 1,
  await ev(`(window.__errs||[]).slice(0,6).join(' | ')`));
ok('V-61 三档视口（1920/1440/1200）面板内无横向滚动，§7 徽标照常渲染', await (async () => {
  const res = [];
  for (const w of [1920, 1440, 1200]) {
    await setViewport(w, 1000);
    res.push(await ev(PE`const s=p().scrollWidth - p().clientWidth;
      return { w:${w}, overflow: s > 1, badges: [...p().querySelectorAll('span')].filter(x=>/^(偏差 |超排期|已收口·只读)/.test(x.textContent.trim())).length };`));
  }
  await setViewport(1920, 1000);
  return res.every((r) => r && r.overflow === false && r.badges >= 3);
})(), null);
await shot('04-viewport-1200');
const bad = serverLog.join('').split('\n').filter((l) => /异常|error|Error|500/.test(l) && !/无异常/.test(l));
ok('V-62 服务日志无 §7/试算/写闸门相关异常', bad.length === 0, bad.slice(0, 4));

console.log(`\n截图 ${shotFiles.length} 张 → ${SHOTS}`);
console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail > 0 ? 1 : 0);
