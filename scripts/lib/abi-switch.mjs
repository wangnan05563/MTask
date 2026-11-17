/**
 * T02069：better-sqlite3 Electron/Node ABI 切换的单一实现，供 scripts/打包.mjs 与 scripts/dist.js 复用。
 *
 * 背景：package.json 的 build.npmRebuild = false，electron-builder 不重编译原生模块，只按 asarUnpack
 * 把 node_modules/better-sqlite3 原样搬进包内——包内 .node 的 ABI 完全等于打包时工作区那份。所以
 * 「打包前切到 Electron 缓存、打包后按字节还原工作区版本」是出可用安装包的必要条件（实测：用
 * dev ABI 出的包装机后后端 NODE_MODULE_VERSION 127 vs 130 直接起不来）。还原是本地 node 直跑
 * server/dist 的前提，不能被打包改掉。
 *
 * T03731：切换改为「可恢复事务」，不再假设「被占用就必须让人工关进程」：
 *   - 先按需重试（默认 4 次 × 750ms），覆盖另一个会话正在复制/杀毒扫描这类瞬时占用；
 *   - 仍失败才用改名旁路接管（Windows 允许 rename 被映射中的映像，实测删除/覆盖都不会被映射本身挡住，
 *     真占用来自别的进程的共享模式），打包结束按快照还原；
 *   - 切换与还原都做 sha256 校验——「拷过去但字节不对」与「没拷贝」一样是坏包，必须当场红；
 *   - 失败时枚举占用进程（PID / 命令行），把「该关谁」写进错误信息，而不是笼统说「有进程占用」。
 * 历史坑（T03731 根因）：旧 .bat 用 `[IO.File]::Open(...,'None')` 探针把结果写到 %TEMP% 共享文件再
 * `set /p` 读回；PowerShell 起不来、输出为空或并发构建撞同一个临时文件时，变量读空 —— 判据
 * `if /i not "%BSLOCK%"=="UNLOCKED"` 于是把「探针没跑成」当成「被锁」，构建无端中止并已烧掉一个版本号。
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORKSPACE_NODE = path.join('node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
const LOCK_SIDECAR = `${WORKSPACE_NODE}.mtask-lock`;

const RELEASE_CACHE = path.join('release', '.mtask-abi-cache');

/**
 * T05739：可重复构建产物集中到 release/。
 * release\.mtask-abi-cache 为主缓存，build\native 只作为旧布局的兼容兜底；
 * 这样构建脚本自动播种时不会再在仓库根重建 build\native。
 */
export function cacheCandidates(root, mode) {
  return [
    path.join(root, RELEASE_CACHE, mode, 'better_sqlite3.node'),
    path.join(root, 'build', 'native', mode, 'better_sqlite3.node'),
  ];
}

export function cachePath(root, mode) {
  const candidates = cacheCandidates(root, mode);
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

/** 写入缺失的 ABI 缓存；首选 release\.mtask-abi-cache，失败再落 build\native。 */
export function writeCache(root, mode, data) {
  const candidates = cacheCandidates(root, mode);
  let lastErr = null;
  for (const p of candidates) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, data);
      return p;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`无法写入 ${mode} ABI 缓存（${candidates.join(' / ')}）：${lastErr?.message || '未知错误'}`);
}

function readCacheSource(root, mode) {
  for (const p of cacheCandidates(root, mode)) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 当前工作区二进制能否被当前 Node 加载；用来判断它是否可充当 dev 缓存。 */
function isNodeLoadable(root) {
  const r = spawnSync(process.execPath, ['-e', 'require("better-sqlite3")'], {
    cwd: root, stdio: 'ignore', timeout: 15000, windowsHide: true,
  });
  return r.status === 0;
}

/** 从历史安装包 win-unpacked 找 Electron ABI 二进制（release 被清理时可能不存在）。 */
function findElectronFromRelease(root) {
  const dirs = ['release', 'release2', 'release3', 'release4', 'release5', 'release6', 'release7', 'release8', 'release9'];
  for (const dir of dirs) {
    const p = path.join(
      root, dir, 'win-unpacked', 'resources', 'app.asar.unpacked',
      'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node',
    );
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 从已安装的 MTask 桌面应用找 Electron ABI 二进制（release 被整体清理后的兜底）。 */
function findElectronFromInstalledApp() {
  const local = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.PROGRAMFILES || '';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] || '';
  const bases = [
    path.join(local, 'Programs', 'MTask'),
    path.join(local, 'Programs', 'mtask'),
    path.join(local, 'MTask'),
    path.join(programFiles, 'MTask'),
    path.join(programFilesX86, 'MTask'),
  ].filter(Boolean);
  for (const base of bases) {
    const p = path.join(
      base, 'resources', 'app.asar.unpacked',
      'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node',
    );
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 从历史恢复目录读 Electron 缓存；兼容本机曾生成的 mtask-recovery 副本。 */
function findElectronFromRecoveryCache() {
  const candidates = [
    path.join(os.tmpdir(), 'mtask-recovery', 'build', 'native', 'electron', 'better_sqlite3.node'),
    path.join(os.tmpdir(), 'mtask-recovery', 'release', '.mtask-abi-cache', 'electron', 'better_sqlite3.node'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function abiOfBuffer(buf) {
  const m = /node_register_module_v(\d+)/.exec(buf.toString('latin1'));
  return m ? Number(m[1]) : null;
}

function restoreSnapshot(root, snapshot) {
  const dst = workspaceNodePath(root);
  if (snapshot) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, snapshot);
  } else {
    fs.rmSync(dst, { force: true });
  }
}

/**
 * 最后的自动兜底：用 prebuild-install 下载当前 Electron 版本的 better-sqlite3 预编译包。
 * 下载会先覆盖工作区二进制，因此下载前快照、下载后按字节还原；成功返回临时文件路径。
 */
function downloadElectronPrebuild(root, { log = (m) => console.log(m) } = {}) {
  const betterDir = path.join(root, 'node_modules', 'better-sqlite3');
  const bin = path.join(root, 'node_modules', 'prebuild-install', 'bin.js');
  const electronPkg = path.join(root, 'node_modules', 'electron', 'package.json');
  if (!fs.existsSync(bin) || !fs.existsSync(electronPkg)) return null;

  let electronVersion;
  try {
    electronVersion = JSON.parse(fs.readFileSync(electronPkg, 'utf8')).version;
  } catch {
    return null;
  }
  if (!electronVersion) return null;

  const snapshot = snapshotWorkspaceAbi(root);
  let temp = null;
  try {
    log(`[ABI][WARN] electron 缓存缺失，尝试下载 Electron ${electronVersion} 预编译包…`);
    const r = spawnSync(process.execPath, [
      bin,
      '--runtime=electron',
      `--target=${electronVersion}`,
      '--arch=x64',
      '--platform=win32',
      '--tag-prefix=v',
    ], {
      cwd: betterDir,
      stdio: 'inherit',
      timeout: 180000,
      windowsHide: true,
    });
    if (r.status !== 0) {
      log('[ABI][WARN] prebuild-install 下载失败，无法自动创建 electron 缓存。');
      return null;
    }
    const built = path.join(betterDir, 'build', 'Release', 'better_sqlite3.node');
    if (!fs.existsSync(built)) return null;
    const data = fs.readFileSync(built);
    if (snapshot && sha256Buffer(data) === sha256Buffer(snapshot)) {
      log('[ABI][WARN] prebuild-install 未产出不同 ABI 的二进制，跳过。');
      return null;
    }
    temp = path.join(os.tmpdir(), `mtask-electron-prebuild-${process.pid}.node`);
    fs.writeFileSync(temp, data);
    log(`[ABI] 已下载 electron ABI ${abiOfBuffer(data) ?? '未知'} 预编译包`);
    return temp;
  } catch (err) {
    log(`[ABI][WARN] electron 缓存下载异常：${err?.message || err}`);
    return null;
  } finally {
  // 无论下载成功还是失败，都恢复工作区原有的 dev 二进制。
    try { restoreSnapshot(root, snapshot); } catch { /* 还原失败不阻断缓存写入 */ }
  }
}

/**
 * 构建前自动补齐缺失的 dev/electron ABI 缓存：
 * - 先找本项目逻辑根目录（junction 场景下 process.cwd() 是 D 盘真实入口）；
 * - 再找当前 root（可能是 E 盘真实 target）；
 * - dev 最后允许用「当前 Node 能加载的工作区二进制」播种；
 * - electron 最后允许从历史 release\win-unpacked\app.asar.unpacked 播种；
 * - 仍找不到才 fail，并明确列出候选路径。
 */
export function ensureCache(root, { fail, log = (m) => console.log(m) } = {}) {
  const logicalRoot = process.cwd();
  const roots = [...new Set([root, logicalRoot])];

  for (const mode of ['dev', 'electron']) {
    const existing = roots.map((r) => readCacheSource(r, mode)).find(Boolean);
    if (existing) {
      const primary = cacheCandidates(root, mode)[0];
      if (!fs.existsSync(primary)) {
        const dest = writeCache(root, mode, fs.readFileSync(existing));
        log(`[ABI] ${mode} 缓存缺失，已自动创建：${dest}（来源 ${existing}）`);
      } else {
        log(`[ABI] ${mode} 缓存已存在：${primary}`);
      }
      continue;
    }

    let source = null;
    for (const r of roots) {
      source = readCacheSource(r, mode);
      if (source) break;
    }
    if (!source && mode === 'dev') {
      const ws = workspaceNodePath(root);
      if (fs.existsSync(ws) && isNodeLoadable(root)) source = ws;
    }
    if (!source && mode === 'electron') {
      for (const r of roots) {
        source = findElectronFromRelease(r);
        if (source) break;
      }
      if (!source) source = findElectronFromInstalledApp();
      if (!source) source = findElectronFromRecoveryCache();
      if (!source) {
        log('[ABI][WARN] 本地未找到 electron 缓存，尝试 prebuild-install 自动下载…');
        source = downloadElectronPrebuild(root, { log });
      }
    }
    if (!source) {
      fail(`ABI 缓存缺失且无法自动创建：${mode}\n`
        + `  已查找：${roots.map((r) => cacheCandidates(r, mode).join(' / ')).join('\n          ')}\n`
        + '  可先执行 scripts\\native-switch.bat dev/electron 生成，或从历史安装包 app.asar.unpacked 复制。');
    }

    const data = fs.readFileSync(source);
    const dest = writeCache(root, mode, data);
    if (path.basename(source).startsWith('mtask-electron-prebuild-')) {
      fs.rmSync(source, { force: true });
    }
    log(`[ABI] ${mode} 缓存缺失，已自动创建：${dest}（来源 ${source}）`);
  }
  return 0;
}

export function workspaceNodePath(root) {
  return path.join(root, WORKSPACE_NODE);
}

export function lockSidecarPath(root) {
  return path.join(root, LOCK_SIDECAR);
}

export function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function sha256File(p) {
  return sha256Buffer(fs.readFileSync(p));
}

/** 同步等待：本模块在打包入口里是同步调用链，不能用 setTimeout。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 真实可写性探针：用「打包真正要做的动作」判定，而不是更严格的独占共享模式。
 * 被映射中的 .node 不会让这个探针失败（实测），因此不会再现旧探针那类假阳性。
 */
export function probeNativeWritable(file) {
  try {
    fs.closeSync(fs.openSync(file, 'r+'));
    return { writable: true };
  } catch (e) {
    return { writable: false, code: e.code || 'UNKNOWN' };
  }
}

/** 探针带重试：给「另一个会话正在复制/杀毒正在扫」这类瞬时占用留出恢复窗口。 */
export function waitForWritable(file, { tries = 4, delayMs = 750 } = {}) {
  let res = probeNativeWritable(file);
  for (let i = 1; i < tries && !res.writable; i += 1) {
    sleepSync(delayMs);
    res = probeNativeWritable(file);
  }
  return res;
}

/** 尽力枚举可能持有原生二进制的本仓进程（仅用于错误提示，任何失败都不影响判定）。 */
export function describeHolders(root) {
  if (process.platform !== 'win32') return [];
  const script = 'Get-CimInstance Win32_Process | Where-Object { $_.Name -in @("node.exe","electron.exe","MTask.exe") } '
    + '| Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress';
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 8000, windowsHide: true,
  });
  if (r.status !== 0 || !r.stdout) return [];
  let rows = [];
  try {
    const parsed = JSON.parse(r.stdout);
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
  const needle = path.resolve(root).toLowerCase().replaceAll('/', '\\');
  return rows
    .filter((p) => typeof p.CommandLine === 'string' && p.CommandLine.toLowerCase().replaceAll('/', '\\').includes(needle))
    .map((p) => `PID ${p.ProcessId} ${p.Name}：${String(p.CommandLine).slice(0, 160)}`);
}

/** 打包前记录工作区当前的原生二进制（不存在返回 null，由调用方决定回落策略）。 */
export function snapshotWorkspaceAbi(root) {
  const dst = workspaceNodePath(root);
  return fs.existsSync(dst) ? fs.readFileSync(dst) : null;
}

function copyAndVerify(src, dst, expectSha) {
  fs.copyFileSync(src, dst);
  const got = sha256File(dst);
  if (got !== expectSha) throw new Error(`字节校验不一致（期望 ${expectSha.slice(0, 12)}，实际 ${got.slice(0, 12)}）`);
}

/**
 * 切换工作区原生二进制到指定 ABI 缓存。
 * @returns {{sidecar: string|null, sha: string}} sidecar 非空表示走了改名接管，还原时必须带上
 */
export function switchAbi(root, mode, { fail, log = (m) => console.log(m), lockRetries = 4, lockRetryDelayMs = 750 } = {}) {
  const src = cachePath(root, mode);
  if (!fs.existsSync(src)) fail(`ABI 缓存缺失：${src}（可用 scripts/native-switch.bat dev 重建）`);
  const dst = workspaceNodePath(root);
  const sidecar = lockSidecarPath(root);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const expectSha = sha256File(src);

  let lastErr = null;
  for (let i = 0; i <= lockRetries; i += 1) {
    try {
      copyAndVerify(src, dst, expectSha);
      log(`[ABI] better-sqlite3 → ${mode}`);
      return { sidecar: null, sha: expectSha };
    } catch (e) {
      lastErr = e;
      if (i === 0 && lockRetries > 0) log(`[ABI] 目标暂时不可写（${e.code || e.message}），重试 ${lockRetries} 次…`);
      if (i < lockRetries) sleepSync(lockRetryDelayMs);
    }
  }

  // 重试仍失败：改名旁路接管（原文件被占用时，rename 不受共享模式限制）
  if (fs.existsSync(sidecar)) fs.rmSync(sidecar, { force: true });
  let movedAside = false;
  try {
    if (fs.existsSync(dst)) { fs.renameSync(dst, sidecar); movedAside = true; }
    copyAndVerify(src, dst, expectSha);
    log(`[ABI][WARN] ${path.basename(dst)} 被占用（${lastErr?.code ?? '未知'}），已改名旁路接管：打包结束自动还原`);
    return { sidecar, sha: expectSha };
  } catch (e) {
    // 尽力回滚到切换前状态，避免留下「既不是 dev 也不是 electron」的半截文件
    try {
      if (movedAside && !fs.existsSync(dst)) fs.renameSync(sidecar, dst);
      else if (movedAside) fs.rmSync(sidecar, { force: true });
    } catch { /* 回滚失败只在下面一并报出 */ }
    const holders = describeHolders(root);
    fail(`切换到 ${mode} ABI 失败：${e.message}`
      + (holders.length ? `\n  可能的占用进程：\n   - ${holders.join('\n   - ')}` : '\n  未能枚举占用进程，请检查杀毒/资源管理器预览。'));
  }
}

/**
 * 按字节原样还原快照；无快照（工作区本来就没有 .node）时回落到 switchAbi('dev')。
 *
 * 与 switchAbi 对称的 EBUSY 兜底（此前只有 switch 有、restore 没有 → 打包产物已成功、
 * 收尾还原却因 dev server / 桌面壳占用 .node 而整包报红，2026-11-17 实测）：
 *   1) 有旁路文件时先 rename 回填（原字节，不依赖能否覆盖被映射中的 .node）；
 *   2) 带重试直接写快照；
 *   3) 仍不可写 → 改名旁路：rename dst→sidecar 后写快照（Windows 上被 map 的 dll 可改名、不可覆盖）。
 * 任何一步失败都尽力回滚，避免留下「既不是快照也不是切换目标」的半截二进制。
 */
export function restoreWorkspaceAbi(root, snapshot, {
  fail, log = (m) => console.log(m), sidecar = null,
  lockRetries = 4, lockRetryDelayMs = 750,
} = {}) {
  const dst = workspaceNodePath(root);
  const sp = sidecar || lockSidecarPath(root);

  // 走改名接管时优先用 rename 把原文件放回（保留原字节，且不依赖能否覆盖）
  if (fs.existsSync(sp)) {
    try {
      if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
      fs.renameSync(sp, dst);
    } catch (e) {
      log(`[ABI][WARN] 旁路文件回填失败（${e.code || e.message}），改用快照写入`);
    }
  }

  if (!snapshot) {
    switchAbi(root, 'dev', { fail, log });
    return;
  }
  const want = sha256Buffer(snapshot);

  // 带重试直接写：dev server 重启/杀毒扫描造成的瞬时占用在这一层就消化掉
  let lastErr = null;
  for (let i = 0; i <= lockRetries; i += 1) {
    try {
      if (!fs.existsSync(dst) || sha256File(dst) !== want) fs.writeFileSync(dst, snapshot);
      const got = sha256File(dst);
      if (got !== want) throw new Error(`字节校验不一致（期望 ${want.slice(0, 12)}，实际 ${got.slice(0, 12)}）`);
      log('[ABI] better-sqlite3 → 还原打包前工作区版本（sha256 校验通过）');
      return;
    } catch (e) {
      lastErr = e;
      if (i === 0 && lockRetries > 0) log(`[ABI] 还原目标暂时不可写（${e.code || e.message}），重试 ${lockRetries} 次…`);
      if (i < lockRetries) sleepSync(lockRetryDelayMs);
    }
  }

  // 重试仍失败：改名旁路接管（被映射中的 .node 可以 rename，不可覆盖写）
  try {
    if (fs.existsSync(sp)) fs.rmSync(sp, { force: true });
    let movedAside = false;
    if (fs.existsSync(dst)) { fs.renameSync(dst, sp); movedAside = true; }
    fs.writeFileSync(dst, snapshot);
    const got = sha256File(dst);
    if (got !== want) throw new Error(`字节校验不一致（期望 ${want.slice(0, 12)}，实际 ${got.slice(0, 12)}）`);
    log(`[ABI][WARN] 还原目标被占用（${lastErr?.code ?? '未知'}），已改名旁路接管：打包前版本已就位`);
    return;
  } catch (e) {
    try {
      if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
      if (fs.existsSync(sp)) fs.renameSync(sp, dst);
    } catch { /* 回滚失败一并报出 */ }
    const holders = describeHolders(root);
    fail(`还原工作区原生二进制失败：${e.message}`
      + (holders.length ? `\n  可能的占用进程：\n   - ${holders.join('\n   - ')}` : ''));
  }
}

/** T02079：输出目录兜底——release/win-unpacked 被占用时依次尝试 release2..9，全被占用才抛错。
 * @returns {string} 选中的输出目录名（如 'release' 或 'release2'）
 */
export function resolveOutputDir(root, { fail, log = (m) => console.log(m) }) {
  const candidates = ['release', 'release2', 'release3', 'release4', 'release5', 'release6', 'release7', 'release8', 'release9'];
  let outDir = '';
  for (const dir of candidates) {
    const unpacked = path.join(root, dir, 'win-unpacked');
    if (!fs.existsSync(unpacked)) { outDir = dir; break; }
    try { fs.rmSync(unpacked, { recursive: true, force: true }); outDir = dir; break; } catch { /* 被占用，尝试下一目录 */ }
  }
  if (!outDir) fail('release 及 release2..9 的 win-unpacked 均被占用，无法打包。请关闭相关进程或删除目录后重试。');
  if (outDir !== 'release') console.log(`[WARN] release 被占用，打包到 ${outDir}`);
  return outDir;
}

/** T02079：构建子进程环境变量——安全删除开关 + Electron/electron-builder 镜像。 */
export function buildChildEnv() {
  return {
    ...process.env,
    CODEBUDDY_SAFE_DELETE_ENABLED: '0',
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
    ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  };
}
