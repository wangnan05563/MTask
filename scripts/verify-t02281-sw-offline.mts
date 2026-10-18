#!/usr/bin/env node
/**
 * T02281 回归门（T02293 改判版）：PWA 断供离线壳——`web/public/sw.js` 的 assets 回写与同名分片剪枝。
 *
 * 拦的是什么：T02281 之前 SW 的 `/assets` 分支「只读不写」，正常浏览一次也留不下带 hash 的主包，
 * 断供 reload 时主 JS `net::ERR_FAILED`、React 根不挂载（移动端白板）。任何人把 SW 改回只读不写，
 * 本门的 pre 组必须复现该症状、post 组必须证伪它——两组同时成立才叫门有效（见「负对照口径」）。
 *
 * 本轮（T02293 改判）改了什么、为什么：
 *  ① 基线实录：改判前自跑 **PASS=25 FAIL=4**（结果文件 t02281-sw-offline-gate-results-11584-20261018-130945.txt，
 *     VERDICT 判「门的判别力不成立」）；而更早 01:12 的同版门曾 29/0。两轮的差别不在被测物，在工作树：
 *     并发会话把工作树 `server/src/index.ts` 停在缺 `MTASK_STATIC_DIR` 的旧暂存版（工作树 0 处命中、
 *     HEAD 3 处命中）——旧版门 a) 用 `readFileSync` 读**工作树**源码做字面锚（反模式 11），
 *     b) 用**工作树** server 入口起实例，于是临时静态目录被无声忽略，实例伺服了主仓 web/dist 的修复版 SW：
 *     缺陷根本没被伺服，P 组 1/4、G-01 红，门对整个工作树状态过敏且红因难读。本版根治：
 *     **全链一律来自 HEAD detached 副本**——server 入口、vite 构建、静态目录内容、字面锚文本
 *     （字面锚取 `git show HEAD:<path>`，绝不读工作树）。
 *  ② 判据换向（规约判据 1）：S-01..S-04 / G-01 从「读源码正则」降级为 okPair 的**字面腿**，
 *     行为腿用真实现测：伺服 sw.js 的 HTTP 响应体/响应头（H 组，Node 侧直连自起实例）、
 *     MTASK_STATIC_DIR 的**在位生效**（往临时目录放门内标记文件，GET 必须按字节取回——
 *     若 env 被忽略会掉进 SPA 兜底拿到 index.html，当场可辨）、SW 接管后的缓存观测
 *     （caches.keys/open 全量遍历，不锁实现字面量）、断供 reload 的挂载与请求失败。
 *     新增 **H 组 4 点**（pre/post 伺服字节逐字比对、sw.js 响应头再校验语义、SPA 兜底路由表行为）、
 *     **N 组 2 点**（N-01 字面腿牙齿：同一判据在内存缺陷形态必红；N-02 跨阶段判别力：
 *     pre/post 的挂载态与伺服字节必须真的不同——两阶段「一致地空」不算绿）。
 *  ③ 负对照（规约判据 3）：pre 组仍是全链真缺陷回放（注入只落临时副本），本版加显式自证：
 *     S-02 行为腿写成**判别式** `pre 期 assets 缓存数 =0 且 post 期 >0`，两相同侧即红；
 *     O-01/O-02 断供通道自检保留（端口不再应答才算「断供」）。
 *  ④ 数据纪律（规约判据 2）：离线回显断言用**门内夹具**——`POST /api/projects` 建项目再取 id，
 *     绝不读生产库业务行；本门起的是全新空库隔离实例（MTask_DATA_DIR 每次 mkdtemp）。
 *  ⑤ 环境缺口 → `skipped()`（不计 PASS），fake PASS 严禁：Chrome 缺席/端口被占/构建失败时
 *     行为组整组记 SKIP，摘要如实标 `SKIP=n` 与「未验证离线行为」。`--source-only` 只跑
 *     S-01/S-05/N-01 字面链并顶 `[DEGRADED]` 标——机制在位 ≠ 断供可用。
 *  ⑥ 副本边界：主仓 web/dist 全程零写入（Z-01/Z-02 逐字节前后核对），缺陷注入只落临时副本；
 *     HEAD 副本用完即拆（先删 junction、再 worktree remove --force、最后 prune）。
 *
 * 判据点数：基线 29 → 本版 36（S×5、G×5、H×4、P×4+O-01、Q×12+O-02、N×2、Z×2）。
 *
 * 用法（Node 须与 better-sqlite3 ABI 对齐，本仓惯例走 tsx）：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02281-sw-offline.mts
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02281-sw-offline.mts --source-only
 *   环境变量：T02281_PORT（默认 39955，避开 39877 生产实例——本门只连自起实例）、T02281_CDP（默认 39956）、
 *             T02281_CHROME、T02281_TMP_ROOT（默认 D:/code/tmp；C 盘常年 0 可用会假性 SQLITE_FULL）、
 *             T02281_KEEP=1 保留临时目录便于排障。旧变量 T02281_GATE_SKIP_BUILD 已随「副本内构建」废除。
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, cpSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { gateShotsDir, writeGateResults } from './lib/gate-results.mts';
import { resolveServerLauncher } from './isolated-server-launcher.mts';
import { okPair } from './lib/anchor-pair.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');
const OUT_BASE = 't02281-sw-offline-gate-results.txt';
/** 字面锚与全部被测文本的来源：HEAD blob（git show），不是工作树（反模式 11） */
const REL_SW = 'web/public/sw.js';
const REL_SERVER = 'server/src/index.ts';

const SOURCE_ONLY = process.argv.includes('--source-only');
const PORT = Number(process.env.T02281_PORT ?? 39955);
const CDP_PORT = Number(process.env.T02281_CDP ?? 39956);
const CHROME = process.env.T02281_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE_NAME = `T02281 离线门项目-${Date.now()}`;
/** 上一构建的同词干产物名——用来逼「回写 + 同名剪枝」这条路走一遍 */
const FAKE_OLD_CHUNK = '/assets/index-OLDEPREBUILD.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let failCount = 0;
let skipCount = 0;
const lines: string[] = [];
const pageErrors: string[] = [];
const failedReq: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) pass += 1; else failCount += 1;
  const tail = cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 320)}`;
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${tail}`);
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${tail}`);
};
/** 环境缺口走这里：不计 PASS、不计 FAIL，摘要如实标 SKIP（规约判据 4：缺口≠通过） */
const skipped = (name: string, why: string) => {
  skipCount += 1;
  lines.push(`[SKIP] ${name} —— ${why}`);
  console.log(`  [SKIP] ${name} —— ${why}`);
};
const info = (s: string) => { lines.push(`[INFO] ${s}`); console.log(`  [INFO] ${s}`); };
const tailOf = (file: string) => { try { return readFileSync(file, 'utf8').slice(-240).replace(/\s+/g, ' '); } catch { return '(还没日志)'; } };

function gitShow(rel: string): string {
  return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// ---------------- 字面锚（全部作用于 HEAD 文本；行为腿见 M 记录） ----------------
const RE_S2 = /includes\('assets'\)[\s\S]{0,600}cache\.put\(req, copy\)/;
const RE_S3 = /\.then\(\(\) => precacheBuildAssets\(\)\)/;
const reS4 = (s: string) => (s.match(/await pruneReplacedChunk\(cache, url\)/g) ?? []).length >= 2;
const RE_G1 = /process\.env\.MTASK_STATIC_DIR/;

// ---------------- 缺陷变体构造（pre 组的注入文本，只写进临时副本） ----------------
const DEFECT_EDITS: Array<[RegExp, string]> = [
  // ① install 期不再从壳里解析清单预缓存 hash 产物（T02281 修复的第一条腿）
  [/\n[ \t]*\/\/ T02281：断供 reload 真正缺的是带 hash 的主包[\s\S]*?\n[ \t]*\.then\(\(\) => precacheBuildAssets\(\)\)/, ''],
  // ② `/assets` 分支退回「只读不写」——正是工单要守住的静默退化形态。
  // 匹配吃到 `}))` 整条尾巴（箭头体 + 内层 .then + 外层 .then），替换体自带闭合括号；
  // 只吃到 `})` 会让行尾多出一个 `)` → SW 语法错、注册失败，pre 组会以「SW 没接管」而非缺陷复现变红。
  [/caches\.match\(req\)\.then\(\(r\) => r \|\| fetch\(req\)\.then\(async \(res\) => \{[\s\S]*?\n[ \t]*\}\)\)/,
    'caches.match(req).then((r) => r || fetch(req))'],
];

function defectiveSw(src: string): string {
  let out = src;
  for (const [re] of DEFECT_EDITS) {
    if (!re.test(out)) throw new Error(`缺陷变体锚点未命中（HEAD:${REL_SW} 形态变了，请同步本门）：${re.source.slice(0, 72)}`);
  }
  for (const [re, to] of DEFECT_EDITS) out = out.replace(re, to);
  return out;
}

// ---------------- 实测记录（行为腿取值晚于测量，发射在链尾——反模式 14） ----------------
interface Measured {
  ranPhases: boolean;
  markerPre: boolean; markerPost: boolean;
  servedPre: string; servedPost: string;
  swHeaders: { status: number; ct: string; cc: string; revalid: boolean };
  fallback: boolean;
  preAssets: number | null; postAssets: number | null;
  indexJs: boolean; pruned: boolean;
  preOfflineMounted: boolean | null; postOfflineMounted: boolean | null;
}
const M: Measured = {
  ranPhases: false, markerPre: false, markerPost: false,
  servedPre: '', servedPost: '', swHeaders: { status: 0, ct: '', cc: '', revalid: false }, fallback: false,
  preAssets: null, postAssets: null, indexJs: false, pruned: false,
  preOfflineMounted: null, postOfflineMounted: null,
};

// ---------------- 隔离实例（真后端【HEAD 副本入口】 + MTASK_STATIC_DIR 指向临时副本） ----------------
let SERVER_ROOT = '';            // HEAD detached 副本根——server 入口与 node_modules 都从这里走
let server: ReturnType<typeof spawn> | null = null;
let chrome: ReturnType<typeof spawn> | null = null;
let LAUNCHER: ReturnType<typeof resolveServerLauncher> | null = null;
const killTree = (pid?: number) => { if (pid) { try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } } };
// 异常收口（memory「门脚本隔离实例收口三坑」）：门被 Ctrl-C / 崩溃时子进程不会自己消失，
// 残留实例占着端口，下一轮端口自检会把它当成「别人已在跑的实例」而拒绝执行。
const teardown = () => { if (server?.pid) killTree(server.pid); if (chrome?.pid) killTree(chrome.pid); };
process.on('exit', teardown);
process.on('SIGINT', () => { teardown(); process.exit(130); });
process.on('SIGTERM', () => { teardown(); process.exit(143); });

async function startServer(tag: string, staticDir: string, dataDir: string): Promise<void> {
  LAUNCHER ??= resolveServerLauncher(SERVER_ROOT, join(SERVER_ROOT, 'server', 'src', 'index.ts'));
  mkdirSync(dataDir, { recursive: true });
  const logFile = join(dataDir, `server-${tag}.log`);
  const fd = openSync(logFile, 'a');
  server = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
    cwd: SERVER_ROOT,
    env: {
      ...process.env, ...LAUNCHER.env,
      // 隔离实例端口的环境变量族是 MTask_*（不是 PORT）——写错则实例落回默认口，撞生产 39877
      MTask_PORT: String(PORT), MTask_DATA_DIR: dataDir, MTask_LOG_DIR: dataDir, MTASK_STATIC_DIR: staticDir,
    },
    stdio: ['ignore', fd, fd],
  });
  const t0 = Date.now();
  let warned = 0;
  for (;;) {
    if (server && server.exitCode !== null) throw new Error(`实例过早退出（${tag}）code=${server.exitCode}，看 ${logFile}`);
    try { if ((await fetch(`${BASE}/api/health`)).ok) { info(`[instance up] ${tag} · 静态目录 ${staticDir} · 用时 ${Math.round((Date.now() - t0) / 1000)}s`); return; } } catch { /* 未就绪 */ }
    const took = Date.now() - t0;
    if (took > 420_000) throw new Error(`实例启动超时（${tag}，${Math.round(took / 1000)}s），看 ${logFile}；端口持有者 ${pidsListening(PORT).join(',') || '(无)'}`);
    // 首轮启动实测 8~60s（重排期/对账/备份都在启动路径上），心跳把「慢」与「挂」区分开
    if (took > warned * 60_000) { warned += 1; info(`[waiting ${Math.round(took / 1000)}s] ${tag} 未就绪，日志尾部：${tailOf(logFile)}`); }
    await sleep(1_000);
  }
}

/** 端口上的应答者必是本门实例（起服前已确认端口空闲），按端口补杀是安全的 */
function pidsListening(port: number): string[] {
  let out = '';
  try { out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' }); } catch { return []; }
  const set = new Set<string>();
  for (const line of out.split('\n')) {
    if (!/LISTENING/i.test(line) || !new RegExp(`:${port}(\\s|$)`).test(line)) continue;
    const pid = line.trim().split(/\s+/).pop() ?? '';
    if (/^\d+$/.test(pid)) set.add(pid);
  }
  return [...set];
}

/** 断供必须是真的：taskkill 是异步的，端口没停应答就 reload，测的还是在线态 */
async function stopServer(tag: string): Promise<boolean> {
  const s = server;
  server = null;
  // 只杀 spawn 回来的 tsx 父进程不够：真正持有端口与 SQLite 句柄的是它的 worker 子进程
  const killAll = () => {
    if (s?.pid) killTree(s.pid);
    for (const pid of pidsListening(PORT)) killTree(Number(pid));
  };
  killAll();
  const t0 = Date.now();
  for (;;) {
    let up = false;
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { /* 已无应答 */ }
    const holders = pidsListening(PORT);
    if (!up && holders.length === 0) { info(`[instance down] ${tag}`); return true; }
    if (Date.now() - t0 > 30_000) { info(`[instance down?] ${tag} 端口仍被 ${holders.join(',') || '(仅应答)'} 持有`); return false; }
    killAll();
    await sleep(1_000);
  }
}

async function seedFixtureProject(): Promise<{ id: string; name: string }> {
  await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FIXTURE_NAME, description: '门内夹具项目，仅用于离线回显断言。' }),
  }).catch(() => { /* 建不成由下一行抛错点名 */ });
  const projects = (await (await fetch(`${BASE}/api/projects`)).json()) as Array<{ id: string; name: string }>;
  const hit = projects.find((p) => p.name === FIXTURE_NAME);
  if (!hit) throw new Error(`夹具项目没建成（POST /api/projects 后 GET 查不到 ${FIXTURE_NAME}）`);
  return { id: hit.id, name: hit.name };
}

// ---------------- Node 侧 HTTP 探针（不借浏览器，绕开 SW/缓存语义，直读伺服事实） ----------------
async function putMarker(staticDir: string): Promise<{ file: string; content: string }> {
  const rand = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const content = `MTASK-GATE-MARKER-${rand}`;
  const file = `gate-marker-${rand}.txt`;
  writeFileSync(join(staticDir, file), content, 'utf8');
  return { file, content };
}
async function markerServed(marker: { file: string; content: string }): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/${marker.file}`, { cache: 'no-store' });
    const body = await r.text();
    // 逐字节等于标记内容才算「静态目录真的被伺服」：SPA 兜底会回 index.html（含 id="root"），
    // 那种「200 但不是我的字节」正是 MTASK_STATIC_DIR 被忽略的形态，不能放行
    return r.status === 200 && body === marker.content;
  } catch { return false; }
}
async function probeSwResponse(): Promise<{ body: string; headers: Measured['swHeaders'] }> {
  const r = await fetch(`${BASE}/sw.js`, { cache: 'no-store' });
  const body = await r.text();
  const ct = String(r.headers.get('content-type') ?? '');
  const cc = String(r.headers.get('cache-control') ?? '');
  const revalid = r.headers.has('etag') || r.headers.has('last-modified');
  return { body, headers: { status: r.status, ct, cc, revalid } };
}
async function probeSpaFallback(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/gate-no-such-route-${Date.now().toString(36)}`, { cache: 'no-store' });
    const body = await r.text();
    return r.status === 200 && body.includes('id="root"');
  } catch { return false; }
}

// ---------------- CDP（无外部依赖：Node 全局 WebSocket） ----------------
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
  const reqUrl = new Map<string, string>();
  const waiting = new Map<number, (v: any) => void>();
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails;
      pageErrors.push(String(d?.exception?.description ?? d?.text ?? '').slice(0, 300));
    }
    if (msg.method === 'Network.requestWillBeSent') reqUrl.set(String(msg.params?.requestId), msg.params?.request?.url ?? '');
    if (msg.method === 'Network.loadingFailed') {
      const u = reqUrl.get(String(msg.params?.requestId)) ?? '';
      failedReq.push(`${msg.params?.type ?? ''} ${u} :: ${msg.params?.errorText ?? ''}`);
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

async function goto(cdp: Cdp, url: string): Promise<void> {
  await cdp.send('Page.navigate', { url });
  await sleep(1_500);
}

/** 真实指针点击（CDP Input.dispatchMouseEvent）——DOM 级 el.click() 会掩盖层叠/遮挡类缺陷 */
async function realClick(cdp: Cdp, ev: Ev, selector: string): Promise<boolean> {
  const p = await ev(`
    const el = document.querySelector(${JSON.stringify(selector)});
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

/** SW 缓存里的 /assets 条目：遍历全部缓存名（不锁 'mtask-v1' 这类实现字面量） */
const EV_ASSETS = `return (async () => {
  const out = [];
  for (const n of await caches.keys()) {
    const c = await caches.open(n);
    for (const r of await c.keys()) {
      const p = new URL(r.url).pathname;
      if (p.includes('/assets/')) out.push({ cache: n, path: p });
    }
  }
  return out;
})()`;
const assetsInCache = (ev: Ev) => ev(EV_ASSETS) as Promise<Array<{ cache: string; path: string }>>;
const waitSwActive = (ev: Ev) => ev(`
  return (async () => {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((r) => setTimeout(() => r(null), 20000)),
    ]);
    return !!(reg && reg.active);
  })()`);
const EV_MOUNTED = `return ((document.querySelector('#root')?.children.length ?? 0) > 0)`;
const EV_OPTIONS = `return [...document.querySelectorAll('header select option')].map(o => (o.textContent ?? '').trim())`;

/** 每阶段一套全新 Chrome profile：SW 接管与 CacheStorage 按 profile 留存，复用会把上一阶段的离线态带进来 */
async function withBrowser<T>(fn: (cdp: Cdp, ev: Ev) => Promise<T>): Promise<T> {
  const profile = mkdtempSync(join(TMP, 'chrome-'));
  chrome = spawn(CHROME, [
    `--remote-debugging-port=${CDP_PORT}`, '--headless=new', '--no-first-run', '--disable-gpu',
    '--force-device-scale-factor=1', `--user-data-dir=${profile}`, '--window-size=390,760', 'about:blank',
  ], { stdio: 'ignore' });
  let cdp: Cdp | null = null;
  try {
    cdp = await connectCdp();
    const ev = makeEval(cdp);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    // 移动端壳：App.tsx 用 matchMedia('(max-width: 820px)') 判定，靠视口而非 UA
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      // 导航失败时 Chrome 会建 chrome-error:// 文档，那里没有可用 origin → localStorage 直接抛 SecurityError，
      // 被 Runtime.exceptionThrown 收走就成了「页面异常」噪声（pre 组首轮实测踩到）。注入脚本一律包 try。
      source: 'try{window.__rej=[];addEventListener("unhandledrejection",(e)=>window.__rej.push(String(e.reason&&e.reason.message||e.reason)));'
        + "localStorage.setItem('mtask.guide.seen.tasks','1');localStorage.setItem('mtask.projectGuide.seen','1');}catch(_){}",
    });
    return await fn(cdp, ev);
  } finally {
    cdp?.close();
    killTree(chrome.pid);
    await sleep(1_200);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 句柄未放，留给 TMP 清理 */ }
  }
}

async function shot(cdp: Cdp, name: string): Promise<void> {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  if (r?.data) writeFileSync(join(shots, `${name}.png`), Buffer.from(String(r.data), 'base64'));
}

// ---------------- pre：缺陷回放（=本门的负对照，注入只落临时副本） ----------------
async function runPre(staticDir: string, dataDir: string, defectText: string): Promise<void> {
  writeFileSync(join(staticDir, 'sw.js'), defectText, 'utf8');
  const marker = await putMarkerSafe(staticDir);
  await startServer('pre-online', staticDir, dataDir);
  // H-01：伺服事实——pre 阶段线上 sw.js 响应体必须逐字节等于注入的缺陷文本（≠修复文本）。
  // 这条腿同时是「MTASK_STATIC_DIR 被真实遵守」的伺服侧证据：旧版污染形态下这里会拿到主仓 dist 的修复版。
  const probe = await probeSwResponse();
  M.servedPre = probe.body;
  ok('H-01 pre 阶段 HTTP 伺服的 sw.js 逐字节等于注入的缺陷文本（伺服通道可信，缺陷真的在线上）',
    probe.body === defectText && probe.body !== HEAD_SW,
    { status: probe.headers.status, got: probe.body.slice(0, 90), want: 'defect' });
  M.markerPre = await markerServed(marker);
  await withBrowser(async (cdp, ev) => {
    await goto(cdp, `${BASE}/?m=pre`);
    await until(ev, `document.querySelectorAll('header select option').length > 0`);
    ok('P-00 修复前 SW 已接管（门打的确实是离线壳，不是普通网页）', (await waitSwActive(ev)) === true);
    const cached = await assetsInCache(ev);
    M.preAssets = cached.length;
    ok('P-01 修复前正常浏览后 /assets 仍不进 SW 缓存（回写缺失即工单根因）', cached.length === 0, cached.slice(0, 4));
    ok('O-01 pre 断供通道自检：实例端口确实不再应答（否则「断供」是假的）', await stopServer('pre-outage'));
    failedReq.length = 0;
    await goto(cdp, `${BASE}/`);
    await sleep(2_500);
    const assetsFailed = failedReq.filter((s) => s.includes('/assets/'));
    const mounted = await ev(EV_MOUNTED).catch(() => false);
    M.preOfflineMounted = mounted === true;
    ok('P-02 修复前断供 reload 主 JS 请求失败（net::ERR_FAILED 类）', assetsFailed.length > 0, assetsFailed.slice(0, 2));
    ok('P-03 修复前断供 reload React 根未挂载（白板，即工单症状）', mounted === false, { mounted, failed: failedReq.length });
    await shot(cdp, 'pre-white');
    info(`pre 页面异常 ${pageErrors.slice(0, 2).join(' | ') || '(无)'}（缺陷态本就崩，不作判据）`);
  });
}

async function putMarkerSafe(staticDir: string) {
  try { return await putMarker(staticDir); }
  catch (e) { info(`标记文件写入失败（${e instanceof Error ? e.message : e}），对应阶段行为腿会如实转红`); return { file: 'gate-marker-missing.txt', content: '(missing)' }; }
}

// ---------------- post：修复版验收（工单 11 条 + 缓存自净 + 伺服事实） ----------------
async function runPost(staticDir: string, dataDir: string): Promise<void> {
  writeFileSync(join(staticDir, 'sw.js'), HEAD_SW, 'utf8');
  const marker = await putMarkerSafe(staticDir);
  await startServer('post-online', staticDir, dataDir);
  // H-02/H-03：修复态的伺服事实（响应体逐字节、响应头的再校验语义）
  const probe = await probeSwResponse();
  M.servedPost = probe.body;
  ok('H-02 post 阶段 HTTP 伺服的 sw.js 逐字节等于 HEAD 修复文本（且不同于缺陷文本）',
    probe.body === HEAD_SW && probe.body !== M.servedPre, { status: probe.headers.status, bytes: probe.body.length });
  ok('H-03 sw.js 以静态资产形态伺服：200 + JS 类 content-type + ETag/Last-Modified + 不固化 max-age（SW 更新每次回源再校验）',
    probe.headers.status === 200
    && /javascript/.test(probe.headers.ct)
    && probe.headers.revalid
    && !/max-age=[1-9]\d*/.test(probe.headers.cc),
    probe.headers);
  M.fallback = await probeSpaFallback();
  ok('H-04 SPA 兜底路由表行为在场：未知 GET 路径回 index.html（标记文件按字节命中因此不可能是兜底假绿）', M.fallback);
  M.markerPost = await markerServed(marker);
  const fixture = await seedFixtureProject();
  const projects = (await (await fetch(`${BASE}/api/projects`)).json()) as Array<{ id: string; name: string }>;
  await withBrowser(async (cdp, ev) => {
    await goto(cdp, `${BASE}/?m=post`);
    await until(ev, `document.querySelectorAll('header select option').length > 0`);
    ok('Q-00 修复后 SW 已接管', (await waitSwActive(ev)) === true);
    const hintsOnline = (await ev(`return [...document.querySelectorAll('[data-t02201="project-list-error"]')].map(e => e.textContent ?? '')`)) as string[];
    const onlineOptions = (await ev(EV_OPTIONS)) as string[];
    ok('Q-01 正常态无失败提示，且夹具项目真的进了下拉（门内夹具经 POST /api/projects 建成——不读生产业务行）',
      hintsOnline.length === 0 && onlineOptions.some((o) => o.includes(FIXTURE_NAME)),
      { hints: hintsOnline, options: onlineOptions, apiProjects: projects.length });

    // 注意别写成 `.some(async n => …)`——some 把返回的 Promise 当 truthy，第一条缓存名就会假绿
    const precached = await until(ev, `(async () => {
      const names = await caches.keys();
      const hits = await Promise.all(names.map(async (n) => {
        const c = await caches.open(n);
        return (await c.keys()).some((r) => /\\/assets\\/index-[^/]+\\.js$/.test(new URL(r.url).pathname));
      }));
      return hits.some(Boolean);
    })()`, 25_000);
    const found = await assetsInCache(ev);
    M.indexJs = precached === true;
    M.postAssets = found.length;
    ok('Q-02 验收①前提：主 JS 已进 SW 缓存（install 清单预缓存 + 未命中回写）', precached && found.length > 0, found.slice(0, 6));
    const real = found.find((x) => /\/index-[^/]+\.js$/.test(x.path));
    if (real) {
      const injected = await ev(`
        return (async () => {
          const c = await caches.open(${JSON.stringify(real.cache)});
          const hit = await c.match(${JSON.stringify(real.path)});
          if (!hit) return 'no-hit';
          await c.put(${JSON.stringify(FAKE_OLD_CHUNK)}, hit);
          await c.delete(${JSON.stringify(real.path)});
          return 'ok';
        })()`);
      await goto(cdp, `${BASE}/`);
      const pruned = await until(ev, `(async () => {
        const c = await caches.open(${JSON.stringify(real.cache)});
        const ks = (await c.keys()).map((r) => new URL(r.url).pathname).filter((p) => /\\/index-[^/]+\\.js$/.test(p));
        return ks.length === 1 && ks[0] === ${JSON.stringify(real.path)};
      })()`, 20_000);
      M.pruned = injected === 'ok' && pruned;
      ok('Q-03 同名分片只留最新（hash 换代不留垃圾堆积）', M.pruned,
        { injected, after: await assetsInCache(ev) });
    } else {
      ok('Q-03 同名分片只留最新（hash 换代不留垃圾堆积）', false, { real: null, found: found.slice(0, 4) });
    }

    await ev(`return (() => {
      localStorage.setItem('mtask.mobile.lastProject', ${JSON.stringify(fixture.id)});
      localStorage.setItem('mtask.mobile.lastProjectName', ${JSON.stringify(fixture.name)});
      return true;
    })()`);
    ok('O-02 post 断供通道自检：实例端口确实不再应答（否则「断供」是假的）', await stopServer('post-outage'));
    failedReq.length = 0;
    await goto(cdp, `${BASE}/`);
    const mounted = await ev(EV_MOUNTED).catch(() => false);
    M.postOfflineMounted = mounted === true;
    ok('Q-04 验收①断供 reload 页面挂载（React root 存在）', mounted === true, { mounted, navFailed: failedReq.slice(0, 2) });
    ok('Q-05 验收①附带：断供 reload 无 /assets 请求失败（全走缓存）',
      failedReq.filter((s) => s.includes('/assets/')).length === 0, failedReq.slice(0, 3));
    if (mounted) {
      await until(ev, `!!document.querySelector('[data-t02201="project-list-error"]')`);
      const hintText = String(await ev(`const e = document.querySelector('[data-t02201="project-list-error"]');
        return e ? e.textContent.replace(/\\s+/g, ' ').trim() : '';`) ?? '');
      ok('Q-06 验收②项目下拉失败态可见（真实文案）', hintText.includes('项目列表加载失败'), hintText.slice(0, 140));
      ok('Q-07 验收②失败态带真实原因 + 重试入口',
        /failed to fetch|fetch failed|networkerror|err_connection_refused|网络|连接/i.test(hintText)
        && (await ev(`return !!document.querySelector('button[aria-label="重试加载项目列表"]')`)) === true, hintText.slice(0, 140));
      const firstOption = String(await ev(`return (document.querySelector('header select option')?.textContent ?? '').trim()`) ?? '');
      ok('Q-08 验收③上次项目名回显（列表没取到也讲清在用哪个项目——回显源是门内夹具）',
        firstOption.includes('上次项目：') && firstOption.includes(fixture.name.slice(0, 4)), firstOption);
      await shot(cdp, 'post-offline');
    }
    ok('Q-09 验收④全程无页面脚本异常', pageErrors.length === 0, pageErrors.slice(0, 3));
    const rejections = (await ev(`return (window.__rej ?? [])`)) as string[];
    await startServer('post-recover', staticDir, dataDir);
    const clicked = await realClick(cdp, ev, 'button[aria-label="重试加载项目列表"]');
    const recovered = await until(ev, `!document.querySelector('[data-t02201="project-list-error"]')`, 25_000);
    const afterOptions = (await ev(EV_OPTIONS)) as string[];
    info(`post 失败请求样本 ${failedReq.slice(0, 3).join(' || ') || '(无)'}`);
    ok('Q-10 验收⑤重启后端后重试恢复真实项目', clicked && recovered && afterOptions.length === onlineOptions.length,
      { clicked, recovered, options: afterOptions.length, expected: onlineOptions.length });
    await shot(cdp, 'post-recovered');
    ok('Q-11 离线态未冒出未捕获 rejection（SW 回写/回退路径没把拒绝抛到全局）', rejections.length === 0, rejections);
  });
}

// ---------------- HEAD 副本工作树（server 入口、vite 构建、字面锚全部从这里出发） ----------------
function makeHeadWorktree(tmpRoot: string): { root: string; outer: string } {
  const outer = mkdtempSync(join(tmpRoot, 't02281-negwt-'));
  const wt = join(outer, 'wt');
  execFileSync('git', ['worktree', 'add', '--detach', wt, 'HEAD'], { cwd: ROOT, stdio: 'pipe', timeout: 300_000 });
  symlinkSync(join(ROOT, 'node_modules'), join(wt, 'node_modules'), 'junction');
  symlinkSync(join(ROOT, 'web', 'node_modules'), join(wt, 'web', 'node_modules'), 'junction');
  return { root: wt, outer };
}
function removeHeadWorktree(wt: string, outer: string): void {
  // 拆序纪律：先删 junction（否则 worktree remove 会顺着链接删主仓 node_modules），再 force remove，最后 prune
  try { rmSync(join(wt, 'web', 'node_modules'), { recursive: true, force: true }); } catch { /* */ }
  try { rmSync(join(wt, 'node_modules'), { recursive: true, force: true }); } catch { /* */ }
  try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: ROOT, stdio: 'ignore', timeout: 180_000 }); }
  catch { rmSync(wt, { recursive: true, force: true }); }
  try { execFileSync('git', ['worktree', 'prune'], { cwd: ROOT, stdio: 'ignore', timeout: 60_000 }); } catch { /* 尽力 */ }
  rmSync(outer, { recursive: true, force: true });
}

// ---------------- 主流程 ----------------
mkdirSync(OUT_DIR, { recursive: true });
const tmpRoot = process.env.T02281_TMP_ROOT ?? 'D:/code/tmp';
if (!existsSync(tmpRoot)) console.log(`  ⚠ T02281_TMP_ROOT=${tmpRoot} 不存在，回落 os.tmpdir()（C 盘满盘会假性失败）`);
const TMP = mkdtempSync(join(existsSync(tmpRoot) ? tmpRoot : tmpdir(), 't02281-gate-'));
if (!process.env.MTASK_GATE_ARTIFACT_DIR) process.env.MTASK_GATE_ARTIFACT_DIR = 'D:/code/tmp/gate-tmp';
const shots = gateShotsDir('t02281-sw-offline');
mkdirSync(shots, { recursive: true });
const DATA_PRE = join(TMP, 'data-pre');
const DATA_POST = join(TMP, 'data-post');
const mode = SOURCE_ONLY ? 'source-only' : 'full';
console.log(`T02281 PWA 断供离线门（mode=${mode}·T02293 改判版）· 实例 ${BASE} · CDP ${CDP_PORT} · 临时根 ${TMP}`);

// Z 前置快照：主仓 web/dist 的关键字节（本门此后对它只字不动）
const MAIN_DIST_SW = join(ROOT, 'web', 'dist', 'sw.js');
const MAIN_DIST_HTML = join(ROOT, 'web', 'dist', 'index.html');
const snap = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : null);
const distSwBefore = snap(MAIN_DIST_SW);
const distHtmlBefore = snap(MAIN_DIST_HTML);

// S-01：HEAD 形态的 SW 源码在场（这是「被测物存在于版本库」的前置点，字面口径如实标出）
let HEAD_SW = '';
try { HEAD_SW = gitShow(REL_SW); } catch { /* 下面如实转红 */ }
ok('S-01 被测 SW 源码在 HEAD 在场（git show HEAD:web/public/sw.js 非空）', HEAD_SW.length > 0, `bytes=${HEAD_SW.length}`);

// S-05：缺陷变体可构造且语法可编译（pre 组注入的可行性前提；对 HEAD 文本构造）
let DEFECT_TEXT = '';
{
  let why = '';
  try {
    const d = defectiveSw(HEAD_SW);
    if (/cache\.put\(req, copy\)/.test(d) || RE_S3.test(d)) why = '注入后仍残留回写/预缓存路径';
    else if (d === HEAD_SW) why = '注入没改变任何字节';
    else {
      // 语法自检：注入若把括号配平改坏，SW 直接注册失败，pre 组会以「没接管」而非缺陷复现变红——
      // 那种红会误导人去查通道，所以在这儿就拦掉（new Function 只编译不执行，触不到 self/caches）
      new Function(d);
      DEFECT_TEXT = d;
    }
  } catch (e) { why = e instanceof Error ? e.message : String(e); }
  ok('S-05 缺陷变体可构造且语法可编译（负对照注入没被源码改动漂掉）', DEFECT_TEXT !== '', why);
}

// N-01：字面腿牙齿——同一组字面判据在 HEAD 文本上必真、在内存缺陷形态上必假
// （不是「预修复世界」的旁敲侧击，而是把被测文本真的改坏后同判据翻红——规约反模式 12 的自检）
{
  let headAllTrue = false; let defectAllFalse = false; let g1Teeth = false;
  try {
    headAllTrue = RE_S2.test(HEAD_SW) && RE_S3.test(HEAD_SW) && reS4(HEAD_SW);
    if (DEFECT_TEXT) defectAllFalse = !RE_S2.test(DEFECT_TEXT) && !RE_S3.test(DEFECT_TEXT) && !reS4(DEFECT_TEXT);
    const srv = gitShow(REL_SERVER);
    // HEAD 里该 env 读取出现多处——篡改必须全数改名，否则残留命中会假装牙齿（本条首轮实测踩过）
    const tampered = srv.replace(/process\.env\.MTASK_STATIC_DIR/g, 'process.env.T02281_NEOVER');
    g1Teeth = RE_G1.test(srv) && tampered !== srv && !RE_G1.test(tampered);
  } catch { /* 判红 */ }
  const cond = DEFECT_TEXT !== '' ? (headAllTrue && defectAllFalse && g1Teeth) : (headAllTrue && g1Teeth);
  ok('N-01 字面腿有牙齿：剥 useMemo 式注入（去 precache 调用、assets 分支退回只读、剪枝调用减到 <2、静态目录 env 改名）后，S-02/S-03/S-04/G-01 同款字面判据必须转假、HEAD 上必须为真',
    cond, { headAllTrue, defectAllFalse, g1Teeth, note: DEFECT_TEXT === '' ? '缺陷变体未构出，只验了 HEAD 侧（牙齿半截）' : '' });
}

if (SOURCE_ONLY) {
  skipped('G-01..G-05 与 H/P/Q/Z 行为组', 'source-only 降级：无行为通道可测（离线结论需带 Chrome 复跑 full）');
  skipped('S-02/S-03/S-04 配对条目与 G-01 配对条目', 'source-only：行为腿无实测来源，不冒充 okPair');
  skipped('N-02 跨阶段判别力', 'source-only：两阶段未运行');
}

if (!SOURCE_ONLY) {
  // G-02/G-03：环境通道（缺口 → SKIP，不算 PASS；fake PASS 严禁）
  const chromeOk = existsSync(CHROME);
  if (chromeOk) ok('G-02 Chrome 可执行文件在场（T02281_CHROME 可覆盖）', existsSync(CHROME), CHROME);
  else skipped('G-02 Chrome 可执行文件在场', `${CHROME} 不在场——行为组整组不执行，本门不给离线结论`);
  const portFree = await (async () => { try { return !(await fetch(`${BASE}/api/health`)).ok; } catch { return true; } })();
  if (portFree) ok('G-03 断言只打在自起的隔离实例上：端口空闲自检（绝不连生产 39877）', !(await fetch(`${BASE}/api/health`).catch(() => ({ ok: false }))).ok, BASE);
  else skipped('G-03 端口空闲自检', `${BASE} 已有实例应答——请用 T02281_PORT 换端口`);

  let canRun = chromeOk && portFree && DEFECT_TEXT !== '' && HEAD_SW.length > 0;
  let wt: { root: string; outer: string } | null = null;
  if (canRun) {
    try {
      wt = makeHeadWorktree(existsSync(tmpRoot) ? tmpRoot : tmpdir());
      SERVER_ROOT = wt.root;
      ok('G-05 HEAD detached 副本就绪（server 入口/vite/静态目录全部从副本走，工作树状态对本门无效）',
        existsSync(join(wt.root, 'server', 'src', 'index.ts')) && existsSync(join(wt.root, 'node_modules'))
        && existsSync(join(wt.root, 'web', 'node_modules')), wt.root);
    } catch (e) {
      ok('G-05 HEAD detached 副本就绪', false, e instanceof Error ? e.message : String(e));
      canRun = false;
    }
  } else if (!chromeOk || !portFree) {
    skipped('G-05 HEAD 副本通道', '环境缺口（Chrome/端口），副本无从谈起');
  } else {
    skipped('G-05 HEAD 副本通道', '缺陷变体未构出或 HEAD SW 缺失，行为链不执行');
  }

  if (canRun && wt) {
    // G-04：在副本里构建——判据来自 HEAD 源码，主仓共享 web/dist 从此不再被本门构建/触碰
    const webDir = join(wt.root, 'web');
    const distDir = join(wt.root, 'web', 'dist');
    let built = false;
    try {
      const r = spawnSync(process.execPath, [join(wt.root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'],
        { cwd: webDir, encoding: 'utf8', timeout: 600_000 });
      built = r.status === 0 && existsSync(join(distDir, 'index.html'));
      if (!built) info(`vite build（副本）输出尾部：${String(r.stderr ?? r.stdout ?? '').slice(-300)}`);
    } catch (e) {
      info(`vite build（副本）抛错：${e instanceof Error ? e.message : e}`);
    }
    ok('G-04 HEAD 副本内 vite 构建成功（dist/index.html 在场）', built, distDir);

    if (!built) {
      skipped('H/P/Q/Z 与配对行为腿', '副本构建失败：行为通道塌了，本门不给离线结论');
    } else {
      const preStatic = join(TMP, 'static-pre');
      const postStatic = join(TMP, 'static-post');
      try {
        mkdirSync(preStatic, { recursive: true });
        mkdirSync(postStatic, { recursive: true });
        cpSync(distDir, preStatic, { recursive: true, force: true });
        cpSync(distDir, postStatic, { recursive: true, force: true });
        // 每阶段一套独立库：pre 的实例被硬杀后留下的 WAL/锁不许拖累 post 的启动
        await runPre(preStatic, DATA_PRE, DEFECT_TEXT);
        await runPost(postStatic, DATA_POST);
        M.ranPhases = true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lines.push(`[CRASH] 门自身执行抛异常（崩溃即门失效，不得当成通过）→ ${msg}`);
        failCount += 1;
        console.log(`  ⚠ 门执行异常：${msg}`);
      } finally {
        await stopServer('final').catch(() => { /* */ });
        removeHeadWorktree(wt.root, wt.outer);
        wt = null;
      }

      // ---- 链尾发射：行为腿取值已全部完成（反模式 14），现在才轮到配对条目 ----
      // 只有两阶段真的跑完才发配对；中途崩溃时配对/缺口由后面的 SKIP 补记块处理（崩溃已计红）
      if (M.ranPhases) {
        okPair(ok, 'S-02 `/assets` 分支「未命中回写」在位（字面腿=HEAD sw.js；行为腿=判别式：pre 期缓存 0 条 且 post 期 >0 条——两相同侧即无判别力）',
          () => M.preAssets === 0 && (M.postAssets ?? 0) > 0,
          () => RE_S2.test(HEAD_SW),
          () => ({ preAssets: M.preAssets, postAssets: M.postAssets }));
        okPair(ok, 'S-03 install 期从壳里解析清单预缓存 hash 产物（字面腿=HEAD sw.js；行为腿=post 实测 index-<hash>.js 已进缓存）',
          () => M.indexJs === true,
          () => RE_S3.test(HEAD_SW),
          () => ({ indexJs: M.indexJs, postAssets: M.postAssets }));
        okPair(ok, 'S-04 同名分片剪枝挂在两条写入路径（字面腿=HEAD sw.js 两处调用；行为腿=投旧留新后缓存仅剩当前 hash 条目）',
          () => M.pruned === true,
          () => reS4(HEAD_SW),
          () => ({ pruned: M.pruned }));
        okPair(ok, 'G-01 静态目录覆盖真实生效（字面腿=HEAD server 源码读 MTASK_STATIC_DIR；行为腿=pre/post 两阶段的临时目录标记文件都被按字节伺服——env 被忽略时会掉进 SPA 兜底拿到 index.html，当场转红）',
          () => M.markerPre === true && M.markerPost === true,
          () => RE_G1.test(gitShow(REL_SERVER)),
          () => ({ markerPre: M.markerPre, markerPost: M.markerPost }));
        ok('N-02 跨阶段判别力成立：同一实测口径在缺陷态与修复态必须给出相反读数（断供挂载 false→true；线上伺服字节 pre≠post；资产缓存 0→>0）——任何「两侧相同」都说明回放漂了',
          M.preOfflineMounted === false && M.postOfflineMounted === true
          && M.servedPre !== '' && M.servedPost !== '' && M.servedPre !== M.servedPost
          && M.preAssets === 0 && (M.postAssets ?? 0) > 0,
          { preOfflineMounted: M.preOfflineMounted, postOfflineMounted: M.postOfflineMounted, servedDiff: M.servedPre !== M.servedPost, preAssets: M.preAssets, postAssets: M.postAssets });
      }
      // Z：主仓 web/dist 零写入纪律（本门构建发生在副本，dist 只读快照）——通道走到过就核对
      ok('Z-01 主仓 web/dist/sw.js 未被本门改写（缺陷注入只落临时副本）', snap(MAIN_DIST_SW) === distSwBefore, MAIN_DIST_SW);
      ok('Z-02 主仓 web/dist/index.html 未被本门改写（副本构建不回写主仓）', snap(MAIN_DIST_HTML) === distHtmlBefore, MAIN_DIST_HTML);
    }
  }
  if (!M.ranPhases && !SOURCE_ONLY && skipCount === 0) {
    lines.push('[ABORT] 通道前置不满足且未记 SKIP——请核对上方红项');
    failCount += 1;
  }
  if (!M.ranPhases && !SOURCE_ONLY) {
    for (const n of ['S-02 配对', 'S-03 配对', 'S-04 配对', 'G-01 配对', 'N-02 判别力', 'Z-01', 'Z-02', 'H 组', 'P 组', 'Q 组']) {
      if (!lines.some((l) => l.includes(n))) skipped(`${n}（行为链未执行）`, '前置塌方或环境缺口——不给离线结论');
    }
  }
}

const group = (tag: string) => lines.filter((l) => new RegExp(`^\\[(PASS|FAIL)\\] ${tag}-`).test(l));
const failsOf = (tag: string) => group(tag).filter((l) => l.startsWith('[FAIL]')).length;
if (M.ranPhases) {
  const pN = group('P').length; const qN = group('Q').length;
  const n2 = lines.some((l) => l.startsWith('[PASS] N-02'));
  const hAll = group('H').length === 4 && failsOf('H') === 0;
  const discriminating = pN === 4 && qN >= 11 && failsOf('P') === 0 && failsOf('Q') === 0 && n2 && hAll;
  lines.unshift(`[VERDICT] 缺陷回放 P 组 ${pN - failsOf('P')}/${pN} 绿 + 修复验收 Q 组 ${qN - failsOf('Q')}/${qN} 绿 + H 组伺服事实全绿 + N-02 判别力在位 → `
    + `${discriminating ? '门拦得住缺陷、也证得了修复（合格）' : '门的判别力不成立（缺陷形态没复现、伺服/验收组有红或 N-02 未绿），必须修门'}`);
}
if (SOURCE_ONLY) lines.unshift('[DEGRADED] 仅源码锚点链（HEAD 文本 + 内存缺陷形态）：通过只代表 SW 机制在位，不代表断供离线可用（需带 Chrome 复跑 full）');

const summary = `T02281 PWA 断供离线门（mode=${mode}·T02293 改判版）：PASS=${pass} FAIL=${failCount} SKIP=${skipCount}`;
const resultsFile = writeGateResults(OUT_DIR, OUT_BASE, `${summary}\n${lines.join('\n')}\n`,
  { port: SOURCE_ONLY ? undefined : PORT, dataDir: TMP, note: `mode=${mode}` });
console.log(`\n${summary}${M.ranPhases ? '' : '（行为链未完整执行：不给离线结论）'} → ${resultsFile}`);
if (process.env.T02281_KEEP === '1' && !SOURCE_ONLY) info(`T02281_KEEP=1，临时目录保留：${TMP}`);
else {
  await sleep(1_500);
  try { rmSync(TMP, { recursive: true, force: true }); } catch { info(`临时目录未清干净（Chrome 句柄未放），可手工删：${TMP}`); }
}
process.exit(failCount === 0 ? 0 : 1);
