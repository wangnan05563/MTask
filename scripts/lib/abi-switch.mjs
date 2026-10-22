/**
 * T02069：better-sqlite3 Electron/Node ABI 切换的单一实现，供 scripts/打包.mjs 与 scripts/dist.js 复用。
 *
 * 背景：package.json 的 build.npmRebuild = false，electron-builder 不重编译原生模块，只按 asarUnpack
 * 把 node_modules/better-sqlite3 原样搬进包内——包内 .node 的 ABI 完全等于打包时工作区那份。所以
 * 「打包前切到 Electron 缓存、打包后按字节还原工作区版本」是出可用安装包的必要条件（实测：用
 * dev ABI 出的包装机后后端 NODE_MODULE_VERSION 127 vs 130 直接起不来）。还原是本地 node 直跑
 * server/dist 的前提，不能被打包改掉。
 */
import fs from 'node:fs';
import path from 'node:path';

const WORKSPACE_NODE = path.join('node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');

export function cachePath(root, mode) {
  return path.join(root, 'build', 'native', mode, 'better_sqlite3.node');
}

export function workspaceNodePath(root) {
  return path.join(root, WORKSPACE_NODE);
}

/** 打包前记录工作区当前的原生二进制（不存在返回 null，由调用方决定回落策略）。 */
export function snapshotWorkspaceAbi(root) {
  const dst = workspaceNodePath(root);
  return fs.existsSync(dst) ? fs.readFileSync(dst) : null;
}

export function switchAbi(root, mode, { fail, log = (m) => console.log(m) }) {
  const src = cachePath(root, mode);
  if (!fs.existsSync(src)) fail(`ABI 缓存缺失：${src}（可用 scripts/native-switch.bat dev 重建）`);
  const dst = workspaceNodePath(root);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  log(`[ABI] better-sqlite3 → ${mode}`);
}

/** 按字节原样还原快照；无快照（工作区本来就没有 .node）时回落到 switchAbi('dev')。 */
export function restoreWorkspaceAbi(root, snapshot, { fail, log = (m) => console.log(m) }) {
  if (snapshot) {
    fs.writeFileSync(workspaceNodePath(root), snapshot);
    log('[ABI] better-sqlite3 → 还原打包前工作区版本');
  } else {
    switchAbi(root, 'dev', { fail, log });
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
