/**
 * T02071 验证：一键更新的「下载中途取消」与「安装失败回执/重试」。
 *
 * 覆盖策略（与工单口径一致）：真机安装/真实更高版本发布属真机验收项，本仓跑不了；
 * 但两块的**决策内核**（Range 续传判定、待回执标记与下次启动对账、安装退出码→回执）是纯函数，
 * 这里逐条断言，并额外用本地 HTTP 服务器跑一次**真实 Range 协议**，证明「取消后继续」拼出来的
 * 字节与原包逐字节一致；主进程/预加载/界面的接线原以静态断言钉住，批㉖ 起改为「真跑接线 + 字面锚点配对」
 * （静态锚只在行为腿通过时才算绿，见文末批㉖ 说明）。
 *
 * 用法（判据 ②③④ 见 `docs/验收门判据规约.md`，本门断言数 35 → 58）：
 *   node scripts/verify-t02071-update-flow.mjs         # 或 npm run verify:update
 *   ⚠ 必须在 HEAD 干净的副本里跑（`git worktree add --detach`）：字面腿取 `git show HEAD:`，
 *     行为腿直接 `require` 仓库内文件——工作树若躺着别的会话的过期文件，两条腿会各说各话。
 *   需要 Node ≥ 22.18（`scripts/lib/anchor-pair.mts` 走原生类型剥离，不再依赖 tsx）。
 *
 * 批㉖ 改判（T02293）：原 W-01~W-14 是 14 条**工作树源码正则**，且旧前提写着「本仓跑不了 Electron IPC，
 * 只能静态钉住」。实测证伪——用 `Module._load` 钩子替换 `electron` / `node:https` / `node:child_process`
 * 三条平台边界后，`electron/main.js` 可在门进程里真加载，四枚 `update:*` handler 真可调用：
 * 下载/取消/续传打到门自建的真实 Range 服务器，安装换成真实子进程的真实退出码
 * （只有 NSIS 安装包本体仍是替身，那属真机验收项）。于是新增 B 组 15 条行为探针作为 W 组每条锚点的
 * 同义行为腿（`okPair`，红因区分「行为失守」与「等价重构换措辞」），取证面同时切到 HEAD。
 * B 组里最有判别力的是 B-06a/B-06b（同一现场「本地有 .part + 服务端忽略 Range 回 200」：真内核判不追加→删半截从 0
 * 重写→逐字节一致；把内核 append 结论强改为 true→主进程立刻把整包拼到旧半截后面，体积多出前缀、sha 不再一致。
 * 「没有第二套判定」只能靠这种依赖注入反证测出来，正则锚点测不出）与 B-09（重试期间服务端下载请求数零增长，
 * 才真等于「复用安装包」）。B-16 是驱动过程中实测撞出的**产品缺陷**现状钉住（206 的 Content-Range 起点与本地
 * .part 不符时，半截响应体被当整包落盘并回 downloaded，无总量/校验和兜底），已按规约建派生单 T02644 而非在本单修产品。
 * N 组负对照从无到有 8 条（本门原先一条都没有）：空源码同义反复探针、HEAD 取证面在场性、逐锚变异（含反模式 31
 * 两坑）、行为袋抽干、逐键孤立检测、空注册表反证、okPair 契约、八项关键数值点名。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const U = require(path.join(ROOT, 'electron', 'update-state.js'));

// 临时根必须落 D:（C: 常年吃紧，mkdtemp/写盘失败会伪装成产品失败）
const TMP_ROOT = fs.existsSync('D:/code/tmp') ? 'D:/code/tmp' : os.tmpdir();
let pass = 0, fail = 0;
const show = (detail) => (typeof detail === 'string' ? detail : JSON.stringify(detail));
const ok = (name, cond, detail = '') => {
  const tail = detail ? ` :: ${show(detail).slice(0, 400)}` : '';
  if (cond) { pass++; console.log(`PASS ${name}${tail}`); }
  else { fail++; console.log(`FAIL ${name}${tail}`); }
};
const group = (title) => console.log(`\n---- ${title} ----`);

// ---------- 版本号比较（对账判定用） ----------
group('U 组 决策内核（纯函数，可脱离 electron）');
ok('U-01 cmpVersion 4 段逐段比大小', U.cmpVersion('0.1.1011.194', '0.1.1011.94') === 1
  && U.cmpVersion('0.1.1011.94', '0.1.1011.194') === -1
  && U.cmpVersion('0.1.1011.194', '0.1.1011.194') === 0);
ok('U-02 缺位补 0 / 非法段按 0，不因段数不同误判', U.cmpVersion('0.1.1011', '0.1.1011.0') === 0
  && U.cmpVersion('0.1.1011.194', '0.1.1011') === 1
  && U.cmpVersion('garbage', '') === 0);

// ---------- 续传判定 ----------
const CR = (start, end, total) => ({ 'content-range': `bytes ${start}-${end}/${total}` });
ok('U-03 206 且 Content-Range 起点==本地已有字节 → 追加续传', (() => {
  const p = U.resumePlan({ partBytes: 1024, statusCode: 206, headers: { ...CR(1024, 4095, 4096), 'content-length': String(4096 - 1024) } });
  return p.append === true && p.startBytes === 1024 && p.totalBytes === 4096;
})());
ok('U-04 200 忽略 Range → 从 0 重下（半截文件不可拼）', (() => {
  const p = U.resumePlan({ partBytes: 1024, statusCode: 200, headers: { 'content-length': '4096' } });
  return p.append === false && p.startBytes === 0 && p.totalBytes === 4096;
})());
ok('U-05 206 但起点错位（服务端/本地不一致）→ 从 0 重下', (() => {
  const p = U.resumePlan({ partBytes: 1024, statusCode: 206, headers: CR(0, 4095, 4096) });
  return p.append === false;
})());
ok('U-06 416 越界 → 从 0 重下', U.resumePlan({ partBytes: 9999, statusCode: 416, headers: {} }).append === false);
ok('U-07 无本地残留时即使 206 也从 0 开始', (() => {
  const p = U.resumePlan({ partBytes: 0, statusCode: 206, headers: CR(0, 4095, 4096) });
  return p.append === false && p.startBytes === 0;
})());
ok('U-08 Content-Range 长度为 * 时用 content-length 补总量', (() => {
  const p = U.resumePlan({ partBytes: 1000, statusCode: 206, headers: { ...CR(1000, 1999, '*'), 'content-length': '1000' } });
  return p.append === true && p.totalBytes === 2000;
})());

// ---------- 待回执标记 + 下次启动对账 ----------
const userData = fs.mkdtempSync(path.join(TMP_ROOT, 't02071-pending-'));
ok('U-09 无标记时对账为 null（平时启动不打扰）', U.reconcilePending(U.readPending(userData), '0.1.1011.194') === null);
U.writePending(userData, { filePath: 'D:/dl/MTask Setup 0.1.1012.001.exe', targetVersion: '0.1.1012.001', currentVersion: '0.1.1011.194' });
ok('U-10 标记落盘并可读回（安装前写入，退出后仍在）', U.readPending(userData)?.targetVersion === '0.1.1012.001'
  && fs.existsSync(U.pendingFile(userData)));
ok('U-11 当前版本已达目标版本 → installed（安装器 taskkill 后唯一可判据）', (() => {
  const r = U.reconcilePending(U.readPending(userData), '0.1.1012.001');
  return r.status === 'installed' && r.targetVersion === '0.1.1012.001';
})());
ok('U-12 当前版本仍是旧的 → failed，携带安装包路径与目标版本供重试', (() => {
  const r = U.reconcilePending(U.readPending(userData), '0.1.1011.194');
  return r.status === 'failed' && r.filePath.includes('MTask Setup') && r.targetVersion === '0.1.1012.001'
    && typeof r.reason === 'string' && r.reason.length > 0;
})());
U.clearPending(userData);
ok('U-13 回执消费即清（不会每次启动重复提示）', U.readPending(userData) === null);
ok('U-14 对账不看安装器日志，只认版本：当前更高也算 installed', (() => {
  return U.reconcilePending({ targetVersion: '0.1.1012.001', filePath: 'x' }, '0.1.1013.002').status === 'installed';
})());

// ---------- 安装进程退出码 → 回执 ----------
ok('U-15 退出码 0 → installed', U.installOutcome({ code: 0, timedOut: false }).status === 'installed');
ok('U-16 非 0 退出码 → failed 且原始码随行带出（界面点明原因）', (() => {
  const o = U.installOutcome({ code: 5, timedOut: false });
  return o.status === 'failed' && o.code === 5 && o.message.includes('退出码 5');
})());
ok('U-17 等待超时不判失败（可能正弹授权确认）→ pending 留待下次对账', U.installOutcome({ code: null, timedOut: true }).status === 'pending');

// ---------- 真实 Range 协议：证明「取消后继续」拼出的字节与原包逐字节一致 ----------
const blob = crypto.randomBytes(300_000);
const blobSha = crypto.createHash('sha256').update(blob).digest('hex');
const srv = http.createServer((req, res) => {
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : blob.length - 1;
    res.writeHead(206, {
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${blob.length}`,
    });
    res.end(blob.subarray(start, end + 1));
    return;
  }
  res.writeHead(200, { 'content-length': String(blob.length) });
  res.end(blob);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${srv.address().port}/pkg.exe`;
const tmpDir = fs.mkdtempSync(path.join(TMP_ROOT, 't02071-dl-'));
const partPath = path.join(tmpDir, 'pkg.exe.part');

/** 模拟一次「下载/续传」：按主进程同一套判定（Range 请求头 → resumePlan → append/w flag）落盘 */
async function oneRound(partBytes, cutAfter) {
  const res = await fetch(baseUrl, { headers: partBytes > 0 ? { Range: `bytes=${partBytes}-` } : {} });
  const plan = U.resumePlan({ partBytes, statusCode: res.status, headers: { 'content-range': res.headers.get('content-range'), 'content-length': res.headers.get('content-length') } });
  const out = fs.createWriteStream(partPath, { flags: plan.append ? 'a' : 'w' });
  let written = 0, aborted = false;
  for await (const chunk of res.body) {
    out.write(chunk);
    written += chunk.length;
    if (cutAfter > 0 && partBytes + written >= cutAfter) { aborted = true; break; } // 用户取消：断连，保留 .part
  }
  // 中途取消时显式取消响应流，否则 undici 句柄半挂在退出阶段触发 libuv 断言
  if (aborted) await res.body.cancel();
  await new Promise((r) => out.end(r));
  return { plan, aborted, bytesOnDisk: fs.statSync(partPath).size };
}

const r1 = await oneRound(fs.existsSync(partPath) ? fs.statSync(partPath).size : 0, 120_000);
ok('U-18 首下中途取消：未续传（从 0 起）但 .part 已保留非零字节', r1.plan.append === false && r1.aborted && r1.bytesOnDisk >= 120_000);
const r2 = await oneRound(r1.bytesOnDisk, 260_000);
ok('U-19 取消后再点：服务端按 Range 响应，判定为追加而非重下', r2.plan.append === true && r2.plan.startBytes === r1.bytesOnDisk);
const r3 = await oneRound(r2.bytesOnDisk, 0);
ok('U-20 三段拼接后总长 == 原包长度', r3.plan.append === true && r3.bytesOnDisk === blob.length, `实际 ${r3.bytesOnDisk} / ${blob.length}`);
ok('U-21 拼接产物 sha256 与原包逐字节一致（续传不会拼坏安装包）',
  crypto.createHash('sha256').update(fs.readFileSync(partPath)).digest('hex') === blobSha);
srv.closeAllConnections?.();
await new Promise((r) => srv.close(r));
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.rmSync(userData, { recursive: true, force: true });

// ---------- 批㉖ ①：取证面切到 HEAD（反模式 11：工作树可能躺着别的会话的过期文件） ----------
const cp = require('node:child_process');
const { okPair } = await import(new URL('./lib/anchor-pair.mts', import.meta.url).href);
const headSrc = (rel) => {
  try { return cp.execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }); } catch { return ''; }
};
const SRC = {
  main: headSrc('electron/main.js'),
  preload: headSrc('electron/preload.js'),
  desktop: headSrc('web/src/ui/desktop.ts'),
  settings: headSrc('web/src/pages/SettingsPage.tsx'),
  pkg: headSrc('package.json'),
};
/** 行为腿取值袋：先测后判（反模式 14——配对声明必须排在实测之后） */
const BEV = {};

// ---------- 批㉖ ②：假 electron 宿主——把「接线」真跑起来，而不是读它的源码 ----------
group('B 组 假 electron 宿主驱动（真加载主进程/预加载，真跑 IPC handler）');
/*
 * 本门旧前提写着「主进程/预加载的接线以静态断言钉住（本仓跑不了 Electron IPC）」。批㉖ 证伪它：
 * 用 Module._load 钩子把三条平台边界换成测试替身——`electron`（假 app/ipcMain/Notification…）、
 * `node:https`（转接 node:http，打到门内自建的真实 Range 服务器）、`node:child_process`
 * （把「NSIS 安装器」换成真实 node 子进程，退出码是真的，只有安装器本体是替身）——
 * `electron/main.js` 就能在门进程里真加载，四枚 `update:*` handler 真可调用。
 * 于是 W 组每条字面锚都配上了同义行为腿（判据 3），红因可区分「功能失守」与「等价重构换措辞」。
 */
const Module = require('node:module');
const realCp = require('node:child_process');
const origLoad = Module._load;
const MAIN_PATH = path.join(ROOT, 'electron', 'main.js');
const PRELOAD_PATH = path.join(ROOT, 'electron', 'preload.js');
const KERNEL_PATH = path.join(ROOT, 'electron', 'update-state.js');
const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 起一个「假 electron 主进程」：真 require electron/main.js，只替换平台边界 */
function bootMain({ dirs, version, installers, kernel }) {
  const handlers = new Map();
  const quitCalls = [];
  const spawnLog = [];
  const app = {
    isPackaged: false,
    name: 'MTask',
    requestSingleInstanceLock: () => true,
    on: () => {},
    once: () => {},
    quit: () => { quitCalls.push(Date.now()); },
    // 启动体（建窗、拉后端）不在本门判据面内：让它永不 resolve，门只驱动 update 四枚 IPC
    whenReady: () => new Promise(() => {}),
    // 目录是可换的（dirs 是对象）：同一宿主要在多个「下载现场」之间切换
    getPath: (n) => (n === 'downloads' ? dirs.dl : dirs.ud),
    getVersion: () => version,
    setAppUserModelId: () => {},
  };
  const electronFake = {
    app,
    BrowserWindow: class { constructor() {} static getAllWindows() { return []; } isDestroyed() { return true; } show() {} loadURL() { return Promise.resolve(); } close() {} hide() {} },
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => [] },
    protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
    shell: { openExternal: async () => {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    ipcMain: { handle: (ch, fn) => { handlers.set(ch, fn); }, on: () => {}, removeHandler: () => {} },
    Notification: class { constructor(o) { this.title = o && o.title; } on() {} show() {} static isSupported() { return false; } },
  };
  // 主进程写死 https.get；门的假服务器是 http——把边界转接过来，其余（Range 头、状态码判定、pump）全是真的
  const httpsFake = { get: (target, options, cb) => http.get(target, options, cb) };
  const spawnFake = (cmd, args, opts) => {
    const plan = installers ? installers[cmd] : undefined;
    // 关键取证点：主进程在 spawn 的**同一时刻**标记是否已落盘（写顺序只能在这里看）
    spawnLog.push({ cmd, args, markerBeforeSpawn: U.readPending(dirs.ud), killedHere: !!plan });
    if (!plan) return { on: () => {}, unref: () => {}, kill: () => {} };
    return realCp.spawn(process.execPath, ['-e', plan.script], { stdio: 'ignore' });
  };
  const hook = function (request, parent, isMain) {
    if (request === 'electron') return electronFake;
    if (request === 'node:https' || request === 'https') return httpsFake;
    if (request === 'node:child_process' || request === 'child_process') return Object.assign({}, realCp, { spawn: spawnFake });
    if (kernel && request === './update-state') return kernel;
    return origLoad.call(this, request, parent, isMain);
  };
  delete require.cache[MAIN_PATH];
  Module._load = hook;
  try { require(MAIN_PATH); } finally { Module._load = origLoad; }
  return { handlers, quitCalls, spawnLog };
}

/** 真执行 electron/preload.js：假 contextBridge 捕获白名单，假 ipcRenderer 把调用路由到主进程真 handler */
function bootPreload(handlers) {
  const exposed = {};
  const channelLog = [];
  const listenerLog = [];
  const ipcRenderer = {
    invoke: async (ch, ...a) => {
      const h = handlers.get(ch);
      channelLog.push({ ch, reached: !!h });
      if (!h) throw new Error(`主进程未注册 channel：${ch}`);
      return await h({ sender: {} }, ...a);
    },
    on: (ch) => { listenerLog.push(ch); },
    removeListener: (ch) => { listenerLog.push(`-` + ch); },
  };
  const electronFake = { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } }, ipcRenderer };
  const hook = function (request, parent, isMain) {
    if (request === 'electron') return electronFake;
    return origLoad.call(this, request, parent, isMain);
  };
  delete require.cache[PRELOAD_PATH];
  Module._load = hook;
  try { require(PRELOAD_PATH); } finally { Module._load = origLoad; }
  return { api: exposed.mtaskDesktop, channelLog, listenerLog };
}

// 门自建夹具：一个按 Range 分段、每段限速的真实下载服务器 + 三个「真实退出码」的假安装器
const TMP2 = fs.mkdtempSync(path.join(TMP_ROOT, 't02071-host-'));
const mk = (n) => { const p = path.join(TMP2, n); fs.mkdirSync(p, { recursive: true }); return p; };
// 一套宿主跑多个「下载现场」：dl-a 首下/续传、dl-c 服务端忽略 Range、dl-e 206 起点错位；dl-b 归 Spy 内核宿主
const DIRS_A = { dl: mk('dl-a'), ud: mk('ud-a') };
const DIRS_B = { dl: mk('dl-b'), ud: mk('ud-b') };
const UD_E = mk('ud-e');
const DL_C = mk('dl-c');
const DL_E = mk('dl-e');

const CHUNK = 8192;
const blob2 = crypto.randomBytes(400_000);
const blob2Sha = sha(blob2);
const BAD_START = 32_768; // 「服务端按另一个偏移应答」的现场（CDN 夹断 Range 的真实形态）
const reqLog = [];
const srv2 = http.createServer(async (req, res) => {
  const ignore = /ignore/.test(req.url);
  const badStart = /badstart/.test(req.url);
  const m = ignore ? null : /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
  const start = m ? (badStart ? BAD_START : Number(m[1])) : 0;
  const end = m && m[2] ? Number(m[2]) : blob2.length - 1;
  const status = m ? 206 : 200;
  reqLog.push({ url: req.url, range: req.headers.range ?? null, status, servedFrom: start });
  if (m) res.writeHead(206, { 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${blob2.length}` });
  else res.writeHead(200, { 'content-length': String(blob2.length) });
  for (let p = start; p <= end; p += CHUNK) {
    if (res.destroyed || res.writableEnded) return;
    if (!res.write(blob2.subarray(p, Math.min(p + CHUNK, end + 1)))) await new Promise((r) => res.once('drain', r));
    await sleep(6);
  }
  res.end();
});
await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
const PORT2 = srv2.address().port;
const url2 = `http://127.0.0.1:${PORT2}/pkg.exe`;
const urlIgnore = `http://127.0.0.1:${PORT2}/pkg-ignore.exe`;
const urlBadStart = `http://127.0.0.1:${PORT2}/pkg-badstart.exe`;

// 假安装器：真实子进程、真实退出码（第一次 5、重试 0 的「同一包」正是重试复用的现场）
const counterFile = path.join(TMP2, 'retry-count.txt');
const installers = {
  [path.join(TMP2, 'Setup-retry.exe')]: { script: `const fs=require('fs');const c=${JSON.stringify(counterFile)};const n=fs.existsSync(c)?Number(fs.readFileSync(c,'utf8')):0;fs.writeFileSync(c,String(n+1));process.exit(n===0?5:0)` },
  [path.join(TMP2, 'Setup-quit.exe')]: { script: 'setTimeout(() => process.exit(0), 250)' },
};
for (const f of Object.keys(installers)) fs.writeFileSync(f, 'fake installer (门内测试替身，不是真安装包)');
const RETRY_PKG = path.join(TMP2, 'Setup-retry.exe');
const QUIT_PKG = path.join(TMP2, 'Setup-quit.exe');

let bootErr = '';
let host = null;
let hostB = null;
try {
  host = bootMain({ dirs: DIRS_A, version: '0.1.1011.194', installers });
  // 判定委托探针：把内核 resumePlan 的 append 结论**强行改为 true**（真值本应是 false——服务端忽略了 Range），
  // 主进程若另写一套判定，产物不会随之变化；真委托则同一现场被拼坏
  const spyCalls = [];
  hostB = bootMain({
    dirs: DIRS_B, version: '0.1.1011.194', installers,
    kernel: Object.assign({}, U, { resumePlan: (a) => { spyCalls.push(a); return Object.assign({}, U.resumePlan(a), { append: true }); } }),
  });
  host.spyCalls = spyCalls;
} catch (e) {
  bootErr = e instanceof Error ? `${e.message}\n${(e.stack || '').split('\n').slice(0, 3).join('\n')}` : String(e);
}
ok('B-00 假 electron 宿主可真加载主进程（后续所有行为腿的前置）', !!host && !!hostB, bootErr || undefined);

let cancelRes = null; let dl1 = null; let dl2 = null; let diskAfter = 0; let spliceSha = '';
let ignoreRes = null; let ignoreSha = ''; let ignoreSize = 0;
let spyRes = null; let spySpliceSha = ''; let spySizeB = 0; let prefixBytes = 65_536;
let badRes = null; let badSize = 0; let badSha = '';
let irFail = null; let irRetry = null; let quitAfterFail = -1; let quitAfterInstalled = -1; let retryReqDelta = -1;
let pendingNow = null; let idleRes = null; let preload = null; let preloadErr = '';
if (host) {
  const H = host.handlers;
  // ① 真下载 → 真取消（走主进程 update:cancel，不是门自己模拟）
  const partPath = path.join(DIRS_A.dl, 'pkg.exe.part');
  const p1 = H.get('update:download')(null, url2);
  let waited = 0;
  while (sizeOf(partPath) < CHUNK && waited < 8000) { await sleep(10); waited += 10; }
  cancelRes = await H.get('update:cancel')(null);
  dl1 = await p1;
  const bytesAtCancel = sizeOf(partPath);
  await sleep(250);
  diskAfter = sizeOf(partPath);
  BEV.cancelKeepsPart = dl1?.status === 'cancelled' && bytesAtCancel > 0 && bytesAtCancel < blob2.length && sizeOf(partPath) > 0;
  BEV.streamStopsAfterCancel = diskAfter === bytesAtCancel && diskAfter > 0 && diskAfter < blob2.length;
  ok('B-02 真取消生效：主进程返回 cancelled 且 .part 留在盘上（取消路径不删半成品）', BEV.cancelKeepsPart,
    { status: dl1?.status, partialBytes: dl1?.partialBytes, 磁盘实测: bytesAtCancel, 总量: blob2.length });
  ok('B-03 取消即断流：收口后 250ms 内 .part 字节数不再增长（句柄真被销毁）', BEV.streamStopsAfterCancel,
    { 取消时: bytesAtCancel, '250ms 后': diskAfter });
  // ② 再点一次：主进程自己发 Range、自己判 206、自己追加
  const roundsBefore = reqLog.length;
  dl2 = await H.get('update:download')(null, url2);
  const resumeReq = reqLog[roundsBefore];
  const finalPath = path.join(DIRS_A.dl, 'pkg.exe');
  spliceSha = fs.existsSync(finalPath) ? sha(fs.readFileSync(finalPath)) : '';
  BEV.resumeHeaderFromDisk = dl2?.status === 'downloaded' && dl2?.resumedFrom === diskAfter && resumeReq?.range === `bytes=${diskAfter}-`;
  BEV.secondRoundIs206Append = resumeReq?.status === 206 && dl2?.resumedFrom > 0;
  BEV.resumeSpliceByteExact = spliceSha === blob2Sha && sizeOf(partPath) === 0;
  ok('B-04 续传请求头由磁盘实际大小生成：服务端实测收到 bytes=<disk>-', BEV.resumeHeaderFromDisk,
    { resumedFrom: dl2?.resumedFrom, 磁盘实测: diskAfter, 服务端收到: resumeReq?.range });
  ok('B-05 206 被当合法响应并按段追加，拼接产物 sha256 与原包逐字节一致', BEV.secondRoundIs206Append && BEV.resumeSpliceByteExact,
    { 服务端状态: resumeReq?.status, 拼接sha相同: spliceSha === blob2Sha });
  // ③ 安装：真实子进程退出码 5 → 失败回执，且应用不退出（缺口 2 的落点面）
  irFail = await H.get('update:install')(null, RETRY_PKG, '0.1.1012.001');
  quitAfterFail = host.quitCalls.length;
  BEV.realExitCodeCollected = irFail?.status === 'failed' && irFail?.code === 5 && irFail?.filePath === RETRY_PKG && irFail?.targetVersion === '0.1.1012.001';
  BEV.failureKeepsAppAlive = quitAfterFail === 0 && irFail?.ok === false;
  BEV.markerWrittenBeforeSpawn = host.spawnLog.length > 0 && host.spawnLog[0].markerBeforeSpawn?.targetVersion === '0.1.1012.001';
  ok('B-07 安装回执收的是真实退出码：非 0 → failed 并带出原始码/包路径/目标版本', BEV.realExitCodeCollected,
    { status: irFail?.status, code: irFail?.code, message: irFail?.message });
  ok('B-08 失败不退出应用（回执与重试的前提）：本次安装后 app.quit 调用数为 0', BEV.failureKeepsAppAlive,
    { quitCalls: quitAfterFail });
  ok('B-10 待回执标记先于 spawn 落盘（安装器 taskkill 后仍能回执的根据）', BEV.markerWrittenBeforeSpawn,
    { 拉起安装器时的标记: host.spawnLog[0]?.markerBeforeSpawn });
  // ④ 重试：拿失败回执里的两个入参再装一次，中间**不允许**产生任何下载请求
  const roundsAtRetry = reqLog.length;
  irRetry = await H.get('update:install')(null, irFail.filePath, irFail.targetVersion);
  quitAfterInstalled = host.quitCalls.length;
  await sleep(1300); // 成功路径的 app.quit 在 800ms 后
  const quitFinal = host.quitCalls.length;
  BEV.retryReusesPackageWithoutDownload = irRetry?.status === 'installed' && reqLog.length === roundsAtRetry && irRetry?.message?.includes('安装完成');
  retryReqDelta = reqLog.length - roundsAtRetry;
  BEV.quitOnlyAfterInstalled = quitAfterInstalled === 0 && quitFinal === 1;
  ok('B-09 重试复用已下载包：同一包路径再装即 installed，期间服务端下载请求数零增长（不重新下载）', BEV.retryReusesPackageWithoutDownload,
    { status: irRetry?.status, 安装前后下载请求: [roundsAtRetry, reqLog.length] });
  ok('B-11 installed 才 app.quit 且恰一次（失败路径 0 次、成功路径 1 次）', BEV.quitOnlyAfterInstalled,
    { 失败后: quitAfterFail, 刚返回时: quitAfterInstalled, '1.3s 后': quitFinal });
  // ⑤ 判定委托（依赖注入反证）：同一现场「本地有 .part + 服务端忽略 Range 回 200 全量」，
  //    真内核判「不追加」→ 删 .part 从 0 重写 → 逐字节一致；把内核结论强改为「追加」→ 产物立刻被拼坏。
  //    产物随内核结论而变，才是「主进程没有第二套判定」的可证事实（正则锚点永远测不出这件事）。
  DIRS_A.dl = DL_C;
  fs.writeFileSync(path.join(DL_C, 'pkg-ignore.exe.part'), blob2.subarray(0, prefixBytes));
  ignoreRes = await H.get('update:download')(null, urlIgnore);
  ignoreSize = sizeOf(path.join(DL_C, 'pkg-ignore.exe'));
  ignoreSha = ignoreSize ? sha(fs.readFileSync(path.join(DL_C, 'pkg-ignore.exe'))) : '';
  BEV.ignoreRangeRewindsFromZero = ignoreRes?.status === 'downloaded' && ignoreRes?.resumedFrom === 0
    && ignoreSize === blob2.length && ignoreSha === blob2Sha;
  ok('B-06a 服务端忽略 Range 回 200 全量时，主进程删半截 .part 从 0 重写并逐字节一致', BEV.ignoreRangeRewindsFromZero,
    { status: ignoreRes?.status, resumedFrom: ignoreRes?.resumedFrom, 落盘: ignoreSize, 原包: blob2.length });
  fs.writeFileSync(path.join(DIRS_B.dl, 'pkg-ignore.exe.part'), blob2.subarray(0, prefixBytes));
  spyRes = await hostB.handlers.get('update:download')(null, urlIgnore);
  spySizeB = sizeOf(path.join(DIRS_B.dl, 'pkg-ignore.exe'));
  spySpliceSha = spySizeB ? sha(fs.readFileSync(path.join(DIRS_B.dl, 'pkg-ignore.exe'))) : '';
  BEV.kernelDelegationProven = BEV.ignoreRangeRewindsFromZero === true
    && spyRes?.status === 'downloaded' && spySizeB === blob2.length + prefixBytes
    && spySpliceSha !== blob2Sha && host.spyCalls.length > 0;
  ok('B-06b 判定只有一套（内核结论即写流 flag）：同一现场把内核 append 强改为 true，主进程立刻把整包拼到旧半截后（体积 +65536、sha 不再一致）', BEV.kernelDelegationProven,
    { 真内核落盘: ignoreSize, 换内核后落盘: spySizeB, 原包: blob2.length, 内核被问了几次: host.spyCalls.length });
  // ⑥ 缺陷现场刻画（T02644 已建单）：206 但 Content-Range 起点 ≠ 本地 .part 字节数
  //    内核结论「不可拼」是对的，主进程的动作却是「删 .part + 把这条从错误偏移开始的响应体从 0 写完并改名」——
  //    半截包被当成整包，且回 status=downloaded。本条钉的是**现状**（缺陷修好后此条会转红，须同步改成断言「丢弃并重取/长度校验失败」）。
  //    缺陷已按规约建派生单 T02644（四期「【AI回写待审核】应用内更新续传：206 起点错位时半截响应体被当整包落盘并回 downloaded」）。
  //    注意本条是**现状钉住**而非行为腿：它不参与任何字面锚点的绿判定（缺陷修好后本条转红即应改断言），
  //    故不能塞进 BEV 袋——否则 W-05 一类锚点会因产品修好而被误标「行为失守」。
  DIRS_A.dl = DL_E;
  fs.writeFileSync(path.join(DL_E, 'pkg-badstart.exe.part'), blob2.subarray(0, prefixBytes));
  badRes = await H.get('update:download')(null, urlBadStart);
  badSize = sizeOf(path.join(DL_E, 'pkg-badstart.exe'));
  badSha = badSize ? sha(fs.readFileSync(path.join(DL_E, 'pkg-badstart.exe'))) : '';
  const expectCorrupt = blob2.length - BAD_START;
  const badPin = badRes?.status === 'downloaded' && badSize === expectCorrupt && badSha !== blob2Sha;
  ok('B-16 现状钉住（缺陷 T02644 已建单；修好后此条应转红并改断言）：206 起点错位时主进程把「从 32768 起的半截体」当整包落盘并回 downloaded（无总量/校验和兜底）', badPin,
    { status: badRes?.status, 落盘: badSize, 应为整包: blob2.length, 半截起点: BAD_START });
  // ⑥ 预加载面：执行真 preload，把 invoke 路由到真主进程 handler
  try {
    preload = bootPreload(H);
    const keys = Object.keys(preload.api ?? {});
    const invokeOnly = ['openDirectory', 'downloadUpdate', 'cancelUpdateDownload', 'installUpdate', 'getUpdatePendingResult', 'getNotifyEnabled', 'setNotifyEnabled'];
    const results = {};
    for (const k of invokeOnly) {
      try { results[k] = await preload.api[k](k === 'downloadUpdate' ? '' : k === 'installUpdate' ? 'D:/不存在.exe' : k === 'setNotifyEnabled' ? true : undefined); }
      catch (e) { results[k] = `抛出：${e.message}`; }
    }
    const missing = preload.channelLog.filter((c) => !c.reached);
    const unsubA = preload.api.onUpdateProgress(() => {}); const unsubB = preload.api.onNavigateTask(() => {});
    unsubA(); unsubB();
    BEV.preloadSurfaceWired = missing.length === 0
      && ['cancelUpdateDownload', 'getUpdatePendingResult', 'downloadUpdate', 'installUpdate', 'onUpdateProgress'].every((k) => keys.includes(k))
      && results.cancelUpdateDownload?.status === 'idle' && results.getUpdatePendingResult === null
      && host.handlers.has('update:cancel') && host.handlers.has('update:pending-result')
      && preload.listenerLog.includes('update:progress') && preload.listenerLog.includes('notify:navigate')
      && preload.listenerLog.includes('-update:progress');
    idleRes = results.cancelUpdateDownload; pendingNow = results.getUpdatePendingResult;
    ok('B-01 preload 白名单与主进程注册表双向对应：每个 invoke 都落到真 handler，四枚 update channel 齐备', BEV.preloadSurfaceWired,
      { 未注册的channel: missing, 往返: { cancel: idleRes, pendingResult: pendingNow } });
    // ⑦ 返回契约形状（W-11 的同义行为：不再是 string/裸 ok）
    BEV.receiptIsStatusedObject = dl2 && typeof dl2 === 'object' && dl2.status === 'downloaded'
      && typeof irFail === 'object' && 'ok' in irFail && 'status' in irFail && typeof irRetry === 'object' && 'status' in irRetry;
    ok('B-12 主进程返回契约是带 status 的结果对象（渲染侧据此分取消/续传/失败三态）', BEV.receiptIsStatusedObject,
      { download: dl2?.status, installFail: irFail?.status, installRetry: irRetry?.status });
  } catch (e) {
    preloadErr = e instanceof Error ? e.message : String(e);
    BEV.preloadSurfaceWired = false;
    ok('B-01 preload 白名单与主进程注册表双向对应（执行真 preload）', false, preloadErr);
  }
} else {
  ok('B-01/B-04~B-12 假宿主未起来，行为腿全部不成立', false, bootErr.slice(0, 300));
}

// ⑧ 内核导出面 + 本地 require 文件真能加载（W-01 / W-14 的行为腿）
const KERNEL_EXPORTS = ['parseVersion', 'cmpVersion', 'resumePlan', 'pendingFile', 'writePending', 'readPending', 'clearPending', 'reconcilePending', 'installOutcome'];
BEV.kernelExportsComplete = KERNEL_EXPORTS.every((k) => typeof U[k] === 'function');
const localRequires = [...SRC.main.matchAll(/require\('\.\/([\w-]+)'\)/g)].map((m) => `electron/${m[1]}.js`);
const buildFiles = JSON.parse(SRC.pkg || '{}')?.build?.files ?? [];
const unloadable = localRequires.filter((f) => !headSrc(f) || headSrc(f).length < 50);
try {
  // 装机版的崩点就在 require：这里真的把 HEAD 里的每个本地依赖加载一次（临时目录里放 HEAD 版本，不读工作树）
  for (const f of localRequires) {
    const tmpCopy = path.join(TMP2, `headload-${path.basename(f)}`);
    fs.writeFileSync(tmpCopy, headSrc(f));
    require(tmpCopy);
  }
} catch (e) {
  unloadable.push(`加载抛错：${e instanceof Error ? e.message : String(e)}`);
}
BEV.requiredFilesLoad = localRequires.length > 0 && unloadable.length === 0 && localRequires.every((f) => buildFiles.includes(f));
ok('B-13 决策内核导出面齐全，且主进程本地 require 的每个文件在 HEAD 里真存在、真能加载', BEV.kernelExportsComplete && BEV.requiredFilesLoad,
  { 内核导出: KERNEL_EXPORTS.filter((k) => typeof U[k] !== 'function'), 本地依赖: localRequires, 未登记进白名单: localRequires.filter((f) => !buildFiles.includes(f)), 加载失败: unloadable });

// ⑨ 跨进程对账：真的再起一个进程，读同一份待回执标记按当前版本收敛（W-09 的行为腿）
UD_E && U.writePending(UD_E, { filePath: RETRY_PKG, targetVersion: '0.1.1012.001', currentVersion: '0.1.1011.194', startedAt: new Date().toISOString() });
const reconcileInChild = (currentVersion) => {
  const script = `const U=require(${JSON.stringify(KERNEL_PATH)});const m=U.readPending(process.argv[1]);process.stdout.write(JSON.stringify(U.reconcilePending(m,process.argv[2])))`;
  return JSON.parse(cp.execFileSync(process.execPath, ['-e', script, UD_E, currentVersion], { encoding: 'utf8' }));
};
const rcStale = reconcileInChild('0.1.1011.194');
const rcReached = reconcileInChild('0.1.1012.001');
BEV.crossProcessReconcile = rcStale?.status === 'failed' && rcStale?.filePath === RETRY_PKG && rcStale?.targetVersion === '0.1.1012.001'
  && typeof rcStale?.reason === 'string' && rcStale.reason.length > 0 && rcReached?.status === 'installed';
ok('B-14 下次启动对账是跨进程事实：新进程读同一标记，仍旧版本判 failed（带包路径与目标版本供重试），达标判 installed', BEV.crossProcessReconcile,
  { 旧版本: rcStale, 新版本: rcReached });

// ---------- 接线字面锚点：全部改为「行为腿 + HEAD 字面腿」配对（判据 3，红因可区分） ----------
group('W 组 接线字面锚点 × 行为腿配对（行为腿不成立即红因「行为失守」）');
const SP = [
  { id: 'W-01', label: 'W-01 主进程引用决策内核（不在 main.js 里另写一套判定）', file: 'main',
    anchors: [
      { file: 'main', token: "require('./update-state')", re: /require\('\.\/update-state'\)/, want: true },
      { file: 'main', token: 'resumePlan', re: /resumePlan/, want: true },
      { file: 'main', token: 'installOutcome', re: /installOutcome/, want: true },
    ],
    behavior: () => BEV.kernelExportsComplete === true && BEV.kernelDelegationProven === true },
  { id: 'W-02', label: 'W-02 缺口 1 有落点：update:cancel IPC 存在且保留 .part（取消路径不删半成品）',
    anchors: [
      { file: 'main', token: "ipcMain.handle('update:cancel'", re: /ipcMain\.handle\('update:cancel'/, want: true },
      { file: 'main', token: 'if (!ctx.cancelled) { try { fs.rmSync(tmpPath', re: /if \(!ctx\.cancelled\) \{ try \{ fs\.rmSync\(tmpPath/, want: true },
    ],
    behavior: () => BEV.cancelKeepsPart === true },
  { id: 'W-03', label: 'W-03 下载句柄被登记（取消才有东西可断）',
    anchors: [
      { file: 'main', token: 'let activeDownload = null;', re: /let activeDownload = null;/, want: true },
      { file: 'main', token: 'activeDownload = ctx;', re: /activeDownload = ctx;/, want: true },
    ],
    behavior: () => BEV.streamStopsAfterCancel === true },
  { id: 'W-04', label: 'W-04 续传请求头按 .part 实际大小生成',
    anchors: [
      { file: 'main', token: 'headers.Range = `bytes=${partBytes}-`', re: /headers\.Range = `bytes=\$\{partBytes\}-`/, want: true },
      { file: 'main', token: 'partBytes: fileSizeOf(tmpPath)', re: /partBytes: fileSizeOf\(tmpPath\)/, want: true },
    ],
    behavior: () => BEV.resumeHeaderFromDisk === true },
  { id: 'W-05', label: 'W-05 206 被当合法响应（原实现只认 200，Range 续传会被误判失败）',
    anchors: [{ file: 'main', token: 'res.statusCode !== 200 && res.statusCode !== 206', re: /res\.statusCode !== 200 && res\.statusCode !== 206/, want: true }],
    behavior: () => BEV.secondRoundIs206Append === true && BEV.resumeSpliceByteExact === true && BEV.ignoreRangeRewindsFromZero === true },
  { id: 'W-06', label: 'W-06 缺口 2 有落点：安装器不再 detached 即退，改为等退出码',
    anchors: [
      { file: 'main', token: "spawn(filePath, ['/S'], { detached: true", re: /spawn\(filePath, \['\/S'\], \{ detached: true/, want: false },
      { file: 'main', token: "child.on('exit', (code)", re: /child\.on\('exit', \(code\)/, want: true },
    ],
    behavior: () => BEV.realExitCodeCollected === true },
  { id: 'W-07', label: 'W-07 安装前落待回执标记，成功后才 app.quit',
    anchors: [
      { file: 'main', token: "writePending(app.getPath('userData')", re: /writePending\(app\.getPath\('userData'\)/, want: true },
      { file: 'main', token: 'setTimeout(() => app.quit(), 800)', re: /setTimeout\(\(\) => app\.quit\(\), 800\)/, want: true },
    ],
    behavior: () => BEV.markerWrittenBeforeSpawn === true && BEV.quitOnlyAfterInstalled === true },
  { id: 'W-08', label: 'W-08 失败/超时不退出应用（回执与重试的前提）',
    anchors: [{ file: 'main', token: 'setTimeout(() => app.quit(), 1500)', re: /setTimeout\(\(\) => app\.quit\(\), 1500\)/, want: false }],
    behavior: () => BEV.failureKeepsAppAlive === true },
  { id: 'W-09', label: 'W-09 下次启动对账已挂进 whenReady，并经 IPC 回给界面',
    anchors: [
      { file: 'main', token: 'reconcilePendingUpdateOnLaunch();', re: /reconcilePendingUpdateOnLaunch\(\);/, want: true },
      { file: 'main', token: "ipcMain.handle('update:pending-result'", re: /ipcMain\.handle\('update:pending-result'/, want: true },
    ],
    behavior: () => BEV.crossProcessReconcile === true },
  { id: 'W-10', label: 'W-10 preload 白名单补齐取消与回执两个能力',
    anchors: [
      { file: 'preload', token: "cancelUpdateDownload: () => ipcRenderer.invoke('update:cancel')", re: /cancelUpdateDownload: \(\) => ipcRenderer\.invoke\('update:cancel'\)/, want: true },
      { file: 'preload', token: "getUpdatePendingResult: () => ipcRenderer.invoke('update:pending-result')", re: /getUpdatePendingResult: \(\) => ipcRenderer\.invoke\('update:pending-result'\)/, want: true },
    ],
    behavior: () => BEV.preloadSurfaceWired === true },
  { id: 'W-11', label: 'W-11 渲染侧类型与主进程返回契约同步（不再是 string/裸 ok）',
    anchors: [
      { file: 'desktop', token: 'downloadUpdate?: (url: string) => Promise<UpdateDownloadResult>', re: /downloadUpdate\?: \(url: string\) => Promise<UpdateDownloadResult>/, want: true },
      { file: 'desktop', token: 'installUpdate?: (filePath: string, targetVersion?: string) => Promise<UpdateInstallResult>', re: /installUpdate\?: \(filePath: string, targetVersion\?: string\) => Promise<UpdateInstallResult>/, want: true },
    ],
    behavior: () => BEV.receiptIsStatusedObject === true },
  { id: 'W-12', label: 'W-12 界面：下载中有「取消下载」，取消后主按钮变「继续下载」',
    anchors: [
      { file: 'settings', token: 'doCancelDownload', re: /doCancelDownload/, want: true },
      { file: 'settings', token: '取消下载', re: /取消下载/, want: true },
      { file: 'settings', token: "'继续下载'", re: /'继续下载'/, want: true },
    ],
    behavior: () => BEV.cancelKeepsPart === true && BEV.resumeHeaderFromDisk === true },
  { id: 'W-13', label: 'W-13 界面：安装失败回执条 + 重试复用安装包（不重新下载）',
    anchors: [
      { file: 'settings', token: '安装失败：{installError.message}', re: /安装失败：\{installError\.message\}/, want: true },
      { file: 'settings', token: 'runInstall(installError.filePath, installError.targetVersion)', re: /runInstall\(installError\.filePath, installError\.targetVersion\)/, want: true },
    ],
    behavior: () => BEV.retryReusesPackageWithoutDownload === true },
  { id: 'W-14', label: 'W-14 主进程本地 require 的每个文件都在 build.files 白名单里（装机版不会缺文件崩在 require）',
    anchors: [{ file: 'pkg', token: '"electron/update-state.js"', re: /"electron\/update-state\.js"/, want: true }],
    behavior: () => BEV.requiredFilesLoad === true },
];
const litOn = (spec, src) => spec.anchors.every((a) => new RegExp(a.re.source, a.re.flags).test(src[a.file] ?? '') === a.want);
for (const spec of SP) {
  okPair(ok, spec.label, spec.behavior, () => litOn(spec, SRC), () => ({ 锚点: spec.anchors.map((a) => `${a.file}:${a.want ? '须有' : '须无'}:${a.token}`), 行为袋: Object.keys(BEV).filter((k) => BEV[k] === false) }));
}

// ---------- N 组 负对照（判据 ④：改判必须自证「不是恒绿」） ----------
group('N 组 负对照');
const collectPairs = () => {
  const out = [];
  const rec = (name, cond, detail) => out.push({ name, cond, detail });
  for (const spec of SP) okPair(rec, spec.label, spec.behavior, () => litOn(spec, SRC), () => detailCtx(spec));
  return out;
};
const detailCtx = (spec) => ({ 锚点: spec.anchors.map((a) => a.token) });

// N-01 空源码同义反复探针：每条「须有」锚点在空源码下必须失配（否则锚点是恒真摆设）
{
  const vacuous = SP.flatMap((s) => s.anchors).filter((a) => a.want)
    .filter((a) => new RegExp(a.re.source, a.re.flags).test('') === true).map((a) => a.token);
  ok('N-01 空源码下所有正向锚点都失配（无一条是恒真摆设）', vacuous.length === 0, vacuous);
}
// N-02 HEAD 取证面在场性：反向锚点（「须无」）只有在源码真取到才是有意义的
{
  const missing = Object.entries(SRC).filter(([, v]) => !v || v.length < 200).map(([k]) => k);
  ok('N-02 五份 HEAD 取证面全部在场（反向锚点不因取不到源码而空转）', missing.length === 0, missing);
}
// N-03 逐锚变异：正向锚改名、反向锚注入，落地自证后字面腿必须失配（反模式 31 两坑已写进规约）
{
  const bad = [];
  for (const spec of SP) {
    for (const a of spec.anchors) {
      const orig = SRC[a.file] ?? '';
      const tampered = a.want ? orig.split(a.token).join('__RENAMED__') : `${orig}\n/* ${a.token} 门注入的禁词 */\n`;
      const landed = a.want ? !tampered.includes(a.token) : tampered.includes(a.token);
      const flipped = new RegExp(a.re.source, a.re.flags).test(tampered) === a.want;
      if (!landed || flipped) bad.push({ id: spec.id, token: a.token, 变异落地: landed, 锚点仍绿: flipped });
    }
  }
  ok('N-03 逐锚变异（正向改名 / 反向注入）后字面腿全部失配，且变异确已落地', bad.length === 0, bad.slice(0, 6));
}
// N-04 行为袋抽干：把 BEV 全置 false，每条配对必须转红且红因是「行为失守」
{
  const saved = Object.assign({}, BEV);
  for (const k of Object.keys(BEV)) BEV[k] = false;
  const drained = collectPairs();
  for (const k of Object.keys(saved)) BEV[k] = saved[k];
  const restored = collectPairs();
  const allRed = drained.filter((r) => r.cond);
  const wrongCause = drained.filter((r) => r.cond === false && !String(r.detail?.红因).includes('行为失守')).map((r) => r.name);
  const stillGreen = restored.filter((r) => !r.cond).map((r) => r.name);
  ok('N-04 行为袋抽干后 14 条配对全红（红因均为行为失守），恢复后复绿', allRed.length === 0 && wrongCause.length === 0 && restored.length === SP.length && stillGreen.length === 0,
    { 抽干后仍绿: allRed.length, 红因不符: wrongCause, 恢复后转红: stillGreen });
}
// N-05 逐条行为腿破坏：行为袋每个键都真被某条配对依赖（单独破坏它必有配对转红，无孤立腿）
{
  const saved = Object.assign({}, BEV);
  const orphans = [];
  const baseGreen = collectPairs().filter((r) => r.cond).length;
  for (const key of Object.keys(BEV)) {
    if (typeof BEV[key] !== 'boolean') continue;
    BEV[key] = false;
    const broke = collectPairs().filter((r) => r.cond === false).map((r) => r.name);
    BEV[key] = saved[key];
    if (broke.length === 0) orphans.push(key);
  }
  ok('N-05 行为袋每个键都真被某条配对依赖（单独破坏它必有配对转红，无孤立腿）', orphans.length === 0 && baseGreen === SP.length,
    { 孤立键: orphans, 基线绿数: baseGreen, 配对总数: SP.length });
}
// N-06 空注册表反证：把主进程 handler 表换成空的，preload 对应性检查必须转假
{
  const emptyApi = (() => { try { return bootPreload(new Map()); } catch { return null; } })();
  const reached = emptyApi ? emptyApi.channelLog.filter((c) => c.reached).length : -1;
  ok('N-06 空注册表下「channel 全部可达」判据转假（证明 B-01 不是恒真探针）', emptyApi !== null && reached === 0,
    { 命中数: reached, 调用记录: emptyApi?.channelLog?.length });
}
// N-07/N-08/N-09 okPair 契约本身
{
  const rec = [];
  const spy = (name, cond, detail) => rec.push({ name, cond, detail });
  okPair(spy, '契约-双绿', () => true, () => true);
  okPair(spy, '契约-行为红字面绿', () => false, () => true);
  okPair(spy, '契约-行为绿字面红', () => true, () => false);
  okPair(spy, '契约-行为抛错', () => { throw new Error('boom'); }, () => true);
  okPair(spy, '契约-字面抛错', () => true, () => { throw new Error('badre'); });
  const byName = Object.fromEntries(rec.map((r) => [r.name, r]));
  ok('N-07 okPair 契约：双绿才 PASS，其余四种红因各归其位', byName['契约-双绿'].cond === true
    && String(byName['契约-行为红字面绿'].detail.红因).includes('行为失守')
    && String(byName['契约-行为绿字面红'].detail.红因).includes('字面锚点失配')
    && String(byName['契约-行为抛错'].detail.红因).includes('行为断言抛错')
    && String(byName['契约-字面抛错'].detail.红因).includes('字面锚点抛错'), rec.map((r) => ({ n: r.name, c: r.cond, 红因: r.detail?.红因 })));
}
// N-10 关键数值逐一点名（防「断言写成真值表达式」）
{
  const expect = [
    ['取消时磁盘字节在 (0, 总量) 之间', diskAfter, (v) => v > 0 && v < blob2.length],
    ['续传起点逐字等于取消后磁盘字节', dl2?.resumedFrom, (v) => v === diskAfter],
    ['失败回执退出码 == 5', irFail?.code, (v) => v === 5],
    ['重试期间服务端下载请求零增长', retryReqDelta, (v) => v === 0],
    ['installed 后 app.quit 恰一次', host?.quitCalls.length, (v) => v === 1],
    ['真内核忽略 Range 现场从 0 重写（体积恰等于原包）', ignoreSize, (v) => v === blob2.length && ignoreRes?.resumedFrom === 0],
    ['换内核（append 强改 true）后体积多出半截前缀', spySizeB, (v) => v === blob2.length + prefixBytes && spySpliceSha !== blob2Sha],
    ['206 起点错位现场半截体被当整包（缺陷钉住的体积口径）', badSize, (v) => v === blob2.length - BAD_START],
  ];
  const bad = expect.filter(([, v, p]) => !p(v)).map(([label]) => label);
  ok('N-10 八项关键实测数值逐条点名（取消量/续传起点/退出码/重试请求数/quit 次数/两种内核结论下的体积/缺陷体积）', bad.length === 0,
    { 失配: bad, 实测: { diskAfter, resumedFrom: dl2?.resumedFrom, code: irFail?.code, retryReqDelta, quit: host?.quitCalls.length, ignoreSize, spySizeB, badSize } });
}

// ---------- 收口 ----------
srv2.closeAllConnections?.();
await new Promise((r) => srv2.close(r));
fs.rmSync(TMP2, { recursive: true, force: true });

console.log(`verify-t02071-update-flow: PASS=${pass} FAIL=${fail}`);
process.exitCode = fail > 0 ? 1 : 0; // 自然退出（硬 exit 会与未释放的 undici 句柄撞 libuv 断言）

console.log(`verify-t02071-update-flow: PASS=${pass} FAIL=${fail}`);
process.exitCode = fail > 0 ? 1 : 0; // 自然退出（硬 exit 会与未释放的 undici 句柄撞 libuv 断言）
