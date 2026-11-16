/**
 * T05791 门：自动备份列表删除功能。
 *
 * 运行时验证（真实 fs，isolated MTask_DATA_DIR）：
 *  - deleteBackup 白名单挡路径穿越 / 非法文件名（400）
 *  - 不存在的备份 → 404
 *  - 合法备份 → 物理文件移除、返回大小、列表同步、lastRun 一致性
 * 另含源码静态断言：路由 DELETE 端点 + 审计日志 + 前端二次确认/删除按钮/api.del。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t05791-backup-delete.mts
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.MTASK_GATE_ROOT
  ? resolve(process.env.MTASK_GATE_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// 隔离数据目录：BackupService 从 MTask_DATA_DIR 解析 dbFilePath → backupDir
const DATA_DIR = mkdtempSync(join(tmpdir(), 'mtask-t05791-'));
process.env.MTask_DATA_DIR = DATA_DIR;
const BACKUP_DIR = join(DATA_DIR, 'backups');
mkdirSync(BACKUP_DIR, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra)}`}`);
};

const SVC = readFileSync(join(ROOT, 'server/src/services/BackupService.ts'), 'utf8');
const ROUTE = readFileSync(join(ROOT, 'server/src/routes/index.ts'), 'utf8');
const TAB = readFileSync(join(ROOT, 'web/src/pages/DbAdminTab.tsx'), 'utf8');

// ---- 运行时：动态 import（确保上方 env 已设置） ----
const svc = await import(pathToFileURL(join(ROOT, 'server/src/services/BackupService.ts')).href);

// 造 3 份合法备份 + 1 份非白名单文件
const goodA = 'mtask-backup-20261116-010101.db';
const goodB = 'mtask-backup-20261116-020202.db';
writeFileSync(join(BACKUP_DIR, goodA), 'a'.repeat(1024));
writeFileSync(join(BACKUP_DIR, goodB), 'b'.repeat(2048));
writeFileSync(join(BACKUP_DIR, 'notes.txt'), 'should not be deletable');

ok('R-01 listBackups 只读白名单备份文件（忽略 notes.txt）',
  svc.listBackups().map((b: { name: string }) => b.name).sort().join(',') === [goodA, goodB].sort().join(','));

// 路径穿越 / 非法名：400
for (const bad of ['../mtask.db', 'notes.txt', 'mtask-backup-bad.db', '/etc/passwd', '']) {
  let status = 0;
  try { svc.deleteBackup(bad); } catch (e) { status = (e as { status?: number }).status ?? 0; }
  ok(`R-02 非法文件名被拒（400）: ${bad || '<空>'}`, status === 400);
}

// 不存在：404
let missingStatus = 0;
try { svc.deleteBackup('mtask-backup-20260101-000000.db'); } catch (e) { missingStatus = (e as { status?: number }).status ?? 0; }
ok('R-03 不存在的备份返回 404', missingStatus === 404);

// 合法删除：物理文件移除 + 返回大小 + 列表同步
const before = svc.listBackups().length;
const res = svc.deleteBackup(goodA);
ok('R-04 deleteBackup 返回被删文件名与正确大小', res.name === goodA && res.size === 1024, res);
ok('R-05 物理文件已移除', !existsSync(join(BACKUP_DIR, goodA)));
ok('R-06 列表同步减少一份', svc.listBackups().length === before - 1);
ok('R-07 非白名单 notes.txt 未被误删', existsSync(join(BACKUP_DIR, 'notes.txt')));

// lastRun 一致性：删除 lastRun 指向的文件后清空（用 runBackup 造 lastRun 需真实 db，改用两级断言源码口径）
ok('R-08 源码含 lastRun 一致性清理（删最近备份则清空）',
  /if \(lastRun\?\.file === name\) lastRun = null/.test(SVC));

// ---- 源码静态：路由 + 前端 ----
ok('S-01 路由注册 DELETE /backups/:name + BackupDeleteError 映射 HTTP 状态',
  /api\.delete\('\/backups\/:name'/.test(ROUTE)
  && /e instanceof BackupDeleteError \? e\.status : 500/.test(ROUTE)
  && /import \{[\s\S]{0,200}deleteBackup, BackupDeleteError/.test(ROUTE));
ok('S-02 删除审计日志走 logService（后台日志可见，操作人单机留空）',
  /logService\.log\('INFO', 'backup',[\s\S]{0,120}备份删除/.test(ROUTE));
ok('S-03 前端二次确认（confirmDanger → CONFIRM_DELETE）',
  /confirmDanger\(`确认删除备份快照/.test(TAB) && /const CONFIRM_TOKEN = 'CONFIRM_DELETE'/.test(TAB));
ok('S-04 前端每行删除按钮 + api.del + 成功后同步列表/状态',
  /onClick=\{\(\) => void deleteBackupFile\(b\.name\)\}/.test(TAB)
  && /api\.del<[\s\S]{0,200}>\(`\/backups\/\$\{encodeURIComponent\(name\)\}`\)/.test(TAB)
  && /setBackups\(d\.backups\)/.test(TAB));
ok('S-05 删除与恢复 busy 态隔离（del: 前缀）',
  /const busyKey = `del:\$\{name\}`/.test(TAB) && /bkBusy === `del:\$\{b\.name\}`/.test(TAB));

rmSync(DATA_DIR, { recursive: true, force: true });
console.log('');
console.log(`T05791 门：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
