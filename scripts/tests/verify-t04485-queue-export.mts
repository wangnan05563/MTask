// T04485 门脚本：memory_review_queue 纳入导出/导入三张顺序表 + 旧备份兼容（PRD MEM-104 三通道语义）。
// 运行：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t04485-queue-export.mts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'mtask-t04485-gate-'));
process.env.MTask_DATA_DIR = DIR;
const { initSchema } = await import('../../server/src/db/schema');
const { getDb, closeDb } = await import('../../server/src/db/connection');
const { exportBundle, importBundle } = await import('../../server/src/services/SettingsService');

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};

initSchema();
const db = getDb();
const now = new Date().toISOString();
// 构造一条待确认候选 + 一条评审记录，验证两表都随包往返
db.prepare(`INSERT INTO memory_review_queue (id,product_key,project_id,title,content,type,source_kind,created_at)
  VALUES (?,?,?,?,?,?,?,?)`).run('q-1', 'wiki', null, '待确认候选', '电话 13800138000', 'project', 'auto', now);
db.prepare(`INSERT INTO memory_review_log (id,batch_id,memory_id,verdict,hit_rule,reviewer,created_at)
  VALUES (?,?,?,?,?,?,?)`).run('rv-1', 'b-1', 'm-1', 'not_worth', 'Q3', 'alice', now);

const bundle = await exportBundle();
check('导出包含 memory_review_queue', Array.isArray(bundle.data.memory_review_queue) && (bundle.data.memory_review_queue as unknown[]).length === 1,
  String((bundle.data.memory_review_queue as unknown[])?.length));
check('导出包含 memory_review_log', Array.isArray(bundle.data.memory_review_log) && (bundle.data.memory_review_log as unknown[]).length === 1);

// overwrite 精确恢复：先清空库，再按包恢复，行数必须一致（不多不少）
db.prepare('DELETE FROM memory_review_queue').run();
db.prepare('DELETE FROM memory_review_log').run();
const r = importBundle(bundle, 'overwrite');
check('overwrite 导入不抛错', !!r);
check('overwrite 后队列行数精确恢复', (db.prepare('SELECT COUNT(*) AS c FROM memory_review_queue').get() as { c: number }).c === 1);
check('overwrite 后评审记录精确恢复', (db.prepare('SELECT COUNT(*) AS c FROM memory_review_log').get() as { c: number }).c === 1);

// 旧备份兼容：不带两张新表 key 的包仍可导入（CORE_TABLES 不含这两表）
const legacy = { ...bundle, data: { ...bundle.data } } as typeof bundle;
delete (legacy.data as Record<string, unknown>).memory_review_queue;
delete (legacy.data as Record<string, unknown>).memory_review_log;
const lr = importBundle(legacy, 'keep');
check('旧备份（无两表 key）仍可导入', !!lr);

try { closeDb(); rmSync(DIR, { recursive: true, force: true }); } catch { /* 清理失败不阻塞结论 */ }
console.log(`\n结果: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exitCode = 1;
