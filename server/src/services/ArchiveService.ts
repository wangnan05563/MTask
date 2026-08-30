import { getDb } from '../db/connection';
import { TaskService, type TaskView } from './TaskService';

function now(): string {
  return new Date().toISOString();
}

/**
 * FR6 归档与删除：待办/已完成均可归档（archived=1）；仅归档任务可删除。
 */
export const ArchiveService = {
  /** FR6.1/6.2 归档（支持批量） */
  archive(taskIds: string[]): TaskView[] {
    const db = getDb();
    const stmt = db.prepare("UPDATE tasks SET archived = 1, archived_at = ?, updated_at = ? WHERE id = ? AND archived = 0");
    db.transaction(() => {
      for (const id of taskIds) stmt.run(now(), now(), id);
    })();
    return taskIds.map((id) => TaskService.getById(id)).filter(Boolean) as TaskView[];
  },

  /** FR6.5 还原 */
  restore(taskIds: string[]): TaskView[] {
    const db = getDb();
    const stmt = db.prepare("UPDATE tasks SET archived = 0, archived_at = NULL, updated_at = ? WHERE id = ?");
    db.transaction(() => {
      for (const id of taskIds) stmt.run(now(), id);
    })();
    return taskIds.map((id) => TaskService.getById(id)).filter(Boolean) as TaskView[];
  },

  /** FR6.3 归档列表 */
  list(projectId?: string): TaskView[] {
    return TaskService.list({ projectId, archived: true });
  },

  /** FR6.4 删除——仅归档任务可删；直接物理删除（骨架阶段），生产可加软删 */
  remove(taskIds: string[]): number {
    const db = getDb();
    const stmt = db.prepare('DELETE FROM tasks WHERE id = ? AND archived = 1');
    let count = 0;
    db.transaction(() => {
      for (const id of taskIds) {
        const r = stmt.run(id);
        count += r.changes;
      }
    })();
    return count;
  },
};
