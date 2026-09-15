import express from 'express';
import { getDb } from '../db/connection';
import { ArchiveService } from '../services/ArchiveService';
import { notifyChange } from '../services/ChangeBus';

function now(): string {
  return new Date().toISOString();
}

/**
 * 历史资产（T00589）：把指定项目的**已完结内容**（已完成任务 + 已完结项目计划）
 * 整体转移至历史资产区（等同归档），供查看、沉淀与追溯查询，避免长期使用历史堆积。
 * 历史资产的读取复用既有归档通道：GET /tasks?archived=1 与 GET /plans/archived。
 */
export const historyApi = express.Router();

/** 转移统计：指定项目当前可转移的完结内容数量 */
historyApi.get('/summary', (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  const db = getDb();
  // 可转移：已完成的活跃任务（archived=0 + status=done）
  const tasks = (projectId
    ? db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE archived = 0 AND status = 'done' AND project_id = ?").get(projectId)
    : db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE archived = 0 AND status = 'done'").get()) as { c: number };
  // 已完结计划：状态 done 的活跃计划
  const plans = (projectId
    ? db.prepare("SELECT COUNT(*) AS c FROM plan_tasks WHERE archived = 0 AND status = 'done' AND project_id = ?").get(projectId)
    : db.prepare("SELECT COUNT(*) AS c FROM plan_tasks WHERE archived = 0 AND status = 'done'").get()) as { c: number };
  // 已入历史（归档）总量与时间跨度
  const archivedStat = (projectId
    ? db.prepare("SELECT COUNT(*) AS c, MIN(archived_at) AS first, MAX(archived_at) AS last FROM tasks WHERE archived = 1 AND project_id = ?").get(projectId)
    : db.prepare('SELECT COUNT(*) AS c, MIN(archived_at) AS first, MAX(archived_at) AS last FROM tasks WHERE archived = 1').get()) as { c: number; first: string | null; last: string | null };
  const archivedPlans = (projectId
    ? db.prepare('SELECT COUNT(*) AS c FROM plan_tasks WHERE archived = 1 AND project_id = ?').get(projectId)
    : db.prepare('SELECT COUNT(*) AS c FROM plan_tasks WHERE archived = 1').get()) as { c: number };
  // 覆盖项目数（去重）
  const projects = db.prepare('SELECT COUNT(DISTINCT project_id) AS c FROM tasks WHERE archived = 1').get() as { c: number };
  res.json({
    transferableTasks: tasks?.c ?? 0,
    transferablePlans: plans?.c ?? 0,
    archivedTasks: archivedStat?.c ?? 0,
    archivedPlans: archivedPlans?.c ?? 0,
    archivedProjects: projects?.c ?? 0,
    firstArchivedAt: archivedStat?.first ?? null,
    lastArchivedAt: archivedStat?.last ?? null,
  });
});

/** 转移到历史资产：把指定项目的已完成任务与已完结计划批量归档（可限定只转移任务或计划） */
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
      const ids = (db.prepare("SELECT id FROM tasks WHERE project_id = ? AND archived = 0 AND status = 'done'").all(projectId) as Array<{ id: string }>).map((r) => r.id);
      if (ids.length > 0) {
        ArchiveService.archive(ids);
        tasks = ids.length;
      }
    }
    if (includePlans) {
      const r = db.prepare("UPDATE plan_tasks SET archived = 1, archived_at = ?, updated_at = ? WHERE project_id = ? AND archived = 0 AND status = 'done'").run(t, t, projectId);
      plans = r.changes;
    }
  })();
  notifyChange('tasks');
  if (plans > 0) notifyChange('plans');
  res.json({ ok: true, tasks, plans });
});
