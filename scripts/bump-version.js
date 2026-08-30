/**
 * MTask 版本生成：每次打包前生成「当天日期 + 递增序号」写回根 package.json，
 * 并同步 electron/package.json 与 package-lock.json，保证每次构建产物版本唯一。
 *
 * 版本形如 <major>.<minor>.<MMDD>.<seq>，例如 0.1.0827.1：
 *  - MMDD 为当天月日（4 位数字，恒 <= 65535，落在 Windows 版本段合法范围内）；
 *  - seq 为该次构建的递增序号，取上次 seq + 1，保证即便跨天/跨年 MMDD 相同也唯一。
 *
 * 为什么不用 8 位日期(如 20260827)充当单个版本段：Windows 应用文件版本号的每一段
 * 取值 0–65535，8 位日期会溢出/读写错乱，因此把「日期」与「序号」拆成两个合法版本段。
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'package.json');
const electronPkg = path.resolve(__dirname, '..', 'electron', 'package.json');

function readVer(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8')).version || '0.0.0';
}
function setVer(p, v) {
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  j.version = v;
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
}

const cur = readVer(root);
const parts = String(cur).split('.').map(Number);
if (parts.length < 2 || parts.some(Number.isNaN)) {
  console.error('[bump-version] 当前版本格式异常，请手动修正: ' + cur);
  process.exit(1);
}
const now = new Date();
// 月日恒为 4 位且 <= 1231，满足 Windows 版本段 0–65535 的限制
const mmdd = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
// 序号沿用上次值 +1，保证多个版本段都为同一日期时版本号仍唯一
const seq = (parts.length >= 4 ? parts[3] : 0) + 1;
const next = `${parts[0]}.${parts[1]}.${mmdd}.${seq}`;
setVer(root, next);
setVer(electronPkg, next);

// 同步 package-lock.json：顶层 version 必须跟根一致；workspace 入口则按各自 package.json
// 的「真实版本」逐一对齐，不能把 server/web 也强制改成根版本——否则会与其自身 package.json
// 不一致，导致下次 npm install 因版本漂移重写锁文件、产生与本次改动无关的噪音。
const lockP = path.resolve(__dirname, '..', 'package-lock.json');
const lock = JSON.parse(fs.readFileSync(lockP, 'utf8'));
lock.version = next;
if (lock.packages['']) lock.packages[''].version = next; // 根入口即根版本（已 setVer）
if (lock.packages['electron']) lock.packages['electron'].version = next; // electron 已 setVer
for (const w of ['server', 'web']) { // 未改版本的 workspace 按其真实 package.json 版本对齐
  if (!lock.packages[w]) continue;
  const wp = path.resolve(__dirname, '..', w, 'package.json');
  lock.packages[w].version = JSON.parse(fs.readFileSync(wp, 'utf8')).version;
}
fs.writeFileSync(lockP, JSON.stringify(lock, null, 2) + '\n');

console.log('[bump-version] ' + cur + ' -> ' + next + '  (' + now.toLocaleDateString() + ')');