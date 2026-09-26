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
      .catch((err) => new Response(`api proxy error: ${err.message}`, { status: 502 }));
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
          if (!notifyPrimed) {
            // 首轮：仅建立基线，不轰炸存量未读
            notifyPrimed = true;
          } else {
            for (const it of items) {
              const prev = notifySeen.get(it.task_no);
              if (prev !== it.ai_state) showTaskNotification(it);
            }
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

/** 从下载 URL 提取文件名（末尾路径段，去掉查询串）；取不到则回退默认名 */
function downloadFilename(url) {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (seg) return seg;
  } catch { /* 非法 URL，走回退 */ }
  return `mtask-update-${Date.now()}.exe`;
}

// 应用内下载更新安装包到系统下载目录，下载进度经 webContents.send 推给渲染进程
ipcMain.handle('update:download', async (_evt, url) => {
  if (typeof url !== 'string' || !url) throw new Error('下载地址无效');
  const filePath = path.join(app.getPath('downloads'), downloadFilename(url));
  // 流式下载到临时文件，写完再改名，避免下载中断残留半截"安装包"被误执行
  const tmpPath = filePath + `.part`;

  // 用 Node https 手动流：可精确拿到 content-length 与逐块字节数来推进度，
  // 比 electron session downloadURL（走默认下载器、事件回调复杂）更可控、无侧栏打扰。
  await new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'MTask-Updater' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // 跟随 302/303（GitHub Release asset 通常重定向到云端存储）
        https.get(res.headers.location, { headers: { 'User-Agent': 'MTask-Updater' } }, (r2) => pump(r2)).on('error', reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`下载失败：HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      pump(res);
      async function pump(r) {
        // 失败清理：删掉残留别名文件，避免下次误判断下载完成
        const cleanup = () => { try { fs.rmSync(tmpPath, { force: true }); } catch { /* 忽略 */ } };
        const total = Number(r.headers['content-length'] || 0);
        let received = 0;
        const out = fs.createWriteStream(tmpPath);
        r.on('data', (chunk) => {
          received += chunk.length;
          out.write(chunk);
          // 节流推送进度（每块都 send 会太频繁，这里按字节步进）——进度是给"若非流式会卡界面"的场景兜底的低频更新
          if (received % (1 << 20) === 0 && mainWin && !mainWin.isDestroyed()) {
            mainWin.webContents.send('update:progress', { status: 'downloading', received, total });
          }
        });
        r.on('end', () => {
          out.end(() => {
            try { fs.renameSync(tmpPath, filePath); } catch (e) {
              cleanup();
              reject(new Error(`写入安装包失败：${e.message}`));
              return;
            }
            if (mainWin && !mainWin.isDestroyed()) {
              mainWin.webContents.send('update:progress', { status: 'downloaded', received, total, filePath });
            }
            resolve(filePath);
          });
        });
        r.on('error', (e) => { cleanup(); out.destroy(); reject(e); });
        out.on('error', (e) => { cleanup(); reject(e); });
      }
    }).on('error', reject);
  });
  return filePath;
});

// 静默安装已下载的安装包并退出当前应用：NSIS 安装器自身会 taskkill 旧 MTask 进程，故可无缝覆盖
ipcMain.handle('update:install', async (_evt, filePath) => {
  if (typeof filePath !== 'string' || !filePath || !fs.existsSync(filePath)) throw new Error('安装包不存在，或已失效');
  try {
    // /S=静默安装，detached 使安装器独立于本进程存活；stdio ignore 不阻塞主进程退出
    const child = spawn(filePath, ['/S'], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e) {
    throw new Error(`启动安装程序失败：${e instanceof Error ? e.message : String(e)}`);
  }
  // 给渲染进程留出闪现提示的时间，随即退出本应用让安装器接管
  setTimeout(() => app.quit(), 1500);
  return { ok: true };
});

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
}

// 主进程为 CommonJS 入口（electron/package.json 未启用 "type":"module"），顶层 await 语法非法；
// 改 ESM 需把全部 require 重写为 import 并调整打包入口，风险远大于收益，维持 promise 链是 CJS 主进程的标准写法
app.whenReady().then(async () => { // NOSONAR - S7785 顶层 await 在 CommonJS 中不可用，原因见上
  setupApiProxy();
  setupWebProtocol();

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
