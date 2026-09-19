import { getDb } from '../db/connection';
import { notifyChange } from './ChangeBus';
import { v4 as uuid } from 'uuid';
import { cachedPrepare } from '../util/stmt-cache'; // T00792：热点 SQL 语句复用
import { TaskImageService, type TaskImageMeta } from './TaskImageService';
import { ReqEntryService } from './ReqService';

/** 批量 IN 查询的每批 id 数：SQLite 变量上限 999，留足余量并与图片批量查询（≤200）同量级 */
const PLAN_LOOKUP_BATCH = 200;
/** T00620：running 状态超时阈值——超过则视为 AI 中断并自动置 failed（可用环境变量覆盖，便于调试） */
const AI_STATE_STALE_MS = Number(process.env.MTASK_AI_STATE_STALE_MS ?? 10 * 60 * 1000);


/** DB 原始行：archived 为 number（SQLite 0/1） */
export interface TaskRow {
  id: string;
  /** 任务编号：全局唯一 T+5位数字递增，供 AI Agent 通过 MCP 按编号定位任务 */
  task_no: string | null;
  project_id: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  verified: number;
  archived: number;
  archived_at: string | null;
  /** T00589：历史资产时间（非空即已沉淀至历史资产，与归档独立） */
  history_at: string | null;
  ai_summary: string | null;
  /** 处理结果：AI 分析结论（根因/解决方案）等，由 MCP 或前端编辑写入 */
  handle_result: string | null;
  /** T00566：AI 处理状态动画（'' 已读/无 | running 运行中 | failed 运行失败 | unread 未读） */
  ai_state: string;
  /** T00620：AI 状态变更时间（ISO）；'' 状态（已读清空）时保留历史值，用于判断"是否被处理过" */
  ai_state_at: string;
  /** T00577：派生单溯源——原任务编号（如 T00422）；处理完成后结论自动整合回原任务 */
  derived_from: string | null;
  /** T00719：搁置标记（1=已搁置）——搁置任务从待办/已完成列表与 MCP 查询隔离，仅出现在搁置列表 */
  shelved: number;
  /** T00490：记录字体颜色（Excel 风格颜色按钮），空串=默认色 */
  color: string;
  pinned: number;
  category_id: string | null;
  parent_id: string | null;
  user_sort: number | null;
  created_at: string;
  updated_at: string;
}

/** 对外输出视图：archived 转为 boolean（API 返回）；images 为截图附件元信息 */
export interface TaskView {
  id: string;
  task_no: string | null;
  project_id: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  verified: boolean;
  archived: boolean;
  archived_at: string | null;
  /** T00589：历史资产时间（非空即已沉淀，与归档独立） */
  history_at: string | null;
  ai_summary: string | null;
  handle_result: string | null;
  /** T00566：AI 处理状态动画（'' 已读/无 | running failed unread） */
  ai_state: string;
  /** T00620：AI 状态变更时间（ISO）；'' 状态（已读清空）时保留历史值 */
  ai_state_at: string;
  /** T00577：派生单溯源——原任务编号 */
  derived_from: string | null;
  /** T00719：搁置标记 */
  shelved: boolean;
  pinned: boolean;
  category_id: string | null;
  /** T00450：父任务 id（两级的 epic→task 层级） */
  parent_id: string | null;
  /** T00446：手动排序权重（拖拽排序结果；pinned 组内生效） */
  user_sort: number | null;
  created_at: string;
  updated_at: string;
  images: TaskImageMeta[];
  /** T00462/T00451：任务由项目计划联动创建/关联——值为来源计划标题，前端据此显示区分徽标与来源引用 */
  fromPlanTitle?: string;
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
  /** T00450：父任务 id（两级的 epic→task 层级）；创建子任务时传入 */
  parentId?: string | null;
  /** T00577：派生单溯源——原任务编号（如 T00422） */
  derived_from?: string | null;
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
  /** T00474：优先级精确过滤（urgent/high/normal/low），非法值忽略 */
  priority?: string;
  /** 状态筛选（待办/已完成）；不传返回该范围内全部状态。供 MCP/AI 按待办/已完成精确拉取，减少返回量 */
  status?: 'todo' | 'done';
  /** T00719：搁置筛选——不传/false 排除搁置任务（默认隔离，MCP 处理待办自动忽略搁置）；true 只返回搁置任务 */
  shelved?: boolean;
  /** 分析范围：只返回「待处理 或 未验证(verified=0)」的任务。与 status 互斥（优先 pending）
   *  未验证任务即便已 done，其处理结果可能仍需关联判断，纳入便于 AI 分析上下文 */
  pending?: boolean;
  /** 排序键；默认 pinned（置顶优先+创建时间倒序），与旧行为一致 */
  sort?: 'pinned' | 'created_desc' | 'created_asc' | 'priority_desc' | 'priority_asc' | 'manual';
}

function now(): string {
  return new Date().toISOString();
}

/** 分配下一个任务编号：取库中当前最大的 T+数字 序号 +1，包在写事务外由 create 事务整体提交。
 *  为何自行分配而非 SQLite 自增：task_no 需对外暴露为稳定业务编号（T00001 可读）且删除任务后不复用。 */
/** 任务编号生成（T00662 起对外导出：PRD 导入建待办时复用，保证编号单一来源） */
export function nextTaskNo(): string {
  const db = getDb();
  const rows = db.prepare('SELECT task_no FROM tasks WHERE task_no IS NOT NULL').all() as { task_no: string }[];
  let max = 0;
  for (const r of rows) {
    const m = /^T(\d+)$/.exec(r.task_no);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `T${String(max + 1).padStart(5, '0')}`;
}

function rowToTask(r: TaskRow, images: TaskImageMeta[] = []): TaskView {
  return { ...r, verified: Boolean(r.verified), archived: Boolean(r.archived), pinned: Boolean(r.pinned), shelved: Boolean(r.shelved), images };
}

/** 待办状态变更后反向同步关联的计划任务（已完成↔已完成，待办→进行中），并按完成比例汇总父任务进度 */
function syncPlanOnStatusChange(id: string, status: string): void {
  const db = getDb();
  const planStatus = status === 'done' ? 'done' : 'doing';
  db.prepare('UPDATE plan_tasks SET status = ?, progress = CASE WHEN ? = 100 THEN 100 ELSE progress END, updated_at = ? WHERE linked_task_id = ?')
    .run(planStatus, planStatus === 'done' ? 100 : -1, now(), id);
  // T00450 配套：子任务状态变更后汇总父任务进度（按子任务完成比例），全完成时父自动 done
  const childRow = db.prepare('SELECT parent_id FROM tasks WHERE id = ?').get(id) as { parent_id: string | null } | undefined;
  if (childRow?.parent_id) {
    const stat = db.prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done FROM tasks WHERE parent_id = ? AND archived = 0",
    ).get(childRow.parent_id) as { total: number; done: number };
    if (stat.total > 0) {
      const progress = Math.round((stat.done / stat.total) * 100);
      const parentStatus = stat.done === stat.total ? 'done' : 'todo';
      db.prepare("UPDATE tasks SET progress = ?, status = ?, updated_at = ? WHERE id = ? AND status != 'done'").run(progress, parentStatus, now(), childRow.parent_id);
    }
  }
}

/** FR1.2 / FR1.3 / FR1.4 / FR5 */
export const TaskService = {
  create(input: TaskInput): TaskView {
    const db = getDb();
    const id = uuid();
    const t = now();
    if (input.parentId && !db.prepare('SELECT id FROM tasks WHERE id = ?').get(input.parentId)) {
      throw new Error('父任务不存在');
    }
    const r = db.prepare(
      `INSERT INTO tasks (id, task_no, project_id, title, description, priority, status, category_id, parent_id, derived_from, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, nextTaskNo(), input.projectId, input.title, input.description ?? '', input.priority ?? 'normal', input.status ?? 'todo', input.categoryId ?? null, input.parentId ?? null, input.derived_from ?? null, t, t);
    if (r.changes !== 1) throw new Error('创建任务失败');
    return this.getById(id)!;
  },

  getById(id: string): TaskView | null {
    // T00620：读取路径惰性过期 running（AI 中断兜底）——放在取行之前，保证返回值已是终态
    this.expireStaleRunning();
    const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? rowToTask(row, TaskImageService.listByTask(id)) : null;
  },

  /** T00566：AI 处理状态回写（running/failed/unread；'' = 已读清空）。非法值忽略。 */
  setAiState(id: string, state: string): TaskView | null {
    const allowed = new Set(['running', 'failed', 'unread', '']);
    if (!allowed.has(state)) return this.getById(id);
    // T00620：同步记录状态变更时间。
    // - 置 ''（用户已读清空）时**保留**原 ai_state_at：它是"该任务是否被 AI 处理过"的判据，
    //   丢掉会让 MCP 的"读取即开始处理"再次误判，把已完成的卡片重新转圈；
    // - 其余状态（含 failed/超时兜底）刷新时间戳，供 running 超时判断使用。
    if (state === '') {
      return this.update(id, { ai_state: state });
    }
    return this.update(id, { ai_state: state, ai_state_at: new Date().toISOString() });
  },

  /**
   * T00620：running 超时兜底——AI Agent 中断（进程被杀/会话结束/网络断开）时
   * 不会有任何回调来收尾，任务会永远停在转圈态。这里在读取路径上**惰性过期**：
   * 把 running 且超过 maxAgeMs 未更新的任务置为 failed（红色警示，用户可据此重试）。
   *
   * 实现要点：
   * - **探测优先**：先用一次轻量 SELECT 判断是否存在过期项（配 idx_tasks_ai_state 索引），
   *   无过期项直接返回——避免每次 list/get 都做写事务；
   * - **不做时间节流**：曾经加过 30s 节流，结果中断检测被最长延迟 30s（验证脚本当场暴露），
   *   而探测本身已足够便宜（真实库 619 任务、running 通常 0~2 条），故直接去掉；
   * - 时间戳缺失的历史数据回退用 updated_at 判断年龄（否则老数据永远不过期）；
   * - 直接 SQL 更新（只改 ai_state/ai_state_at，**不动 updated_at**），避免污染"最近更新"排序。
   */
  expireStaleRunning(maxAgeMs: number = AI_STATE_STALE_MS, force = false): number {
    const db = getDb();
    const nowMs = Date.now();
    const cutoff = new Date(nowMs - maxAgeMs).toISOString();
    const ageExpr = "CASE WHEN COALESCE(ai_state_at, '') <> '' THEN ai_state_at ELSE COALESCE(updated_at, '') END";
    const stale = db.prepare(
      `SELECT id FROM tasks WHERE ai_state = 'running' AND ${ageExpr} < ? LIMIT 1`,
    ).get(cutoff) as { id: string } | undefined;
    if (!stale && !force) return 0;

    const r = db.prepare(
      `UPDATE tasks SET ai_state = 'failed', ai_state_at = ? WHERE ai_state = 'running' AND ${ageExpr} < ?`,
    ).run(new Date(nowMs).toISOString(), cutoff);
    if (r.changes > 0) {
      console.warn(`[TaskService] ${r.changes} 个 running 任务超过 ${Math.round(maxAgeMs / 60000)} 分钟未更新，自动置 failed（AI 中断兜底）`);
    }
    return r.changes;
  },

  /** 按编号查找任务：供 AI Agent 通过 MCP 的 taskNo 参数定位。不存在返回 null。 */
  findByNo(taskNo: string): TaskView | null {
    const row = getDb().prepare('SELECT * FROM tasks WHERE task_no = ?').get(taskNo) as TaskRow | undefined;
    return row ? rowToTask(row, TaskImageService.listByTask(row.id)) : null;
  },

  /** 按项目/条件列出；archived=false 为活跃列表（待办/已完成由 status 区分）。支持可选分页/搜索/分类/排序 */
  list(opts: TaskListOptions = {}): TaskView[] {
    // T00620：列表读取路径惰性过期 running（AI 中断兜底；内部 30s 节流）
    this.expireStaleRunning();
    const db = getDb();
    // 动态 WHERE：分页/搜索/分类需精确拼条件，全部走参数绑定防注入
    const where: string[] = [];
    const values: unknown[] = [];
    where.push('archived = ?');
    values.push(opts.archived ? 1 : 0);
    // T00589：活跃列表排除已入历史资产的内容（历史资产为独立沉淀区，不与活跃/归档混排）
    if (!opts.archived) where.push("COALESCE(history_at, '') = ''");
    // T00719：搁置隔离——默认活跃列表（含 MCP pending/status 查询）一律排除搁置任务；
    // 搁置列表（shelved=true）只返回搁置任务；归档列表不过滤（先搁置后归档的任务仍可在归档区找到）
    if (opts.shelved) where.push('shelved = 1');
    else if (!opts.archived) where.push('COALESCE(shelved, 0) = 0');
    if (opts.projectId) { where.push('project_id = ?'); values.push(opts.projectId); }
    if (opts.keyword) {
      // 转义 LIKE 通配符（%/_），让搜索词按字面匹配而非被误当通配
      const kw = `%${opts.keyword.replaceAll(/[%_]/g, (m) => '\\' + m)}%`;
      where.push(String.raw`(title LIKE ? ESCAPE '\' OR description LIKE ? ESCAPE '\')`);
      values.push(kw, kw);
    }
    if (opts.categoryId === 'none') where.push('category_id IS NULL');
    else if (opts.categoryId) { where.push('category_id = ?'); values.push(opts.categoryId); }
    // T00474：优先级筛选——合法值白名单校验，非法值忽略保持全量
    if (opts.priority && ['urgent', 'high', 'normal', 'low'].includes(opts.priority)) {
      where.push('priority = ?'); values.push(opts.priority);
    }
    // 状态/范围筛选：MCP/AI 拉指定范围时在服务端过滤，避免全量下发再本地筛，省 Token。
    // pending 优先于 status：返回「待处理 或 未验证」任务的并集。
    if (opts.pending) { where.push('(status = ? OR verified = 0)'); values.push('todo'); }
    else if (opts.status) { where.push('status = ?'); values.push(opts.status); }
    // 排序映射：优先级按业务档位映射数值，保证 urgent>high>normal>low
    const orderBy: Record<NonNullable<TaskListOptions['sort']>, string> = {
      pinned: 'pinned DESC, created_at DESC',
      created_desc: 'created_at DESC',
      created_asc: 'created_at ASC',
      priority_desc: "CASE priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END DESC, created_at DESC",
      priority_asc: "CASE priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END ASC, created_at ASC",
      // T00446：手动排序（拖拽结果）——pinned 优先，user_sort 空值排最后
      manual: "pinned DESC, CASE WHEN user_sort IS NULL THEN 1 ELSE 0 END, user_sort, created_at DESC",
    };
    let sql = `SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY ${orderBy[opts.sort ?? 'pinned']}`;
    if (opts.limit) {
      sql += ' LIMIT ?';
      values.push(opts.limit);
      if (opts.offset) { sql += ' OFFSET ?'; values.push(opts.offset); }
    }
    // T00792：SQL 文本由「过滤组合 × 6 种排序 × limit/offset」决定，变体数有限且高度重复
    //（前端固定几种视图来回切），缓存 Statement 避免每次请求重新编译（实测 3.48× 于编译环节）
    const rows = cachedPrepare(db, sql).all(...values) as TaskRow[];
    // 一次批量查图片，避免逐任务 N+1（内部已按 ≤200/批规避 SQLite 参数上限）
    const imageMap = TaskImageService.mapByTasks(rows.map((r) => r.id));
    // T00462/T00451：批量反查项目计划关联（linked_task_id 命中即「计划联动任务」），值=来源计划标题。
    // 必须分批：SQLite 变量上限 999，而无 limit 的调用（移动端/归档/队列页）会传入全量任务 id，
    // 单条 IN (?,?,...) 在任务数 >999 时直接抛错（真实缺陷）；分批后同时把 SQL 文本长度控制住。
    const planLinked = new Map<string, string>();
    for (let i = 0; i < rows.length; i += PLAN_LOOKUP_BATCH) {
      const chunk = rows.slice(i, i + PLAN_LOOKUP_BATCH);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => '?').join(',');
      const hits = db.prepare(
        `SELECT pt.linked_task_id AS id, pt.title FROM plan_tasks pt
         WHERE pt.archived = 0 AND pt.linked_task_id IN (${placeholders})`,
      ).all(...chunk.map((r) => r.id)) as Array<{ id: string; title: string }>;
      for (const h of hits) planLinked.set(h.id, h.title);
    }
    return rows.map((r) => {
      const view = rowToTask(r, imageMap.get(r.id) ?? []);
      const planTitle = planLinked.get(r.id);
      if (planTitle) view.fromPlanTitle = planTitle;
      return view;
    });
  },

  update(id: string, patch: Partial<Pick<TaskRow, 'title' | 'description' | 'priority' | 'status' | 'verified' | 'ai_summary' | 'handle_result' | 'pinned' | 'category_id' | 'parent_id' | 'color' | 'ai_state' | 'ai_state_at' | 'derived_from' | 'shelved'>>): TaskView {
    const db = getDb();
    // better-sqlite3 不支持 boolean 绑定且 SQLite 无布尔型，verified/pinned 先归一整型 0/1 再落库
    if (patch.verified !== undefined) {
      (patch as { verified: number }).verified = patch.verified ? 1 : 0;
    }
    if (patch.pinned !== undefined) {
      (patch as { pinned: number }).pinned = patch.pinned ? 1 : 0;
    }
    // T00719：搁置标记同样归一整型
    if (patch.shelved !== undefined) {
      (patch as { shelved: number }).shelved = patch.shelved ? 1 : 0;
    }
    // T00566：ai_state 白名单防御（PATCH 直传路径）——非法值静默忽略
    if (patch.ai_state !== undefined && !['running', 'failed', 'unread', ''].includes(patch.ai_state)) {
      delete (patch as { ai_state?: string }).ai_state;
    }
    // 路由层会把未提供的字段用 undefined 塞进 patch，若全部纳入会把该列置为 NULL
    //（例如只 PATCH status 时 title 被清空，触发 NOT NULL）。因此过滤掉值为 undefined 的键。
    const keys = (Object.keys(patch) as (keyof typeof patch)[]).filter((k) => patch[k] !== undefined);
    if (keys.length === 0) return this.getById(id)!;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => patch[k]);
    db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, now(), id);
    // 反向计划联动（T00436）：待办被项目计划关联时，状态变更同步回计划任务（已完成↔已完成，待办→进行中）
    if (patch.status !== undefined) syncPlanOnStatusChange(id, patch.status);
    notifyChange('tasks');
    return this.getById(id)!;
  },

  /** FR5.1 / FR5.3：完成或退回待办 */
  setStatus(id: string, status: 'todo' | 'done'): TaskView {
    return this.update(id, { status });
  },

  /** T00719：搁置 / 恢复——搁置任务从待办/已完成列表与 MCP 查询隔离（shelved=1），恢复即回到原列表 */
  setShelved(id: string, shelved: boolean): TaskView {
    if (!this.getById(id)) throw new Error('任务不存在');
    // update 的 patch 类型按 TaskRow（number），这里先归一 0/1（update 内 boolean 归一为冗余兜底）
    return this.update(id, { shelved: shelved ? 1 : 0 });
  },

  /**
   * 手动排序（T00446）：前端传拖拽后的完整 id 顺序（限定同一项目），事务内写入 user_sort（1..n）。
   * 列表 sort='manual' 时 pinned 优先、user_sort 空值排后——与拖拽结果一致。
   */
  reorder(orderedIds: string[]): { reordered: number } {
    if (orderedIds.length === 0) throw new Error('orderedIds 必填');
    const db = getDb();
    db.transaction(() => {
      orderedIds.forEach((id, i) => {
        db.prepare('UPDATE tasks SET user_sort = ?, updated_at = ? WHERE id = ?').run(i + 1, now(), id);
      });
    })();
    return { reordered: orderedIds.length };
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
      // 复用生成新 id 但保留原任务编号？不复用：新任务需全局唯一编号，重新分配避免重复
      // T00631：复用需**适度清洗**，使新任务开箱可执行——
      //   status 固定 todo（不继承源任务的完成态）、verified 归零、清空 handle_result（原任务产物）、取消置顶；
      //   保留 title/description/priority/category_id/ai_summary（内容与参考信息）与截图附件。
      db.prepare(
        `INSERT INTO tasks (id, task_no, project_id, title, description, priority, status, verified, archived, archived_at, ai_summary, handle_result, pinned, category_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'todo', 0, 0, NULL, ?, NULL, 0, ?, ?, ?)`
      ).run(id, nextTaskNo(), projectId, src.title, src.description, src.priority, src.ai_summary, src.category_id, t, t);
      // 复制截图：读取原图二进制，为新任务建立相同图片元信息与内容
      const imgs = db.prepare('SELECT mime_type, data FROM task_images WHERE task_id = ?').all(taskId) as { mime_type: string; data: Buffer }[];
      const ins = db.prepare('INSERT INTO task_images (id, task_id, mime_type, data, created_at) VALUES (?, ?, ?, ?, ?)');
      for (const im of imgs) ins.run(uuid(), id, im.mime_type, im.data, t);
    })();
    return this.getById(id)!;
  },

  /**
   * 将任务复制为提示词页可复用的结构化资产：把任务核心字段（标题/优先级/状态/描述/AI 摘要）
   * 拼为单份可读 Markdown 文本写入 prompts 表（资产存储复用现有管理页字段，不新建表/不改架构）。
   * 不再用 JSON 序列化：JSON 转义/引号/嵌套对用户阅读与直接复用都不友好。
   * 不做自动价值打分——「有价值」由用户在任务页手动确认；仅读取源任务，不改动其归属。
   */
  toPromptAsset(taskId: string, categoryId: string): { id: string; category_id: string; title: string; content: string } {
    const db = getDb();
    const src = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
    if (!src) throw new Error('任务不存在');
    if (!db.prepare('SELECT 1 FROM prompt_categories WHERE id = ?').get(categoryId)) throw new Error('目标提示词分类不存在');
    // 直接组织为可读的纯文本（Markdown 友好），不再 JSON 序列化：
    // JSON 结构对用户观感差（转义、引号、嵌套），提示词页按 Markdown 渲染 content，
    // 用「标题 + 分块」的平铺文本既保留完整信息，又方便直接复用/粘贴给 AI。
    const parts: string[] = [`**任务标题**：${src.title}`];
    if (src.priority) parts.push(`**优先级**：${src.priority}`);
    if (src.status) parts.push(`**状态**：${src.status === 'done' ? '已完成' : '待办'}`);
    if (src.description) parts.push(`**任务描述**：\n${src.description}`);
    if (src.ai_summary) parts.push(`**AI 梳理摘要**：\n${src.ai_summary}`);
    const id = uuid();
    const t = now();
    db.prepare('INSERT INTO prompts (id, category_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, categoryId, src.title, parts.join('\n\n'), t, t);
    return db.prepare('SELECT id, category_id, title, content FROM prompts WHERE id = ?')
      .get(id) as { id: string; category_id: string; title: string; content: string };
  },

  /**
   * 将任务复制为「通用需求」条目：与 toPromptAsset 同构，但写入 req_entries 表，
   * 便于把有跨项目复用价值的优秀任务沉淀到「通用需求」菜单做分类管理。
   * 仅读取源任务，不改动其归属；内容组织为可读 Markdown 平铺文本，方便在需求页直接查看/复用。
   */
  toReqAsset(taskId: string, categoryId: string): { id: string; category_id: string; title: string; content: string } {
    const src = this.getById(taskId);
    if (!src) throw new Error('任务不存在');
    if (!getDb().prepare('SELECT 1 FROM req_categories WHERE id = ?').get(categoryId)) throw new Error('目标通用需求分类不存在');
    const parts: string[] = [`**任务标题**：${src.title}`];
    if (src.priority) parts.push(`**优先级**：${src.priority}`);
    if (src.status) parts.push(`**状态**：${src.status === 'done' ? '已完成' : '待办'}`);
    if (src.description) parts.push(`**任务描述**：\n${src.description}`);
    if (src.ai_summary) parts.push(`**AI 梳理摘要**：\n${src.ai_summary}`);
    const entry = ReqEntryService.create({ categoryId, title: src.title, content: parts.join('\n\n') });
    return { id: entry.id, category_id: entry.category_id, title: entry.title, content: entry.content };
  },

  /**
   * FR5.1 采纳：将用户审阅后的 AI 文本保存到任务 ai_summary，并将任务置为 done。
   * 采纳语义 = 仅保存文本待人工合并，不自动写入代码（FR4.4/FR5.1）。
   */
  adoptContent(id: string, content: string): TaskView {
    // 可选链一步覆盖「未传内容」与「空白内容」，与原 !content || !content.trim() 语义一致
    if (!content?.trim()) throw new Error('采纳内容不能为空');
    if (!this.getById(id)) throw new Error('任务不存在');
    const db = getDb();
    db.prepare('UPDATE tasks SET ai_summary = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(content, 'done', now(), id);
    return this.getById(id)!;
  },
};
