/**
 * T01061 后续（备份失败告警进通知中心）冒烟脚本。
 *
 * 断言：
 * - 系统告警写入 task_events（kind=system、哨兵 task_id）；
 * - 同文案 6h 内重复写入被抑制（避免磁盘满时每小时刷一条）；
 * - 真实备份失败路径（备份目录被同名文件占位 → mkdir 失败）确实产生一条告警。
 *
 * 运行：npx tsx server/scripts/verify-backup-alert.ts
 */
process.env.MTask_DATA_DIR = process.env.MTask_DATA_DIR ?? require('node:os').tmpdir() + '/mtask-backup-alert-smoke';

import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../src/db/connection';
import { initSchema } from '../src/db/schema';
import { logSystemEvent, SYSTEM_TASK_ID, SYSTEM_EVENT_KIND } from '../src/services/SystemEvent';
import { runBackup, backupDir } from '../src/services/BackupService';

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
}

async function main(): Promise<void> {
  initSchema();
  const db = getDb();
  db.prepare('DELETE FROM task_events').run();

  console.log('[1] 系统告警写入与静默窗口');
  assert(logSystemEvent('测试告警A') === true, '首次写入成功');
  const rows = () => db.prepare('SELECT * FROM task_events WHERE task_id = ? AND kind = ? ORDER BY created_at DESC').all(SYSTEM_TASK_ID, SYSTEM_EVENT_KIND) as Array<{ detail: string; created_at: string; task_no: string | null }>;
  assert(rows().length === 1, `库中 1 条系统告警（实际 ${rows().length}）`);
  assert(rows()[0].task_no === null, 'task_no 为 null（不关联任务，前端不跳转）');
  assert(logSystemEvent('测试告警A') === false, '同文案重复写入被抑制');
  assert(rows().length === 1, '抑制后未新增行');
  assert(logSystemEvent('测试告警B') === true, '不同文案照常写入');
  assert(rows().length === 2, `共 2 条（实际 ${rows().length}）`);

  console.log('[2] 备份失败 → 告警（备份目录被同名文件占位）');
  const dir = backupDir();
  // 先确保目录不存在，再用同名**文件**占位，使 mkdirSync 抛 EEXIST
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.writeFileSync(dir, '占位');
  let backupThrew = false;
  try {
    await runBackup('auto');
  } catch {
    backupThrew = true;
  }
  assert(backupThrew, '备份确实失败（抛出）');
  const alerts = rows().filter((r) => r.detail.includes('数据备份失败'));
  assert(alerts.length === 1, `产生 1 条备份失败告警（实际 ${alerts.length}）`);
  assert(alerts[0]?.detail.includes('数据保护已降级') === true, '告警文案含可操作提示');

  console.log('[3] 恢复目录后备份成功（不应再新增告警）');
  fs.rmSync(dir, { force: true });
  const ok = await runBackup('manual');
  assert(!!ok.name, `备份成功：${ok.name}`);
  assert(rows().filter((r) => r.detail.includes('数据备份失败')).length === 1, '成功不再刷告警');

  console.log(failed === 0 ? '\nSMOKE OK: 全部断言通过' : `\nSMOKE FAILED: ${failed} 条断言未通过`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
