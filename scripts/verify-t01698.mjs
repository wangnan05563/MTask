#!/usr/bin/env node
/**
 * T01698 移动端探针：半屏详情「结果历史 diff/回滚」全链路——
 * 打开任务详情 → 结果历史面板出现 → 选版本 → 回滚 → 二次确认 → 正文回旧版 + 服务端落库。
 * 移动端 UI 由 `?m=1`（resolveUiMode）+ Chrome 400x850 视口触发。
 *
 * T02293 判据落地：
 *  - 行为腿只认结构：半屏详情＝文档流内可见的 `dialog[aria-modal="true"]`；历史面板＝该 dialog 内
 *    选项数 ≥2 的 `select`（`select.parentElement`＝面板头、其父＝面板根、面板根的兄弟＝
 *    「处理结果」正文区）；确认层＝恰含 2 枚按钮的 `position:fixed` 覆盖层（末钮即确定）。
 *    行定位用夹具标题所在 `li` 内的按钮，不再匹配 `aria-label="任务详情：…"` 前缀；
 *  - S-06 修掉旧门缺陷：旧版用 `document.body.textContent` 判「正文回旧版」，而选中版本后 diff 区
 *    本来就渲染旧版文本，该判据在回滚前即为真（假绿）。改判为只读「处理结果」正文区节点，
 *    并要求旧版在、新版不在；
 *  - 保留的 4 组产品文案锚（结果历史（／选择历史版本对比／回滚到该版本／确定：确认执行该操作）全部进
 *    `okPair` 字面腿（取证面 `git show HEAD:`），行为腿为上述结构实测；
 *  - 判据里的 `V0 旧结果 / V1 新结果 / 移动端回滚探针` 是**门内夹具数据**（临时库自建），不是产品文案；
 *  - N 组负对照：空源码、HEAD 在场性、抽干运行期实测料＋回填复原、逐锚改名自证、`okPair` 两红因契约、
 *    结构破坏形态（面板条数错位／选项数错位／确认层 3 钮／正文区仍为新版）、旧门 body 全文判据不复现。
 *
 * 隔离纪律（skill 红线 8）：MTask_DATA_DIR 指 **D:** 临时目录、端口自配，用完连树回收；不碰生产库与 39877。
 * 用法：node scripts/verify-t01698.mjs
 *   环境变量：T01698_PORT（默认 39916）、T01698_CDP（默认 9338）、T01698_CHROME
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 临时根必须落 D:（C: 常年 0 可用，SQLITE_FULL 会伪装成产品失败）
const TMP_ROOT = existsSync('D:/code/tmp') ? 'D:/code/tmp' : tmpdir();
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't01698-data-'));
const CHROME_PROFILE = mkdtempSync(join(TMP_ROOT, 't01698-chrome-'));
const PORT = Number(process.env.T01698_PORT ?? 39916);
const CDP = Number(process.env.T01698_CDP ?? 9338);
const CHROME = process.env.T01698_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = `http://127.0.0.1:${PORT}/api`;
const FIX_TITLE = '移动端回滚探针';
const V0 = 'V0 旧结果';
const V1 = 'V1 新结果';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { resolveServerLauncher } = await import(pathToFileURL(join(ROOT, 'scripts/isolated-server-launcher.mts')).href);
const { okPair } = await import(pathToFileURL(join(ROOT, 'scripts/lib/anchor-pair.mts')).href);

let failures = 0;
let passed = 0;
const check = (n, p, i) => {
  if (p) { passed += 1; console.log(`  [PASS] ${n}`); return; }
  failures += 1;
  console.log(`  [FAIL] ${n}${i !== undefined ? ` -> ${JSON.stringify(i).toString().slice(0, 300)}` : ''}`);
};

// 字面腿取证面固定 HEAD（反模式 11：不读工作树）
const headSource = (rel) => {
  try {
    return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return '';
  }
};
const DIFF_SRC = headSource('web/src/ui/ResultDiff.tsx');
const DLG_SRC = headSource('web/src/ui/dialogs.tsx');
const ANCHORS = {
  'S-02': { src: DIFF_SRC, needle: '结果历史（', literal: (s) => /结果历史（/.test(s) },
  'S-03': { src: DIFF_SRC, needle: 'aria-label="选择历史版本对比"', literal: (s) => /aria-label="选择历史版本对比"/.test(s) },
  'S-04': { src: DIFF_SRC, needle: '回滚到该版本', literal: (s) => /回滚到该版本/.test(s) },
  'S-05': { src: DLG_SRC, needle: 'aria-label="确定：确认执行该操作"', literal: (s) => /aria-label="确定：确认执行该操作"/.test(s) },
};

// 运行期实测料（行为腿唯一取数面；N 组靠抽干它证明行为腿不恒真）
const EV = {
  detailOpened: false, detailHasFixture: false,
  uiHistoryCount: -1, serverHistoryCount: -1, panelHeaderText: '',
  selectPresent: false, selectChangedValue: false, selectOptionCount: -1,
  rollbackBtnAfterSelect: false, confirmOverlaySeen: false, confirmButtonCount: 0,
  confirmClicked: false, serverResult: '', resultText: '',
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
const BEHAVIOR = [
  { id: 'S-01', label: '移动端半屏详情打开', fn: () => EV.detailOpened === true && EV.detailHasFixture === true },
  { id: 'S-02', label: '结果历史面板条数＝服务端留档条数', fn: () => EV.uiHistoryCount > 0 && EV.uiHistoryCount === EV.serverHistoryCount },
  { id: 'S-03', label: '版本选择控件在场且改值生效', fn: () => EV.selectPresent === true && EV.selectChangedValue === true && EV.selectOptionCount === EV.serverHistoryCount + 1 },
  { id: 'S-04', label: '选中版本后浮出回滚控件并唤出确认层', fn: () => EV.rollbackBtnAfterSelect === true && EV.confirmOverlaySeen === true && EV.confirmButtonCount === 2 },
  { id: 'S-05', label: '确认层末钮提交后服务端落库为旧版', fn: () => EV.confirmClicked === true && EV.serverResult === V0 },
  { id: 'S-06', label: '「处理结果」正文区回到旧版且不再含新版', fn: () => typeof EV.resultText === 'string' && EV.resultText.includes(V0) && !EV.resultText.includes(V1) },
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

// ---- 隔离 server + 夹具（覆盖写入产生历史留档）----
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
server = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT,
  env: { ...process.env, ...LAUNCHER.env, MTask_DATA_DIR: DATA_DIR, MTask_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout?.on('data', (b) => serverLog.push(b.toString()));
server.stderr?.on('data', (b) => serverLog.push(b.toString()));
console.log(`隔离实例启动器：${LAUNCHER.label}`);
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

// POST /tasks 不接受 handleResult（创建即带结果本就无「被覆盖前」留档）——先建空结果，两次 PATCH 造两层历史
const task = await (await fetch(`${API}/tasks`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ projectId: 'sys-inbox', title: FIX_TITLE, description: 'x' }),
})).json();
check('U-01 夹具任务创建（收件箱）', !!task?.id && !!task?.task_no, { id: task?.id, taskNo: task?.task_no });
if (!task?.id) {
  console.log(`\n结果：PASS=${passed} FAIL=${failures}（夹具未建成，终止）`);
  process.exit(1);
}
const p1 = await fetch(`${API}/tasks/${task.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handleResult: V0 }) });
const p2 = await fetch(`${API}/tasks/${task.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handleResult: V1 }) });
check('U-01b 两层覆盖写入（PATCH 均 2xx）', p1.ok && p2.ok, { p1: p1.status, p2: p2.status });
const hist = await (await fetch(`${API}/tasks/by-no/${task.task_no}/result-history`)).json();
EV.serverHistoryCount = Array.isArray(hist) ? hist.length : -1;
check('U-02 服务端留档恰 2 条（夹具前提）', EV.serverHistoryCount === 2, EV.serverHistoryCount);

// ---- Chrome 移动视口 ----
chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--no-first-run', '--disable-gpu',
  '--window-size=400,850', `--user-data-dir=${CHROME_PROFILE}`, 'about:blank',
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
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
check('U-03 headless Chrome 与 CDP 就绪', true);
await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?m=1` }); // ?m=1 强制移动端 UI（resolveUiMode）

// 结构句柄一次性装到页面（全程不出现产品中文文案选择器）
await ev(`(() => {
  const vis = (el) => !!el && el.getClientRects().length > 0;
  globalThis.__p = {
    dlg: () => [...document.querySelectorAll('dialog[aria-modal="true"]')].find(vis) || null,
    sel: () => { const d = globalThis.__p.dlg(); return d ? [...d.querySelectorAll('select')].find((s) => s.options.length >= 2) || null : null; },
    head: () => { const s = globalThis.__p.sel(); return s ? s.parentElement : null; },
    panel: () => { const h = globalThis.__p.head(); return h ? h.parentElement : null; },
    resultEl: () => { const pn = globalThis.__p.panel(); const w = pn ? pn.parentElement : null; if (!w) return null; const k = [...w.children].filter((c) => c !== pn); return k[0] || null; },
    confirm: () => [...document.querySelectorAll('div')].filter((el) => vis(el) && getComputedStyle(el).position === 'fixed' && el.querySelectorAll('button').length === 2).pop() || null,
  };
  return true;
})()`);
const TITLE = JSON.stringify(FIX_TITLE);
let listReady = false;
for (let i = 0; i < 90; i++) {
  listReady = (await ev(`[...document.querySelectorAll('li')].some((x) => x.textContent.includes(${TITLE}))`)) === true;
  if (listReady) break;
  await sleep(300);
}
check('U-04 移动端列表渲染且夹具行在场、结构句柄装载',
  listReady && (await ev(`typeof globalThis.__p === 'object'`)) === true, { listReady });

// 1) 点开夹具行 → 半屏详情
const s1 = await ev(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 20; i++) {
    const li = [...document.querySelectorAll('li')].find((x) => x.textContent.includes(${TITLE}));
    const btn = li ? [...li.querySelectorAll('button')].find((b) => b.textContent.includes(${TITLE})) : null;
    if (btn) { btn.click(); return 'clicked'; }
    await sleep(300);
  }
  return 'row-missing';
})()`);
const opened = await ev(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 25; i++) {
    const d = globalThis.__p.dlg();
    if (d && d.textContent.includes(${TITLE})) return true;
    await sleep(300);
  }
  return false;
})()`);
EV.detailOpened = s1 === 'clicked';
EV.detailHasFixture = opened === true;
check('S-01 移动端半屏详情打开（可见 dialog[aria-modal] 内含夹具标题）', BEHAVIOR[0].fn(), { s1, opened });

// 2) 结果历史面板（结构：面板内 select 的 option 数 = 留档数 + 1）
const s2 = await ev(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 30; i++) {
    const s = globalThis.__p.sel();
    const h = globalThis.__p.head();
    if (s && h) return { options: s.options.length, header: String(h.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60) };
    await sleep(300);
  }
  return null;
})()`);
EV.selectPresent = !!s2;
EV.selectOptionCount = s2 ? s2.options : -1;
EV.uiHistoryCount = s2 ? s2.options - 1 : -1;
EV.panelHeaderText = s2 ? s2.header : '';
okPair(check, 'S-02 结果历史面板条数＝服务端留档条数（字面锚：结果历史（…）·HEAD）',
  BEHAVIOR[1].fn, () => ANCHORS['S-02'].literal(DIFF_SRC),
  () => ({ ui: EV.uiHistoryCount, server: EV.serverHistoryCount, 面板头实测: EV.panelHeaderText }));

// 3) 选定对比版本 → 回滚控件浮出 → 点击
const chosen = await ev(`(() => {
  const s = globalThis.__p.sel();
  if (!s || s.options.length < 2) return null;
  const v = s.options[1].value;
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  set.call(s, v);
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return { v, aria: s.getAttribute('aria-label') || '' };
})()`);
await sleep(400);
const s3 = await ev(`(() => {
  const want = ${JSON.stringify(chosen ? chosen.v : null)};
  const s = globalThis.__p.sel();
  const h = globalThis.__p.head();
  const btn = h ? h.querySelector('button') : null;
  if (btn) btn.click();
  return { changed: !!s && want !== null && s.value === want, btnFound: !!btn };
})()`);
EV.selectChangedValue = s3?.changed === true;
EV.rollbackBtnAfterSelect = s3?.btnFound === true;
okPair(check, 'S-03 历史版本选择控件可用且改值生效（字面锚：选择历史版本对比·HEAD）',
  BEHAVIOR[2].fn, () => ANCHORS['S-03'].literal(DIFF_SRC),
  () => ({ 运行期可访问名: chosen?.aria ?? '', 选项数: EV.selectOptionCount, 改值生效: EV.selectChangedValue }));

// 4) 确认层（结构：恰含 2 枚按钮的 fixed 覆盖层，末钮即确定）
const confirm = await ev(`(() => {
  const o = globalThis.__p.confirm();
  if (!o) return null;
  return { buttons: o.querySelectorAll('button').length, msg: String(o.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 70) };
})()`);
EV.confirmOverlaySeen = !!confirm;
EV.confirmButtonCount = confirm ? confirm.buttons : 0;
okPair(check, 'S-04 选中版本后浮出回滚控件并唤出确认层（字面锚：回滚到该版本·HEAD）',
  BEHAVIOR[3].fn, () => ANCHORS['S-04'].literal(DIFF_SRC),
  () => ({ 按钮数: EV.confirmButtonCount, 确认层实测: confirm?.msg ?? '', 选中态: s3 }));

const s4 = await ev(`(() => {
  const o = globalThis.__p.confirm();
  if (!o) return 'confirm-missing';
  const bs = [...o.querySelectorAll('button')];
  bs[bs.length - 1].click();
  return 'confirmed';
})()`);
EV.confirmClicked = s4 === 'confirmed';
const s5 = await ev(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const read = () => { const el = globalThis.__p.resultEl(); return el ? String(el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60) : ''; };
  for (let i = 0; i < 30; i++) {
    const t = read();
    if (t.includes(${JSON.stringify(V0)}) && !t.includes(${JSON.stringify(V1)})) return { text: t, hit: true };
    await sleep(300);
  }
  return { text: read(), hit: false };
})()`);
EV.resultText = s5?.text ?? '';
const sv = await (await fetch(`${API}/tasks?projectId=sys-inbox&archived=false`)).json();
const found = Array.isArray(sv) ? sv.find((t) => t.id === task.id) : null;
EV.serverResult = found?.handle_result ?? '';
okPair(check, 'S-05 确认层末钮提交后服务端落库为旧版（字面锚：确定：确认执行该操作·HEAD dialogs）',
  BEHAVIOR[4].fn, () => ANCHORS['S-05'].literal(DLG_SRC),
  () => ({ s4, 服务端正文: EV.serverResult }));
check('S-06 「处理结果」正文区回到旧版且不再含新版（不读 body 全文，避开 diff 区旧版文本造成的假绿）',
  BEHAVIOR[5].fn(), { 正文区实测: EV.resultText, 轮询命中: s5?.hit });

// ---- N 组负对照 ----
const keys = Object.keys(ANCHORS);
check('N-01 空源码负对照：4 条字面腿全假（每条正则确实承重）',
  keys.every((k) => ANCHORS[k].literal('') === false), keys.filter((k) => ANCHORS[k].literal('') !== false));
check('N-02 HEAD 在场性：4 个锚在各自 HEAD 文件中确实存在（源码非空且命中）',
  keys.every((k) => ANCHORS[k].src.length > 0 && ANCHORS[k].src.includes(ANCHORS[k].needle)),
  keys.filter((k) => !ANCHORS[k].src.includes(ANCHORS[k].needle)));
check('N-02b 抽干运行期实测料：6 条行为腿全假——行为腿确实在读实测，不是恒真',
  BEHAVIOR.every((b) => withEV({}, b.fn) === false),
  BEHAVIOR.filter((b) => withEV({}, b.fn) !== false).map((b) => b.id));
check('N-02c 还原实证：实测料回填后同一批行为腿重新为真（N-02b 的红不是恒红）',
  BEHAVIOR.every((b) => b.fn() === true),
  BEHAVIOR.filter((b) => b.fn() !== true).map((b) => b.id));
const renamed = keys.map((k) => {
  const a = ANCHORS[k];
  const tampered = a.src.split(a.needle).join('⟪改名⟫');
  return { k, selfProof: tampered !== a.src, gone: !tampered.includes(a.needle), literalFalse: a.literal(tampered) === false };
});
check('N-03 逐锚改名模拟：4 个锚从 HEAD 副本抹掉后字面判据各自转假（且自证 tampered !== original）',
  renamed.every((r) => r.selfProof && r.gone && r.literalFalse), renamed.filter((r) => !(r.selfProof && r.gone && r.literalFalse)));
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
  'S-01': (e) => { e.detailHasFixture = false; },
  'S-02': (e) => { e.uiHistoryCount = e.serverHistoryCount + 1; },
  'S-03': (e) => { e.selectOptionCount = e.serverHistoryCount + 2; },
  'S-04': (e) => { e.confirmButtonCount = 3; },
  'S-05': (e) => { e.serverResult = V1; },
  'S-06': (e) => { e.resultText = V1 + '（diff 区另有 ' + V0 + '）'; },
};
const mut = BEHAVIOR.map((b) => {
  const e = { ...EV };
  MUT[b.id](e);
  return { id: b.id, turnedFalse: withEV(e, b.fn) === false };
});
check('N-05 结构破坏反证：详情未含夹具／面板条数错位／选项数错位／确认层 3 钮／落库仍新版／正文区仍新版 各自转假',
  mut.every((r) => r.turnedFalse === true), mut.filter((r) => !r.turnedFalse));
// 旧门缺陷不复现：回滚前「diff 区渲染旧版 + 正文仍是新版」这一形态，body 全文判据为真、正文区判据必须为假
{
  const preRollback = V1 + ' −' + V0; // 正文区若把 diff 行也算进来时的形态
  const oldBodyProbe = preRollback.includes(V0); // 旧判据（body 全文 includes V0）在此形态为真 = 假绿
  check('N-06 旧门 body 全文判据不复现：同一「diff 含旧版、正文仍新版」形态下正文区判据为假（旧判据在该形态本就为真）',
    oldBodyProbe === true && withEV({ ...EV, resultText: preRollback }, BEHAVIOR[5].fn) === false,
    { oldBodyProbe, newLeg: withEV({ ...EV, resultText: preRollback }, BEHAVIOR[5].fn) });
}

console.log(`\n结果：PASS=${passed} FAIL=${failures}`);
try { ws.close(); } catch { /* 已关闭 */ }
killTree(chrome?.pid);
killTree(server?.pid);
await sleep(1000);
cleanup();
process.exit(failures === 0 ? 0 : 1);
