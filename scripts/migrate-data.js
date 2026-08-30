// MTask 数据迁移：把开发库快照写入打包版 userData 数据目录。
// 必须以 Electron 自带 Node（ABI 130，与打包态原生模块匹配）运行（见 迁移数据.bat）。
// 说明：SQLite 库文件格式与运行 ABI 无关，因此开发库可直接作为打包版数据源。
// 流程：合并开发库 WAL -> 复制主文件到目标 -> 清理目标残留 WAL/SHM -> 校验。开发库只做 checkpoint 不丢数据。
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function fail(msg) {
  console.error('[ERROR] ' + msg);
  process.exit(1);
}

// 开发库位置：本文件在 scripts/，开发库固定在 server/src/data/mtask.db
const devDb = path.resolve(__dirname, '..', 'server', 'src', 'data', 'mtask.db');
if (!fs.existsSync(devDb)) fail('未找到开发库: ' + devDb);

// 打包版数据目录：%APPDATA%\mtask\data（main.js 设定 MTask_DATA_DIR 指向这里）
const pkgDir = process.env.APPDATA ? path.join(process.env.APPDATA, 'mtask', 'data') : '';
if (!pkgDir) fail('无法定位 APPDATA');
fs.mkdirSync(pkgDir, { recursive: true });

const targetDb = path.join(pkgDir, 'mtask.db');

// 覆盖前先备份目标旧库，避免误覆盖丢失（例如打包态里已手动录入的数据）
const bak = targetDb + '.bak-' + Date.now();
if (fs.existsSync(targetDb)) fs.copyFileSync(targetDb, bak);

// 合并开发库 WAL：把尚未并入主文件的已提交数据折回主文件，保证单文件完整一致
const src = new Database(devDb); // 读写打开才能 checkpoint
try {
  src.pragma('wal_checkpoint(TRUNCATE)');
} catch (e) {
  src.close();
  fail('合并开发库 WAL 失败: ' + e.message);
}
src.close();

// 复制开发主文件到目标（含 schema + 数据）
fs.copyFileSync(devDb, targetDb);

// 删除目标残留的 WAL/SHM，避免两套日志混淆（快照已全量并入主文件）
for (const ext of ['-wal', '-shm']) {
  const p = targetDb + ext;
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// 校验落库结果
const check = new Database(targetDb, { readonly: true });
const projects = check.prepare('SELECT COUNT(*) n FROM projects').get().n;
const tasks = check.prepare('SELECT COUNT(*) n FROM tasks').get().n;
const prompts = check.prepare('SELECT COUNT(*) n FROM prompts').get().n;
check.close();

console.log('迁移完成: 项目 ' + projects + ' 个, 任务 ' + tasks + ' 条, 提示词 ' + prompts + ' 条');
console.log('目标目录: ' + pkgDir);
if (fs.existsSync(bak)) console.log('原目标库已备份为: ' + bak);