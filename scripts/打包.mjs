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
import {
  cachePath, describeHolders, restoreWorkspaceAbi, snapshotWorkspaceAbi, switchAbi,
  waitForWritable, workspaceNodePath,
} from './lib/abi-switch.mjs';
import versionBackup from './lib/version-backup.js';

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

// T03731：打包是个事务——版本号递增与 ABI 切换都要能整体撤销。
// 任一分支 exit（含 fail / 异常）都会走这里：先把工作区原生二进制还原，再把三份版本文件恢复原字节，
// 避免「版本 bumped 了、包没出来」把无意义的 +1 留在工作区里（还会和并发会话的 WIP 混在一起）。
let versionBumped = false;
let abiRestored = true;
let buildOk = false;
let abiSidecar = null;
let prevAbiSnapshot = null;
process.on('exit', () => {
  if (buildOk) return;
  if (!abiRestored) {
    try {
      restoreWorkspaceAbi(ROOT, prevAbiSnapshot, {
        fail: (m) => console.error(`[ERROR] ${m}`),
        log: (m) => console.log(m),
        sidecar: abiSidecar,
      });
    } catch (e) {
      console.error(`[ERROR] 中断后还原原生二进制失败：${e.message}（可执行 scripts/native-switch.bat dev）`);
    }
  }
  if (versionBumped) {
    const r = versionBackup.restoreVersionFiles(ROOT);
    if (r.restored) console.error(`[WARN] 本次没有产出安装包：版本号已回滚到 ${r.version ?? '(未知)'}，三份版本文件按字节恢复`);
  }
});

// T02692：本入口此前没接 abi-hint，日志里缺「build interpreter / ABI 现场」两行，
// 出现「装了包却不知道用哪个解释器打的」时就无从追溯（三枚 .bat 入口在第 53 行同一位置都打了）。
// 不占 [n/7] 编号：它是开跑前的现场快照，不是构建步骤；abi-hint 自带「永不非零退出」纪律。
console.log(`  [INFO] build interpreter: ${process.version} ABI ${process.versions.modules}   exe=${process.execPath}`);
run(NODE, [path.join(ROOT, 'scripts', 'lib', 'abi-hint.mjs')]);

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
// 运行时资产：server/src/skills 下的内置技能 Markdown 不被 tsc 拷贝（server 的 build 脚本另行 cp），
// 这里直接调 tsc 会绕过它，asar 内缺 skills → 打包版用例/PRD 生成读 SKILL.md 直接 ENOENT。
fs.rmSync(path.join(ROOT, 'server', 'dist', 'skills'), { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'server', 'src', 'skills'), path.join(ROOT, 'server', 'dist', 'skills'), { recursive: true });

// [6] web build
// T00749 补充：vite 清空 dist 产物目录的 rmSync 同样可能触发安全删除守卫——子进程统一带逃生开关
log('web build…');
run(NODE, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
  cwd: path.join(ROOT, 'web'),
  env: { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: '0' },
});

// [7] 版本递增 + ABI 切换 + electron-builder
// T03731：预检（缓存齐全 + 工作区二进制可写）放在**递增版本号之前**。旧 .bat 把锁判定排在 bump 之后，
// 一锁定就退出，版本号已 +1 却没有产物（旧脚本那句 "version was bumped already but no artifact was
// produced this run" 就是这个副作用的残留）。这里先验后 bump，并给失败分支挂回滚。
log('原生依赖预检（递增版本号之前）…');
for (const mode of ['dev', 'electron']) {
  if (!fs.existsSync(cachePath(ROOT, mode))) fail(`ABI 缓存缺失：${cachePath(ROOT, mode)}（可用 scripts/native-switch.bat dev 重建）`);
}
const deployedNative = workspaceNodePath(ROOT);
if (fs.existsSync(deployedNative)) {
  const w = waitForWritable(deployedNative);
  if (!w.writable) {
    const holders = describeHolders(ROOT);
    console.warn(`[WARN] 工作区 better_sqlite3.node 暂不可写（${w.code}），切换阶段将用改名旁路接管；`
      + '若下方有 dev server / 桌面壳，建议先停掉，避免打包窗口期内它重启加载到 Electron ABI。');
    if (holders.length) console.warn(`  可能的占用进程：\n   - ${holders.join('\n   - ')}`);
  }
}

log('版本号递增…');
run(NODE, [path.join(ROOT, 'scripts', 'bump-version.js')]);
versionBumped = true;
const appVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// T02069：ABI 切换抽到 scripts/lib/abi-switch.mjs，与 scripts/dist.js 共用同一实现
// （缓存缺失 fail-fast、打包前记录工作区二进制、打包后按字节原样还原）。
const abiOpts = { fail, log: (m) => console.log(m) };
log('切换 Electron ABI 并打包…');
// 打包前记录工作区当前的原生二进制，打包后原样还原（见下方恢复段）。
const prevAbi = snapshotWorkspaceAbi(ROOT);
prevAbiSnapshot = prevAbi;
const switched = switchAbi(ROOT, 'electron', abiOpts);
abiSidecar = switched.sidecar;
abiRestored = false;

// T02079：输出目录兜底 + 安全删除开关抽到 scripts/lib/abi-switch.mjs，与 scripts/dist.js 共用
const { resolveOutputDir, buildChildEnv } = await import('./lib/abi-switch.mjs');
const outDir = resolveOutputDir(ROOT, { fail, log: (m) => console.log(m) });

// 子进程环境变量：安全删除开关 + Electron/electron-builder 镜像
const childEnv = buildChildEnv();
run(NODE, [path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
  '--win', `-c.buildVersion=${appVer}`, `--config.directories.output=${outDir}`, '--publish=never'], { env: childEnv });

// 恢复打包前的 ABI：build/native/dev 是针对旧 Node 运行时缓存的，本地 Node 升级后直接覆盖会让
// server/dist 直跑报 ERR_DLOPEN_FAILED（实测 Node24/ABI137 环境 require 失败），故按字节原样还原。
restoreWorkspaceAbi(ROOT, prevAbi, { ...abiOpts, sidecar: abiSidecar });
abiRestored = true;

// 清理 win-unpacked（非致命）
try {
  fs.rmSync(path.join(ROOT, outDir, 'win-unpacked'), { recursive: true, force: true });
  console.log('[OK] 已清理 win-unpacked');
} catch {
  console.warn(`[WARN] 未能删除 ${outDir}\\win-unpacked（被进程占用），下次打包前请手动清理。`);
}

// 安装包已产出、ABI 已还原：这次递增定稿，丢弃回滚备份（否则下次失败会还原成更旧的版本）
versionBackup.discardVersionBackup(ROOT);
buildOk = true;

console.log('\n============================================');
console.log(' Build done');
console.log(` server: server\\dist\n web:    web\\dist\n exe:    ${outDir}\\\n version: ${appVer}`);
console.log('============================================');
