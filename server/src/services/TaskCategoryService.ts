/**
 * 任务分类服务：分类的增删改查。
 * 删除分类时会把其下任务的 category_id 置空（任务保留、回到未分类），避免任务丢失。
 */
import { getDb } from '../db/connection';
import { v4 as uuid } from 'uuid';

export interface TaskCategoryRow {
  id: string;
  name: string;
  sort_weight: number;
  created_at: string;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

export const TaskCategoryService = {
  list(): TaskCategoryRow[] {
    return getDb().prepare('SELECT * FROM task_categories ORDER BY sort_weight, created_at').all() as TaskCategoryRow[];
  },

  create(name: string): TaskCategoryRow {
    const db = getDb();
    const id = uuid();
    const t = now();
    db.prepare('INSERT INTO task_categories (id, name, sort_weight, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name.trim(), 0, t, t);
    return db.prepare('SELECT * FROM task_categories WHERE id = ?').get(id) as TaskCategoryRow;
  },

  rename(id: string, name: string): TaskCategoryRow | null {
    const db = getDb();
    const existing = db.prepare('SELECT id FROM task_categories WHERE id = ?').get(id);
    if (!existing) return null;
    db.prepare('UPDATE task_categories SET name = ?, updated_at = ? WHERE id = ?').run(name.trim(), now(), id);
    return db.prepare('SELECT * FROM task_categories WHERE id = ?').get(id) as TaskCategoryRow;
  },

  /** 删除分类：其下任务 category_id 置空，置于同一事务保证一致性 */
  remove(id: string): boolean {
    const db = getDb();
    const existing = db.prepare('SELECT id FROM task_categories WHERE id = ?').get(id);
    if (!existing) return false;
    db.transaction(() => {
      db.prepare('UPDATE tasks SET category_id = NULL, updated_at = ? WHERE category_id = ?').run(now(), id);
      db.prepare('DELETE FROM task_categories WHERE id = ?').run(id);
    })();
    return true;
  },
};