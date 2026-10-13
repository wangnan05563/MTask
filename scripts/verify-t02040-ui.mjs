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
 * 用法（Chrome 用系统安装版；本仓内置 Browser 无视口不能点击/截图，见 memory）：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02040-ui.mjs
 *   环境变量：T02040_UI_PORT（默认 39933）、T02040_UI_CDP（默认 9343）
 *
 * 隔离纪律（skill 红线 8）：MTask_DATA_DIR 指临时目录、端口自配，不碰生产库与用户实例；
 * 退出连 Chrome 子进程树一起回收（taskkill /T），截图落 .t02040-shots/。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02040-ui-'));
const CHROME_PROFILE = mkdtempSync(join(tmpdir(), 't02040-ui-chrome-'));
const SHOTS = join(ROOT, '.t02040-shots');
const PORT = Number(process.env.T02040_UI_PORT ?? 39933);
const CDP = Number(process.env.T02040_UI_CDP ?? 9343);
const CHROME = process.env.T02040_UI_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra).toString().slice(0, 320)}` : ''}`);
  }
};

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
const cleanup = () => {
  if (process.env.T02040_UI_KEEP) return;
  // 回收是 taskkill 异步杀的：库文件可能还被上一秒的服务进程占着，重试几轮再认输（不影响结论）
  for (const dir of [DATA_DIR, CHROME_PROFILE]) {
    for (let i = 0; i < 8; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break; } catch { sleepSync(i); }
    }
  }
};
const sleepSync = (i) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300 * (i + 1)); };
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
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Network.responseReceived' && /\/api\/estimates/.test(m.params.response.url)) {
    netLog.push({ rid: m.params.requestId, url: m.params.response.url.replace(/^https?:\/\/[^/]+/, ''), status: m.params.response.status });
  }
  if (m.method === 'Network.loadingFinished' && netBodies.size < 40) {
    send('Network.getResponseBody', { requestId: m.params.requestId }).then((r) => {
      const body = r.result?.body;
      if (body) netBodies.set(m.params.requestId, body.slice(0, 300));
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
      shotFiles.push(`${name}.png`);
      return file;
    }
    await sleep(700);
  }
  return '';
}

// 面板根节点：停靠态是 aside，<1200px 是覆盖式 dialog（与 e4-ui 同一取法）
const PJ = `const p=()=>document.querySelector('aside[aria-label="估算面板"]')||[...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find(d=>d.innerText.includes('实际预估人月'));`;
/** 面板内求值统一套 IIFE：`PJ` 只是 `p()` 的定义，裸 `return` 交给 Runtime.evaluate 是语法错误 */
const PE = (strings, ...exprs) => {
  let body = strings[0];
  exprs.forEach((e, i) => { body += String(e) + strings[i + 1]; });
  return `(() => { ${PJ}${body} })()`;
};
const inP = (label) => `[...p().querySelectorAll('input[type="number"]')].find(i=>(i.getAttribute('aria-label')||'')===${JSON.stringify(label)})`;
const point = (title, field) => `${title} ${field}（人天）`;
/** 点面板里的按钮（按可见文案），返回执行结果字符串 */
const clickBtn = (text) => `(() => { ${PJ}const b=[...p().querySelectorAll('button')].find(x=>x.textContent.trim().includes(${JSON.stringify(text)})); if(!b) return 'nobtn'; b.click(); return 'clicked'; })()`;
const val = (label) => PE`const el=${inP(label)};return el?el.value:'missing';`;
const rest = async (path) => (await fetch(`${BASE}/api${path}`)).json();
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
ok('U-02 页面加载完成（桌面 UI）',
  await until(`[...document.querySelectorAll('button')].some(x=>x.textContent.trim()==='项目管理')`), 'nav 按钮缺失');
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '项目管理'); b?.click(); return 1; })()`);
await setViewport(1920, 1000);
ok('U-03 估算面板已打开（会话态种入开键，走查专注写路径）',
  await until(PE`return !!p();`), '面板未出现');
const sumText = () => ev(PE`return p().innerText.slice(0,400);`);

// ---------------- 4) 空态 + 行内录入首次落库（§10-3） ----------------
ok('U-04 空态：无估算行时给出「按规则推导」入口（不骗人说已有值）',
  await until(PE`return p().innerText.includes('尚未录入估算');`));
const sumBefore = await sumText();
await ev(clickBtn('全选可见'));
const selCount = await until(PE`return (p().innerText.match(/已选 (\\d+) 行/)||['',''])[1];`);
ok('U-05 「全选可见」作用域=4 条普通计划（里程碑行不参与批量填充）', String(selCount) === '4', selCount);

// 行内编辑：聚焦 → 原生赋值 + input 事件（React 受控框只有走原生 setter 才收到 onChange）→ Enter
async function typePoint(title, field, v) {
  const label = point(title, field);
  const s1 = await ev(`(() => { ${PJ}const el=${inP(label)}; if(!el) return 'missing'; el.focus(); return 'focused'; })()`);
  await sleep(150);
  const s2 = await ev(`(() => { ${PJ}const el=${inP(label)}; const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
    d.set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value; })()`);
  await sleep(200);
  const s3 = await ev(`(() => { ${PJ}const el=${inP(label)}; el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return 'sent'; })()`);
  return { s1, s2, s3 };
}
const typed = await typePoint('需求分析', '最可能 M', '4');
ok('U-06 三列是真正的 input[type=number]（受控框可聚焦、可输入、值回显）', typed.s1 === 'focused' && typed.s2 === '4' && typed.s3 === 'sent', typed);
const itemAfterPatch = await until(`(async () => { const r = await fetch('${BASE}/api/estimates?projectId=${PID}'); const j = await r.json(); return j.items.find(i=>i.plan_id==='u-cx') || null; })()`, 20_000);
ok('U-07 建议行首次落库：M=4 且 O/P 继承推导值（3.5/5.5=3.5×1.6 落 0.5 网格，面板不猜数、由服务端建行）',
  itemAfterPatch && itemAfterPatch.likely === 4 && itemAfterPatch.optimistic === 3.5 && itemAfterPatch.pessimistic === 5.5,
  itemAfterPatch);
if (!itemAfterPatch) await diag('U-07');
ok('U-07b 人工改过即转 manual：PATCH 不给 source 也由服务端补（复核率按它出数）',
  itemAfterPatch && itemAfterPatch.source === 'manual' && itemAfterPatch.phase === 'req', itemAfterPatch);
const sumAfterPatch = await until(PE`return p().innerText.includes('直接投入') && p().innerText.slice(0,400)!==${JSON.stringify(sumBefore)} ? p().innerText.slice(0,400) : '';`, 20_000);
ok('U-08 改值即时刷新：汇总卡读数随服务端重算变了（面板没有本地一套 E）', typeof sumAfterPatch === 'string' && sumAfterPatch !== '' && sumAfterPatch !== sumBefore,
  { before: String(sumBefore).slice(0, 120), after: String(sumAfterPatch).slice(0, 120) });
const badgeUcx = await until(PE`const row=[...p().querySelectorAll('input[type="number"]')].find(i=>(i.getAttribute('aria-label')||'').startsWith('需求分析 ')); const box=row?row.parentElement.parentElement:p(); return box.innerText.includes('人工')||'';`, 20_000);
ok('U-08b 该行徽标从「默认·复杂度」转为「人工」（重取的是响应，不是内存态）', badgeUcx === true, badgeUcx);
if (badgeUcx !== true) await diag('U-08b');

// ---------------- 5) 刷新后仍在（§10-3 落库口径） ----------------
await send('Page.navigate', { url: `${BASE}/?m=0` });
await until(`[...document.querySelectorAll('button')].some(x => x.textContent.trim() === '项目管理')`, 25_000);
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '项目管理'); b?.click(); return 1; })()`);
await setViewport(1920, 1000);
const valAfterReload = await until(PE`const el=${inP(point('需求分析', '最可能 M'))};return el&&el.value==='4'?1:'';`, 25_000);
ok('U-09 刷新重进后 M 仍是 4：行内录入真落库（不是面板会话内的临时态）', valAfterReload === 1, valAfterReload);
await shot('01-panel-inline-edit');

// ---------------- 6) O>M：行内标红 + 底部提示条，且原值不动（§10-4） ----------------
const badType = await typePoint('需求分析', '乐观 O', '99');
const redInfo = await until(PE`const el=${inP(point('需求分析', '乐观 O'))};
  if(!el) return ''; const border=(el.getAttribute('style')||'')+'|'+getComputedStyle(el).borderTopColor;
  const text=p().innerText.includes('不满足录入校验'), msg=p().innerText.includes('不能大于最可能值');
  if (!text || !msg) return ''; return { styled: border.includes('danger') || !border.endsWith('|'), text, msg };`, 20_000);
ok('U-10 被拒的行内联标红 + 底部「N 行不满足录入校验（O≤M≤P），导出前须修正」+ 逐行点名服务端文案',
  redInfo && redInfo.text === true && redInfo.msg === true, { badType, redInfo });
if (!(redInfo && redInfo.text)) await diag('U-10');
ok('U-10b 红色来自 var(--danger)（样式与主题变量单源，不硬编码色值）',
  redInfo && redInfo.styled === true, redInfo);
const stillThere = await rest(`/estimates?projectId=${PID}`);
const ucxRow = stillThere.items.find((i) => i.plan_id === 'u-cx');
ok('U-10c 被拒后库里分毫未动（O 仍 3.5、M 仍 4）——判据只有一份，前端不预筛',
  !!ucxRow && ucxRow.optimistic === 3.5 && ucxRow.likely === 4, ucxRow);
const afterReject = await ev(PE`const el=${inP(point('需求分析', '乐观 O'))};return el?el.value:'missing';`);
ok('U-10d 输入框保留用户刚打的 99（不静默吞掉被拒值，也不回填成旧数骗人）', afterReject === '99', afterReject);
await shot('02-reject-o-gt-m');
// 还原成合法值：错误态应随写入成功自动消掉
await typePoint('需求分析', '乐观 O', '3.5');
const cleared = await until(PE`return !p().innerText.includes('不满足录入校验') || '';`, 20_000);
ok('U-11 改回合法值后错误条消失（错误态不是常驻装饰）', cleared === true, cleared);

/** 面板批量按钮在请求在途（busy）时是禁用的：不等空闲就点，等于点了个密寇 */
const idle = async (tag) => {
  const v = await until(PE`const i=[...p().querySelectorAll('input[type="number"]')]; return i.length > 0 && i.every((x) => !x.disabled) ? 1 : '';`, 25_000);
  if (v !== 1) await diag(tag);
  return v;
};

// ---------------- 7) 批量按规则推导：预览行数=写入行数 + 撤销（§10-5） ----------------
await idle('U-12');
await ev(clickBtn('全选可见'));
await until(PE`return /已选 [1-9]/.test(p().innerText) ? 1 : '';`);
await ev(clickBtn('按用例加权重推'));
const confirmText = await until(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || '') === '确定：确认执行该操作');
  if (!b) return '';
  const box = b.closest('[role="dialog"]') || (b.parentElement && b.parentElement.parentElement);
  return box ? box.innerText : '';
})()`);
ok('U-12 批量填充走 askConfirm（项目对话框，非原生 confirm）+ 文案点明可写行数与跳过原因',
  typeof confirmText === 'string' && confirmText.includes('1 行可写入') && confirmText.includes('不属于该档'),
  (confirmText || '').slice(0, 240));
if (!confirmText) await diag('U-12');
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || '') === '确定：确认执行该操作'); b?.click(); return !!b; })()`);
ok('U-13 确认后 toast 报实际写入行数（与服务端 written 同源）',
  await until(`document.body.innerText.includes('已按用例加权重推写入 1 行')`, 20_000));
ok('U-13c 点击真的打到了批量接口（POST /api/estimates/batch 200）——按钮有文案没接线这类问题只有网络层看得见',
  netLog.some((n) => n.url.includes('/estimates/batch') && n.status === 200), netLog.slice(-6));
const caseItem = await rest(`/estimates?projectId=${PID}`);
const uCase = caseItem.items.find((i) => i.plan_id === 'u-case');
ok('U-13b 被写的只有自然择档为用例档的行（u-case），其余三行不因「换个档硬凑」而落库',
  uCase && caseItem.items.length === 2, { written: uCase && [uCase.optimistic, uCase.likely, uCase.pessimistic], all: caseItem.items.map((i) => i.plan_id) });
ok('U-14 顶部出现撤销条「已填充 N 行 · 撤销」（§5.3 原文口径）',
  await until(PE`return !!p().querySelector('[aria-label="批量填充撤销条"]') && p().innerText.includes('已填充 1 行 · 撤销') || '';`, 20_000));
await ev(`(() => { ${PJ}const b=[...p().querySelectorAll('button')].find(x=>x.textContent.trim().startsWith('撤销')); b?.click(); return !!b; })()`);
ok('U-15 点撤销：原态无估算行的按删除回滚（toast 如实报「还原/删除」两条通道）',
  await until(`document.body.innerText.includes('已撤销')`, 20_000));
const afterUndo = await rest(`/estimates?projectId=${PID}`);
ok('U-15b 撤销后只剩 u-cx 一行，u-case 回到「建议值」态（未落库）',
  afterUndo.items.length === 1 && afterUndo.items[0].plan_id === 'u-cx', afterUndo.items.map((i) => i.plan_id));
await shot('03-batch-derive-undo');

// ---------------- 8) 统一值模式 + 撤销还原 source ----------------
await idle('U-16');
await ev(clickBtn('全选可见'));
await until(PE`return /已选 [1-9]/.test(p().innerText) ? 1 : '';`);
await ev(clickBtn('统一值'));
const uniformForm = await until(PE`return !!p().querySelector('[aria-label="统一值批量填充表单"]');`);
ok('U-16 「统一值…」展开表单（M + 两个倍率，倍率预填服务端 ruleRatio）', uniformForm === true, uniformForm);
const mulPrefill = await ev(PE`const els=[...p().querySelectorAll('[aria-label="统一值批量填充表单"] input[type="number"]')];
  return { m: els[0]?.value, oMul: els[1]?.value, pMul: els[2]?.value };`);
const cfgMeta = await rest(`/estimates?projectId=${PID}`);
ok('U-16b 倍率预取自动态参数（1 / 1.6），面板不内置一套经验值',
  mulPrefill.oMul === String(cfgMeta.params.config.ruleRatio.oMul) && mulPrefill.pMul === String(cfgMeta.params.config.ruleRatio.pMul),
  { mulPrefill, ratio: cfgMeta.params.config.ruleRatio });
const setUniform = await ev(PE`const els=[...p().querySelectorAll('[aria-label="统一值批量填充表单"] input[type="number"]')];
  const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
  const row=[els[0],els[1],els[2]]; const want=['3','0.8','1.4'];
  row.forEach((el,i)=>{ d.set.call(el, want[i]); el.dispatchEvent(new Event('input',{bubbles:true})); });
  return p().innerText.includes('O 2.5 / M 3 / P 4') ? 'preview-ok' : 'preview-missing';`);
ok('U-17 表单实时预览三点（M=3、倍率 0.8/1.4 → O 2.5 / M 3 / P 4，落 0.5 网格）', setUniform === 'preview-ok', setUniform);
await ev(`(() => { ${PJ}const b=[...p().querySelectorAll('button')].find(x=>x.textContent.includes('写入 4 行')); b?.click(); return !!b; })()`);
const uniConfirm = await until(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || '') === '确定：确认执行该操作');
  if (!b) return '';
  const box = b.closest('[role="dialog"]') || (b.parentElement && b.parentElement.parentElement);
  return box ? box.innerText : '';
})()`);
ok('U-18 统一值确认文案点明「转人工」并给出三点（覆盖是有意识的动作，不是静默改写）',
  typeof uniConfirm === 'string' && uniConfirm.includes('O 2.5 / M 3 / P 4') && uniConfirm.includes('转「人工」'),
  (uniConfirm || '').slice(0, 200));
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || '') === '确定：确认执行该操作'); b?.click(); return !!b; })()`);
ok('U-18b 批量写入 4 行（含覆盖人工行的统一值场景）',
  await until(`document.body.innerText.includes('已填充 4 行')`, 20_000));
const uniVals = await ev(PE`const want=['需求分析','系统设计','开发联调','测试执行'];
  return want.map(t=>{ const els=[...p().querySelectorAll('input[type="number"]')].filter(i=>(i.getAttribute('aria-label')||'').startsWith(t+' '));
    return els.map(e=>e.value); });`);
ok('U-19 四行的三点都变成 2.5/3/4（面板把服务端写入值重取上屏，不是本地填的假数）',
  uniVals.length === 4 && uniVals.every((v) => v.join('/') === '2.5/3/4'), uniVals);
await ev(`(() => { ${PJ}const b=[...p().querySelectorAll('button')].find(x=>x.textContent.trim().startsWith('撤销')); b?.click(); return !!b; })()`);
ok('U-20 撤销统一值：1 行按快照还原（含 source 回到 manual），3 行新建估算按删除回滚',
  await until(`document.body.innerText.includes('还原 1 行，删除 3 行新建估算')`, 20_000));
const backUcx = (await rest(`/estimates?projectId=${PID}`)).items.find((i) => i.plan_id === 'u-cx');
ok('U-20b 还原后的三点=写入前快照（3.5/4/5.5）、来源仍是 manual、阶段仍是 req',
  backUcx && backUcx.optimistic === 3.5 && backUcx.likely === 4 && backUcx.pessimistic === 5.5 && backUcx.source === 'manual' && backUcx.phase === 'req',
  backUcx);
await shot('04-uniform-undo');

// ---------------- 9) 只看未复核筛选 + 里程碑不参与 ----------------
await ev(clickBtn('取涁'));
const filterOn = await ev(PE`const l=[...p().querySelectorAll('label')].find(x=>x.textContent.includes('只看未复核'));
  const before=[...p().querySelectorAll('input[type="number"]')].filter(i=>(i.getAttribute('aria-label')||'').includes('（人天）')).length;
  const cb=l.querySelector('input[type="checkbox"]'); cb.click();
  return { before };`);
const afterFilter = await until(PE`return [...p().querySelectorAll('input[type="number"]')].filter(i=>(i.getAttribute('aria-label')||'').includes('（人天）')).length;`, 15_000);
ok('U-21 「只看未复核」把已复核（manual）行摘出列表：12 个数字格 → 9 个（其余三行仍是建议值）',
  filterOn.before === 12 && afterFilter === 9, { before: filterOn.before, after: afterFilter });
await ev(PE`const l=[...p().querySelectorAll('label')].find(x=>x.textContent.includes('只看未复核')); l.querySelector('input[type="checkbox"]').click(); return 1;`);
await until(PE`return [...p().querySelectorAll('input[type="number"]')].filter(i=>(i.getAttribute('aria-label')||'').includes('（人天）')).length===12?'1':''`, 15_000);
const msGuard = await ev(PE`const t=p().innerText; const inputs=[...p().querySelectorAll('input[type="number"]')].filter(i=>(i.getAttribute('aria-label')||'').includes('（人天）'));
  return { milestoneInHeader: t.includes('不进 Σ'), msInput: inputs.some(i=>(i.getAttribute('aria-label')||'').startsWith('M-A')),
    allEnabled: inputs.every(i=>!i.disabled), n: inputs.length };`);
ok('U-22 里程碑只在组头显示「不进 Σ」，不给可写格子；其余 12 格都可编辑（红线一在 UI 层同样成立）',
  msGuard.milestoneInHeader === true && msGuard.msInput === false && msGuard.allEnabled === true && msGuard.n === 12, msGuard);

// ---------------- 10) 窄视口：写路径新增的工具条不撑破覆盖式（§10-13 回归） ----------------
await setViewport(1100, 900);
const narrow = await until(PE`if(!p()) return ''; const a=p(); const leaves=[...a.querySelectorAll('*')].filter(e=>!e.children.length && e.textContent.trim());
  const de=document.documentElement; return { overlay: !document.querySelector('aside[aria-label="估算面板"]') && !!a.closest('[role="dialog"]'),
    panelHScroll: a.scrollWidth > a.clientWidth + 1, hScroll: de.scrollWidth > de.clientWidth + 1,
    clipped: leaves.filter(e=>e.scrollWidth > e.clientWidth + 1).map(e=>e.textContent.trim().slice(0,20)),
    toolbar: !!a.querySelector('[aria-label="估算批量填充工具条"]') };`, 20_000);
ok('U-23 覆盖式下面板仍无横向滚动、无文字截断，工具条随抽屉一起收窄',
  narrow && narrow.overlay && !narrow.panelHScroll && !narrow.hScroll && narrow.clipped.length === 0 && narrow.toolbar, narrow);
await shot('05-overlay-narrow');
await setViewport(1920, 1000);
const logCheck = await rest(`/estimates?projectId=${PID}`);
ok('U-24 走查收尾：估算行仍只 1 条（所有伪写入都被撤销），明细可读',
  logCheck.items.length === 1 && Array.isArray(logCheck.summary.rowRatios), { items: logCheck.items.length });
ok('U-25 走查截图取证齐全（行内录入/被拒标红/批量撤销/统一值撤销/覆盖式）', shotFiles.length === 5, shotFiles);

ws.close();
bye();
cleanup();
console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
