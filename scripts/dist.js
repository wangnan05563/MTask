/**
 * 打包入口薄包装：把 package.json 的 version 原样注入 electron-builder 的 buildVersion，
 * 使安装包名保留完整 4 段版本（0.1.1004.180）。
 *
 * 为什么不直接用默认 ${version} 命名：版本方案 <major>.<minor>.<MMDD>.<seq> 为 4 段（Windows
 * 文件版本段 ≤65535 的限制，见 bump-version.js 注释），不是合法 semver，electron-builder 的
 * normalizePackageData 会把它规范成 0.1.100-4.180 写进产物名（实测）。buildVersion 宏不经
 * semver 规范化，运行时从 package.json 注入即与当前版本恒等同步，无手工维护负担。
 *
 * T02069 补 ABI 守卫：package.json 的 build.npmRebuild = false，electron-builder 不重编译原生
 * 模块，包内 better_sqlite3.node 就是打包时工作区那一份。本脚本原来只做版本名注入，用工作区的
 * dev ABI（Node22/127）出 Electron 包（需 130）→ 装机后端起不来、装机即废（0.1.1011.193 实测）。
 * 现在与 scripts/打包.mjs 共用 scripts/lib/abi-switch.mjs：打包前切 Electron ABI 缓存、打包后
 * 按字节还原工作区版本（还原是本地 node 直跑 server/dist 的前提）；缓存缺失直接拒绝打包。
 *
 * 用法：node scripts/dist.js [--skip-head-check] [electron-builder 附加参数...]（npm run dist / dist:dir 调用）
 *
 * T02355 补 HEAD 自洽性预检：与 scripts/打包.mjs 第 [3] 步共用 scripts/lib/head-precheck.mjs，
 * 红 HEAD 在切 ABI 之前就中止（`MTASK_SKIP_HEAD_CHECK=1` 等价于 `--skip-head-check`）。
 * T02617 提交纪律：提交这几条发布入口**必须带明确路径**（`git commit -- scripts/dist.js …`）——
 * 本仓索引里常躺着并发会话 staged 的旧版入口，一次不带路径的提交就能把守卫调用行静默抹掉。
 * 预检入口现在先自检「工作树 / HEAD / 索引 三条面都还调用守卫」，任一面丢引用即在构建/切 ABI 之前拦下。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

(async () => {
  const { switchAbi, snapshotWorkspaceAbi, restoreWorkspaceAbi } = await import('./lib/abi-switch.mjs');
  const fail = (msg) => {
    console.error(`[ERROR] ${msg}`);
    process.exit(1);
  };
  const abiOpts = { fail };

  // T02355：HEAD 自洽性预检——本入口原先只注入版本名 + 切 ABI，是发布链路上的第二条旁路。
  // 必须落在 ABI 切换**之前**：拦下时工作区原生二进制还没被覆写，不需要走还原分支。
  const { runHeadPrecheck, isRequestedSkip, shortHead } = await import('./lib/head-precheck.mjs');
  const SKIP_HEAD_CHECK = isRequestedSkip();
  const headSha = shortHead();
  console.log(`[dist] HEAD 自洽性预检（commit ${headSha || '未知'}）…`);
  const headCheck = runHeadPrecheck({ skip: SKIP_HEAD_CHECK, sha: headSha, tag: '[dist]' });
  if (!headCheck.skipped && headCheck.status !== 0) {
    fail(`HEAD 自洽性预检未通过（commit ${headSha || '未知'}）：该提交单独 checkout 编译不过，`
      + '安装包将不可复现。请补齐漏掉的提交（常见成因：定义留在工作树未入库）；'
      + '确属临时包时加 --skip-head-check 并在发布说明里写明。');
  }
  // --skip-head-check 是本脚本自己的开关，不能透传给 electron-builder
  const builderArgs = process.argv.slice(2).filter((a) => a !== '--skip-head-check');

  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  if (!version) fail('无法读取 package.json version');

  // 打包前记录工作区当前的原生二进制（必须先取快照再切换，否则快照就是 Electron 那份、还原等于没做），
  // 缓存缺失在这里就 fail-fast，避免打到一半才炸。
  const prevAbi = snapshotWorkspaceAbi(ROOT);
  switchAbi(ROOT, 'electron', abiOpts);

  // T02079：输出目录兜底 + 安全删除开关，与 scripts/打包.mjs 共用同一实现
  const { resolveOutputDir, buildChildEnv } = await import('./lib/abi-switch.mjs');
  
  // 检查用户是否显式传了 --config.directories.output=…（npm script 透传参数优先）
  const explicitOutDir = process.argv.slice(2).find((a) => a.startsWith('--config.directories.output='));
  let outDir;
  if (explicitOutDir) {
    outDir = explicitOutDir.split('=')[1];
    console.log(`[dist] 使用显式输出目录: ${outDir}`);
  } else {
    outDir = resolveOutputDir(ROOT, abiOpts);
  }

  // 参数为本仓库固定字面量 + npm script 透传的已知 flag，无外部用户输入进入命令行
  const cmd = ['electron-builder', '--win', `-c.buildVersion=${version}`, `--config.directories.output=${outDir}`, ...builderArgs].join(' ');
  console.log(`[dist] ${cmd}`);
  const child = spawn(cmd, { cwd: ROOT, shell: true, stdio: 'inherit', env: buildChildEnv() });

  // 成功、失败、被子进程异常终止都要还原 ABI（否则本地 node 直跑 server/dist 会 ERR_DLOPEN_FAILED）
  child.on('exit', (code) => {
    restoreWorkspaceAbi(ROOT, prevAbi, abiOpts);
    process.exit(code ?? 1);
  });
  child.on('error', (err) => {
    restoreWorkspaceAbi(ROOT, prevAbi, abiOpts);
    fail(`electron-builder 启动失败：${err.message}`);
  });
})();
