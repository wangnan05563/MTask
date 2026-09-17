/**
 * 项目计划服务（T00431）：计划任务 CRUD、串行瀑布时间线重排（避开周末与节假日）、
 * Excel 导入/导出（exceljs）、计划→待办状态联动。设计文档见 docs/PRD-项目计划.md。
 */
import { getDb } from '../db/connection';
import { v4 as uuid } from 'uuid';
import ExcelJS from 'exceljs';
import { AIService } from './AIService';
import { nextTaskNo } from './TaskService'; // T00662：PRD 导入生成待办复用统一编号生成器
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
  /** T00490：记录字体颜色，空串=默认色 */
  color: string;
  /** T00499：前置依赖 JSON [{id,type:'serial'|'parallel'}]，空=无依赖 */
  deps: string;
  /** T00506：任务类型 normal=普通、milestone=阶段里程碑、daily=日常任务 */
  kind: string;
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

/** T00500 验证修正：计划表共用美化（模板/导出同源）——冻结首行由 addWorksheet views 配置，
 *  此处负责深蓝表头白字加粗 + 指定列居中；centerKeys 由调用方显式传入（getColumn 对未知 key 会新建列导致越界，T00516 冒烟实测） */
function applyPlanSheetStyle(ws: ExcelJS.Worksheet, centerKeys: string[]): void {
  const header = ws.getRow(1);
  header.height = 22;
  header.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
    c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    c.alignment = { vertical: 'middle', horizontal: 'center' };
    c.border = { bottom: { style: 'thin', color: { argb: 'FF1F4E79' } } };
  });
  for (const key of centerKeys) ws.getColumn(key).alignment = { horizontal: 'center' };
}

/**
 * 从 AI 输出中提取 JSON 数组，带截断恢复（T00439）：
 * 大文档拆分时输出可能被 max_tokens 截断（JSON 未闭合），此时退化到
 * 「最后一个完整对象 + ]」补全重试，尽量抢救已生成的大部分条目。
 */
/** T00652+：扫描文本中所有**顶层 {...} 对象**（括号配平，跳过字符串与转义）。
 *  兼容大模型 JSON 瑕疵：数组元素间缺逗号、NDJSON、夹杂说明文字、尾部截断。 */
function extractTopLevelObjects(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let depth = 0;
  let startIdx = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === String.fromCharCode(92)) esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') {
      if (depth === 0) startIdx = i;
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0 && startIdx >= 0) {
        try {
          const o = JSON.parse(text.slice(startIdx, i + 1)) as unknown;
          if (o && typeof o === 'object' && !Array.isArray(o)) out.push(o as Record<string, unknown>);
        } catch { /* 跳过损坏对象 */ }
        startIdx = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return out;
}

function parseJsonArrayWithRecovery(text: string, notFoundMsg: string): unknown[] {
  const bare = text.replaceAll(/```json/gi, '').replaceAll(/```/gi, '').trim();
  const start = bare.indexOf('[');
  if (start === -1) throw new Error(notFoundMsg);
  const end = bare.lastIndexOf(']');
  try {
    const arr: unknown = JSON.parse(bare.slice(start, end > start ? end + 1 : start + 1));
    if (Array.isArray(arr)) return arr;
  } catch {
    // 截断恢复：JSON.parse 完整数组失败，尝试到「最后一个 }」为止补 ]
    const lastObj = bare.lastIndexOf('}');
    if (lastObj > start) {
      try {
        const arr: unknown = JSON.parse(bare.slice(start, lastObj + 1) + ']');
        if (Array.isArray(arr)) return arr;
      } catch { /* 落到对象扫描回退 */ }
    }
  }
  // T00652+ 回退：逐对象扫描——模型常在数组元素间**漏写逗号**（整体 parse 必失败），
  // 逐对象提取可完整救回（原实现直接抛错，导致「有结论却无数据」）
  const objs = extractTopLevelObjects(bare);
  if (objs.length > 0) return objs;
  throw new Error(notFoundMsg);
}

/** T00662：对象型 JSON 恢复解析（PRD 解析返回 {requirements, plans}）——剥离围栏、截断续补 */
function parseJsonObjectWithRecovery(text: string, notFoundMsg: string): Record<string, unknown> {
  const bare = text.replaceAll(/```json/gi, '').replaceAll(/```/gi, '').trim();
  const start = bare.indexOf('{');
  if (start === -1) throw new Error(notFoundMsg);
  const end = bare.lastIndexOf('}');
  if (end <= start) throw new Error(notFoundMsg);
  let obj: unknown;
  try {
    obj = JSON.parse(bare.slice(start, end + 1));
  } catch {
    throw new Error(notFoundMsg);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(notFoundMsg);
  return obj as Record<string, unknown>;
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
  if (typeof v === 'object' && 'text' in v) return String((v as { text: unknown }).text);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v); // NOSONAR - 前置 typeof 已排除 object 分支，此处仅剩 string/number/boolean/bigint
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

// ---------- T00561：显式依赖驱动排期（去掉默认串行链） ----------
// 旧行为：rescheduleFrom 把全部任务按串行瀑布隐式串联——任意任务日期/工期变动，后续全部顺延。
// 新行为：任务默认无依赖（各自保持日期）；仅当显式配置 deps（serial/parallel 指向前置任务）时联动：
//   serial：start = 全部串行前置 end 的下一工作日；parallel：start = 前置任务 start。
// 传播：从变更任务出发沿 deps 引用关系 BFS，日期有变化才继续向下传播。

/** 单任务工期收尾：end = start 起按工作日计 duration 天 */
function refreshTaskEnd(db: ReturnType<typeof getDb>, id: string, start: string, duration: number): void {
  const end = calcEndDate(start, Math.max(1, duration), loadHolidaySet());
  db.prepare("UPDATE plan_tasks SET start_date = COALESCE(NULLIF(?, ''), start_date), end_date = ?, updated_at = ? WHERE id = ?")
    .run(start, end, now(), id);
}

/** 沿显式 deps 依赖图传播重算（BFS）：serial 后移 / parallel 对齐前置开始日 */
function rescheduleDependents(db: ReturnType<typeof getDb>, projectId: string, seedId: string): void {
  const holidays = loadHolidaySet();
  const all = db.prepare(
    'SELECT id, title, start_date, end_date, duration_days, deps, kind FROM plan_tasks WHERE project_id = ? AND archived = 0',
  ).all(projectId) as Array<{ id: string; title: string; start_date: string; end_date: string; duration_days: number; deps: string; kind: string }>;
  const map = new Map(all.map((r) => [r.id, { ...r }]));
  const upd = db.prepare('UPDATE plan_tasks SET start_date = ?, end_date = ?, updated_at = ? WHERE id = ?');
  const t = now();
  const queue = [seedId];
  const touched = new Set<string>([seedId]);
  while (queue.length > 0) {
    const seed = map.get(queue.shift()!);
    if (!seed) continue;
    for (const row of all) {
      if (touched.has(row.id)) continue;
      let deps: Array<{ id: string; type: string }> = [];
      try { deps = JSON.parse(row.deps || '[]') as Array<{ id: string; type: string }>; } catch { deps = []; }
      const rel = deps.find((d) => d.id === seed.id);
      if (!rel) continue;
      let start = row.start_date;
      if (rel.type === 'serial') {
        const ends = deps.filter((d) => d.type === 'serial')
          .map((d) => map.get(d.id)?.end_date)
          .filter(isDate).sort();
        if (ends.length > 0) start = nextWorkday(ends[ends.length - 1], holidays);
        else continue; // 串行前置已缺失：保持现状（徽标已标注「已删除」）
      } else {
        if (!isDate(seed.start_date)) continue;
        start = seed.start_date; // parallel：与前置同日开工
      }
      const end = calcEndDate(start, Math.max(1, row.duration_days), holidays);
      if (start !== row.start_date || end !== row.end_date) {
        upd.run(start, end, t, row.id);
        row.start_date = start; row.end_date = end;
        touched.add(row.id); queue.push(row.id);
      }
    }
  }
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
 *
 * 性能：UPDATE 语句**预编译一次**（原实现把 db.prepare 放在循环体内，重排 N 行要编译 N 次语句，
 * 在 2000+ 计划规模下是主要开销）；updated_at 取同一次 now()，避免逐行构造时间戳。
 */
function rescheduleFrom(db: ReturnType<typeof getDb>, projectId: string, fromOrder: number, opts: RescheduleOpts = {}): void {
  const holidays = loadHolidaySet();
  const rows = db.prepare(
    'SELECT id, start_date, duration_days, sort_order FROM plan_tasks WHERE project_id = ? AND archived = 0 AND sort_order >= ? ORDER BY sort_order',
  ).all(projectId, fromOrder) as Array<Pick<PlanTaskRow, 'id' | 'start_date' | 'duration_days' | 'sort_order'>>;
  if (rows.length === 0) return;
  const upd = db.prepare('UPDATE plan_tasks SET start_date = ?, end_date = ?, updated_at = ? WHERE id = ?');
  const t = now();
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
    upd.run(start, end, t, r.id);
    prevEnd = end;
  }
}

/** 合法 YYYY-MM-DD 判定（用于容忍建行后尚未重排的 end_date='' 过渡态） */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isDate(s: string | null | undefined): s is string {
  return typeof s === 'string' && DATE_RE.test(s);
}

/**
 * 首个「可能受某日期变更影响」行的 sort_order；无则 null（该项目在该日期前已全部结束，时间线不受影响）。
 *
 * 依据：串行瀑布下 end_date 随 sort_order 单调不减，故 end_date < sinceDate 的行不可能受影响
 * （其 start/end 全落在 sinceDate 之前，工作日计数与串行推导均不变）。
 * end_date='' （建行后未重排的过渡态）视为受影响，避免漏排。
 */
function firstAffectedOrder(db: ReturnType<typeof getDb>, projectId: string, sinceDate: string): number | null {
  const row = db.prepare(
    "SELECT sort_order FROM plan_tasks WHERE project_id = ? AND archived = 0 AND (end_date = '' OR end_date >= ?) ORDER BY sort_order LIMIT 1",
  ).get(projectId, sinceDate) as { sort_order: number } | undefined;
  return row ? row.sort_order : null;
}

/** 某 sort_order 之前最近一行的结束日（用于「从某位置起衔接」时取锚点） */
function prevEndBefore(db: ReturnType<typeof getDb>, projectId: string, sortOrder: number): string | null {
  const prev = db.prepare(
    'SELECT end_date FROM plan_tasks WHERE project_id = ? AND archived = 0 AND sort_order < ? ORDER BY sort_order DESC LIMIT 1',
  ).get(projectId, sortOrder) as { end_date: string } | undefined;
  return prev && isDate(prev.end_date) ? prev.end_date : null;
}

/**
 * T00470：启动对账——待办与计划状态一致性兜底。
 * 背景：AI/脚本可能直写 sqlite（绕过 TaskService.update 的 syncPlanOnStatusChange），
 * 导致 task=done 而关联 plan 仍非 done。启动时按「task done → plan done + progress 100」
 * 单向对齐（保守：不反向改写 plan→todo/doing，避免覆盖用户手动排期语义）。
 * 返回对齐行数（用于启动日志观测）。
 */
export function reconcileLinkedPlanStatuses(): number {
  const db = getDb();
  const r = db.prepare(
    `UPDATE plan_tasks SET status = 'done', progress = 100, updated_at = ?
     WHERE archived = 0 AND linked_task_id IS NOT NULL AND status != 'done'
       AND linked_task_id IN (SELECT id FROM tasks WHERE status = 'done')`,
  ).run(now());
  return r.changes;
}

/** 计划状态 → 关联待办状态映射（MTask 待办仅「待办/完成」两态） */
function taskStatusForPlan(ps: PlanStatus): 'todo' | 'done' {
  return ps === 'done' ? 'done' : 'todo';
}

/** AI 条目标准结构（草稿） */
type PlanDraft = { title: string; description: string; startDate: string; durationDays: number; assignee: string; status: PlanStatus };

/** AI 原始条目 → 标准计划草稿：title 必填，startDate 规范化，durationDays≥1，status 枚举兜底；非法条目返回 null */
function normalizeDraft(entry: unknown): PlanDraft | null {
  if (!entry || typeof entry !== 'object') return null;
  const o = entry as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  if (!title) return null;
  const statusRaw = String(o.status);
  const status = PLAN_STATUSES.has(statusRaw as PlanStatus) ? (statusRaw as PlanStatus) : 'todo';
  const startDate = typeof o.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.startDate.trim()) ? o.startDate.trim() : '';
  return {
    title,
    description: typeof o.description === 'string' ? o.description : '',
    startDate,
    durationDays: Math.max(1, Math.floor(Number(o.durationDays) || 1)),
    assignee: typeof o.assignee === 'string' ? o.assignee : '',
    status,
  };
}

// ---------- 服务 ----------

export const PlanService = {
  /** 活跃计划列表（排除已归档；归档条目走 listArchived，T00442 语义：删除=归档） */
  list(projectId: string): PlanTaskRow[] {
    const rows = getDb().prepare(
      `SELECT p.*, t.title AS linked_task_title
       FROM plan_tasks p LEFT JOIN tasks t ON t.id = p.linked_task_id
       WHERE p.project_id = ? AND p.archived = 0 AND COALESCE(p.history_at, '') = '' ORDER BY p.sort_order`,
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
  create(input: { projectId: string; title: string; description?: string; startDate?: string; durationDays?: number; assignee?: string; status?: PlanStatus; kind?: string }): PlanTaskRow {
    const db = getDb();
    const title = String(input.title ?? '').trim();
    if (!title) throw new Error('标题必填');
    if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(input.projectId)) throw new Error('项目不存在');
    const status = PLAN_STATUSES.has(input.status as PlanStatus) ? (input.status as PlanStatus) : 'todo';
    const duration = Math.max(1, Math.floor(Number(input.durationDays) || 1));
    const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM plan_tasks WHERE project_id = ? AND archived = 0').get(input.projectId) as { m: number }).m;
    const first = maxOrder < 0;
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    let start = '';
    if (first) {
      start = input.startDate && dateRe.test(input.startDate) ? input.startDate : fmt(new Date());
    }
    const id = uuid();
    const t = now();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
           progress, status, assignee, sort_order, linked_task_id, kind, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, ?, ?)`,
      ).run(id, input.projectId, title, input.description ?? '', start, start, duration, status, input.assignee ?? '', maxOrder + 1, (input as { kind?: string }).kind ?? 'normal', t, t);
      // T00561：去掉默认串行依赖——新任务保持自身日期，不重排他人；显式依赖者（若引用新任务）传播
      refreshTaskEnd(db, id, start, duration);
    })();
    return this.get(id)!;
  },

  /** 更新：标题/描述/工期/进度/状态/负责人；开始日与工期变化会触发从该任务起的时间线重排 */
  update(id: string, patch: { title?: string; description?: string; startDate?: string; durationDays?: number; progress?: number; status?: PlanStatus; assignee?: string; color?: string; deps?: string; kind?: string }): PlanTaskRow | null {
    const db = getDb();
    const row = this.get(id);
    if (!row) return null;
    const title = patch.title === undefined ? row.title : String(patch.title).trim();
    if (!title) throw new Error('标题必填');
    const duration = patch.durationDays === undefined ? row.duration_days : Math.max(1, Math.floor(Number(patch.durationDays) || 1));
    let status = row.status;
    let linkedTaskId = row.linked_task_id;
    db.transaction(() => {
      // 状态变更先落列，再同步关联待办（同步读取最新 plan 状态）
      if (patch.status !== undefined && PLAN_STATUSES.has(patch.status)) status = patch.status;
      const startDateChanged = patch.startDate !== undefined && patch.startDate !== row.start_date;
      db.prepare(
        `UPDATE plan_tasks SET title = ?, description = ?, start_date = ?, duration_days = ?,
           progress = ?, status = ?, assignee = ?, color = ?, deps = ?, kind = ?, updated_at = ? WHERE id = ?`,
      ).run(
        title,
        patch.description ?? row.description,
        patch.startDate ?? row.start_date,
        duration,
        patch.progress === undefined ? row.progress : Math.min(100, Math.max(0, Math.floor(Number(patch.progress) || 0))),
        status,
        patch.assignee ?? row.assignee,
        patch.color === undefined ? (row.color ?? '') : patch.color,
        patch.deps === undefined ? (row.deps ?? '') : patch.deps,
        patch.kind === undefined ? (row.kind ?? 'normal') : patch.kind,
        now(),
        id,
      );
      // T00561：去掉默认串行链——变更只影响本任务（end 重算），仅显式配置依赖的任务联动传播
      const cur = this.get(id)!;
      db.prepare('UPDATE plan_tasks SET end_date = ? WHERE id = ?')
        .run(calcEndDate(cur.start_date, cur.duration_days, loadHolidaySet()), id);
      rescheduleDependents(db, row.project_id, id);
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
    })();
    notifyChange('plans');
    return true;
  },

  /** 恢复：取消归档并插回原排序位衔接重排（前序取恢复位之前最近的未归档任务） */
  restore(id: string): boolean {
    const db = getDb();
    const row = this.get(id);
    if (!row?.archived) return false;
    db.transaction(() => {
      db.prepare('UPDATE plan_tasks SET archived = 0, archived_at = NULL, updated_at = ? WHERE id = ?').run(now(), id);
      const prev = db.prepare(
        'SELECT end_date FROM plan_tasks WHERE project_id = ? AND archived = 0 AND sort_order < ? ORDER BY sort_order DESC LIMIT 1',
      ).get(row.project_id, row.sort_order) as { end_date: string } | undefined;
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
    // 首个顺序变化的位置：之前的行顺序未变 → 其日期链完全不受影响，无需重排（原实现无条件 rescheduleAll）
    const before = active.map((r) => r.id);
    let firstChanged = 0;
    while (firstChanged < orderedIds.length && orderedIds[firstChanged] === before[firstChanged]) firstChanged++;
    if (firstChanged >= orderedIds.length) return { reordered: orderedIds.length }; // 顺序一致，无副作用
    const db = getDb();
    const t = now();
    db.transaction(() => {
      const upd = db.prepare('UPDATE plan_tasks SET sort_order = ?, updated_at = ? WHERE id = ?');
      orderedIds.forEach((id, i) => upd.run(i, t, id));
      // 从首个变化位置起衔接：锚点取该位置前一行的结束日；位置 0 变化时保留首行自身 start_date
      // T00561：排序仅改展示顺序，不再联动日期（去默认串行链）
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
    // T00555 / PRD INT-5：来源标注——描述首行标注来源通用需求，便于计划侧溯源
    this.createBatch(projectId, [{ title: `[需求] ${entry.title}`, description: `来源：通用需求「${entry.title}」\n\n${entry.content ?? ''}` }]);
    return { plan: this.list(projectId).at(-1)! };
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
      const start = fmt(new Date());
      db.prepare(
        `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
           progress, status, assignee, sort_order, linked_task_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 0, 'todo', '', ?, NULL, ?, ?)`,
      ).run(id, after.project_id, trimmed, description ?? '', start, start, after.sort_order + 1, t, t);
      // T00561：新插入行保持自身日期（今天起 1 天），不重排后续
      refreshTaskEnd(db, id, start, 1);
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
    if (!DATE_RE.test(date)) throw new Error('日期格式应为 YYYY-MM-DD');
    getDb().prepare('INSERT INTO holidays (date, name) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET name = excluded.name')
      .run(date, name.trim());
    // 只有「结束日 ≥ 该日期」的计划行可能受影响（该日期前已结束的行工作日计数不变）
    this.rescheduleFromDate(date);
  },

  removeHoliday(date: string): boolean {
    const r = getDb().prepare('DELETE FROM holidays WHERE date = ?').run(date);
    if (r.changes > 0) this.rescheduleFromDate(date);
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
    if (data?.code !== 0 || !data?.holiday) throw new Error('节假日数据源返回异常');
    const items: Array<{ date: string; name: string }> = [];
    for (const [k, v] of Object.entries(data.holiday)) {
      if (v?.holiday !== true) continue; // 跳过调休补班日
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
    // 以导入的最早日期为界重排（更早的日期之前已结束的行不受影响）
    this.rescheduleFromDate(items.map((i) => i.date).sort((a, b) => a.localeCompare(b))[0]);
    return { imported: items.length, items };
  },

  /**
   * 节假日变更后的时间线重排：只处理「结束日 ≥ sinceDate」的部分。
   *
   * 原实现无条件全量重排**所有项目的所有计划行**（PlanService.rescheduleAllProjects），
   * 节假日多在未来时等于白算一遍全库；实测「新增节假日」单发 30ms@单线程 / 137ms@探针。
   * 传入 sinceDate 后：该日期前已结束的项目整段跳过（firstAffectedOrder 返回 null），
   * 其余项目从首个受影响行起串行重排。不传 sinceDate 时退化为全量重排（保留原语义）。
   */
  rescheduleFromDate(sinceDate?: string): void {
    const db = getDb();
    const ids = (db.prepare('SELECT DISTINCT project_id FROM plan_tasks WHERE archived = 0').all() as Array<{ project_id: string }>)
      .map((r) => r.project_id);
    for (const pid of ids) {
      // T00561：新排期模型下任务日期独立——节假日变更只刷新各行 end（start 不动），不触发串行顺延
      const rows = db.prepare('SELECT id, start_date, duration_days FROM plan_tasks WHERE project_id = ? AND archived = 0').all(pid) as Array<{ id: string; start_date: string; duration_days: number }>;
      const holidays = loadHolidaySet();
      const upd = db.prepare('UPDATE plan_tasks SET end_date = ?, updated_at = ? WHERE id = ?');
      const t = now();
      db.transaction(() => {
        for (const r of rows) {
          if (!isDate(r.start_date)) continue;
          upd.run(calcEndDate(r.start_date, Math.max(1, r.duration_days), holidays), t, r.id);
        }
      })();
    }
  },

  /** 节假日变更影响所有项目的时间线，全量重排（保留原语义，供需要强一致的场景调用） */
  rescheduleAllProjects(): void {
    this.rescheduleFromDate();
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

    // T00553：按表头名映射列（兼容任意列序）——导出列序调整后固定列序解析会把日期当工期
    const colMap: Record<string, number> = {};
    ws.getRow(1).eachCell((c, n) => {
      const h = cellValueText(c.value).trim();
      if (!h) return;
      if (h.includes('标题') || h.includes('任务名称')) colMap['title'] = n;
      else if (h.includes('描述')) colMap['description'] = n;
      else if (h.includes('开始')) colMap['start'] = n;
      else if (h.includes('结束')) colMap['end'] = n;
      else if (h.includes('工期') || h.includes('工时')) colMap['duration'] = n;
      else if (h.includes('进度')) colMap['progress'] = n;
      else if (h.includes('状态')) colMap['status'] = n;
      else if (h.includes('负责人')) colMap['assignee'] = n;
    });
    if (!colMap['title'] || !colMap['start']) throw new Error('表头缺少「标题」或「开始日期」列，请使用导出/模板同构的文件');
    const existingTitles = new Set(
      (getDb().prepare('SELECT title FROM plan_tasks WHERE project_id = ?').all(projectId) as Array<{ title: string }>).map((r) => r.title),
    );
    const seenTitles = new Set<string>();

    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // 表头
      const cell = (name: string): string => (colMap[name] ? cellValueText(row.getCell(colMap[name]).value).trim() : '');
      const title = cell('title');
      const description = cell('description');
      const startDate = cell('start');
      const endDate = cell('end');
      const durationRaw = cell('duration');
      const assignee = cell('assignee');
      const statusRaw = cell('status').toLowerCase() || 'todo';
      if (!title && !description && !startDate && !durationRaw && !endDate) return; // 整行空跳过
      const fail = (message: string) => errors.push({ row: rowNumber, message });

      if (!title) { fail('标题必填'); return; }
      if (existingTitles.has(title) || seenTitles.has(title)) { fail(`标题与现有/前文计划重复：${title}`); return; }
      let start: string;
      try { start = fmt(parseDate(startDate)); } catch { fail(`开始日期非法：${startDate || '(空)'}（应为 YYYY-MM-DD）`); return; }
      // T00553：工期缺失/非法但起止齐全时按自然日差换算（≥1）
      let duration = Number(durationRaw);
      if (!Number.isInteger(duration) || duration < 1) {
        if (endDate) {
          try {
            const s0 = new Date(start).getTime();
            const e0 = new Date(fmt(parseDate(endDate))).getTime();
            if (Number.isFinite(s0) && Number.isFinite(e0) && e0 >= s0) duration = Math.max(1, Math.round((e0 - s0) / 86400000) + 1);
          } catch { /* 保持非法判定 */ }
        }
      }
      if (!Number.isInteger(duration) || duration < 1) { fail(`工期非法：${durationRaw || '(空)'}（应为 ≥1 的整数，或提供开始/结束日期自动换算）`); return; }
      if (!PLAN_STATUSES.has(statusRaw as PlanStatus)) { fail(`状态非法：${statusRaw}（应为 todo/doing/done/blocked）`); return; }
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
      const ins = db.prepare(
        `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
           progress, status, assignee, sort_order, linked_task_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '', ?, 0, ?, ?, ?, NULL, ?, ?)`,
      );
      const holidays = loadHolidaySet();
      parsed.forEach((p, i) => {
        // T00561：各行日期独立——开始日用自己的（空则今天），end 按工作日计算，不联动他人
        const start = p.startDate || fmt(new Date());
        const end = calcEndDate(start, p.durationDays, holidays);
        ins.run(uuid(), projectId, p.title, p.description, start, end, p.durationDays, p.status, p.assignee, maxOrder + 1 + i, t, t);
      });
    })();
    return { inserted: parsed.length, errors: [] };
  },

  /** 导出：sheet1=计划任务（与模板同列序同样式，T00500 验证修正），sheet2=节假日 */
  async exportExcel(projectId: string): Promise<Buffer> {
    const rows = this.list(projectId);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('项目计划', { views: [{ state: 'frozen', ySplit: 1 }] });
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
    applyPlanSheetStyle(ws, ['start_date', 'end_date', 'duration_days', 'progress', 'status']);
    const hws = wb.addWorksheet('节假日', { views: [{ state: 'frozen', ySplit: 1 }] });
    hws.columns = [{ header: '日期', key: 'date', width: 14 }, { header: '名称', key: 'name', width: 24 }];
    for (const h of this.listHolidays()) hws.addRow(h);
    applyPlanSheetStyle(hws, ['date']);
    const out = await wb.xlsx.writeBuffer();
    return Buffer.from(out);
  },

  /** 模板：表头 + 1 行示例（列序与导出完全一致 8 列，T00500 验证修正：字段/样式三路径一致） */
  async templateExcel(): Promise<Buffer> {    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('项目计划', { views: [{ state: 'frozen', ySplit: 1 }] }); // 冻结表头
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
    ws.addRow({ title: '示例：完成登录模块联调', description: '示例描述（导入前请删除本行）', start_date: '2026-09-14', end_date: '2026-09-16', duration_days: 3, progress: 0, assignee: '张三', status: 'todo' });
    applyPlanSheetStyle(ws, ['start_date', 'end_date', 'duration_days', 'progress', 'status']);
    // 示例行：斜体灰字提示 + 浅分隔线（模板专属）
    const sample = ws.getRow(2);
    sample.font = { italic: true, color: { argb: 'FF808080' }, size: 10 };
    sample.eachCell((c) => { c.border = { bottom: { style: 'hair', color: { argb: 'FFD9D9D9' } } }; });
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
        cells.push(cellValueText(cell.value).trim().replaceAll(/\s*\n\s*/g, ' '));
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
        .map((t) => t.replaceAll(/<[^>]+>/g, '').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'))
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
    // T00723：JSON 解析失败/输出截断自动重试 1 次，且解析成败计入 ai_usage（ask-json）
    const ai = await AIService.askJson(toolId, system, `【需求文档】\n${docText}`, (content) =>
      parseJsonArrayWithRecovery(content, 'AI 未返回有效的 WBS 数组，请检查文档内容或更换模型'),
    );
    if (!ai.ok) throw new Error(`AI 拆分失败：${ai.error}`);
    const drafts = ai.data as unknown[];
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

  // ---------- T00662：从 PRD 导入（AI 拆 WBS + 需求跟踪矩阵） ----------

  /** T00662：PRD 文档 → 文本（多格式分派）。老式 .doc/.xls 与不可解析 PDF 给出可操作的友好提示。 */
  async extractPrdText(buffer: Buffer, filename: string): Promise<string> {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.txt')) return buffer.toString('utf-8');
    if (lower.endsWith('.docx')) return this.docxToMarkdown(buffer);
    if (lower.endsWith('.xlsx') || lower.endsWith('.csv')) return this.tableToTextAsync(buffer, filename);
    if (lower.endsWith('.pdf')) {
      try {
        // 动态导入（编译为 CJS 时保留原生动态 import）：pdf-parse 为纯 JS 解析库，无原生依赖
        const mod = (await import('pdf-parse')) as unknown as { default?: (b: Buffer) => Promise<{ text?: string }> } & ((b: Buffer) => Promise<{ text?: string }>);
        const parse = mod.default ?? mod;
        const r = await parse(buffer);
        const text = String(r?.text ?? '').trim();
        if (!text) throw new Error('未提取到可读文本（可能是扫描件/图片型 PDF）');
        return text;
      } catch (e) {
        throw new Error(`PDF 解析失败：${e instanceof Error ? e.message : String(e)}。可将 PDF 另存为 .docx 或 .md 后重试`);
      }
    }
    if (lower.endsWith('.doc')) throw new Error('老式 .doc 暂不支持，请用 Word 另存为 .docx 后导入');
    if (lower.endsWith('.xls')) throw new Error('老式 .xls 暂不支持，请用 Excel 另存为 .xlsx 后导入');
    throw new Error('不支持的文件格式（支持 .docx / .md / .markdown / .txt / .xlsx / .csv / .pdf）');
  },

  /** T00662：AI 解析 PRD →（需求清单 + WBS 计划草稿，含需求关联）。 */
  async aiParsePrd(toolId: string, docText: string): Promise<{
    requirements: Array<{ reqNo: string; title: string; content: string; sourceRef: string; priority: string }>;
    drafts: Array<{ title: string; description: string; durationDays: number; startDate: string; reqNos: string[]; status: PlanStatus }>;
    coverageWarn?: string;
  }> {
    const system = [
      '你是 MTask 的 PRD 解析助手：既要拆分 WBS 计划，也要**逐条提取可跟踪需求**（用于生成需求跟踪矩阵）。',
      '给定一份 PRD / 需求文档（Markdown 或纯文本），输出**一个 JSON 对象**（不是数组），结构：',
      '{"requirements":[{"reqNo":"REQ-001","title":"需求简述","content":"需求原文要点","sourceRef":"原文定位（章节/小节/段落号）","priority":"low|normal|high|urgent"}],',
      ' "plans":[{"title":"WBS 编号 + 任务名","description":"该节点要做的事（保留原文关键信息）","durationDays":工期工作日数,"startDate":"","reqNos":["REQ-001"]}]}',
      '要求：',
      '1. **需求逐条提取，严禁合并**——PRD 中每条可跟踪的需求（功能/非功能/约束/验收要点）各生成一条 requirements，reqNo 从 REQ-001 顺序编号；',
      '2. plans 按 WBS 规范拆分（标题带编号如 "1 项目启动"、"1.1 需求评审"），每个节点的 reqNos 只填**该节点直接实现/覆盖的需求编号**；',
      '   ——管理类节点（项目启动/计划/评审/验收等）若确实不直接对应某条需求，reqNos 输出空数组 []，**不要把所有需求都挂上**（关联过宽会让需求跟踪矩阵失去意义）；',
      '3. startDate 一律空串（保存后系统按导入当日并行排布：各行独立取导入日为开始日，不做串行顺延）；status 一律 "todo"；durationDays 缺失默认 1；',
      '4. 只输出 JSON 对象本身，不要任何解释或 Markdown 代码围栏；不虚构文档中没有的内容。',
      // T00707：原「宁多勿漏」会把长文档的输出顶到 token 上限而截断（用户实测导入报错），改为规模约束
      '5. **输出规模控制（必须遵守）**：requirements 最多 40 条、plans 最多 25 条；title ≤30 字、content/description ≤40 字。'
      + '文档过长时合并同类需求，宁可少几条也必须保证 JSON 完整闭合——输出被截断会导致整个导入失败。',
    ].join('\n');
    // T00707：首轮若被截断/解析失败，重试改用精简提示词（压缩到更小规模，确保能完整闭合）
    const systemCompact = [
      system,
      '【精简模式·仅本次重试】上次输出超出长度被截断。本次请大幅压缩：requirements ≤20 条（只输出 reqNo 与 title，content 与 sourceRef 输出空串）、'
      + 'plans ≤12 条（只输出 title 与 reqNos，description 空串）；标题 ≤20 字。宁可少，也必须输出完整可解析的 JSON 对象。',
    ].join('\n');
    // T00723：JSON 解析失败/输出截断自动重试 1 次，且解析成败计入 ai_usage（ask-json）
    const ai = await AIService.askJson(toolId, system, `【PRD 文档】\n${docText}`, (content) =>
      parseJsonObjectWithRecovery(content, 'AI 未返回有效的 PRD 解析结果（需 JSON 对象），请检查文档内容或更换模型'),
      undefined, systemCompact,
    );
    if (!ai.ok) throw new Error(`AI 解析失败：${ai.error}`);
    const obj = ai.data as Record<string, unknown>;
    const rawReqs = Array.isArray(obj.requirements) ? obj.requirements : [];
    const requirements: Array<{ reqNo: string; title: string; content: string; sourceRef: string; priority: string }> = [];
    const seenNo = new Set<string>();
    for (const r of rawReqs) {
      if (!r || typeof r !== 'object') continue;
      const o = r as Record<string, unknown>;
      const title = typeof o.title === 'string' ? o.title.trim() : '';
      if (!title) continue;
      let reqNo = typeof o.reqNo === 'string' && o.reqNo.trim() ? o.reqNo.trim() : `REQ-${String(requirements.length + 1).padStart(3, '0')}`;
      if (seenNo.has(reqNo)) reqNo = `${reqNo}-${requirements.length + 1}`;
      seenNo.add(reqNo);
      const pr = typeof o.priority === 'string' && ['low', 'normal', 'high', 'urgent'].includes(o.priority) ? o.priority : 'normal';
      requirements.push({
        reqNo,
        title,
        content: typeof o.content === 'string' ? o.content : '',
        sourceRef: typeof o.sourceRef === 'string' ? o.sourceRef : '',
        priority: pr,
      });
    }
    const rawPlans = Array.isArray(obj.plans) ? obj.plans : [];
    const drafts: Array<{ title: string; description: string; durationDays: number; startDate: string; reqNos: string[]; status: PlanStatus }> = [];
    for (const r of rawPlans) {
      if (!r || typeof r !== 'object') continue;
      const o = r as Record<string, unknown>;
      const title = typeof o.title === 'string' ? o.title.trim() : '';
      if (!title) continue;
      const reqNos = Array.isArray(o.reqNos) ? o.reqNos.filter((x): x is string => typeof x === 'string') : [];
      drafts.push({
        title,
        description: typeof o.description === 'string' ? o.description : '',
        durationDays: Math.max(1, Math.floor(Number(o.durationDays) || 1)),
        startDate: '',
        reqNos,
        status: 'todo',
      });
    }
    if (requirements.length === 0 && drafts.length === 0) throw new Error('AI 未能从 PRD 中解析出需求或计划，请确认文档内容或更换模型');
    const coverageWarn = drafts.length > 0 && requirements.length > 0 && drafts.every((d) => d.reqNos.length === 0)
      ? '本次解析的计划节点未关联到需求编号——可在矩阵面板中手动建立关联'
      : '';
    return { requirements, drafts, coverageWarn };
  },

  /** T00662：导入 PRD 解析结果——事务创建需求项 + 计划（含 req_ids 关联）+ 可选同步生成待办任务。 */
  /** T00712（D-5）：返回 unlinkedReqNos——reqNos 引用了本次导入中不存在的需求编号时不再静默丢弃。 */
  importPrd(projectId: string, input: {
    requirements?: Array<{ reqNo?: string; title: string; content?: string; sourceRef?: string; priority?: string }>;
    plans?: Array<{ title: string; description?: string; durationDays?: number; startDate?: string; reqNos?: string[]; assignee?: string }>;
    createTasks?: boolean;
  }): { requirements: number; plans: number; tasks: number; unlinkedReqNos: string[] } {
    const db = getDb();
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new Error('项目不存在');
    const reqs = (input.requirements ?? []).filter((r) => r?.title?.trim());
    const planItems = (input.plans ?? []).filter((p) => p?.title?.trim());
    if (reqs.length === 0 && planItems.length === 0) throw new Error('没有可导入的需求或计划条目');
    const t = now();
    let taskCount = 0;
    const unlinkedReqNos = new Set<string>();
    db.transaction(() => {
      // 1) 需求项（矩阵行）——reqNo → id 映射供计划/待办关联
      const noToId = new Map<string, string>();
      const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM prd_requirements WHERE project_id = ?').get(projectId) as { m: number }).m;
      let order = maxOrder;
      const insReq = db.prepare(
        `INSERT INTO prd_requirements (id, project_id, req_no, title, content, source_ref, priority, status, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?)`,
      );
      for (const r of reqs) {
        const id = uuid();
        const reqNo = (r.reqNo ?? '').trim() || `REQ-${String(order + 1).padStart(3, '0')}`;
        order += 1;
        insReq.run(id, projectId, reqNo, r.title.trim(), r.content ?? '', r.sourceRef ?? '', r.priority ?? 'normal', order, t, t);
        noToId.set(reqNo, id);
      }
      // 2) 计划（含 req_ids 关联）
      let insertedPlans = 0;
      if (planItems.length > 0) {
        const created = this.createBatch(projectId, planItems.map((p) => ({
          title: p.title,
          description: p.description,
          startDate: p.startDate,
          durationDays: p.durationDays,
          assignee: p.assignee,
          status: 'todo' as PlanStatus,
        })));
        insertedPlans = created.inserted;
        // T00709（D-1 修复）：按 createBatch 返回的 id（与 planItems 同一下标序，两侧 title 过滤口径一致）回写 req_ids，
        // 废弃按标题 find 匹配——同名计划会命中同一行导致关联互相覆盖丢失
        const updPlan = db.prepare('UPDATE plan_tasks SET req_ids = ?, updated_at = ? WHERE id = ?');
        created.ids.forEach((planId, i) => {
          const p = planItems[i];
          if (!p) return;
          const rawNos = p.reqNos ?? [];
          // T00712（D-5）：引用了不存在的需求编号 → 记入 unlinkedReqNos 供调用方提示
          for (const n of rawNos) if (!noToId.has(n)) unlinkedReqNos.add(n);
          const ids = rawNos.map((n) => noToId.get(n)).filter((x): x is string => !!x);
          if (ids.length > 0) updPlan.run(JSON.stringify(ids), t, planId);
        });
      }
      // 3) 可选：WBS → 待办任务（便于 AI 推进执行），待办同样携带 req_ids
      if (input.createTasks && planItems.length > 0) {
        const insTask = db.prepare(
          `INSERT INTO tasks (id, task_no, project_id, title, description, priority, status, verified, archived, pinned, req_ids, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'todo', 0, 0, 0, ?, ?, ?)`,
        );
        for (const p of planItems) {
          const ids = (p.reqNos ?? []).map((n) => noToId.get(n)).filter((x): x is string => !!x);
          insTask.run(uuid(), nextTaskNo(), projectId, `[PRD] ${p.title}`, p.description ?? '', 'normal', ids.length ? JSON.stringify(ids) : null, t, t);
          taskCount += 1;
        }
      }
      if (insertedPlans === 0 && reqs.length > 0) {
        // 仅导入需求（无计划）时属合法场景，不抛错
      }
    })();
    return { requirements: reqs.length, plans: planItems.length, tasks: taskCount, unlinkedReqNos: [...unlinkedReqNos] };
  },

  // ---------- T00662：需求跟踪矩阵 CRUD ----------

  /** 矩阵行列表（按项目；含关联的计划与待办摘要，供矩阵展示「需求 ← 计划/任务」关联关系） */
  listRequirements(projectId: string): Array<Record<string, unknown>> {
    const db = getDb();
    const reqs = db.prepare('SELECT * FROM prd_requirements WHERE project_id = ? ORDER BY sort_order, created_at').all(projectId) as Array<Record<string, unknown>>;
    const plans = db.prepare('SELECT id, title, status, req_ids FROM plan_tasks WHERE project_id = ? AND archived = 0').all(projectId) as Array<{ id: string; title: string; status: string; req_ids: string | null }>;
    const tasks = db.prepare('SELECT id, task_no, title, status, verified, req_ids FROM tasks WHERE project_id = ? AND archived = 0').all(projectId) as Array<{ id: string; task_no: string | null; title: string; status: string; verified: number; req_ids: string | null }>;
    const parse = (v: string | null): string[] => {
      if (!v) return [];
      try { const a = JSON.parse(v) as unknown; return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
    };
    return reqs.map((r) => {
      const rid = String(r.id);
      const linkedPlans = plans.filter((p) => parse(p.req_ids).includes(rid)).map((p) => ({ id: p.id, title: p.title, status: p.status }));
      const linkedTasks = tasks.filter((x) => parse(x.req_ids).includes(rid)).map((x) => ({ id: x.id, taskNo: x.task_no, title: x.title, status: x.status, verified: !!x.verified }));
      return { ...r, linkedPlans, linkedTasks };
    });
  },

  createRequirement(projectId: string, input: { reqNo?: string; title: string; content?: string; sourceRef?: string; priority?: string; status?: string }): Record<string, unknown> {
    const db = getDb();
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new Error('项目不存在');
    const t = now();
    const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM prd_requirements WHERE project_id = ?').get(projectId) as { m: number }).m;
    const id = uuid();
    const reqNo = (input.reqNo ?? '').trim() || `REQ-${String(maxOrder + 1).padStart(3, '0')}`;
    db.prepare(
      `INSERT INTO prd_requirements (id, project_id, req_no, title, content, source_ref, priority, status, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, projectId, reqNo, input.title.trim(), input.content ?? '', input.sourceRef ?? '', input.priority ?? 'normal', input.status ?? 'todo', maxOrder + 1, t, t);
    return db.prepare('SELECT * FROM prd_requirements WHERE id = ?').get(id) as Record<string, unknown>;
  },

  updateRequirement(id: string, patch: { title?: string; content?: string; reqNo?: string; sourceRef?: string; priority?: string; status?: string; sortOrder?: number }): Record<string, unknown> {
    const db = getDb();
    const sets: string[] = [];
    const vals: unknown[] = [];
    const map: Array<[keyof typeof patch, string]> = [['title', 'title'], ['content', 'content'], ['reqNo', 'req_no'], ['sourceRef', 'source_ref'], ['priority', 'priority'], ['status', 'status'], ['sortOrder', 'sort_order']];
    for (const [k, col] of map) {
      const v = patch[k];
      if (v !== undefined) { sets.push(`${col} = ?`); vals.push(v); }
    }
    if (sets.length === 0) return db.prepare('SELECT * FROM prd_requirements WHERE id = ?').get(id) as Record<string, unknown>;
    sets.push('updated_at = ?');
    vals.push(now(), id);
    const r = db.prepare(`UPDATE prd_requirements SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    if (r.changes === 0) throw new Error('需求不存在');
    return db.prepare('SELECT * FROM prd_requirements WHERE id = ?').get(id) as Record<string, unknown>;
  },

  deleteRequirement(id: string): void {
    const db = getDb();
    // 同步清理计划/待办上的关联引用（避免矩阵残留悬空 id）
    const plans = db.prepare("SELECT id, req_ids FROM plan_tasks WHERE COALESCE(req_ids,'') != ''").all() as Array<{ id: string; req_ids: string }>;
    const tasks = db.prepare("SELECT id, req_ids FROM tasks WHERE COALESCE(req_ids,'') != ''").all() as Array<{ id: string; req_ids: string }>;
    const strip = (json: string): string | null => {
      try {
        const a = (JSON.parse(json) as unknown[]).filter((x) => x !== id);
        return a.length > 0 ? JSON.stringify(a) : null;
      } catch { return null; }
    };
    db.transaction(() => {
      for (const p of plans) { const n = strip(p.req_ids); if (n !== p.req_ids) db.prepare('UPDATE plan_tasks SET req_ids = ?, updated_at = ? WHERE id = ?').run(n, now(), p.id); }
      for (const x of tasks) { const n = strip(x.req_ids); if (n !== x.req_ids) db.prepare('UPDATE tasks SET req_ids = ?, updated_at = ? WHERE id = ?').run(n, now(), x.id); }
      db.prepare('DELETE FROM prd_requirements WHERE id = ?').run(id);
    })();
  },

  /** 关联调整：把需求关联到计划/待办（或解除）——矩阵面板的「关联调整」编辑入口 */
  linkRequirement(reqId: string, target: { kind: 'plan' | 'task'; targetId: string; linked: boolean }): void {
    const db = getDb();
    const table = target.kind === 'plan' ? 'plan_tasks' : 'tasks';
    // T00710（D-2 修复）：校验需求与目标同项目（对齐 linkTodo 的同项目约束），防矩阵跨项目混入脏关联
    const req = db.prepare('SELECT project_id FROM prd_requirements WHERE id = ?').get(reqId) as { project_id: string } | undefined;
    if (!req) throw new Error('需求不存在');
    const row = db.prepare(`SELECT req_ids, project_id FROM ${table} WHERE id = ?`).get(target.targetId) as { req_ids: string | null; project_id: string } | undefined;
    if (!row) throw new Error(target.kind === 'plan' ? '计划不存在' : '任务不存在');
    if (req.project_id !== row.project_id) throw new Error(target.kind === 'plan' ? '仅可关联同项目的计划' : '仅可关联同项目的待办');
    let ids: string[] = [];
    try { const a = row.req_ids ? (JSON.parse(row.req_ids) as unknown) : []; ids = Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []; } catch { ids = []; }
    const has = ids.includes(reqId);
    if (target.linked && !has) ids.push(reqId);
    if (!target.linked && has) ids = ids.filter((x) => x !== reqId);
    db.prepare(`UPDATE ${table} SET req_ids = ?, updated_at = ? WHERE id = ?`).run(ids.length > 0 ? JSON.stringify(ids) : null, now(), target.targetId);
  },

  /**
   * AI 解析：把表格文本交给所选模型，识别计划条目并输出标准结构草稿（不入库，返回前端预览确认）。
   * 校验与归一化在服务端完成：title 必填、startDate 规范化（非法置空由重排兜底）、durationDays≥1、status 枚举。
   */
  async aiParseDrafts(toolId: string, tableText: string): Promise<{
    drafts: Array<{ title: string; description: string; startDate: string; durationDays: number; assignee: string; status: PlanStatus }>;
    /** T00620：行数守恒提示（输入行数与解析条数差异过大时给出，供前端提示可能被归纳合并） */
    coverageWarn?: string;
  }> {
    const system = [
      '你是 MTask 的项目计划解析助手。给定来自用户上传 Excel 的表格文本（每行一条记录，单元格以「 | 」分隔，列含义未知，可能含表头/说明/汇总行）。',
      '请识别其中的项目计划条目，输出 JSON 数组，每元素为：',
      '{"title":"任务名称(必填)","description":"描述(无则空串)","startDate":"YYYY-MM-DD(无法识别则空串)","durationDays":工期工作日数(默认1),"assignee":"负责人(无则空串)","status":"todo|doing|done|blocked(默认todo)"}',
      '要求：',
      '1. 只输出 JSON 数组本身，不要任何解释或 Markdown 代码围栏',
      '2. 中文/异构日期（如 9月14日、2026.9.14、14/9）转换为 YYYY-MM-DD；无法可靠识别则**给出合理日程建议**：以今天为基准，按条目顺序与工期并行/串行关系推算 startDate（如多条无日期任务可按顺序依次排开），建议值同样输出 YYYY-MM-DD；完全无法推断时才置空串',
      '3. 工期/天数/持续列给出 durationDays；缺失默认 1；不允许小于 1',
      '4. 状态列映射到 todo/doing/done/blocked；无法识别默认 todo',
      '5. 跳过表头行、空行、纯说明/汇总行；不要虚构任务',
      // T00620：行数守恒——源表常出现「同一工作项多行（不同产出物/阶段）」，严禁按标题合并归纳
      '6. **逐行输出：表格中每个数据行都必须生成一个独立条目，严禁把同一工作项的多行合并成一条**；',
      '   同一「工作项」出现多行时，用产出物/阶段信息区分标题（如「XX工具开发（bemp-test-common）」），确保每行可独立识别；',
      '7. 输出条目数应尽量与表格数据行数一致（仅允许因表头/空行/汇总行而减少）',
    ].join('\n');
    // T00551：分块解析——整表一次性交给模型会被 max_tokens 截断（19 条只回 7 条），
    // 按行分块（每块 ≤15 行）逐块解析合并
    // T00620 修复：块内分隔符原为 '\nn'（「换行 + 字母 n」），使除首行外每行开头被字符 n 污染，
    // 干扰 AI 逐行识别——修正为标准换行分隔
    const tLines = tableText.split('\n').map((x) => x.trim()).filter(Boolean);
    const CHUNK = 15;
    const chunks: string[] = [];
    for (let i = 0; i < tLines.length; i += CHUNK) chunks.push(tLines.slice(i, i + CHUNK).join('\n'));
    if (chunks.length === 0) throw new Error('Excel 中未解析到任何数据行');

    const drafts: PlanDraft[] = [];
    // T00620 修复：原按 title 去重，会把「同一工作项的多行」（源表常见：同工作项 × 多产出物/多阶段）
    // 误合并成一条——这是「54 行只解析出 17 条」的根因之一。改为**行级指纹去重**
    // （标题+开始日期+描述+负责人），仅消除跨块重复的同一条记录，保留同工作项的不同行。
    const seen = new Set<string>();
    for (const chunk of chunks) {
      const ai = await AIService.ask(toolId, system, `【Excel 表格文本】\n${chunk}`);
      if (!ai.ok || !ai.content) continue; // 单块失败跳过，不拖垮整体
      const arr = parseJsonArrayWithRecovery(ai.content, '');
      for (const r of arr) {
        const d = normalizeDraft(r);
        if (!d) continue;
        const fingerprint = `${d.title}|${d.startDate ?? ''}|${(d.description ?? '').slice(0, 40)}|${d.assignee ?? ''}`;
        if (!seen.has(fingerprint)) { seen.add(fingerprint); drafts.push(d); }
      }
    }
    if (drafts.length === 0) throw new Error('AI 未能从文件中识别出任何计划条目，请确认文件内容或更换模型');
    // T00620：行数守恒提示——输入数据行与解析条数差异过大时附诊断信息（前端可据此提示「可能被模型归纳合并」）
    const coverageWarn = tLines.length > 0 && drafts.length < tLines.length * 0.6
      ? `本次输入 ${tLines.length} 行，解析出 ${drafts.length} 条；若与源表条目数不符，可能被模型归纳合并——请核对后手动补充`
      : '';
    return { drafts, coverageWarn };
  },

  /** 批量创建（AI 导入确认保存/其他批量来源）：事务插入后统一重排；首条用其 startDate 作锚点。
   *  T00709（D-1 修复）：返回 ids 按输入顺序对齐（经 title 清洗过滤后的 clean 数组下标），
   *  供调用方（importPrd）按 id 回写 req_ids 关联——废弃按标题 find 匹配（同名计划会互相覆盖）。 */
  createBatch(projectId: string, items: Array<{ title: string; description?: string; startDate?: string; durationDays?: number; assignee?: string; status?: PlanStatus }>): { inserted: number; ids: string[] } {
    if (!getDb().prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new Error('项目不存在');
    const clean = items.filter((it) => it.title?.trim());
    if (clean.length === 0) throw new Error('没有可创建的计划条目');
    if (clean.length > 5000) throw new Error('单次创建上限 5000 条');
    const db = getDb();
    const t = now();
    const holidays = loadHolidaySet();
    const ids: string[] = [];
    db.transaction(() => {
      const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM plan_tasks WHERE project_id = ? AND archived = 0').get(projectId) as { m: number }).m;
      const existingCount = maxOrder + 1;
      const ins = db.prepare(
        `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
           progress, status, assignee, sort_order, linked_task_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, ?)`,
      );
      clean.forEach((it, i) => {
        const duration = Math.max(1, Math.floor(Number(it.durationDays) || 1));
        const status = PLAN_STATUSES.has(it.status as PlanStatus) ? (it.status as PlanStatus) : 'todo';
        // T00561：各行日期独立——开始日用自己的（空则今天），end 按工作日计算
        const start = it.startDate && DATE_RE.test(it.startDate) ? it.startDate : fmt(new Date());
        const end = calcEndDate(start, duration, holidays);
        const id = uuid();
        ids.push(id);
        ins.run(id, projectId, it.title.trim(), it.description ?? '', start, end, duration, status, it.assignee ?? '', maxOrder + 1 + i, t, t);
      });
    })();
    notifyChange('plans');
    return { inserted: clean.length, ids };
  },
};
