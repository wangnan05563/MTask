/**
 * MTask 桌面壳主进程（Electron）。
 * 职责：
 *  1. 以子进程方式启动 server（tsx/打包 dist，127.0.0.1:39876），等待健康就绪；
 *  2. 注册 api:// 自定义协议，将页面中的 API 请求代理到本地服务；
 *  3. 生产模式加载 web/dist 产物；开发模式（MTask_DEV=1）加载 Vite dev server。
 *
 * 启动体验：先创建「启动窗」（brand 图 + 进度条），按真实加载阶段推进进度——
 *  创建启动窗 → 检测/启动后端服务 → 等待就绪 → 主窗口加载完成 → 完成并关闭启动窗。
 * 进度点对应真实完成事件；后端等待期为“正在加载”的视觉推进，不做虚假的完成宣称。
 *
 * 运行前提：server/ 与 web/ 依赖已安装、web 已构建（scripts\构建打包.bat）。
 */

const { app, BrowserWindow, Menu, protocol, shell, dialog, ipcMain, Notification } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
// T02071：更新的取消/续传/安装回执决策内核（纯函数，可脱离 electron 单测）
// T02740：在线更新 latest-release 判定并入同一内核（新文件需入 build.files 白名单，package.json 正被并发会话占用）
const { resumePlan, writePending, readPending, clearPending, reconcilePending, installOutcome } = require('./update-state');

const DEV = process.env.MTask_DEV === '1';
const VITE_PORT = 5175;
// 打包态使用独立端口，避免复用 39876 上仍在运行的开发服务：
// 该服务（启动服务.bat 拉起的 tsx）连接的是开发库 server/src/data，
// 被复用会导致安装后启动读到开发数据而非 %APPDATA% 正式库。
// 允许用 MTask_PORT 显式覆盖（开发/打包均生效），打包态默认 39877。
let SERVER_PORT = Number(process.env.MTask_PORT ?? (app.isPackaged ? 39877 : 39876));
const SERVER_HOST = '127.0.0.1';

// 单实例锁：应用持有唯一用户数据目录（%APPDATA%\MTask\data）。多个实例并发打开并写入
// 同一 SQLite 库时，Windows 文件锁偶发触发 SQLITE_IOERR_TRUNCATE 崩溃（表现即「后端未连接」）。
// 同一时间只保留一个实例，从源头避免并发写同一数据库文件。
if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });
} else {
  app.quit();
}

let serverProc = null;
let splashWin = null;
let mainWin = null;
let backendReady = false;
let uiReady = false;
let ticker = null;

/** 一次性探测后端是否已在监听（脚本先行启动服务时，壳直接复用） */
function probeHealthOnce() {
  return new Promise((resolve) => {
    const req = http.get({ host: SERVER_HOST, port: SERVER_PORT, path: '/api/health', timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** 数据目录：打包后写入用户数据目录；开发态沿用 server/data */
function dataDir() {
  return app.isPackaged
    ? path.join(app.getPath('userData'), 'data')
    : undefined;
}

/** 轮询后端健康检查直至就绪（最多约 60s） */
function waitForServer(tries = 60) {
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get({ host: SERVER_HOST, port: SERVER_PORT, path: '/api/health', timeout: 1000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); });
      function retry() {
        if (tries <= 0) return reject(new Error(`server 未就绪 (127.0.0.1:${SERVER_PORT})`));
        tries -= 1;
        setTimeout(probe, 1000);
      }
    };
    probe();
  });
}

/** 启动内嵌后端服务。
 *  开发态：tsx 直接跑 TS 源码；打包后：以 ELECTRON_RUN_AS_NODE 方式用 Electron 自带 Node 运行 dist/index.js。
 */
function startServer() {
  // 打包态：server/dist 与全部依赖都打进 app.asar（asarUnpack 只保留 better-sqlite3 原生模块）。
  // 入口用 asar 内绝对路径（Electron 的 asar 钩子会按入口文件的 asar 位置解析 require），
  // 但 spawn 的 cwd 必须指向真实存在的目录——asar 内路径不是真实文件系统，作为 cwd 会导致 spawn 失败。
  const serverDir = path.join(__dirname, '..', 'server');
  const env = {
    ...process.env,
    MTask_PORT: String(SERVER_PORT),
  };
  const dir = dataDir();
  if (dir) env.MTask_DATA_DIR = dir;

  if (app.isPackaged) {
    env.ELECTRON_RUN_AS_NODE = '1';
    // 后端子进程的 stdout/stderr 重定向到 userData 下的日志文件：
    // 桌面双击启动无控制台，stdio:'inherit' 时 server 的报错会被直接丢弃，导致“未连接”时无从定位。
    // 落盘后即便再次失败，也能从该日志复现真实原因（端口占用/缺依赖/被杀软拦截等）。
    const serverLogFd = fs.openSync(path.join(app.getPath('userData'), 'server-startup.log'), 'a');
    serverProc = spawn(process.execPath, [path.join(serverDir, 'dist', 'index.js')], {
      // resourcesPath（<install>/resources）为真实目录，可作为子进程 cwd；asar 钩子对 cwd 无要求
      cwd: process.resourcesPath,
      env,
      stdio: ['ignore', serverLogFd, serverLogFd],
    });
    fs.closeSync(serverLogFd);
  } else {
    const tsxCli = require.resolve('tsx/cli');
    serverProc = spawn(process.execPath, [tsxCli, path.join(serverDir, 'src', 'index.ts')], {
      cwd: serverDir,
      env,
      stdio: 'inherit',
    });
  }

  // 容错：spawn 失败（如 ENOENT、被杀软拦截、路径异常）会以 'error' 事件异步发出。
  // 不挂监听就会冒成 uncaughtException 崩主进程（弹"A JavaScript error occurred in the main process"）。
  // 这里捕获后更新启动窗文案，让用户看到明确失败原因而不是被 Electron 默认错误框打断。
  if (serverProc) {
    const serverLog = path.join(app.getPath('userData'), 'server-startup.log');
    // server 子进程退出/报错时追加到日志，便于“未连接”时定位后端启动失败的真实原因
    serverProc.on('exit', (code, sig) => {
      try { fs.appendFileSync(serverLog, `[main] 后端子进程退出 code=${code} signal=${sig}\n`); } catch {}
    });
    serverProc.on('error', (err) => {
      try { fs.appendFileSync(serverLog, `[main] 后端 spawn 失败: ${err.code || ''} ${err.message}\n`); } catch {}
      console.error('[mtask] 后端子进程启动失败:', err.message);
      serverProc = null;
      stopTicker();
      updateSplash(66, `后端启动失败: ${err.code || ''} ${err.message}`.trim());
    });
  }
}

let quitting = false;

/** 可靠终止内嵌后端：kill 后等待其真正 exit，超时再强杀兜底。
 *  目的：避免关窗后残留进程继续占用 better_sqlite3 的 DLL 与端口，
 *  否则下次 electron-rebuild 覆盖 .node 时会因 EPERM 失败。 */
function killServerProc() {
  if (!serverProc) return Promise.resolve();
  const proc = serverProc;
  serverProc = null;
  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(escalate);
      clearTimeout(force);
      resolve();
    };
    // 3s 后仍未退出则升级为强杀，避免优雅退出被挂起
    const escalate = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (err) {
        // 强杀失败多因进程恰好自行退出或句柄失效，已无升级手段；
        // 留日志便于排查"后端为何未在优雅期内退出"（如 DLL 占用残留）
        console.warn('[mtask] SIGKILL 强杀后端子进程失败:', err.message);
      }
    }, 3000);
    // 兜底：最迟 6s 放行退出，不阻塞应用关闭
    const force = setTimeout(finish, 6000);
    proc.once('exit', finish);
    try {
      proc.kill();
    } catch (err) {
      // 优雅终止失败（进程可能已退出）：记录原因后直接放行退出流程，避免阻塞应用关闭
      console.warn('[mtask] 优雅终止后端子进程失败:', err.message);
      finish();
    }
  });
}

/** 退出统一入口：
 *  复用外部后端则直接退出；自拉后端则可靠终止后再彻底退出。
 *  - 幂等：quitting 守卫保证清理只启动一次，不会重复 kill；
 *  - 最终用 app.exit 而非 app.quit，避免再次进入 before-quit 而在清理期间被提前放行，
 *    杜绝“kill 尚在兜底窗口内二次退出 → 后端子进程残留”的时序问题。 */
function requestQuit() {
  if (quitting) return;
  if (!serverProc) { app.exit(0); return; }
  quitting = true;
  killServerProc().finally(() => app.exit(0));
}

app.on('before-quit', (e) => {
  // 一律拦截，统一由 requestQuit 控制；清理完成用 app.exit 跳过本事件，不会死循环
  e.preventDefault();
  requestQuit();
});

// ================= T00840：关闭前检测运行中任务并友好确认 =================
// 点击关闭按钮/关闭主窗口时不直接退出，先汇总「正在运行」的任务（AI 控制台手动分析 +
// 后台队列 + 渲染进程内存流），有任务则弹确认框：取消保留运行、强制关闭先清理再退出。
let closeApproved = false; // 已获准本次关闭（无任务，或用户已选强制关闭）→ 放行真正关闭
let closing = false; // 防 close 事件在 async 确认期间重入

/** 在渲染进程执行一段 JS 并把其 Promise 结果取回主进程；窗口不可用/执行失败返回 undefined */
function runInRenderer(expr) {
  if (!mainWin || mainWin.isDestroyed()) return Promise.resolve(undefined);
  return mainWin.webContents.executeJavaScript(expr).catch(() => undefined);
}

/** 让渲染进程汇总当前运行中任务名称（内存流 + 后端运行态） */
function queryRunningTasks() {
  return runInRenderer('window.__mtaskRunningSnapshot ? window.__mtaskRunningSnapshot() : []')
    .then((r) => (Array.isArray(r) ? r : []));
}

/** 强制关闭前交由渲染进程调用后端清理运行态（删 busy / 复位在途队列），尽力即可 */
function cleanupRunningTasks() {
  return runInRenderer('typeof window.__mtaskCleanupRunning === "function" ? window.__mtaskCleanupRunning() : undefined');
}

async function handleCloseRequest(win) {
  if (closing) return;
  closing = true;
  try {
    const tasks = await queryRunningTasks();
    // 无运行任务：直接放行关闭（走正常退出通道）
    if (!tasks.length) { closeApproved = true; win.close(); return; }

    // 有运行任务：列出名称，提供「取消关闭」/「强制关闭」两选项
    const list = tasks.length > 6
      ? tasks.slice(0, 6).map((t) => `· ${t.name}`).join('\n') + `\n…等 ${tasks.length} 个`
      : tasks.map((t) => `· ${t.name}`).join('\n');
    const choice = await dialog.showMessageBox(win, {
      type: 'warning',
      title: '确认关闭',
      message: `检测到有 ${tasks.length} 个任务正在运行`,
      detail: `关闭可能导致这些任务中断：\n${list}\n\n是否仍要关闭应用？`,
      buttons: ['取消关闭', '强制关闭'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (choice.response === 1) {
      // 强制关闭：先清理遗留 busy/在途记录，避免下次启动看到永远挂起的任务，再放行退出
      await cleanupRunningTasks();
      closeApproved = true;
      win.close();
    }
    // 选「取消关闭」：什么都不做，窗口保持开启
  } finally {
    closing = false;
  }
}

/** 主窗口关闭拦截：不直接关，先查运行任务；无任务或已确认则放行由正常退出通道收尾 */
function setupCloseGuard(win) {
  win.on('close', (e) => {
    // 已获准本次关闭，或在退出流程中（before-quit 已接管），不再拦截
    if (closeApproved || quitting) return;
    e.preventDefault();
    void handleCloseRequest(win);
  });
}

/**
 * 关键接入点：注册 api:// 自定义协议，由主进程代理转发到本地 HTTP 服务。
 * 前端在 Electron 壳内以 api:// 前缀发起请求（见 web/src/api/client.ts），
 * 桌面壳内零网关问题联通后端；浏览器访问时仍用同源相对路径 /api。
 * （旧方案的 webRequest.onBeforeRequest redirectURL 对 fetch 无效，已废弃）
 */
protocol.registerSchemesAsPrivileged([
  { scheme: 'api', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  // app:// 用于加载打包前端：规避 file:// 在带空格安装路径（如 Program Files）下 loadFile ERR_FAILED 的白屏
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

function setupApiProxy() {
  protocol.handle('api', (request) => {
    // 跨源 fetch 携带自定义头（如 X-Access-Token）时 Chromium 会先发 OPTIONS 预检。
    // 本机协议仅桌面壳内可用，直接返回允许头即可，无需转发到后端。
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Access-Token',
        },
      });
    }
    const u = new URL(request.url);
    const target = `http://${SERVER_HOST}:${SERVER_PORT}/api${u.pathname}${u.search}`;
    // 带 body 时 Node fetch 必须显式声明 duplex，否则 POST/PATCH 会抛 "duplex option is required"
    const hasBody = !['GET', 'HEAD'].includes(request.method);
    return fetch(target, {
      method: request.method,
      headers: request.headers,
      body: hasBody ? request.body : undefined,
      duplex: hasBody ? 'half' : undefined,
    })
      .then((res) => {
        // 允许渲染进程以 fetch 跨源读取图片等二进制（复制到剪贴板需取 blob）；
        // 该协议仅在本机桌面壳内可用，开放 * 不构成外部攻击面
        const headers = new Headers(res.headers);
        headers.set('Access-Control-Allow-Origin', '*');
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
      })
      // T02282：失败体必须回 JSON。前端 client.ts 的 request() 以 `res.json().catch(() => ({}))` 取错误，
      // text/plain 时 body.error 为空 → 页面只剩「HTTP 502」，断连具体原因（fetch failed/ECONNREFUSED）丢失。
      // CORS 头与成功分支对齐，否则渲染进程跨源读不到这条 502。
      .catch((err) => new Response(JSON.stringify({ error: `api proxy error: ${err.message}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }));
  });
}

/** 本地静态资源 MIME（覆盖 web/dist 产物会用到的类型） */
const WEB_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** 用 app:// 协议服务打包前端资源。
 *  原因：loadFile 在安装到含空格的路径（如 F:\Program Files\...）时，以 file://
 *  加载 index.html 会抛 ERR_FAILED 导致白屏；改用 app:// 协议从磁盘读取即可规避，
 *  无需放开 webSecurity。同时校验路径禁止 ../ 越权读取打包目录之外的文件。 */
/**
 * T01057-FR1.1：任务完成系统通知——主进程 30s 轮询 /api/notify/pending（ai_state=unread/failed），
 * 与上次快照 diff 后对「新完成/新失败/状态变化」发 OS 通知；点击通知聚焦窗口并通知渲染端定位任务。
 * 主进程常驻（不依赖前端页面），最小化/切页时通知依然可达。
 */
const notifyPrefsFile = () => path.join(app.getPath('userData'), 'notify-prefs.json');
let notifyEnabled = true; // 默认开启；持久化在 userData/notify-prefs.json
try {
  const pf = notifyPrefsFile();
  if (fs.existsSync(pf)) notifyEnabled = JSON.parse(fs.readFileSync(pf, 'utf8')).enabled !== false;
} catch { /* 忽略：默认开启 */ }
const notifySeen = new Map(); // task_no → ai_state 快照
let notifyPrimed = false; // 首轮只建快照不通知（避免升级启动后轰炸存量未读）
let notifyTimer = null;

/** 读取 server 端访问令牌（tunnel-config.json 的 accessToken；未启用隧道时为空=接口不鉴权） */
function readServerAccessToken() {
  try {
    const dir = dataDir() ?? path.join(__dirname, '..', 'server', 'data');
    const cfgPath = path.join(dir, 'tunnel', 'tunnel-config.json');
    if (!fs.existsSync(cfgPath)) return '';
    return String(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).accessToken ?? '');
  } catch { return ''; }
}

function showTaskNotification(item) {
  const win = mainWin && !mainWin.isDestroyed() ? mainWin : null;
  const n = new Notification({
    title: item.ai_state === 'failed' ? `任务处理失败：${item.task_no}` : `任务处理完成：${item.task_no}`,
    body: `${item.title}（${item.project_name}）— 点击查看详情`,
    silent: false,
  });
  n.on('click', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      win.webContents.send('notify:navigate', item.task_no);
    }
  });
  n.show();
}

async function pollNotifyPending() {
  if (!notifyEnabled || !serverProc) return;
  try {
    const token = readServerAccessToken();
    const req = http.get({
      host: SERVER_HOST, port: SERVER_PORT, path: '/api/notify/pending', timeout: 5000,
      headers: token ? { 'X-Access-Token': token } : {},
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const items = JSON.parse(buf) || [];
          if (notifyPrimed) {
            for (const it of items) {
              const prev = notifySeen.get(it.task_no);
              if (prev !== it.ai_state) showTaskNotification(it);
            }
          } else {
            // 首轮：仅建立基线，不轰炸存量未读
            notifyPrimed = true;
          }
          notifySeen.clear();
          for (const it of items) notifySeen.set(it.task_no, it.ai_state);
        } catch { /* 坏 JSON 忽略本轮 */ }
      });
    });
    req.on('error', () => { /* 服务未就绪/网络异常：忽略本轮 */ });
    req.on('timeout', () => { req.destroy(); });
  } catch { /* 忽略本轮 */ }
}

function startNotifyPolling() {
  if (notifyTimer) return;
  notifyTimer = setInterval(pollNotifyPending, 30000);
  setTimeout(pollNotifyPending, 8000); // 启动后 8s 先对一次基线
}

ipcMain.handle('notify:get-enabled', () => notifyEnabled);
ipcMain.handle('notify:set-enabled', (_evt, enabled) => {
  notifyEnabled = enabled !== false;
  try { fs.writeFileSync(notifyPrefsFile(), JSON.stringify({ enabled: notifyEnabled })); } catch { /* 持久化失败不阻断 */ }
  if (notifyEnabled) {
    setTimeout(pollNotifyPending, 500);
  } else {
    notifySeen.clear();
    notifyPrimed = false; // 重新开启后先重建基线，避免通知积压
  }
  return notifyEnabled;
});

/**
 * T00771 修复：系统「选择文件夹」对话框。
 * 原先前端只能用 <input type="file">，Windows 下弹出的是文件选择框（只能选文件，选不了文件夹），
 * 工作空间绑定因此走不通。这里经 IPC 调主进程 dialog.showOpenDialog({openDirectory})，
 * 返回所选目录绝对路径（取消返回 null）；渲染进程经 preload 的 contextBridge 调用。
 */
ipcMain.handle('dialog:open-directory', async () => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWin;
  const r = await dialog.showOpenDialog(win, {
    title: '选择工作空间目录',
    properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
  });
  if (r.canceled || !r.filePaths?.length) return null;
  return r.filePaths[0];
});

// ---------- T00878：一键下载并静默安装更新包 ----------

/** T02071：等安装器退出码的上限；超时不判失败（可能正弹授权确认），留待下次启动对账 */
const INSTALL_WAIT_MS = 60_000;

/** 从下载 URL 提取文件名（末尾路径段，去掉查询串）；取不到则回退默认名 */
function downloadFilename(url) {
  try {
    const seg = new URL(url).pathname.split('/').findLast(Boolean);
    if (seg) return seg;
  } catch { /* 非法 URL，走回退 */ }
  return `mtask-update-${Date.now()}.exe`;
}

function fileSizeOf(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function sendUpdateProgress(payload) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('update:progress', payload);
}

/** 进行中的下载句柄（T02071 缺口 1）：update:cancel 需要拿到 request/响应流才能中途终止 */
let activeDownload = null;

/**
 * 更新下载续传：可续传的瞬时网络错误——这类失败**保留 .part** 并带 Range 自动重试。
 * 原实现把所有错误一视同仁地走 abort（删半成品），与界面「重试时断点续传」的承诺正好相反：
 * 长连接被中间设备 RST（ECONNRESET）在大安装包上属常态，用户每点一次重试都得从 0 重下 100+MB。
 * 只有「服务端明确异常」「拼包不符」「写盘失败」才该删半成品——那类失败继续重试也拼不出正确包。
 */
const NET_RETRY_MAX = 4;
const NET_RETRY_DELAY_MS = [1_000, 2_000, 4_000, 8_000];
const TRANSIENT_NET_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED',
  'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ERR_STREAM_PREMATURE_CLOSE',
]);

function isTransientNetError(e) {
  if (!e) return false;
  if (TRANSIENT_NET_CODES.has(e.code)) return true;
  // 流层中断不带 code（'aborted'、socket hang up），按文案兜住
  return /socket hang up|aborted|connection reset|连接超时/i.test(String(e.message ?? ''));
}

/** 原生网络错误 → 用户可读中文：裸 `read ECONNRESET` 对用户没有任何行动指引 */
function netErrorText(e) {
  const code = e?.code ?? '';
  if (code === 'ECONNRESET') return '网络连接被中断（ECONNRESET）';
  if (code === 'ETIMEDOUT' || /连接超时/.test(String(e?.message ?? ''))) return '网络连接超时';
  if (code === 'EAI_AGAIN') return '域名解析暂时失败（EAI_AGAIN）';
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return '网络不可达';
  if (code === 'EPIPE' || code === 'ECONNABORTED') return '网络连接被中断';
  return e instanceof Error ? e.message : String(e ?? '下载失败');
}

/** 续传请求头：本地已有 .part 时带 Range，由服务端决定是否按段响应 */
function downloadHeaders(partBytes) {
  const headers = { 'User-Agent': 'MTask-Updater' };
  if (partBytes > 0) headers.Range = `bytes=${partBytes}-`;
  return headers;
}

// 流式写入下载响应：写完落盘改名，进度经 webContents 推送
// 失败清理半成品；「用户取消」不清理——.part 就是断点续传的本体（T02071）
// T02644：能落盘的响应体只有两种——200 全量、206 且 Content-Range 起点 == 本地 .part 字节数。
// 其余分段响应（起点错位、无 .part 却按段应答）就地写会拼出「体积看着像整包」的坏安装包，
// 必须丢弃本条响应、改为不带 Range 重取一次（单次标志防循环），仍不行即判失败。
function pump(r, ctx, attempt) {
  const plan = resumePlan({ partBytes: ctx.partBytes, statusCode: r.statusCode, headers: r.headers });
  if (r.statusCode === 206 && !plan.append) {
    if (!ctx.retriedWithoutRange && ctx.restartWithoutRange) {
      attempt.discarded = true;
      try { r.destroy(); } catch { /* 忽略 */ }
      ctx.restartWithoutRange();
      return;
    }
    ctx.abort(new Error('下载失败：服务端按段应答且起点与本地文件不符，无法拼包'));
    return;
  }
  if (!plan.append && ctx.partBytes > 0) {
    // 服务端未按 Range 响应（200 全量）：半截文件不能再拼，从 0 重下
    try { fs.rmSync(ctx.tmpPath, { force: true }); } catch { /* 忽略 */ }
    ctx.partBytes = 0;
  }
  const total = plan.totalBytes || Number(r.headers['content-length'] || 0);
  let received = ctx.partBytes;
  ctx.received = received;
  ctx.total = total;
  const out = fs.createWriteStream(ctx.tmpPath, { flags: plan.append ? 'a' : 'w' });
  ctx.out = out;
  r.on('data', (chunk) => {
    received += chunk.length;
    ctx.received = received;
    out.write(chunk);
    // T02976：改为按时间节流（≥200ms）而非按字节步进——1MB 步进在慢网下数秒才推一次，
    // 满足不了「进度延迟不超过 1 秒」；200ms 既够实时又不会把 IPC 打爆。
    const now = Date.now();
    if (now - ctx.lastProgressAt >= 200) {
      ctx.lastProgressAt = now;
      sendUpdateProgress({ status: 'downloading', received, total, resumedFrom: plan.append ? ctx.partBytes : 0, origin: ctx.origin });
    }
  });
  r.on('end', () => {
    out.end(() => {
      // T02644 体积兜底：实收字节与落盘字节都必须等于服务端声明的总量，差一个字节也不改名——
      // 半截包一旦被当成 downloaded 交给「安装」，后果比下载失败严重
      const written = fileSizeOf(ctx.tmpPath);
      if (total > 0 && (received !== total || written !== total)) {
        ctx.abort(new Error(`下载不完整：已落盘 ${written} 字节，应为 ${total} 字节`));
        return;
      }
      try { fs.renameSync(ctx.tmpPath, ctx.filePath); } catch (e) {
        ctx.abort(new Error(`写入安装包失败：${e.message}`));
        return;
      }
      sendUpdateProgress({ status: 'downloaded', received, total, filePath: ctx.filePath, origin: ctx.origin });
      ctx.finish({ status: 'downloaded', filePath: ctx.filePath, resumedFrom: plan.append ? ctx.partBytes : 0, totalBytes: total });
    });
  });
  r.on('error', (e) => { if (!attempt.discarded) { ctx.softFail(e); } });
  r.on('aborted', () => {
    // 响应流被对端掐断：Node 只发 'aborted' 不带 code，补一个 ECONNRESET 供重试判定
    if (!attempt.discarded) ctx.softFail(Object.assign(new Error('下载连接中断'), { code: 'ECONNRESET' }));
  });
  // 写盘错误（磁盘满/权限）不是网络问题：softFail 会判非瞬时并走 abort 删除半成品
  out.on('error', (e) => { if (!attempt.discarded) { ctx.softFail(e); } });
}

// 应用内下载更新安装包到系统下载目录（T02071：支持中途取消 + 取消后继续＝Range 断点续传）
// T02740：函数体抽出为 downloadUpdatePackage，IPC（设置页）与「在线更新」菜单（主进程自驱）共用同一条下载通道
// T02976：origin 区分两条入口——菜单自驱的下载要在全局进度条上提示（设置页自己有卡片内进度，不重复显示）。
async function downloadUpdatePackage(url, origin = 'settings') {
  if (typeof url !== 'string' || !url) throw new Error('下载地址无效');
  if (activeDownload) throw new Error('已有下载进行中，请先取消或等待完成');
  const filePath = path.join(app.getPath('downloads'), downloadFilename(url));
  // 流式下载到临时文件，写完再改名，避免下载中断残留半截"安装包"被误执行
  const tmpPath = filePath + '.part';
  const ctx = {
    filePath, tmpPath, partBytes: fileSizeOf(tmpPath), origin, lastProgressAt: 0,
    // T02976 补：把最新进度挂在 ctx 上，settings 页重新挂载时靠 update:active 恢复现场
    received: 0, total: 0,
    cancelled: false, done: false, req: null, res: null, out: null, resolve: null, reject: null,
    retriedWithoutRange: false, restartWithoutRange: null,
    // 更新下载续传：瞬时网络失败的续传重试计数与退避定时器（收口时必须清掉，否则已结束后还会再起请求）
    netRetries: 0, retryTimer: null, retryScheduled: false, softFail: null,
    // 正常完成/取消收口：保留 .part，只销毁流
    finish: (value) => {
      if (ctx.done) { return; }
      ctx.done = true;
      if (ctx.retryTimer) { clearTimeout(ctx.retryTimer); ctx.retryTimer = null; }
      try { ctx.res?.destroy(); } catch { /* 忽略 */ }
      try { ctx.out?.destroy(); } catch { /* 忽略 */ }
      try { ctx.req?.destroy(); } catch { /* 忽略 */ }
      if (activeDownload === ctx) activeDownload = null;
      ctx.resolve?.(value);
    },
    // 真实失败收口：默认删半成品，避免下次误判断已下载完（原行为）
    // 更新下载续传：keepPartial=true 时保留 .part——网络类失败是「同一份包的续传起点」，删了就兑现不了续传承诺
    abort: (err, keepPartial = false) => {
      if (ctx.done) { return; }
      ctx.done = true;
      if (ctx.retryTimer) { clearTimeout(ctx.retryTimer); ctx.retryTimer = null; }
      try { ctx.out?.destroy(); } catch { /* 忽略 */ }
      try { ctx.req?.destroy(); } catch { /* 忽略 */ }
      if (!ctx.cancelled && !keepPartial) { try { fs.rmSync(tmpPath, { force: true }); } catch { /* 忽略 */ } }
      if (activeDownload === ctx) activeDownload = null;
      ctx.reject?.(err);
    },
  };
  return await new Promise((resolve, reject) => {
    ctx.resolve = resolve;
    ctx.reject = reject;
    activeDownload = ctx;
    const open = (target, withRange = true) => {
      // 本轮响应是否被主动弃用（T02644 起点错位重取）：弃用后旧请求的 error/aborted 不算下载失败
      const attempt = { discarded: false };
      const req = https.get(target, { headers: downloadHeaders(withRange ? ctx.partBytes : 0) }, (res) => {
        if (attempt.discarded) { res.resume(); return; }
        ctx.res = res;
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // 跟随 302/303（GitHub Release asset 通常重定向到云端存储）；重定向后仍带 Range
          res.resume();
          open(new URL(res.headers.location, target).href, withRange);
          return;
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          ctx.abort(new Error(`下载失败：HTTP ${res.statusCode}`));
          return;
        }
        pump(res, ctx, attempt);
      });
      ctx.req = req;
      // 更新下载续传：https.get 没有默认超时——连接假死（NAT 表项被清、中间设备丢包）时会一直挂着，
      // 用户既看不到进度也不会收到失败提示。socket 空闲 60s 即按超时处理，交给续传重试；
      // 有数据流动时 socket 不空闲，因此不会误伤慢速大包。
      req.setTimeout(60_000, () => {
        req.destroy(Object.assign(new Error('连接超时'), { code: 'ETIMEDOUT' }));
      });
      req.on('error', (e) => {
        if (attempt.discarded) return;
        if (ctx.cancelled) {
          ctx.finish({ status: 'cancelled', partialBytes: fileSizeOf(tmpPath), partPath: tmpPath, filePath });
          return;
        }
        ctx.softFail(e);
      });
    };
    // T02644：分段响应对不上本地文件时，丢掉这条响应改发一次「不带 Range」的全量请求（单次，靠
    // ctx.retriedWithoutRange 防循环）；本地半截 .part 由全量轮以 flag 'w' 覆盖，不需要先删。
    ctx.restartWithoutRange = () => {
      ctx.retriedWithoutRange = true;
      ctx.partBytes = 0;
      open(url, false);
    };
    // 更新下载续传：瞬时网络失败 → 保留 .part，带 Range 自动续传重试（退避 1/2/4/8s）。
    // 重试起点一律取磁盘实际字节数：写流 destroy 会丢未落盘缓冲，用内存 received 算 Range 会错位。
    // retryScheduled 防重入——req/res 的 error 与 aborted 可能在同一轮里连触发多次，重复计数会提前耗尽次数。
    ctx.softFail = (err) => {
      if (ctx.done || ctx.retryScheduled) return;
      if (!isTransientNetError(err) || ctx.netRetries >= NET_RETRY_MAX) {
        const label = netErrorText(err);
        ctx.abort(
          new Error(ctx.netRetries > 0 ? `${label}（已自动续传重试 ${ctx.netRetries} 次仍未恢复）` : label),
          // 网络类失败保留半截包，兑现「重试时断点续传」；非网络错误（4xx/拼包不符/写盘失败）仍清掉
          isTransientNetError(err),
        );
        return;
      }
      ctx.retryScheduled = true;
      ctx.netRetries += 1;
      // 此处只用于提示显示：destroy 写流会丢未落盘缓冲，此刻读到的字节数可能偏大，
      // 真正的 Range 起点在退避结束、写流确定关闭后再以磁盘为准重算（见下方定时器）
      ctx.partBytes = fileSizeOf(tmpPath);
      try { ctx.out?.destroy(); } catch { /* 忽略 */ }
      try { ctx.res?.destroy(); } catch { /* 忽略 */ }
      try { ctx.req?.destroy(); } catch { /* 忽略 */ }
      ctx.out = null;
      ctx.res = null;
      ctx.req = null;
      const delay = NET_RETRY_DELAY_MS[Math.min(ctx.netRetries - 1, NET_RETRY_DELAY_MS.length - 1)];
      sendUpdateProgress({
        status: 'retrying', received: ctx.partBytes, total: ctx.total || 0, origin: ctx.origin,
        message: `${netErrorText(err)}，正在自动续传重试（${ctx.netRetries}/${NET_RETRY_MAX}）`,
      });
      ctx.retryTimer = setTimeout(() => {
        ctx.retryTimer = null;
        ctx.retryScheduled = false;
        if (ctx.done) return;
        // 退避期已过、写流已关闭：这时的磁盘字节数才是可信的续传起点，
        // 起点与文件不符会被服务端按 206 拒拼（T02644 的守护）而白跑一轮
        ctx.partBytes = fileSizeOf(tmpPath);
        open(url);
      }, delay);
    };
    open(url);
    if (ctx.partBytes > 0) sendUpdateProgress({ status: 'resuming', received: ctx.partBytes, total: 0, origin });
  });
}
ipcMain.handle('update:download', (_evt, url) => downloadUpdatePackage(url));

// T02071 缺口 1：下载中途取消——终止连接但保留 .part，界面据此提供「继续下载」
ipcMain.handle('update:cancel', async () => {
  const ctx = activeDownload;
  if (!ctx) return { status: 'idle' };
  ctx.cancelled = true;
  const partialBytes = fileSizeOf(ctx.tmpPath);
  sendUpdateProgress({ status: 'cancelled', received: partialBytes, total: 0, origin: ctx.origin });
  ctx.finish({ status: 'cancelled', partialBytes, partPath: ctx.tmpPath, filePath: ctx.filePath });
  return { status: 'cancelled', partialBytes };
});

// T02976 补：设置页切走再回来（或菜单发起下载时）用它恢复「正在下载」现场。
// 没有这条查询，用户只能看到「已有下载进行中」的报错，既看不到进度也没有取消入口。
ipcMain.handle('update:active', () => {
  const ctx = activeDownload;
  if (!ctx) return { active: false };
  return { active: true, received: ctx.received || 0, total: ctx.total || 0, origin: ctx.origin };
});

// T02976：菜单通道下载失败/中断后，全局进度条上的「重试」重走整条在线更新流程
// （检查 → 确认 → 下载），与菜单入口共用 onlineUpdateBusy 重入闸，连点不会起两条流程。
ipcMain.handle('update:retry', () => runOnlineUpdateFlow());

// T02071 启动对账：上次静默安装被安装器接管退出时收不到退出码，靠「当前版本是否已达目标版本」回执
let pendingUpdateResult = null;

function reconcilePendingUpdateOnLaunch() {
  const userData = app.getPath('userData');
  const marker = readPending(userData);
  if (!marker) return;
  const outcome = reconcilePending(marker, app.getVersion());
  clearPending(userData);
  pendingUpdateResult = outcome;
  // 失败当场弹一次系统通知（用户当时可能不在设置页），成功不打扰、仅在设置页静默回执
  if (outcome.status === 'failed' && Notification.isSupported()) {
    const n = new Notification({ title: 'MTask 更新未生效', body: outcome.reason });
    n.on('click', () => { if (mainWin && !mainWin.isDestroyed()) mainWin.show(); });
    n.show();
  }
}

// 静默安装已下载的安装包：等退出码给出回执（缺口 2），失败保持应用存活供重试，成功才退出
// T02740：同下载——抽出 installUpdatePackage 供 IPC 与菜单两路共用
async function installUpdatePackage(filePath, targetVersion) {
  if (typeof filePath !== 'string' || !filePath || !fs.existsSync(filePath)) throw new Error('安装包不存在，或已失效');
  const target = typeof targetVersion === 'string' ? targetVersion : '';
  // 先落「待回执」标记再拉起安装器——安装器会 taskkill 本应用，那时我们已无法自己写回执
  writePending(app.getPath('userData'), {
    filePath, targetVersion: target, currentVersion: app.getVersion(), startedAt: new Date().toISOString(),
  });
  return await new Promise((resolve) => {
    let settled = false;
    const settle = (value, { keepMarker = false } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!keepMarker) clearPending(app.getPath('userData'));
      resolve(value);
    };
    let child;
    try {
      // /S=静默安装；--force-run（T03298）= 装完由安装器拉起新版本：辅助安装器在静默模式下没有
      // 「运行完成后启动」这一步，只有带该开关才 doStartApp，不带就是「装完了也没人开新版本」。
      // detached:true（T03298 关键）：安装器是本应用用 node 的 child_process.spawn 拉起来的，
      // 会被放进本进程的 Job 里；本应用被安装器自己的 taskkill 打死时，Job 连带把安装器一起带走
      // ——实测矩阵：同 job 时「/T」和「不带 /T」两种杀法安装器都死，只有 detached 起来且不再用
      // /T 才活得下来。detached 只影响进程组/归属，不 unref 就照常收退出码（实测 code=7 能收到），
      // 所以 T02071 的「等退出码给回执」这条链不受影响。
      child = spawn(filePath, ['/S', '--force-run'], { detached: true, stdio: 'ignore' });
    } catch (e) {
      settle({ ok: false, status: 'failed', message: `启动安装程序失败：${e instanceof Error ? e.message : String(e)}`, filePath, targetVersion: target });
      return;
    }
    const timer = setTimeout(() => {
      // 等待超时不判失败（安装器可能在等授权确认）：标记保留，下次启动由对账收敛出真实结果
      const o = installOutcome({ timedOut: true });
      settle({ ok: false, status: 'pending', message: o.message, filePath, targetVersion: target }, { keepMarker: true });
    }, INSTALL_WAIT_MS);
    child.on('error', (e) => {
      settle({ ok: false, status: 'failed', message: `安装进程异常：${e instanceof Error ? e.message : String(e)}`, filePath, targetVersion: target });
    });
    child.on('exit', (code) => {
      const o = installOutcome({ code, timedOut: false });
      if (o.status === 'installed') {
        // 标记保留（T03298）：辅助安装器在静默按机器升级时只是「UAC 提权交接」，外层进程交接完
        // 就 Quit(0)，这个 0 并不证明文件真被替换了。留在下次启动由对账按真实版本给结论——
        // 装成功则静默清掉，没成功（授权被拒等）当场弹「更新未生效」。
        settle({ ok: true, status: 'installed', message: o.message }, { keepMarker: true });
        // 给渲染进程留出闪现提示的时间，随即退出本应用让新版本接管
        setTimeout(() => app.quit(), 800);
        return;
      }
      settle({ ok: false, status: 'failed', message: o.message, code, filePath, targetVersion: target });
    });
  });
}
ipcMain.handle('update:install', (_evt, filePath, targetVersion) => installUpdatePackage(filePath, targetVersion));

// 渲染进程取回上一次安装的回执（installed / failed），一次消费即清
ipcMain.handle('update:pending-result', async () => {
  const r = pendingUpdateResult;
  pendingUpdateResult = null;
  return r;
});

// ---------- 在线更新（内置地址兜底 + 手动地址覆盖，T02740/T02977） ----------

const UPDATE_API_TIMEOUT_MS = 15_000;
/** 菜单通道重入闸：下载/安装各自有独立 ctx，连点弹多层对话框会串台，一次只跑一条流程 */
let onlineUpdateBusy = false;

/** 调本地后端 /api/*（带隧道令牌）。菜单通道不再直连 GitHub：
 *  地址解析（手动覆盖/内置兜底）、Token 与 5 分钟缓存统一由 server UpdateService 负责，
 *  与设置页「检查更新」得到同一份结果。非 2xx 时把响应体里的 source/repo 挂到异常上。 */
function serverApi(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const token = readServerAccessToken();
    const req = http.request({
      host: SERVER_HOST,
      port: SERVER_PORT,
      path: `/api${apiPath}`,
      method,
      timeout: UPDATE_API_TIMEOUT_MS,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(token ? { 'X-Access-Token': token } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 非 JSON 走状态码分支 */ }
        if (res.statusCode >= 200 && res.statusCode < 300) { resolve(data ?? {}); return; }
        const err = new Error(data?.error || `本地更新服务返回异常状态 ${res.statusCode}`);
        if (data && typeof data === 'object') { err.source = data.source; err.repo = data.repo; }
        reject(err);
      });
    });
    req.on('error', (e) => reject(new Error(`无法连接本地更新服务：${e instanceof Error ? e.message : String(e)}`)));
    req.on('timeout', () => { req.destroy(new Error('本地更新服务响应超时')); });
    if (payload) req.write(payload);
    req.end();
  });
}

/** 检查更新：后端口径＝手动地址合法则覆盖内置地址，留空/非法回退内置地址。 */
async function checkOnlineUpdate() {
  const info = await serverApi('POST', '/update/check', { force: false });
  return {
    version: info.latestVersion,
    currentVersion: info.currentVersion,
    hasUpdate: Boolean(info.hasUpdate),
    releaseName: info.releaseName ?? '',
    publishedAt: info.publishedAt ?? '',
    downloadUrl: info.downloadUrl ?? '',
    repo: info.repo ?? '',
    source: info.source === 'manual' ? 'manual' : 'builtin',
  };
}

/** 「下载来源」对话框文案：内置地址兜底，手动地址覆盖 */
function updateSourceText(info) {
  const label = info.source === 'manual' ? '手动配置地址' : '内置地址';
  return info.repo ? `${label} ${info.repo}` : label;
}

function ownerWin() {
  return mainWin && !mainWin.isDestroyed() ? mainWin : undefined;
}

/** 在线更新完整链路：检查 →（有新版本）确认下载 → 主通道下载 → 确认安装 → 静默安装。
 *  auto=true 为开机自动检测：无新版本/检查失败一律静默，只有真的新版本才弹框——自动检测不打扰。
 *  失败提示全部走 dialog（Electron 无 window.prompt/confirm，原生弹框是唯一可靠通道）。 */
async function runOnlineUpdateFlow({ auto = false } = {}) {
  if (onlineUpdateBusy) return;
  onlineUpdateBusy = true;
  try {
    let info;
    try {
      info = await checkOnlineUpdate();
    } catch (e) {
      if (!auto) {
        const message = e instanceof Error ? e.message : String(e);
        const src = e?.source === 'manual' ? `手动配置地址${e.repo ? ` ${e.repo}` : ''}` : e?.repo ? `内置地址 ${e.repo}` : '';
        const hint = e?.source === 'manual'
          ? '可在「设置 → 版本更新」修正手动仓库地址，或清空后回退内置地址'
          : '可在「设置 → 版本更新」填写手动仓库地址覆盖内置地址';
        await dialog.showMessageBox(ownerWin(), {
          type: 'error',
          title: '检查更新失败',
          message,
          detail: `${src ? `下载来源：${src}\n` : ''}${hint}`,
          buttons: ['知道了'],
        });
      }
      return;
    }
    if (!info.hasUpdate) {
      if (!auto) {
        await dialog.showMessageBox(ownerWin(), { type: 'info', title: '检查更新', message: `当前已是最新版本 v${info.currentVersion}`, buttons: ['好的'] });
      }
      return;
    }
    const want = await dialog.showMessageBox(ownerWin(), {
      type: 'info',
      title: '发现新版本',
      message: `发现新版本 v${info.version}（当前 v${info.currentVersion}）`,
      detail: `${info.releaseName ? `Release：${info.releaseName}\n` : ''}${info.publishedAt ? `发布时间：${info.publishedAt.slice(0, 10)}\n` : ''}下载来源：${updateSourceText(info)}`,
      buttons: ['立即下载', '稍后再说'],
      defaultId: 0,
      cancelId: 1,
    });
    if (want.response !== 0) return;
    let dl;
    try {
      // 与设置页同一条下载通道：进度照常推 update:progress，Range 续传/取消语义一致
      // T02976：带 origin='menu'，渲染进程据此在主界面显示全局进度条（菜单通道没有自己的进度卡片）
      dl = await downloadUpdatePackage(info.downloadUrl, 'menu');
      // 用户可能在全局进度条上点了「取消」：下载会以 cancelled 正常收口（不抛错），
      // 这里必须静默返回——否则会继续往下弹「下载完成」并拿 undefined 当安装包去安装。
      if (dl.status === 'cancelled') return;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // 失败也必须推一条：否则全局进度条会停在最后一个百分比上，看起来像卡死
      sendUpdateProgress({ status: 'failed', received: 0, total: 0, origin: 'menu', message });
      await dialog.showMessageBox(ownerWin(), {
        type: 'error',
        title: '下载失败',
        message: `更新包下载失败：${message}`,
        detail: '网络类失败已自动续传重试；仍失败时可稍后通过「帮助 → 检查在线更新」重试——已下载的半截包会保留，下次从断点继续，不必重下整包',
        buttons: ['知道了'],
      });
      return;
    }
    const wantInstall = await dialog.showMessageBox(ownerWin(), {
      type: 'info',
      title: '下载完成',
      message: `v${info.version} 安装包已就绪`,
      detail: `${dl.filePath}\n安装将执行静默安装器；安装器会先结束本应用，按机器安装（如 Program Files）时 Windows 会弹一次授权确认，装完自动以新版本启动。`,
      buttons: ['立即安装', '稍后安装'],
      defaultId: 0,
      cancelId: 1,
    });
    if (wantInstall.response !== 0) {
      await dialog.showMessageBox(ownerWin(), { type: 'info', title: '稍后安装', message: '安装包已存放在系统下载目录，随时双击安装，或稍后经本菜单再次走在线更新', buttons: ['好的'] });
      return;
    }
    const res = await installUpdatePackage(dl.filePath, info.version);
    if (res.status === 'installed') return; // 成功即退出应用，无需弹框
    if (res.status === 'pending') {
      await dialog.showMessageBox(ownerWin(), { type: 'warning', title: '安装结果待对账', message: res.message, detail: '下次启动将自动对账给出结果（失败会弹系统通知）', buttons: ['知道了'] });
      return;
    }
    await dialog.showMessageBox(ownerWin(), { type: 'error', title: '安装失败', message: res.message, detail: '应用保持存活，可稍后通过「帮助 → 检查在线更新」重试', buttons: ['知道了'] });
  } finally {
    onlineUpdateBusy = false;
  }
}

/** 应用菜单：显式构建（Electron 默认菜单不含更新入口，一旦 setApplicationMenu 即整体接管）。
 *  标准 role 子菜单保留默认能力（关闭/编辑/视图含刷新与 DevTools/窗口），再补「帮助 → 检查在线更新」。 */
function setupAppMenu() {
  const template = [
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: '帮助',
      submenu: [
        { label: '检查在线更新', click: () => { runOnlineUpdateFlow().catch(() => { /* 提示已在链路内 dialog 给出，不向外抛裸异常 */ }); } },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function setupWebProtocol() {
  const root = path.resolve(__dirname, '..', 'web', 'dist');
  protocol.handle('app', (request) => {
    try {
      const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '') || 'index.html';
      const target = path.resolve(root, rel);
      if (target !== root && !target.startsWith(root + path.sep)) {
        return new Response('forbidden', { status: 403 });
      }
      const data = fs.readFileSync(target);
      const mime = WEB_MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
      return new Response(data, { status: 200, headers: { 'content-type': mime } });
    } catch (err) {
      return new Response(`app load error: ${err.message}`, { status: 404 });
    }
  });
}

// ---------- 启动窗与进度 ----------

/** 创建并显示启动窗，等待其加载完成后再更新进度，避免早期进度丢失。
 *  容错：splash.html 缺失（打包白名单遗漏等）时不阻塞启动——返回 null，主流程照常进行。 */
async function createSplash() {
  const win = new BrowserWindow({
    width: 360,
    height: 240,
    frame: false,
    resizable: false,
    show: false,
    backgroundColor: '#111827',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  try {
    await win.loadFile(path.join(__dirname, 'splash.html'));
  } catch (e) {
    // 启动窗仅是体验增强，加载失败不应阻断应用启动
    console.error('[mtask] splash 加载失败，跳过启动窗:', e.message);
    if (!win.isDestroyed()) win.destroy();
    return null;
  }
  win.show();
  return win;
}

/** 更新启动窗进度（0-100）与阶段文案；窗口未就绪/已关闭时安全忽略 */
function updateSplash(progress, status) {
  if (!splashWin || splashWin.isDestroyed()) return;
  splashWin.webContents
    .executeJavaScript(`window.__setProgress(${progress}, ${JSON.stringify(status)})`)
    .catch(() => { /* 竞态下忽略 */ });
}

/** 后端等待期内的“进行中”视觉推进：只填到阶段上限，避免虚假完成 */
function startTicker(to = 58) {
  let p = 18;
  ticker = setInterval(() => {
    if (p >= to) return;
    p = Math.min(p + (Math.random() * 3 + 1), to);
    updateSplash(p, '正在启动后端服务…');
  }, 220);
}
function stopTicker() {
  if (ticker) { clearInterval(ticker); ticker = null; }
}

// 打包态回退端口：首位默认/覆盖端口被占时依次尝试这些高位端口，保证不与外部/旧实例抢占。
const PACKED_FALLBACK_PORTS = [39882, 39883, 39884, 39885];

/** 终止并清空上一轮尝试残留的后端子进程，等其真正退出后再返回。
 *  kill 失败仅告警不阻断：多因进程恰好自行退出或句柄失效，已无进一步手段，
 *  留日志便于定位"端口仍被占用"一类残留问题。
 *  为什么要等退出而不是立刻放行：被杀的进程可能仍持有 SQLite 数据库文件句柄
 *  （WAL 的 -shm/-wal 也在被占用），旧句柄未释放就启动新后端，新进程打开同一
 *  数据库会抛 SQLITE_IOERR_TRUNCATE 崩溃，UI 表现即"后端未连接"。 */
function stopStaleServerProc() {
  if (!serverProc) return Promise.resolve();
  const proc = serverProc;
  serverProc = null;
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(force);
      clearTimeout(escalate);
      resolve();
    };
    // 3s 内未自然退出则升级强杀；兜底 6s 无论如何放行，避免卡死启动流程
    const escalate = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (err) {
        console.warn('[mtask] SIGKILL 强杀旧后端子进程失败:', err.message);
      }
    }, 3000);
    const force = setTimeout(finish, 6000);
    if (proc.exitCode !== null || proc.signalCode !== null) { finish(); return; }
    proc.once('exit', finish);
    try {
      proc.kill();
    } catch (err) {
      // 优雅终止失败（进程可能已退出）：记录原因后直接放行
      console.warn('[mtask] 终止旧后端子进程失败:', err.message);
      finish();
    }
  });
}

/** 在单个候选端口上尝试自起并验证后端；成功返回 true。
 *  端口被占时我们拉起的子进程会因 EADDRINUSE 立即退出，据此判定并换下一个端口。 */
async function tryStartOnPort(port) {
  SERVER_PORT = port;
  await stopStaleServerProc();
  startServer();
  let exited = false;
  serverProc.once('exit', () => { exited = true; });
  // 留一个短窗口让 EADDRINUSE 导致的退出显现，避免把“被占端口误判为自起成功”
  await new Promise((r) => setTimeout(r, 300));
  if (exited) { await stopStaleServerProc(); return false; } // 我们拉起的进程已退出 -> 端口被占
  try {
    await waitForServer(30);
    // 二次确认：探到健康的是“我们自起的进程”而非他人占用的端口，
    // 消除 300ms 窗口内子进程迟到退出造成的误判
    if (serverProc && serverProc.exitCode === null && !serverProc.killed) return true;
  } catch {
    // 该端口未探到健康服务——换下一个候选端口
  }
  // 本次端口未成功：清理仍存活的子进程，避免残留进程占用端口
  await stopStaleServerProc();
  return false;
}

/** 打包态后端启动：从候选端口逐个自起服务。
 *  端口若被其它程序/旧实例占用则换下一个，实现真正隔离——既不侵占他人端口，也不再隐式复用外部后端。 */
async function startPackedBackend() {
  const candidates = [...new Set([SERVER_PORT, ...PACKED_FALLBACK_PORTS])];
  for (const port of candidates) {
    if (await tryStartOnPort(port)) return true;
  }
  return false;
}

/** 打包态启动内嵌后端并推进启动窗进度 */
async function bootPackedBackend() {
  const ok = await startPackedBackend();
  stopTicker();
  updateSplash(ok ? 62 : 66, ok ? '后端服务就绪' : '后端启动失败');
  if (!ok) console.error('[mtask] 打包内嵌服务在各候选端口均启动失败');
}

/** 开发态启动 tsx 后端并推进启动窗进度 */
async function bootDevBackend() {
  startServer();
  try {
    await waitForServer();
    stopTicker();
    updateSplash(62, '后端服务就绪');
  } catch (e) {
    stopTicker();
    updateSplash(66, '后端启动失败');
    console.error('[mtask] 内嵌服务启动失败:', e.message);
  }
}

/** 推进真实后端启动进度：结果决定阶段落点 */
async function ensureBackend() {
  updateSplash(12, '检测后端服务');
  // 打包态禁止复用外部服务（其多为连接开发库的进程），总是自起内嵌服务以连正式库；
  // 开发态保留复用：启动服务.bat 先启动服务时可直接复用
  const reused = app.isPackaged ? false : await probeHealthOnce();
  if (reused) {
    updateSplash(55, '后端已就绪（复用服务）');
  } else {
    updateSplash(18, '启动后端服务');
    startTicker(58);
    if (app.isPackaged) {
      await bootPackedBackend();
    } else {
      await bootDevBackend();
    }
  }
  backendReady = true;
  maybeFinishSplash();
}

/** 后端与界面都就绪后：跳到 100%，短暂停留后关闭启动窗、显示主窗口 */
function maybeFinishSplash() {
  if (!backendReady || !uiReady) return;
  stopTicker();
  updateSplash(100, '就绪');
  setTimeout(() => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.show();
    if (splashWin && !splashWin.isDestroyed()) splashWin.close();
    splashWin = null;
  }, 400);
  // T01057-FR1.1：后端启动流程挂载后开启任务通知轮询（函数幂等；server 未就绪的轮次自动跳过）
  startNotifyPolling();
  // T02740：开机自动检测更新源版本（延迟 12s 让启动收尾先走完；auto 模式下无新版本/检查失败全静默）
  // T02977：检测地址＝手动覆盖地址（有效时）否则内置地址，与菜单入口同一份解析
  setTimeout(() => { runOnlineUpdateFlow({ auto: true }).catch(() => { /* 自动模式失败本就静默 */ }); }, 12_000);
}

// 主进程为 CommonJS 入口（electron/package.json 未启用 "type":"module"），顶层 await 语法非法；
// 改 ESM 需把全部 require 重写为 import 并调整打包入口，风险远大于收益，维持 promise 链是 CJS 主进程的标准写法
app.whenReady().then(async () => { // NOSONAR - S7785 顶层 await 在 CommonJS 中不可用，原因见上
  setupApiProxy();
  setupWebProtocol();
  // T02740：应用菜单带「帮助 → 检查在线更新」（T02977：内置地址兜底 + 手动地址覆盖）
  setupAppMenu();
  // T02071：先对账上一次静默安装的结果（安装器接管退出时我们没能自己写回执）
  reconcilePendingUpdateOnLaunch();

  splashWin = await createSplash();
  if (splashWin) {
    updateSplash(6, '正在启动…');
    // 兜底：后端/界面长时间未就绪（如异常卡死）时强制收尾，避免无边框启动窗永久占用
    setTimeout(() => {
      if (splashWin && !splashWin.isDestroyed()) {
        splashWin.close();
        splashWin = null;
      }
      if (mainWin && !mainWin.isDestroyed()) mainWin.show();
    }, 90000);
  }

  // 主窗口：后端/界面任一就绪前保持隐藏，由启动窗承载等待反馈
  mainWin = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    title: 'MTask · AI 任务开发管理工具',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // T00771：preload 暴露 mtaskDesktop.openDirectory（系统目录选择对话框）。
      // 路径随 __dirname 解析：开发态为 electron/ 目录，打包态为 app.asar/electron，两态一致。
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 全局右键菜单（webContents 级监听，覆盖 SPA 内所有页面）：
  // 选中文字时弹「复制」（含输入框内的选中场景）；可编辑且未选中时弹「粘贴」；其余场景不弹菜单。
  // Electron 不像浏览器自带右键菜单，必须显式构建，否则选取文字后无法右键复制。
  mainWin.webContents.on('context-menu', (_event, params) => {
    const template = [];
    if (params.selectionText?.trim()) {
      template.push({ label: '复制', role: 'copy' });
    }
    if (params.isEditable) {
      if (template.length) template.push({ type: 'separator' });
      template.push({ label: '粘贴', role: 'paste' });
    }
    if (template.length) Menu.buildFromTemplate(template).popup({ window: mainWin });
  });

  // 界面资源加载完成 → 进入 80% 阶段；两端就绪即可收尾
  mainWin.webContents.on('did-finish-load', () => {
    uiReady = true;
    if (backendReady) updateSplash(80, '加载界面');
    else updateSplash(80, '加载界面，等待后端…');
    maybeFinishSplash();
  });

  // T00840：注册主窗口关闭守卫——有运行任务时先弹确认而非直接退出
  setupCloseGuard(mainWin);

  await ensureBackend();

  if (DEV) {
    await mainWin.loadURL(`http://localhost:${VITE_PORT}`);
  } else {
    await mainWin.loadURL('app://ui/index.html');
  }
});

app.on('window-all-closed', () => {
  // 是否退出交由 before-quit 统一裁决：自拉后端先可靠终止，复用外部服务则直接退出
  app.quit();
});

// 兜底：极端情况下（用户强杀主进程 / 崩溃 / app.exit 异常路径）内嵌 server 子进程可能与主进程同名
// 残留，导致安装器检测到运行进程而提示“无法关闭”。此钩子保证进程退出瞬间强制终止子进程。
process.on('exit', () => {
  try {
    if (serverProc && !serverProc.killed) serverProc.kill('SIGKILL');
  } catch { /* 清理失败已尽力，交由安装器 taskkill 兜底 */ }
});
