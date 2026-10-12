#!/usr/bin/env node
/**
 * T02044（估算视图 §5.2 第 4 段「导出区」· E7 PDF）真机走查：CDP 驱动 headless Chrome 打开**隔离实例**
 * 的估算面板，只断言「非真实浏览器不能回答」的问题：
 *   ① 两枚 PDF 按钮（§5.2 原文形态：内部版/客户版各一枚，不是靠 radio 表达）真的各自发出一次
 *      GET /api/estimates/export-pdf，且 query 里的 audience 各归各（internal / client）；
 *   ② 下载体是真 PDF（%PDF 魔数 + %%EOF + application/pdf + 体积），件名逐字等于服务端写进快照的 filename
 *      ——前端没有第二套命名口径（§6.3）；
 *   ③ §10-9「一次出两版对照」：连续点两枚按钮出两份件，两版件名互为「-客户版-」关系、
 *      各自写一条快照，且快照里的报价数相同（脱敏藏依据、不改报价）；
 *   ④ §5.2「有行未通过校验 → 导出禁用」对 PDF 两枚同样成立，禁用期间点不出请求；
 *   ⑤ 导出中（exporting）三枚按钮一起禁用且「导出中…」只标在被点的那枚上（共用一条并发闸）；
 *   ⑥ 裁决 D4 的「PDF 为预览件，正式交付以 Excel 为准」这句在界面上（不只在 PRD 里）；
 *   ⑦ PDF 与 xlsx 都进「最近导出」列表，两种 format 的留痕在同一处可读；
 *   ⑧ 三档视口与 <1200px 覆盖式下新增的第二行按钮不撑出横向滚动。
 *
 * 用法（Chrome 用系统安装版；本仓内置 Browser 无视口不能点击/截图，见 memory）：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02044-ui.mjs
 *   环境变量：T02044_UI_PORT（默认 39938）、T02044_UI_CDP（默认 9348）
 *
 * 隔离纪律（skill 红线 8）：MTask_DATA_DIR 指临时目录、端口自配，不碰生产库与用户实例；
 * 下载在页面内拦截（不写盘），截图落 .t02044-shots/。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02044-ui-'));
const CHROME_PROFILE = mkdtempSync(join(tmpdir(), 't02044-ui-chrome-'));
const SHOTS = join(ROOT, '.t02044-shots');
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

// ---------------- 1) 夹具：临时库直写（进程内，起服务前完成） ----------------
process.env.MTask_DATA_DIR = DATA_DIR;
const { getDb, closeDb } = await import(pathToFileURL(join(ROOT, 'server/src/db/connection.ts')).href);
const { initSchema } = await import(pathToFileURL(join(ROOT, 'server/src/db/schema.ts')).href);
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
ok('U-00 隔离服务启动（2 条已估算 + 1 条未估算，署名已置「王南」）', serverUp);
if (!serverUp) {
  console.log(`\n—— 服务日志（${DATA_DIR}）——\n${serverLog.join('').split('\n').slice(-40).join('\n')}`);
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
const PE = (strings, ...exprs) => {
  let body = strings[0];
  exprs.forEach((e, i) => { body += String(e) + strings[i + 1]; });
  return `(() => { ${PJ}${body} })()`;
};
/** 属性选择器的引号由 JSON.stringify 给出（自己再补一个 `"` 会拼成 `""`，querySelector 抛语法错、点击静默失败） */
const PDF_BTN = (label) => {
  const sel = `[aria-label=${JSON.stringify(`导出 PDF ${label}`)}]`;
  return PE`const b=rg()&&rg().querySelector(${JSON.stringify(sel)});
    if(!b) return 'nobtn'; if(b.disabled) return 'disabled';
    b.scrollIntoView({block:'center'}); b.click(); return 'clicked:'+(b.textContent||'').trim();`;
};
const setOnlyEstimated = (on) => PE`const l=[...rg().querySelectorAll('label')].find(x=>x.textContent.trim()==='只导已估算行');
  const c=l&&l.querySelector('input[type="checkbox"]'); if(!c) return 'nochk';
  if(c.checked!==${on}) c.click(); return c.checked===${on}?'ok':'stuck';`;
const rest = async (path) => (await fetch(`${BASE}/api${path}`)).json();
const idle = async (tag) => {
  const v = await until(PE`const bs=[...rg().querySelectorAll('button')];
    return bs.length>0 && bs.every((x)=>!x.disabled) ? 1 : '';`, 25_000);
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
  console.log(`  [DIAG ${tag}] 接口请求: ${netLog.slice(-6).map((n) => `${n.status} ${n.url}`).join(' | ') || '无'}`);
}
const DL_INFO = `(() => { const out=[];
  for (let i=0;i<window.__dl.length;i++) out.push({ name: window.__dl[i], has: !!window.__blobs[i] });
  return out; })()`;
/** 读第 n 次下载的 Blob：PDF 看前 5 字节 `%PDF-`（十六进制 255044462d）+ 尾 1024 字节里要有 %%EOF */
const READ_BLOB_AT = (i) => `(async () => { const b=window.__blobs[${i}]; if(!b) return null;
  const buf=await b.arrayBuffer(); const u8=new Uint8Array(buf);
  const head=Array.from(u8.slice(0,5)).map((x)=>x.toString(16).padStart(2,'0')).join('');
  const tail=Array.from(u8.slice(-1024)).map((x)=>String.fromCharCode(x)).join('');
  return { type: b.type, size: buf.byteLength, head, eof: tail.includes('%%EOF') }; })()`;
const pdfReqs = () => netLog.filter((n) => /export-pdf/.test(n.url));

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
ok('U-02 页面加载完成（桌面 UI）',
  await until(`[...document.querySelectorAll('button')].some(x=>x.textContent.trim()==='项目管理')`), 'nav 按钮缺失');
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '项目管理'); b?.click(); return 1; })()`);
await setViewport(1920, 1000);
ok('U-03 估算面板已打开（会话态种入开键）', await until(PE`return !!p();`), '面板未出现');

console.log('\n=== §5.2 第 4 段：PDF 两枚按钮的落地形态 ===');
ok('U-04 导出区共三枚出件按钮（Excel + PDF 内部版 + PDF 客户版），PDF 各带各的受众而非共用 radio',
  await until(PE`const r=rg(); if(!r) return '';
    return { x: !!r.querySelector('[aria-label="导出 Excel 文件"]'),
      pi: !!r.querySelector('[aria-label="导出 PDF 内部版"]'),
      pc: !!r.querySelector('[aria-label="导出 PDF 客户版"]'),
      labels: [...r.querySelectorAll('button')].map((b)=>b.getAttribute('aria-label')||b.textContent.trim()) };`)
    .then((s) => s && s.x && s.pi && s.pc));
ok('U-05 裁决 D4 的「PDF 为预览件，正式交付以 Excel 为准」写在按钮旁边（不只在 PRD 里）',
  await until(PE`return rg().innerText.includes('正式交付以 Excel 为准') ? 1 : '';`, 8_000));
const tipBoth = await ev(PE`const pi=rg().querySelector('[aria-label="导出 PDF 内部版"]');
  const pc=rg().querySelector('[aria-label="导出 PDF 客户版"]');
  return { i: pi.title, c: pc.title };`);
ok('U-06 两枚 title 各自说清含/不含什么（内部版含 σ/系数分项，客户版说服务端组装阶段就不写）',
  /系数分项/.test(tipBoth?.i ?? '') && /σ/.test(tipBoth?.i ?? '')
  && /系数分项/.test(tipBoth?.c ?? '') && /报价数与内部版一致/.test(tipBoth?.c ?? ''), tipBoth);
await shot('00-pdf-buttons-initial');

console.log('\n=== 内部版 PDF：请求、真件与件名同源 ===');
const n0 = pdfReqs().length;
const click1 = await ev(PDF_BTN('内部版'));
const q1 = await until(`window.__dl.length>0 ? 1 : ''`, 40_000);
const req1 = pdfReqs()[n0];
if (!req1) {
  // 点不出请求时最缺「为什么」：按钮态、回执文案、页面报错、服务日志一次吐全
  console.log(`  [DIAG 点击回执] ${click1}`);
  console.log(`  [DIAG 按钮态] ${JSON.stringify(await ev(PE`const b=rg().querySelector('[aria-label="导出 PDF 内部版"]');return {dis:b.disabled,txt:b.textContent.trim(),cls:b.className};`))}`);
  console.log(`  [DIAG toast] ${JSON.stringify(await ev(`[...document.querySelectorAll('.flash-toast')].map(x=>x.textContent)`))}`);
  await diag('U-07');
}
ok('U-07 点「导出 PDF（内部版）」真的打到 GET /api/estimates/export-pdf 且 200 + audience=internal',
  !!q1 && !!req1 && req1.status === 200 && /[?&]audience=internal/.test(req1.url) && /[?&]scope=all/.test(req1.url), req1);
const dl1 = await ev(DL_INFO);
const snaps1 = await rest(`/estimates/snapshots?projectId=${PID}`);
const srvName1 = (snaps1.snapshots ?? [])[0]?.filename;
ok('U-08 真的触发一次下载，件名逐字等于服务端快照 filename（前端没有第二套命名）',
  dl1?.length === 1 && dl1[0].name === srvName1, { dl1, srvName1 });
ok('U-09 内部版件名符合 §6.3：工作量评估-项目名-yyyymmdd-HHMMSS.pdf',
  /^工作量评估-T02044-E7走查-\d{8}-\d{6}\.pdf$/.test(String(srvName1 ?? '')), srvName1);
const blob1 = await ev(READ_BLOB_AT(0));
ok('U-10 下载体是真 PDF（%PDF- 头 + %%EOF 尾 + application/pdf + 体积过 4KB）',
  blob1 && blob1.head === '255044462d' && blob1.eof === true
  && String(blob1.type).includes('application/pdf') && blob1.size > 4000, blob1);
ok('U-11 导出成功 toast「已导出 …pdf」用的是服务端件名',
  await until(`[...document.querySelectorAll('.flash-toast')].some(x=>/已导出 工作量评估-.*\\.pdf/.test(x.textContent)) ? 1 : ''`, 10_000));
const sn1 = (snaps1.snapshots ?? [])[0];
ok('U-12 快照留痕记 format=pdf（与界面 xlsx 记录同一张表、可事后区分两种件）',
  sn1?.format === 'pdf', { format: sn1?.format, filename: sn1?.filename });
const pl1 = typeof sn1?.payload === 'string' ? JSON.parse(sn1.payload) : sn1?.payload;
ok('U-13 内部版快照 payload 记「1 行为系统推导值未复核」（rule 口径与导出侧同源）',
  pl1?.unreviewed === 1, { unreviewed: pl1?.unreviewed });
await shot('01-internal-pdf-done');

console.log('\n=== §10-9：一次出两版对照（脱敏藏依据、不改报价数） ===');
const n1 = pdfReqs().length;
await ev(PDF_BTN('客户版'));
await until(`window.__dl.length>1 ? 1 : ''`, 40_000);
const req2 = pdfReqs()[n1];
ok('U-14 客户版按钮自带 audience=client（不跟随 radio：radio 仍是内部版）',
  !!req2 && /audience=client/.test(req2.url) && req2.status === 200
  && await ev(PE`const l=[...rg().querySelectorAll('label')].find(x=>x.querySelector('input[type="radio"]:checked'));return l?l.textContent.trim():'';`) === '内部版',
  req2);
const dl2 = await ev(DL_INFO);
const snaps2 = await rest(`/estimates/snapshots?projectId=${PID}`);
const srvName2 = (snaps2.snapshots ?? [])[0]?.filename;
ok('U-15 客户版件名带「-客户版-」且与快照行一致（同一套命名，不开第二条通道）',
  /^工作量评估-客户版-T02044-E7走查-\d{8}-\d{6}\.pdf$/.test(String(srvName2 ?? '')) && dl2?.[1]?.name === srvName2,
  { dl2, srvName2 });
const blob2 = await ev(READ_BLOB_AT(1));
ok('U-16 客户版同样是渲染完成的真 PDF（脱敏不改变件能不能打开）',
  blob2 && blob2.head === '255044462d' && blob2.eof === true && blob2.size > 3000, blob2);
const pl2 = typeof srvName2 === 'string'
  ? (() => { const s = (snaps2.snapshots ?? []).find((x) => x.filename === srvName2); const p = typeof s?.payload === 'string' ? JSON.parse(s.payload) : s?.payload; return p; })()
  : null;
const sameMoney = Math.abs((pl1?.actualManMonths?.expected ?? -1) - (pl2?.actualManMonths?.expected ?? -2)) < 1e-9;
ok('U-17 两版快照的实际预估人月逐字相同（§10-9「报价数不变」在界面出件路径上成立）',
  sameMoney && Number.isFinite(pl1?.actualManMonths?.expected), { internal: pl1?.actualManMonths, client: pl2?.actualManMonths });
ok('U-18 两版件体量不同（客户版少掉区间/系数分项/自检/备注四段），不是同一份字节的两次改名',
  (blob1?.size ?? 0) !== (blob2?.size ?? 0) && Math.abs((blob1?.size ?? 0) - (blob2?.size ?? 0)) > 300, { i: blob1?.size, c: blob2?.size });
const snapText = await until(PE`const r=rg(); return r.innerText.includes('最近导出（2）') ? r.innerText : '';`, 20_000);
ok('U-19 列表把两版 PDF 都列出来并标出版本（读者能分清哪份发给了客户）',
  String(snapText).includes('客户版') && String(snapText).includes('内部版'),
  String(snapText).replace(/\s*\n+\s*/g, ' ⏎ ').slice(-220));
await shot('02-two-pdf-versions');

console.log('\n=== §5.2 行内错误态：三枚按钮一起禁用 ===');
const P_LABEL = `${DEVM} 悲观 P（人天）`;
await ev(PE`const el=[...p().querySelectorAll('input[type="number"]')].find(i=>(i.getAttribute('aria-label')||'')===${JSON.stringify(P_LABEL)});
  if(!el) return 'missing'; el.focus(); const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
  d.set.call(el,'1'); el.dispatchEvent(new Event('input',{bubbles:true}));
  el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return el.value;`);
const errRegion = await until(PE`const a=p()&&p().querySelector('[aria-label="行内录入错误提示"]');return a?a.innerText:'';`, 20_000);
ok('U-20 录入 P<O 被服务端拒后行内错误条点名该行', String(errRegion ?? '').includes(DEVM), { errRegion: String(errRegion).slice(0, 140) });
const disState = await ev(PE`const b=rg().querySelector('[aria-label="导出 PDF 内部版"]');
  const c=rg().querySelector('[aria-label="导出 PDF 客户版"]');
  const x=rg().querySelector('[aria-label="导出 Excel 文件"]');
  return { pi:b.disabled, pc:c.disabled, x:x.disabled, ti:b.title, tc:c.title };`);
ok('U-21 错误态下 PDF 两枚与 Excel 一同 disabled（§5.2 的禁用面覆盖到 E7 新增按钮）',
  disState?.pi === true && disState?.pc === true && disState?.x === true, disState);
ok('U-22 禁用期间 title 说明的是校验未过而非「导出中」（两种禁用的成因要能区分）',
  /导出禁用/.test(String(disState?.ti ?? '')) && /导出禁用/.test(String(disState?.tc ?? '')), disState);
await shot('03-rowerror-pdf-disabled');
const nb = pdfReqs().length;
const dlBefore = (await ev(DL_INFO)).length;
await ev(PDF_BTN('内部版'));
await ev(PDF_BTN('客户版'));
await sleep(1_200);
ok('U-23 禁用期间点两枚 PDF 都不产生 export-pdf 请求、也不触发下载（禁用是真禁用）',
  pdfReqs().length === nb && (await ev(DL_INFO)).length === dlBefore,
  { reqBefore: nb, reqAfter: pdfReqs().length, dlBefore, dlAfter: (await ev(DL_INFO)).length });
await ev(PE`const el=[...p().querySelectorAll('input[type="number"]')].find(i=>(i.getAttribute('aria-label')||'')===${JSON.stringify(P_LABEL)});
  el.focus(); const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
  d.set.call(el,'9'); el.dispatchEvent(new Event('input',{bubbles:true}));
  el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return 1;`);
ok('U-24 改回合法值后三枚按钮恢复可用（错误态不粘在界面上）',
  await until(PE`const a=p().querySelector('[aria-label="行内录入错误提示"]');
    const b=rg().querySelector('[aria-label="导出 PDF 内部版"]');
    return !a && b.disabled===false ? 1 : '';`, 25_000));

console.log('\n=== 范围筛选 / 并发闸 / 视口 ===');
await ev(setOnlyEstimated(true));
const n2 = pdfReqs().length;
await ev(PDF_BTN('内部版'));
await until(`window.__dl.length>2 ? 1 : ''`, 40_000);
const req3 = pdfReqs()[n2];
ok('U-25 「只导已估算行」的勾选对 PDF 同样生效（scope=estimated_only 进 query）',
  !!req3 && /scope=estimated_only/.test(req3.url) && req3.status === 200, req3);
await ev(setOnlyEstimated(false));

// 并发闸：同时点两枚，两次请求都应发生，且「导出中…」只出现在被点的那枚
const nAll = pdfReqs().length;
await ev(PDF_BTN('内部版'));
const midState = await until(PE`const b=rg().querySelector('[aria-label="导出 PDF 客户版"]');
  const i=rg().querySelector('[aria-label="导出 PDF 内部版"]');
  return { xLoading: i.textContent.trim()==='导出中…', cDisabled: b.disabled };`, 6_000);
ok('U-26 导出中：被点的内部版按钮显示「导出中…」、另一枚 PDF 同时被并发闸禁用',
  midState?.xLoading === true && midState?.cDisabled === true, midState);
await idle('U-26');
ok('U-27 导出结束后按钮文案回到正常（并发闸会释放，不会永久卡「导出中…」）',
  await ev(PE`const b=[...rg().querySelectorAll('button')];
    return b.every((x)=>!x.textContent.includes('导出中…')) && b.filter((x)=>/导出/.test(x.textContent)).every((x)=>!x.disabled) ? 1 : '';`));
ok('U-28 全过程每次点 PDF 都对应一次请求（无重复发请求：并发闸没把两次点击合成两件）',
  pdfReqs().length === nAll + 1 && pdfReqs().slice(nAll).every((r) => r.status === 200),
  pdfReqs().slice(nAll));

ok('U-29 三档视口（1920/1440/1200）导出区无横向滚动、PDF 两枚仍在（新增第二行按钮没撑宽）', await (async () => {
  const res = [];
  for (const w of [1920, 1440, 1200]) {
    await setViewport(w, 1000);
    res.push(await ev(PE`const r=rg();
      return { w:${w}, wide: r.scrollWidth - r.clientWidth > 1,
        btn: !!r.querySelector('[aria-label="导出 PDF 客户版"]') };`));
  }
  return res.every((r) => r && !r.wide && r.btn);
})());
await setViewport(1100, 1000);
ok('U-30 <1200px 覆盖式下面板与 PDF 两枚照常可用（§10-13 挤压复验）',
  await until(PE`const d=[...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find(x=>x.innerText.includes('实际预估人月'));
    const g=d&&d.querySelector('[aria-label="估算导出区"]');
    return g ? { btn: !!g.querySelector('[aria-label="导出 PDF 内部版"]'), wide: g.scrollWidth - g.clientWidth > 1 } : '';`, 15_000)
    .then((r) => !!r && r.btn && !r.wide));
await shot('04-pdf-overlay-1100');
await setViewport(1920, 1000);
ok('U-31 全程页面无 JS 异常', (await ev(`(window.__errs||[]).length`)) === 0, await ev(`(window.__errs||[]).slice(-3)`));
ok('U-32 PDF/快照接口无 5xx，服务日志无 estimates 异常',
  netLog.filter((n) => /export-pdf|snapshots/.test(n.url)).every((n) => n.status === 200)
  && !/estimates.*(500|异常|Error)/i.test(serverLog.join('')),
  netLog.filter((n) => /export-pdf|snapshots/.test(n.url)).slice(-5));

console.log(`\n结果：PASS=${pass} FAIL=${fail}｜截图：${shotFiles.join('、') || '无'}`);
process.exit(fail === 0 ? 0 : 1);
