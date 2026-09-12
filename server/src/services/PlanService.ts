/**
 * 项目计划服务（T00431）：计划任务 CRUD、串行瀑布时间线重排（避开周末与节假日）、
 * Excel 导入/导出（exceljs）、计划→待办状态联动。设计文档见 docs/PRD-项目计划.md。
 */
import { getDb } from '../db/connection';
import { v4 as uuid } from 'uuid';
import ExcelJS from 'exceljs';

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
  created_at: string;
  updated_at: string;
  /** 查询附带：关联待办标题（不存在则为 null） */
  linked_task_title?: string | null;
  /** 查询附带：关联待办是否已删除 */
  linked_task_missing?: boolean;
}

export type PlanStatus = 'todo' | 'doing' | 'done' | 'blocked';

const PLAN_STATUSES: PlanStatus[] = ['todo', 'doing', 'done', 'blocked'];

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
    'SELECT id, start_date, duration_days, sort_order FROM plan_tasks WHERE project_id = ? AND sort_order >= ? ORDER BY sort_order',
  ).all(projectId, fromOrder) as Array<Pick<PlanTaskRow, 'id' | 'start_date' | 'duration_days' | 'sort_order'>>;
  let prevEnd: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let start: string;
    if (i === 0) {
      start = opts.firstStartDate ?? (opts.afterEndDate ? nextWorkday(opts.afterEndDate, holidays) : r.start_date);
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
  list(projectId: string): PlanTaskRow[] {
    const rows = getDb().prepare(
      `SELECT p.*, t.title AS linked_task_title
       FROM plan_tasks p LEFT JOIN tasks t ON t.id = p.linked_task_id
       WHERE p.project_id = ? ORDER BY p.sort_order`,
    ).all(projectId) as Array<PlanTaskRow & { linked_task_title: string | null }>;
    return rows.map((r) => ({
      ...r,
      linked_task_missing: r.linked_task_id != null && r.linked_task_title == null,
    }));
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
    const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM plan_tasks WHERE project_id = ?').get(input.projectId) as { m: number }).m;
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

  /** 删除：事务内从删除位置衔接重排（取删除位前一个任务的结束日作顺延锚点） */
  remove(id: string): boolean {
    const db = getDb();
    const row = this.get(id);
    if (!row) return false;
    db.transaction(() => {
      db.prepare('DELETE FROM plan_tasks WHERE id = ?').run(id);
      const prev = db.prepare(
        'SELECT end_date FROM plan_tasks WHERE project_id = ? AND sort_order < ? ORDER BY sort_order DESC LIMIT 1',
      ).get(row.project_id, row.sort_order) as { end_date: string } | undefined;
      rescheduleFrom(db, row.project_id, row.sort_order, prev ? { afterEndDate: prev.end_date } : {});
    })();
    return true;
  },

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

  /** 由计划任务创建新待办（接收计划标题/描述），并直接关联 */
  createLinkedTodo(id: string): { plan: PlanTaskRow; taskId: string } {
    const db = getDb();
    const row = this.get(id);
    if (!row) throw new Error('计划任务不存在');
    if (row.linked_task_id) throw new Error('已关联待办，请先解除关联');
    const taskId = uuid();
    const t = now();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO tasks (id, project_id, title, description, priority, status, verified, archived, pinned, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'normal', ?, 0, 0, 0, ?, ?)`,
      ).run(taskId, row.project_id, `[计划] ${row.title}`, row.description || '', taskStatusForPlan(row.status), t, t);
      db.prepare('UPDATE plan_tasks SET linked_task_id = ?, updated_at = ? WHERE id = ?').run(taskId, now(), id);
    })();
    return { plan: this.get(id)!, taskId };
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
      const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM plan_tasks WHERE project_id = ?').get(projectId) as { m: number }).m;
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
  async templateExcel(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
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
};
