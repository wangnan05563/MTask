import express from 'express';
import { getDb } from '../db/connection';
import { notifyChange } from '../services/ChangeBus';
import { cacheClear } from '../util/ttl-cache';

function now(): string {
  return new Date().toISOString();
}

/**
 * 历史资产（T00589 二轮：**项目级快照**）——组织过程资产沉淀，与「归档」（软删除）语义独立。
 *
 * 状态流转（以**项目**为粒度）：
 *   活跃项目 --沉淀--> 历史快照（projects.history_at 非空）——该项目不再出现在任务/计划菜单的项目列表
 *   历史快照 --恢复--> 活跃项目（清 history_at）
 *   历史快照 --归档删除--> archived（项目 archived=1；其任务/计划全部转归档区，软删除可恢复）
 *
 * 命名约束：新建项目名不得与历史快照中的项目名重复（POST /projects 已校验）。
 */
export const historyApi = express.Router();

/** 统计：可沉淀项目数 / 历史快照数 / 快照内任务与计划总量 */
historyApi.get('/summary', (_req, res) => {
  const db = getDb();
  const active = (db.prepare("SELECT COUNT(*) AS c FROM projects WHERE COALESCE(history_at,'') = '' AND COALESCE(archived,0) = 0").get() as { c: number }).c;
  const snaps = (db.prepare("SELECT COUNT(*) AS c FROM projects WHERE COALESCE(history_at,'') != ''").get() as { c: number }).c;
  const snapTasks = (db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE COALESCE(history_at,'') != '')").get() as { c: number }).c;
  const snapPlans = (db.prepare("SELECT COUNT(*) AS c FROM plan_tasks WHERE project_id IN (SELECT id FROM projects WHERE COALESCE(history_at,'') != '')").get() as { c: number }).c;
  const span = db.prepare("SELECT MIN(history_at) AS first, MAX(history_at) AS last FROM projects WHERE COALESCE(history_at,'') != ''").get() as { first: string | null; last: string | null };
  res.json({
    activeProjects: active,
    snapshotProjects: snaps,
    snapshotTasks: snapTasks,
    snapshotPlans: snapPlans,
    firstHistoryAt: span?.first ?? null,
    lastHistoryAt: span?.last ?? null,
  });
});

/** 历史快照列表：每个快照项目 + 其全部任务与计划（供项目级查看视图）+ 汇总统计
 *
 *  T00788：原实现为 N+1——对每个快照项目各执行 2 次全列查询（tasks + plans）。
 *  改为一次取全部快照项目 → 各一条 IN 查询取回相关任务/计划 → 内存按 project_id 分组。
 *  查询数由 1+2N 降为 3（与快照数无关），快照量增长后不再线性劣化。
 *  注：任务/计划的 description 与 handle_result 为前端 tooltip 实际消费字段（HistoryPage
 *  第 237/250 行），不可省略；本优化针对查询次数而非列裁剪。 */
historyApi.get('/list', (_req, res) => {
  const db = getDb();
  const projects = db.prepare("SELECT id, name, description, history_at FROM projects WHERE COALESCE(history_at,'') != '' ORDER BY history_at DESC").all() as Array<{ id: string; name: string; description: string; history_at: string }>;
  if (projects.length === 0) return res.json({ snapshots: [] });

  // 占位符按项目数动态生成；IN 查询一次取回全部快照的任务/计划
  const ids = projects.map((p) => p.id);
  const ph = ids.map(() => '?').join(',');
  const allTasks = db
    .prepare(`SELECT id, project_id, task_no, title, description, status, verified, priority, category_id, handle_result, created_at FROM tasks WHERE project_id IN (${ph}) ORDER BY task_no`)
    .all(...ids) as Array<Record<string, unknown> & { project_id: string }>;
  const allPlans = db
    .prepare(`SELECT id, project_id, title, description, kind, status, progress, start_date, end_date, duration_days FROM plan_tasks WHERE project_id IN (${ph}) ORDER BY sort_order`)
    .all(...ids) as Array<Record<string, unknown> & { project_id: string }>;

  // 内存分组：每组保持查询的 ORDER BY 顺序（任务按 task_no，计划按 sort_order）
  const tasksByProject = new Map<string, Array<Record<string, unknown>>>();
  for (const t of allTasks) {
    const { project_id, ...rest } = t;
    const bucket = tasksByProject.get(project_id);
    if (bucket) bucket.push(rest);
    else tasksByProject.set(project_id, [rest]);
  }
  const plansByProject = new Map<string, Array<Record<string, unknown>>>();
  for (const p of allPlans) {
    const { project_id, ...rest } = p;
    const bucket = plansByProject.get(project_id);
    if (bucket) bucket.push(rest);
    else plansByProject.set(project_id, [rest]);
  }

  const snapshots = projects.map((p) => {
    const tasks = tasksByProject.get(p.id) ?? [];
    const plans = plansByProject.get(p.id) ?? [];
    return {
      ...p,
      stats: {
        tasks: tasks.length,
        doneTasks: tasks.filter((t) => t.status === 'done').length,
        plans: plans.length,
        donePlans: plans.filter((x) => x.status === 'done').length,
      },
      tasks,
      plans,
    };
  });
  res.json({ snapshots });
});

/** 沉淀：把**整个项目**转为历史快照（项目从任务/计划菜单的项目列表消失，内容随快照保留） */
historyApi.post('/transfer', (req, res) => {
  const { projectId } = (req.body ?? {}) as { projectId?: unknown };
  if (typeof projectId !== 'string' || !projectId) return res.status(400).json({ error: 'projectId 必填' });
  const db = getDb();
  const proj = db.prepare('SELECT id, name, history_at, archived FROM projects WHERE id = ?').get(projectId) as { id: string; name: string; history_at: string | null; archived: number } | undefined;
  if (!proj) return res.status(400).json({ error: '项目不存在' });
  if (proj.archived) return res.status(400).json({ error: '该项目已归档，无法沉淀' });
  if (proj.history_at) return res.status(400).json({ error: '该项目已在历史资产中' });
  const t = now();
  const tasks = (db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE project_id = ?').get(projectId) as { c: number }).c;
  const plans = (db.prepare('SELECT COUNT(*) AS c FROM plan_tasks WHERE project_id = ?').get(projectId) as { c: number }).c;
  db.prepare('UPDATE projects SET history_at = ?, updated_at = ? WHERE id = ?').run(t, t, projectId);
  cacheClear('projects'); // 项目列表 5s TTL 缓存即时失效——沉淀后立即从任务/计划菜单的项目列表消失
  notifyChange('projects');
  notifyChange('tasks');
  res.json({ ok: true, projects: 1, tasks, plans, projectName: proj.name });
});

/** 恢复：整个项目快照回到活跃（任务/计划菜单的项目列表重新可见） */
historyApi.post('/restore', (req, res) => {
  const { projectId } = (req.body ?? {}) as { projectId?: unknown };
  if (typeof projectId !== 'string' || !projectId) return res.status(400).json({ error: 'projectId 必填' });
  const db = getDb();
  const r = db.prepare('UPDATE projects SET history_at = NULL, updated_at = ? WHERE id = ?').run(now(), projectId);
  if (r.changes === 0) return res.status(400).json({ error: '项目不存在或未沉淀' });
  cacheClear('projects');
  notifyChange('projects');
  notifyChange('tasks');
  res.json({ ok: true, projects: r.changes });
});

/** 归档删除：整个快照转归档区（项目标记 archived；其任务/计划全部软删除，可经归档菜单恢复） */
historyApi.post('/to-archive', (req, res) => {
  const { projectId } = (req.body ?? {}) as { projectId?: unknown };
  if (typeof projectId !== 'string' || !projectId) return res.status(400).json({ error: 'projectId 必填' });
  const db = getDb();
  const t = now();
  let tasks = 0;
  let plans = 0;
  db.transaction(() => {
    tasks = db.prepare('UPDATE tasks SET archived = 1, archived_at = ?, updated_at = ? WHERE project_id = ? AND archived = 0').run(t, t, projectId).changes;
    plans = db.prepare('UPDATE plan_tasks SET archived = 1, archived_at = ?, updated_at = ? WHERE project_id = ? AND archived = 0').run(t, t, projectId).changes;
    db.prepare('UPDATE projects SET archived = 1, history_at = NULL, updated_at = ? WHERE id = ?').run(t, projectId);
  })();
  cacheClear('projects');
  notifyChange('projects');
  notifyChange('tasks');
  if (plans > 0) notifyChange('plans');
  res.json({ ok: true, tasks, plans });
});
