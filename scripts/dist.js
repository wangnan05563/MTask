/**
 * 打包入口薄包装：把 package.json 的 version 原样注入 electron-builder 的 buildVersion，
 * 使安装包名保留完整 4 段版本（0.1.1004.180）。
 *
 * 为什么不直接用默认 ${version} 命名：版本方案 <major>.<minor>.<MMDD>.<seq> 为 4 段（Windows
 * 文件版本段 ≤65535 的限制，见 bump-version.js 注释），不是合法 semver，electron-builder 的
 * normalizePackageData 会把它规范成 0.1.100-4.180 写进产物名（实测）。buildVersion 宏不经
 * semver 规范化，运行时从 package.json 注入即与当前版本恒等同步，无手工维护负担。
 *
 * 用法：node scripts/dist.js [electron-builder 附加参数...]（npm run dist / dist:dir 调用）
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
if (!version) {
  console.error('[dist] 无法读取 package.json version');
  process.exit(1);
}
// 参数为本仓库固定字面量 + npm script 透传的已知 flag，无外部用户输入进入命令行
const cmd = ['electron-builder', '--win', `-c.buildVersion=${version}`, ...process.argv.slice(2)].join(' ');
console.log(`[dist] ${cmd}`);
const child = spawn(cmd, { cwd: ROOT, shell: true, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
