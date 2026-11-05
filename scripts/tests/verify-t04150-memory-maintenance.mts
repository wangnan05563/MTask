// T04150 门脚本：容量淘汰 + 月度整理幂等 + 30 天节流（PRD MEM-306 / MEM-307，F9）。
// 运行：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t04150-memory-maintenance.mts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'mtask-t04150-gate-'));
process.env.MTask_DATA_DIR = DIR;
const { initSchema } = await import('../../server/src/db/schema');
const { getDb, closeDb } = await import('../../server/src/db/connection');
const M = await import('../../server/src/services/MemoryMaintenanceService');
const { queryMemories } = await import('../../server/src/services/MemoryService');

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};

initSchema();
const db = getDb();
const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * 86400000).toISOString();
const activeCount = (pk: string) =>
  (db.prepare('SELECT COUNT(*) AS c FROM memories WHERE product_key = ? AND invalidated_at IS NULL')
    .get(pk) as { c: number }).c;

const ins = db.prepare(`INSERT INTO memories
  (id,product_key,project_id,type,title,content,tags,source_task_id,source_kind,confidence,
   access_count,last_accessed_at,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const add = (o: {
  id: string; pk?: string; type?: string; title?: string; access?: number;
  updatedAt?: string; sourceTask?: string | null; projectId?: string | null;
}) => ins.run(
  o.id, o.pk ?? 'cap', o.projectId ?? null, o.type ?? 'project',
  o.title ?? `标题-${o.id}`, `内容-${o.id}`, null, o.sourceTask ?? null, 'auto', 0.9,
  o.access ?? 0, null, o.updatedAt ?? now.toISOString(), o.updatedAt ?? now.toISOString(),
);

// ---- MEM-306：容量上限 200，按 access_count 最低/最旧淘汰 ----
for (let i = 0; i < 205; i++) add({ id: `c-${i}`, access: i });
const removed = M.enforceCapacity('cap');
check('超限淘汰条数 = 总量-上限', removed === 5, String(removed));
check('有效行恰好 200', activeCount('cap') === M.MEMORY_CAPACITY_LIMIT, String(activeCount('cap')));
const invalidatedIds = (db.prepare('SELECT id FROM memories WHERE invalidated_at IS NOT NULL ORDER BY id')
  .all() as { id: string }[]).map((r) => r.id);
check('淘汰的是 access_count 最低的 5 条',
  ['c-0', 'c-1', 'c-2', 'c-3', 'c-4'].every((id) => invalidatedIds.includes(id)), invalidatedIds.join(','));
check('淘汰走软失效并留审计原因', invalidatedIds.length === 5 && (db.prepare(
  "SELECT COUNT(*) AS c FROM memories WHERE superseded_by = 'capacity-overflow'").get() as { c: number }).c === 5);
check('重复执行幂等', M.enforceCapacity('cap') === 0);

// ---- 查询触发容量评估（F9）----
for (let i = 0; i < 204; i++) add({ id: `q-${i}`, pk: 'q', access: i });
queryMemories({ kind: 'ok', productKey: 'q' }, { limit: 1 });
check('查询触发后有效行回落到 200', activeCount('q') === M.MEMORY_CAPACITY_LIMIT, String(activeCount('q')));

// ---- MEM-307：月度整理 ----
db.prepare('DELETE FROM memories').run();
db.prepare(`INSERT INTO projects (id,name,description,product_key,memory_auto_extract,archived,history_at,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?)`).run('p-org', '整理测试项目', '', 'org', 1, 0, null, now.toISOString(), now.toISOString());
db.prepare("INSERT INTO tasks (id,title,project_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?)")
  .run('t-done', '已完结任务', 'p-org', 'done', now.toISOString(), now.toISOString());
// 近重复：同产品同 type 同标题
add({ id: 'dup-keep', pk: 'org', title: '重复标题', access: 5 });
add({ id: 'dup-lose', pk: 'org', title: '重复标题', access: 0 });
// 无人遵守：从未召回且超 180 天
add({ id: 'stale', pk: 'org', title: '陈旧规则', access: 0, updatedAt: daysAgo(200) });
// 已完结任务导出且超 180 天
add({ id: 'arch', pk: 'org', title: '历史结论', access: 1, updatedAt: daysAgo(200), sourceTask: 't-done' });
// 正常条目：不应被动
add({ id: 'normal', pk: 'org', title: '现行有效', access: 3 });

const r1 = M.organizeMemories();
check('近重复合并 1 条', r1.deduped === 1, JSON.stringify(r1));
check('重复项指向保留项', (db.prepare("SELECT superseded_by FROM memories WHERE id='dup-lose'")
  .get() as { superseded_by: string }).superseded_by === 'dup-keep');
check('重复项保留访问最多的那条', (db.prepare("SELECT invalidated_at FROM memories WHERE id='dup-keep'")
  .get() as { invalidated_at: string | null }).invalidated_at === null);
check('无人遵守规则被软失效', r1.stale >= 1 && (db.prepare("SELECT invalidated_at FROM memories WHERE id='stale'")
  .get() as { invalidated_at: string | null }).invalidated_at !== null);
check('已完结任务历史结论被软失效', r1.archived === 1 && (db.prepare("SELECT invalidated_at FROM memories WHERE id='arch'")
  .get() as { invalidated_at: string | null }).invalidated_at !== null);
check('正常条目不受影响', (db.prepare("SELECT invalidated_at FROM memories WHERE id='normal'")
  .get() as { invalidated_at: string | null }).invalidated_at === null);
const r2 = M.organizeMemories();
check('整理可重复执行（第二轮全 0）', r2.deduped === 0 && r2.stale === 0 && r2.archived === 0, JSON.stringify(r2));

// ---- 30 天节流（调度入口）----
const first = M.maybeOrganizeMemories();
check('首次到期执行整理', first.ran === true, JSON.stringify(first));
const second = M.maybeOrganizeMemories();
check('30 天内再次调用跳过', second.ran === false);
const later = new Date(now.getTime() + 31 * 86400000).toISOString();
const third = M.maybeOrganizeMemories(later);
check('超过 30 天后重新执行', third.ran === true, JSON.stringify(third));

try { closeDb(); rmSync(DIR, { recursive: true, force: true }); } catch { /* 清理失败不阻塞结论 */ }
console.log(`\n结果: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
