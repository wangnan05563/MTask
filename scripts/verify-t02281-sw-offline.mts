#!/usr/bin/env node
/**
 * T02281 回归门（入库版，T02289）：PWA 断供离线壳——`web/public/sw.js` 的 assets 回写与同名分片剪枝。
 *
 * 拦的是什么：T02281 之前 SW 的 `/assets` 分支「只读不写」，正常浏览一次也留不下带 hash 的主包，
 * 断供 reload 时主 JS `net::ERR_FAILED`、React 根不挂载（移动端白板）。任何人把 SW 改回只读不写，
 * 本门的 pre 组必须复现该症状、post 组必须证伪它——两组同时成立才叫门有效（见下「负对照口径」）。
 *
 * 通道（蓝本 t02281-offline-gate.mjs 的四处入库改造）：
 *   ① 静态目录走 `MTASK_STATIC_DIR`（T02289 裁定 (乙)）——门把 `web/dist` 复制到临时目录后让实例伺服**副本**，
 *      缺陷变体只写副本，**主仓 web/dist 全程零写入**（蓝本直写 `web/dist/sw.js`，靠「收尾停在修复版」
 *      这种约定而非机制来维持一致）；Z-01 逐字节核对这条纪律。
 *   ② 数据目录每次 `mkdtempSync` 新建并由本门自播种（蓝本复用 `t02221-data` 种子库，并发跑互踩）。
 *   ③ 依赖策略：零外部依赖——系统 Chrome(headless=new) + Node 全局 WebSocket 走 CDP，
 *      不用跨项目 Playwright（蓝本 import `11_OcrDemo/node_modules/playwright`，换机器即失效）。
 *      SW 语义不需要 attach ServiceWorker target：CacheStorage 是**按源**共享的，页面上下文里
 *      `caches.keys()/open()/keys()` 读到的就是 SW 写的那份；接管与否用 `navigator.serviceWorker.ready` 判。
 *   ④ `--source-only` 降级：只跑 S 组源码锚点，结果首行标 `mode=source-only`。
 *      **S 组通过只代表机制在位，不代表断供离线可用**（降级运行不得冒充离线结论）。
 *
 * 负对照口径（本门与 T02290 的差别）：不需要 `--negative-control` 改工作区源码——
 * pre 组就是缺陷回放，注入发生在临时副本里，工作区一个字节都不动。P-01..P-03 若在缺陷形态下「反而全绿」，
 * 说明注入漂掉了（S-05 先拦一道），门的判别力归零。
 *
 * 用法（Node 须与 better-sqlite3 ABI 对齐，本仓惯例走 tsx）：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02281-sw-offline.mts
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02281-sw-offline.mts --source-only
 *   环境变量：T02281_PORT（默认 39955，避开 39877 生产实例）、T02281_CDP（默认 39956）、
 *             T02281_CHROME、T02281_GATE_SKIP_BUILD=1 复用现有 web/dist（改过前端源码时别用，G-05 会拦）、
 *             T02281_TMP_ROOT（默认 D:/code/tmp；C 盘常年 0 可用会假性 SQLITE_FULL）、
 *             T02281_KEEP=1 保留临时目录便于排障
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, cpSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { gateShotsDir, writeGateResults } from './lib/gate-results.mts';
import { resolveServerLauncher } from './isolated-server-launcher.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const DIST = join(WEB, 'dist');
const SRC_SW = join(WEB, 'public', 'sw.js');
const SERVER_INDEX = join(ROOT, 'server', 'src', 'index.ts');
const OUT_DIR = join(ROOT, '.workbuddy');
const OUT_BASE = 't02281-sw-offline-gate-results.txt';

const SOURCE_ONLY = process.argv.includes('--source-only');
const PORT = Number(process.env.T02281_PORT ?? 39955);
const CDP_PORT = Number(process.env.T02281_CDP ?? 39956);
const CHROME = process.env.T02281_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = `http://127.0.0.1:${PORT}`;
const SKIP_BUILD = process.env.T02281_GATE_SKIP_BUILD === '1';
const FIXTURE_NAME = `T02281 离线门项目-${Date.now()}`;
/** 上一构建的同词干产物名——用来逼「回写 + 同名剪枝」这条路走一遍 */
const FAKE_OLD_CHUNK = '/assets/index-OLDEPREBUILD.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let failCount = 0;
const lines: string[] = [];
const pageErrors: string[] = [];
const failedReq: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) pass += 1; else failCount += 1;
  const tail = cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 320)}`;
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${tail}`);
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${tail}`);
};
const info = (s: string) => { lines.push(`[INFO] ${s}`); console.log(`  [INFO] ${s}`); };
const tailOf = (file: string) => { try { return readFileSync(file, 'utf8').slice(-240).replace(/\s+/g, ' '); } catch { return '(还没日志)'; } };

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
    if (!re.test(out)) throw new Error(`缺陷变体锚点未命中（sw.js 形态变了，请同步本门）：${re.source.slice(0, 72)}`);
  }
  for (const [re, to] of DEFECT_EDITS) out = out.replace(re, to);
  return out;
}

// ---------------- S 组：源码锚点（也是 --source-only 降级通道的全部内容） ----------------
/** 返回「缺陷变体是否可构造」——不可构造时 pre 组无从注入，通道前置直接判不满足 */
function runSourceGroup(): boolean {
  if (!existsSync(SRC_SW)) { ok('S-01 SW 源码在场（web/public/sw.js）', false, SRC_SW); return false; }
  const src = readFileSync(SRC_SW, 'utf8');
  ok('S-01 SW 源码在场（web/public/sw.js）', src.length > 0, SRC_SW);
  ok("S-02 `/assets` 分支带「未命中回写」（缺它即断供白板）", /includes\('assets'\)[\s\S]{0,600}cache\.put\(req, copy\)/.test(src));
  ok('S-03 install 期从壳里解析清单预缓存 hash 产物', /\.then\(\(\) => precacheBuildAssets\(\)\)/.test(src));
  ok('S-04 同名分片剪枝挂在两条写入路径上（缓存名固定，不清旧名会永久堆积）',
    (src.match(/await pruneReplacedChunk\(cache, url\)/g) ?? []).length >= 2);
  let defect: string | null = null;
  let why = '';
  try {
    defect = defectiveSw(src);
    if (/cache\.put\(req, copy\)/.test(defect) || /\.then\(\(\) => precacheBuildAssets\(\)\)/.test(defect)) {
      why = '注入后仍残留回写/预缓存路径';
      defect = null;
    } else {
      // 语法自检：注入若把括号配平改坏，SW 直接注册失败，pre 组会以「没接管」而非缺陷复现变红——
      // 那种红会误导人去查通道，所以在这儿就拦掉（new Function 只编译不执行，触不到 self/caches）
      new Function(defect);
    }
  } catch (e) {
    why = e instanceof Error ? e.message : String(e);
    defect = null;
  }
  ok('S-05 缺陷变体可构造且语法可编译（pre 组的负对照注入没被源码改动漂掉）', defect !== null, why);
  return defect !== null;
}

// ---------------- 隔离实例（真后端 + MTASK_STATIC_DIR 指向临时副本） ----------------
let LAUNCHER: ReturnType<typeof resolveServerLauncher> | null = null;
let server: ReturnType<typeof spawn> | null = null;
let chrome: ReturnType<typeof spawn> | null = null;
const killTree = (pid?: number) => { if (pid) { try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } } };
// 异常收口（memory「门脚本隔离实例收口三坑」）：门被 Ctrl-C / 崩溃时子进程不会自己消失，
// 残留实例占着端口，下一轮 G-03 端口自检会把它当成「别人已在跑的实例」而拒绝执行。
const teardown = () => { if (server?.pid) killTree(server.pid); if (chrome?.pid) killTree(chrome.pid); };
process.on('exit', teardown);
process.on('SIGINT', () => { teardown(); process.exit(130); });
process.on('SIGTERM', () => { teardown(); process.exit(143); });

async function startServer(tag: string, staticDir: string, dataDir: string): Promise<void> {
  LAUNCHER ??= resolveServerLauncher(ROOT, SERVER_INDEX);
  mkdirSync(dataDir, { recursive: true });
  const logFile = join(dataDir, `server-${tag}.log`);
  const fd = openSync(logFile, 'a');
  server = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
    cwd: ROOT,
    env: {
      ...process.env, ...LAUNCHER.env,
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
    // 本实例首轮启动实测 48~60s（重排期/对账/备份都在启动路径上），心跳把「慢」与「挂」区分开
    if (took > warned * 60_000) { warned += 1; info(`[waiting ${Math.round(took / 1000)}s] ${tag} 未就绪，日志尾部：${tailOf(logFile)}`); }
    await sleep(1_000);
  }
}

/** 端口上的应答者必是本门实例（G-03 起服前已确认端口空闲），按端口补杀是安全的 */
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
  // 只杀 spawn 回来的 tsx 父进程不够：真正持有端口与 SQLite 句柄的是它的 worker 子进程，
  // 脱树存活时下一台启动会卡在打开同一个库（run1 的 post-online 卡死即此形态）
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
    // 移动端壳：App.tsx:361 用 matchMedia('(max-width: 820px)') 判定，靠视口而非 UA
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
async function runPre(staticDir: string, dataDir: string): Promise<void> {
  writeFileSync(join(staticDir, 'sw.js'), defectiveSw(readFileSync(SRC_SW, 'utf8')), 'utf8');
  await startServer('pre-online', staticDir, dataDir);
  await withBrowser(async (cdp, ev) => {
    await goto(cdp, `${BASE}/?m=pre`);
    await until(ev, `document.querySelectorAll('header select option').length > 0`);
    ok('P-00 修复前 SW 已接管（门打的确实是离线壳，不是普通网页）', (await waitSwActive(ev)) === true);
    const cached = await assetsInCache(ev);
    ok('P-01 修复前正常浏览后 /assets 仍不进 SW 缓存（回写缺失即工单根因）', cached.length === 0, cached.slice(0, 4));
    ok('O-01 pre 断供通道自检：实例端口确实不再应答（否则「断供」是假的）', await stopServer('pre-outage'));
    failedReq.length = 0;
    await goto(cdp, `${BASE}/`);
    await sleep(2_500);
    const assetsFailed = failedReq.filter((s) => s.includes('/assets/'));
    const mounted = await ev(EV_MOUNTED).catch(() => false);
    ok('P-02 修复前断供 reload 主 JS 请求失败（net::ERR_FAILED 类）', assetsFailed.length > 0, assetsFailed.slice(0, 2));
    ok('P-03 修复前断供 reload React 根未挂载（白板，即工单症状）', mounted === false, { mounted, failed: failedReq.length });
    await shot(cdp, 'pre-white');
    info(`pre 页面异常 ${pageErrors.slice(0, 2).join(' | ') || '(无)'}（缺陷态本就崩，不作判据）`);
  });
}

// ---------------- post：修复版验收（工单 11 条 + 缓存自净） ----------------
async function runPost(staticDir: string, dataDir: string): Promise<void> {
  cpSync(SRC_SW, join(staticDir, 'sw.js'));
  await startServer('post-online', staticDir, dataDir);
  const fixture = await seedFixtureProject();
  const projects = (await (await fetch(`${BASE}/api/projects`)).json()) as Array<{ id: string; name: string }>;
  await withBrowser(async (cdp, ev) => {
    await goto(cdp, `${BASE}/?m=post`);
    await until(ev, `document.querySelectorAll('header select option').length > 0`);
    ok('Q-00 修复后 SW 已接管', (await waitSwActive(ev)) === true);
    const hintsOnline = (await ev(`return [...document.querySelectorAll('[data-t02201="project-list-error"]')].map(e => e.textContent ?? '')`)) as string[];
    const onlineOptions = (await ev(EV_OPTIONS)) as string[];
    ok('Q-01 正常态无失败提示，且夹具项目真的进了下拉（不误伤在线路径）',
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
      ok('Q-03 同名分片只留最新（hash 换代不留垃圾堆积）', injected === 'ok' && pruned,
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
      ok('Q-08 验收③上次项目名回显（列表没取到也讲清在用哪个项目）',
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
console.log(`T02281 PWA 断供离线门（mode=${mode}）· 实例 ${BASE} · CDP ${CDP_PORT} · 临时根 ${TMP}`);

const defectConstructible = runSourceGroup();

if (!SOURCE_ONLY) {
  ok('G-01 服务端静态目录可覆盖（MTASK_STATIC_DIR，T02289 裁定 (乙)）',
    /process\.env\.MTASK_STATIC_DIR/.test(readFileSync(SERVER_INDEX, 'utf8')), SERVER_INDEX);
  const chromeOk = existsSync(CHROME);
  ok('G-02 Chrome 可执行文件在场（T02281_CHROME 可覆盖）', chromeOk, CHROME);
  const portFree = await (async () => { try { return !(await fetch(`${BASE}/api/health`)).ok; } catch { return true; } })();
  ok('G-03 断言只打在自起的隔离实例上：端口空闲自检', portFree, `${BASE} 已有实例应答——请用 T02281_PORT 换端口`);
  let built = existsSync(join(DIST, 'index.html'));
  if (!SKIP_BUILD) {
    const r = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: WEB, encoding: 'utf8' });
    built = r.status === 0 && existsSync(join(DIST, 'index.html'));
    if (!built) info(`vite build 输出尾部：${String(r.stderr ?? r.stdout ?? '').slice(-300)}`);
  }
  ok('G-04 web 构建成功（判据来自当前源码）', built, SKIP_BUILD ? 'T02281_GATE_SKIP_BUILD=1 复用现有 dist' : DIST);
  const distSw = join(DIST, 'sw.js');
  const swFresh = existsSync(distSw) && readFileSync(distSw, 'utf8') === readFileSync(SRC_SW, 'utf8');
  ok('G-05 共享 web/dist 的 sw.js 与源码逐字节一致（dist 不陈旧，临时副本来源可信）', swFresh, distSw);
  const canRun = chromeOk && portFree && built && swFresh && defectConstructible;

  const preStatic = join(TMP, 'static-pre');
  const postStatic = join(TMP, 'static-post');
  const distSwBefore = existsSync(distSw) ? readFileSync(distSw, 'utf8') : null;
  if (!canRun) {
    lines.push('[ABORT] 通道前置不满足（Chrome/端口/dist/缺陷变体），pre+post 组不执行——门不给离线结论');
    failCount += 1;
  } else {
    try {
      mkdirSync(preStatic, { recursive: true });
      mkdirSync(postStatic, { recursive: true });
      cpSync(DIST, preStatic, { recursive: true, force: true });
      cpSync(DIST, postStatic, { recursive: true, force: true });
      // 每阶段一套独立库：pre 的实例被硬杀后留下的 WAL/锁不许拖累 post 的启动
      await runPre(preStatic, DATA_PRE);
      await runPost(postStatic, DATA_POST);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lines.push(`[CRASH] 门自身执行抛异常（崩溃即门失效，不得当成通过）→ ${msg}`);
      failCount += 1;
      console.log(`  ⚠ 门执行异常：${msg}`);
    } finally {
      await stopServer('final').catch(() => { /* */ });
      const distSwAfter = existsSync(distSw) ? readFileSync(distSw, 'utf8') : null;
      ok('Z-01 主仓 web/dist/sw.js 未被本门改写（缺陷注入只落临时副本）',
        distSwBefore !== null && distSwAfter === distSwBefore, distSw);
      if (process.env.T02281_KEEP === '1') info(`T02281_KEEP=1，临时目录保留：${TMP}`);
      else {
        await sleep(1_500);
        try { rmSync(TMP, { recursive: true, force: true }); } catch { info(`临时目录未清干净（Chrome 句柄未放），可手工删：${TMP}`); }
      }
    }
  }
}

const group = (tag: string) => lines.filter((l) => new RegExp(`^\\[(PASS|FAIL)\\] ${tag}-`).test(l));
const failsOf = (tag: string) => group(tag).filter((l) => l.startsWith('[FAIL]')).length;
if (!SOURCE_ONLY) {
  const pN = group('P').length; const qN = group('Q').length;
  const discriminating = pN === 4 && qN >= 11 && failsOf('P') === 0 && failsOf('Q') === 0;
  lines.unshift(`[VERDICT] 缺陷回放 P 组 ${pN - failsOf('P')}/${pN} 绿 + 修复验收 Q 组 ${qN - failsOf('Q')}/${qN} 绿 → `
    + `${discriminating ? '门拦得住缺陷、也证得了修复（合格）' : '门的判别力不成立（缺陷形态没复现或验收组有红），必须修门'}`);
}
if (SOURCE_ONLY) lines.unshift('[DEGRADED] 仅源码锚点：通过只代表 SW 机制在位，不代表断供离线可用（需带 Chrome 复跑 full）');

const summary = `T02281 PWA 断供离线门（mode=${mode}）：PASS=${pass} FAIL=${failCount}`;
const resultsFile = writeGateResults(OUT_DIR, OUT_BASE, `${summary}\n${lines.join('\n')}\n`,
  { port: SOURCE_ONLY ? undefined : PORT, dataDir: TMP, note: `mode=${mode}` });
console.log(`\n${summary}${SOURCE_ONLY ? '（降级运行：未验证离线行为）' : ''} → ${resultsFile}`);
if (SOURCE_ONLY) { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 空目录删不掉不影响判定 */ } }
process.exit(failCount === 0 ? 0 : 1);
