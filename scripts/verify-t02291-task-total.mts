/**
 * T02291 门：桌面任务页「共 N 条」必须取服务端 total，且到底后常驻、旧后端无通道时不猜数。
 *
 * 拦的是两类回归（本单缺陷形态）：
 *   ① 页脚从不显示筛选命中的总条数（`hasMore` 由「本页是否满页」派生，用户分不清「本页 200 条=到底」
 *      与「命中 1234 条只加载了第一页」）；
 *   ② 唯一的页脚在到底后整块消失（调用点 `{hasMore && renderLoadMore()}`）。
 * 另一类是「通道契约」回归：`total=1` 是 T02284 的**加性**通道，旧安装包后端没有它（实测装机 39877
 * 带 total=1 仍回裸数组），所以前端必须按可空信封解析——本门用桩服把两种响应形态各喂一次来钉住。
 *
 * 判据口径（服从 T02293）：
 * - 数据全部由门自造夹具（标题「门夹具总数样本…」），**不连生产实例 39877、不读生产库**；
 * - 断言只锚 `data-t02291="task-total"` 这个显式钩子 + 与桩服侧记录的 `total` 交叉比对，
 *   不锁 CSS 类名/文案排版等实现细节；「请求带 total=1」断言的是服务端契约参数名，不是实现字面量；
 * - 每条改法配负对照：`--negative-control` 把源码退回缺陷形态，交互组必须变红。
 *
 * 用法（必须用 ABI 127 的 node22，环境 Node 24 会让 better-sqlite3 报 ERR_DLOPEN_FAILED）：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02291-task-total.mts
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02291-task-total.mts --negative-control
 *   环境变量：T02291_PORT（默认 39953）、T02291_CDP（默认 39954）、T02291_CHROME、
 *             T02291_GATE_SKIP_BUILD=1 复用现有 web/dist（改过前端源码时别用，G-03 会拦；负对照忽略本开关）、
 *             T02291_TMP_ROOT（默认 D:/code/tmp；C 盘常年 0 可用会假性失败）
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
const OUT_BASE = 't02291-task-total-gate-results.txt';
const BACKUP = join(OUT_DIR, 't02291-task-total-source-backup.tsx');

const NEGATIVE = process.argv.includes('--negative-control');
const PORT = Number(process.env.T02291_PORT ?? 39953);
const CDP_PORT = Number(process.env.T02291_CDP ?? 39954);
const CHROME = process.env.T02291_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = `http://127.0.0.1:${PORT}`;
const SKIP_BUILD = process.env.T02291_GATE_SKIP_BUILD === '1';

/** 与前端 PAGE_SIZE 同值的「本页条数」——门用它构造满页/不满页两种形态 */
const PAGE_ROWS = 200;
/** 桩服给出的「筛选命中总数」：刻意与本页条数不同，用来证明页脚取的是服务端 total */
const STUB_TOTAL = 1234;
/** 关键词命中时的总数（C 组用它断言总数随请求刷新） */
const STUB_FILTERED_TOTAL = 77;

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

// ---------------- 桩服形态开关 ----------------
/**
 * envelope：带 total=1 时回信封（新后端）；bare：无视 total 参数仍回裸数组（旧装机后端）；
 * last：回不满页（2 行）→ 「加载更多」消失，用于断言总数到底后常驻。
 */
const shape = { mode: 'envelope' as 'envelope' | 'bare' | 'last' };
/** 桩服侧收到的 /api/tasks 查询串，供「请求真的带 total=1」「搁置段不带 total」两条契约断言取用 */
const seenQueries: string[] = [];

const T = '2026-10-17T00:00:00.000Z';
const PID = 'gate-t02291-project';
const PROJECTS = [{
  id: PID, name: 'T02291 总数门项目', description: '', sort_weight: 0, created_at: T, updated_at: T,
  todo_count: PAGE_ROWS, done_count: 0, unverified_count: 0, plan_done: 0, plan_doing: 0, plan_open: 0, workspace_path: '',
}];
const mkTask = (i: number, shelved = false) => ({
  id: `gate-t02291-${shelved ? 's' : 't'}${i}`, task_no: `T991${String(i).padStart(2, '0')}`,
  project_id: PID, title: i === 0 ? '门夹具总数样本首行' : `门夹具总数样本-${i}`,
  description: '门内夹具正文，仅用于总数口径断言。', priority: 'normal', status: 'todo',
  verified: false, archived: false, archived_at: null, ai_summary: null, ai_summary_at: null,
  handle_result: null, ai_state: '', retry_count: 0, derived_from: null, history_at: null,
  shelved, user_sort: null, pinned: false, category_id: null, parent_id: null, color: '',
  created_at: T, updated_at: T, images: [],
});
const ROWS = Array.from({ length: PAGE_ROWS }, (_, i) => mkTask(i));
const SHORT_ROWS = [mkTask(0), mkTask(1), mkTask(2)];
const SHELVED_ROWS = [mkTask(0, true)];

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
      seenQueries.push(p.slice('/api/tasks?'.length));
      if (/shelved=1/.test(p)) return json(200, SHELVED_ROWS);
      const kw = new URLSearchParams(p.slice('/api/tasks?'.length)).get('keyword') ?? '';
      if (shape.mode === 'last') return json(200, { items: SHORT_ROWS, total: SHORT_ROWS.length });
      if (kw) {
        const items = SHORT_ROWS;
        return shape.mode === 'bare' ? json(200, items) : json(200, { items, total: STUB_FILTERED_TOTAL });
      }
      if (shape.mode === 'bare') return json(200, ROWS);
      return json(200, { items: ROWS, total: STUB_TOTAL });
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
  if (SKIP_BUILD && !force) { console.log('  (跳过构建：T02291_GATE_SKIP_BUILD=1，复用现有 web/dist)'); return; }
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

async function until(ev: Ev, expr: string, ms = 30_000): Promise<boolean> {
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

/** 页面现场摘要：只认显式钩子与文本内容，不认排版 */
const PROBE = `
  const span = document.querySelector('[data-t02291="task-total"]');
  const body = (document.body.innerText ?? '').replace(/\\s+/g, ' ');
  return {
    mounted: (document.querySelector('#root')?.children.length ?? 0) > 0,
    hasSpan: !!span,
    totalText: span ? (span.textContent ?? '').replace(/\\s+/g, ' ').trim() : '',
    bodyHasTotal: body.includes('共 '),
    hasRows: body.includes('门夹具总数样本首行'),
    loadMoreBtn: [...document.querySelectorAll('button')].some(b => (b.textContent ?? '').includes('加载更多')),
    listCount: document.querySelectorAll('[data-t02291="task-total"]').length,
    rejections: (window.__rej ?? []),
  };
`;

async function probe(ev: Ev): Promise<any> { return ev(PROBE); }

async function reloadAndProbe(cdp: Cdp, ev: Ev): Promise<any> {
  await cdp.send('Page.navigate', { url: `${BASE}/?t=${Date.now()}` });
  await until(ev, `(document.querySelector('#root')?.children.length ?? 0) > 0`, 30_000);
  await until(ev, `document.body.innerText.includes('门夹具')`, 20_000);
  await sleep(1_000);
  return probe(ev);
}

function queriesForMainList(): string[] { return seenQueries.filter((q) => !/shelved=1/.test(q)); }

// ---------------- 交互组 ----------------
async function runInteraction(cdp: Cdp, ev: Ev, shots: string): Promise<void> {
  seenQueries.length = 0;
  shape.mode = 'envelope';
  const base = await reloadAndProbe(cdp, ev);
  ok('A-00 前提：夹具满页进到了界面（桩数据真的渲染，不是空列表）', base.mounted === true && base.hasRows === true, base);
  ok('A-01 信封态：页脚出现「共 N 条」钩子', base.hasSpan === true, base);
  ok(`A-02 页脚数字 = 服务端 total（${STUB_TOTAL}），不是本页条数`,
    base.totalText.includes(String(STUB_TOTAL)) && !base.totalText.includes(String(PAGE_ROWS)), base.totalText);
  ok('A-03 总数钩子只有一个（页脚常驻而非每行重复）', base.listCount === 1, base.listCount);
  ok('A-04 满页时「加载更多」仍在（分页交互未被总数改动打掉）', base.loadMoreBtn === true, base.loadMoreBtn);
  ok('A-05 主列表请求真的带 total=1（T02284 加性通道）',
    queriesForMainList().length > 0 && queriesForMainList().every((q) => /total=1/.test(q)), queriesForMainList().slice(0, 3));
  ok('A-06 搁置段请求不带 total（响应体保持裸数组，不牵动 T02290 路径）',
    seenQueries.some((q) => /shelved=1/.test(q)) && seenQueries.filter((q) => /shelved=1/.test(q)).every((q) => !/total=1/.test(q)),
    seenQueries.filter((q) => /shelved=1/.test(q)));
  ok('A-07 正常态无未捕获 rejection', Array.isArray(base.rejections) && base.rejections.length === 0, base.rejections);
  await (async () => { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); if (r?.data) writeFileSync(join(shots, 'A-envelope.png'), Buffer.from(String(r.data), 'base64')); })();

  // 旧后端形态：带 total=1 仍回裸数组（实测装机 39877 即如此）
  shape.mode = 'bare';
  const bare = await reloadAndProbe(cdp, ev);
  ok('B-01 裸数组回退：主列表照常渲染（信封解析没把列表打空）', bare.hasRows === true, bare);
  ok('B-02 裸数组回退：页脚不显示总数（拿不到就不猜数）', bare.hasSpan === false, bare.totalText);
  ok('B-03 裸数组回退：无未捕获 rejection', Array.isArray(bare.rejections) && bare.rejections.length === 0, bare.rejections);

  // 到底形态：本页不满页 → 「加载更多」消失，但总数必须常驻（本单第 4/5 处改动）
  shape.mode = 'last';
  const last = await reloadAndProbe(cdp, ev);
  ok('D-01 到底（不满页）时「加载更多」消失', last.loadMoreBtn === false, last.loadMoreBtn);
  ok('D-02 到底时总数常驻（页脚不再整块消失）', last.hasSpan === true && last.totalText.includes(String(SHORT_ROWS.length)), last);

  // 筛选变化 → 总数随请求刷新
  shape.mode = 'envelope';
  const pre = await reloadAndProbe(cdp, ev);
  ok('C-01 筛选前总数为未筛选口径', pre.hasSpan === true && pre.totalText.includes(String(STUB_TOTAL)), pre.totalText);
  const typed = await ev(`
    const inp = document.querySelector('input[placeholder^="搜索标题"]');
    if (!inp) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, '门夹具');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return inp.value;
  `);
  await sleep(2_000);
  const filtered = await probe(ev);
  ok('C-02 改关键词后总数随请求刷新为筛选口径（不是停留在旧值）',
    typed === '门夹具' && filtered.hasSpan === true && filtered.totalText.includes(String(STUB_FILTERED_TOTAL)),
    { typed, totalText: filtered.totalText });
  ok('C-03 筛选后列表仍渲染（关键词命中的夹具行在场）', filtered.hasRows === true, filtered);
}

// ---------------- 负对照：把源码退回缺陷形态 ----------------
const REVERTS: Array<[RegExp, string]> = [
  // ① 取数退回不带 total 的裸数组消费
  [/      const pTotal = new URLSearchParams\(p\);\n      pTotal\.set\('total', '1'\);\n[\s\S]*?      setServerTotal\(page\.total\);\n/,
    "      list = await api.get<Task[]>(`/tasks?${p.toString()}`);\n"],
  // ② 状态声明退回（缺陷态没有 serverTotal 这个通道）
  [/ {2}\/\/ T02291：筛选命中的服务端总条数[^\n]*\n {2}const \[serverTotal, setServerTotal\][^\n]*\n/, ''],
  // ③ 页脚退回：无总数 span、按钮不再被 hasMore 包裹
  [/ {6}<div style=\{\{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10, margin: '12px 0' \}\}>\n {8}\{serverTotal != null && \(\n {10}<span data-t02291="task-total"[^\n]*\n {8}\)\}\n {8}\{hasMore && \(\n/,
    "      <div style={{ display: 'flex', justifyContent: 'center', margin: '12px 0' }}>\n"],
  [/          \{loadingMore \? '加载中…' : '加载更多'\}\n        <\/button>\n        \)\}\n/,
    "          {loadingMore ? '加载中…' : '加载更多'}\n        </button>\n"],
  // ④ 调用点退回：到底后页脚整块消失
  [/\n {6}\{renderLoadMore\(\)\}\n/, '\n      {hasMore && renderLoadMore()}\n'],
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
  console.log('  负对照：已把 TasksPage.tsx 退回缺陷形态（原文备份 .workbuddy/t02291-task-total-source-backup.tsx）');
  return { restore: () => restoreNegative(patched) };
}

/**
 * 还原守卫的比对基准是「门自己写进去的缺陷形态」，不是改动前的原文：
 * 一致才说明门运行期间没有第三方插入改动，可安全按备份逐字还原；不一致只报警、不覆盖他人改动。
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
 * 「通道前置不满足」时门会跳过交互组直接收工，收尾照样要跑——否则工作区被留在缺陷形态。
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
console.log(`T02291 任务页「共 N 条」门${NEGATIVE ? '【负对照】' : ''} · 桩服 ${BASE} · CDP ${CDP_PORT}`);

const tmpRoot = process.env.T02291_TMP_ROOT ?? 'D:/code/tmp';
if (!existsSync(tmpRoot)) console.log(`  ⚠ T02291_TMP_ROOT=${tmpRoot} 不存在，回落 os.tmpdir()（C 盘满盘会假性失败）`);
const TMP = mkdtempSync(join(existsSync(tmpRoot) ? tmpRoot : tmpdir(), 't02291-gate-'));
const profile = join(TMP, 'chrome');
mkdirSync(profile, { recursive: true });
// 截图根钉在 D:（T02312 口径）——os.tmpdir() 在本机是 C:，满盘时整轮取证文件写不出
if (!process.env.MTASK_GATE_ARTIFACT_DIR) process.env.MTASK_GATE_ARTIFACT_DIR = 'D:/code/tmp/gate-tmp';
const shots = gateShotsDir('t02291-task-total');
mkdirSync(shots, { recursive: true });

ok('G-01 Chrome 可执行文件在场（T02291_CHROME 可覆盖）', existsSync(CHROME), CHROME);
// 负对照注入必须先于构建：dist 若在注入前编译好，跑的仍是修复态，交互组会给出假的「全绿」
const negativeControl = NEGATIVE ? applyNegativeControl() : null;
process.on('SIGINT', () => { closeNegative(negativeControl); process.exit(130); });
process.on('SIGTERM', () => { closeNegative(negativeControl); process.exit(143); });
buildWeb(NEGATIVE);
ok('G-02 web/dist 已就绪（index.html 存在）', existsSync(join(DIST, 'index.html')));
const distAt = existsSync(join(DIST, 'index.html')) ? statSync(join(DIST, 'index.html')).mtimeMs : 0;
const srcAt = statSync(SRC).mtimeMs;
ok('G-03 门的判据来自当前源码（dist 不早于 TasksPage.tsx 的 mtime）', SKIP_BUILD && !NEGATIVE ? distAt >= srcAt : true,
  { dist: new Date(distAt).toISOString(), src: new Date(srcAt).toISOString(), skipBuild: SKIP_BUILD });
if (!existsSync(CHROME) || !existsSync(join(DIST, 'index.html'))) {
  lines.push('[ABORT] 通道前置不满足（Chrome 或 dist 缺失），交互组不执行——门不给结论');
  failCount += 1;
} else {
  const stub = stubServer();
  let serverUp = false;
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) { serverUp = true; break; } } catch { /* */ } await sleep(250); }
  ok('G-04 桩服就绪（静态伺服 dist + 可切换的信封/裸数组/到底三种响应形态）', serverUp);
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

ok('Z-01 全程页面未捕获异常为 0（总数通道接线没引入新崩溃）', pageErrors.length === 0, pageErrors.slice(0, 3));

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

const resultsFile = writeGateResults(OUT_DIR, OUT_BASE, `T02291 任务页「共 N 条」门${NEGATIVE ? '（负对照）' : ''}：PASS=${pass} FAIL=${failCount}\n${lines.join('\n')}\n`, { port: PORT });
console.log(`\nPASS=${pass} FAIL=${failCount} → ${resultsFile}`);
process.exit(failCount === 0 ? 0 : 1);
