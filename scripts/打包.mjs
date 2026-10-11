#!/usr/bin/env node
/**
 * T00749：无 cmd/.bat 依赖的打包脚本（`构建打包.bat` 的 Node 等价实现）。
 *
 * 背景：沙箱与部分 CI 环境禁止/不便调用 .bat；`trim-locales.js` 的批量删除会触发
 * WorkBuddy 安全删除守卫（SAFE_DELETE_BULK_CONFIRM_REQUIRED），需要逃生开关。
 *
 * 用法：node scripts/打包.mjs
 *
 * 步骤（与 构建打包.bat 对齐）：
 *  [1] 依赖检查（node_modules 存在）
 *  [2] Electron 二进制检查（缺失时 node electron/install.js 下载）
 *  [3] server typecheck（tsc --noEmit）
 *  [4] server build（tsc -p）
 *  [5] web build（vite build）
 *  [6] 版本号递增（bump-version.js）→ 切 Electron ABI → electron-builder --win
 *      （带 -c.buildVersion=<version> 保住 4 段版本名，见修复4/T01569）
 *      → 还原打包前 ABI → 尝试清理 win-unpacked
 *
 * 说明：
 *  - electron-builder 子进程统一带 CODEBUDDY_SAFE_DELETE_ENABLED=0（shim 官方逃生开关）：
 *    打包产物目录的批量删除属构建必需行为，不能被安全删除守卫拦截。
 *  - 输出目录兜底：release/win-unpacked 被占用时依次尝试 release2..release9。
 *  - 构建打包.bat 保留为 Windows 用户的一键入口（行为不变）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { switchAbi, snapshotWorkspaceAbi, restoreWorkspaceAbi } from './lib/abi-switch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
let step = 0;
const fail = (msg) => { console.error(`[ERROR] ${msg}`); process.exit(1); };
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell: false, ...opts });
  if (r.status !== 0) fail(`命令失败（exit=${r.status}）：${cmd} ${args.join(' ')}`);
};
const runCapture = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: false });
  if (r.status !== 0) fail(`命令失败（exit=${r.status}）：${cmd} ${args.join(' ')}`);
  return r.stdout.trim();
};
const log = (msg) => console.log(`[${++step}/6] ${msg}`);

// [1] 依赖检查
log('依赖检查…');
if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
  log('node_modules 缺失，执行 npm install…');
  run(NODE, [path.join(ROOT, 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'install', '--no-audit', '--no-fund']);
}

// [2] Electron 二进制
log('Electron 二进制检查…');
if (!fs.existsSync(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'))) {
  run(NODE, [path.join(ROOT, 'node_modules', 'electron', 'install.js')]);
}

// [3] server typecheck
log('server typecheck…');
run(NODE, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', path.join(ROOT, 'server', 'tsconfig.json')]);

// [4] server build
log('server build…');
run(NODE, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(ROOT, 'server', 'tsconfig.json')]);

// [5] web build
// T00749 补充：vite 清空 dist 产物目录的 rmSync 同样可能触发安全删除守卫——子进程统一带逃生开关
log('web build…');
run(NODE, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
  cwd: path.join(ROOT, 'web'),
  env: { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: '0' },
});

// [6] 版本递增 + ABI 切换 + electron-builder
log('版本号递增…');
run(NODE, [path.join(ROOT, 'scripts', 'bump-version.js')]);
const appVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// T02069：ABI 切换抽到 scripts/lib/abi-switch.mjs，与 scripts/dist.js 共用同一实现
// （缓存缺失 fail-fast、打包前记录工作区二进制、打包后按字节原样还原）。
const abiOpts = { fail, log: (m) => console.log(m) };
log('切换 Electron ABI 并打包…');
// 打包前记录工作区当前的原生二进制，打包后原样还原（见下方恢复段）。
const prevAbi = snapshotWorkspaceAbi(ROOT);
switchAbi(ROOT, 'electron', abiOpts);

// 输出目录兜底：release 被占用（win-unpacked 无法清理）时依次尝试 release2..9
const candidates = ['release', 'release2', 'release3', 'release4', 'release5', 'release6', 'release7', 'release8', 'release9'];
let outDir = '';
for (const dir of candidates) {
  const unpacked = path.join(ROOT, dir, 'win-unpacked');
  if (!fs.existsSync(unpacked)) { outDir = dir; break; }
  try { fs.rmSync(unpacked, { recursive: true, force: true }); outDir = dir; break; } catch { /* 被占用，尝试下一目录 */ }
}
if (!outDir) fail('release 及 release2..9 的 win-unpacked 均被占用，无法打包。请关闭相关进程或删除目录后重试。');
if (outDir !== 'release') console.log(`[WARN] release 被占用，打包到 ${outDir}`);

// 安全删除守卫逃生开关：仅作用于 electron-builder 子进程（打包产物的批量删除是构建必需行为）；
// 非 WorkBuddy 沙箱环境下该变量无任何作用。
const childEnv = {
  ...process.env,
  CODEBUDDY_SAFE_DELETE_ENABLED: '0',
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? 'https://npmmirror.com/mirrors/electron-builder-binaries/',
};
run(NODE, [path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
  '--win', `-c.buildVersion=${appVer}`, `--config.directories.output=${outDir}`, '--publish=never'], { env: childEnv });

// 恢复打包前的 ABI：build/native/dev 是针对旧 Node 运行时缓存的，本地 Node 升级后直接覆盖会让
// server/dist 直跑报 ERR_DLOPEN_FAILED（实测 Node24/ABI137 环境 require 失败），故按字节原样还原。
restoreWorkspaceAbi(ROOT, prevAbi, abiOpts);

// 清理 win-unpacked（非致命）
try {
  fs.rmSync(path.join(ROOT, outDir, 'win-unpacked'), { recursive: true, force: true });
  console.log('[OK] 已清理 win-unpacked');
} catch {
  console.warn(`[WARN] 未能删除 ${outDir}\\win-unpacked（被进程占用），下次打包前请手动清理。`);
}

console.log('\n============================================');
console.log(' Build done');
console.log(` server: server\\dist\n web:    web\\dist\n exe:    ${outDir}\\\n version: ${appVer}`);
console.log('============================================');
