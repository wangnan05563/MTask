/**
 * T03731：版本号递增的「可回滚事务」。
 *
 * 原流程先 bump 再探 ABI 锁，锁判定失败时直接退出——package.json / electron/package.json /
 * package-lock.json 三份已被改写，安装包却没有产出（旧脚本自己都留了
 * `[WARN] version was bumped already but no artifact was produced this run` 这行字）。
 * 在下一次构建前，这三份「凭空 +1」的改动就混进了工作区，和并发会话的 WIP 叠在一起，
 * 既污染 diff 又容易在手工回退时改错。
 *
 * 这里把三份文件在递增前按字节备份，构建失败/中断时整体还原；成功才丢弃备份。
 * CommonJS：bump-version.js 是 CJS，ESM 入口通过 default import 复用同一实现。
 */
const fs = require('node:fs');
const path = require('node:path');

const FILES = [
  ['package.json', 'root-package.json'],
  ['electron/package.json', 'electron-package.json'],
  ['package-lock.json', 'package-lock.json'],
];

function backupDir(root) {
  return path.join(root, 'node_modules', '.cache', 'mtask-pack', 'version-backup');
}

function backupVersionFiles(root) {
  const dir = backupDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const [rel, name] of FILES) {
    const src = path.join(root, rel);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(dir, name));
    saved.push(rel);
  }
  const prev = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ prev, at: new Date().toISOString(), saved }, null, 2));
  return { prev, saved };
}

/** @returns {{restored: boolean, version: string|null}} 无备份时 restored=false（幂等，不报错） */
function restoreVersionFiles(root) {
  const dir = backupDir(root);
  const metaPath = path.join(dir, 'meta.json');
  if (!fs.existsSync(metaPath)) return { restored: false, version: null };
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { meta = null; }
  for (const [rel, name] of FILES) {
    const bak = path.join(dir, name);
    if (!fs.existsSync(bak)) continue;
    fs.copyFileSync(bak, path.join(root, rel));
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { restored: true, version: meta?.prev ?? null };
}

function discardVersionBackup(root) {
  fs.rmSync(backupDir(root), { recursive: true, force: true });
}

module.exports = { backupVersionFiles, restoreVersionFiles, discardVersionBackup };
