import express from 'express';
import { getDb } from '../db/connection';
import { TaskService, type TaskView } from '../services/TaskService';
import { notifyChange } from '../services/ChangeBus';

function now(): string {
  return new Date().toISOString();
}

/**
 * 历史资产（T00589）：**组织过程资产沉淀**，与「归档」（软删除）语义独立。
 *
 * 状态流转：
 *   活跃（history_at 空）--转移--> 历史资产（history_at 非空, archived=0）
 *   历史资产 --恢复--> 活跃（清 history_at）
 *   历史资产 --转归档--> 归档（archived=1, 清 history_at；走既有归档恢复/彻底删除）
 *
 * 列表隔离：活跃列表（TaskService.list / PlanService.list）排除 history_at 非空；
 * 归档列表只含 archived=1，天然不含历史资产。
 */
export const historyApi = express.Router();

/** 统计：可转移 / 已沉淀 / 时间跨度 */
historyApi.get('/summary', (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  const db = getDb();
  const scope = projectId ? ' AND project_id = ?' : '';
  const args = projectId ? [projectId] : [];
  const transferableTasks = (db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE archived = 0 AND COALESCE(history_at,'') = '' AND status = 'done'${scope}`).get(...args) as { c: number }).c;
  const transferablePlans = (db.prepare(`SELECT COUNT(*) AS c FROM plan_tasks WHERE archived = 0 AND COALESCE(history_at,'') = '' AND status = 'done'${scope}`).get(...args) as { c: number }).c;
  const historyTasks = (db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE COALESCE(history_at,'') != ''${scope}`).get(...args) as { c: number }).c;
  const historyPlans = (db.prepare(`SELECT COUNT(*) AS c FROM plan_tasks WHERE COALESCE(history_at,'') != ''${scope}`).get(...args) as { c: number }).c;
  const span = db.prepare(`SELECT MIN(history_at) AS first, MAX(history_at) AS last FROM tasks WHERE COALESCE(history_at,'') != ''${scope}`).get(...args) as { first: string | null; last: string | null };
  const projects = (db.prepare("SELECT COUNT(DISTINCT project_id) AS c FROM tasks WHERE COALESCE(history_at,'') != ''").get() as { c: number }).c;
  res.json({
    transferableTasks,
    transferablePlans,
    historyTasks,
    historyPlans,
    historyProjects: projects,
    firstHistoryAt: span?.first ?? null,
    lastHistoryAt: span?.last ?? null,
  });
});

/** 历史资产列表：任务（完整视图 + 项目名）与计划（完整行 + 项目名）——供查看视图渲染 */
historyApi.get('/list', (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  const db = getDb();
  const tWhere = projectId ? 'AND t.project_id = ?' : '';
  const pWhere = projectId ? 'AND p.project_id = ?' : '';
  const args = projectId ? [projectId] : [];
  const taskRows = db.prepare(
    `SELECT t.id, t.project_id, pr.name AS project_name
     FROM tasks t LEFT JOIN projects pr ON pr.id = t.project_id
     WHERE COALESCE(t.history_at,'') != '' ${tWhere}
     ORDER BY t.history_at DESC`,
  ).all(...args) as Array<{ id: string; project_id: string; project_name: string | null }>;
  // 用 TaskView 装配（图片/分类等完整字段与原任务页同源），保证查看视图一致
  const tasks = taskRows.map((r) => {
    const v = TaskService.getById(r.id);
    return v ? { ...v, project_name: r.project_name ?? '' } : null;
  }).filter(Boolean) as Array<TaskView & { project_name: string }>;

  const plans = db.prepare(
    `SELECT p.*, pr.name AS project_name FROM plan_tasks p LEFT JOIN projects pr ON pr.id = p.project_id
     WHERE COALESCE(p.history_at,'') != '' ${pWhere}
     ORDER BY p.history_at DESC`,
  ).all(...args) as Array<Record<string, unknown> & { project_name: string | null }>;
  res.json({ tasks, plans: plans.map((p) => ({ ...p, project_name: p.project_name ?? '' })) });
});

/** 转移到历史资产：按项目把已完成任务 / 已完结计划沉淀（仅写 history_at，不改 archived） */
historyApi.post('/transfer', (req, res) => {
  const { projectId, includeTasks = true, includePlans = true } = (req.body ?? {}) as { projectId?: unknown; includeTasks?: unknown; includePlans?: unknown };
  if (typeof projectId !== 'string' || !projectId) return res.status(400).json({ error: 'projectId 必填' });
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) return res.status(400).json({ error: '项目不存在' });
  const t = now();
  let tasks = 0;
  let plans = 0;
  db.transaction(() => {
    if (includeTasks) {
      tasks = db.prepare("UPDATE tasks SET history_at = ?, updated_at = ? WHERE project_id = ? AND archived = 0 AND COALESCE(history_at,'') = '' AND status = 'done'").run(t, t, projectId).changes;
    }
    if (includePlans) {
      plans = db.prepare("UPDATE plan_tasks SET history_at = ?, updated_at = ? WHERE project_id = ? AND archived = 0 AND COALESCE(history_at,'') = '' AND status = 'done'").run(t, t, projectId).changes;
    }
  })();
  notifyChange('tasks');
  if (plans > 0) notifyChange('plans');
  res.json({ ok: true, tasks, plans });
});

/** 恢复回原视图：清 history_at（回到任务/计划活跃列表） */
historyApi.post('/restore', (req, res) => {
  const { taskIds, planIds } = (req.body ?? {}) as { taskIds?: unknown; planIds?: unknown };
  const db = getDb();
  const t = now();
  let tasks = 0;
  let plans = 0;
  db.transaction(() => {
    if (Array.isArray(taskIds)) {
      const stmt = db.prepare('UPDATE tasks SET history_at = NULL, updated_at = ? WHERE id = ?');
      for (const id of taskIds as string[]) tasks += stmt.run(t, id).changes;
    }
    if (Array.isArray(planIds)) {
      const stmt = db.prepare('UPDATE plan_tasks SET history_at = NULL, updated_at = ? WHERE id = ?');
      for (const id of planIds as string[]) plans += stmt.run(t, id).changes;
    }
  })();
  notifyChange('tasks');
  if (plans > 0) notifyChange('plans');
  res.json({ ok: true, tasks, plans });
});

/** 转为归档（软删除区）：置 archived=1 并清 history_at——随后在归档菜单恢复/彻底删除 */
historyApi.post('/to-archive', (req, res) => {
  const { taskIds, planIds } = (req.body ?? {}) as { taskIds?: unknown; planIds?: unknown };
  const db = getDb();
  const t = now();
  let tasks = 0;
  let plans = 0;
  db.transaction(() => {
    if (Array.isArray(taskIds)) {
      const stmt = db.prepare('UPDATE tasks SET archived = 1, archived_at = ?, history_at = NULL, updated_at = ? WHERE id = ?');
      for (const id of taskIds as string[]) tasks += stmt.run(t, t, id).changes;
    }
    if (Array.isArray(planIds)) {
      const stmt = db.prepare('UPDATE plan_tasks SET archived = 1, archived_at = ?, history_at = NULL, updated_at = ? WHERE id = ?');
      for (const id of planIds as string[]) plans += stmt.run(t, t, id).changes;
    }
  })();
  notifyChange('tasks');
  if (plans > 0) notifyChange('plans');
  res.json({ ok: true, tasks, plans });
});
