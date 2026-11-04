import { getDb } from '../db/connection';

/**
 * T04136（PRD MEM-105 / MEM-106）：记忆与项目的应用层引用约束。
 *
 * PRD §5 选型：memories 全表无外键（老库补列与导入导出都不受 FK 顺序约束），
 * 因此 v2 时代由 FK 承担的两件事必须由应用层显式实现：删项目时 SET NULL、写入时校验引用。
 */

/**
 * MEM-105：删项目**之前**调用——把该项目特有的记忆降级为产品级共享（project_id=NULL），
 * 不物理删除任何记忆。降级后同产品其它期仍可经 MEM-301 的 `project_id IS NULL` 分支召回。
 * 返回受影响行数，便于调用方留痕/遥测。
 */
export function detachMemoriesFromProject(projectId: string): number {
  const r = getDb().prepare('UPDATE memories SET project_id = NULL WHERE project_id = ?').run(projectId);
  return r.changes;
}

/**
 * MEM-106：`mtask_save_memory` / REST POST 带 projectId 时校验项目存在。
 * 无 FK 后不校验会写出孤儿行（指向已删项目），查询时既不算共享也不算本期特有，永远召回不到。
 * null / undefined / '' 表示产品级共享，合法，直接放行。
 */
export function assertProjectExists(projectId: string | null | undefined): void {
  if (!projectId) return;
  const hit = getDb().prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
  if (!hit) throw new Error(`项目 id 不存在：${projectId}`);
}
