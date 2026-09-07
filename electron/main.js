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

const { app, BrowserWindow, Menu, protocol, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
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
