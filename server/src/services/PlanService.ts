/**
 * 项目计划服务（T00431）：计划任务 CRUD、串行瀑布时间线重排（避开周末与节假日）、
 * Excel 导入/导出（exceljs）、计划→待办状态联动。设计文档见 docs/PRD-项目计划.md。
 */
import { getDb } from '../db/connection';
import { v4 as uuid } from 'uuid';
import ExcelJS from 'exceljs';
import { AIService } from './AIService';
import { notifyChange } from './ChangeBus';
// pizzip：docxtemplater 既有依赖，用于解压 .docx 提取 word/document.xml（T00439）
import PizZip from 'pizzip';

export interface PlanTaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  start_date: string; // YYYY-MM-DD
  end_date: string;   // YYYY-MM-DD（含当天）
  duration_days: number;
  progress: number;
  status: PlanStatus;
  assignee: string;
  sort_order: number;
  /** 关联待办 tasks.id；待办已删除时保留原值并由查询附带 linked_task_missing 提示 */
  linked_task_id: string | null;
  /** 归档标记（T00442 扩展）：1=已归档（时间线移除，归档菜单可恢复/彻底删除） */
  archived: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  /** 查询附带：关联待办标题（不存在则为 null） */
  linked_task_title?: string | null;
  /** 查询附带：关联待办是否已删除 */
  linked_task_missing?: boolean;
}

export type PlanStatus = 'todo' | 'doing' | 'done' | 'blocked';

const PLAN_STATUSES = new Set<PlanStatus>(['todo', 'doing', 'done', 'blocked']);

/** AI 解析输入的行数上限：超出的内容截断，避免超大文件拖垮模型上下文（T00438） */
const MAX_PARSE_ROWS = 300;

/**
 * 从 AI 输出中提取 JSON 数组，带截断恢复（T00439）：
 * 大文档拆分时输出可能被 max_tokens 截断（JSON 未闭合），此时退化到
 * 「最后一个完整对象 + ]」补全重试，尽量抢救已生成的大部分条目。
 */
function parseJsonArrayWithRecovery(text: string, notFoundMsg: string): unknown[] {
  const bare = text.replace(/```json/gi, '').replace(/```/gi, '').trim();
  const start = bare.indexOf('[');
  if (start === -1) throw new Error(notFoundMsg);
  const end = bare.lastIndexOf(']');
  let arr: unknown;
  try {
    arr = JSON.parse(bare.slice(start, end > start ? end + 1 : start + 1));
  } catch {
    // 截断恢复：JSON.parse 完整数组失败，尝试到「最后一个 }」为止补 ]
    const lastObj = bare.lastIndexOf('}');
    if (lastObj <= start) throw new Error(notFoundMsg);
    try {
      arr = JSON.parse(bare.slice(start, lastObj + 1) + ']');
    } catch {
      throw new Error(notFoundMsg);
    }
  }
  if (!Array.isArray(arr)) throw new Error(notFoundMsg);
  return arr;
}

/** CSV 行文本：按行拆分 + 逗号切分（含引号单元格原样保留，粒度足够 AI 理解） */
function csvToText(buffer: Buffer): string {
  return buffer.toString('utf-8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, MAX_PARSE_ROWS)
    .map((l) => l.split(',').map((c) => c.trim()).join(' | '))
    .join('\n');
}

function now(): string {
  return new Date().toISOString();
}

// ---------- 工作日计算 ----------

/** YYYY-MM-DD → 本地零点 Date（避免 toISOString 时区偏移） */
function parseDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`日期格式非法：${s}（应为 YYYY-MM-DD）`);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // 回写不一致说明是非法日（如 02-31 会被 Date 进位到 3 月）
  if (fmt(d) !== s) throw new Error(`日期非法：${s}`);
  return d;
}

function fmt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Excel 单元格值 → 文本：Date 走 fmt，富文本对象取其 text，其余 object 显式 JSON 化
 * （避免隐式 String() 得到 "[object Object]"）。
 */
function cellValueText(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return fmt(v);
  if (typeof v === 'object' && 'text' in (v as object)) return String((v as { text: unknown }).text);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function loadHolidaySet(): Set<string> {
  const rows = getDb().prepare('SELECT date FROM holidays').all() as { date: string }[];
  return new Set(rows.map((r) => r.date));
}

/** 工作日 = 非周六日 且 不在节假日表 */
function isWorkday(d: Date, holidays: Set<string>): boolean {
  const wd = d.getDay();
  if (wd === 0 || wd === 6) return false;
  return !holidays.has(fmt(d));
}

/** 起始日起 duration_days 个工作日的含尾结束日 */
function calcEndDate(start: string, durationDays: number, holidays: Set<string>): string {
  const d = parseDate(start);
  let left = durationDays;
  while (left > 0) {
    if (isWorkday(d, holidays)) left -= 1;
    if (left > 0) d.setDate(d.getDate() + 1);
  }
  return fmt(d);
}

/** 某结束日之后的下一个工作日（串行重排用） */
function nextWorkday(after: string, holidays: Set<string>): string {
  const d = parseDate(after);
  do { d.setDate(d.getDate() + 1); } while (!isWorkday(d, holidays));
  return fmt(d);
}

// ---------- 时间线重排 ----------

interface RescheduleOpts {
  /** 首行显式开始日（用户改开始日时传入；缺省=首行保持自身 start_date 作锚点） */
  firstStartDate?: string;
  /** 前一任务结束日（中间删除/改工期时传入，后续从其下一工作日顺延） */
  afterEndDate?: string;
}

/**
 * 从指定 sort_order 起向后串行重排（单事务）：
 * 首行开始日 = firstStartDate ?? afterEndDate 的下一工作日 ?? 自身 start_date；
 * 后续每行开始日 = 前一任务结束日之后的下一个工作日（串行瀑布，跳过周末与节假日）。
 */
function rescheduleFrom(db: ReturnType<typeof getDb>, projectId: string, fromOrder: number, opts: RescheduleOpts = {}): void {
  const holidays = loadHolidaySet();
  const rows = db.prepare(
    'SELECT id, start_date, duration_days, sort_order FROM plan_tasks WHERE project_id = ? AND archived = 0 AND sort_order >= ? ORDER BY sort_order',
  ).all(projectId, fromOrder) as Array<Pick<PlanTaskRow, 'id' | 'start_date' | 'duration_days' | 'sort_order'>>;
  let prevEnd: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let start: string;
    if (i === 0) {
      start = opts.firstStartDate ?? (opts.afterEndDate ? nextWorkday(opts.afterEndDate, holidays) : (r.start_date || fmt(new Date())));
    } else {
      start = nextWorkday(prevEnd!, holidays);
    }
    const end = calcEndDate(start, Math.max(1, r.duration_days), holidays);
    db.prepare('UPDATE plan_tasks SET start_date = ?, end_date = ?, updated_at = ? WHERE id = ?')
      .run(start, end, now(), r.id);
    prevEnd = end;
  }
}

/** 重排某项目整条时间线（首任务保持自身 start_date 作锚点） */
function rescheduleAll(db: ReturnType<typeof getDb>, projectId: string): void {
  rescheduleFrom(db, projectId, 0, {});
}

/** 计划状态 → 关联待办状态映射（MTask 待办仅 todo/done 两态） */
function taskStatusForPlan(ps: PlanStatus): 'todo' | 'done' {
  return ps === 'done' ? 'done' : 'todo';
}

// ---------- 服务 ----------

export const PlanService = {
  /** 活跃计划列表（排除已归档；归档条目走 listArchived，T00442 语义：删除=归档） */
  list(projectId: string): PlanTaskRow[] {
    const rows = getDb().prepare(
      `SELECT p.*, t.title AS linked_task_title
       FROM plan_tasks p LEFT JOIN tasks t ON t.id = p.linked_task_id
       WHERE p.project_id = ? AND p.archived = 0 ORDER BY p.sort_order`,
    ).all(projectId) as Array<PlanTaskRow & { linked_task_title: string | null }>;
    return rows.map((r) => ({
      ...r,
      linked_task_missing: r.linked_task_id != null && r.linked_task_title == null,
    }));
  },

  /** 归档计划列表（全库，含项目名）——供「归档」菜单的恢复/彻底删除操作（T00442 扩展） */
  listArchived(): Array<PlanTaskRow & { project_name: string }> {
    return getDb().prepare(
      `SELECT p.*, pr.name AS project_name, t.title AS linked_task_title
       FROM plan_tasks p
       JOIN projects pr ON pr.id = p.project_id
       LEFT JOIN tasks t ON t.id = p.linked_task_id
       WHERE p.archived = 1 ORDER BY p.archived_at DESC, p.project_id, p.sort_order`,
    ).all() as Array<PlanTaskRow & { project_name: string; linked_task_title: string | null }>;
  },

  get(id: string): PlanTaskRow | null {
    return (getDb().prepare('SELECT * FROM plan_tasks WHERE id = ?').get(id) as PlanTaskRow | undefined) ?? null;
  },

  /** 新建：追加到序列尾部；首任务用传入 start_date 作锚点，否则全量重排 */
  create(input: { projectId: string; title: string; description?: string; startDate?: string; durationDays?: number; assignee?: string; status?: PlanStatus }): PlanTaskRow {
    const db = getDb();
    const title = String(input.title ?? '').trim();
    if (!title) throw new Error('标题必填');
    if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(input.projectId)) throw new Error('项目不存在');
    const status = PLAN_STATUSES.includes(input.status as PlanStatus) ? (input.status as PlanStatus) : 'todo';
    const duration = Math.max(1, Math.floor(Number(input.durationDays) || 1));
    const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM plan_tasks WHERE project_id = ? AND archived = 0').get(input.projectId) as { m: number }).m;
    const first = maxOrder < 0;
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const start = first
      ? (input.startDate && dateRe.test(input.startDate) ? input.startDate : fmt(new Date()))
      : '';
    const id = uuid();
    const t = now();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
           progress, status, assignee, sort_order, linked_task_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, ?)`,
      ).run(id, input.projectId, title, input.description ?? '', start, start, duration, status, input.assignee ?? '', maxOrder + 1, t, t);
      // 非首任务：由重排从锚点串行推导 start/end；首任务也统一走一次以生成 end_date
      rescheduleAll(db, input.projectId);
    })();
    return this.get(id)!;
  },

  /** 更新：标题/描述/工期/进度/状态/负责人；开始日与工期变化会触发从该任务起的时间线重排 */
  update(id: string, patch: { title?: string; description?: string; startDate?: string; durationDays?: number; progress?: number; status?: PlanStatus; assignee?: string }): PlanTaskRow | null {
    const db = getDb();
    const row = this.get(id);
    if (!row) return null;
    const title = patch.title !== undefined ? String(patch.title).trim() : row.title;
    if (!title) throw new Error('标题必填');
    const duration = patch.durationDays !== undefined ? Math.max(1, Math.floor(Number(patch.durationDays) || 1)) : row.duration_days;
    let status = row.status;
    let linkedTaskId = row.linked_task_id;
    db.transaction(() => {
      // 状态变更先落列，再同步关联待办（同步读取最新 plan 状态）
      if (patch.status !== undefined && PLAN_STATUSES.includes(patch.status)) status = patch.status;
      const startDateChanged = patch.startDate !== undefined && patch.startDate !== row.start_date;
      db.prepare(
        `UPDATE plan_tasks SET title = ?, description = ?, start_date = ?, duration_days = ?,
           progress = ?, status = ?, assignee = ?, updated_at = ? WHERE id = ?`,
      ).run(
        title,
        patch.description ?? row.description,
        patch.startDate ?? row.start_date,
        duration,
        patch.progress !== undefined ? Math.min(100, Math.max(0, Math.floor(Number(patch.progress) || 0))) : row.progress,
        status,
        patch.assignee ?? row.assignee,
        now(),
        id,
      );
      if (startDateChanged) {
        // 用户显式改开始日：以新开始日为该任务锚点，后续串行顺延
        rescheduleFrom(db, row.project_id, row.sort_order, { firstStartDate: patch.startDate });
      } else if (duration !== row.duration_days) {
        // 工期变化：开始日不变（中间任务由前序决定），后续从本任务新结束日顺延
        if (row.sort_order === 0) {
          rescheduleFrom(db, row.project_id, 0, {});
        } else {
          const prev = db.prepare(
            'SELECT end_date FROM plan_tasks WHERE project_id = ? AND sort_order < ? ORDER BY sort_order DESC LIMIT 1',
          ).get(row.project_id, row.sort_order) as { end_date: string } | undefined;
          rescheduleFrom(db, row.project_id, row.sort_order, prev ? { afterEndDate: prev.end_date } : {});
        }
      } else {
        // 未动排期也要刷新自身 end_date（纯状态/文本编辑的兜底）
        const holidays = loadHolidaySet();
        const cur = this.get(id)!;
        db.prepare('UPDATE plan_tasks SET end_date = ? WHERE id = ?').run(calcEndDate(cur.start_date, cur.duration_days, holidays), id);
      }
      if (linkedTaskId) {
        db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(taskStatusForPlan(status), now(), linkedTaskId);
      }
    })();
    return this.get(id);
  },

  /** 归档（原「删除」语义，T00442 扩展）：软删——从时间线移除并衔接重排，可在归档菜单恢复 */
  archive(id: string): boolean {
    const db = getDb();
    const row = this.get(id);
    if (!row || row.archived) return false;
    db.transaction(() => {
      db.prepare('UPDATE plan_tasks SET archived = 1, archived_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id);
      const prev = db.prepare(
        'SELECT end_date FROM plan_tasks WHERE project_id = ? AND archived = 0 AND sort_order < ? ORDER BY sort_order DESC LIMIT 1',
      ).get(row.project_id, row.sort_order) as { end_date: string } | undefined;
      rescheduleFrom(db, row.project_id, row.sort_order, prev ? { afterEndDate: prev.end_date } : {});
    })();
    notifyChange('plans');
    return true;
  },

  /** 恢复：取消归档并插回原排序位衔接重排（前序取恢复位之前最近的未归档任务） */
  restore(id: string): boolean {
    const db = getDb();
    const row = this.get(id);
    if (!row || !row.archived) return false;
    db.transaction(() => {
      db.prepare('UPDATE plan_tasks SET archived = 0, archived_at = NULL, updated_at = ? WHERE id = ?').run(now(), id);
      const prev = db.prepare(
        'SELECT end_date FROM plan_tasks WHERE project_id = ? AND archived = 0 AND sort_order < ? ORDER BY sort_order DESC LIMIT 1',
      ).get(row.project_id, row.sort_order) as { end_date: string } | undefined;
      rescheduleFrom(db, row.project_id, row.sort_order, prev ? { afterEndDate: prev.end_date } : { firstStartDate: row.start_date });
    })();
    notifyChange('plans');
    return true;
  },

  /** 彻底删除（归档菜单专用）：物理删除行；已归档行不参与时间线，无需重排。恢复关联待办不受影响 */
  purge(id: string): boolean {
    return getDb().prepare('DELETE FROM plan_tasks WHERE id = ? AND archived = 1').run(id).changes > 0;
  },

  /**
   * 拖拽排序（T00459）：前端传拖拽后的完整 id 顺序，事务内校验覆盖一致后重写 sort_order
   * （0..n 连续化），再全量重排时间线。仅接受活跃计划，防止把归档行卷入。
   */
  reorder(projectId: string, orderedIds: string[]): { reordered: number } {
    if (!getDb().prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new Error('项目不存在');
    const active = getDb().prepare(
      "SELECT id FROM plan_tasks WHERE project_id = ? AND archived = 0 ORDER BY sort_order",
    ).all(projectId) as Array<{ id: string }>;
    const activeIds = new Set(active.map((r) => r.id));
    if (orderedIds.length !== activeIds.size || !orderedIds.every((id) => activeIds.has(id))) {
      throw new Error('orderedIds 必须与当前活跃计划一一对应（数量与成员一致）');
    }
    const db = getDb();
    const t = now();
    db.transaction(() => {
      orderedIds.forEach((id, i) => {
        db.prepare('UPDATE plan_tasks SET sort_order = ?, updated_at = ? WHERE id = ?').run(i, t, id);
      });
      rescheduleAll(db, projectId);
    })();
    return { reordered: orderedIds.length };
  },

  /**
   * 通用需求 → 计划草稿（PRD INT-5）：把通用需求条目转为计划任务（追加到目标项目计划尾部）。
   * 标题带 [需求] 前缀；同项目查重（同标题已存在则报错提示）。
   */
  createFromReq(reqEntryId: string, projectId: string): { plan: PlanTaskRow } {
    const db = getDb();
    const entry = db.prepare('SELECT title, content FROM req_entries WHERE id = ?').get(reqEntryId) as { title: string; content: string } | undefined;
    if (!entry) throw new Error('通用需求不存在');
    if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new Error('目标项目不存在');
    const dup = db.prepare(
      "SELECT id FROM plan_tasks WHERE project_id = ? AND title = ? AND archived = 0",
    ).get(projectId, `[需求] ${entry.title}`) as { id: string } | undefined;
    if (dup) throw new Error('该需求已转存为计划任务，请勿重复转存');
    const r = this.createBatch(projectId, [{ title: `[需求] ${entry.title}`, description: entry.content }]);
    return { plan: this.list(projectId).slice(-1)[0] };
  },

  /**
   * 任意位置插入（T00459）：在指定行之后插入新计划任务——
   * 事务内后续行 sort_order+1 顺移、新行插入 after+1、全量重排时间线（新行无日期由锚点推导）。
   */
  insertAfter(afterId: string, title: string, description?: string): PlanTaskRow {
    const db = getDb();
    const after = this.get(afterId);
    if (!after || after.archived) throw new Error('插入位置任务不存在或已归档');
    const trimmed = title.trim();
    if (!trimmed) throw new Error('标题必填');
    const id = uuid();
    const t = now();
    db.transaction(() => {
      db.prepare('UPDATE plan_tasks SET sort_order = sort_order + 1 WHERE project_id = ? AND archived = 0 AND sort_order > ?')
        .run(after.project_id, after.sort_order);
      db.prepare(
        `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
           progress, status, assignee, sort_order, linked_task_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', '', 1, 0, 'todo', '', ?, NULL, ?, ?)`,
      ).run(id, after.project_id, trimmed, description ?? '', after.sort_order + 1, t, t);
      // 重排：从插入位置起衔接（after 行自身日期不变作锚点——afterEndDate 语义为“之后”）
      const afterEnd = after.end_date || fmt(new Date());
      rescheduleFrom(db, after.project_id, after.sort_order + 1, { afterEndDate: afterEnd });
    })();
    return this.get(id)!;
  },

  /**

  /** 关联待办：同项目校验 + 按当前计划状态立即同步该待办状态 */
  linkTodo(id: string, taskId: string | null): PlanTaskRow | null {
    const db = getDb();
    const row = this.get(id);
    if (!row) return null;
    if (taskId) {
      const task = db.prepare('SELECT id, project_id FROM tasks WHERE id = ?').get(taskId) as { project_id: string } | undefined;
      if (!task) throw new Error('待办任务不存在');
      if (task.project_id !== row.project_id) throw new Error('仅可关联同项目的待办任务');
    }
    db.transaction(() => {
      db.prepare('UPDATE plan_tasks SET linked_task_id = ?, updated_at = ? WHERE id = ?').run(taskId, now(), id);
      if (taskId) {
        db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(taskStatusForPlan(row.status), now(), taskId);
      }
    })();
    return this.get(id);
  },

  /** 由计划任务创建新待办（接收计划标题/描述），并直接关联。
   *  T00445 教训：多渠道创建易产生重复待办——创建前查同项目同标题，已存在则直接关联既有任务。 */
  createLinkedTodo(id: string): { plan: PlanTaskRow; taskId: string; reused: boolean } {
    const db = getDb();
    const row = this.get(id);
    if (!row) throw new Error('计划任务不存在');
    if (row.linked_task_id) throw new Error('已关联待办，请先解除关联');
    // 同项目查重：规范化标题一致的待办视为已存在，直接关联（避免重复创建）
    const exist = db.prepare('SELECT id FROM tasks WHERE project_id = ? AND REPLACE(title, char(10), \'\') = ? LIMIT 1')
      .get(row.project_id, `[计划] ${row.title}`) as { id: string } | undefined;
    const t = now();
    if (exist) {
      db.transaction(() => {
        db.prepare('UPDATE plan_tasks SET linked_task_id = ?, updated_at = ? WHERE id = ?').run(exist.id, now(), id);
        db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(taskStatusForPlan(row.status), now(), exist.id);
      })();
      return { plan: this.get(id)!, taskId: exist.id, reused: true };
    }
    const taskId = uuid();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO tasks (id, project_id, title, description, priority, status, verified, archived, pinned, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'normal', ?, 0, 0, 0, ?, ?)`,
      ).run(taskId, row.project_id, `[计划] ${row.title}`, row.description || '', taskStatusForPlan(row.status), t, t);
      db.prepare('UPDATE plan_tasks SET linked_task_id = ?, updated_at = ? WHERE id = ?').run(taskId, now(), id);
    })();
    return { plan: this.get(id)!, taskId, reused: false };
  },

  // ---------- 节假日 ----------

  listHolidays(): Array<{ date: string; name: string }> {
    return getDb().prepare('SELECT date, name FROM holidays ORDER BY date').all() as Array<{ date: string; name: string }>;
  },

  addHoliday(date: string, name: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式应为 YYYY-MM-DD');
    getDb().prepare('INSERT INTO holidays (date, name) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET name = excluded.name')
      .run(date, name.trim());
    this.rescheduleAllProjects();
  },

  removeHoliday(date: string): boolean {
    const r = getDb().prepare('DELETE FROM holidays WHERE date = ?').run(date);
    if (r.changes > 0) this.rescheduleAllProjects();
    return r.changes > 0;
  },

  /**
   * 联网导入国家法定节假日（T00442）：后端代理请求 timor.tech 免费节假日 API（避免浏览器 CORS），
   * 仅导入法定放假日期（holiday=true；调休补班日不导入——当前 isWorkday 把周末固定排除，无法表达补班）。
   * upsert 幂等：重复导入同一年不产生脏数据；导入后全量重排受影响时间线。
   */
  async importNationalHolidays(year: number): Promise<{ imported: number; items: Array<{ date: string; name: string }> }> {
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('年份非法（应为 2000-2100）');
    const resp = await fetch(`https://timor.tech/api/holiday/year/${year}`, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`节假日数据源请求失败：HTTP ${resp.status}（请检查网络）`);
    const data = (await resp.json()) as {
      code?: number;
      holiday?: Record<string, { holiday?: boolean; name?: string; date?: string } | undefined>;
    };
    if (!data || data.code !== 0 || !data.holiday) throw new Error('节假日数据源返回异常');
    const items: Array<{ date: string; name: string }> = [];
    for (const [k, v] of Object.entries(data.holiday)) {
      if (!v || v.holiday !== true) continue; // 跳过调休补班日
      const date = (v.date && /^\d{4}-\d{2}-\d{2}$/.test(v.date)) ? v.date : `${year}-${k}`;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      items.push({ date, name: (v.name ?? '').trim() });
    }
    if (items.length === 0) throw new Error('数据源未返回法定节假日，请稍后重试');
    const db = getDb();
    db.transaction(() => {
      for (const it of items) {
        db.prepare('INSERT INTO holidays (date, name) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET name = excluded.name')
          .run(it.date, it.name);
      }
    })();
    this.rescheduleAllProjects();
    return { imported: items.length, items };
  },

  /** 节假日变更影响所有项目的时间线，全量重排 */
  rescheduleAllProjects(): void {
    const db = getDb();
    const ids = (db.prepare('SELECT DISTINCT project_id FROM plan_tasks').all() as Array<{ project_id: string }>).map((r) => r.project_id);
    for (const pid of ids) {
      db.transaction(() => rescheduleAll(db, pid))();
    }
  },

  // ---------- Excel 导入 / 导出 ----------

  /**
   * 导入：逐行校验，任一行失败则整体不入库并返回全部行级错误（约束：事务一致性 + 行号定位）。
   * 返回 { inserted, errors }。
   */
  async importExcel(projectId: string, buffer: Buffer): Promise<{ inserted: number; errors: Array<{ row: number; message: string }> }> {
    if (!getDb().prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new Error('项目不存在');
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    } catch {
      throw new Error('Excel 文件解析失败，请使用导出/模板同构的 .xlsx 文件');
    }
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('Excel 中无工作表');

    const errors: Array<{ row: number; message: string }> = [];
    const parsed: Array<{ title: string; description: string; startDate: string; durationDays: number; assignee: string; status: PlanStatus }> = [];
    const existingTitles = new Set(
      (getDb().prepare('SELECT title FROM plan_tasks WHERE project_id = ?').all(projectId) as Array<{ title: string }>).map((r) => r.title),
    );
    const seenTitles = new Set<string>();

    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // 表头
      const cell = (n: number): string => {
        const c = row.getCell(n);
        const v = c.value;
        if (v == null) return '';
        if (v instanceof Date) return fmt(v);
        const text = typeof v === 'object' && 'text' in (v as object) ? String((v as { text: unknown }).text) : String(v);
        return text.trim();
      };
      const title = cell(1);
      const description = cell(2);
      const startDate = cell(3);
      const durationRaw = cell(4);
      const assignee = cell(5);
      const statusRaw = cell(6).toLowerCase() || 'todo';
      if (!title && !description && !startDate && !durationRaw) return; // 整行空跳过
      const fail = (message: string) => errors.push({ row: rowNumber, message });

      if (!title) { fail('标题必填'); return; }
      if (existingTitles.has(title) || seenTitles.has(title)) { fail(`标题与现有/前文计划重复：${title}`); return; }
      let start: string;
      try { start = fmt(parseDate(startDate)); } catch { fail(`开始日期非法：${startDate || '(空)'}（应为 YYYY-MM-DD）`); return; }
      const duration = Number(durationRaw);
      if (!Number.isInteger(duration) || duration < 1) { fail(`工期非法：${durationRaw || '(空)'}（应为 ≥1 的整数）`); return; }
      if (!PLAN_STATUSES.includes(statusRaw as PlanStatus)) { fail(`状态非法：${statusRaw}（应为 todo/doing/done/blocked）`); return; }
      seenTitles.add(title);
      parsed.push({ title, description, startDate: start, durationDays: duration, assignee, status: statusRaw as PlanStatus });
    });

    if (errors.length > 0) return { inserted: 0, errors };
    if (parsed.length === 0) return { inserted: 0, errors: [{ row: 0, message: '未解析到任何数据行' }] };
    if (parsed.length > 5000) throw new Error('单次导入上限 5000 行，请分批导入');

    const db = getDb();
    const t = now();
    db.transaction(() => {
      const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM plan_tasks WHERE project_id = ? AND archived = 0').get(projectId) as { m: number }).m;
      const existingCount = maxOrder + 1;
      parsed.forEach((p, i) => {
        // 首行（项目内第一条）用自己的开始日作时间线锚点；其余行 start_date 先置空，由重排统一推导
        const start = existingCount === 0 && i === 0 ? p.startDate : '';
        db.prepare(
          `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
             progress, status, assignee, sort_order, linked_task_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, '', ?, 0, ?, ?, ?, NULL, ?, ?)`,
        ).run(uuid(), projectId, p.title, p.description, start, p.durationDays, p.status, p.assignee, maxOrder + 1 + i, t, t);
      });
      rescheduleAll(db, projectId);
    })();
    return { inserted: parsed.length, errors: [] };
  },

  /** 导出：sheet1=计划任务（与模板同列序），sheet2=节假日 */
  async exportExcel(projectId: string): Promise<Buffer> {
    const rows = this.list(projectId);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('项目计划');
    ws.columns = [
      { header: '标题', key: 'title', width: 36 },
      { header: '描述', key: 'description', width: 40 },
      { header: '开始日期', key: 'start_date', width: 14 },
      { header: '结束日期', key: 'end_date', width: 14 },
      { header: '工期(工作日)', key: 'duration_days', width: 14 },
      { header: '进度(%)', key: 'progress', width: 10 },
      { header: '状态', key: 'status', width: 10 },
      { header: '负责人', key: 'assignee', width: 14 },
    ];
    for (const r of rows) ws.addRow({ title: r.title, description: r.description, start_date: r.start_date, end_date: r.end_date, duration_days: r.duration_days, progress: r.progress, status: r.status, assignee: r.assignee });
    const hws = wb.addWorksheet('节假日');
    hws.columns = [{ header: '日期', key: 'date', width: 14 }, { header: '名称', key: 'name', width: 24 }];
    for (const h of this.listHolidays()) hws.addRow(h);
    const out = await wb.xlsx.writeBuffer();
    return Buffer.from(out);
  },

  /** 模板：表头 + 1 行示例（与导入列序一致） */
  async templateExcel(): Promise<Buffer> {    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('项目计划');
    ws.columns = [
      { header: '标题', key: 'title', width: 36 },
      { header: '描述', key: 'description', width: 40 },
      { header: '开始日期', key: 'start_date', width: 14 },
      { header: '工期(工作日)', key: 'duration_days', width: 14 },
      { header: '负责人', key: 'assignee', width: 14 },
      { header: '状态', key: 'status', width: 10 },
    ];
    ws.addRow({ title: '示例：完成登录模块联调', description: '示例描述（导入前请删除本行）', start_date: '2026-09-14', duration_days: 3, assignee: '张三', status: 'todo' });
    const out = await wb.xlsx.writeBuffer();
    return Buffer.from(out);
  },

  // ---------- AI 导入（T00438）：任意格式 Excel → 表格文本 → AI 语义解析 → 标准草稿 ----------

  /**
   * xlsx/csv → 行文本（每行一条、单元格以「 | 」分隔），交由 AI 做语义解析。
   * 刻意不做任何字段映射假设——列的含义完全由 AI 识别（任务约束：不得硬编码字段映射）。
   * 老式 .xls（BIFF 二进制）exceljs 不支持，抛出友好提示引导另存为 .xlsx。
   */
  async tableToTextAsync(buffer: Buffer, filename: string): Promise<string> {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.csv')) return csvToText(buffer);
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    } catch {
      throw new Error('文件解析失败：仅支持 .xlsx / .csv；老式 .xls 请先用 Excel 另存为 .xlsx 再导入');
    }
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('Excel 中无工作表');
    const lines: string[] = [];
    ws.eachRow((row) => {
      if (lines.length >= MAX_PARSE_ROWS) return;
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        if (v == null) { cells.push(''); return; }
        if (v instanceof Date) { cells.push(fmt(v)); return; }
        const text = typeof v === 'object' && 'text' in (v as object) ? String((v as { text: unknown }).text) : String(v);
        cells.push(text.trim().replace(/\s*\n\s*/g, ' '));
      });
      const line = cells.join(' | ').replace(/(\s*\|\s*)+$/, '').trim();
      if (line) lines.push(line);
    });
    return lines.join('\n');
  },

  // ---------- 需求文档 → WBS → 项目计划（T00439）：Word/Markdown → 层级文本 → AI 拆分 → 标准草稿 ----------

  /**
   * Word(.docx) → Markdown 层级文本：pizzip 解压 OOXML，从 word/document.xml 提取段落；
   * 标题样式（Heading1-4/内置中文标题）转 # 前缀，保留文档层级供 AI 识别 WBS 结构。
   * 老式 .doc（BIFF 二进制）不支持，抛友好提示。零新依赖（pizzip 为 docxtemplater 既有依赖）。
   */
  docxToMarkdown(buffer: Buffer): string {
    let zip: { file: (name: string) => { asText: () => string } | null };
    try {
      zip = new PizZip(buffer);
    } catch {
      throw new Error('Word 文档解析失败：仅支持 .docx；老式 .doc 请先用 Word 另存为 .docx 再导入');
    }
    const doc = zip.file('word/document.xml');
    if (!doc) throw new Error('Word 文档结构异常（缺少 document.xml），请确认文件为有效的 .docx');
    const xml = doc.asText();
    // 按段落切分：<w:p ...>...</w:p>；每段提取样式与全部 <w:t> 文本
    const paras = xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? [];
    const lines: string[] = [];
    for (const p of paras) {
      const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(p)?.[1] ?? '';
      const text = (p.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) ?? [])
        .map((t) => t.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
        .join('')
        .trim();
      if (!text) continue;
      // 标题样式识别：Heading1-4 / 纯数字 / 中文「标题N」——统一转 # 前缀保留文档层级
      const level = Number((/^Heading(\d)$/i.exec(style) ?? /^(\d)$/.exec(style) ?? /(\d)/.exec(style))?.[1] ?? 0);
      if (level >= 1 && level <= 4) {
        lines.push(`${'#'.repeat(level)} ${text}`);
      } else {
        // 非标题段落直接保留文本（列表编号在文本内，AI 可从编号语义识别层级）
        lines.push(text);
      }
      if (lines.length >= MAX_PARSE_ROWS) break;
    }
    if (lines.length === 0) throw new Error('Word 文档中未提取到任何文本内容');
    return lines.join('\n');
  },

  /**
   * AI WBS 拆分：需求文档（Markdown 层级文本）→ 有序计划条目。
   * 要求 AI 按 WBS 规范拆分（编号表达层级）、估算工期、保留原文关键信息、不虚构。
   * startDate 不输出——保存后由系统工作日串行排期统一生成。
   */
  async aiParseWbs(toolId: string, docText: string): Promise<{
    drafts: Array<{ title: string; description: string; startDate: string; durationDays: number; assignee: string; status: PlanStatus }>;
  }> {
    const system = [
      '你是 MTask 的项目计划 WBS 拆分助手。给定一份需求文档（Markdown 层级文本，# 数量表示标题层级），请：',
      '0. 先识别文档类型：若为「调研报告/PRD/优化建议」类文档（内含多条编号的优化需求/建议清单，如 P0/P1/P2 或 UX-1/AI-1 等），应拆分的是**文档中提出的需求条目**（每条建议=一个任务），而非文档的撰写步骤；若为「功能需求/说明书」类文档，才按功能模块拆分实施任务。',
      '1. 按 WBS（工作分解结构）规范把识别出的内容拆分为有序的计划任务：用标题编号表达层级（如 "1 项目启动"、"1.1 需求评审"）',
      '2. 为每个任务估算工期（工作日数，依据任务范围合理估计）',
      '3. 输出 JSON 数组，每元素为：',
      '{"title":"WBS 编号+任务名","description":"该任务对应的需求要点（保留原文关键信息，Markdown）","durationDays":工期工作日数,"assignee":"","status":"todo"}',
      '要求：',
      '1. 只输出 JSON 数组本身，不要任何解释或 Markdown 代码围栏',
      '2. 保留原文关键信息，不虚构、不删改事实内容；文档中没有的负责人/日期字段留空',
      '3. 粒度适中：建议 5~30 条，任务应可在数个工作日内完成',
      '4. startDate 一律输出空串（保存后由系统按工作日串行排期自动生成）',
      '5. status 一律输出 "todo"',
    ].join('\n');
    const ai = await AIService.ask(toolId, system, `【需求文档】\n${docText}`);
    if (!ai.ok || !ai.content) throw new Error(`AI 拆分失败：${ai.error ?? '模型未返回结果'}`);
    const drafts = parseJsonArrayWithRecovery(ai.content, 'AI 未返回有效的 WBS 数组，请检查文档内容或更换模型');
    const items: Array<{ title: string; description: string; startDate: string; durationDays: number; assignee: string; status: PlanStatus }> = [];
    for (const r of drafts) {
      if (!r || typeof r !== 'object') continue;
      const o = r as Record<string, unknown>;
      const title = typeof o.title === 'string' ? o.title.trim() : '';
      if (!title) continue;
      items.push({
        title,
        description: typeof o.description === 'string' ? o.description : '',
        startDate: '',
        durationDays: Math.max(1, Math.floor(Number(o.durationDays) || 1)),
        assignee: typeof o.assignee === 'string' ? o.assignee : '',
        status: 'todo',
      });
    }
    if (items.length === 0) throw new Error('AI 未能从文档中拆分出任何任务，请确认文档内容或更换模型');
    return { drafts: items };
  },

  /**
   * AI 解析：把表格文本交给所选模型，识别计划条目并输出标准结构草稿（不入库，返回前端预览确认）。
   * 校验与归一化在服务端完成：title 必填、startDate 规范化（非法置空由重排兜底）、durationDays≥1、status 枚举。
   */
  async aiParseDrafts(toolId: string, tableText: string): Promise<{
    drafts: Array<{ title: string; description: string; startDate: string; durationDays: number; assignee: string; status: PlanStatus }>;
  }> {
    const system = [
      '你是 MTask 的项目计划解析助手。给定来自用户上传 Excel 的表格文本（每行一条记录，单元格以「 | 」分隔，列含义未知，可能含表头/说明/汇总行）。',
      '请识别其中的项目计划条目，输出 JSON 数组，每元素为：',
      '{"title":"任务名称(必填)","description":"描述(无则空串)","startDate":"YYYY-MM-DD(无法识别则空串)","durationDays":工期工作日数(默认1),"assignee":"负责人(无则空串)","status":"todo|doing|done|blocked(默认todo)"}',
      '要求：',
      '1. 只输出 JSON 数组本身，不要任何解释或 Markdown 代码围栏',
      '2. 中文/异构日期（如 9月14日、2026.9.14、14/9）转换为 YYYY-MM-DD；无法可靠识别则 startDate 置空串',
      '3. 工期/天数/持续列给出 durationDays；缺失默认 1；不允许小于 1',
      '4. 状态列映射到 todo/doing/done/blocked；无法识别默认 todo',
      '5. 跳过表头行、空行、纯说明/汇总行；不要虚构任务',
    ].join('\n');
    const ai = await AIService.ask(toolId, system, `【Excel 表格文本】\n${tableText}`);
    if (!ai.ok || !ai.content) throw new Error(`AI 解析失败：${ai.error ?? '模型未返回结果'}`);
    // 剥离代码围栏后提取 JSON 数组（带截断恢复，同 aiParseWbs）
    const arr = parseJsonArrayWithRecovery(ai.content, 'AI 未返回有效的计划数组，请检查文件内容或更换模型');
    const drafts: Array<{ title: string; description: string; startDate: string; durationDays: number; assignee: string; status: PlanStatus }> = [];
    for (const r of arr) {
      if (!r || typeof r !== 'object') continue;
      const o = r as Record<string, unknown>;
      const title = typeof o.title === 'string' ? o.title.trim() : '';
      if (!title) continue;
      const status = ['todo', 'doing', 'done', 'blocked'].includes(String(o.status)) ? (String(o.status) as PlanStatus) : 'todo';
      const duration = Math.max(1, Math.floor(Number(o.durationDays) || 1));
      const sd = typeof o.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.startDate.trim()) ? o.startDate.trim() : '';
      drafts.push({
        title,
        description: typeof o.description === 'string' ? o.description : '',
        startDate: sd,
        durationDays: duration,
        assignee: typeof o.assignee === 'string' ? o.assignee : '',
        status,
      });
    }
    if (drafts.length === 0) throw new Error('AI 未能从文件中识别出任何计划条目，请确认文件内容或更换模型');
    return { drafts };
  },

  /** 批量创建（AI 导入确认保存/其他批量来源）：事务插入后统一重排；首条用其 startDate 作锚点 */
  createBatch(projectId: string, items: Array<{ title: string; description?: string; startDate?: string; durationDays?: number; assignee?: string; status?: PlanStatus }>): { inserted: number } {
    if (!getDb().prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new Error('项目不存在');
    const clean = items.filter((it) => it.title && it.title.trim());
    if (clean.length === 0) throw new Error('没有可创建的计划条目');
    if (clean.length > 5000) throw new Error('单次创建上限 5000 条');
    const db = getDb();
    const t = now();
    const holidays = loadHolidaySet();
    db.transaction(() => {
      const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM plan_tasks WHERE project_id = ? AND archived = 0').get(projectId) as { m: number }).m;
      const existingCount = maxOrder + 1;
      clean.forEach((it, i) => {
        const first = existingCount === 0 && i === 0;
        const duration = Math.max(1, Math.floor(Number(it.durationDays) || 1));
        const status = PLAN_STATUSES.includes(it.status as PlanStatus) ? (it.status as PlanStatus) : 'todo';
        const start = first && it.startDate && /^\d{4}-\d{2}-\d{2}$/.test(it.startDate) ? it.startDate : '';
        const end = start ? calcEndDate(start, duration, holidays) : '';
        db.prepare(
          `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
             progress, status, assignee, sort_order, linked_task_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, ?)`,
        ).run(uuid(), projectId, it.title.trim(), it.description ?? '', start, end, duration, status, it.assignee ?? '', maxOrder + 1 + i, t, t);
      });
      rescheduleAll(db, projectId);
    })();
    notifyChange('plans');
    return { inserted: clean.length };
  },
};
