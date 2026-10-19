#!/usr/bin/env node
/**
 * T00749：无 cmd/.bat 依赖的打包脚本（`构建打包.bat` 的 Node 等价实现）。
 *
 * 背景：沙箱与部分 CI 环境禁止/不便调用 .bat；`trim-locales.js` 的批量删除会触发
 * WorkBuddy 安全删除守卫（SAFE_DELETE_BULK_CONFIRM_REQUIRED），需要逃生开关。
 *
 * 用法：node scripts/打包.mjs [--skip-head-check]
 *
 * 步骤（与 构建打包.bat 对齐）：
 *  [1] 依赖检查（node_modules 存在）
 *  [2] Electron 二进制检查（缺失时 node electron/install.js 下载）
 *  [3] HEAD 自洽性预检（T02321）——对 HEAD 的 worktree 副本跑 tsc，见 verify-t02295 门
 *  [4] server typecheck（tsc --noEmit）
 *  [5] server build（tsc -p）
 *  [6] web build（vite build）
 *  [7] 版本号递增（bump-version.js）→ 切 Electron ABI → electron-builder --win
 *      （带 -c.buildVersion=<version> 保住 4 段版本名，见修复4/T01569）
 *      → 还原打包前 ABI → 尝试清理 win-unpacked
 *
 * 说明：
 *  - **[3] 为什么必须在工作树 typecheck 之前**：本仓常年有并发会话 WIP，工作树是「HEAD + 未提交
 *    hunk」的叠加态——「引用已入库、定义没入库」的缺口会被另一个会话的 WIP 恰好补齐，于是 [4] 步
 *    全绿、安装包照样产出，但按那个 commit 重新 checkout 就编译不出来（发布件不可复现）。
 *  - `--skip-head-check`：显式跳过 [3]，供「明知 HEAD 红、只想出临时包」使用；跳过会打成醒目一行，
 *    不静默（静默跳过等于没这道门）。
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
const log = (msg) => console.log(`[${++step}/7] ${msg}`);

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

// [3] HEAD 自洽性预检（T02321）：判据打在提交上，不是工作树叠加态
// T02355：实现收口到 scripts/lib/head-precheck.mjs，与 dist.js / 构建打包.bat / build-pack-t.bat 共用同一份
// T02617 提交纪律：本仓索引里常躺着并发会话 staged 的**旧版发布入口**（那次实测是摘掉预检、步骤计数还停在
//   /6 的 打包.mjs）。不带路径的 `git commit` 会把那份旧副本写进提交，守卫调用行就此消失，而工作树看着全绿。
//   所以提交这几条入口时必须带明确路径：`git commit -- scripts/打包.mjs scripts/lib/head-precheck.mjs`。
//   预检自己也会先自检「三条面（工作树/HEAD/索引）都还调用守卫」，任一面丢引用即在构建之前中止。
const { runHeadPrecheck, isRequestedSkip, shortHead } = await import('./lib/head-precheck.mjs');
const SKIP_HEAD_CHECK = isRequestedSkip();
const headSha = shortHead();
if (SKIP_HEAD_CHECK) {
  runHeadPrecheck({ skip: true, sha: headSha });
  step = 3; // 占位：保持后续步骤编号连续
} else {
  log(`HEAD 自洽性预检（commit ${headSha || '未知'}）…`);
  const r = runHeadPrecheck({ sha: headSha });
  if (r.status !== 0) {
    fail(`HEAD 自洽性预检未通过（commit ${headSha || '未知'}）：该提交单独 checkout 编译不过，`
      + `安装包将不可复现。请补齐漏掉的提交（常见成因：定义留在工作树未入库）；`
      + `确属临时包时加 --skip-head-check 并在发布说明里写明。`);
  }
}

// [4] server typecheck
log('server typecheck…');
run(NODE, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', path.join(ROOT, 'server', 'tsconfig.json')]);

// [5] server build
log('server build…');
run(NODE, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(ROOT, 'server', 'tsconfig.json')]);

// [6] web build
// T00749 补充：vite 清空 dist 产物目录的 rmSync 同样可能触发安全删除守卫——子进程统一带逃生开关
log('web build…');
run(NODE, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
  cwd: path.join(ROOT, 'web'),
  env: { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: '0' },
});

// [7] 版本递增 + ABI 切换 + electron-builder
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

// T02079：输出目录兜底 + 安全删除开关抽到 scripts/lib/abi-switch.mjs，与 scripts/dist.js 共用
const { resolveOutputDir, buildChildEnv } = await import('./lib/abi-switch.mjs');
const outDir = resolveOutputDir(ROOT, { fail, log: (m) => console.log(m) });

// 子进程环境变量：安全删除开关 + Electron/electron-builder 镜像
const childEnv = buildChildEnv();
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
