#!/usr/bin/env node
/**
 * T01700 竞态探针门：抽屉打开态跟随外部写入 / 编辑态草稿不被在途刷新吞掉 / 本地保存不被陈旧快照打回。
 *
 * T02293 判据落地：
 *  - 判据 1（断言打行为/产物/结构）：全程不用产品中文文案选择器。
 *    抽屉＝文档流内可见的 `div[role=dialog][aria-modal=true]` 且其文本含**夹具标题**（SlideOver 常驻挂载，
 *    关闭态靠祖先 visibility:hidden 排除）；标签页栏＝抽屉内「恰 5 个直接子 BUTTON 的 DIV」，
 *    正文＝其 nextElementSibling；查看态操作钮＝正文内层容器的**直接子** BUTTON（不能数全部后代——
 *    MarkdownContent 自带「渲染/源码/复制」工具条，后代计数会把查看态算成 3 钮，实测踩到）；
 *    编辑态＝textarea ＋同父按钮行；
 *    取消/保存不靠文案判定——**按服务端可观测效果认定**（首钮写完服务端不变，末钮使服务端等于草稿）。
 *    S7 的「不回退」用 CDP `Fetch` 响应阶段拦截**真的注入一次陈旧快照**（抓到的响应体经
 *    `Fetch.getResponseBody` 复核：含 V2 且不含 V3），再释放给页面——没有实证陈旧快照在场，
 *    该腿必须为假（旧门只「保存后刷一下」，任何刷新都返回新值，判据恒真）。
 *    「刷新/陈旧快照确实落回页面」统一由 `addScriptToEvaluateOnNewDocument` 里对 `window.fetch` 的
 *    **只读包装**记账（clone 后记录该列表响应是否含夹具标记，不改请求也不改响应）——不靠猜时间窗。
 *  - 判据 2（门内自造夹具）：自起隔离实例（D: 临时 DATA_DIR + 临时端口）+ REST 建夹具任务，
 *    不再依赖外部 39913 常驻服务与 argv <taskId>；`V0/V1/V2/草稿X/V3` 与标题都是夹具数据。
 *  - 判据 3（字面锚配对）：保留 6 组锚点（行标识 data-ttask-id、定位意图事件 mtaskFocusTask、
 *    SlideOver 模态语义、编辑态 aria-label、编辑行取消先于保存的源码顺序、fetchTasks 版本守卫）
 *    全部走 `okPair`，取证面 `git show HEAD:`（反模式 11：不读工作树）。
 *  - 判据 4（负对照）：N-01..N-07 七组（空源码、HEAD 在场、抽干实测料＋回填复原、逐锚改名自证、
 *    `okPair` 两红因契约、逐腿结构破坏反证、旧门恒真形态不复现）。
 *  - 向导遮罩不用「跳过」文案点击：`Page.addScriptToEvaluateOnNewDocument` 预种已读键；
 *    开抽屉走产品官方跨页定位意图事件 `mtaskFocusTask`（不依赖行内按钮的位置/文案）。
 *
 * 隔离纪律（skill 红线 8）：临时根全落 **D:**（C: 常年 0 可用会伪装成 SQLITE_FULL），退出连树回收；
 * 不碰生产库与 39877。
 * 用法：node scripts/verify-t01700-probe.mjs
 *   环境变量：T01700_PORT（默认 39931）、T01700_CDP（默认 9351）、T01700_CHROME
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP_ROOT = existsSync('D:/code/tmp') ? 'D:/code/tmp' : tmpdir();
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't01700-data-'));
const CHROME_PROFILE = mkdtempSync(join(TMP_ROOT, 't01700-chrome-'));
const PORT = Number(process.env.T01700_PORT ?? 39931);
const CDP = Number(process.env.T01700_CDP ?? 9351);
const CHROME = process.env.T01700_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = `http://127.0.0.1:${PORT}/api`;
const APP = `http://127.0.0.1:${PORT}`;
// 以下全部是**门内夹具数据**（临时库自建），不是产品文案
const FIX_TITLE = 'T01700 竞态探针任务';
const V0 = 'V0 原始描述';
const V1 = 'V1 外部改';
const V2 = 'V2 外部再改';
const DRAFT = '草稿X-不应落库';
const V3 = 'V3 本地保存';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { resolveServerLauncher } = await import(pathToFileURL(join(ROOT, 'scripts/isolated-server-launcher.mts')).href);
const { okPair } = await import(pathToFileURL(join(ROOT, 'scripts/lib/anchor-pair.mts')).href);

let failures = 0;
let passed = 0;
const check = (n, p, i) => {
  if (p) { passed += 1; console.log(`  [PASS] ${n}`); return; }
  failures += 1;
  console.log(`  [FAIL] ${n}${i !== undefined ? ` -> ${JSON.stringify(i).toString().slice(0, 320)}` : ''}`);
};

// 字面腿取证面固定 HEAD（反模式 11）
const headSource = (rel) => {
  try {
    return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return '';
  }
};
const TASKS_SRC = headSource('web/src/pages/TasksPage.tsx');
const SLIDE_SRC = headSource('web/src/components/SlideOver.tsx');
const DRAWER_SRC = headSource('web/src/components/TaskDetailDrawer.tsx');
const GUARD_NEEDLE = `(next.updated_at ?? '') < (cur.updated_at ?? '')`;
const ANCHORS = {
  'B-10': { src: TASKS_SRC, needle: 'data-ttask-id={t.id}', literal: (s) => /data-ttask-id=\{t\.id\}/.test(s) },
  'B-01': { src: TASKS_SRC, needle: "addEventListener('mtaskFocusTask'", literal: (s) => /addEventListener\('mtaskFocusTask'/.test(s) },
  'B-09': { src: SLIDE_SRC, needle: 'aria-modal={passthrough ? undefined : \'true\'}', literal: (s) => /role="dialog"/.test(s) && /aria-modal=\{passthrough \? undefined : 'true'\}/.test(s) },
  'B-11': { src: DRAWER_SRC, needle: 'aria-label="编辑任务描述"', literal: (s) => /aria-label="编辑任务描述"/.test(s) },
  'B-056': { src: DRAWER_SRC, needle: "void save('desc')", literal: (s) => /setEditing\(null\)[\s\S]{0,600}?void save\('desc'\)/.test(s) },
  'B-07': { src: TASKS_SRC, needle: GUARD_NEEDLE, literal: (s) => s.includes(GUARD_NEEDLE) },
};

// 运行期实测料（行为腿唯一取数面；N 组靠抽干它证明行为腿不恒真）
const EV = {
  drawerVisible: false, drawerHasFixture: false, dialogVisibleCountWhileOpen: -1,
  rowFoundByDataId: false, rowContainsFixtureTitle: false,
  viewButtonCount: -1, editRowButtonCount: -1, textareaPresent: false,
  initialDisplay: '', serverAfterCreate: '',
  followDisplay: '', serverAtFollow: '', listResponsesDuringFollow: -1,
  draftKept: false, listResponsesDuringEdit: -1, v2SnapshotDuringEdit: false, serverAtEdit: '',
  cancelClosedEditor: false, displayAfterCancel: '', serverAfterCancel: '',
  draftNeverLanded: false, cancelWritesNothing: false, saveWritesDraft: false,
  saveClicked: false, serverAfterSave: '',
  staleSnapshotConfirmed: false, staleReleased: false, staleConsumedByPage: false, displayAfterStale: '', serverAfterStale: '',
  displayAfterFresh: '', serverAfterFresh: '',
  closedAfterCloseClick: false, dialogVisibleCountAfterClose: -1,
};
const withEV = (e, fn) => {
  const saved = { ...EV };
  for (const k of Object.keys(EV)) EV[k] = undefined;
  Object.assign(EV, e);
  let r = false;
  try { r = fn() === true; } catch { r = false; }
  Object.assign(EV, saved);
  return r;
};
const has = (text, s) => typeof text === 'string' && text.includes(s);
const BEHAVIOR = [
  { id: 'B-01', label: '经官方定位意图打开详情抽屉（唯一可见模态抽屉且含夹具标题）', fn: () => EV.drawerVisible === true && EV.drawerHasFixture === true && EV.dialogVisibleCountWhileOpen === 1 },
  { id: 'B-02', label: '抽屉初始展示＝服务端初始正文（同源）', fn: () => has(EV.initialDisplay, V0) && EV.serverAfterCreate === V0 },
  { id: 'B-03', label: '抽屉打开态跟随外部写入（在途列表刷新确实落过）', fn: () => has(EV.followDisplay, V1) && !has(EV.followDisplay, V0) && EV.serverAtFollow === V1 && EV.listResponsesDuringFollow >= 1 },
  { id: 'B-04', label: '编辑态草稿不被在途刷新吞掉（含新值的快照确实落回页面、草稿逐字仍在）', fn: () => EV.draftKept === true && EV.v2SnapshotDuringEdit === true && EV.listResponsesDuringEdit >= 1 && EV.serverAtEdit === V2 },
  { id: 'B-05', label: '取消编辑：编辑器关闭、展示最新值、草稿从未落库', fn: () => EV.cancelClosedEditor === true && has(EV.displayAfterCancel, V2) && EV.serverAfterCancel === V2 && EV.draftNeverLanded === true },
  { id: 'B-06', label: '抽屉保存落库（末钮写入、首钮不写入）', fn: () => EV.saveClicked === true && EV.serverAfterSave === V3 && EV.cancelWritesNothing === true && EV.saveWritesDraft === true },
  { id: 'B-07', label: '实证陈旧快照被页面消费后展示不回退（版本守卫生效）', fn: () => EV.staleSnapshotConfirmed === true && EV.staleConsumedByPage === true && EV.staleReleased === true && has(EV.displayAfterStale, V3) && !has(EV.displayAfterStale, V2) && EV.serverAfterStale === V3 },
  { id: 'B-08', label: '释放拦截后的新鲜快照与本地保存值一致', fn: () => has(EV.displayAfterFresh, V3) && EV.serverAfterFresh === V3 },
  { id: 'B-09', label: '关闭抽屉后可见模态抽屉归零（常驻挂载靠 visibility 排除）', fn: () => EV.closedAfterCloseClick === true && EV.dialogVisibleCountAfterClose === 0 },
  { id: 'B-10', label: '行标识句柄命中夹具行（data-ttask-id 与标题同属一个 li）', fn: () => EV.rowFoundByDataId === true && EV.rowContainsFixtureTitle === true },
  { id: 'B-11', label: '描述编辑器结构：查看态恰 1 钮、编辑态 textarea＋恰 2 钮', fn: () => EV.viewButtonCount === 1 && EV.editRowButtonCount === 2 && EV.textareaPresent === true },
];

const killTree = (pid) => {
  if (!pid) return;
  try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
};
let chrome = null;
let server = null;
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  killTree(chrome?.pid);
  killTree(server?.pid);
  for (const dir of [CHROME_PROFILE, DATA_DIR]) {
    for (let i = 0; i < 8; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * (i + 1)); }
    }
  }
};
process.on('exit', cleanup);

// ---- 隔离 server + 夹具 ----
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
server = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT,
  env: { ...process.env, ...LAUNCHER.env, MTask_DATA_DIR: DATA_DIR, MTask_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout?.on('data', (b) => serverLog.push(b.toString()));
server.stderr?.on('data', (b) => serverLog.push(b.toString()));
console.log(`隔离实例启动器：${LAUNCHER.label}（端口 ${PORT}，CDP ${CDP}，临时根 ${TMP_ROOT}）`);
let serverUp = false;
for (let i = 0; i < 180; i++) {
  try { if ((await fetch(`${API}/health`)).ok) { serverUp = true; break; } } catch { /* 未就绪 */ }
  await sleep(500);
}
if (!serverUp) {
  console.log(`\n—— 服务日志（${DATA_DIR}）——\n${serverLog.join('').split('\n').slice(-40).join('\n')}`);
  check('U-00 隔离服务启动（D: 临时 DATA_DIR + 临时端口）', false);
  console.log(`\n结果：PASS=${passed} FAIL=${failures}`);
  process.exit(1);
}
check('U-00 隔离服务启动（D: 临时 DATA_DIR + 临时端口）', true);

const created = await (await fetch(`${API}/tasks`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ projectId: 'sys-inbox', title: FIX_TITLE, description: V0 }),
})).json();
check('U-01 夹具任务创建（收件箱，含初始描述）', !!created?.id && !!created?.task_no, { id: created?.id, taskNo: created?.task_no });
if (!created?.id) {
  console.log(`\n结果：PASS=${passed} FAIL=${failures}（夹具未建成，终止）`);
  process.exit(1);
}
const TASK_ID = created.id;
const TASK_NO = created.task_no;
// 抽屉需要完整任务视图（images/updated_at 等）——by-no 是本仓既有通道，比 POST 回体更全
const taskView = await (await fetch(`${API}/tasks/by-no/${encodeURIComponent(TASK_NO)}`)).json();
check('U-01b 夹具任务视图完整（images/updated_at 在场）', Array.isArray(taskView?.images) && typeof taskView?.updated_at === 'string',
  { images: Array.isArray(taskView?.images) ? taskView.images.length : typeof taskView?.images, updated_at: taskView?.updated_at });
const patchTask = async (body) => {
  const r = await fetch(`${API}/tasks/${TASK_ID}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.ok;
};
const readServer = async () => {
  const t = await (await fetch(`${API}/tasks/by-no/${encodeURIComponent(TASK_NO)}`)).json();
  return typeof t?.description === 'string' ? t.description : '';
};
EV.serverAfterCreate = await readServer();
check('U-02 服务端初始正文＝夹具 V0（判据 2：门内自建夹具）', EV.serverAfterCreate === V0, EV.serverAfterCreate);

// ---- Chrome + CDP ----
chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--no-first-run', '--disable-gpu',
  `--user-data-dir=${CHROME_PROFILE}`, 'about:blank',
], { stdio: 'ignore' });
let targets;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://127.0.0.1:${CDP}/json/list`); if (r.ok) { targets = await r.json(); break; } } catch { /* 未就绪 */ }
  await sleep(400);
}
const page = targets?.find((t) => t.type === 'page');
if (!page) {
  check('U-03 headless Chrome 与 CDP 就绪', false);
  console.log(`\n结果：PASS=${passed} FAIL=${failures}`);
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pend = new Map();
const eventHandlers = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method) for (const h of eventHandlers.get(m.method) ?? []) h(m.params ?? {});
};
const on = (method, fn) => { if (!eventHandlers.has(method)) eventHandlers.set(method, []); eventHandlers.get(method).push(fn); };
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id;
  pend.set(i, (m) => res(m.result ?? { __error: m.error?.message ?? 'CDP 错误' }));
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }))?.result?.value;
const netLogLen = async () => Number(await ev(`globalThis.__net ? globalThis.__net.log.length : -1`) ?? -1);
const netLogSince = async (from) => {
  const slice = await ev(`globalThis.__net ? globalThis.__net.log.slice(${from}) : []`);
  return Array.isArray(slice) ? slice : [];
};
check('U-03 headless Chrome 与 CDP 就绪', true);

// 页面侧 fetch 落回记账（判据「刷新确实落回过页面」的唯一取数面，也是陈旧快照被消费的实证）
const MARK_V2 = JSON.stringify(V2);
const MARK_V3 = JSON.stringify(V3);
// Fetch 响应阶段拦截：holdFirst=true 时扣留**第一条**已完成的列表响应（陈旧快照），其余放行
let holdFirst = false;
let releaseAll = false;
let held = null;
// 放行一条被扣留的响应：优先 continueResponse（原样投递缓冲体），老版本 Chrome 无此域时用捕获体 fulfill
async function passPaused(p) {
  const r = await send('Fetch.continueResponse', { requestId: p.requestId });
  if (r && r.__error !== undefined) {
    const b = await send('Fetch.getResponseBody', { requestId: p.requestId });
    if (typeof b?.body === 'string') {
      await send('Fetch.fulfillRequest', {
        requestId: p.requestId, responseCode: p.responseCode ?? 200,
        responseHeaders: p.responseHeaders ?? [{ name: 'Content-Type', value: 'application/json' }],
        body: b.base64Encoded ? b.body : Buffer.from(String(b.body), 'utf8').toString('base64'),
      });
    }
  }
}
on('Fetch.requestPaused', (p) => {
  const url = p?.request?.url ?? '';
  if (!/\/api\/tasks\?/.test(url) || !holdFirst || releaseAll || held) { void passPaused(p); return; }
  held = p;
});

await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try {
    for (const k of ['mtask.guide.seen.tasks','mtask.guide.seen.aitools','mtask.guide.seen.prompts','mtask.guide.seen.req',
      'mtask.guide.seen.report','mtask.guide.seen.history','mtask.guide.seen.queue','mtask.guide.seen.exec-sessions',
      'mtask.guide.seen.settings']) localStorage.setItem(k, '1');
    localStorage.setItem('mtask.projectGuide.seen', '1');
  } catch { /* 隐私模式：忽略 */ }
  try {
    globalThis.__net = { log: [] };
    const origFetch = globalThis.fetch;
    globalThis.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      try {
        const u = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        if (u.indexOf('/api/tasks?') >= 0) {
          p.then((res) => { res.clone().text().then((t) => {
            globalThis.__net.log.push({ hasV2: t.indexOf(${MARK_V2}) >= 0, hasV3: t.indexOf(${MARK_V3}) >= 0, len: t.length });
          }).catch(() => { globalThis.__net.log.push({ hasV2: false, hasV3: false, len: -1 }); }); }).catch(() => { /* 请求本身失败：不计 */ });
        }
      } catch { /* 记账失败不影响页面 */ }
      return p;
    };
  } catch { /* 无 fetch */ }`,
});
await send('Page.navigate', { url: APP });

// 结构句柄装入页面一次（全程不出现产品中文文案选择器；TITLE 为夹具标题）
const TITLE = JSON.stringify(FIX_TITLE);
await ev(`(() => {
  const vis = (el) => !!el && getComputedStyle(el).visibility === 'visible' && el.getClientRects().length > 0;
  globalThis.__p = {
    dialogs: () => [...document.querySelectorAll('div[role="dialog"][aria-modal="true"]')].filter(vis),
    drawer: () => globalThis.__p.dialogs().find((d) => d.textContent.includes(${TITLE})) || null,
    tabBar: () => { const d = globalThis.__p.drawer(); if (!d) return null;
      return [...d.querySelectorAll('div')].find((c) => c.children.length === 5 && [...c.children].every((x) => x.tagName === 'BUTTON')) || null; },
    body: () => { const t = globalThis.__p.tabBar(); return t && t.nextElementSibling ? t.nextElementSibling : null; },
    ta: () => { const b = globalThis.__p.body(); return b ? b.querySelector('textarea') : null; },
    editBtns: () => { const t = globalThis.__p.ta(); if (!t || !t.parentElement) return null;
      const kids = [...t.parentElement.children]; const row = kids.find((c) => c !== t && c.querySelector && c.querySelector('button'));
      return row ? [...row.querySelectorAll('button')] : null; },
    viewBtns: () => { const i = globalThis.__p.inner(); if (!i || i.querySelector('textarea')) return null;
      return [...i.children].filter((c) => c.tagName === 'BUTTON'); },
    inner: () => { const b = globalThis.__p.body(); return b ? b.firstElementChild : null; },
    readText: () => { const i = globalThis.__p.inner(); if (!i) return ''; const t = i.querySelector('textarea');
      if (t) return String(t.value); const w = i.firstElementChild;
      return w ? String(w.innerText || '') : String(i.innerText || ''); },
    counts: () => { const i = globalThis.__p.inner(); const vb = globalThis.__p.viewBtns(); const eb = globalThis.__p.editBtns();
      return { inner: !!i, textarea: !!globalThis.__p.ta(), viewBtns: vb ? vb.length : 0, editBtns: eb ? eb.length : 0,
        bodyBtnsAll: i ? i.querySelectorAll('button').length : 0 }; },
    setDraft: (txt) => { const t = globalThis.__p.ta(); if (!t) return false;
      const s = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; s.call(t, txt);
      t.dispatchEvent(new Event('input', { bubbles: true })); return globalThis.__p.ta().value === txt; },
    openEditor: () => { const bs = globalThis.__p.viewBtns(); if (!bs || bs.length !== 1) return false; bs[0].click(); return true; },
    clickEditBtn: (which) => { const bs = globalThis.__p.editBtns(); if (!bs || bs.length < 2) return 0;
      (which === 'first' ? bs[0] : bs[bs.length - 1]).click(); return bs.length; },
    closeHeaderBtn: () => { const d = globalThis.__p.drawer(); if (!d || !d.firstElementChild) return false;
      const b = d.firstElementChild.querySelector('button'); if (!b) return false; b.click(); return true; },
    focusIntent: (detail) => { globalThis.dispatchEvent(new CustomEvent('mtaskFocusTask', { detail })); return true; },
  };
  return typeof globalThis.__p.drawer === 'function';
})()`);
const handlesOk = (await ev(`typeof globalThis.__p === 'object' && typeof globalThis.__p.readText === 'function'`)) === true;

let shellReady = false;
for (let i = 0; i < 120; i++) {
  shellReady = (await ev(`!!document.querySelector('nav')`)) === true;
  if (shellReady) break;
  await sleep(250);
}
check('U-04 外壳渲染、结构句柄装载（无产品文案选择器）', shellReady && handlesOk, { shellReady, handlesOk });

// ---- 经产品官方通道开抽屉（重复派发直到监听器接管）----
const intent = JSON.stringify({ id: TASK_ID, taskNo: TASK_NO, tab: 'todo', projectId: 'sys-inbox', drawerTab: 'desc', task: taskView });
for (let i = 0; i < 15; i++) {
  await ev(`globalThis.__p.focusIntent(${intent})`);
  const open = (await ev(`!!globalThis.__p.drawer()`)) === true;
  if (open) break;
  await sleep(400);
}
EV.dialogVisibleCountWhileOpen = await ev(`globalThis.__p.dialogs().length`);
EV.drawerVisible = (await ev(`!!globalThis.__p.drawer()`)) === true;
EV.drawerHasFixture = EV.drawerVisible;
const initialRead = await ev(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 40; i++) { const t = globalThis.__p.readText(); if (t.trim().length > 0) return t; await sleep(250); }
  return globalThis.__p.readText();
})()`);
EV.initialDisplay = String(initialRead ?? '');
okPair(check, 'B-01 抽屉经 mtaskFocusTask 意图打开（字面锚：addEventListener(\'mtaskFocusTask\'·HEAD TasksPage）',
  BEHAVIOR[0].fn, () => ANCHORS['B-01'].literal(TASKS_SRC),
  () => ({ 可见模态抽屉数: EV.dialogVisibleCountWhileOpen, 正文实测: EV.initialDisplay.slice(0, 60) }));
check('B-02 抽屉初始展示＝服务端初始正文（同源，不靠文案选择器）', BEHAVIOR[1].fn(),
  { 抽屉正文: EV.initialDisplay.slice(0, 60), 服务端: EV.serverAfterCreate });

// 夹具行由行标识句柄命中（data-ttask-id 与标题同属一个 li）
const rowHit = await ev(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 50; i++) {
    const el = document.querySelector('[data-ttask-id="${TASK_ID}"]');
    if (el) { const li = el.closest('li'); if (li) return { li: true, title: li.textContent.includes(${TITLE}) }; }
    await sleep(300);
  }
  return { li: false, title: false };
})()`);
EV.rowFoundByDataId = rowHit?.li === true;
EV.rowContainsFixtureTitle = rowHit?.title === true;
okPair(check, 'B-10 行标识句柄命中夹具行（字面锚：data-ttask-id={t.id}·HEAD TasksPage）',
  BEHAVIOR[9].fn, () => ANCHORS['B-10'].literal(TASKS_SRC), () => rowHit);

// ---- S5：外部写入 → 抽屉跟随（先证明确实有列表刷新落回）----
const netBeforeFollow = await netLogLen();
await patchTask({ description: V1 });
const followed = await ev(`(async (w) => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 100; i++) {
    document.dispatchEvent(new Event('visibilitychange'));
    const t = globalThis.__p.readText();
    if (t.includes(w)) return { hit: true, text: t };
    await sleep(300);
  }
  return { hit: false, text: globalThis.__p.readText() };
})(${JSON.stringify(V1)})`);
EV.followDisplay = String(followed?.text ?? '');
await sleep(600);
EV.listResponsesDuringFollow = (await netLogLen()) - netBeforeFollow;
EV.serverAtFollow = await readServer();
check('B-03 抽屉打开态跟随外部写入（跟随期间确有列表刷新落回，非只看结果）', BEHAVIOR[2].fn(),
  { 命中: followed?.hit, 抽屉正文: EV.followDisplay.slice(0, 60), 服务端: EV.serverAtFollow, 列表响应数: EV.listResponsesDuringFollow });

// ---- S6：编辑态草稿 + 在途刷新 ----
EV.viewButtonCount = await ev(`(() => { const b = globalThis.__p.viewBtns(); return b ? b.length : -1 })()`);
const editorOpened = await ev(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 20; i++) { if (globalThis.__p.openEditor()) { for (let j = 0; j < 20; j++) { if (globalThis.__p.ta()) return true; await sleep(200); } } await sleep(200); }
  return false;
})()`);
EV.textareaPresent = editorOpened === true;
const typed = await ev(`globalThis.__p.setDraft(${JSON.stringify(DRAFT)})`);
EV.editRowButtonCount = await ev(`(() => { const b = globalThis.__p.editBtns(); return b ? b.length : -1 })()`);
okPair(check, 'B-11 描述编辑器结构：查看态恰 1 钮→编辑态 textarea＋恰 2 钮（字面锚：aria-label="编辑任务描述"·HEAD Drawer）',
  BEHAVIOR[10].fn, () => ANCHORS['B-11'].literal(DRAWER_SRC),
  () => ({ 查看态按钮数: EV.viewButtonCount, 'textarea 在场': EV.textareaPresent, 编辑行按钮数: EV.editRowButtonCount, 草稿写入生效: typed }));

const netBeforeEdit = await netLogLen();
await patchTask({ description: V2 });
// 编辑窗口内主动催几次轮询 tick（SSE 若通则更快），每次留 1.5s 让响应落回——刷新确实发生过是 B-04 的前提
for (let i = 0; i < 4; i++) {
  await ev(`document.dispatchEvent(new Event('visibilitychange'))`);
  await sleep(1500);
}
await sleep(600);
const draftState = await ev(`(() => { const t = globalThis.__p.ta(); return { v: t ? String(t.value) : null, counts: globalThis.__p.counts() } })()`);
EV.draftKept = draftState?.v === DRAFT;
EV.listResponsesDuringEdit = (await netLogLen()) - netBeforeEdit;
EV.v2SnapshotDuringEdit = (await netLogSince(netBeforeEdit)).some((e) => e && e.hasV2 === true);
EV.serverAtEdit = await readServer();
check('B-04 编辑态草稿不被在途刷新吞掉（编辑窗口内确有含新值的列表快照落回页面）', BEHAVIOR[3].fn(),
  { 'textarea 实测': draftState?.v, 列表落回数: EV.listResponsesDuringEdit, 含V2快照落回: EV.v2SnapshotDuringEdit, 服务端: EV.serverAtEdit });

// 首钮＝取消（按服务端效果认定：点击后服务端不变）
const cancelClicked = await ev(`globalThis.__p.clickEditBtn('first')`);
await sleep(1200);
const afterCancel = await ev(`(() => ({ gone: !globalThis.__p.ta(), text: globalThis.__p.readText() }))()`);
EV.cancelClosedEditor = afterCancel?.gone === true && cancelClicked === 2;
EV.displayAfterCancel = String(afterCancel?.text ?? '');
EV.serverAfterCancel = await readServer();
EV.draftNeverLanded = EV.serverAfterCancel !== DRAFT && !EV.serverAfterCancel.includes(DRAFT);
EV.cancelWritesNothing = EV.serverAfterCancel === V2;

// 末钮＝保存（按服务端效果认定：点击后服务端＝草稿文本）
await ev(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 20; i++) { if (globalThis.__p.openEditor()) { for (let j = 0; j < 20; j++) { if (globalThis.__p.ta()) return true; } } await sleep(200); }
  return false;
})()`);
await ev(`globalThis.__p.setDraft(${JSON.stringify(V3)})`);
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/tasks?*', requestStage: 'Response' }] });
holdFirst = true;
await ev(`document.dispatchEvent(new Event('visibilitychange'))`);
for (let i = 0; i < 60 && !held; i++) await sleep(300);
let staleBody = '';
if (held) {
  try {
    const r = await send('Fetch.getResponseBody', { requestId: held.requestId });
    staleBody = r?.base64Encoded ? Buffer.from(String(r.body), 'base64').toString('utf8') : String(r?.body ?? '');
  } catch { staleBody = ''; }
}
EV.staleSnapshotConfirmed = typeof staleBody === 'string' && staleBody.includes(V2) && !staleBody.includes(V3);
const saveClicked = await ev(`globalThis.__p.clickEditBtn('last')`);
for (let i = 0; i < 40; i++) { if ((await readServer()) === V3) break; await sleep(300); }
EV.saveClicked = saveClicked === 2;
EV.serverAfterSave = await readServer();
EV.saveWritesDraft = EV.serverAfterSave === V3;
okPair(check, 'B-05 取消编辑：编辑器关闭、展示最新值、草稿从未落库（字面锚：编辑行取消先于保存·HEAD Drawer）',
  BEHAVIOR[4].fn, () => ANCHORS['B-056'].literal(DRAWER_SRC),
  () => ({ 取消后编辑器关闭: afterCancel?.gone, 展示: EV.displayAfterCancel.slice(0, 60), 服务端: EV.serverAfterCancel }));
okPair(check, 'B-06 抽屉保存落库（末钮写入、首钮不写入）（字面锚：同 B-056 源码顺序）',
  BEHAVIOR[5].fn, () => ANCHORS['B-056'].literal(DRAWER_SRC),
  () => ({ 点击钮数: saveClicked, 服务端: EV.serverAfterSave, 草稿是否曾被落库: !EV.draftNeverLanded }));

const netBeforeRelease = await netLogLen();
if (held) { await passPaused(held); }
const afterStale = await ev(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await sleep(2500);
  return globalThis.__p.readText();
})()`);
const landedAfterRelease = await netLogSince(netBeforeRelease);
EV.staleConsumedByPage = landedAfterRelease.some((e) => e && e.hasV2 === true && e.hasV3 === false);
EV.staleReleased = EV.staleSnapshotConfirmed === true && EV.staleConsumedByPage === true;
EV.displayAfterStale = String(afterStale ?? '');
EV.serverAfterStale = await readServer();
okPair(check, 'B-07 实证陈旧快照被页面消费后展示不回退（字面锚：fetchTasks 版本守卫·HEAD TasksPage）',
  BEHAVIOR[6].fn, () => ANCHORS['B-07'].literal(TASKS_SRC),
  () => ({ 缓冲体含V2不含V3: EV.staleSnapshotConfirmed, 页面消费到该陈旧体: EV.staleConsumedByPage, 释放后落回条目: landedAfterRelease, 抽屉正文: EV.displayAfterStale.slice(0, 60), 服务端: EV.serverAfterStale }));

releaseAll = true;
await ev(`document.dispatchEvent(new Event('visibilitychange'))`);
await sleep(4000);
await send('Fetch.disable');
EV.displayAfterFresh = String(await ev(`globalThis.__p.readText()`) ?? '');
EV.serverAfterFresh = await readServer();
check('B-08 释放拦截后的新鲜快照与本地保存值一致', BEHAVIOR[7].fn(),
  { 抽屉正文: EV.displayAfterFresh.slice(0, 60), 服务端: EV.serverAfterFresh });

// 关闭抽屉（SlideOver 常驻挂载：关后可见模态抽屉应为 0）
const closeClicked = await ev(`globalThis.__p.closeHeaderBtn()`);
await sleep(1200);
EV.closedAfterCloseClick = closeClicked === true;
EV.dialogVisibleCountAfterClose = await ev(`globalThis.__p.dialogs().length`);
okPair(check, 'B-09 关闭抽屉后可见模态抽屉归零（字面锚：SlideOver role=dialog/aria-modal·HEAD）',
  BEHAVIOR[8].fn, () => ANCHORS['B-09'].literal(SLIDE_SRC),
  () => ({ 关闭按钮点击: closeClicked, 关后可见抽屉数: EV.dialogVisibleCountAfterClose }));

// ---- N 组负对照 ----
const keys = Object.keys(ANCHORS);
check('N-01 空源码负对照：6 条字面腿全假（每条正则确实承重）',
  keys.every((k) => ANCHORS[k].literal('') === false), keys.filter((k) => ANCHORS[k].literal('') !== false));
check('N-02 HEAD 在场性：6 个锚在各自 HEAD 文件中确实存在（源码非空且命中）',
  keys.every((k) => ANCHORS[k].src.length > 0 && ANCHORS[k].src.includes(ANCHORS[k].needle)),
  keys.filter((k) => !ANCHORS[k].src.includes(ANCHORS[k].needle)));
check('N-02b 抽干运行期实测料：11 条行为腿全假——行为腿确实在读实测，不是恒真',
  BEHAVIOR.every((b) => withEV({}, b.fn) === false),
  BEHAVIOR.filter((b) => withEV({}, b.fn) !== false).map((b) => b.id));
check('N-02c 还原实证：实测料回填后同一批行为腿重新为真（N-02b 的红不是恒红）',
  BEHAVIOR.every((b) => b.fn() === true),
  BEHAVIOR.filter((b) => b.fn() !== true).map((b) => b.id));
{
  const renamed = keys.map((k) => {
    const a = ANCHORS[k];
    const tampered = a.src.split(a.needle).join('⟪改名⟫');
    return { k, selfProof: tampered !== a.src, gone: !tampered.includes(a.needle), literalFalse: a.literal(tampered) === false };
  });
  check('N-03 逐锚改名模拟：6 个锚从 HEAD 副本抹掉后字面判据各自转假（且自证 tampered !== original）',
    renamed.every((r) => r.selfProof && r.gone && r.literalFalse), renamed.filter((r) => !(r.selfProof && r.gone && r.literalFalse)));
}
{
  const rec = [];
  const recOk = (n, c, i) => rec.push({ n, c, i });
  okPair(recOk, '契约-行为假', () => false, () => true);
  okPair(recOk, '契约-字面假', () => true, () => false);
  okPair(recOk, '契约-双真', () => true, () => true);
  check('N-04 okPair 落地：行为失守记「行为失守」、字面失配记「字面锚点失配」、两侧齐真才绿',
    rec.length === 3 && rec[0].c === false && /行为失守/.test(rec[0].i?.红因)
    && rec[1].c === false && /字面锚点失配/.test(rec[1].i?.红因) && rec[2].c === true, rec);
}
const MUT = {
  'B-01': (e) => { e.dialogVisibleCountWhileOpen = 2; },
  'B-02': (e) => { e.initialDisplay = V1; },
  'B-03': (e) => { e.followDisplay = V0; e.listResponsesDuringFollow = 0; },
  'B-04': (e) => { e.draftKept = false; e.v2SnapshotDuringEdit = false; },
  'B-05': (e) => { e.serverAfterCancel = DRAFT; e.draftNeverLanded = false; },
  'B-06': (e) => { e.serverAfterSave = V2; },
  'B-07': (e) => { e.displayAfterStale = V2; e.staleConsumedByPage = false; },
  'B-08': (e) => { e.displayAfterFresh = V2; },
  'B-09': (e) => { e.dialogVisibleCountAfterClose = 1; },
  'B-10': (e) => { e.rowContainsFixtureTitle = false; },
  'B-11': (e) => { e.viewButtonCount = 2; e.editRowButtonCount = 1; },
};
const mut = BEHAVIOR.map((b) => {
  const e = { ...EV };
  MUT[b.id](e);
  return { id: b.id, turnedFalse: withEV(e, b.fn) === false };
});
check('N-05 结构破坏反证：多个可见抽屉／正文不同源／无刷新／草稿被吞／取消即落库／保存未落库／陈旧快照打回／新鲜快照不一致／抽屉未关／行句柄错项目／编辑器按钮数错位 各自转假',
  mut.every((r) => r.turnedFalse === true), mut.filter((r) => !r.turnedFalse));
{
  // 旧门形态：S7b 只「保存后刷一下」再看是否含新版——任何刷新都返回新值，判据恒真。
  // 本腿把「陈旧快照确实被页面消费」写进前提，没有竞态注入就必须为假。
  const oldForm = (txt) => String(txt).includes(V3); // 旧判据形态（只要求含新版）
  const noRace = { ...EV, staleSnapshotConfirmed: false, staleConsumedByPage: false, staleReleased: false };
  check('N-06 旧门恒真形态不复现：同一展示下旧判据为真，而本腿在无竞态注入（陈旧快照未被消费）时为假',
    oldForm(EV.displayAfterStale) === true
    && withEV(noRace, BEHAVIOR[6].fn) === false
    && withEV({ ...EV, staleConsumedByPage: false }, BEHAVIOR[6].fn) === false,
    { 旧判据形态: oldForm(EV.displayAfterStale), 无竞态注入: withEV(noRace, BEHAVIOR[6].fn) });
}
check('N-07 定位器防空转：抽屉/标签栏/正文/编辑行在关键相位均解析到非空且计数受控',
  EV.dialogVisibleCountWhileOpen === 1 && EV.viewButtonCount === 1 && EV.editRowButtonCount === 2
  && EV.textareaPresent === true && typeof EV.initialDisplay === 'string' && EV.initialDisplay.length > 0,
  { 可见抽屉: EV.dialogVisibleCountWhileOpen, 查看态钮: EV.viewButtonCount, 编辑行钮: EV.editRowButtonCount });

console.log(`\n结果：PASS=${passed} FAIL=${failures}（夹具 ${TASK_NO}，隔离实例 ${PORT}，临时根 ${DATA_DIR}）`);
try { ws.close(); } catch { /* 已关闭 */ }
killTree(chrome?.pid);
killTree(server?.pid);
await sleep(1000);
cleanup();
process.exit(failures === 0 ? 0 : 1);
