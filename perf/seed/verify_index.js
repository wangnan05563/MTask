// 验证 P2 复合索引：initSchema 建索引 + PRAGMA + EXPLAIN QUERY PLAN
process.env.MTask_DATA_DIR = 'D:/code/otherProjects/26_MTask/perf/sandbox/data';
const { initSchema } = require('../../server/dist/db/schema.js');
const D = require('better-sqlite3');
initSchema(); // CREATE INDEX IF NOT EXISTS 会补齐新复合索引
const db = new D(process.env.MTask_DATA_DIR + '/mtask.db');

for (const t of ['tasks', 'queue_jobs', 'prompts']) {
  const idx = db.prepare(`PRAGMA index_list('${t}')`).all();
  console.log(`${t}: ${idx.map((i) => i.name).join(', ')}`);
}

console.log('\n--- EXPLAIN tasks (projectId+archived, 项目活跃列表) ---');
console.log(db.prepare("EXPLAIN QUERY PLAN SELECT * FROM tasks WHERE project_id=? AND archived=0 ORDER BY pinned DESC, created_at DESC LIMIT 100")
  .all('proj-main').map((r) => r.detail).join('\n'));
console.log('\n--- EXPLAIN tasks (archived+created, 全库列表) ---');
console.log(db.prepare("EXPLAIN QUERY PLAN SELECT * FROM tasks WHERE archived=0 ORDER BY created_at DESC LIMIT 100")
  .all().map((r) => r.detail).join('\n'));
console.log('\n--- EXPLAIN queue_jobs (queue_id+status) ---');
console.log(db.prepare("EXPLAIN QUERY PLAN SELECT * FROM queue_jobs WHERE queue_id=? AND status IN ('failed','timeout')")
  .all('queue-perf').map((r) => r.detail).join('\n'));

db.close();
