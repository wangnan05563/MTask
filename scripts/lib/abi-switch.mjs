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
import path from 'node:path';

const WORKSPACE_NODE = path.join('node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
const LOCK_SIDECAR = `${WORKSPACE_NODE}.mtask-lock`;

export function cachePath(root, mode) {
  return path.join(root, 'build', 'native', mode, 'better_sqlite3.node');
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

/** 按字节原样还原快照；无快照（工作区本来就没有 .node）时回落到 switchAbi('dev')。 */
export function restoreWorkspaceAbi(root, snapshot, { fail, log = (m) => console.log(m), sidecar = null } = {}) {
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
  try {
    if (!fs.existsSync(dst) || sha256File(dst) !== want) fs.writeFileSync(dst, snapshot);
    const got = sha256File(dst);
    if (got !== want) fail(`还原失败：工作区 better_sqlite3.node 与打包前不一致（期望 ${want.slice(0, 12)}，实际 ${got.slice(0, 12)}）`);
    log('[ABI] better-sqlite3 → 还原打包前工作区版本（sha256 校验通过）');
  } catch (e) {
    fail(`还原工作区原生二进制失败：${e.message}`);
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
