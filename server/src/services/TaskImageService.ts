import { getDb } from '../db/connection';
import { v4 as uuid } from 'uuid';

/** 单张图片上限（解码后字节数）：base64 传输由 express.json 的 body 上限兜底 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** 允许的图片 MIME 类型（剪贴板截图常见格式） */
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp']);

/** 图片元信息（不含 BLOB，用于列表/任务视图） */
export interface TaskImageMeta {
  id: string;
  task_id: string;
  mime_type: string;
  size: number;
  created_at: string;
}

interface ImageRow {
  id: string;
  task_id: string;
  mime_type: string;
  data: Buffer;
  created_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function toMeta(r: Omit<ImageRow, 'data'> & { size?: number }): TaskImageMeta {
  return { id: r.id, task_id: r.task_id, mime_type: r.mime_type, size: r.size ?? 0, created_at: r.created_at };
}

/** 任务截图附件：粘贴上传 / 读取 / 删除（FR1.3 图文混合描述） */
export const TaskImageService = {
  /** 保存一张图片（base64 数据），返回元信息 */
  add(taskId: string, base64: string, mimeType?: string): TaskImageMeta {
    const db = getDb();
    if (!db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId)) throw new Error('任务不存在');
    const mime = mimeType && ALLOWED_MIME.has(mimeType) ? mimeType : 'image/png';
    const buf = Buffer.from(base64, 'base64');
    if (buf.length === 0) throw new Error('图片数据为空');
    if (buf.length > MAX_IMAGE_BYTES) throw new Error(`图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB 上限`);
    const id = uuid();
    db.prepare('INSERT INTO task_images (id, task_id, mime_type, data, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, taskId, mime, buf, now());
    db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now(), taskId);
    return this.getMeta(id)!;
  },

  /** 单张图片元信息 */
  getMeta(id: string): TaskImageMeta | null {
    const row = getDb().prepare(
      'SELECT id, task_id, mime_type, length(data) AS size, created_at FROM task_images WHERE id = ?'
    ).get(id) as (Omit<ImageRow, 'data'> & { size: number }) | undefined;
    return row ? toMeta(row) : null;
  },

  /** 任务的图片列表（按上传顺序，不含 BLOB） */
  listByTask(taskId: string): TaskImageMeta[] {
    const rows = getDb().prepare(
      'SELECT id, task_id, mime_type, length(data) AS size, created_at FROM task_images WHERE task_id = ? ORDER BY created_at'
    ).all(taskId) as (Omit<ImageRow, 'data'> & { size: number })[];
    return rows.map(toMeta);
  },

  /** 批量任务的图片映射（任务列表渲染用，一次查询避免 N+1） */
  mapByTasks(taskIds: string[]): Map<string, TaskImageMeta[]> {
    const map = new Map<string, TaskImageMeta[]>();
    if (taskIds.length === 0) return map;
    const db = getDb();
    // SQLite 单条 SQL 参数上限 999（SQLITE_MAX_VARIABLE_NUMBER），任务数一旦超过该值，
    // 一条大 IN 会直接抛 "too many SQL variables" 使列表接口崩溃。
    // 按每批 ≤200 分次查询再合并，规避上限的同时保持"一次批量查图、避免 N+1"的初衷。
    const BATCH = 200;
    for (let i = 0; i < taskIds.length; i += BATCH) {
      const chunk = taskIds.slice(i, i + BATCH);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = db.prepare(
        `SELECT id, task_id, mime_type, length(data) AS size, created_at FROM task_images WHERE task_id IN (${placeholders}) ORDER BY created_at`
      ).all(...chunk) as (Omit<ImageRow, 'data'> & { size: number })[];
      for (const r of rows) {
        const list = map.get(r.task_id) ?? [];
        list.push(toMeta(r));
        map.set(r.task_id, list);
      }
    }
    return map;
  },

  /** 读取图片二进制（供 GET /api/images/:id 输出） */
  getData(id: string): { mime_type: string; data: Buffer } | null {
    const row = getDb().prepare('SELECT mime_type, data FROM task_images WHERE id = ?').get(id) as
      | { mime_type: string; data: Buffer }
      | undefined;
    return row ?? null;
  },

  /** 删除单张图片 */
  remove(id: string): boolean {
    return getDb().prepare('DELETE FROM task_images WHERE id = ?').run(id).changes > 0;
  },
};
