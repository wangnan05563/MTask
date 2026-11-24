/**
 * T06314 5k 任务性能夹具：临时 SQLite，只写测试库。
 * 用法：node scripts/tests/fixture-t06314-5k.mjs
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(HERE), '..', '..');
const DATA = process.env.T06314_DATA || 'C:/Users/hspcadmin/AppData/Local/Temp/t06314-perf-data';
if (!DATA.includes('t06314')) throw new Error('T06314_DATA 必须包含 t06314，拒绝写生产库');
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
process.env.MTask_DATA_DIR = DATA;

const schema = await import(pathToFileURL(join(ROOT, 'server/dist/db/schema.js')).href);
schema.initSchema();
const { getDb } = await import(pathToFileURL(join(ROOT, 'server/dist/db/connection.js')).href);
const db = getDb();
const now = new Date().toISOString();
const projectId = 'p-t06314-perf';
db.prepare('DELETE FROM tasks WHERE project_id = ?').run(projectId);
db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
db.prepare('INSERT INTO projects (id, name, description, sort_weight, wip_limit, created_at, updated_at) VALUES (?, ?, ?, 0, 10, ?, ?)')
  .run(projectId, 'T06314 性能压测', '5k 任务性能基准', now, now);
const ins = db.prepare(`INSERT INTO tasks
  (id, task_no, project_id, title, description, priority, status, verified, archived, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, 'todo', 0, 0, ?, ?)`);
db.transaction(() => {
  for (let i = 1; i <= 5000; i += 1) {
    const n = String(i).padStart(4, '0');
    ins.run(`t06314-${n}`, `T06314-${n}`, projectId, `压测任务 ${n} 性能滚动基线`,
      `第 ${i} 条任务，用于 5k 列表/搜索性能验证。`, i % 10 === 0 ? 'high' : 'normal', now, now);
  }
})();
const count = db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE project_id = ?').get(projectId).c;
console.log(JSON.stringify({ dataDir: DATA, projectId, tasks: count }));
