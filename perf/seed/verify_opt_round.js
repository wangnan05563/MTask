/**
 * 优化轮次的服务层回归校验（P0-2/P0-3/P1-5/P1-7）。
 *
 * 覆盖：
 *  A. TaskService.list 在任务数 >999 时不抛错（原实现单条 IN (?,?,...,1500 个占位) 超出 SQLite 变量上限 → 500）
 *  B. 任务列表「计划联动」反查与图片批量查询在超大批量下结果正确
 *  C. TaskCategoryService 加缓存后增/改/删的读写一致性（不能读到脏数据）
 *  D. initSchema 后新索引确实存在（tasks.category_id / plan_tasks.linked_task_id）
 *  E. exportBundle(tables) 子集导出只含指定表；isExportTable 白名单
 *
 * 用法：node perf/seed/verify_opt_round.js
 */
const path = require('node:path');
const fs = require('node:fs');

const DIR = path.join(__dirname, '..', 'sandbox', 'verify-opt');
process.env.MTask_DATA_DIR = DIR;
fs.mkdirSync(DIR, { recursive: true });

const { initSchema } = require('../../server/dist/db/schema.js');
initSchema();
const { getDb } = require('../../server/dist/db/connection.js');
const { TaskService } = require('../../server/dist/services/TaskService.js');
const { TaskCategoryService } = require('../../server/dist/services/TaskCategoryService.js');
const { exportBundle, isExportTable } = require('../../server/dist/services/SettingsService.js');

let fail = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '✅' : '❌'} ${msg}`);
  if (!cond) fail += 1;
};

const PID = 'proj-opt';
const N = 1500; // > SQLite 变量上限 999，专门触发原缺陷

// ---------- 准备 ----------
const db = getDb();
db.prepare('DELETE FROM tasks WHERE project_id = ?').run(PID);
db.prepare('DELETE FROM projects WHERE id = ?').run(PID);
const t = new Date().toISOString();
db.prepare('INSERT INTO projects (id,name,description,sort_weight,created_at,updated_at) VALUES (?,?,?,?,?,?)')
  .run(PID, '优化校验项目', '', 0, t, t);

console.log(`=== 优化轮次服务层校验（任务数 ${N} > 999）===\n`);

// ---------- A/B：超大批量任务列表 ----------
const insTask = db.prepare(
  'INSERT INTO tasks (id, task_no, project_id, title, description, priority, status, verified, archived, pinned, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
);
db.transaction(() => {
  for (let i = 1; i <= N; i++) {
    insTask.run(`ot-${String(i).padStart(5, '0')}`, `TV${String(i).padStart(5, '0')}`, PID,
      `批量任务-${i}`, 'bulk', 'normal', i % 2 ? 'todo' : 'done', 0, 0, 0, t, t);
  }
})();
// 让前 3 条任务成为「计划联动」任务（覆盖反查分支）
db.prepare('DELETE FROM plan_tasks WHERE project_id = ?').run(PID);
const insPlan = db.prepare(
  `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days, progress, status, assignee, sort_order, linked_task_id, archived, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
);
for (let i = 1; i <= 3; i++) {
  insPlan.run(`op-${i}`, PID, `联动计划-${i}`, '', '2026-09-14', '2026-09-15', 2, 0, 'todo', '', i, `ot-${String(i).padStart(5, '0')}`, 0, t, t);
}

let list = null;
try {
  list = TaskService.list({ projectId: PID });
  ok(list.length === N, `A. list 返回 ${N} 条任务（实际 ${list.length}）——分批 IN 路径正常`);
} catch (e) {
  ok(false, `A. list 抛错：${e.message}`);
}

// A2：原实现形态的证据 —— 单条 IN 传全部 id 时的真实上限（实测 SQLite 3.53.2 = 32766，非 999）
{
  const big = 34000;
  const ph = Array(big).fill('?').join(',');
  let threw = '';
  try {
    db.prepare(`SELECT 1 FROM tasks WHERE id IN (${ph})`).all(...Array(big).fill('x'));
  } catch (e) {
    threw = e.message;
  }
  ok(/too many SQL variables/i.test(threw),
    `A2. 原「单条 IN 传全部 id」形态在 ${big} 个 id 下抛错（${threw || '未抛错'}）→ 分批修复必要性证据`);
}

if (list) {
  const linked = list.filter((x) => x.fromPlanTitle);
  ok(linked.length === 3, `B. 计划联动反查命中 ${linked.length}/3 条（分批 IN 结果正确）`);
  const withImages = list.every((x) => Array.isArray(x.images));
  ok(withImages, 'B. 每条任务均带 images 数组（图片分批查询正常）');
}

// ---------- C：分类缓存一致性 ----------
console.log('');
const cat0 = TaskCategoryService.list().length;
const created = TaskCategoryService.create('校验分类A');
const afterCreate = TaskCategoryService.list().some((c) => c.id === created.id);
ok(afterCreate, 'C. create 后 list 立即可见（缓存已失效）');

TaskCategoryService.rename(created.id, '校验分类A-改名');
const renamed = TaskCategoryService.list().find((c) => c.id === created.id);
ok(renamed && renamed.name === '校验分类A-改名', 'C. rename 后 list 反映新名称（未读到脏缓存）');

TaskCategoryService.remove(created.id);
const afterRemove = TaskCategoryService.list().some((c) => c.id === created.id);
ok(!afterRemove, 'C. remove 后 list 不再包含该分类');
ok(TaskCategoryService.list().length === cat0, `C. 增删改后分类总数回到初始值（${cat0}）`);

// ---------- D：索引存在性 ----------
console.log('');
const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
ok(idx.includes('idx_tasks_category'), 'D. idx_tasks_category 已建立（分类删除/筛选不再全表扫描）');
ok(idx.includes('idx_plan_tasks_linked'), 'D. idx_plan_tasks_linked 已建立（计划联动反查走索引）');

// ---------- E：导出子集与白名单 ----------
console.log('');
const sub = exportBundle(['app_settings']);
ok(Object.keys(sub.data).length === 1 && Array.isArray(sub.data.app_settings), 'E. exportBundle([\'app_settings\']) 仅含该表');
const full = exportBundle();
ok(Object.keys(full.data).length > 5, `E. 不带参数仍为全量（${Object.keys(full.data).length} 张表，行为不变）`);
ok(isExportTable('tasks') && !isExportTable('users'), 'E. isExportTable 白名单正确（tasks ✓ / users ✗）');

console.log(`\n结果：${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
