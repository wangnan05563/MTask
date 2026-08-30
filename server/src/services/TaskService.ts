import { getDb } from '../db/connection';
import { v4 as uuid } from 'uuid';
import { TaskImageService, type TaskImageMeta } from './TaskImageService';

/** DB 原始行：archived 为 number（SQLite 0/1） */
export interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  verified: number;
  archived: number;
  archived_at: string | null;
  ai_summary: string | null;
  pinned: number;
  category_id: string | null;
  created_at: string;
  updated_at: string;
}

/** 对外输出视图：archived 转为 boolean（API 返回）；images 为截图附件元信息 */
export interface TaskView {
  id: string;
  project_id: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  verified: boolean;
  archived: boolean;
  archived_at: string | null;
  ai_summary: string | null;
  pinned: boolean;
  category_id: string | null;
  created_at: string;
  updated_at: string;
  images: TaskImageMeta[];
}

export interface TaskInput {
  projectId: string;
  title: string;
  description?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  status?: 'todo' | 'done';
  verified?: boolean;
  /** 所属任务分类 id；null/空表示未分类 */
  categoryId?: string | null;
}

/** 任务列表查询选项：全部可选。不传 limit/offset 时保持"一次返回全量"的既有行为 */
export interface TaskListOptions {
  projectId?: string;
  archived?: boolean;
  /** 分页大小；不传=全量返回（兼容移动端/归档等调用方） */
  limit?: number;
  offset?: number;
  /** 标题/描述模糊搜索（大小写不敏感） */
  keyword?: string;
  /** 分类筛选；'none' 表示未分类任务 */
  categoryId?: string;
  /** 排序键；默认 pinned（置顶优先+创建时间倒序），与旧行为一致 */
  sort?: 'pinned' | 'created_desc' | 'created_asc' | 'priority_desc' | 'priority_asc';
}

function now(): string {
  return new Date().toISOString();
}

function rowToTask(r: TaskRow, images: TaskImageMeta[] = []): TaskView {
  return { ...r, verified: Boolean(r.verified), archived: Boolean(r.archived), pinned: Boolean(r.pinned), images };
}

/** FR1.2 / FR1.3 / FR1.4 / FR5 */
export const TaskService = {
  create(input: TaskInput): TaskView {
    const db = getDb();
    const id = uuid();
    const t = now();
    const r = db.prepare(
      `INSERT INTO tasks (id, project_id, title, description, priority, status, category_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, input.projectId, input.title, input.description ?? '', input.priority ?? 'normal', input.status ?? 'todo', input.categoryId ?? null, t, t);
    if (r.changes !== 1) throw new Error('创建任务失败');
    return this.getById(id)!;
  },

  getById(id: string): TaskView | null {
    const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? rowToTask(row, TaskImageService.listByTask(id)) : null;
  },

  /** 按项目/条件列出；archived=false 为活跃列表（待办/已完成由 status 区分）。支持可选分页/搜索/分类/排序 */
  list(opts: TaskListOptions = {}): TaskView[] {
    const db = getDb();
    // 动态 WHERE：分页/搜索/分类需精确拼条件，全部走参数绑定防注入
    const where: string[] = [];
    const values: unknown[] = [];
    where.push('archived = ?');
    values.push(opts.archived ? 1 : 0);
    if (opts.projectId) { where.push('project_id = ?'); values.push(opts.projectId); }
    if (opts.keyword) {
      // 转义 LIKE 通配符（%/_），让搜索词按字面匹配而非被误当通配
      const kw = `%${opts.keyword.replace(/[%_]/g, (m) => `\\${m}`)}%`;
      where.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
      values.push(kw, kw);
    }
    if (opts.categoryId === 'none') where.push('category_id IS NULL');
    else if (opts.categoryId) { where.push('category_id = ?'); values.push(opts.categoryId); }
    // 排序映射：优先级按业务档位映射数值，保证 urgent>high>normal>low
    const orderBy: Record<NonNullable<TaskListOptions['sort']>, string> = {
      pinned: 'pinned DESC, created_at DESC',
      created_desc: 'created_at DESC',
      created_asc: 'created_at ASC',
      priority_desc: "CASE priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END DESC, created_at DESC",
      priority_asc: "CASE priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END ASC, created_at ASC",
    };
    let sql = `SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY ${orderBy[opts.sort ?? 'pinned']}`;
    if (opts.limit) {
      sql += ' LIMIT ?';
      values.push(opts.limit);
      if (opts.offset) { sql += ' OFFSET ?'; values.push(opts.offset); }
    }
    const rows = db.prepare(sql).all(...values) as TaskRow[];
    // 一次批量查图片，避免逐任务 N+1（内部已按 ≤200/批规避 SQLite 参数上限）
    const imageMap = TaskImageService.mapByTasks(rows.map((r) => r.id));
    return rows.map((r) => rowToTask(r, imageMap.get(r.id) ?? []));
  },

  update(id: string, patch: Partial<Pick<TaskRow, 'title' | 'description' | 'priority' | 'status' | 'verified' | 'ai_summary' | 'pinned' | 'category_id'>>): TaskView {
    const db = getDb();
    // better-sqlite3 不支持 boolean 绑定且 SQLite 无布尔型，verified/pinned 先归一整型 0/1 再落库
    if (patch.verified !== undefined) {
      (patch as { verified: number }).verified = patch.verified ? 1 : 0;
    }
    if (patch.pinned !== undefined) {
      (patch as { pinned: number }).pinned = patch.pinned ? 1 : 0;
    }
    // 路由层会把未提供的字段用 undefined 塞进 patch，若全部纳入会把该列置为 NULL
    //（例如只 PATCH status 时 title 被清空，触发 NOT NULL）。因此过滤掉值为 undefined 的键。
    const keys = (Object.keys(patch) as (keyof typeof patch)[]).filter((k) => patch[k] !== undefined);
    if (keys.length === 0) return this.getById(id)!;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => patch[k]);
    db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, now(), id);
    return this.getById(id)!;
  },

  /** FR5.1 / FR5.3：完成或退回待办 */
  setStatus(id: string, status: 'todo' | 'done'): TaskView {
    return this.update(id, { status });
  },

  /** FR1.3：批量移动项目 */
  moveProject(taskIds: string[], projectId: string): void {
    const db = getDb();
    const stmt = db.prepare('UPDATE tasks SET project_id = ?, updated_at = ? WHERE id = ?');
    db.transaction(() => {
      for (const id of taskIds) stmt.run(projectId, now(), id);
    })();
  },

  /**
   * 复用（复制）任务到目标项目：生成新 id/时间，但完整保留标题、描述、优先级、状态、
   * 验证态、AI 摘要、置顶、分类与全部截图附件；源任务归属不受影响（仅读取）。
   * 目标项目存在同名任务时抛错（由路由层映射为 409），不做静默覆盖。
   */
  reuse(taskId: string, projectId: string): TaskView {
    const db = getDb();
    const src = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
    if (!src) throw new Error('任务不存在');
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new Error('目标项目不存在');
    const clash = db.prepare('SELECT 1 FROM tasks WHERE project_id = ? AND archived = 0 AND title = ?').get(projectId, src.title);
    if (clash) throw new Error(`目标项目已存在同名任务「${src.title}」`);
    const id = uuid();
    const t = now();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO tasks (id, project_id, title, description, priority, status, verified, archived, archived_at, ai_summary, pinned, category_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?)`
      ).run(id, projectId, src.title, src.description, src.priority, src.status, src.verified, src.ai_summary, src.pinned ? 1 : 0, src.category_id, t, t);
      // 复制截图：读取原图二进制，为新任务建立相同图片元信息与内容
      const imgs = db.prepare('SELECT mime_type, data FROM task_images WHERE task_id = ?').all(taskId) as { mime_type: string; data: Buffer }[];
      const ins = db.prepare('INSERT INTO task_images (id, task_id, mime_type, data, created_at) VALUES (?, ?, ?, ?, ?)');
      for (const im of imgs) ins.run(uuid(), id, im.mime_type, im.data, t);
    })();
    return this.getById(id)!;
  },

  /**
   * 将任务复制为提示词页可复用的结构化资产：把任务核心字段（标题/优先级/状态/描述/AI 摘要）
   * 打包成单份 JSON 文本写入 prompts 表（资产存储复用现有管理页字段，不新建表/不改架构）。
   * 不做自动价值打分——「有价值」由用户在任务页手动确认；仅读取源任务，不改动其归属。
   */
  toPromptAsset(taskId: string, categoryId: string): { id: string; category_id: string; title: string; content: string } {
    const db = getDb();
    const src = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
    if (!src) throw new Error('任务不存在');
    if (!db.prepare('SELECT 1 FROM prompt_categories WHERE id = ?').get(categoryId)) throw new Error('目标提示词分类不存在');
    // 仅纳入非空字段，避免空描述/空 AI 摘要污染资产的 JSON 结构
    const body: Record<string, string> = { type: 'task', title: src.title, priority: src.priority, status: src.status };
    if (src.description) body.description = src.description;
    if (src.ai_summary) body.ai_summary = src.ai_summary;
    const id = uuid();
    const t = now();
    db.prepare('INSERT INTO prompts (id, category_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, categoryId, src.title, JSON.stringify(body, null, 2), t, t);
    return db.prepare('SELECT id, category_id, title, content FROM prompts WHERE id = ?')
      .get(id) as { id: string; category_id: string; title: string; content: string };
  },

  /**
   * FR5.1 采纳：将用户审阅后的 AI 文本保存到任务 ai_summary，并将任务置为 done。
   * 采纳语义 = 仅保存文本待人工合并，不自动写入代码（FR4.4/FR5.1）。
   */
  adoptContent(id: string, content: string): TaskView {
    if (!content || !content.trim()) throw new Error('采纳内容不能为空');
    if (!this.getById(id)) throw new Error('任务不存在');
    const db = getDb();
    db.prepare('UPDATE tasks SET ai_summary = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(content, 'done', now(), id);
    return this.getById(id)!;
  },
};
