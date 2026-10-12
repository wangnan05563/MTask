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
 * 用法（Chrome 用系统安装版；本仓内置 Browser 无视口不能点击/截图，见 memory）：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02043-ui.mjs
 *   环境变量：T02043_UI_PORT（默认 39936）、T02043_UI_CDP（默认 9346）
 *
 * 隔离纪律（skill 红线 8）：MTask_DATA_DIR 指临时目录、端口自配，不碰生产库与用户实例；
 * 下载在页面内拦截（不写盘），截图落 .t02043-shots/。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02043-ui-'));
const CHROME_PROFILE = mkdtempSync(join(tmpdir(), 't02043-ui-chrome-'));
const SHOTS = join(ROOT, '.t02043-shots');
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
const tsxPath = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const server = spawn(process.execPath, [tsxPath, join(ROOT, 'server', 'src', 'index.ts')], {
  cwd: ROOT, env: { ...process.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR }, stdio: ['ignore', 'pipe', 'pipe'],
});
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
      shotFiles.push(`${name}.png`);
      return file;
    }
    await sleep(700);
  }
  return '';
}

const PJ = `const p=()=>document.querySelector('aside[aria-label="估算面板"]')||[...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find(d=>d.innerText.includes('实际预估人月'));
  const rg=()=>{const q=p()&&p().querySelector('[aria-label="估算导出区"]');return q;};`;
/** 面板内求值统一套 IIFE（裸 return 交给 Runtime.evaluate 是语法错误，T02040 踩过） */
const PE = (strings, ...exprs) => {
  let body = strings[0];
  exprs.forEach((e, i) => { body += String(e) + strings[i + 1]; });
  return `(() => { ${PJ}${body} })()`;
};
const EXP = PE`const b=rg()&&rg().querySelector('[aria-label="导出 Excel 文件"]');if(!b)return 'nobtn';b.scrollIntoView({block:'center'});b.click();return 'clicked';`;
/** radio / checkbox 控件本体不是 button（T02041 的假绿教训：找不到按钮会静默返回并让断言空过） */
const setAudience = (client) => PE`const l=[...rg().querySelectorAll('label')].find(x=>x.textContent.trim()===${JSON.stringify(client ? '客户版' : '内部版')});
  const r=l&&l.querySelector('input[type="radio"]'); if(!r) return 'noradio';
  if(!r.checked) r.click(); return r.checked===${client}?'ok':'stuck';`;
const setOnlyEstimated = (on) => PE`const l=[...rg().querySelectorAll('label')].find(x=>x.textContent.trim()==='只导已估算行');
  const c=l&&l.querySelector('input[type="checkbox"]'); if(!c) return 'nochk';
  if(c.checked!==${on}) c.click(); return c.checked===${on}?'ok':'stuck';`;
/** 快照行勾选框：导出区第 2 枚起的 checkbox（第 1 枚是「只导已估算行」），按 DOM 序即服务端倒序 */
const pickSnap = (i) => PE`const cs=[...rg().querySelectorAll('input[type="checkbox"]')].slice(1);
  const c=cs[${i}]; if(!c) return 'none'; if(!c.checked) c.click(); return 'ok';`;
const snapState = PE`const cs=[...rg().querySelectorAll('input[type="checkbox"]')].slice(1);
  return { n: cs.length, picked: cs.map((c)=>c.checked) };`;
const rest = async (path) => (await fetch(`${BASE}/api${path}`)).json();
const idle = async (tag) => {
  const v = await until(PE`const i=[...p().querySelectorAll('input[type="number"]')]; return i.length > 0 && i.every((x) => !x.disabled) ? 1 : '';`, 25_000);
  if (v !== 1) await diag(tag);
  return v;
};
async function diag(tag) {
  const panel = await ev(PE`return rg()?rg().innerText.slice(-600):'no-region';`);
  const errs = await ev(`(window.__errs||[]).slice(-3).join(' | ')`);
  const srv = serverLog.join('').split('\n').filter((l) => /estimates|error|异常/i.test(l)).slice(-4).join(' ⏎ ');
  console.log(`  [DIAG ${tag}] 导出区尾部: ${String(panel).replace(/\s*\n+\s*/g, ' ⏎ ').slice(-400)}`);
  console.log(`  [DIAG ${tag}] 页面报错: ${errs || '无'}`);
  console.log(`  [DIAG ${tag}] 服务日志: ${srv || '无匹配行'}`);
  console.log(`  [DIAG ${tag}] 接口请求: ${netLog.slice(-5).map((n) => `${n.status} ${n.url}`).join(' | ') || '无'}`);
}
/** 下载拦截：记住每次 createObjectURL 的 Blob 与 a[download] 的件名，二者按调用序一一对应 */
const DL_INFO = `(() => { const n=window.__dl.length; const out=[];
  for (let i=0;i<n;i++) out.push({ name: window.__dl[i], blobs: !!window.__blobs[i] });
  return out; })()`;
const READ_BLOB = `(async () => { const b=window.__blobs[window.__blobs.length-1];
  const buf=await b.arrayBuffer(); const u8=new Uint8Array(buf.slice(0,4));
  return { type: b.type, size: buf.byteLength, head: Array.from(u8).map((x)=>x.toString(16).padStart(2,'0')).join('') }; })()`;
const exportReqs = () => netLog.filter((n) => /export-xlsx/.test(n.url));

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
ok('E-02 页面加载完成（桌面 UI）',
  await until(`[...document.querySelectorAll('button')].some(x=>x.textContent.trim()==='项目管理')`), 'nav 按钮缺失');
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '项目管理'); b?.click(); return 1; })()`);
await setViewport(1920, 1000);
ok('E-03 估算面板已打开（会话态种入开键）', await until(PE`return !!p();`), '面板未出现');

console.log('\n=== 导出区落地形态（§5.2 第 4 段） ===');
ok('E-04 导出区存在且控件齐全：两枚受众 radio + 一枚 scope 勾选 + 一枚导出按钮',
  await until(PE`const r=rg(); if(!r) return '';
    const rs=[...r.querySelectorAll('input[type="radio"]')].map(x=>x.name);
    return { radios: rs.length, sameName: new Set(rs).size===1 && rs[0]==='estimate-audience',
      checks: [...r.querySelectorAll('input[type="checkbox"]')].length,
      btn: !!r.querySelector('[aria-label="导出 Excel 文件"]') };`)
    .then((s) => s && s.radios === 2 && s.sameName && s.checks === 1 && s.btn));
ok('E-05 初始态：内部版被选中、未勾「只导已估算行」、按钮可用、快照区给空态文案',
  await ev(PE`const r=rg();const cs=[...r.querySelectorAll('input[type="checkbox"]')];
    const onLabel=[...r.querySelectorAll('label')].find(l=>l.querySelector('input[type="radio"]:checked'));
    return { aud: onLabel?onLabel.textContent.trim():'', only: cs[0].checked,
      dis: r.querySelector('[aria-label="导出 Excel 文件"]').disabled,
      empty: r.innerText.includes('还没有导出记录') };`)
    .then((s) => s && s.aud === '内部版' && s.only === false && s.dis === false && s.empty === true));
await ev(setAudience(true));
ok('E-06 选客户版后出现「系数分项将折叠」提示（脱敏开关走服务端 app_settings，面板不自带默认值）',
  await until(PE`return rg().innerText.includes('系数分项将折叠') ? 1 : '';`, 8_000));
await ev(setAudience(false));
ok('E-06b 切回内部版后折叠提示消失（提示只跟随当前受众选择）',
  await until(PE`return !rg().innerText.includes('系数分项将折叠') ? 1 : '';`, 8_000));
await shot('00-export-region-initial');

console.log('\n=== 内部版导出：请求、真实下载与件名同源 ===');
const n0 = exportReqs().length;
await ev(EXP);
const q1 = await until(`window.__dl.length>0 ? 1 : ''`, 30_000);
const req1 = exportReqs()[n0];
ok('E-07 点「导出 Excel」真的打到 GET /api/estimates/export-xlsx 且 200',
  !!q1 && !!req1 && req1.status === 200 && /[?&]audience=internal/.test(req1.url) && /[?&]scope=all/.test(req1.url), req1);
const dl = await ev(DL_INFO);
const snapList0 = await rest(`/estimates/snapshots?projectId=${PID}`);
const srvName = (snapList0.snapshots ?? [])[0]?.filename;
ok('E-08 真的触发了一次下载，件名逐字等于服务端写进快照的 filename（前端没有第二套命名口径）',
  dl?.length === 1 && dl[0].name === srvName, { dl, srvName });
ok('E-09 件名符合 §6.1：工作量评估-项目名-yyyymmdd-HHMMSS.xlsx',
  /^工作量评估-T02043-导出区走查-\d{8}-\d{6}\.xlsx$/.test(String(srvName ?? '')), srvName);
const blob1 = await ev(READ_BLOB);
ok('E-10 下载体是真 xlsx（PK\\x03\\x04 头 + 表格 MIME + 体积过 5KB）',
  blob1 && blob1.head === '504b0304' && blob1.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' && blob1.size > 5000,
  blob1);
ok('E-11 导出成功有 toast（「已导出 …」带服务端件名，不是本地拼的）',
  await until(`[...document.querySelectorAll('.flash-toast')].some(x=>x.textContent.includes('已导出 工作量评估-')) ? 1 : ''`, 10_000));
const sn0 = (snapList0.snapshots ?? [])[0];
const pl0 = typeof sn0?.payload === 'string' ? JSON.parse(sn0.payload) : sn0?.payload;
const snapRows = await until(PE`const r=rg(); const rows=[...r.querySelectorAll('input[type="checkbox"]')].slice(1);
  return rows.length===1 ? r.innerText : '';`, 20_000);
const mmShown = [...String(snapRows ?? '').matchAll(/(-?\d+(?:\.\d+)?) 人月/g)].map((m) => Number(m[1]));
ok('E-12 快照留痕进界面：「最近导出（1）」+ 行标内部版 + 人月数就是服务端 payload 的那个数（面板不算第二遍）',
  typeof snapRows === 'string' && snapRows.includes('最近导出（1）') && snapRows.includes('内部版')
  && mmShown.some((v) => Math.abs(v - pl0?.actualManMonths?.expected) < 0.005),
  { text: String(snapRows).replace(/\s*\n+\s*/g, ' ⏎ ').slice(-200), mm: pl0?.actualManMonths, mmShown });
ok('E-13 「本次件」标注的未复核行数 = rule+default 两条（若只数 default 会变成 1 条，与 §5.2/§9 口径不符）',
  String(snapRows).includes('内含「2 行为系统推导值，未人工复核」标注') && pl0?.unreviewed === 2,
  { text: String(snapRows).replace(/\s*\n+\s*/g, ' ⏎ ').slice(-160), unreviewed: pl0?.unreviewed });
await shot('01-export-internal-done');

console.log('\n=== 行内改值 → 客户版导出 → 只导已估算行 ===');
const M_LABEL = `${DEVM} 最可能 M（人天）`;
await ev(PE`const el=[...p().querySelectorAll('input[type="number"]')].find(i=>(i.getAttribute('aria-label')||'')===${JSON.stringify(M_LABEL)});
  if(!el) return 'missing'; el.focus(); const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
  d.set.call(el,'7.5'); el.dispatchEvent(new Event('input',{bubbles:true}));
  el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return el.value;`);
const afterPatch = await rest(`/estimates?projectId=${PID}`);
const itemA = (afterPatch.items ?? []).find((i) => i.plan_id === 'r-a');
ok('E-14 行内把 M 6→7.5 真落库（服务端 likely=7.5、source 转 manual），后续件按新值出数',
  itemA && itemA.likely === 7.5 && itemA.source === 'manual', itemA);
await idle('E-14');
const n1 = exportReqs().length;
await ev(setAudience(true));
await ev(EXP);
await until(`window.__dl.length>1 ? 1 : ''`, 30_000);
const req2 = exportReqs()[n1];
ok('E-15 客户版导出：radio 选择真的进 query（audience=client）', !!req2 && /audience=client/.test(req2.url) && req2.status === 200, req2);
const snapList1 = await rest(`/estimates/snapshots?projectId=${PID}`);
const srvName2 = (snapList1.snapshots ?? [])[0]?.filename; // 倒序：第 0 行就是刚出的客户版
const dl2 = await ev(DL_INFO);
ok('E-16 客户版件名带「-客户版-」，且同样与快照行 filename 一致',
  /^工作量评估-客户版-T02043-导出区走查-\d{8}-\d{6}\.xlsx$/.test(String(srvName2 ?? '')) && dl2?.[1]?.name === srvName2,
  { dl2, srvName2 });
const snapText1 = await until(PE`const r=rg(); return r.innerText.includes('最近导出（2）') ? r.innerText : '';`, 20_000);
ok('E-17 快照两行分别标「客户版 / 内部版」（两种受众都留痕，读者能分清哪份发给了客户）',
  String(snapText1).includes('客户版') && String(snapText1).includes('内部版'), String(snapText1).replace(/\s*\n+\s*/g, ' ⏎ ').slice(-200));
const n2 = exportReqs().length;
await ev(setOnlyEstimated(true));
await ev(EXP);
await until(`window.__dl.length>2 ? 1 : ''`, 30_000);
const req3 = exportReqs()[n2];
ok('E-18 「只导已估算行」勾选真的进 query（scope=estimated_only）',
  !!req3 && /scope=estimated_only/.test(req3.url) && req3.status === 200, req3);
const snapState1 = await ev(snapState);
ok('E-19 三条快照各有勾选框（导出区共 1 枚 scope + 3 枚勾选）——勾选是逐条而非区间',
  snapState1?.n === 3, snapState1);
const created = (await rest(`/estimates/snapshots?projectId=${PID}`)).snapshots.map((s) => s.created_at);
ok('E-19b 三条快照时间戳互不相同（界面倒序与勾选配对不靠运气）', new Set(created).size === 3, created);
await ev(setOnlyEstimated(false));
await shot('02-three-snapshots');

console.log('\n=== §7 两条对比在界面上出数 ===');
await ev(pickSnap(2)); // 最早一条（内部版，改值前）
await ev(pickSnap(1)); // 客户版（改值后）
const picked = await ev(snapState);
ok('E-20 勾选两条后出现「对比所选两条」入口',
  picked?.picked?.[2] === true && picked?.picked?.[1] === true && picked?.picked?.[0] === false
  && await ev(PE`return [...rg().querySelectorAll('button')].some(b=>b.textContent.includes('对比所选两条')) ? 1 : '';`),
  picked);
await ev(PE`const b=[...rg().querySelectorAll('button')].find(x=>x.textContent.includes('对比所选两条'));b.click();return 1;`);
/** 差异面板每行是两个 flex item（阶段名 / 差值），按 DOM 结构化读取——不靠 innerText 的换行位置 */
const diffRead = PE`const g=rg().querySelector('[aria-label="两次导出差异"]'); if(!g) return '';
  return { header: g.children[0]?g.children[0].textContent.trim():'',
    rows: [...g.children].filter(el=>el.querySelectorAll('span').length>=2).map(el=>[...el.children].map(c=>c.textContent.trim())) };`;
const diff0 = await until(diffRead, 25_000);
const rowFor = (re) => (diff0?.rows ?? []).find((r) => re.test(r[0]));
const D_E = (3 + 4 * 7.5 + 9) / 6 - (3 + 4 * 6 + 9) / 6; // 手算 = 1 人天
const D_MM = (D_E / 20.83) * 1.23;
const nums = (s) => (String(s ?? '').match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
const devCell = rowFor(/开发\/研发/);
const devNum = nums(devCell?.[1])[0];
ok('E-21 逐阶段 Δ 出数且与手算一致：开发/研发 +1 人天（改 M 6→7.5 的 E 差），正号写在脸上',
  !!devCell && Math.abs((devNum ?? NaN) - D_E) < 0.005 && String(devCell[1]).includes('+'), { devCell, D_E });
ok('E-22 其余阶段差值为 0（只动了 dev，界面不给别的行造变化）',
  (diff0?.rows ?? []).filter((r) => /需求分析|系统设计|实施|公共|现场/.test(r[0])).every((r) => nums(r[1])[0] === 0),
  diff0?.rows);
const totalCell = rowFor(/实际预估人月/);
const totalNum = nums(totalCell?.[1])[0];
ok('E-23 「实际预估人月」合计差 = Δ人天 ÷ 每人月工天标准 × (1+Σ系数) ≈ 0.06，且带正号（报价涨了要说清）',
  Math.abs((totalNum ?? NaN) - D_MM) < 0.005 && String(totalCell?.[1] ?? '').includes('+'), { totalCell, D_MM });
const snapAll = (await rest(`/estimates/snapshots?projectId=${PID}&limit=20`)).snapshots;
const cmpRest = await rest(`/estimates/snapshots?projectId=${PID}&limit=20&compare=${encodeURIComponent(`${snapAll[2].id},${snapAll[1].id}`)}`);
const srvDev = (cmpRest.compare?.diff?.phases ?? []).find((p) => p.phase === 'dev');
const srvTotal = cmpRest.compare?.diff?.totals?.actualManMonths;
ok('E-24 界面数字与服务端 compare 响应同源（同一份 diff，面板不自己算差值）',
  Math.abs((srvDev?.expected?.delta ?? NaN) - D_E) < 1e-9 && Math.abs((srvTotal ?? NaN) - D_MM) < 1e-6,
  { srvDev, srvTotal });
await shot('03-snapshot-compare');
await ev(pickSnap(0));
const picked3 = await ev(snapState);
ok('E-25 第三条勾选挤掉最早一条（至多两条，不给「先取消再选」的额外步骤）',
  picked3?.picked?.[0] === true && picked3?.picked?.[2] === false, picked3);

console.log('\n=== §5.2 行内错误态：导出禁用 ===');
const P_LABEL = `${DEVM} 悲观 P（人天）`;
await ev(PE`const el=[...p().querySelectorAll('input[type="number"]')].find(i=>(i.getAttribute('aria-label')||'')===${JSON.stringify(P_LABEL)});
  if(!el) return 'missing'; el.focus(); const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
  d.set.call(el,'1'); el.dispatchEvent(new Event('input',{bubbles:true}));
  el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return el.value;`);
const errRegion = await until(PE`const a=p()&&p().querySelector('[aria-label="行内录入错误提示"]');return a?a.innerText:'';`, 20_000);
ok('E-26 录入 P<O 被服务端拒（400）后行内错误条点名该行',
  String(errRegion ?? '').includes(DEVM), { errRegion: String(errRegion).slice(0, 160) });
const badReq = netLog.filter((n) => /r-a/.test(n.url) && n.status === 400).length;
ok('E-26b 拒绝发生在服务端（面板不本地判 O≤M 就当通过）', badReq >= 1, badReq);
const disState = await ev(PE`const b=rg().querySelector('[aria-label="导出 Excel 文件"]');return {dis:b.disabled,title:b.title};`);
ok('E-27 错误态下导出按钮 disabled，title 说明「导出禁用」', disState?.dis === true && /导出禁用/.test(String(disState?.title)), disState);
await shot('04-rowerror-export-disabled');
const nBefore = exportReqs().length;
await ev(EXP);
await sleep(1_200);
ok('E-28 禁用期间点按钮不产生任何 export-xlsx 请求（禁用是真禁用，不是灰个颜色）',
  exportReqs().length === nBefore, { before: nBefore, after: exportReqs().length });
await ev(PE`const el=[...p().querySelectorAll('input[type="number"]')].find(i=>(i.getAttribute('aria-label')||'')===${JSON.stringify(P_LABEL)});
  el.focus(); const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
  d.set.call(el,'9'); el.dispatchEvent(new Event('input',{bubbles:true}));
  el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return 1;`);
ok('E-29 改回合法值后错误条消失、导出按钮恢复可用（错误态不粘在界面上）',
  await until(PE`const a=p().querySelector('[aria-label="行内录入错误提示"]');
    const b=rg().querySelector('[aria-label="导出 Excel 文件"]');
    return !a && b.disabled===false ? 1 : '';`, 25_000));

console.log('\n=== 视口与健壮性 ===');
ok('E-30 三档视口（1920/1440/1200）导出区无横向滚动、按钮仍在', await (async () => {
  const res = [];
  for (const w of [1920, 1440, 1200]) {
    await setViewport(w, 1000);
    res.push(await ev(PE`const r=rg();
      return { w:${w}, wide: r.scrollWidth - r.clientWidth > 1, btn: !!r.querySelector('[aria-label="导出 Excel 文件"]') };`));
  }
  return res.every((r) => r && !r.wide && r.btn);
})());
await setViewport(1100, 1000);
ok('E-31 <1200px 覆盖式下面板与导出区照常可用（§10-13 挤压复验）',
  await until(PE`const d=[...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find(x=>x.innerText.includes('实际预估人月'));
    return d && d.querySelector('[aria-label="估算导出区"]')
      ? { btn: !!d.querySelector('[aria-label="导出 Excel 文件"]'), wide: d.querySelector('[aria-label="估算导出区"]').scrollWidth - d.querySelector('[aria-label="估算导出区"]').clientWidth > 1 } : '';`, 15_000)
    .then((r) => !!r && r.btn && !r.wide));
await shot('05-export-overlay-1100');
await setViewport(1920, 1000);
ok('E-32 全程页面无 JS 异常', (await ev(`(window.__errs||[]).length`)) === 0, await ev(`(window.__errs||[]).slice(-3)`));
ok('E-33 导出/快照接口无 5xx，服务日志无 estimates 异常',
  netLog.filter((n) => /export-xlsx|snapshots/.test(n.url)).every((n) => n.status === 200)
  && !/estimates.*(500|异常|Error)/i.test(serverLog.join('')),
  netLog.filter((n) => /export-xlsx|snapshots/.test(n.url)).slice(-4));

console.log(`\n结果：PASS=${pass} FAIL=${fail}｜截图：${shotFiles.join('、') || '无'}`);
process.exit(fail === 0 ? 0 : 1);
