/**
 * T01064 后续（事件表保留期清理）冒烟脚本。
 *
 * 用独立数据目录（MTask_DATA_DIR）建空库，写入「新/旧」两类事件后按保留期清理，
 * 断言：90 天保留期只删旧行；保留期置 0 时一行不删。
 *
 * 运行：npx tsx server/scripts/verify-event-retention.ts
 */
process.env.MTask_DATA_DIR = process.env.MTask_DATA_DIR ?? require('node:os').tmpdir() + '/mtask-event-retention-smoke';

import { getDb } from '../src/db/connection';
import { initSchema } from '../src/db/schema';
import { pruneTaskEvents, readEventRetentionDays, setEventRetentionDays, countEvents } from '../src/services/EventRetention';

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
}

initSchema();
const db = getDb();
db.prepare('DELETE FROM task_events').run();

const iso = (daysAgo: number): string => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
const ins = db.prepare('INSERT INTO task_events (id, task_id, task_no, project_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
ins.run('e-new', 't-1', 'T00001', 'p-1', 'status', '新事件', iso(1));
ins.run('e-old', 't-1', 'T00001', 'p-1', 'status', '过期事件', iso(120));
ins.run('e-mid', 't-1', 'T00001', 'p-1', 'result', '边界内事件', iso(30));

console.log('[1] 默认保留期为 90 天');
assert(readEventRetentionDays() === 90, `默认保留期 = 90（实际 ${readEventRetentionDays()}）`);

console.log('[2] 90 天保留期清理：只删 120 天前的旧行');
const deleted = pruneTaskEvents(Date.now(), true);
assert(deleted === 1, `删除 1 行（实际 ${deleted}）`);
assert(countEvents() === 2, `剩余 2 行（实际 ${countEvents()}）`);
assert(db.prepare('SELECT 1 FROM task_events WHERE id = ?').get('e-old') === undefined, '过期行 e-old 已删除');
assert(db.prepare('SELECT 1 FROM task_events WHERE id = ?').get('e-new') !== undefined, '新行 e-new 保留');

console.log('[3] 节流：非 force 调用不再重复清理');
assert(pruneTaskEvents(Date.now(), false) === 0, '节流生效（返回 0）');

console.log('[4] 保留期置 0 = 不清理');
setEventRetentionDays(0);
ins.run('e-old2', 't-1', 'T00001', 'p-1', 'status', '更早事件', iso(1000));
assert(pruneTaskEvents(Date.now(), true) === 0, '保留期 0 时不删除任何行');

console.log('[5] 保留期写入校验');
setEventRetentionDays(30);
assert(readEventRetentionDays() === 30, `保留期改为 30（实际 ${readEventRetentionDays()}）`);
let threw = false;
try {
  setEventRetentionDays(-1);
} catch {
  threw = true;
}
assert(threw, '负数保留期被拒绝');

console.log(failed === 0 ? '\nSMOKE OK: 全部断言通过' : `\nSMOKE FAILED: ${failed} 条断言未通过`);
process.exit(failed === 0 ? 0 : 1);
