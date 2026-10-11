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
 * 用法：node scripts/dist.js [electron-builder 附加参数...]（npm run dist / dist:dir 调用）
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

  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  if (!version) fail('无法读取 package.json version');

  // 打包前记录工作区当前的原生二进制（必须先取快照再切换，否则快照就是 Electron 那份、还原等于没做），
  // 缓存缺失在这里就 fail-fast，避免打到一半才炸。
  const prevAbi = snapshotWorkspaceAbi(ROOT);
  switchAbi(ROOT, 'electron', abiOpts);

  // 参数为本仓库固定字面量 + npm script 透传的已知 flag，无外部用户输入进入命令行
  const cmd = ['electron-builder', '--win', `-c.buildVersion=${version}`, ...process.argv.slice(2)].join(' ');
  console.log(`[dist] ${cmd}`);
  const child = spawn(cmd, { cwd: ROOT, shell: true, stdio: 'inherit' });

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
