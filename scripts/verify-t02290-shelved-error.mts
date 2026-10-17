#!/usr/bin/env node
/**
 * T02290 回归门：桌面任务页「搁置」列表取数失败必须有可见失败态，不得被「暂无搁置任务」空态冒充。
 *
 * 拦的是什么（本单缺陷的两种表现，缺一不可）：
 *   ① 冷启动即失败：搁置段 GET 报错 → 页面必须给出「搁置列表加载失败 · 原因」+ 重试入口，
 *      且不再渲染「暂无搁置任务——…」空态；主列表照常渲染（既有取舍：搁置失败不打断主列表）。
 *   ② 成功后刷新失败：旧数据仍在 → 必须标成「可能过期」，不能读起来像「刚拿到的新数据」。
 *
 * 判据口径（服从 T02293）：
 *   - 全部断言来自**门内自造的桩数据**（夹具行标题 `门夹具活待办样本` / `门夹具活搁置样本`），
 *     不读生产库、不锁函数名/变量名等实现细节；
 *   - 文案锚只咬「共享失败态层的契约文案」（ResourceHint 的 `<label>加载失败 · <原因>` 与
 *     「可能过期」），label 由本门夹具场景决定，不咬具体实现；
 *   - `[data-t02213="resource-error"]` 是 T02213 立下的测试钩子（跨页共享契约），不是样式类名。
 *
 * 通道：无外部依赖——门自己 `vite build` 当前源码 → 内置桩服静态伺服 `web/dist` + 假 API
 *   → 系统 Chrome(headless=new) 经 CDP 真实指针点击 → 断言 DOM。
 *   断供用两条独立通道各证一次：HTTP 500（带 error 正文）与 **socket 直接 destroy**（连接级故障，
 *   等价于后端进程被杀时的 fetch 失败），后者不依赖任何响应体。
 *
 * 用法：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02290-shelved-error.mts
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02290-shelved-error.mts --negative-control
 *   环境变量：T02290_PORT（默认 39951）、T02290_CDP（默认 39952）、T02290_CHROME、
 *             T02290_GATE_SKIP_BUILD=1 复用现有 web/dist（改过前端源码时别用，G-03 会拦；负对照忽略本开关）、
 *             T02290_TMP_ROOT（默认 D:/code/tmp；C 盘常年 0 可用会假性失败）
 *
 * 负对照纪律：--negative-control 在**构建之前**把 `web/src/pages/TasksPage.tsx` 改回缺陷形态（裸吞 catch、
 *   无 hint、无空态守卫），否则 dist 跑的还是修复态、交互组会给出假的「全绿」；
 *   跑完按字节还原并重建 dist。还原守卫比对的是「门自己写进去的缺陷文本」——工作区与它不一致才说明有
 *   第三方在门运行期间动过同一文件，此时拒绝覆盖并大声报警，避免与并发会话互相踩踏。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateShotsDir, writeGateResults } from './lib/gate-results.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const DIST = join(WEB, 'dist');
const SRC = join(WEB, 'src', 'pages', 'TasksPage.tsx');
const OUT_DIR = join(ROOT, '.workbuddy');
const OUT_BASE = 't02290-shelved-error-gate-results.txt';
const BACKUP = join(OUT_DIR, 't02290-shelved-error-source-backup.tsx');

const NEGATIVE = process.argv.includes('--negative-control');
const PORT = Number(process.env.T02290_PORT ?? 39951);
const CDP_PORT = Number(process.env.T02290_CDP ?? 39952);
const CHROME = process.env.T02290_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = `http://127.0.0.1:${PORT}`;
const SKIP_BUILD = process.env.T02290_GATE_SKIP_BUILD === '1';
/** 桩服故障开关：门在场景之间原地翻转，不需要重启服务 */
const fail: { mode: 'off' | 'http500' | 'destroy' } = { mode: 'off' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let failCount = 0;
const lines: string[] = [];
const pageErrors: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) pass += 1; else failCount += 1;
  const tail = cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 320)}`;
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${tail}`);
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${tail}`);
};

// ---------------- 桩数据（形状对齐 web/src/api/client.ts 的 Project / Task） ----------------
const T = '2026-10-17T00:00:00.000Z';
const PID = 'gate-t02290-project';
const PROJECTS = [{
  id: PID, name: 'T02290 搁置门项目', description: '', sort_weight: 0, created_at: T, updated_at: T,
  todo_count: 1, done_count: 0, unverified_count: 0, plan_done: 0, plan_doing: 0, plan_open: 0, workspace_path: '',
}];
const mkTask = (id: string, no: string, title: string, status: 'todo' | 'done', shelved: boolean) => ({
  id, task_no: no, project_id: PID, title, description: '门内夹具正文，仅用于失败态断言。',
  priority: 'normal', status, verified: false, archived: false, archived_at: null,
  ai_summary: null, ai_summary_at: null, handle_result: null, ai_state: '', retry_count: 0,
  derived_from: null, history_at: null, shelved, user_sort: null, pinned: false,
  category_id: null, parent_id: null, color: '', created_at: T, updated_at: T, images: [],
});
const TODO_ROW = mkTask('gate-t02290-todo', 'T99901', '门夹具活待办样本', 'todo', false);
const SHELVED_ROW = mkTask('gate-t02290-shelved', 'T99902', '门夹具活搁置样本', 'todo', true);
/** 失败原因正文由桩服给出——门据此断言「原因真的透到界面上」，而不是只显示一句泛化文案 */
const STUB_REASON = '搁置桩故意断供';
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

function stubServer(): { close: () => Promise<void> } {
  const srv = createServer((req, res) => {
    const p = decodeURIComponent(req.url ?? '');
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify(body));
      return undefined;
    };
    if (p.startsWith('/api/health')) return json(200, { ok: true });
    if (p.startsWith('/api/projects')) return json(200, PROJECTS);
    if (p.startsWith('/api/aitools')) return json(200, p.includes('/defaults') ? { organize: null, develop: null } : []);
    if (/\/categories$/.test(p) || p.startsWith('/api/task-categories') || p.startsWith('/api/prompt-categories') || p.startsWith('/api/req-categories')) return json(200, []);
    if (p.startsWith('/api/tasks')) {
      // 只掐搁置那一段：主列表照常返回，才能证明「搁置失败不打断主列表」这条既有取舍没被改坏
      if (/shelved=1/.test(p)) {
        if (fail.mode === 'http500') return json(500, { error: STUB_REASON });
        if (fail.mode === 'destroy') { req.socket.destroy(); return undefined; }
        return json(200, [SHELVED_ROW]);
      }
      return json(200, [TODO_ROW]);
    }
    if (p.startsWith('/api/')) return json(200, (req.method ?? 'GET') === 'GET' ? [] : {});
    const rel = p.split('?')[0].replace(/^\/+/, '');
    const file = rel ? join(DIST, rel) : join(DIST, 'index.html');
    const candidate = existsSync(file) && statSync(file).isFile() ? file : join(DIST, 'index.html');
    if (!existsSync(candidate)) return json(404, { error: 'web/dist 不存在——门会先跑一次构建' });
    res.writeHead(200, { 'Content-Type': MIME[extname(candidate)] ?? 'application/octet-stream' });
    res.end(readFileSync(candidate));
    return undefined;
  });
  srv.listen(PORT, '127.0.0.1');
  return { close: () => new Promise((done) => { srv.closeAllConnections?.(); srv.close(() => done()); }) };
}

/** 默认每次重建 dist：门的判据必须来自当前源码，否则负对照与回归都无从谈起 */
function buildWeb(force = false): void {
  // force：负对照用——缺陷形态是门在运行期临时注入的，`SKIP_BUILD=1` 复用的 dist 属于修复态，必须重建
  if (SKIP_BUILD && !force) { console.log('  (跳过构建：T02290_GATE_SKIP_BUILD=1，复用现有 web/dist)'); return; }
  const r = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: WEB, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(String(r.stdout ?? '').slice(-2000));
    console.error(String(r.stderr ?? '').slice(-2000));
    throw new Error('vite build 失败——源码不可构建时门不给结论');
  }
}

// ---------------- CDP 客户端（Node 18+ 全局 WebSocket，无外部依赖） ----------------
type Cdp = { send: (method: string, params?: Record<string, unknown>) => Promise<any>; close: () => void };
async function connectCdp(): Promise<Cdp> {
  let wsUrl = '';
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      if (r.ok) {
        const targets = (await r.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
        wsUrl = targets.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? '';
      }
    } catch { /* Chrome 还没起好 */ }
    if (!wsUrl) await sleep(500);
  }
  if (!wsUrl) throw new Error(`CDP 端口 ${CDP_PORT} 拿不到 page target`);
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((r, j) => { ws.onopen = () => r(); ws.onerror = () => j(new Error('CDP 连接失败')); });
  let seq = 0;
  const waiting = new Map<number, (v: any) => void>();
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails;
      pageErrors.push(String(d?.exception?.description ?? d?.text ?? '').slice(0, 300));
    }
    if (msg.id !== undefined && waiting.has(msg.id)) { waiting.get(msg.id)!(msg); waiting.delete(msg.id); }
  };
  return {
    send(method, params = {}) {
      const id = ++seq;
      return new Promise((resolvePromise) => {
        waiting.set(id, (msg) => resolvePromise(msg.error ? { __cdpError: msg.error.message } : msg.result));
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => { try { ws.close(); } catch { /* */ } },
  };
}

function makeEval(cdp: Cdp) {
  return async (expr: string): Promise<any> => {
    const r = await cdp.send('Runtime.evaluate', { expression: `(() => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r?.__cdpError) throw new Error(r.__cdpError);
    return r?.result?.value;
  };
}
type Ev = ReturnType<typeof makeEval>;

async function until(ev: Ev, expr: string, ms = 25_000): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    let v: unknown = null;
    try { v = await ev(`return (${expr});`); } catch { /* 导航/挂载未完成 */ }
    if (v) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(250);
  }
}

/** 真实指针点击（CDP Input.dispatchMouseEvent）——DOM 级 el.click() 会掩盖层叠/遮挡类缺陷 */
async function realClickByText(cdp: Cdp, ev: Ev, text: string): Promise<boolean> {
  const p = await ev(`
    const el = [...document.querySelectorAll('button,[role="button"]')].find(b => (b.textContent ?? '').includes(${JSON.stringify(text)}));
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  `);
  if (!p) return false;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  return true;
}

/** 页面现场摘要：失败态钩子、空态文案、夹具行是否在场 */
const PROBE = `
  const hints = [...document.querySelectorAll('[data-t02213="resource-error"]')].map(e => (e.textContent ?? '').replace(/\\s+/g, ' ').trim());
  const body = (document.body.innerText ?? '').replace(/\\s+/g, ' ');
  return {
    mounted: (document.querySelector('#root')?.children.length ?? 0) > 0,
    hints,
    shelvedHint: hints.find(h => h.includes('搁置列表')) ?? '',
    todoHint: hints.find(h => h.includes('任务列表')) ?? '',
    retryBtn: hints.length > 0 && [...document.querySelectorAll('[data-t02213="resource-error"] button')].some(b => (b.textContent ?? '').includes('重试')),
    emptyState: body.includes('暂无搁置任务'),
    staleMark: body.includes('可能过期'),
    hasTodo: body.includes('门夹具活待办样本'),
    hasShelved: body.includes('门夹具活搁置样本'),
    rejections: (window.__rej ?? []),
  };
`;

async function probe(ev: Ev): Promise<any> { return ev(PROBE); }

async function reloadToShelvedTab(cdp: Cdp, ev: Ev): Promise<any> {
  await cdp.send('Page.navigate', { url: `${BASE}/?t=${Date.now()}` });
  await until(ev, `(document.querySelector('#root')?.children.length ?? 0) > 0`, 25_000);
  await sleep(1_200);
  // 点 tab 而不是行内「搁置」按钮：tab 文案是「搁置（N）」，行内按钮只有「搁置」二字——
  // 上一轮实测点中了待办行的行内按钮，把夹具行真搁置掉了，A-01 因此假红（门自己踩的坑，记在这里防回归）。
  await realClickByText(cdp, ev, '搁置（');
  await sleep(1_200);
  return probe(ev);
}

// ---------------- 交互组（正常态 + 两种故障表现 + 重试恢复） ----------------
async function runInteraction(cdp: Cdp, ev: Ev, shots: string): Promise<void> {
  fail.mode = 'off';
  const base = await reloadToShelvedTab(cdp, ev);
  ok('A-00 视图确实切到「搁置」tab（待办区行不在当前视图，夹具搁置行接管）',
    base.hasTodo === false && base.mounted === true, base);
  ok('A-01 正常态：搁置区渲染门夹具行（桩数据真的进了列表）', base.hasShelved === true, base);
  ok('A-02 正常态：不出现「搁置列表加载失败」提示（不虚报故障）', String(base.shelvedHint ?? '') === '', base.shelvedHint);
  ok('A-03 正常态：有数据时不显示「暂无搁置任务」空态', base.emptyState === false, base.emptyState);

  fail.mode = 'http500';
  const cold = await reloadToShelvedTab(cdp, ev);
  ok('B-01 冷启动 500：搁置区给出可见失败态（含「搁置列表」与「加载失败」）',
    cold.shelvedHint.includes('搁置列表') && cold.shelvedHint.includes('加载失败'), cold.shelvedHint);
  ok('B-02 冷启动 500：失败原因真的透到界面（不是泛化文案）', cold.shelvedHint.includes(STUB_REASON), cold.shelvedHint);
  ok('B-03 冷启动 500：不再用「暂无搁置任务」空态冒充正常', cold.emptyState === false, cold.emptyState);
  ok('B-04 冷启动 500：主列表未被牵连（无「任务列表」失败态）', String(cold.todoHint ?? '') === '' && cold.hints.length === 1,
    { shelved: cold.shelvedHint, todo: cold.todoHint, all: cold.hints });
  ok('B-05 冷启动 500：给出重试入口', cold.retryBtn === true, cold);
  ok('B-06 冷启动 500：异常被接住，无未捕获 rejection', Array.isArray(cold.rejections) && cold.rejections.length === 0, cold.rejections);
  await (async () => { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); if (r?.data) writeFileSync(join(shots, 'B-cold-500.png'), Buffer.from(String(r.data), 'base64')); })();

  fail.mode = 'destroy';
  const conn = await reloadToShelvedTab(cdp, ev);
  ok('B-07 连接级断供（socket 直接断，等价后端进程被杀）同样给出失败态',
    conn.shelvedHint.includes('搁置列表') && conn.shelvedHint.includes('加载失败') && conn.emptyState === false, conn.shelvedHint);
  ok('B-08 连接级断供：原因可读且无未捕获 rejection',
    conn.shelvedHint.replace('搁置列表加载失败 ·', '').trim().length > 0 && (conn.rejections ?? []).length === 0,
    { hint: conn.shelvedHint, rejections: conn.rejections });

  // 表现②：先成功装载，再让刷新失败——旧数据必须被标成「可能过期」而不是冒充新数据
  fail.mode = 'off';
  const pre = await reloadToShelvedTab(cdp, ev);
  ok('C-01 陈旧态前提成立：首轮成功装载夹具行', pre.hasShelved === true, pre);
  fail.mode = 'http500';
  await ev(`
    const inp = document.querySelector('input[placeholder^="搜索标题"]');
    if (!inp) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, '门夹具');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return inp.value;
  `);
  await sleep(1_800);
  const stale = await probe(ev);
  ok('C-02 刷新失败：旧数据仍在（不是整块清空）', stale.hasShelved === true, stale);
  ok('C-03 刷新失败：给出「搁置列表加载失败」且标注「可能过期」',
    stale.shelvedHint.includes('搁置列表') && stale.staleMark === true, { hint: stale.shelvedHint, staleMark: stale.staleMark });
  ok('C-04 刷新失败：不再显示「暂无搁置任务」空态', stale.emptyState === false, stale.emptyState);

  // 恢复：把故障关掉后点重试——失败态必须整条消失且不残留「可能过期」
  fail.mode = 'off';
  ok('D-01 点重试（真实指针点击）可恢复', await (async () => {
    const p = await ev(`
      const b = [...document.querySelectorAll('[data-t02213="resource-error"] button')].find(x => (x.textContent ?? '').includes('重试'));
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    `);
    if (!p) return false;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(2_000);
    const after = await ev(`
      const hints = [...document.querySelectorAll('[data-t02213="resource-error"]')].map(e => e.textContent ?? '');
      const body = (document.body.innerText ?? '').replace(/\\s+/g, ' ');
      return { gone: !hints.some(h => h.includes('搁置列表')), back: body.includes('门夹具活搁置样本'), noStale: !body.includes('可能过期') };
    `);
    return !!(after?.gone && after?.back && after?.noStale);
  })(), undefined);

  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  if (r?.data) writeFileSync(join(shots, 'D-recovered.png'), Buffer.from(String(r.data), 'base64'));
  ok('D-02 全程页面未捕获异常为 0（失败态接线没引入新崩溃）', pageErrors.length === 0, pageErrors.slice(0, 3));
}

// ---------------- 负对照：把源码改回缺陷形态，门必须拦得住 ----------------
const REVERTS: Array<[RegExp, string]> = [
  // ① 成功分支不再置 ready（缺陷形态：状态变量根本不存在，这里退化成「不更新」）
  [/setShelvedTasks\(nextShelved\);\s*setShelvedPhase\('ready'\);\s*setShelvedError\(''\);/, 'setShelvedTasks(nextShelved);'],
  // ② 裸吞 catch 回来
  [/\} catch \(e\) \{\s*\/\/ T02290[^\n]*\n[^\n]*\n\s*setShelvedPhase\('error'\);\s*setShelvedError\(e instanceof Error \? e\.message : String\(e\)\);\s*\}/,
    '} catch { /* 搁置列表拉取失败不打断主列表 */ }'],
  // ③ 失败态提示行摘掉
  [/\{\s*\/\* T02290：搁置列表取数失败此前无任何出口[\s\S]*?<ResourceHint\n\s+view=\{\{ phase: shelvedPhase,[\s\S]*?label="搁置列表"\n\s*\/>\s*<\/div>\n/, ''],
  // ④ 空态守卫退回（失败时也渲染「暂无搁置任务」）
  [/\{visibleShelved\.length === 0 && shelvedPhase !== 'error' && \(/, "{visibleShelved.length === 0 && ("],
];

let negativeRestored = true;

function applyNegativeControl(): { restore: () => void } | null {
  const original = readFileSync(SRC, 'utf8');
  writeFileSync(BACKUP, original, 'utf8');
  let patched = original;
  for (const [re, to] of REVERTS) {
    if (!re.test(patched)) throw new Error(`负对照锚点未命中（源码形态变了，请同步本脚本）：${re.source.slice(0, 80)}`);
    patched = patched.replace(re, to);
  }
  writeFileSync(SRC, patched, 'utf8');
  console.log('  负对照：已把 TasksPage.tsx 改回缺陷形态（原文备份 .workbuddy/t02290-shelved-error-source-backup.tsx）');
  return { restore: () => restoreNegative(patched) };
}

/**
 * 还原守卫的比对基准是「门自己写进去的缺陷形态」，不是改动前的原文：
 * 运行期工作区若与门写的缺陷文本一致 → 无第三方插入，可安全按备份逐字还原；
 * 不一致才说明有人在门运行期间动过同一文件——此时不覆盖他人改动，只点名让人工从备份还原。
 */
function restoreNegative(patched: string): void {
  if (!existsSync(BACKUP)) return;
  const now = readFileSync(SRC, 'utf8');
  const backup = readFileSync(BACKUP, 'utf8');
  if (now !== patched) {
    negativeRestored = false;
    console.log('  ⚠ 负对照还原被拦：源码在门运行期间被第三方改动过——不覆盖他人改动，请人工核对后从备份还原：'
      + BACKUP.replace(/\\/g, '/'));
    return;
  }
  writeFileSync(SRC, backup, 'utf8');
  rmSync(BACKUP, { force: true });
  negativeRestored = readFileSync(SRC, 'utf8') === backup;
  ok('E-01 负对照收尾：源码按字节还原（工作区不留缺陷态）', negativeRestored, SRC);
}

// ---------------- 主流程 ----------------
/**
 * 负对照收尾（幂等）：还原源码 → 按还原后的源码重建 dist。
 * 「通道前置不满足」时门会跳过交互组直接收工，收尾照样要跑——否则工作区被留在缺陷形态（本轮实测踩过）。
 */
let negativeClosed = false;
function closeNegative(control: { restore: () => void } | null): void {
  if (!NEGATIVE || negativeClosed) return;
  negativeClosed = true;
  control?.restore();
  try {
    buildWeb(true);
    console.log('  (负对照收尾：web/dist 已按还原后的源码重建)');
  } catch (e) {
    console.log(`  ⚠ 收尾重建失败：${e instanceof Error ? e.message : String(e)}——dist 仍是缺陷态，下一次跑门别用 SKIP_BUILD`);
  }
}

mkdirSync(OUT_DIR, { recursive: true });
console.log(`T02290 搁置列表失败态门${NEGATIVE ? '【负对照】' : ''} · 桩服 ${BASE} · CDP ${CDP_PORT}`);

const tmpRoot = process.env.T02290_TMP_ROOT ?? 'D:/code/tmp';
if (!existsSync(tmpRoot)) console.log(`  ⚠ T02290_TMP_ROOT=${tmpRoot} 不存在，回落 os.tmpdir()（C 盘满盘会假性失败）`);
const TMP = mkdtempSync(join(existsSync(tmpRoot) ? tmpRoot : tmpdir(), 't02290-gate-'));
const profile = join(TMP, 'chrome');
mkdirSync(profile, { recursive: true });
// 截图根同样钉在 D:（T02312 口径）——未显式指定时 os.tmpdir() 在本机是 C:，满盘时整轮取证文件写不出
if (!process.env.MTASK_GATE_ARTIFACT_DIR) process.env.MTASK_GATE_ARTIFACT_DIR = 'D:/code/tmp/gate-tmp';
const shots = gateShotsDir('t02290-shelved-error');
mkdirSync(shots, { recursive: true });

ok('G-01 Chrome 可执行文件在场（T02290_CHROME 可覆盖）', existsSync(CHROME), CHROME);
// 负对照注入必须先于构建：dist 若在注入前就编译好，跑的仍是修复态，交互组会「全绿」——那种绿是假证据
const negativeControl = NEGATIVE ? applyNegativeControl() : null;
process.on('SIGINT', () => { closeNegative(negativeControl); process.exit(130); });
process.on('SIGTERM', () => { closeNegative(negativeControl); process.exit(143); });
buildWeb(NEGATIVE);
ok('G-02 web/dist 已就绪（index.html 存在）', existsSync(join(DIST, 'index.html')));
const distAt = existsSync(join(DIST, 'index.html')) ? statSync(join(DIST, 'index.html')).mtimeMs : 0;
const srcAt = statSync(SRC).mtimeMs;
ok('G-03 门的判据来自当前源码（dist 不早于 TasksPage.tsx 的 mtime）', SKIP_BUILD ? distAt >= srcAt : true,
  { dist: new Date(distAt).toISOString(), src: new Date(srcAt).toISOString(), skipBuild: SKIP_BUILD });
if (!existsSync(CHROME) || !existsSync(join(DIST, 'index.html'))) {
  lines.push('[ABORT] 通道前置不满足（Chrome 或 dist 缺失），交互组不执行——门不给结论');
  failCount += 1;
} else {
  const stub = stubServer();
  let serverUp = false;
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) { serverUp = true; break; } } catch { /* */ } await sleep(250); }
  ok('G-04 桩服就绪（静态伺服 dist + 可翻转的搁置段故障开关）', serverUp);
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${CDP_PORT}`, '--headless=new', '--no-first-run', '--disable-gpu',
    '--force-device-scale-factor=1', `--user-data-dir=${profile}`, '--window-size=1600,1000', 'about:blank',
  ], { stdio: 'ignore' });
  const killTree = (pid?: number) => { if (pid) { try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } } };
  const bye = () => { killTree(chrome.pid); void stub.close(); for (let i = 0; i < 4; i++) { try { rmSync(TMP, { recursive: true, force: true }); break; } catch { /* 句柄未放 */ } } };
  process.on('exit', bye);
  let cdp: Cdp | null = null;
  try {
    cdp = await connectCdp();
    const ev = makeEval(cdp);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    // 未捕获 rejection 收集：T02290 的修法「只说不打断」，若冒泡出不被接住的拒绝说明 catch 改坏了
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__rej=[];addEventListener("unhandledrejection",(e)=>window.__rej.push(String(e.reason&&e.reason.message||e.reason)));'
        + "['tasks','prompts','report','queue','settings','aitools','req','exec-sessions'].forEach(k=>localStorage.setItem('mtask.guide.seen.'+k,'1'));localStorage.setItem('mtask.projectGuide.seen','1');",
    });
    if (serverUp) await runInteraction(cdp, ev, shots);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ⚠ 门执行异常：${msg}`);
    lines.push(`[CRASH] 门自身执行抛异常（崩溃即门失效，不得当成通过）→ ${msg}`);
    failCount += 1;
  } finally {
    cdp?.close();
    closeNegative(negativeControl);
    process.off('exit', bye);
    bye();
  }
}
closeNegative(negativeControl);

const interaction = lines.filter((l) => /^\[(PASS|FAIL)\] [ABCD]-/.test(l));
const interactionFail = interaction.filter((l) => l.startsWith('[FAIL]')).length;
if (NEGATIVE) {
  const caught = interaction.length > 0 && interactionFail > 0 && negativeRestored;
  lines.unshift(`[NEG] 负对照判定：缺陷形态下交互组 FAIL=${interactionFail}/${interaction.length}`
    + `${negativeRestored ? '' : '，但源码未按字节还原'} —— ${caught ? '门拦得住（合格）' : '门拦不住（失效，必须修门）'}`);
  console.log(`\n${lines[0]}`);
  pass = caught ? 1 : 0;
  failCount = caught ? 0 : 1;
}

const resultsFile = writeGateResults(OUT_DIR, OUT_BASE, `T02290 搁置列表失败态门${NEGATIVE ? '（负对照）' : ''}：PASS=${pass} FAIL=${failCount}\n${lines.join('\n')}\n`, { port: PORT });
console.log(`\nPASS=${pass} FAIL=${failCount} → ${resultsFile}`);
process.exit(failCount === 0 ? 0 : 1);
