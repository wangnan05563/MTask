#!/usr/bin/env node
/**
 * T02290 回归门：桌面任务页「搁置」列表取数失败必须有可见失败态，不得被「暂无搁置任务」空态冒充。
 * 本文件为 T02293「按 `docs/验收门判据规约.md` 四条硬判据改判」版。
 *
 * 拦的是什么（本单缺陷的两种表现，缺一不可）：
 *   ① 冷启动即失败：搁置段 GET 报错 → 页面必须给出「搁置列表加载失败 · 原因」+ 重试入口，
 *      且不再渲染「暂无搁置任务——…」空态；主列表照常渲染（既有取舍：搁置失败不打断主列表）。
 *   ② 成功后刷新失败：旧数据仍在 → 必须标成「可能过期」，不能读起来像「刚拿到的新数据」。
 *
 * 改判口径（服从 T02293）：
 *   - **被测的是 HEAD 那份产品代码，不是工作树**（反模式 11）：门在 `D:/code/tmp` 下 `git worktree add --detach HEAD`
 *     出一份 HEAD 副本、按 junction 挂仓库根 node_modules、在**副本里** `vite build` → 桩服伺服**副本的 dist**。
 *     工作树常年被并发会话改（本轮实测 `TasksPage.tsx` 一度缺 T02290 修复），直接读它会把已有功能判成没实现。
 *   - 全部断言打在**渲染后的 DOM**（CDP 真实指针点击后取 `document`）：失败态钩子、原因文本、空态、重试按钮、
 *     stale 标注——不是读源码正则匹配。
 *   - **中文文案改打实际响应里的文案，并与产品单源常量对表**：`加载失败 · ` / `可能过期` / `重试` 三段契约文案
 *     从 HEAD 的 `web/src/ui/resourceState.tsx` 里抠出来，渲染文本必须逐段等于「`<label>` + 抠出的模板片段」
 *     组装出的期望串——产品改措辞时判据随文案一起移动，不锁死某句字面量。
 *   - `[data-t02213="resource-error"]` 是 T02213 立下的跨页测试钩子（契约），不是样式类名。
 *   - **负对照在 HEAD 副本里做**（原判据 4）：把副本的 `TasksPage.tsx` 改回缺陷形态、重建副本 dist，
 *     同一批 DOM 判据必须转红；真实工作树与他人 WIP 零写入。收尾**先解除 junction 再 `worktree remove`**，
 *     并核对仓库根 node_modules 未被波及。
 *   - 环境缺口（副本/vite/Chrome 任一不可用）记 `skipped()`，交互组不执行、不冒充 PASS。
 *
 * 通道：无外部依赖——门在 HEAD 副本 `vite build` → 内置桩服静态伺服 `dist` + 假 API
 *   → 系统 Chrome(headless=new) 经 CDP 真实指针点击 → 断言 DOM。
 *   断供用两条独立通道各证一次：HTTP 500（带 error 正文）与 **socket 直接 destroy**（连接级故障，
 *   等价于后端进程被杀时的 fetch 失败），后者不依赖任何响应体。
 *
 * 用法：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02290-shelved-error.mts
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02290-shelved-error.mts --negative-control
 *   环境变量：T02290_PORT（默认 39951）、T02290_CDP（默认 39952）、T02290_CHROME、
 *             T02290_GATE_SKIP_BUILD=1 复用副本现有 dist（改过前端源码时别用，G-03 会拦；负对照忽略本开关）、
 *             T02290_TMP_ROOT（默认 D:/code/tmp；C 盘常年 0 可用会假性 SQLITE_FULL/写失败）
 * 负对照判定：跑完要求「缺陷形态下交互组确有 FAIL 且源码逐字节还原」，否则门拦不住＝门失效，判红。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateShotsDir, writeGateResults } from './lib/gate-results.mts';
import { okPair } from './lib/anchor-pair.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NEGATIVE = process.argv.includes('--negative-control');
const PORT = Number(process.env.T02290_PORT ?? 39951);
const CDP_PORT = Number(process.env.T02290_CDP ?? 39952);
const OUT_DIR = join(ROOT, '.workbuddy');
const OUT_BASE = 't02290-shelved-error-gate-results.txt';
const CHROME = process.env.T02290_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = `http://127.0.0.1:${PORT}`;
const SKIP_BUILD = process.env.T02290_GATE_SKIP_BUILD === '1';
const TMP_ROOT = process.env.T02290_TMP_ROOT ?? 'D:/code/tmp';

// —— HEAD 副本：被测产品取自已提交树，绝不受并发工作树污染（反模式 11）——
let WT = '';            // 副本根
let WEB = '';          // 副本 web
let DIST = '';         // 副本 web/dist
let SRC = '';          // 副本 TasksPage.tsx（负对照改的就是它，不碰真实工作树）
let wtReady = false;
let wtWhy = '';
function headShow(rel: string): string | null {
  try { return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch { return null; }
}
function setupHeadCopy(baseTmp: string): boolean {
  WT = join(baseTmp, 'headwt');
  WEB = join(WT, 'web');
  DIST = join(WEB, 'dist');
  SRC = join(WEB, 'src', 'pages', 'TasksPage.tsx');
  try {
    rmSync(WT, { recursive: true, force: true }); // 幂等：清掉上轮可能残留
    execFileSync('git', ['worktree', 'add', '--detach', WT, 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
    symlinkSync(join(ROOT, 'node_modules'), join(WT, 'node_modules'), 'junction');
    wtReady = existsSync(SRC) && existsSync(join(WT, 'node_modules', 'vite', 'bin', 'vite.js'));
    if (!wtReady) wtWhy = '副本缺 TasksPage.tsx 或 vite';
  } catch (e) {
    wtReady = false; wtWhy = e instanceof Error ? e.message : String(e);
  }
  return wtReady;
}
function teardownHeadCopy(): { unlinked: boolean; removed: boolean; rootIntact: boolean } {
  let unlinked = false; let removed = false;
  if (WT) {
    try { rmSync(join(WT, 'node_modules'), { force: true }); unlinked = !existsSync(join(WT, 'node_modules')); } catch { /* */ }
    try { execFileSync('git', ['worktree', 'remove', '--force', WT], { cwd: ROOT, encoding: 'utf8' }); removed = !existsSync(WT); } catch { /* */ }
  }
  return { unlinked, removed, rootIntact: existsSync(join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')) };
}

/** 桩服故障开关：门在场景之间原地翻转，不需要重启服务 */
const fail: { mode: 'off' | 'http500' | 'destroy' } = { mode: 'off' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let failCount = 0;
let skipCount = 0;
const lines: string[] = [];
const pageErrors: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) pass += 1; else failCount += 1;
  const tail = cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 320)}`;
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${tail}`);
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${tail}`);
};
// 环境缺口记 skipped()——既不算 PASS 也不算 FAIL（规约判据 4：不得用假绿冒充被跳过的通道）
const skipped = (name: string, why: string) => {
  skipCount += 1;
  lines.push(`[SKIP] ${name} —— ${why}`);
  console.log(`  [SKIP] ${name} —— ${why}`);
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
// 搁置段 ResourceHint 的 label（HEAD TasksPage 里 label="搁置列表"）；A/B 组已断言 DOM 文案含此串
const LABEL = '搁置列表';
/**
 * 契约文案取自共享失败态层 `web/src/ui/resourceState.tsx`（HEAD 那份，单源）。
 * 判据不锁死某句字面量，而是**读产品定义的措辞模板**：产品改措辞时这里随模板一起移动，
 * 由 `expectFail()` 组装出的期望串与 DOM 实际文案对表。抠不到模板 = 单源契约缺失（字面腿转红）。
 */
function contractCopy(): { connector: string; staleToken: string; retryToken: string } {
  const rs = headShow('web/src/ui/resourceState.tsx') ?? '';
  const m = rs.match(/\{label\}([^{}]*?)\{view\.error\}/); // 期望捕获「加载失败 · 」
  return {
    connector: m ? m[1] : '',
    staleToken: rs.includes('可能过期') ? '可能过期' : '',
    retryToken: /重试/.test(rs) ? '重试' : '',
  };
}
/** 用产品单源模板组装「冷启动失败」期望文案前缀（label + 连接器 + 原因），供与 DOM 逐字符对表 */
function expectFail(c = contractCopy()): string {
  return `${LABEL}${c.connector}${STUB_REASON}`;
}
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

/**
 * 页面现场摘要：失败态钩子、空态文案、夹具行是否在场。
 * ⚠ T02293 改判：探针**不用产品文案当选择器**。「哪一条提示属于搁置段」由门自己的桩令牌
 *   （STUB_REASON，只有搁置那个端点会返回它）认领，令牌读不到时退「全场只有一条提示」这一
 *   结构事实（桩只掐搁置一段，主列表永远不会失败）。中文串因此只出现在 okPair 的字面腿里——
 *   产品改词时选择器不会拿错对象，字面腿会红着把「文案变了」这件事交到人手上。
 */
const PROBE = `
  const hints = [...document.querySelectorAll('[data-t02213="resource-error"]')].map(e => (e.textContent ?? '').replace(/\\s+/g, ' ').trim());
  const body = (document.body.innerText ?? '').replace(/\\s+/g, ' ');
  const tok = ${JSON.stringify(STUB_REASON)};
  const withTok = hints.find(h => h.includes(tok));
  const shelved = withTok ?? (hints.length === 1 ? hints[0] : '');
  const btns = [...document.querySelectorAll('[data-t02213="resource-error"] button')].map(b => (b.textContent ?? '').replace(/\\s+/g, ' ').trim());
  return {
    mounted: (document.querySelector('#root')?.children.length ?? 0) > 0,
    hints,
    shelvedHint: shelved,
    todoHint: hints.filter(h => h !== shelved).join(' | '),
    retryBtn: hints.length > 0 && btns.length > 0,
    btnTexts: btns,
    emptyState: body.includes('暂无搁置任务'),
    staleMark: body.includes('可能过期'),
    hasTodo: body.includes('门夹具活待办样本'),
    hasShelved: body.includes('门夹具活搁置样本'),
    rejections: (window.__rej ?? []),
  };
`;
/** 从 DOM 实际串里反解出产品自己渲染的 label（连接器取自 HEAD 单源模板，不新造字面量） */
function labelFromHint(hint: string, connector: string): string {
  const i = connector ? hint.indexOf(connector) : -1;
  return i > 0 ? hint.slice(0, i) : '';
}

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
  okPair(ok, 'A-02 正常态：不出现「搁置列表加载失败」提示（不虚报故障）',
    () => base.hints.length === 0 && String(base.shelvedHint ?? '') === '',
    () => base.hints.every((h: string) => !h.includes(LABEL) && !h.includes(contractCopy().connector)),
    () => ({ hints: base.hints }));
  okPair(ok, 'A-03 正常态：有数据时不显示「暂无搁置任务」空态',
    () => base.hasShelved === true && base.hints.length === 0,
    () => base.emptyState === false,
    () => ({ emptyState: base.emptyState, hasShelved: base.hasShelved }));

  fail.mode = 'http500';
  const cold = await reloadToShelvedTab(cdp, ev);
  okPair(ok, 'B-01 冷启动 500：搁置区给出可见失败态（含「搁置列表」与「加载失败」）',
    () => cold.hints.length === 1 && cold.shelvedHint.includes(STUB_REASON),
    () => cold.shelvedHint.includes('搁置列表') && cold.shelvedHint.includes('加载失败'),
    () => ({ hint: cold.shelvedHint, hints: cold.hints }));
  ok('B-02 冷启动 500：失败原因真的透到界面（不是泛化文案）', cold.shelvedHint.includes(STUB_REASON), cold.shelvedHint);
  // 中文文案不锁死字面量：把 DOM 实际串与「共享失败态层单源模板组装出的期望串」对表（行为腿=原因透到界面，字面腿=模板仍在且组装一致）
  okPair(ok, 'B-09 冷启动 500：失败态文案 == 由 resourceState 单源模板组装的期望串（措辞随产品移动）',
    () => {
      const c = contractCopy();
      // 行为腿用**运行时反解出的 label**：DOM 里那条提示的前段就是产品渲染的 label，
      // 它非空、且与连接器+原因按模板顺序拼起来正好等于整条提示——不依赖门里抄的那份词。
      const rt = labelFromHint(cold.shelvedHint, c.connector);
      return rt.length > 0 && cold.shelvedHint === `${rt}${c.connector}${cold.shelvedHint.slice(rt.length + c.connector.length)}`
        && cold.shelvedHint.slice(rt.length + c.connector.length).startsWith(STUB_REASON);
    },
    () => {
      const c = contractCopy();
      return c.connector !== '' && c.retryToken === '重试' && c.staleToken === '可能过期'
        && cold.shelvedHint.startsWith(expectFail(c));
    },
    () => ({ hint: cold.shelvedHint, expected: expectFail(), 运行时label: labelFromHint(cold.shelvedHint, contractCopy().connector) }));
  okPair(ok, 'B-03 冷启动 500：不再用「暂无搁置任务」空态冒充正常',
    () => cold.hints.length === 1 && cold.shelvedHint.includes(STUB_REASON),
    () => cold.emptyState === false,
    () => ({ emptyState: cold.emptyState, hint: cold.shelvedHint }));
  okPair(ok, 'B-04 冷启动 500：主列表未被牵连（无「任务列表」失败态）',
    () => String(cold.todoHint ?? '') === '' && cold.hints.length === 1,
    () => cold.hints.every((h: string) => !h.includes('任务列表')),
    () => ({ shelved: cold.shelvedHint, todo: cold.todoHint, all: cold.hints }));
  okPair(ok, 'B-05 冷启动 500：给出重试入口（钩子里真有按钮＝入口可点，文案是字面腿）',
    () => cold.retryBtn === true && Array.isArray(cold.btnTexts) && cold.btnTexts.length >= 1,
    () => cold.btnTexts.some((t: string) => t.includes('重试')),
    () => ({ btnTexts: cold.btnTexts }));
  ok('B-06 冷启动 500：异常被接住，无未捕获 rejection', Array.isArray(cold.rejections) && cold.rejections.length === 0, cold.rejections);
  await (async () => { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); if (r?.data) writeFileSync(join(shots, 'B-cold-500.png'), Buffer.from(String(r.data), 'base64')); })();

  fail.mode = 'destroy';
  const conn = await reloadToShelvedTab(cdp, ev);
  okPair(ok, 'B-07 连接级断供（socket 直接断，等价后端进程被杀）同样给出失败态',
    // 断供时原因由 fetch/浏览器给出（不是桩令牌），所以行为腿认结构：全场恰有一条失败态、
    // 且它带一个可点的重试入口——这才叫「有出口」，与文案无关。
    () => conn.hints.length === 1 && conn.retryBtn === true && conn.emptyState === false,
    () => conn.shelvedHint.includes('搁置列表') && conn.shelvedHint.includes('加载失败'),
    () => ({ hint: conn.shelvedHint, hints: conn.hints, emptyState: conn.emptyState }));
  okPair(ok, 'B-08 连接级断供：原因可读且无未捕获 rejection',
    () => {
      const c = contractCopy();
      const rt = labelFromHint(conn.shelvedHint, c.connector);
      // 「原因可读」= 模板连接器之后还有非空正文（长度判据，不锁某句错误消息）
      return rt.length > 0 && conn.shelvedHint.slice(rt.length + c.connector.length).trim().length > 0
        && (conn.rejections ?? []).length === 0;
    },
    () => conn.shelvedHint.replace(`${LABEL}${contractCopy().connector}`, '').trim().length > 0 && (conn.rejections ?? []).length === 0,
    () => ({ hint: conn.shelvedHint, rejections: conn.rejections }));

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
  okPair(ok, 'C-03 刷新失败：给出「搁置列表加载失败」且标注「可能过期」',
    // 行为腿是 stale 的定义本身：既报失败（原因在场）又仍留着上一次的旧数据
    () => stale.shelvedHint.includes(STUB_REASON) && stale.hasShelved === true,
    () => stale.shelvedHint.includes('搁置列表') && stale.staleMark === true,
    () => ({ hint: stale.shelvedHint, staleMark: stale.staleMark, hasShelved: stale.hasShelved }));
  okPair(ok, 'C-04 刷新失败：不再显示「暂无搁置任务」空态',
    () => stale.hints.length === 1 && stale.shelvedHint.includes(STUB_REASON),
    () => stale.emptyState === false,
    () => ({ emptyState: stale.emptyState }));

  // 恢复：把故障关掉后点重试——失败态必须整条消失且不残留「可能过期」
  fail.mode = 'off';
  let recovered: any = null;
  ok('D-01 点重试（真实指针点击）可恢复（结构判据：钩子清空 + 夹具行回位）', await (async () => {
    const p = await ev(`
      const b = document.querySelector('[data-t02213="resource-error"] button');
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
    recovered = await probe(ev);
    return recovered?.hints?.length === 0 && recovered?.hasShelved === true;
  })(), undefined);
  okPair(ok, 'D-01b 恢复后文案侧不留痕（「可能过期」标注与失败态文案都不在场）',
    () => recovered !== null && recovered.hints.length === 0 && recovered.shelvedHint === '' && recovered.hasShelved === true,
    () => recovered !== null && recovered.staleMark === false && recovered.emptyState === false
      && recovered.hints.every((h: string) => !h.includes(LABEL)),
    () => ({ recovered: recovered && { hints: recovered.hints, staleMark: recovered.staleMark, emptyState: recovered.emptyState } }));

  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  if (r?.data) writeFileSync(join(shots, 'D-recovered.png'), Buffer.from(String(r.data), 'base64'));
  ok('D-02 全程页面未捕获异常为 0（失败态接线没引入新崩溃）', pageErrors.length === 0, pageErrors.slice(0, 3));

  // 字面腿自己的牙齿（T02293 反模式 20）：配对里的字面判据不能是恒真正则——
  // ① 反解函数对空串/空连接器必须给不出 label（否则「label 非空」那条行为腿是空判据）；
  // ② 按 HEAD 模板原样组装必须与 DOM 实际串相等（证明相等是拼对了，不是巧合）；
  // ③ 把 label 换成门没用过的词，同一组装式必须立刻失配（产品改词时字面腿会红着交人，不会假绿）。
  {
    const c = contractCopy();
    const assembled = expectFail(c);
    const drift = assembled.replace(LABEL, '搁置清单（门未使用）');
    ok('B-10 字面腿牙齿：反解函数在空输入上给不出 label、HEAD 模板原样组装与 DOM 串相等、label 一漂即失配（B-09 的字面判据对文案漂移敏感，不是恒真正则）',
      labelFromHint('', c.connector) === '' && labelFromHint(cold.shelvedHint, '') === ''
        && cold.shelvedHint.startsWith(assembled) && drift !== assembled && !cold.shelvedHint.startsWith(drift),
      { 连接器: c.connector, 组装: assembled.slice(0, 40), 漂移: drift.slice(0, 40), 实际: cold.shelvedHint.slice(0, 40) });
  }
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
let pristineCopy: string | null = null; // 负对照写的是隔离副本，逐字基线取自 git show HEAD（不落磁盘备份文件）

function applyNegativeControl(): { restore: () => void } | null {
  if (SRC.startsWith(join(ROOT, 'web'))) throw new Error('负对照防线：SRC 竟指向真实工作树——绝不写它');
  // 副本由 `git worktree add --detach HEAD` 生成，源码逐字取自已提交树；REVERTS 命中即证明副本带着 HEAD 的 T02290 形态
  const original = readFileSync(SRC, 'utf8');
  const fromHead = headShow('web/src/pages/TasksPage.tsx');
  // 换行符可能因 autocrlf 而不同，归一后比对，确保「被测的确就是 HEAD 那份」而非别的 WIP
  if (fromHead !== null && original.replace(/\r\n/g, '\n') !== fromHead.replace(/\r\n/g, '\n')) {
    throw new Error('负对照前置失败：HEAD 副本 TasksPage.tsx 与 git show 归一后仍不一致（隔离副本被污染？）');
  }
  pristineCopy = original;
  // worktree checkout 可能是 CRLF，而 REVERTS 按 LF 编写：归一后再打补丁，缺陷文本落盘；还原仍按逐字 pristineCopy
  let patched = original.replace(/\r\n/g, '\n');
  for (const [re, to] of REVERTS) {
    if (!re.test(patched)) throw new Error(`负对照锚点未命中（HEAD 源码形态变了，请同步本脚本）：${re.source.slice(0, 80)}`);
    patched = patched.replace(re, to);
  }
  writeFileSync(SRC, patched, 'utf8');
  console.log('  负对照：已把 HEAD 隔离副本的 TasksPage.tsx 改回缺陷形态（真实工作树零写入）');
  return { restore: () => restoreNegative(patched) };
}

/**
 * 还原守卫的比对基准是「门自己写进副本的缺陷形态」：
 * 副本在门独占的临时 worktree 内，正常无第三方并发；仍按「与门写的缺陷文本一致才逐字还原」把关，
 * 一旦不一致（副本被别处动过）就不覆盖、点名人工，且 E-01 判红。收尾后整个 worktree 会被拆除。
 */
function restoreNegative(patched: string): void {
  if (pristineCopy === null || !existsSync(SRC)) return;
  const now = readFileSync(SRC, 'utf8');
  if (now !== patched) {
    negativeRestored = false;
    console.log('  ⚠ 负对照还原被拦：隔离副本源码在门运行期间被改动——不覆盖，请人工核对');
    return;
  }
  writeFileSync(SRC, pristineCopy, 'utf8');
  negativeRestored = readFileSync(SRC, 'utf8') === pristineCopy;
  ok('E-01 负对照收尾：HEAD 副本源码按字节还原（缺陷态不残留于任何持久位置）', negativeRestored, SRC);
}

// ---------------- 主流程 ----------------
/**
 * 负对照收尾（幂等）：把 HEAD 副本源码逐字还原 → 按还原后的源码重建副本 dist。
 * 收尾后整个 worktree 会被 teardownHeadCopy 拆除，故「缺陷态」绝不外泄到真实工作树；
 * 这里仍坚持先还原再重建，是为了让 E-01「按字节还原」在拆除前确有对证，而非事后无从核对。
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

// —— 临时根与产物根一律钉在 D:（C 盘常年 0 可用会假性 SQLITE_FULL / 写失败）——
const tmpRoot = existsSync(TMP_ROOT) ? TMP_ROOT : tmpdir();
if (!existsSync(TMP_ROOT)) console.log(`  ⚠ T02290_TMP_ROOT=${TMP_ROOT} 不存在，回落 os.tmpdir()（本机 os.tmpdir 可能是 C:）`);
const TMP = mkdtempSync(join(tmpRoot, 't02290-gate-'));
const profile = join(TMP, 'chrome');
mkdirSync(profile, { recursive: true });
if (!process.env.MTASK_GATE_ARTIFACT_DIR) process.env.MTASK_GATE_ARTIFACT_DIR = 'D:/code/tmp/gate-tmp';
const shots = gateShotsDir('t02290-shelved-error');
mkdirSync(shots, { recursive: true });

// —— 收尾总闸：先解除 junction、再 worktree remove、最后删 TMP；顺序颠倒会把 junction 指向的仓库根依赖一并端走 ——
let chromeProc: ReturnType<typeof spawn> | null = null;
let stubRef: { close: () => Promise<void> } | null = null;
let copyMounted = false;
let tmpPurged = false;
function hardCleanup(): void {
  try { if (chromeProc?.pid) spawn('taskkill', ['/pid', String(chromeProc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ }
  try { void stubRef?.close(); } catch { /* */ }
  if (copyMounted) { teardownHeadCopy(); copyMounted = false; }
  if (!tmpPurged) { for (let i = 0; i < 5; i++) { try { rmSync(TMP, { recursive: true, force: true }); tmpPurged = true; break; } catch { /* 句柄未放 */ } } }
}
process.on('exit', hardCleanup);
process.on('SIGINT', () => { hardCleanup(); process.exit(130); });
process.on('SIGTERM', () => { hardCleanup(); process.exit(143); });

// —— 被测产品取 HEAD 隔离副本（反模式 11：工作树常年被并发会话改，直接读它会把已有功能判成没实现）——
const copyReady = setupHeadCopy(TMP);
copyMounted = copyReady;
ok('G-01 HEAD 隔离副本就绪（git worktree checkout + node_modules junction）', copyReady, copyReady ? { WT } : wtWhy);
const wtHadContent = copyReady && existsSync(SRC) && existsSync(join(DIST, '..', 'package.json')); // 拆残留底账：证明副本曾非空，拆除判据才有牙

let negativeControl: { restore: () => void } | null = null;
if (!copyReady) {
  // 副本通道起不来＝环境缺口，整条交互通道 skipped，不冒充 PASS（负对照模式下牙齿无从证明，交末尾判红）
  skipped('G-02 vite 构建 HEAD 副本', `副本未就绪：${wtWhy}`);
  skipped('G-03 判据来自当前源码', '副本缺失');
  skipped('G-04 桩服就绪', '副本缺失');
  skipped('交互组 A/B/C/D（失败态断言）', '副本缺失——环境缺口，不计 PASS');
} else if (!existsSync(CHROME)) {
  skipped('G-02 vite 构建 HEAD 副本', `Chrome 缺失：${CHROME}——无浏览器无法取证，整通道跳过`);
  skipped('G-03 判据来自当前源码', '同上');
  skipped('G-04 桩服就绪', '同上');
  skipped('交互组 A/B/C/D（失败态断言）', `Chrome 缺失：${CHROME}`);
} else {
  // 负对照注入必须先于构建：dist 若在注入前就编译好，跑的仍是修复态，那种绿是假证据
  negativeControl = NEGATIVE ? applyNegativeControl() : null;
  let buildErr = '';
  try { buildWeb(NEGATIVE); } catch (e) { buildErr = e instanceof Error ? e.message : String(e); }
  const distIndex = join(DIST, 'index.html');
  ok('G-02 vite 构建 HEAD 副本 → web/dist 就绪（index.html 存在）', buildErr === '' && existsSync(distIndex), buildErr || DIST);
  const distAt = existsSync(distIndex) ? statSync(distIndex).mtimeMs : 0;
  const srcAt = existsSync(SRC) ? statSync(SRC).mtimeMs : 0;
  ok('G-03 门的判据来自当前副本源码（每轮重建；SKIP_BUILD 时须 dist 不早于 TasksPage.tsx 的 mtime）',
    SKIP_BUILD ? distAt >= srcAt : buildErr === '',
    { dist: new Date(distAt).toISOString(), src: new Date(srcAt).toISOString(), skipBuild: SKIP_BUILD });

  stubRef = stubServer();
  let serverUp = false;
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) { serverUp = true; break; } } catch { /* */ } await sleep(250); }
  ok('G-04 桩服就绪（静态伺服副本 dist + 可翻转的搁置段故障开关）', serverUp);
  chromeProc = spawn(CHROME, [
    `--remote-debugging-port=${CDP_PORT}`, '--headless=new', '--no-first-run', '--disable-gpu',
    '--force-device-scale-factor=1', `--user-data-dir=${profile}`, '--window-size=1600,1000', 'about:blank',
  ], { stdio: 'ignore' });
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
    else skipped('交互组 A/B/C/D（失败态断言）', '桩服未就绪——环境缺口');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ⚠ 门执行异常：${msg}`);
    lines.push(`[CRASH] 门自身执行抛异常（崩溃即门失效，不得当成通过）→ ${msg}`);
    failCount += 1;
  } finally {
    cdp?.close();
    closeNegative(negativeControl);
  }
}

// —— 拆除隔离副本：核对仓库根 node_modules 未被 junction 拆除波及（零残留 + 「曾非空」对偶，见规约反模式）——
// 先释放句柄：杀掉 Chrome、关掉桩服，否则 Windows 上 dist 文件句柄未放，worktree remove 会 Permission denied
if (chromeProc?.pid) { try { spawnSync('taskkill', ['/pid', String(chromeProc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } }
if (stubRef) { await stubRef.close(); }
await sleep(500);
if (copyReady) {
  let td = teardownHeadCopy();
  for (let i = 0; i < 12 && !td.removed; i++) { await sleep(400); td = teardownHeadCopy(); } // 句柄释放有延迟，重试直到 worktree 真的拆除
  copyMounted = false; // 已显式拆除，hardCleanup 不重复
  ok('E-02 收尾拆除 HEAD 副本且仓库根依赖未波及（junction 先解除、worktree 移除、根 vite 仍在、副本曾非空）',
    td.rootIntact && td.unlinked && td.removed && wtHadContent, { ...td, wtHadContent });
}
for (let i = 0; i < 5; i++) { try { rmSync(TMP, { recursive: true, force: true }); tmpPurged = true; break; } catch { /* 句柄未放 */ } }

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

const resultsFile = writeGateResults(OUT_DIR, OUT_BASE, `T02290 搁置列表失败态门${NEGATIVE ? '（负对照）' : ''}：PASS=${pass} FAIL=${failCount} SKIP=${skipCount}\n${lines.join('\n')}\n`, { port: PORT });
console.log(`\nPASS=${pass} FAIL=${failCount} SKIP=${skipCount} → ${resultsFile}`);
process.exit(failCount === 0 ? 0 : 1);
