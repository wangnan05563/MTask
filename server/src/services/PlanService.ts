/**
 * 项目计划服务（T00431）：计划任务 CRUD、串行瀑布时间线重排（避开周末与节假日）、
 * Excel 导入/导出（exceljs）、计划→待办状态联动。设计文档见 docs/PRD-项目计划.md。
 */
import { getDb } from '../db/connection';
import { createHash } from 'node:crypto'; // T01156-3：PRD 导入内容哈希——同名/同内容覆盖去重
import { v4 as uuid } from 'uuid';
import ExcelJS from 'exceljs';
import { AIService } from './AIService';
import { clampComplexity } from './PlanComplexity'; // T02122：复杂度钳位单源
import { nextTaskNo } from './TaskService'; // T00662：PRD 导入生成待办复用统一编号生成器
import { ArchiveService } from './ArchiveService'; // T01874：计划彻底删除时连带归档其派生孤儿待办，走既有归档通道（含父进度重算）
import { notifyChange } from './ChangeBus';
// pizzip：docxtemplater 既有依赖，用于解压 .docx 提取 word/document.xml（T00439）
import PizZip from 'pizzip';
import { stripWordFieldCodes } from '../util/wordFields'; // T00814：清洗 Word 域代码（目录/页码/交叉引用）
import { logService } from './LogService'; // T00821：覆盖录入行为留痕（覆盖时间/文件名/项目，单机无账号故操作人留空）
import { parsePlanDeps, depsSatisfied } from '../util/planDeps'; // T01284：deps 判定统一实现（FR-3.7）
import { addChildEdge, childParentIds, hasChildEdge, intervalChildEdges } from '../util/milestoneChild'; // T02090 口径 A：child 边纯函数单源
import { recalcMilestoneProgress, recalcMilestonesOfChild, milestoneHasChildren } from './milestoneProgress'; // T02090：里程碑进度聚合
import { resolveReqNo, groupDuplicateReqNos, isReqNoTaken } from '../util/reqNo'; // T01867：需求编号项目内唯一顺延
import { syncReqStatuses } from './reqStatusSync'; // T02087：需求状态随计划/待办完成度派生
import { nextPlanTitle } from '../util/planTitle'; // T01875：计划标题撞名让号（与需求编号顺延同构）

/** T01361：需求跟踪矩阵行（prd_requirements 全列 + 联表摘要）——具体化类型替代 Record<string, unknown>（Sonar S6551） */
export interface RequirementRow {
  id: string;
  project_id: string;
  req_no: string | null;
  title: string | null;
  content: string | null;
  source_ref: string | null;
  priority: string | null;
  status: string | null;
  sort_order: number | null;
  created_at: string | null;
  updated_at: string | null;
  prd_id: string | null;
  linkedPlans: Array<{ id: string; title: string; status: string }>;
  linkedTasks: Array<{ taskNo: string | null; title: string | null; status: string; verified: boolean }>;
  prdDoc: { id: string; filename: string } | null;
}

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
  /** 需求追溯关联：本计划覆盖的需求编号数组（JSON），供矩阵「需求→计划」关联与计划完成态向待办传播 */
  req_ids: string | null;
  /** T00490：记录字体颜色，空串=默认色 */
  color: string;
  /** T00499：前置依赖 JSON [{id,type:'serial'|'parallel'}]，空=无依赖 */
  deps: string;
  /** T01058-FR2.1：AI 复杂度评级（1~5，≥4 建议拆分）；DB 列经 ensureColumn 补齐，历史行/未评估行为 NULL（T01689 起随 MCP 露出） */
  complexity?: number | null;
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

/** T01001：计划条目类型——normal=普通任务、milestone=阶段里程碑、daily=日常任务（对齐 plan_tasks.kind） */
export type PlanKind = 'normal' | 'milestone' | 'daily';

const PLAN_STATUSES = new Set<PlanStatus>(['todo', 'doing', 'done', 'blocked']);

/** AI 解析输入的行数上限：超出的内容截断，避免超大文件拖垮模型上下文（T00438） */
const MAX_PARSE_ROWS = 300;
/** T01156：PRD 解析首轮输出预算下限。
 *  PRD 拆 WBS + 逐条需求可能产出较长 JSON，工具默认 max_tokens(4096) 常被触顶截断 → 触发精简重试硬砍 requirements≤20，静默丢需求。
 *  但预算也绝非越大越好：本轮实测把 16384 顶上去后，上游网关对单次输出上限/响应体大小有硬限制，或生成过久导致网关自身超时 → 直接报 HTTP 502（Bad Gateway）。
 *  实测该 PRD 实际输出约 4000 token，8192 给 2 倍余量既不截断、又远离网关上限，是最稳取值。 */
const PRD_PARSE_MIN_OUTPUT_TOKENS = 8_192;
/** T01156-4：PRD 解析超时下限。maxTokens 抬到 16K 后生成更耗时，工具默认 timeoutMs(60000) 必触顶 →
 *  「连接超时（超过 60000ms）」报错（与上一轮抬高预算是同一连锁反应）。显式给 300s 兜底。 */
const PRD_PARSE_TIMEOUT_MS = 300_000;

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
      const next = nextStringState(ch, inStr, esc);
      inStr = next.inStr;
      esc = next.esc;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') {
      if (depth === 0) startIdx = i;
      depth += 1;
      continue;
    }
    if (ch === '}') {
      const r = flushCloseBrace(text, depth, startIdx, i, out);
      depth = r.depth;
      startIdx = r.startIdx;
    }
  }
  return out;
}

/** 字符串内逐字符推进状态机（跳过转义）：返回新的 inStr/esc */
function nextStringState(ch: string, inStr: boolean, esc: boolean): { inStr: boolean; esc: boolean } {
  if (esc) return { inStr, esc: false };
  if (ch === String.fromCodePoint(92)) return { inStr, esc: true };
  if (ch === '"') return { inStr: false, esc };
  return { inStr, esc };
}

/** 解析 [startIdx, endIdx] 区间内的顶层对象并追加到 out（解析失败则跳过） */
function pushTopLevelObject(text: string, startIdx: number, endIdx: number, out: Record<string, unknown>[]): void {
  try {
    const o = JSON.parse(text.slice(startIdx, endIdx + 1)) as unknown;
    if (o && typeof o === 'object' && !Array.isArray(o)) out.push(o as Record<string, unknown>);
  } catch { /* 跳过损坏对象 */ }
}

/** 处理右花括号：depth-1 后若闭合顶层对象则解析入列；越界 depth 归零 */
function flushCloseBrace(text: string, depth: number, startIdx: number, endIdx: number, out: Record<string, unknown>[]): { depth: number; startIdx: number } {
  const newDepth = depth - 1;
  if (newDepth === 0 && startIdx >= 0) {
    pushTopLevelObject(text, startIdx, endIdx, out);
    return { depth: newDepth, startIdx: -1 };
  }
  if (newDepth < 0) return { depth: 0, startIdx };
  return { depth: newDepth, startIdx };
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

/** T00764：日历上下文——holidays=放假日（工作日排除），overtime=加班日（周末/节假日上班，强制算工作日） */
interface WorkdayCal { holidays: Set<string>; overtime: Set<string>; }

function loadCalendar(): WorkdayCal {
  const rows = getDb().prepare('SELECT date, kind FROM holidays').all() as { date: string; kind: string | null }[];
  const cal: WorkdayCal = { holidays: new Set(), overtime: new Set() };
  for (const r of rows) (r.kind === 'overtime' ? cal.overtime : cal.holidays).add(r.date);
  return cal;
}

/** 工作日 = 加班日优先视为工作日；否则非周六日 且 不在节假日表 */
function isWorkday(d: Date, cal: WorkdayCal): boolean {
  if (cal.overtime.has(fmt(d))) return true;
  const wd = d.getDay();
  if (wd === 0 || wd === 6) return false;
  return !cal.holidays.has(fmt(d));
}

/** 起始日起 duration_days 个工作日的含尾结束日 */
/** T02090：本次 update 可能影响的里程碑集合——自身（若本就是里程碑，聚合可能改写其 status/progress）
 *  + deps 变更前后的全部父里程碑（child 边指向它们的行）。 */
function affectedMilestones(row: PlanTaskRow, patch: { deps?: string }): string[] {
  const ids = new Set<string>();
  if (row.kind === 'milestone') ids.add(row.id);
  for (const d of childParentIds(row.deps ?? '')) ids.add(d);
  if (patch.deps !== undefined) for (const d of childParentIds(patch.deps)) ids.add(d);
  return [...ids];
}

/** T01704：[start, end] 闭区间内的工作日数（含首尾，跳过周末/节假日、含加班日） */
function workdaysInRange(start: string, end: string, cal: WorkdayCal): number {
  const d = parseDate(start);
  const last = parseDate(end);
  let n = 0;
  while (d <= last) {
    if (isWorkday(d, cal)) n += 1;
    d.setDate(d.getDate() + 1);
  }
  return Math.max(1, n);
}

/** 定宽 YYYY-MM-DD 日期串比较器：与 Array#sort 默认的 UTF-16 码元字典序逐字等价，不抛、不用三元 */
function byIsoDateOrder(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** T01704：里程碑包络重算——里程碑的起止与工期取自其下子任务（deps 内 type='child' 指向该里程碑）
 *  的包络，替代 durationDays 推导值（swork 20 条日期失真痛点：里程碑止期晚于其子任务包络）。
 *  无子任务或包络未变时不动。
 *  T02090：子项枚举改走 util/milestoneChild 单源（与进度聚合、导入补边同一判据）。 */
function recalcMilestoneEnvelope(db: ReturnType<typeof getDb>, milestoneId: string): void {
  const m = db.prepare('SELECT id, project_id, start_date, end_date FROM plan_tasks WHERE id = ?').get(milestoneId) as
    | { id: string; project_id: string; start_date: string; end_date: string }
    | undefined;
  if (!m) return;
  const rows = db.prepare('SELECT start_date, end_date, deps FROM plan_tasks WHERE project_id = ? AND archived = 0').all(m.project_id) as
    Array<{ start_date: string; end_date: string; deps: string }>;
  const kids = rows.filter((r) => hasChildEdge(r.deps, milestoneId));
  if (kids.length === 0) return;
  // 包络取最早开始日 / 最晚结束日：日期串定宽 YYYY-MM-DD，字典序即时间序。
  // 显式比较器排序后取首尾，与旧「无比较器 sort() 取 [0]/.at(-1)」逐字等价（UTF-16 码元序），
  // 且不抛——上一版 `reduce((min,d)=>…)` 无初值，空 kids 会抛 TypeError（S6959），此处还原为不抛口径。
  const startDates = kids.map((k) => k.start_date).sort(byIsoDateOrder);
  const endDates = kids.map((k) => k.end_date).sort(byIsoDateOrder);
  const start = startDates[0];
  const end = endDates.at(-1);
  if (!start || !end || (start === m.start_date && end === m.end_date)) return;
  const duration = workdaysInRange(start, end, loadCalendar());
  db.prepare('UPDATE plan_tasks SET start_date = ?, end_date = ?, duration_days = ?, updated_at = ? WHERE id = ?')
    .run(start, end, duration, now(), milestoneId);
}

function calcEndDate(start: string, durationDays: number, cal: WorkdayCal): string {
  const d = parseDate(start);
  let left = durationDays;
  while (left > 0) {
    if (isWorkday(d, cal)) left -= 1;
    if (left > 0) d.setDate(d.getDate() + 1);
  }
  return fmt(d);
}

/** 某结束日之后的下一个工作日（串行重排用） */
function nextWorkday(after: string, cal: WorkdayCal): string {
  const d = parseDate(after);
  do { d.setDate(d.getDate() + 1); } while (!isWorkday(d, cal));
  return fmt(d);
}

// ---------- T00561：显式依赖驱动排期（去掉默认串行链） ----------
// 旧行为：rescheduleFrom 把全部任务按串行瀑布隐式串联——任意任务日期/工期变动，后续全部顺延。
// 新行为：任务默认无依赖（各自保持日期）；仅当显式配置 deps（serial/parallel 指向前置任务）时联动：
//   serial：start = 全部串行前置 end 的下一工作日；parallel：start = 前置任务 start。
// 传播：从变更任务出发沿 deps 引用关系 BFS，日期有变化才继续向下传播。

/** 单任务工期收尾：end = start 起按工作日计 duration 天 */
function refreshTaskEnd(db: ReturnType<typeof getDb>, id: string, start: string, duration: number): void {
  const end = calcEndDate(start, Math.max(1, duration), loadCalendar());
  db.prepare("UPDATE plan_tasks SET start_date = COALESCE(NULLIF(?, ''), start_date), end_date = ?, updated_at = ? WHERE id = ?")
    .run(start, end, now(), id);
}

/** 沿显式 deps 依赖图传播重算（BFS）：serial 后移 / parallel 对齐前置开始日。
 *  T02090：本地 parseDeps 副本删除，统一走 util/planDeps.parsePlanDeps（T01284 单源）；
 *  `child` 边（结构性归属）**不参与**日期传播——否则子任务 start 会被对齐到里程碑 start
 *  （里程碑 start 又取自子任务包络，互为前提造成日期污染与抖动）。 */
function rescheduleDependents(db: ReturnType<typeof getDb>, projectId: string, seedId: string): void {
  const cal = loadCalendar();
  const all = db.prepare(
    'SELECT id, title, start_date, end_date, duration_days, deps, kind FROM plan_tasks WHERE project_id = ? AND archived = 0',
  ).all(projectId) as Array<{ id: string; title: string; start_date: string; end_date: string; duration_days: number; deps: string; kind: string }>;
  const map = new Map(all.map((r) => [r.id, { ...r }]));
  const upd = db.prepare('UPDATE plan_tasks SET start_date = ?, end_date = ?, updated_at = ? WHERE id = ?');
  const t = now();
  const queue = [seedId];
  const touched = new Set<string>([seedId]);

  const dependStart = (
    rel: { id: string; type: string },
    seed: { id: string; start_date: string; end_date: string },
    deps: Array<{ id: string; type: string }>,
  ): string | null => {
    if (rel.type === 'serial') {
      const ends = deps.filter((d) => d.type === 'serial')
        .map((d) => map.get(d.id)?.end_date)
        .filter(isDate)
        .sort((a, b) => a.localeCompare(b));
      if (ends.length > 0) return nextWorkday(ends.at(-1)!, cal);
      return null;
    }
    if (rel.type !== 'parallel') return null; // child（T02090）：归属边，不排期
    if (!isDate(seed.start_date)) return null;
    return seed.start_date;
  };
  const commit = (row: { id: string; start_date: string; end_date: string }, start: string, end: string): void => {
    if (start !== row.start_date || end !== row.end_date) {
      upd.run(start, end, t, row.id);
      row.start_date = start; row.end_date = end;
      touched.add(row.id); queue.push(row.id);
    }
  };

  while (queue.length > 0) {
    const seed = map.get(queue.shift()!);
    if (!seed) continue;
    for (const row of all) {
      if (touched.has(row.id)) continue;
      const deps = parsePlanDeps(row.deps);
      const rel = deps.find((d) => d.id === seed.id);
      if (!rel) continue;
      const start = dependStart(rel, seed, deps);
      if (start === null) continue;
      const end = calcEndDate(start, Math.max(1, row.duration_days), cal);
      commit(row, start, end);
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
  const cal = loadCalendar();
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
      start = opts.firstStartDate ?? (opts.afterEndDate ? nextWorkday(opts.afterEndDate, cal) : (r.start_date || fmt(new Date())));
    } else {
      start = nextWorkday(prevEnd!, cal);
    }
    const end = calcEndDate(start, Math.max(1, r.duration_days), cal);
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
 * 单向对齐（保守：不反向改写 plan→待办/doing，避免覆盖用户手动排期语义）。
 * T02090：**带子项的里程碑除外**——其状态由进度聚合作主（recalcMilestoneProgress，
 * 见下方启动链末尾），若这里按关联待办抢先置 done，会出现「子项未齐里程碑已 done」
 * （正是 T02042 红线要防的）。聚合作主意味着：子项没齐，即使关联待办 done 也不放行。
 * 返回对齐行数（用于启动日志观测）。
 */
export function reconcileLinkedPlanStatuses(): number {
  const db = getDb();
  const cands = db.prepare(
    `SELECT p.id FROM plan_tasks p JOIN tasks t ON t.id = p.linked_task_id
      WHERE p.archived = 0 AND p.status != 'done' AND t.status = 'done'`,
  ).all() as Array<{ id: string }>;
  const own = cands.map((c) => c.id).filter((id) => !milestoneHasChildren(db, id));
  if (own.length === 0) return 0;
  const upd = db.prepare("UPDATE plan_tasks SET status = 'done', progress = 100, updated_at = ? WHERE id = ?");
  let fixed = 0;
  db.transaction(() => {
    for (const id of own) fixed += upd.run(now(), id).changes;
  })();
  return fixed;
}

/** 计划状态 → 关联待办状态映射（MTask 待办仅「待办/完成」两态） */
function taskStatusForPlan(ps: PlanStatus): 'todo' | 'done' {
  return ps === 'done' ? 'done' : 'todo';
}

/**
 * T01266：需求追溯维度（req_ids）的计划→待办状态同步。
 * 需求跟踪矩阵里「需求→计划」与「需求→待办」是通过 req_ids 建立的追溯关联，
 * 与计划页 plan_tasks.linked_task_id 直接关联是两套独立机制。仅 linked_task_id 关联的
 * 待办会在计划完成时被同步（见 update / linkTodo），而矩阵 req_ids 关联的待办不会跟随——
 * 表现为「矩阵里关联了待办、再把计划标记完成，待办状态不动」。本函数把计划状态传播到
 * 所有与该计划共享至少一个需求的未归档待办，实现需求闭环。语义与 linked_task_id 同步一致：
 * 计划完成→待办同步完成；其余→待办回到待办（可回退）。
 */
function syncReqLinkedTasks(db: ReturnType<typeof getDb>, projectId: string, planReqIds: string[], planStatus: PlanStatus): void {
  if (planReqIds.length === 0) return;
  const tasks = db.prepare(
    `SELECT id, req_ids FROM tasks WHERE project_id = ? AND archived = 0 AND req_ids IS NOT NULL AND req_ids != '' AND req_ids != '[]'`,
  ).all(projectId) as Array<{ id: string; req_ids: string | null }>;
  if (tasks.length === 0) return;
  const ts = taskStatusForPlan(planStatus);
  const upd = db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?');
  for (const tk of tasks) {
    const tIds = parseLinkIds(tk.req_ids);
    if (tIds.some((x) => planReqIds.includes(x))) upd.run(ts, now(), tk.id);
  }
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

/** 工期归一：直接整数≥1 或 由 开始/结束日期 自然日差换算（≥1）；否则返回 null（调用方报错） */
function resolveDuration(durationRaw: string, start: string, endDate: string): number | null {
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
  return (!Number.isInteger(duration) || duration < 1) ? null : duration;
}

/** 解析 req_ids JSON 字段为字符串数组（非法/空 → 空数组） */
function parseLinkIds(json: string | null): string[] {
  try {
    const a = json ? (JSON.parse(json) as unknown) : [];
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * M6-6.1（T01156）：反向覆盖检查——需求清单中有、却未被任何 WBS 计划 reqNos 关联的需求编号。
 * 旧 coverageWarn 仅当「所有计划 reqNos 全空」时才告警，漏掉了「部分需求无人认领」的静默缺口
 * （典型表现：需求清单 25 条、WBS 22 条，但仅前 15 条需求被关联，后 10 条 REQ-016…REQ-025 不可追溯）。
 */
function collectUncoveredReqNos(
  requirements: Array<{ reqNo: string }>,
  drafts: Array<{ reqNos: string[] }>,
): string[] {
  const referenced = new Set<string>();
  for (const d of drafts) for (const n of d.reqNos) referenced.add(n);
  return requirements.map((r) => r.reqNo).filter((no) => !referenced.has(no));
}

/** M6-6.1：可追溯性缺口 → 人话告警（全未关联 / 部分未关联两种情况文案不同） */
function buildCoverageWarn(draftCount: number, reqCount: number, uncovered: string[]): string {
  if (draftCount === 0 || reqCount === 0) return '';
  if (uncovered.length === 0) return '';
  if (uncovered.length === reqCount) return '本次解析的计划节点未关联到任何需求编号——可在矩阵面板中手动建立关联';
  const more = uncovered.length > 10 ? '…' : '';
  return `有 ${uncovered.length} 条需求未被任何 WBS 计划关联（${uncovered.slice(0, 10).join('、')}${more}）——这些需求当前不可追溯，建议补计划或在矩阵面板手动关联`;
}

/** M6-6.1：导出 Markdown 的单元格转义（管道符转义 + 换行压平，避免撑坏表格） */
type MdCell = (s: string | null | undefined) => string;

/** M6-6.1：WBS 类型 → 表内人话标签 */
function planKindLabel(kind: string | undefined): string {
  if (kind === 'milestone') return '里程碑';
  if (kind === 'daily') return '日常';
  return '任务';
}

/** M6-6.1：追加「任务清单」表到导出正文 */
function pushTaskTable(
  lines: string[],
  tasks: Array<{ task_no: string | null; title: string; status: string; priority: string; verified: number }>,
  esc: MdCell,
): void {
  lines.push(`## 任务清单（${tasks.length} 条）`, '', '| 编号 | 标题 | 状态 | 优先级 | 验证 |', '| --- | --- | --- | --- | --- |');
  for (const t of tasks) {
    lines.push(`| ${t.task_no ?? '—'} | ${esc(t.title)} | ${t.status} | ${t.priority} | ${t.verified ? '✓' : ''} |`);
  }
  lines.push('');
}

/** M6-6.1：追加「项目计划 / WBS」表到导出正文 */
function pushPlanTable(lines: string[], plans: PlanTaskRow[], esc: MdCell): void {
  lines.push(`## 项目计划 / WBS（${plans.length} 条）`, '', '| 类型 | 标题 | 开始 | 结束 | 工期 | 进度 | 状态 | 负责人 |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const p of plans) {
    const kindLabel = planKindLabel((p as { kind?: string }).kind);
    lines.push(`| ${kindLabel} | ${esc(p.title)} | ${p.start_date} | ${p.end_date} | ${p.duration_days} | ${p.progress}% | ${p.status} | ${esc(p.assignee) || '—'} |`);
  }
  lines.push('');
}

/** M6-6.1：追加「需求跟踪矩阵」表（T01361：关联计划读真实字段 linkedPlans，与界面矩阵同源） */
function pushReqTable(lines: string[], reqs: RequirementRow[], esc: MdCell): void {
  lines.push(`## 需求跟踪矩阵（${reqs.length} 条）`, '', '| 编号 | 需求 | 状态 | 关联计划 |', '| --- | --- | --- | --- |');
  for (const r of reqs) {
    const reqNo = r.req_no == null ? '—' : String(r.req_no);
    const status = r.status == null ? 'todo' : String(r.status);
    lines.push(`| ${reqNo} | ${esc(r.title)} | ${status} | ${r.linkedPlans.map((x) => esc(x.title)).join('、') || '—'} |`);
  }
  lines.push('');
}

function applyLinkToggle(ids: string[], reqId: string, linked: boolean): { ids: string[]; added: boolean } {
  const has = ids.includes(reqId);
  if (linked && !has) ids.push(reqId);
  if (!linked && has) ids.splice(ids.indexOf(reqId), 1);
  return { ids, added: linked && !has };
}

/**
 * M6-6.1（T01266）：需求追溯的反向同步——把待办关联到某需求时，若该需求已被某个「已完成」计划覆盖，
 * 则该待办同步标记完成（与计划页 linked_task_id 同步语义一致），避免「先完成计划、后关联待办」的状态滞后。
 */
function syncTaskCoveredDone(db: ReturnType<typeof getDb>, projectId: string, taskId: string, reqId: string): void {
  const donePlans = db.prepare(
    `SELECT req_ids FROM plan_tasks WHERE project_id = ? AND archived = 0 AND status = 'done' AND req_ids IS NOT NULL AND req_ids != ''`,
  ).all(projectId) as Array<{ req_ids: string }>;
  if (!donePlans.some((p) => parseLinkIds(p.req_ids).includes(reqId))) return;
  db.prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?").run(now(), taskId);
}

/** PRD 解析：单条原始需求 → 归一化需求（reqNo 查重去重 + priority 枚举兜底；标题缺失返回 null） */
function normalizeRequirement(
  r: unknown,
  requirements: Array<{ reqNo: string; title: string; content: string; sourceRef: string; priority: string }>,
  seenNo: Set<string>,
): void {
  if (!r || typeof r !== 'object') return;
  const o = r as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  if (!title) return;
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

/** PRD 解析：原始需求条目 → 归一化需求数组（reqNo 顺序编号 + 查重去重，priority 枚举兜底） */
function normalizeRequirements(raw: unknown[]): Array<{ reqNo: string; title: string; content: string; sourceRef: string; priority: string }> {
  const requirements: Array<{ reqNo: string; title: string; content: string; sourceRef: string; priority: string }> = [];
  const seenNo = new Set<string>();
  for (const r of raw) {
    normalizeRequirement(r, requirements, seenNo);
  }
  return requirements;
}

/** T01001：解析 AI 是否已明确给出计划类型；未给时按 WBS 编号的层级结构兜底判定里程碑。
 *  多级编号（如 "1.1 需求评审"）必为明细任务；一级编号开头（如 "1 M1 平台搭建"）即顶层=阶段里程碑。
 *  用结构（WBS 层级）而非关键词识别，避免把普通任务误判为里程碑。 */
function resolvePrdKind(title: string, kindRaw: unknown): PlanKind {
  // T01361（S6551）：kindRaw 非 string 时不再做 String() 兜底——来源均为 TEXT 列/JSON 字符串，
  // 非字符串值原本也匹配不到任何 PlanKind，行为等价（同样落按编号兜底分支）
  const k = (typeof kindRaw === 'string' ? kindRaw : '').trim().toLowerCase();
  if (k === 'milestone' || k === 'normal' || k === 'daily') return k as PlanKind;
  // 多级编号（1.1/2.3）→ 明细任务
  if (/^\s*\d+(\.\d+)+\s*[.\sA-Za-z0-9]/.test(title)) return 'normal';
  // 单级编号开头（1 xxx / M1 xxx）→ 该 PRD 的两级结构中顶层即阶段里程碑
  if (/^\s*(?:\d+|M\d+)\s+/.test(title)) return 'milestone';
  return 'normal';
}

/**
 * T01001 二轮：里程碑工期汇总——里程碑的工期 = 其下明细任务工期之和（原地改写）。
 * 口径与项目管理页「里程碑汇总（milestoneMeta）」一致：本里程碑之后、下一里程碑之前的非里程碑条目即其明细。
 * 目的：AI 给出的里程碑工期常与其明细合计不相等（实测 M1=4、明细合计 5），导入后两边对不上；
 * 这里在落库前统一按明细汇总，保证里程碑工期与其子任务合计恒等（无明细时保留原值）。
 */
function milestoneDurations(items: Array<{ kind?: PlanKind; durationDays?: number }>): number[] {
  const out = items.map((it) => Math.max(1, Math.floor(Number(it?.durationDays) || 1)));
  for (let i = 0; i < items.length; i++) {
    if (items[i]?.kind !== 'milestone') continue;
    let sum = 0;
    for (let j = i + 1; j < items.length; j++) {
      if (items[j]?.kind === 'milestone') break;
      sum += out[j] ?? 1;
    }
    if (sum > 0) out[i] = sum; // 无明细的里程碑保留 AI 给的工期
  }
  return out;
}

/** PRD 解析：原始计划条目 → 归一化计划草稿数组（reqNos 字符串过滤，durationDays≥1，status 固定为待办初始态）
 *  T01001：新增 kind 字段——AI 显式输出优先，否则按 WBS 层级推断里程碑。 */
function normalizePrdPlans(raw: unknown[]): Array<{ title: string; description: string; durationDays: number; startDate: string; reqNos: string[]; status: PlanStatus; kind: PlanKind; complexity?: number }> {
  const drafts: Array<{ title: string; description: string; durationDays: number; startDate: string; reqNos: string[]; status: PlanStatus; kind: PlanKind; complexity?: number }> = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    if (!title) continue;
    const reqNos = Array.isArray(o.reqNos) ? o.reqNos.filter((x): x is string => typeof x === 'string') : [];
    // T01058-FR2.1 / T02122：AI 复杂度评级（1~5；非法/缺失为 undefined），钳位走单源函数
    const cClamped = clampComplexity(o.complexity);
    const complexity = cClamped ?? undefined;
    drafts.push({
      title,
      description: typeof o.description === 'string' ? o.description : '',
      durationDays: Math.max(1, Math.floor(Number(o.durationDays) || 1)),
      startDate: '',
      reqNos,
      status: 'todo',
      kind: resolvePrdKind(title, o.kind),
      complexity,
    });
  }
  return drafts;
}

/** T01874：计划彻底删除时的派生待办清点——命中返回待办 id，否则 null */
interface PurgePlanRow {
  id: string;
  title: string;
  req_ids: string | null;
  linked_task_id: string | null;
}

/**
 * 「无源孤儿」判定（T01874）：计划→待办的派生关系只存在 plan_tasks.linked_task_id 上（tasks 表无来源列），
 * 计划行一删关系即消失，待办留下「来源计划已删除」的孤儿——标题带派生前缀却无任何入口解释它为何存在。
 * 派生用两条创建通道的命名约定识别：createLinkedTodo 写 `[计划] <标题>`、importPrd 写 `[PRD] <标题>`；
 * 手工建好后仅「关联」到计划的待办不在其中。仍另有来源的一律不动：被其它未归档计划行指向、
 * 或本身挂在别的任务下（parent_id）。需求关联（req_ids）不算来源——它是追溯维度，随待办一并归档，
 * 条数由 purge 的破坏面回传并写进前端确认文案，不再静默变化。
 */
function derivedTaskOfPurgedPlan(db: ReturnType<typeof getDb>, plan: PurgePlanRow): string | null {
  const lid = plan.linked_task_id;
  if (!lid) return null;
  const t = db.prepare('SELECT id, title, parent_id FROM tasks WHERE id = ? AND archived = 0').get(lid) as
    { id: string; title: string; parent_id: string | null } | undefined;
  if (!t || t.parent_id) return null;
  const base = (plan.title ?? '').replaceAll('\n', ''); // 对齐 createLinkedTodo 的 REPLACE(title, char(10)) 去重口径
  const title = t.title.replaceAll('\n', '');
  if (title !== `[计划] ${base}` && title !== `[PRD] ${base}`) return null;
  if (db.prepare('SELECT 1 FROM plan_tasks WHERE archived = 0 AND linked_task_id = ? AND id != ? LIMIT 1').get(lid, plan.id)) return null;
  return t.id;
}

/** 计划行 req_ids 里仍存活的需求行数——物理删除计划行会连带抹掉这些「已关联计划」指向 */
function countLiveReqLinks(db: ReturnType<typeof getDb>, reqIdsJson: string | null): number {
  const ids = parseLinkIds(reqIdsJson);
  if (ids.length === 0) return 0;
  const exists = db.prepare('SELECT 1 FROM prd_requirements WHERE id = ? LIMIT 1');
  return ids.filter((x) => exists.get(x)).length;
}

// ---------- PRD 导入（importPrd）的分段辅助：自原方法体逐段搬移，行为与落库口径完全不变，抽出仅为降认知复杂度 ----------

/** importPrd 的 plans 入参行（与该方法内联签名同构，供下面的辅助按此传参） */
type PrdImportPlanItem = { title: string; description?: string; durationDays?: number; startDate?: string; reqNos?: string[]; assignee?: string; kind?: PlanKind; complexity?: number; status?: PlanStatus };

/** importPrd 的 requirements 入参行（与该方法内联签名同构） */
type PrdImportReqItem = { reqNo?: string; title: string; content?: string; sourceRef?: string; priority?: string };

/** importPrd 的 planTargets 元素：实际落库标题 + 复用的原行 id（null=新建） */
interface PrdImportPlanTarget { title: string; reuseId: string | null }

/** importPrd 的同名计划回传明细（T01869 只回传事实，T01875 定处置口径） */
interface PrdImportDupPlanTitle { title: string; existing: number; renamedTo?: string; reusedPlanId?: string }

/**
 * T00763：PRD 原文完整保留（Markdown 不截断），导入即生成文档记录并关联需求行。
 * T01156-3：同名/同内容覆盖——重复导入不再堆重复文档（对齐 createPrdDoc 的 T00821 覆盖模式）：
 *   ① 同项目 + 同内容哈希(origin_hash) → 覆盖复用该行；② 同项目 + 同文件名 → 覆盖复用（保留状态流转）。
 *   此前每次导入都 INSERT 新行，同一 PRD 导 N 次堆 N 份相同文档，旧需求删除后沦为孤儿（aimsg 实测 3 份同文档、2 份零引用）。
 * 返回本次导入使用的 prd_docs.id；未带原文（或原文全空白）时返回 undefined（与原实现一致：整段不执行）。
 */
function persistPrdDocForImport(
  db: ReturnType<typeof getDb>, projectId: string, rawPrdMd: string | undefined, rawFilename: string | undefined, t: string,
): string | undefined {
  const prdMd = typeof rawPrdMd === 'string' ? rawPrdMd : '';
  if (!prdMd.trim()) return undefined;
  const filename = (rawFilename ?? '').trim();
  const contentHash = createHash('sha256').update(prdMd).digest('hex').slice(0, 24);
  const byHash = db.prepare('SELECT id FROM prd_docs WHERE project_id = ? AND origin_hash = ?').get(projectId, contentHash) as { id: string } | undefined;
  const byName = filename
    ? db.prepare('SELECT id FROM prd_docs WHERE project_id = ? AND filename = ? ORDER BY created_at DESC LIMIT 1').get(projectId, filename) as { id: string } | undefined
    : undefined;
  const existing = byHash ?? byName;
  if (existing) {
    // 覆盖：更新正文/哈希/时间戳；filename 仅在本次带值时覆盖；status 保留原值（不重置用户确认态）
    db.prepare("UPDATE prd_docs SET content_md = ?, filename = CASE WHEN ? <> '' THEN ? ELSE filename END, origin_hash = ?, updated_at = ? WHERE id = ?")
      .run(prdMd, filename, filename, contentHash, t, existing.id);
    logService.log('INFO', 'prd', `[PRD导入覆盖] project=${projectId} doc=${existing.id} filename=${filename}（同内容/同名复用，不新建）`);
    return existing.id;
  }
  const createdId = uuid();
  db.prepare(
    `INSERT INTO prd_docs (id, project_id, filename, content_md, origin_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(createdId, projectId, filename, prdMd, contentHash, t, t);
  return createdId;
}

/**
 * T01869：同名计划回传——重导同一份 PRD 时计划按标题新建而不覆盖，列表里会出现两行同名、
 * 状态一行「未开始/0%」一行原值，极易被读成「原有计划的任务被重置」。T01869 只回传事实，
 * T01875 把口径定下来并给出处置（两种都不动已有行）：
 *   new（默认）：撞名的新行换「（N）」区分后缀——与 T01867/T01921 需求编号顺延同构；
 *   reuse     ：撞名不新建，命中未归档同名原行做补写，原行 status/progress 一字不动。
 * planTargets[i] 与 planItems[i] 一一对应：实际落库标题 + 命中的原行 id（null=新建）。
 */
function resolveImportPlanTargets(
  db: ReturnType<typeof getDb>, projectId: string, planItems: PrdImportPlanItem[], reuseMode: boolean,
): { planTargets: PrdImportPlanTarget[]; dupPlanTitles: PrdImportDupPlanTitle[] } {
  const planTargets: PrdImportPlanTarget[] = [];
  const dupPlanTitles: PrdImportDupPlanTitle[] = [];
  const rows = db.prepare('SELECT id, title FROM plan_tasks WHERE project_id = ? AND archived = 0').all(projectId) as Array<{ id: string; title: string }>;
  const firstIdByTitle = new Map<string, string>();
  const countByTitle = new Map<string, number>();
  for (const r of rows) {
    if (!firstIdByTitle.has(r.title)) firstIdByTitle.set(r.title, r.id);
    countByTitle.set(r.title, (countByTitle.get(r.title) ?? 0) + 1);
  }
  const taken = new Set<string>(firstIdByTitle.keys());
  const reported = new Set<string>();
  for (const p of planItems) {
    const base = p.title.trim();
    const existing = countByTitle.get(base) ?? 0;
    if (existing > 0 && reuseMode) {
      const reuseId = firstIdByTitle.get(base)!;
      planTargets.push({ title: base, reuseId });
      if (!reported.has(base)) { reported.add(base); dupPlanTitles.push({ title: base, existing, reusedPlanId: reuseId }); }
      continue;
    }
    // 无撞名时 nextPlanTitle 原样返回；本批内部自己撞名（同一份拆解两条同标题）也一样让号
    const renamed = nextPlanTitle(base, taken);
    taken.add(renamed);
    planTargets.push({ title: renamed, reuseId: null });
    if (renamed !== base && !reported.has(base)) {
      reported.add(base);
      dupPlanTitles.push({ title: base, existing, renamedTo: renamed });
    }
  }
  return { planTargets, dupPlanTitles };
}

/**
 * 需求项（矩阵行）落库。
 * T01995：两个编号空间分开登记——
 *   noToId         落库编号（顺延后的实际编号）→ id，权威；
 *   requestedToId  PRD 原编号 → id，计划条目引用的就是这个空间（T01921 的顺延不断链靠它）。
 * T01867：编号在项目内唯一——AI 每次解析都从 REQ-001 起号，增量导入必与存量撞号，
 * 撞号后「按编号定位需求」（矩阵导出、用例 importDraft 的 reqNo→id 复用）变成不确定命中，
 * 删掉其中一行会连带清掉另一行的引用。故落库前按项目现有最大编号顺延，旧编号一律不改。
 * T02303（裁定口径甲）：`onDuplicatePlan:'reuse'` 时需求侧也幂等——同标题且同内容的存量行直接复用其 id，
 * 不再新建。实测原坑：reuse 只让计划侧幂等，需求行整批新建（35→70）、关联边翻倍（57→114），
 * 等于把 T01869 的「同标题双行被读成 todo/0%」从计划侧搬到了需求侧。
 * 复用命中时绝不改写存量行（status/编号/标题/内容一律不动，与 T01875 对计划行的保护同构）；
 * 同一「标题+内容」键在存量里命中多行时不复用——宁可新建也不静默合并歧义行。
 */
function insertPrdRequirementsForImport(
  db: ReturnType<typeof getDb>, projectId: string, reqs: PrdImportReqItem[], ctx: {
    t: string;
    prdId: string | undefined;
    noToId: Map<string, string>;
    requestedToId: Map<string, string>;
    ambiguousReqNos: Set<string>;
    reqNoMap: Array<{ from: string; to: string }>;
    newReqs: Array<{ id: string; reqNo: string; title: string }>;
    reuseMode: boolean;
    reusedReqs: Array<{ id: string; reqNo: string; title: string }>;
  },
): void {
  const { t, prdId, noToId, requestedToId, ambiguousReqNos, reqNoMap, newReqs, reuseMode, reusedReqs } = ctx;
  const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM prd_requirements WHERE project_id = ?').get(projectId) as { m: number }).m;
  let order = maxOrder;
  const usedNos = new Set<string>(
    (db.prepare('SELECT req_no FROM prd_requirements WHERE project_id = ?').all(projectId) as Array<{ req_no: string | null }>)
      .map((r) => String(r.req_no ?? '').trim()).filter(Boolean),
  );
  // T02303 甲的复用查找表：按项目隔离，键 = trim(标题)+trim(内容)；值为 null 表示该键在存量里歧义命中多行
  const reqKey = (title: unknown, content: unknown) => `${String(title ?? '').trim()}\u0000${String(content ?? '').trim()}`;
  const reusable = new Map<string, { id: string; reqNo: string } | null>();
  if (reuseMode) {
    const existRows = db.prepare('SELECT id, req_no, title, content FROM prd_requirements WHERE project_id = ?')
      .all(projectId) as Array<{ id: string; req_no: string | null; title: string; content: string | null }>;
    for (const row of existRows) {
      const k = reqKey(row.title, row.content);
      reusable.set(k, reusable.has(k) ? null : { id: row.id, reqNo: String(row.req_no ?? '').trim() });
    }
  }
  const insReq = db.prepare(
    `INSERT INTO prd_requirements (id, project_id, req_no, title, content, source_ref, priority, status, sort_order, prd_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?)`,
  );
  for (const r of reqs) {
    const requested = (r.reqNo ?? '').trim();
    if (reuseMode) {
      const hit = reusable.get(reqKey(r.title, r.content));
      if (hit) {
        noToId.set(hit.reqNo, hit.id);
        if (requested) {
          const claimed = requestedToId.get(requested);
          if (claimed && claimed !== hit.id) ambiguousReqNos.add(requested);
          requestedToId.set(requested, hit.id);
        }
        // 让号明细照记：请求编号 → 复用到的既有编号（调用方据此知道「这条编号落在了哪一行」）
        if (requested && requested !== hit.reqNo) reqNoMap.push({ from: requested, to: hit.reqNo });
        reusedReqs.push({ id: hit.id, reqNo: hit.reqNo, title: r.title.trim() });
        continue;
      }
    }
    const id = uuid();
    const reqNo = resolveReqNo(usedNos, requested);
    usedNos.add(reqNo);
    if (requested && requested !== reqNo) reqNoMap.push({ from: requested, to: reqNo });
    order += 1;
    insReq.run(id, projectId, reqNo, r.title.trim(), r.content ?? '', r.sourceRef ?? '', r.priority ?? 'normal', order, prdId ?? null, t, t);
    noToId.set(reqNo, id);
    // 计划条目仍按 PRD 里的原编号引用：把「请求编号 → 本行 id」登记到原编号空间（顺延后关联不断链，T01921）
    // T01995：同一原编号被本次两行争用时点名（后登记者仍按既有口径胜出），不再静默
    if (requested) {
      const claimed = requestedToId.get(requested);
      if (claimed && claimed !== id) ambiguousReqNos.add(requested);
      requestedToId.set(requested, id);
    }
    newReqs.push({ id, reqNo, title: r.title.trim() });
  }
}

/**
 * T02090 口径 A：补 child 边——按区间规则（里程碑之后、下一里程碑之前的 normal 行）
 *  给子行 deps 并集写入 {id:<里程碑id>,type:'child'}（addChildEdge 已有边原样返回，幂等；
 *  不动 status/progress/日期）。新行与 reuse 行都补边，重导同一份 PRD 不产生重复边。
 *  包络/进度重算**只对新建里程碑**做：reuse 行的 status/progress/起止日期受 T01875 保护
 *  （重导不得打回 0%），其聚合由启动对账 reconcileMilestoneProgresses 权威收敛。
 *  ⚠ 重算必须在**全部边写完之后**统一做：包络/进度都读全量子项，边写一半就重算会漏算后继子项。
 */
function applyImportMilestoneChildEdges(
  db: ReturnType<typeof getDb>, ctx: {
    t: string;
    planItems: PrdImportPlanItem[];
    planKinds: PlanKind[];
    planTargets: PrdImportPlanTarget[];
    planIds: Array<string | null>;
  },
): void {
  const { t, planItems, planKinds, planTargets, planIds } = ctx;
  const edges = intervalChildEdges(planItems.map((_, i) => ({ kind: planKinds[i] })));
  const updDeps = db.prepare('UPDATE plan_tasks SET deps = ?, updated_at = ? WHERE id = ?');
  const newMs = new Set(planTargets.map((x, i) => (x.reuseId ? null : planIds[i])).filter((x): x is string => !!x));
  const touchedParents = new Set<string>();
  for (const { index, parentIndex } of edges) {
    const childId = planIds[index];
    const parentId = planIds[parentIndex];
    if (!childId || !parentId) continue;
    const cur = db.prepare('SELECT deps FROM plan_tasks WHERE id = ?').get(childId) as { deps: string | null } | undefined;
    if (!cur) continue;
    const next = addChildEdge(cur.deps, parentId);
    if (next !== (cur.deps ?? '')) updDeps.run(next, t, childId);
    touchedParents.add(parentId);
  }
  for (const parentId of touchedParents) {
    if (!newMs.has(parentId)) continue;
    // T01704：里程碑起止/工期取自子任务包络（导入产物不再「止期晚于子任务」）
    recalcMilestoneEnvelope(db, parentId);
    // T02090：进度聚合（新里程碑 + 全新待办子项 → 待开始态/0%，通常零变化；防的是「导完就 0% 常驻」）
    recalcMilestoneProgress(db, parentId);
  }
}

/**
 * WBS → 待办任务（便于 AI 推进执行），待办同样携带 req_ids；返回本次新建的待办条数。
 * T00754：导入的待办必须与计划建立关联（plan_tasks.linked_task_id）——
 * 任务列表的「计划」徽标（TaskService.list 反查）与项目管理页「待办联动」均依赖该字段，
 * 缺失会导致任务无「计划」标签、项目管理页显示「未关联」。
 */
function createPrdImportTodos(
  db: ReturnType<typeof getDb>, ctx: {
    t: string;
    projectId: string;
    createTasks: boolean;
    planItems: PrdImportPlanItem[];
    planTargets: PrdImportPlanTarget[];
    planIds: Array<string | null>;
    findReqId: (n: string) => string | null;
  },
): number {
  const { t, projectId, createTasks, planItems, planTargets, planIds, findReqId } = ctx;
  if (!createTasks || planItems.length === 0) return 0;
  const insTask = db.prepare(
    `INSERT INTO tasks (id, task_no, project_id, title, description, priority, status, verified, archived, pinned, req_ids, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'todo', 0, 0, 0, ?, ?, ?)`,
  );
  const linkPlan = db.prepare('UPDATE plan_tasks SET linked_task_id = ?, updated_at = ? WHERE id = ? AND linked_task_id IS NULL');
  const updTaskReq = db.prepare('UPDATE tasks SET req_ids = ?, updated_at = ? WHERE id = ?');
  let created = 0;
  planTargets.forEach((target, i) => {
    const p = planItems[i];
    if (!p) return;
    const ids = (p.reqNos ?? []).map((n) => findReqId(n)).filter((x): x is string => !!x);
    if (target.reuseId) {
      // T01875 reuse：原行已有派生待办 → 不再造第二条（同标题待办会在任务列表并排重复，
      // 也破坏 T01874 的「一个待办只由一个计划承载」口径）；未归档的那条只把本次需求编号并入 req_ids（只增不减），
      // 已归档的既有承载不擅自复活。
      const linkedTaskId = (db.prepare('SELECT linked_task_id FROM plan_tasks WHERE id = ?').get(target.reuseId) as { linked_task_id: string | null } | undefined)?.linked_task_id;
      if (linkedTaskId) {
        const liveTask = db.prepare('SELECT id, req_ids FROM tasks WHERE id = ? AND archived = 0').get(linkedTaskId) as { id: string; req_ids: string | null } | undefined;
        if (liveTask) {
          const curIds = parseLinkIds(liveTask.req_ids);
          const added = ids.filter((x) => !curIds.includes(x));
          if (added.length > 0) updTaskReq.run(JSON.stringify([...curIds, ...added]), t, liveTask.id);
        }
        return;
      }
    }
    const planId = planIds[i];
    if (!planId) return;
    const taskId = uuid();
    // T01875：待办标题跟随实际落库标题（撞名让号后与计划行保持一致，便于反查）
    insTask.run(taskId, nextTaskNo(), projectId, `[PRD] ${target.title}`, p.description ?? '', 'normal', ids.length ? JSON.stringify(ids) : null, t, t);
    linkPlan.run(taskId, t, planId);
    created += 1;
  });
  return created;
}

export const PlanService = {
  /** T01058-FR1.3：就绪任务推荐——依赖满足（serial 前置已完成；parallel 不阻塞）或无 deps 的普通执行行；
   *  携带关联待办编号（linked_task_id → tasks.task_no）供「现在做这个」卡片跳转定位。
   *  T01284：判定改为与排水链路（TaskService.readyAndOrder）共用 util/planDeps，避免「推荐说未就绪、排水说就绪」。 */
  readyTasks(projectId: string, limit = 3): Array<{ id: string; title: string; duration_days: number; complexity: number | null; start_date: string; task_no: string | null }> {
    const db = getDb();
    const rows = db.prepare(
      `SELECT id, title, duration_days, complexity, start_date, sort_order, deps, linked_task_id
         FROM plan_tasks WHERE project_id = ? AND archived = 0 AND kind = 'normal' AND status NOT IN ('done','blocked')
        ORDER BY start_date, sort_order`,
    ).all(projectId) as Array<{ id: string; title: string; duration_days: number; complexity: number | null; start_date: string; sort_order: number; deps: string | null; linked_task_id: string | null }>;
    const statusById = new Map(
      (db.prepare('SELECT id, status FROM plan_tasks WHERE project_id = ? AND archived = 0').all(projectId) as Array<{ id: string; status: string }>)
        .map((r) => [r.id, r.status]),
    );
    const taskNoById = new Map(
      (db.prepare("SELECT id, task_no FROM tasks WHERE archived = 0 AND task_no IS NOT NULL").all() as Array<{ id: string; task_no: string }>)
        .map((r) => [r.id, r.task_no]),
    );
    const out: Array<{ id: string; title: string; duration_days: number; complexity: number | null; start_date: string; task_no: string | null }> = [];
    for (const r of rows) {
      if (!depsSatisfied(parsePlanDeps(r.deps), statusById)) continue;
      out.push({ id: r.id, title: r.title, duration_days: r.duration_days, complexity: r.complexity, start_date: r.start_date, task_no: r.linked_task_id ? taskNoById.get(r.linked_task_id) ?? null : null });
      if (out.length >= limit) break;
    }
    return out;
  },

  /** 活跃计划列表（排除已归档；归档条目走 listArchived，T00442 语义：删除=归档） */
  list(projectId: string): PlanTaskRow[] {    const rows = getDb().prepare(
      `SELECT p.*, t.title AS linked_task_title
       FROM plan_tasks p LEFT JOIN tasks t ON t.id = p.linked_task_id
       WHERE p.project_id = ? AND p.archived = 0 AND COALESCE(p.history_at, '') = '' ORDER BY p.sort_order`,
    ).all(projectId) as Array<PlanTaskRow & { linked_task_title: string | null }>;
    return rows.map((r) => ({
      ...r,
      linked_task_missing: r.linked_task_id != null && r.linked_task_title == null,
    }));
  },

  /**
   * 归档计划列表（含项目名）——供「归档」菜单的恢复/彻底删除操作（T00442 扩展）。
   * T02284：支持 keyword（标题/项目名，与归档页原本地过滤同口径）、projectId 服务端筛选与 limit/offset 分页。
   * ⚠ 缺省 limit=全量：MCP（mtask_list_plans 归档分支）与 `scripts/verify-t01874.mjs` 依赖不带分页参数的全量语义。
   */
  listArchived(opts: { keyword?: string; projectId?: string; limit?: number; offset?: number } = {}): Array<PlanTaskRow & { project_name: string }> {
    const where = ['p.archived = 1'];
    const values: unknown[] = [];
    if (opts.projectId) { where.push('p.project_id = ?'); values.push(opts.projectId); }
    if (opts.keyword) {
      // 转义 LIKE 通配符（%/_），让搜索词按字面匹配（与 TaskService.buildTaskFilter 同规则）
      const kw = `%${opts.keyword.replaceAll(/[%_]/g, (m) => '\\' + m)}%`;
      where.push(String.raw`(p.title LIKE ? ESCAPE '\' OR pr.name LIKE ? ESCAPE '\')`);
      values.push(kw, kw);
    }
    let sql = `SELECT p.*, pr.name AS project_name, t.title AS linked_task_title
       FROM plan_tasks p
       JOIN projects pr ON pr.id = p.project_id
       LEFT JOIN tasks t ON t.id = p.linked_task_id
       WHERE ${where.join(' AND ')} ORDER BY p.archived_at DESC, p.project_id, p.sort_order`;
    if (opts.limit) {
      sql += ' LIMIT ? OFFSET ?';
      values.push(opts.limit, opts.offset ?? 0);
    }
    return getDb().prepare(sql).all(...values) as Array<PlanTaskRow & { project_name: string; linked_task_title: string | null }>;
  },

  /** T02284：与 listArchived 同一套过滤条件的总数（归档页服务端分页的「共 N 条」） */
  countArchived(opts: { keyword?: string; projectId?: string } = {}): number {
    const where = ['p.archived = 1'];
    const values: unknown[] = [];
    if (opts.projectId) { where.push('p.project_id = ?'); values.push(opts.projectId); }
    if (opts.keyword) {
      const kw = `%${opts.keyword.replaceAll(/[%_]/g, (m) => '\\' + m)}%`;
      where.push(String.raw`(p.title LIKE ? ESCAPE '\' OR pr.name LIKE ? ESCAPE '\')`);
      values.push(kw, kw);
    }
    const row = getDb().prepare(
      `SELECT COUNT(*) AS n
       FROM plan_tasks p
       JOIN projects pr ON pr.id = p.project_id
       WHERE ${where.join(' AND ')}`,
    ).get(...values) as { n: number };
    return row.n;
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
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    // T00764 顺带修复（T00561 引入的缺陷）：非首条计划 start 误置空串 → refreshTaskEnd 抛「日期格式非法」，
    // 同项目第二条计划经 POST /plans 无法创建。各行独立语义下 startDate 恒被尊重，缺省今天。
    let start = input.startDate && dateRe.test(input.startDate) ? input.startDate : fmt(new Date());
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
        patch.color ?? (row.color ?? ''),
        patch.deps ?? (row.deps ?? ''),
        patch.kind ?? (row.kind ?? 'normal'),
        now(),
        id,
      );
      // T00561：去掉默认串行链——变更只影响本任务（end 重算），仅显式配置依赖的任务联动传播
      const cur = this.get(id)!;
      db.prepare('UPDATE plan_tasks SET end_date = ? WHERE id = ?')
        .run(calcEndDate(cur.start_date, cur.duration_days, loadCalendar()), id);
      rescheduleDependents(db, row.project_id, id);
      // T01704：子任务日期/工期变动后，父里程碑按子任务包络收口（止期不再晚于其子任务）。
      // T02090：一行可有多个 child 归属（脏数据/手动挂接），遍历全部父里程碑（旧实现只取第一个）
      for (const pid of new Set(childParentIds(row.deps ?? ''))) recalcMilestoneEnvelope(db, pid);
      if (patch.deps !== undefined) {
        for (const pid of new Set(childParentIds(patch.deps))) recalcMilestoneEnvelope(db, pid);
      }
      // T02090：里程碑进度聚合——本次变更若涉及状态/进度/deps，受影响里程碑按子项 done 数重算。
      // 聚合权威：人工 PATCH 里程碑 status/progress 后，若仍有子项则以子项实况为准
      // （T02042 红线「先把里程碑标完成会让后续进度失去意义」的守卫）。
      if (patch.status !== undefined || patch.progress !== undefined || patch.deps !== undefined) {
        for (const msId of affectedMilestones(row, patch)) recalcMilestoneProgress(db, msId);
      }
      if (linkedTaskId) {
        db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(taskStatusForPlan(status), now(), linkedTaskId);
      }
      // T01266：需求追溯维度（req_ids）关联待办的同步（矩阵关联场景）。
      // 仅当本次确实变更了计划状态才传播，避免普通字段编辑（标题/工期等）误触待办回退。
      if (patch.status !== undefined && PLAN_STATUSES.has(patch.status)) {
        const planReqIds = parseLinkIds(row.req_ids);
        if (planReqIds.length > 0) syncReqLinkedTasks(db, row.project_id, planReqIds, status);
        // T02087：需求状态随计划完成度派生（与上一行同一闸门：仅状态变更时触发）。
        syncReqStatuses(db, row.project_id, planReqIds);
      }
    })();
    return this.get(id);
  },

  /** 归档（原「删除」语义，T00442 扩展）：软删——从时间线移除并衔接重排，可在归档菜单恢复。
   *  T02090：归档会改变父里程碑的子项分母（done 子项被移出 → 进度可能回落），故重算父里程碑。 */
  archive(id: string): boolean {
    const db = getDb();
    const row = this.get(id);
    if (!row || row.archived) return false;
    db.transaction(() => {
      db.prepare('UPDATE plan_tasks SET archived = 1, archived_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id);
      recalcMilestonesOfChild(db, id);
    })();
    notifyChange('plans');
    return true;
  },

  /** 恢复：取消归档并插回原排序位衔接重排（前序取恢复位之前最近的未归档任务）。
   *  T02090：恢复即子项重新计入分母，同样重算父里程碑。 */
  restore(id: string): boolean {
    const db = getDb();
    const row = this.get(id);
    if (!row?.archived) return false;
    db.transaction(() => {
      db.prepare('UPDATE plan_tasks SET archived = 0, archived_at = NULL, updated_at = ? WHERE id = ?').run(now(), id);
      recalcMilestonesOfChild(db, id);
    })();
    notifyChange('plans');
    return true;
  },

  /** 彻底删除的连带影响预览（T01874）：删除不可逆，前端确认文案须先写明连带条数。只读，不落库 */
  purgeImpact(id: string): { strippedTasksArchived: number; strippedReqLinks: number } {
    const db = getDb();
    const row = db.prepare('SELECT id, title, req_ids, linked_task_id FROM plan_tasks WHERE id = ?').get(id) as PurgePlanRow | undefined;
    if (!row) return { strippedTasksArchived: 0, strippedReqLinks: 0 };
    return { strippedTasksArchived: derivedTaskOfPurgedPlan(db, row) ? 1 : 0, strippedReqLinks: countLiveReqLinks(db, row.req_ids) };
  },

  /**
   * 彻底删除（归档菜单专用）：物理删除行；已归档行不参与时间线，无需重排。
   * T01874：连带把「仅由该计划派生」的孤儿待办一并归档（不删数据，与「待办删除=归档」同口径，可在归档菜单还原），
   * 并回传破坏面 { strippedTasksArchived, strippedReqLinks }——原实现只返回 boolean，
   * 待办变孤儿、矩阵「已关联计划」列少一条这两处变化全静默（用户报的「RTM 关联需求记录消失」有一半是这个）。
   */
  purge(id: string): { deleted: boolean; strippedTasksArchived: number; strippedReqLinks: number } {
    const db = getDb();
    const row = db.prepare('SELECT id, title, req_ids, linked_task_id, archived FROM plan_tasks WHERE id = ?').get(id) as
      (PurgePlanRow & { archived: number }) | undefined;
    if (!row?.archived) return { deleted: false, strippedTasksArchived: 0, strippedReqLinks: 0 };
    const derivedTaskId = derivedTaskOfPurgedPlan(db, row);
    const strippedReqLinks = countLiveReqLinks(db, row.req_ids);
    let deleted = false;
    db.transaction(() => {
      deleted = db.prepare('DELETE FROM plan_tasks WHERE id = ? AND archived = 1').run(id).changes > 0;
      if (deleted && derivedTaskId) ArchiveService.archive([derivedTaskId]);
    })();
    if (deleted && derivedTaskId) notifyChange('tasks');
    return { deleted, strippedTasksArchived: deleted && derivedTaskId ? 1 : 0, strippedReqLinks };
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
        `INSERT INTO tasks (id, task_no, project_id, title, description, priority, status, verified, archived, pinned, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'normal', ?, 0, 0, 0, ?, ?)`,
      ).run(taskId, nextTaskNo(), row.project_id, `[计划] ${row.title}`, row.description || '', taskStatusForPlan(row.status), t, t);
      db.prepare('UPDATE plan_tasks SET linked_task_id = ?, updated_at = ? WHERE id = ?').run(taskId, now(), id);
    })();
    return { plan: this.get(id)!, taskId, reused: false };
  },

  // ---------- 节假日 ----------

  listHolidays(): Array<{ date: string; name: string; kind: string }> {
    return getDb().prepare('SELECT date, name, kind FROM holidays ORDER BY date').all() as Array<{ date: string; name: string; kind: string }>;
  },

  /** T00764：kind='holiday' 放假日 | 'overtime' 加班日（同日重复添加视为切换类型，upsert 覆盖） */
  addHoliday(date: string, name: string, kind: 'holiday' | 'overtime' = 'holiday'): void {
    if (!DATE_RE.test(date)) throw new Error('日期格式应为 YYYY-MM-DD');
    if (kind !== 'holiday' && kind !== 'overtime') throw new Error('类型非法：应为 holiday 或 overtime');
    getDb().prepare("INSERT INTO holidays (date, name, kind) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET name = excluded.name, kind = excluded.kind")
      .run(date, name.trim(), kind);
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
      const cal = loadCalendar();
      const upd = db.prepare('UPDATE plan_tasks SET end_date = ?, updated_at = ? WHERE id = ?');
      const t = now();
      db.transaction(() => {
        for (const r of rows) {
          if (!isDate(r.start_date)) continue;
          upd.run(calcEndDate(r.start_date, Math.max(1, r.duration_days), cal), t, r.id);
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
      const duration = resolveDuration(durationRaw, start, endDate);
      if (duration === null) { fail(`工期非法：${durationRaw || '(空)'}（应为 ≥1 的整数，或提供开始/结束日期自动换算）`); return; }
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
      const ins = db.prepare(
        `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
           progress, status, assignee, sort_order, linked_task_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '', ?, 0, ?, ?, ?, NULL, ?, ?)`,
      );
      const cal = loadCalendar();
      parsed.forEach((p, i) => {
        // T00561：各行日期独立——开始日用自己的（空则今天），end 按工作日计算，不联动他人
        const start = p.startDate || fmt(new Date());
        const end = calcEndDate(start, p.durationDays, cal);
        ins.run(uuid(), projectId, p.title, p.description, start, end, p.durationDays, p.status, p.assignee, maxOrder + 1 + i, t, t);
      });
    })();
    return { inserted: parsed.length, errors: [] };
  },

  /** 导出：sheet1=计划任务（与模板同列序同样式，T00500 验证修正），sheet2=节假日 */
  /** T01071-FR5.3：项目全量 Markdown 导出——任务清单 + WBS 计划 + 需求跟踪矩阵（单文档，人工可读/可归档） */
  exportMarkdown(projectId: string): string {
    const db = getDb();
    const proj = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string } | undefined;
    const name = proj?.name ?? projectId;
    // T01361（S6551）：入参具体化为 string|null|undefined——调用点均传 DB TEXT 列值，行为等价
    const esc = (s: string | null | undefined) => (s ?? '').replaceAll('|', String.raw`\|`).replaceAll('\n', ' ');
    const lines: string[] = [];
    lines.push(`# ${name} · 全量导出`, '', `> 生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}　|　来源：MTask 项目管理`, '');
    // 任务清单
    const tasks = db.prepare(
      `SELECT task_no, title, status, priority, verified FROM tasks WHERE project_id = ? AND archived = 0 ORDER BY task_no`,
    ).all(projectId) as Array<{ task_no: string | null; title: string; status: string; priority: string; verified: number }>;
    pushTaskTable(lines, tasks, esc);
    // WBS 计划
    pushPlanTable(lines, this.list(projectId), esc);
    // 需求跟踪矩阵
    const reqs = this.listRequirements(projectId);
    if (reqs.length > 0) pushReqTable(lines, reqs, esc);
    return lines.join('\n');
  },

  async exportExcel(projectId: string): Promise<Buffer> {    const rows = this.list(projectId);
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
      const line = cells.join(' | ').replace(/[\s|]+$/, '').trim();
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
      // T00814：清洗 Word 域代码（目录/页码/交叉引用），并把「整行都是域码」的行丢弃
      const cleanText = stripWordFieldCodes(text);
      if (!cleanText.trim()) continue;
      // 标题样式识别：Heading1-4 或**纯数字** styleId（中文版 Word 把「标题2」存为 styleId "2"）——统一转 # 前缀保留层级。
      // T00814 修复：原文案里的 `/(\d)/`（任意位置含数字）会把普通段落样式误判成标题——
      // 实测「编号/日期/描述」（styleId 149）、封面（214）、目录行（49/58/36）全部被标成 #~#### 标题，
      // 正文结构被污染。这里只接受「恰好一位数字」的 styleId，不再做模糊兜底。
      const level = Number((/^Heading\s*(\d)$/i.exec(style) ?? /^([1-9])$/.exec(style))?.[1] ?? 0);
      if (level >= 1 && level <= 4) {
        lines.push(`${'#'.repeat(level)} ${cleanText}`);
      } else {
        // 非标题段落直接保留文本（列表编号在文本内，AI 可从编号语义识别层级）
        lines.push(cleanText);
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
      // T01688 项 1：依赖列解析——文档含「依赖」章节/「依赖：」行/「← 某某」表述时按此填 depsOn
      '6. depsOn：本条依赖的其它条目的 WBS 编号或完整标题数组；仅当文档明确给出依赖时才填，判断不了就给空数组（严禁编造依赖）',
      '7. 输出元素形如：{"title":"1.1 需求评审","description":"…","durationDays":2,"assignee":"","status":"todo","depsOn":["1 项目启动"]}',
    ].join('\n');
    // T00723：JSON 解析失败/输出截断自动重试 1 次，且解析成败计入 ai_usage（ask-json）
    const ai = await AIService.askJson(toolId, system, `【需求文档】\n${docText}`, (content) =>
      parseJsonArrayWithRecovery(content, 'AI 未返回有效的 WBS 数组，请检查文档内容或更换模型'),
    );
    if (!ai.ok) throw new Error(`AI 拆分失败：${ai.error}`);
    const drafts = ai.data as unknown[];
    const items: Array<{ title: string; description: string; startDate: string; durationDays: number; assignee: string; status: PlanStatus; depsOn: string[] }> = [];
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
        // T01688 项 1：依赖引用原样透出（落库时由 createBatch 解析为 deps；未解析到的会回 warnings「依赖待补」）
        depsOn: Array.isArray(o.depsOn) ? o.depsOn.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()) : [],
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

  /** PRD 解析：原始计划条目 → 归一化计划草稿数组（reqNos 字符串过滤，durationDays≥1，status 固定为待办初始态）——实现见模块底部 normalizePrdPlans */

  /** T00662：AI 解析 PRD →（需求清单 + WBS 计划草稿，含需求关联）。 */
  async aiParsePrd(toolId: string, docText: string): Promise<{
    requirements: Array<{ reqNo: string; title: string; content: string; sourceRef: string; priority: string }>;
    drafts: Array<{ title: string; description: string; durationDays: number; startDate: string; reqNos: string[]; status: PlanStatus; kind: PlanKind }>;
    coverageWarn?: string;
    /** T01156：反向覆盖——需求清单中存在、但未被任何 WBS 计划 reqNos 关联的需求编号（可追溯性缺口）。 */
    uncoveredReqNos?: string[];
    /** T01156：首轮输出被截断、已用精简模式重试（requirements≤20/plans≤24）——数量可能被压缩，需求可能静默丢失。 */
    truncatedNote?: string;
  }> {
    const system = [
      '你是 MTask 的 PRD 解析助手：既要拆分 WBS 计划，也要**逐条提取可跟踪需求**（用于生成需求跟踪矩阵）。',
      '给定一份 PRD / 需求文档（Markdown 或纯文本），输出**一个 JSON 对象**（不是数组），结构：',
      '{"requirements":[{"reqNo":"REQ-001","title":"需求简述","content":"需求原文要点","sourceRef":"原文定位（章节/小节/段落号）","priority":"low|normal|high|urgent"}],',
      // T01001：plans 每行必须给出 kind，用于导入时区分「里程碑」与「普通任务」——顶层里程碑 kind="milestone"，明细任务 kind="normal"
      // T02275：不再要 startDate——normalizePrdPlans 硬编码覆盖为 ''，让模型输出纯属浪费输出预算（约 15 字符/行 × 60 行）
      ' "plans":[{"title":"WBS编号+任务名","description":"该节点要做的事（保留原文关键信息）","durationDays":工期工作日数,"reqNos":["REQ-001"],"kind":"milestone|normal","complexity":1到5的整数}]}',
      // T00979：此前只让 AI 按 WBS 编号扁平输出，模型常停在里程碑层（如 M1-M4）不再向下拆明细。
      // 现强制「里程碑 + 每个里程碑下的明细任务」两级展开，且顶层保留原文里程碑名，杜绝只出里程碑不出任务。
      '要求：',
      '1. **需求逐条提取，严禁合并**——PRD 中每条可跟踪的需求（功能/非功能/约束/验收要点）各生成一条 requirements，reqNo 从 REQ-001 顺序编号；',
      '2. **plans 必须是「里程碑 + 里程碑下的明细任务」两级展开的扁平数组，每行一条**：',
      '   - 顶层：PRD 中定义的里程碑/阶段（如 M1/M2/M3/M4 或「项目启动」「开发实施」「测试验收」等），标题写带编号的里程碑名（例：「1 M1 平台搭建」），**务必保留原文里程碑名称、不得重命名**；',
      '   - 每个顶层里程碑之下，必须继续拆出该阶段可直接执行的任务明细（如 1 之下拆出「1.1 需求评审」「1.2 概要设计」，2 之下拆出「2.1 …」），用 WBS 编号表达层级（1 → 1.1、1.2；2 → 2.1 …），全部行放进同一个 plans 数组；',
      '   - **绝对禁止只输出里程碑而不拆明细任务**；若某里程碑在原文确无可落实的独立任务，才允许仅保留该里程碑一行；',
      '   - **每行必须填 kind**：顶层里程碑行填 "milestone"，其下的明细任务行填 "normal"（使用述求准确、不遗漏的这两类取值，不要用其它写法）；',
      '   - 每行 reqNos 只填**该节点直接实现/覆盖的需求编号**；管理类节点（启动/计划/评审/验收等）若不对应具体需求，reqNos 输出 []，**不要把所有需求挂上**（关联过宽会让需求跟踪矩阵失去意义）；',
      '   - **可追溯性约束（必须遵守）**：功能/非功能/约束类需求（REQ-xxx 各一条）至少应被一个明细任务（kind="normal" 行）的 reqNos 覆盖。若某需求确无现成 WBS 节点承载，必须在 plans 末尾为它补一条 normal 任务（标题含该 REQ 编号，如「REQ-016 相关实现/验证」）以保证**每条需求都可追溯到至少一条计划**；严禁出现「需求清单有、WBS 却无人认领」的缺口。',
      '   - **每行（normal 明细任务）必须给出 complexity 复杂度评级（1~5 整数）**：1=琐碎（半天内）、2=简单、3=中等、4=复杂（不确定性高/跨模块耦合，建议再拆分）、5=极复杂（应拆分为多个任务）；里程碑行可不填或填其下平均；',
      '3. **不要输出 startDate**（保存后系统按导入当日并行排布：各行独立取导入日为开始日，不做串行顺延，写了也会被覆盖）；status 一律 "todo"；durationDays 缺失默认 1；',
      '4. 只输出 JSON 对象本身，不要任何解释或 Markdown 代码围栏；不虚构文档中没有的内容。',
      // T00707：原「宁多勿漏」会把长文档的输出顶到 token 上限而截断（用户实测导入报错），改为规模约束
      // T00979：上限从 25 条放宽到 60 条，以满足「里程碑 + 明细」两层组织；仍强制 JSON 完整闭合优先
      '5. **输出规模控制（必须遵守）**：requirements 最多 40 条；plans 最多 60 条（需容纳里程碑与明细两级，先保证每个里程碑至少带其直接明细任务，再取舍更细的层级）；title ≤30 字、content/description ≤40 字。'
      + '文档过长时合并同类需求与同级任务，**宁可少几条也不得把里程碑降级为无明细**，同时必须保证 JSON 完整闭合——输出被截断会导致整个导入失败。',
    ].join('\n');
    // T00707：首轮若被截断/解析失败，重试改用精简提示词（压缩到更小规模，确保能完整闭合）
    const systemCompact = [
      system,
      '【精简模式·仅本次重试】上次输出超出长度被截断。本次请大幅压缩：requirements ≤20 条（只输出 reqNo 与 title，content 与 sourceRef 输出空串）、'
      + 'plans ≤24 条（只输出 title 与 reqNos，description 空串，**仍须保留里程碑并尽量带出各里程碑下最重要的 1~2 条明细**）；标题 ≤20 字。宁可少，也必须输出完整可解析的 JSON 对象。',
    ].join('\n');
    // T00723：JSON 解析失败/输出截断自动重试 1 次，且解析成败计入 ai_usage（ask-json）
    // T01156：首轮预算抬到 PRD_PARSE_MIN_OUTPUT_TOKENS，避免长 PRD 触顶 max_tokens 截断 → 触发精简重试硬砍 requirements≤20 静默丢需求
    // T02275：改传 minMaxTokens（下限语义）——工具 max_tokens 配得比 8192 高时**不再被硬覆盖砍回**，
    //   模型管理里把该工具调到 16384 才真正生效；8192 底线保留（T01156 网关 502 教训：不盲目抬默认值）。
    const ai = await AIService.askJson(toolId, system, `【PRD 文档】\n${docText}`, (content) =>
      parseJsonObjectWithRecovery(content, 'AI 未返回有效的 PRD 解析结果（需 JSON 对象），请检查文档内容或更换模型'),
      { timeoutMs: PRD_PARSE_TIMEOUT_MS, retrySystem: systemCompact, minMaxTokens: PRD_PARSE_MIN_OUTPUT_TOKENS },
    );
    if (!ai.ok) throw new Error(`AI 解析失败：${ai.error}`);
    // T01156：精简重试一旦触发，说明首轮输出被截断（需求/计划数量可能被压缩），必须显式告知，不能静默丢需求
    const truncatedNote = ai.retried
      ? '首轮 AI 输出超长被截断，已自动启用精简模式重试（需求≤20、计划≤24，且需求 content/原文定位被清空）——若需求数量明显偏少，建议调大该工具的 max_tokens 或更换模型后重跑'
      : '';
    const obj = ai.data as Record<string, unknown>;
    const rawReqs = Array.isArray(obj.requirements) ? obj.requirements : [];
    const requirements = normalizeRequirements(rawReqs);
    const rawPlans = Array.isArray(obj.plans) ? obj.plans : [];
    const drafts = normalizePrdPlans(rawPlans);
    if (requirements.length === 0 && drafts.length === 0) throw new Error('AI 未能从 PRD 中解析出需求或计划，请确认文档内容或更换模型');
    // T01156：反向覆盖检查（collectUncoveredReqNos / buildCoverageWarn）——需求清单中存在、
    // 但未被任何 WBS 计划 reqNos 关联的需求编号即可追溯性缺口。
    const uncoveredReqNos = collectUncoveredReqNos(requirements, drafts);
    const coverageWarn = buildCoverageWarn(drafts.length, requirements.length, uncoveredReqNos);
    return { requirements, drafts, coverageWarn, uncoveredReqNos, truncatedNote };
  },

  /** T00763：导入 PRD 解析结果——事务创建需求项 + 计划（含 req_ids 关联）+ 可选同步生成待办任务。 */
  /** T00712（D-5）：返回 unlinkedReqNos——reqNos 引用了本次导入中不存在的需求编号时不再静默丢弃。 */
  /** T00763：input.prdMd（PRD Markdown 原文）非空时完整落库 prd_docs，并回填需求行 prd_id——供矩阵「查看PRD」与 AI 上下文反查。 */
  /**
   * T01875：重复导入的计划行口径（T01869 只回传事实、不改落库，本单把口径定下来）——
   * 默认 `onDuplicatePlan:'new'`：延续 T01867/T01921 已确立的「已有条目一律不动，新行让号」同构口径，
   *   撞名不再并排同名，新行标题自动带 `（N）` 区分后缀；
   * 显式 `'reuse'`：幂等重跑，按标题命中未归档同名原行补差异与需求关联，**绝不改原行 status/progress**。
   */
  importPrd(projectId: string, input: {
    requirements?: Array<{ reqNo?: string; title: string; content?: string; sourceRef?: string; priority?: string }>;
    // T01001：plans 行支持 kind（milestone=里程碑 / normal=普通任务），导入时据此区分，不再全部转成普通任务
    plans?: Array<{ title: string; description?: string; durationDays?: number; startDate?: string; reqNos?: string[]; assignee?: string; kind?: PlanKind; complexity?: number; status?: PlanStatus }>;
    createTasks?: boolean;
    prdMd?: string;
    prdFilename?: string;
    onDuplicatePlan?: 'new' | 'reuse';
  }): { requirements: number; requirementsCreated: number; reusedRequirements: number; plans: number; tasks: number; unlinkedReqNos: string[]; prdId?: string; reqNoMap: Array<{ from: string; to: string }>; dupPlanTitles: Array<{ title: string; existing: number; renamedTo?: string; reusedPlanId?: string }>; reusedPlans: number; ambiguousReqNos: string[]; orphanRequirements: Array<{ reqNo: string; title: string }>; planRowIds: Array<string | null> } {
    const db = getDb();
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new Error('项目不存在');
    const reqs = (input.requirements ?? []).filter((r) => r?.title?.trim());
    const planItems = (input.plans ?? []).filter((p) => p?.title?.trim());
    if (reqs.length === 0 && planItems.length === 0) throw new Error('没有可导入的需求或计划条目');
    // T01001 二轮：落库前统一汇总里程碑工期（= 其下明细之和），覆盖直接调 import-prd / MCP 未做汇总的路径
    const planKinds = planItems.map((p) => (p.kind ?? resolvePrdKind(p.title, p.kind)));
    const planDurations = milestoneDurations(planItems.map((p, i) => ({ kind: planKinds[i], durationDays: p.durationDays })));
    const t = now();
    let taskCount = 0;
    const unlinkedReqNos = new Set<string>();
    const reqNoMap: Array<{ from: string; to: string }> = []; // T01867：撞号顺延明细（请求编号 → 实际落库编号）
    // T01995：多来源合并导入的两处静默缺陷补漏——
    // ① ambiguousReqNos：同一「PRD 原编号」被本次 payload 的两行争用（两份 PRD 各自从 REQ-001 起号且调用方未分表重编号）。
    //    旧实现只把歧义静默吸收成「后写覆盖先写」，前一份文档的关联被悄悄改挂到后一份的行上
    //    （实测 mtask四期 前 20 行零关联），这里点名回传；归属仍沿用既有覆盖语义，不改 T01921 已复验的关联口径。
    // ② orphanRequirements：本次新建却零计划/待办关联的需求行。unlinkedReqNos 只校验编号存在性，
    //    「挂错行」因编号存在而完全不报警，这里按行清点，让同类问题不再静默通过。
    const ambiguousReqNos = new Set<string>();
    const newReqs: Array<{ id: string; reqNo: string; title: string }> = [];
    // T02303 甲：reuse 模式下命中的存量需求行（不新建、不改写），供回传 reusedRequirements 计数
    const reusedReqs: Array<{ id: string; reqNo: string; title: string }> = [];
    const linkedReqIds = new Set<string>();
    // T00763 / T01156-3：PRD 原文落库与同名/同内容覆盖复用（口径与逐段说明见 persistPrdDocForImport）
    const prdId = persistPrdDocForImport(db, projectId, input.prdMd, input.prdFilename, t);
    // T01869 / T01875：同名计划的处置口径与 planTargets/dupPlanTitles 生成见 resolveImportPlanTargets。
    const reuseMode = input.onDuplicatePlan === 'reuse';
    const { planTargets, dupPlanTitles } = resolveImportPlanTargets(db, projectId, planItems, reuseMode);
    const reusedPlans = planTargets.filter((x) => x.reuseId).length;
    let insertedPlans = 0; // 实际新建的计划行数（reuse 命中的行不计数，返回给调用方区分「新建/复用」）
    // T02131：与 planItems 下标对齐的计划行 id，事务内外都要用（返回值 planRowIds 给调用方回填依赖）
    const planIds: Array<string | null> = new Array(planItems.length).fill(null);
    db.transaction(() => {
      // 1) 需求项（矩阵行）——reqNo → id 映射供计划/待办关联
      // T01995：两个编号空间分开登记——
      //   noToId         落库编号（顺延后的实际编号）→ id，权威；
      //   requestedToId  PRD 原编号 → id，计划条目引用的就是这个空间（T01921 的顺延不断链靠它）。
      // 查号按「原编号空间优先」：原编号 REQ-013 撞上别行的落库新号 REQ-013 属正常顺延产物，
      // 不能被当成歧义误报（否则每次增量导入都会红一片），只有同一原编号被本次两行争用才是真歧义。
      const noToId = new Map<string, string>();
      const requestedToId = new Map<string, string>();
      // T02131：编号解析补第三层回落——计划引用「上一次导入已建好的矩阵行」。
      // 旧实现只认本次 payload 的编号空间，增量回写（计划挂到既有 REQ-021）会被判 unlinkedReqNos
      // 并静默丢关联，正是四期 K1~K8「计划无矩阵、无待办」那类孤儿的成因之一。
      // 项目内 req_no 唯一（T01872 唯一索引），按号定位是确定性的。
      const existingReqCache = new Map<string, string | null>();
      const existingReqId = (n: string): string | null => {
        const key = n.trim();
        if (!key) return null;
        if (existingReqCache.has(key)) return existingReqCache.get(key) ?? null;
        const row = db.prepare('SELECT id FROM prd_requirements WHERE project_id = ? AND req_no = ?').get(projectId, key) as { id: string } | undefined;
        const id = row?.id ?? null;
        existingReqCache.set(key, id);
        return id;
      };
      const findReqId = (n: string) => requestedToId.get(n) ?? noToId.get(n) ?? existingReqId(n);
      // T01867 / T01995：需求项落库与两个编号空间登记（口径见 insertPrdRequirementsForImport）
      insertPrdRequirementsForImport(db, projectId, reqs, {
        t, prdId, noToId, requestedToId, ambiguousReqNos, reqNoMap, newReqs, reuseMode, reusedReqs,
      });
      // 2) 计划（含 req_ids 关联）
      // T01875：planIds 与 planItems 下标对齐，元素是该条目实际落库的计划 id——
      // 新建行取 createBatch 返回值，reuse 行指向命中的原行（不新建）。
      // 旧实现（T01869 口径）一律新建且不判重，重导同一份 PRD 会留下并排同名两套计划，无法幂等重跑。
      const newIdx: number[] = [];
      planTargets.forEach((target, i) => { if (!target.reuseId) newIdx.push(i); });
      if (newIdx.length > 0) {
        const created = this.createBatch(projectId, newIdx.map((i) => ({
          title: planTargets[i].title,
          description: planItems[i].description,
          startDate: planItems[i].startDate,
          // T01001 二轮：工期用汇总后的值（里程碑 = 其下明细之和），保证导入后两边对得上
          durationDays: planDurations[i],
          assignee: planItems[i].assignee,
          // T02131：经 MCP 计划回写通道进来的条目允许带自身状态（此前一律落到 PlanStatus 默认态「待开始」）；缺省仍是默认态
          status: planItems[i].status ?? ('todo' as PlanStatus),
          complexity: planItems[i].complexity, // T01058-FR2.1：AI 复杂度评级随导入落库
          // T01001：里程碑/普通任务在导入时确定类型，避免全部落入默认 normal；
          // AI 解析路径已由 normalizePrdPlans 推好 kind，此处的兜底覆盖直接调 import-prd/MCP 未显式传 kind 的场景
          kind: planKinds[i],
        })));
        insertedPlans = created.inserted;
        created.ids.forEach((id, k) => { const i = newIdx[k]; if (i !== undefined) planIds[i] = id; });
      }
      // T00709（D-1 修复）：按 createBatch 返回的 id（与 planItems 同一下标序，两侧 title 过滤口径一致）回写 req_ids，
      // 废弃按标题 find 匹配——同名计划会命中同一行导致关联互相覆盖丢失
      const updPlan = db.prepare('UPDATE plan_tasks SET req_ids = ?, updated_at = ? WHERE id = ?');
      const updReuse = db.prepare(
        `UPDATE plan_tasks SET description = ?, complexity = ?, req_ids = COALESCE(?, req_ids), updated_at = ?
         WHERE id = ? AND archived = 0`,
      );
      planTargets.forEach((target, i) => {
        const p = planItems[i];
        if (!p) return;
        const rawNos = p.reqNos ?? [];
        // T00712（D-5）：引用了不存在的需求编号 → 记入 unlinkedReqNos 供调用方提示
        for (const n of rawNos) if (!findReqId(n)) unlinkedReqNos.add(n);
        const ids = rawNos.map((n) => findReqId(n)).filter((x): x is string => !!x);
        for (const rid of ids) linkedReqIds.add(rid); // T01995：零关联清点用
        if (target.reuseId) {
          // T01875 reuse：只补差异字段与需求关联——
          // 需求关联取「并集」（只增不减；覆盖式写入会让原行手工加的关联消失），
          // 描述/复杂度仅在原值为空时补填；status、progress、起止日期一律不写
          // （T01869 硬约束：重导不得把已有进度打回 0%／未开始）。
          const cur = db.prepare('SELECT description, complexity, req_ids FROM plan_tasks WHERE id = ? AND archived = 0')
            .get(target.reuseId) as { description: string | null; complexity: number | null; req_ids: string | null } | undefined;
          if (!cur) return;
          const description = (cur.description ?? '').trim() ? cur.description : (p.description ?? '');
          const complexity = cur.complexity ?? (p.complexity ?? null);
          const curReqIds = parseLinkIds(cur.req_ids);
          const added = ids.filter((x) => !curReqIds.includes(x));
          updReuse.run(description ?? '', complexity, added.length > 0 ? JSON.stringify([...curReqIds, ...added]) : null, t, target.reuseId);
          return;
        }
        const planId = planIds[i];
        if (planId && ids.length > 0) updPlan.run(JSON.stringify(ids), t, planId);
      });
      // 2.5) T02090 口径 A：补 child 边 + 新建里程碑的包络/进度重算（口径与逐段说明见
      //  applyImportMilestoneChildEdges；⚠ 必须在全部边写完之后统一重算）
      applyImportMilestoneChildEdges(db, { t, planItems, planKinds, planTargets, planIds });
      // 3) 可选：WBS → 待办任务（便于 AI 推进执行），待办同样携带 req_ids（口径见 createPrdImportTodos）
      taskCount = createPrdImportTodos(db, {
        t, projectId, createTasks: !!input.createTasks, planItems, planTargets, planIds, findReqId,
      });
      if (insertedPlans === 0 && reqs.length > 0) {
        // 仅导入需求（无计划）时属合法场景，不抛错
      }
    })();
    // T01995：本次新建却零计划/待办关联的需求行（仅在「有计划条目参与导入」时清点——
    // 只导需求不导计划属合法场景，全部列为零关联会变成噪音）
    const orphanRequirements = planItems.length > 0
      ? newReqs.filter((x) => !linkedReqIds.has(x.id)).map((x) => ({ reqNo: x.reqNo, title: x.title }))
      : [];
    // T02131：把「输入 plans 下标 → 实际落库计划行 id」交还调用方。
    // MCP 计划回写通道需要它来做依赖回填——撞名让号/复用命中都会让「按标题找 id」不可靠，只有下标对齐才准确。
    const planRowIds = planTargets.map((x, i) => x.reuseId ?? planIds[i] ?? null);
    return {
      requirements: reqs.length,
      // T02303 甲：把「本次 payload 需求数」与「实际新建/复用数」分开回传——
      // 旧返回只有 requirements=reqs.length，调用方（含面板/MCP）无法看出 reuse 到底有没有真的幂等，
      // 「补写一次就多出一套同标题需求行」因此长期静默。
      requirementsCreated: newReqs.length,
      reusedRequirements: reusedReqs.length,
      plans: insertedPlans,
      tasks: taskCount,
      unlinkedReqNos: [...unlinkedReqNos],
      prdId,
      reqNoMap,
      dupPlanTitles,
      reusedPlans,
      ambiguousReqNos: [...ambiguousReqNos],
      orphanRequirements,
      planRowIds,
    };
  },

  // ---------- T00763：PRD 原文文档（存储 / 查看 / 反向更新 / AI 上下文反查） ----------

  /** PRD 文档列表（按项目；不含正文，列表轻量） */
  listPrdDocs(projectId: string): Array<Record<string, unknown>> {
    const db = getDb();
    return db.prepare(
      `SELECT id, project_id, filename, status, LENGTH(content_md) AS content_chars, created_at, updated_at
       FROM prd_docs WHERE project_id = ? ORDER BY created_at DESC`,
    ).all(projectId) as Array<Record<string, unknown>>;
  },

  /** T00959：导出件头部需要的项目简要信息（名称缺失时回退「未命名项目」，不抛错以不阻断导出） */
  getProjectBrief(projectId: string): { id: string; name: string } {
    const row = getDb().prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) as { id: string; name: string } | undefined;
    return row ?? { id: projectId, name: '未命名项目' };
  },

  /** PRD 文档详情（含完整 Markdown 原文） */
  getPrdDoc(id: string): Record<string, unknown> {
    const db = getDb();
    const row = db.prepare('SELECT * FROM prd_docs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error('PRD 文档不存在');
    return row;
  },

  /** 反向更新 PRD 内容（全量覆盖）：AI 或用户经接口把修订后的 Markdown 回写原文 */
  updatePrdDoc(id: string, patch: { contentMd?: string; filename?: string }): Record<string, unknown> {
    const db = getDb();
    const row = db.prepare('SELECT id FROM prd_docs WHERE id = ?').get(id);
    if (!row) throw new Error('PRD 文档不存在');
    const contentMd = typeof patch.contentMd === 'string' ? patch.contentMd : '';
    if (!contentMd.trim()) throw new Error('contentMd 不能为空（反向更新为全量覆盖，请传入完整 Markdown 原文）');
    db.prepare('UPDATE prd_docs SET content_md = ?, filename = COALESCE(?, filename), updated_at = ? WHERE id = ?')
      .run(contentMd, typeof patch.filename === 'string' ? patch.filename : null, now(), id);
    return this.getPrdDoc(id);
  },

  // ---------- T00770：PRD 管理视图（新建 / 删除 / 状态流转 / 待确认问题） ----------

  /** 新建 PRD 文档（空白或导入的 Markdown 原文）；status 缺省 'prd'（草稿/评审中） */
  createPrdDoc(input: { projectId: string; filename: string; contentMd: string; status?: string; originHash?: string }): Record<string, unknown> {
    const db = getDb();
    if (!input.projectId) throw new Error('projectId 必填');
    if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(input.projectId)) throw new Error('项目不存在');
    const status = input.status === 'confirmed' ? 'confirmed' : 'prd';
    const originHash = input.originHash?.trim() ?? '';
    // T00821：覆盖模式——按同源生成批次(origin_hash)识别已录入的 PRD，命中则覆盖该条（更新正文/文件名/状态）
    // 并替换其待确认问题（先删旧，由调用方随后重新批量插入），不新建记录、不产生重复。
    if (originHash) {
      const existing = db.prepare('SELECT id FROM prd_docs WHERE project_id = ? AND origin_hash = ?').get(input.projectId, originHash) as { id: string } | undefined;
      if (existing) {
        const t = now();
        db.prepare('UPDATE prd_docs SET content_md = ?, filename = ?, status = ?, updated_at = ? WHERE id = ?')
          .run(input.contentMd ?? '', input.filename ?? '', status, t, existing.id);
        db.prepare('DELETE FROM prd_issues WHERE prd_id = ?').run(existing.id);
        logService.log('INFO', 'prd', `[PRD覆盖] project=${input.projectId} doc=${existing.id} filename=${input.filename} 覆盖时间=${t}（操作人留空）`);
        return this.getPrdDoc(existing.id);
      }
    }
    const id = uuid();
    const t = now();
    db.prepare('INSERT INTO prd_docs (id, project_id, filename, content_md, status, origin_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.projectId, input.filename ?? '', input.contentMd ?? '', status, originHash, t, t);
    return this.getPrdDoc(id);
  },

  /** 删除 PRD 文档（其待确认问题经 FK CASCADE 一并清理） */
  deletePrdDoc(id: string): void {
    const db = getDb();
    if (!db.prepare('SELECT id FROM prd_docs WHERE id = ?').get(id)) throw new Error('PRD 文档不存在');
    db.prepare('DELETE FROM prd_issues WHERE prd_id = ?').run(id);
    db.prepare('DELETE FROM prd_docs WHERE id = ?').run(id);
  },

  /** 状态流转：'prd'（草稿/评审中）↔ 'confirmed'（确认版） */
  setPrdDocStatus(id: string, status: string): Record<string, unknown> {
    const db = getDb();
    if (status !== 'prd' && status !== 'confirmed') throw new Error("status 仅支持 'prd' | 'confirmed'");
    if (!db.prepare('SELECT id FROM prd_docs WHERE id = ?').get(id)) throw new Error('PRD 文档不存在');
    db.prepare('UPDATE prd_docs SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
    return this.getPrdDoc(id);
  },

  /** 待确认问题列表（按项目；可按文档过滤；T02218：软删除条目不出现在任何列表） */
  listIssues(projectId: string, prdId?: string): Array<Record<string, unknown>> {
    const db = getDb();
    if (prdId) {
      return db.prepare("SELECT * FROM prd_issues WHERE project_id = ? AND prd_id = ? AND COALESCE(deleted_at, '') = '' ORDER BY sort_order, created_at").all(projectId, prdId) as Array<Record<string, unknown>>;
    }
    return db.prepare("SELECT * FROM prd_issues WHERE project_id = ? AND COALESCE(deleted_at, '') = '' ORDER BY sort_order, created_at").all(projectId) as Array<Record<string, unknown>>;
  },

  /** 新增待确认问题（prd_id 可空=项目级泛问题） */
  addIssue(input: { projectId: string; prdId?: string; question: string }): Record<string, unknown> {
    const db = getDb();
    if (!input.projectId) throw new Error('projectId 必填');
    if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(input.projectId)) throw new Error('项目不存在');
    if (!input.question?.trim()) throw new Error('question 必填');
    if (input.prdId && !db.prepare('SELECT id FROM prd_docs WHERE id = ?').get(input.prdId)) throw new Error('PRD 文档不存在');
    const id = uuid();
    const t = now();
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM prd_issues WHERE project_id = ?').get(input.projectId) as { m: number };
    db.prepare('INSERT INTO prd_issues (id, project_id, prd_id, question, answer, status, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, \'\', \'open\', ?, ?, ?)')
      .run(id, input.projectId, input.prdId ?? null, input.question.trim(), max.m + 1, t, t);
    return db.prepare('SELECT * FROM prd_issues WHERE id = ?').get(id) as Record<string, unknown>;
  },

  /** 编辑待确认问题（问题内容 / 结论 / 状态 open↔resolved / AI建议；T02218：已软删除的拒绝编辑） */
  updateIssue(id: string, patch: { question?: string; answer?: string; status?: string; suggestion?: string }): Record<string, unknown> {
    const db = getDb();
    const row = db.prepare('SELECT * FROM prd_issues WHERE id = ?').get(id) as
      { status: string; answer: string; deleted_at: string | null } | undefined;
    if (!row) throw new Error('待确认问题不存在');
    if (row.deleted_at) throw new Error('待确认问题已删除，无法编辑');
    if (patch.status !== undefined && patch.status !== 'open' && patch.status !== 'resolved') {
      throw new Error("status 仅支持 'open' | 'resolved'");
    }
    // H-1 修复：以「本次请求生效后的最终 answer」判空——传空串 + resolved 也必须拒绝（原先只查 patch.answer===undefined 分支，空串可绕过并清空已确认结论）
    const finalAnswer = patch.answer ?? row.answer;
    if (patch.status === 'resolved' && !String(finalAnswer).trim()) {
      throw new Error('标记为已确认前请先填写结论（answer）');
    }
    db.prepare('UPDATE prd_issues SET question = COALESCE(?, question), answer = COALESCE(?, answer), status = COALESCE(?, status), suggestion = COALESCE(?, suggestion), updated_at = ? WHERE id = ?')
      .run(patch.question?.trim() ?? null, patch.answer ?? null, patch.status ?? null, patch.suggestion?.trim() ?? null, now(), id);
    return db.prepare('SELECT * FROM prd_issues WHERE id = ?').get(id) as Record<string, unknown>;
  },

  /** T02218：删除改为逻辑删除（deleted_at 置时间）——数据保留，可由管理员在「设置 → 数据维护」恢复；
   *  单条与批量删除共用此通道，操作写入日志（T02218 约束：删除保留操作日志）。 */
  deleteIssue(id: string): void {
    const db = getDb();
    const row = db.prepare('SELECT id, question FROM prd_issues WHERE id = ?').get(id) as { id: string; question: string } | undefined;
    if (!row) throw new Error('待确认问题不存在');
    const t = now();
    db.prepare('UPDATE prd_issues SET deleted_at = ?, updated_at = ? WHERE id = ?').run(t, t, id);
    logService.log('INFO', 'prd', `[待确认问题删除] 软删除 id=${id} question=${row.question.slice(0, 120)}（可在 设置→数据维护 恢复）`);
  },

  /** T00769：批量录入待确认问题（AI 生成的问题清单 + 用户自定义一次入库），返回新建行 */
  addIssuesBatch(input: { projectId: string; prdId?: string; items: Array<{ question: string; answer?: string; level?: string; suggestion?: string }> }): Array<Record<string, unknown>> {
    const db = getDb();
    if (!input.projectId) throw new Error('projectId 必填');
    if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(input.projectId)) throw new Error('项目不存在');
    if (input.prdId && !db.prepare('SELECT id FROM prd_docs WHERE id = ?').get(input.prdId)) throw new Error('PRD 文档不存在');
    const items = (input.items ?? []).filter((x) => typeof x.question === 'string' && x.question.trim());
    if (items.length === 0) throw new Error('items 不能为空（至少一条非空 question）');
    const LEVELS = new Set(['blocker', 'suggested', 'info', 'custom', '']);
    const max = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM prd_issues WHERE project_id = ?').get(input.projectId) as { m: number }).m;
    const out: Array<Record<string, unknown>> = [];
    const t = now();
    items.forEach((x, i) => {
      const level = typeof x.level === 'string' && LEVELS.has(x.level) ? x.level : '';
      const id = uuid();
      // T00822：结转状态按「是否已填结论」区分——有 answer → resolved(已确认)，空 answer → open(待确认)。
      // 此前统一写死 'open' 导致「已录结论的问题在 PRD 管理视图仍显示待确认」，反馈明确。
      const answer = x.answer?.trim() ?? '';
      const status = answer ? 'resolved' : 'open';
      db.prepare("INSERT INTO prd_issues (id, project_id, prd_id, question, answer, status, level, suggestion, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, input.projectId, input.prdId ?? null, x.question.trim(), answer, status, level, x.suggestion?.trim() ?? '', max + 1 + i, t, t);
      out.push(db.prepare('SELECT * FROM prd_issues WHERE id = ?').get(id) as Record<string, unknown>);
    });
    return out;
  },

  /**
   * T02218：批量回写——逐条复用 writebackIssue（同一套判重/锚点/事务逻辑），
   * 单条失败（未确认/无结论/未关联文档/已回写）不影响其余，原因逐项返回供前端展开；
   * 不做整体事务：批量语义即「部分成功」。
   */
  batchWritebackIssues(ids: string[]): {
    succeeded: Array<{ id: string; question: string; prdId: string; filename: string }>;
    failed: Array<{ id: string; question: string; reason: string }>;
  } {
    const db = getDb();
    const succeeded: Array<{ id: string; question: string; prdId: string; filename: string }> = [];
    const failed: Array<{ id: string; question: string; reason: string }> = [];
    for (const id of ids) {
      const row = db.prepare('SELECT question FROM prd_issues WHERE id = ?').get(id) as { question: string } | undefined;
      const question = row?.question ?? '';
      try {
        const r = this.writebackIssue(id);
        succeeded.push({ id, question, prdId: String(r.doc.id ?? ''), filename: String(r.doc.filename ?? '') });
      } catch (e) {
        failed.push({ id, question, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return { succeeded, failed };
  },

  /** T02218：批量删除（逻辑删除）——逐条调用 deleteIssue（含操作日志），部分失败不阻断其余 */
  batchDeleteIssues(ids: string[]): {
    succeeded: Array<{ id: string; question: string }>;
    failed: Array<{ id: string; question: string; reason: string }>;
  } {
    const db = getDb();
    const succeeded: Array<{ id: string; question: string }> = [];
    const failed: Array<{ id: string; question: string; reason: string }> = [];
    for (const id of ids) {
      const row = db.prepare('SELECT question FROM prd_issues WHERE id = ?').get(id) as { question: string } | undefined;
      const question = row?.question ?? '';
      try {
        this.deleteIssue(id);
        succeeded.push({ id, question });
      } catch (e) {
        failed.push({ id, question, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return { succeeded, failed };
  },

  /**
   * 回写：把已确认问题的「问题 + 结论」写入对应 PRD 文档的 Markdown。
   * 规则：文档含「## 待确认问题结论」节 → 条目插入该节标题后（节内最前，保证节内聚合）；
   *       无该节 → 在文档末尾追加节 + 条目。重复回写同一问题会被拒绝（按问题文本判重）。
   */
  writebackIssue(id: string): { doc: Record<string, unknown>; issue: Record<string, unknown> } {
    const db = getDb();
    const issue = db.prepare('SELECT * FROM prd_issues WHERE id = ?').get(id) as
      { id: string; prd_id: string | null; question: string; answer: string; status: string; deleted_at: string | null } | undefined;
    if (!issue) throw new Error('待确认问题不存在');
    if (issue.deleted_at) throw new Error('待确认问题已删除，无法回写');
    if (issue.status !== 'resolved') throw new Error('问题尚未确认（status=resolved）——请先填写结论并确认');
    if (!issue.answer.trim()) throw new Error('结论（answer）为空，无法回写');
    if (!issue.prd_id) throw new Error('该问题未关联 PRD 文档，无法回写');
    const prdId: string = issue.prd_id; // 属性收窄不入闭包（事务回调内引用），此处固化
    const anchor = `<!-- issue:${issue.id} -->`;

    // 走查 L-2：历史数据迁移——文档里已有同文条目但无锚点（锚点机制上线前的历史回写）时，
    // 就地补锚后再判重拒绝。否则该问题日后被编辑文本，锚点/文本双不匹配会写出重复条目。
    // （单条 UPDATE 自身原子，独立于下方写入事务执行——避免迁移随判重 throw 一起回滚）
    const preDoc = this.getPrdDoc(issue.prd_id) as { content_md: string };
    if (!preDoc.content_md.includes(anchor) && preDoc.content_md.includes(`### Q：${issue.question}\n`)) {
      const qIdx = preDoc.content_md.indexOf(`### Q：${issue.question}\n`);
      db.prepare('UPDATE prd_docs SET content_md = ?, updated_at = ? WHERE id = ?')
        .run(preDoc.content_md.slice(0, qIdx) + `${anchor}\n` + preDoc.content_md.slice(qIdx), now(), issue.prd_id);
      throw new Error('该问题的结论已回写至 PRD（历史条目已补锚点），无需重复回写');
    }

    // 走查 M-1：写入包事务——better-sqlite3 同步驱动下当前无让位点，此处为将来引入异步 IO 的防御，
    // 保证「读全文→拼装→写回」不被未来的 await 打断产生丢失更新
    const ts = now();
    const write = db.transaction((): { doc: Record<string, unknown>; issue: Record<string, unknown> } => {
      const doc = this.getPrdDoc(prdId) as { id: string; content_md: string };
      const SECTION = '## 待确认问题结论';
      // T00781：稳定锚点判重——以 issue id 为锚（不依赖可变的 question 文本），
      // 问题被编辑后仍能识别「已回写」，避免同一问题重复写入导致正文堆积重复结论。
      // 兼容：历史数据无锚点时回退按问题文本判定（L-2 已在上一步为命中的历史条目补锚）。
      const entry = `\n\n${anchor}\n### Q：${issue.question}\n\n**结论**：${issue.answer.trim()}\n`;
      if (doc.content_md.includes(anchor) || doc.content_md.includes(`### Q：${issue.question}\n`)) {
        throw new Error('该问题的结论已回写至 PRD（按问题锚点判重），无需重复回写');
      }
      let next: string;
      // T00781：节定位改行首正则——原先 indexOf('\n'+SECTION+'\n') 在「该节位于文档首行」时判不到，
      // 会走到 else 分支追加第二个同名节；正则匹配行首可覆盖该边缘。
      const secMatch = /^##[ \t]+待确认问题结论[ \t]*$/m.exec(doc.content_md);
      if (secMatch) {
        const lineEnd = secMatch.index + secMatch[0].length;
        const insertAt = Math.min(lineEnd + 1, doc.content_md.length); // 越过标题行换行
        next = doc.content_md.slice(0, insertAt) + entry.replace(/^\n\n/, '') + '\n' + doc.content_md.slice(insertAt);
      } else {
        next = `${doc.content_md.replace(/\n*$/, '\n\n')}${SECTION}\n${entry.replace(/^\n\n/, '')}\n`;
      }
      db.prepare('UPDATE prd_docs SET content_md = ?, updated_at = ? WHERE id = ?').run(next, ts, prdId);
      // 走查 L-4：issue 本函数未修改、doc 仅 content_md/updated_at 变化——复用事务内首读对象，省两次查询
      return { doc: { ...doc, content_md: next, updated_at: ts } as Record<string, unknown>, issue: issue as Record<string, unknown> };
    });
    return write();
  },

  // ---------- T00662：需求跟踪矩阵 CRUD ----------

  /** 矩阵行列表（按项目；含关联的计划与待办摘要，供矩阵展示「需求 ← 计划/任务」关联关系） */
  /**
   * T01361：需求跟踪矩阵行（prd_requirements 全列 + 联表摘要）——具体化类型替代
   * `Record<string, unknown>`（Sonar S6551：unknown/object 字符串化无法证明有 toString）。
   */
  listRequirements(projectId: string): RequirementRow[] {
    const db = getDb();
    const reqs = db.prepare('SELECT * FROM prd_requirements WHERE project_id = ? ORDER BY sort_order, created_at').all(projectId) as Array<Omit<RequirementRow, 'linkedPlans' | 'linkedTasks' | 'prdDoc'>>;
    const plans = db.prepare('SELECT id, title, status, req_ids FROM plan_tasks WHERE project_id = ? AND archived = 0').all(projectId) as Array<{ id: string; title: string; status: string; req_ids: string | null }>;
    const tasks = db.prepare('SELECT id, task_no, title, status, verified, req_ids FROM tasks WHERE project_id = ? AND archived = 0').all(projectId) as Array<{ id: string; task_no: string | null; title: string; status: string; verified: number; req_ids: string | null }>;
    const parse = (v: string | null): string[] => {
      if (!v) return [];
      try { const a = JSON.parse(v) as unknown; return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
    };
    // T00763：项目内 PRD 文档摘要——矩阵行经 prd_id 关联，前端「查看PRD」按钮按此取文档
    const prdDocs = db.prepare('SELECT id, filename FROM prd_docs WHERE project_id = ?').all(projectId) as Array<{ id: string; filename: string }>;
    const docById = new Map(prdDocs.map((d) => [d.id, d]));
    // T00784：反向索引替换 O(N×M) 逐需求 filter——原先每个需求都对全量 plans/tasks 重跑
    // JSON.parse（N 需求 × M 计划/任务），压测实测 436 次调用累计 117.6s 事件循环时间，
    // 并拖慢同进程所有其它端点。现改为对 plans/tasks 各遍历一次建 Map<reqId, 摘要[]>，
    // 复杂度降为 O(N+M)，req_ids 仅解析一次。（不改返回结构与字段顺序）
    const plansByReq = new Map<string, Array<{ id: string; title: string; status: string }>>();
    for (const p of plans) {
      for (const id of parse(p.req_ids)) {
        const bucket = plansByReq.get(id);
        const item = { id: p.id, title: p.title, status: p.status };
        if (bucket) bucket.push(item); else plansByReq.set(id, [item]);
      }
    }
    const tasksByReq = new Map<string, Array<{ id: string; taskNo: string | null; title: string; status: string; verified: boolean }>>();
    for (const x of tasks) {
      for (const id of parse(x.req_ids)) {
        const bucket = tasksByReq.get(id);
        const item = { id: x.id, taskNo: x.task_no, title: x.title, status: x.status, verified: !!x.verified };
        if (bucket) bucket.push(item); else tasksByReq.set(id, [item]);
      }
    }
    return reqs.map((r) => {
      const rid = String(r.id);
      const linkedPlans = plansByReq.get(rid) ?? [];
      const linkedTasks = tasksByReq.get(rid) ?? [];
      const prdId = typeof r.prd_id === 'string' ? r.prd_id : null;
      const prdDoc = prdId ? docById.get(prdId) : undefined;
      return { ...r, linkedPlans, linkedTasks, prdDoc: prdDoc ?? null };
    });
  },

  createRequirement(projectId: string, input: { reqNo?: string; title: string; content?: string; sourceRef?: string; priority?: string; status?: string }): Record<string, unknown> {
    const db = getDb();
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new Error('项目不存在');
    const t = now();
    const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM prd_requirements WHERE project_id = ?').get(projectId) as { m: number }).m;
    const id = uuid();
    // T01867：手工新增走「显式编号撞号即报错」——用户手打的编号是他引用的名字，静默改号比拒绝更糟；
    // 自动编号（留空）走同一顺延器，不再用 MAX(sort_order)+1（删除中间行/改过排序后会与存量编号重复）。
    const usedNos = new Set<string>(
      (db.prepare('SELECT req_no FROM prd_requirements WHERE project_id = ?').all(projectId) as Array<{ req_no: string | null }>)
        .map((r) => String(r.req_no ?? '').trim()).filter(Boolean),
    );
    const requested = (input.reqNo ?? '').trim();
    // 占用判定按编号同一性（REQ-01 与 REQ-001 是同一个号），否则两种写法能并存、顺延也白做
    if (requested && isReqNoTaken(usedNos, requested)) throw new Error(`需求编号「${requested}」在本项目已存在，请换一个或直接留空由系统顺延`);
    const reqNo = resolveReqNo(usedNos, requested);
    db.prepare(
      `INSERT INTO prd_requirements (id, project_id, req_no, title, content, source_ref, priority, status, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, projectId, reqNo, input.title.trim(), input.content ?? '', input.sourceRef ?? '', input.priority ?? 'normal', input.status ?? 'todo', maxOrder + 1, t, t);
    return db.prepare('SELECT * FROM prd_requirements WHERE id = ?').get(id) as Record<string, unknown>;
  },

  updateRequirement(id: string, patch: { title?: string; content?: string; reqNo?: string; sourceRef?: string; priority?: string; status?: string; sortOrder?: number; prdId?: string }): Record<string, unknown> {
    const db = getDb();
    // T01867：改成已被占用的编号同样拒绝（编号是按编号定位需求的键，两行同号会让关联指向不确定）
    const targetNo = patch.reqNo === undefined ? undefined : String(patch.reqNo).trim();
    if (targetNo) {
      const self = db.prepare('SELECT project_id FROM prd_requirements WHERE id = ?').get(id) as { project_id: string } | undefined;
      if (!self) throw new Error('需求不存在');
      // 同项目其余行按编号同一性判占用（SQL 等值比不出 REQ-01 与 REQ-001 这种混写同号）
      const others = (db.prepare('SELECT req_no FROM prd_requirements WHERE project_id = ? AND id <> ?').all(self.project_id, id) as Array<{ req_no: string | null }>)
        .map((r) => String(r.req_no ?? '').trim()).filter(Boolean);
      if (isReqNoTaken(others, targetNo)) throw new Error(`需求编号「${targetNo}」在本项目已被其他需求占用`);
    }
    const sets: string[] = [];
    const vals: unknown[] = [];
    const map: Array<[keyof typeof patch, string]> = [['title', 'title'], ['content', 'content'], ['reqNo', 'req_no'], ['sourceRef', 'source_ref'], ['priority', 'priority'], ['status', 'status'], ['sortOrder', 'sort_order'], ['prdId', 'prd_id']];
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

  /**
   * 删除需求行：清理计划/待办上的悬空引用，返回破坏面（T01869）。
   * 原实现全表扫描 plan_tasks/tasks（连项目条件都没有），项目多时每次删一行都要重写
   * 无关项目的 updated_at；现按需求所属项目过滤。test_cases.req_id 是 CASCADE 外键，
   * 删除需求会物理带走其下用例，故把条数一并回传，供调用方核对（前端弹前已有确认文案）。
   */
  deleteRequirement(id: string): { strippedPlans: number; strippedTasks: number; deletedCases: number } {
    const db = getDb();
    const req = db.prepare('SELECT project_id FROM prd_requirements WHERE id = ?').get(id) as { project_id: string } | undefined;
    if (!req) throw new Error('需求不存在');
    const projectId = req.project_id;
    const plans = db.prepare("SELECT id, req_ids FROM plan_tasks WHERE project_id = ? AND COALESCE(req_ids,'') != ''").all(projectId) as Array<{ id: string; req_ids: string }>;
    const tasks = db.prepare("SELECT id, req_ids FROM tasks WHERE project_id = ? AND COALESCE(req_ids,'') != ''").all(projectId) as Array<{ id: string; req_ids: string }>;
    const deletedCases = (db.prepare('SELECT COUNT(*) AS n FROM test_cases WHERE req_id = ?').get(id) as { n: number }).n;
    const strip = (json: string): string | null => {
      try {
        const a = (JSON.parse(json) as unknown[]).filter((x) => x !== id);
        return a.length > 0 ? JSON.stringify(a) : null;
      } catch { return null; }
    };
    let strippedPlans = 0;
    let strippedTasks = 0;
    db.transaction(() => {
      for (const p of plans) { const n = strip(p.req_ids); if (n !== p.req_ids) { db.prepare('UPDATE plan_tasks SET req_ids = ?, updated_at = ? WHERE id = ?').run(n, now(), p.id); strippedPlans += 1; } }
      for (const x of tasks) { const n = strip(x.req_ids); if (n !== x.req_ids) { db.prepare('UPDATE tasks SET req_ids = ?, updated_at = ? WHERE id = ?').run(n, now(), x.id); strippedTasks += 1; } }
      db.prepare('DELETE FROM prd_requirements WHERE id = ?').run(id);
    })();
    return { strippedPlans, strippedTasks, deletedCases };
  },

  /** T01867：项目内重复需求编号分组（存量脏数据可见化；新数据已不会再产生） */
  duplicateReqNos(projectId: string): Array<{ reqNo: string; count: number; variants: string[]; ids: string[] }> {
    const db = getDb();
    // T01873：取 id 并按矩阵顺序返回——面板的行内标记与「点提示直达第一组」都依赖 id 与顺序
    const rows = db.prepare('SELECT id, req_no FROM prd_requirements WHERE project_id = ? ORDER BY sort_order, created_at').all(projectId) as Array<{ id: string; req_no: string | null }>;
    return groupDuplicateReqNos(rows);
  },

  /** 关联调整：把需求关联到计划/待办（或解除）——矩阵面板的「关联调整」编辑入口 */
  linkRequirement(reqId: string, target: { kind: 'plan' | 'task'; targetId: string; linked: boolean }): void {
    const db = getDb();
    const table = target.kind === 'plan' ? 'plan_tasks' : 'tasks';
    // M6-6.1：目标种类 → 人话名词（原散落各处的三元命名统一后，错误文案不再重复）
    const label = target.kind === 'plan' ? '计划' : '待办';
    // T00710（D-2 修复）：校验需求与目标同项目（对齐 linkTodo 的同项目约束），防矩阵跨项目混入脏关联
    const req = db.prepare('SELECT project_id FROM prd_requirements WHERE id = ?').get(reqId) as { project_id: string } | undefined;
    if (!req) throw new Error('需求不存在');
    const row = db.prepare(`SELECT req_ids, project_id FROM ${table} WHERE id = ?`).get(target.targetId) as { req_ids: string | null; project_id: string } | undefined;
    if (!row) throw new Error(`${label}不存在`);
    if (req.project_id !== row.project_id) throw new Error(`仅可关联同项目的${label}`);
    const { ids, added } = applyLinkToggle(parseLinkIds(row.req_ids), reqId, target.linked);
    db.prepare(`UPDATE ${table} SET req_ids = ?, updated_at = ? WHERE id = ?`).run(ids.length > 0 ? JSON.stringify(ids) : null, now(), target.targetId);
    if (target.kind === 'task' && added) syncTaskCoveredDone(db, row.project_id, target.targetId, reqId);
    // T02087：关联建立/解除都改变该需求的完成度读数（解除后可能从全 done 退回 doing），
    // 与上一行的待办反向同步同一时机重算；无关联项时派生自动跳过（保持人工状态）。
    syncReqStatuses(db, row.project_id, [reqId]);
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
    const parseChunk = async (chunk: string, toolId: string, system: string, dedup: Set<string>): Promise<PlanDraft[]> => {
      const ai = await AIService.ask(toolId, system, `【Excel 表格文本】\n${chunk}`);
      if (!ai.ok || !ai.content) return []; // 单块失败跳过，不拖垮整体
      const arr = parseJsonArrayWithRecovery(ai.content, '');
      const out: PlanDraft[] = [];
      for (const r of arr) {
        const d = normalizeDraft(r);
        if (!d) continue;
        const fingerprint = `${d.title}|${d.startDate ?? ''}|${(d.description ?? '').slice(0, 40)}|${d.assignee ?? ''}`;
        if (!dedup.has(fingerprint)) { dedup.add(fingerprint); out.push(d); }
      }
      return out;
    };
    for (const chunk of chunks) {
      drafts.push(...await parseChunk(chunk, toolId, system, seen));
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
  /**
   * 批量创建（T00561 后各行日期独立）。
   * T01688 项 1：items 可带 `depsOn`——按标题引用同批或库内已有条目，创建后解析为 deps 落库：
   *  - 引用目标为里程碑（kind=milestone）→ type='child'（归属，里程碑按子任务包络收口）；
   *  - 其余 → type='serial'（串行前置，触发排期联动）。
   * 无法解析的引用不静默丢弃：以 warnings 返回，供上层提示「依赖待补」。
   */
  createBatch(projectId: string, items: Array<{ title: string; description?: string; startDate?: string; durationDays?: number; assignee?: string; status?: PlanStatus; kind?: PlanKind; complexity?: number; depsOn?: string[] }>, opts: { dupPolicy?: 'warn' | 'block' } = {}): { inserted: number; ids: string[]; warnings?: string[] } {
    if (!getDb().prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new Error('项目不存在');
    const clean = items.filter((it) => it.title?.trim());
    if (clean.length === 0) throw new Error('没有可创建的计划条目');
    if (clean.length > 5000) throw new Error('单次创建上限 5000 条');
    const db = getDb();
    const t = now();
    const cal = loadCalendar();
    const ids: string[] = [];
    const warnings: string[] = [];
    // T01868 防重入：同一份计划拆解经 AI 通道重复落库会留下并排两套计划（四期 E 系列 / [PRD] M 系列事故）。
    // dupPolicy=block（AI 通道默认）时同名占比过高直接拒写；warn（页面/PRD 导入）只提示不落库行为变更，沿用 T01869 口径。
    {
      const titles = new Set(clean.map((it) => it.title.trim()));
      const countSame = db.prepare('SELECT COUNT(*) AS n FROM plan_tasks WHERE project_id = ? AND title = ? AND archived = 0');
      const dups: string[] = [];
      for (const title of titles) {
        if ((countSame.get(projectId, title) as { n: number }).n > 0) dups.push(title);
      }
      if (dups.length > 0) {
        warnings.push(`本批 ${dups.length}/${titles.size} 个标题与该项目已有计划同名（示例：${dups.slice(0, 3).join('、')}）`);
        if (opts.dupPolicy === 'block' && dups.length >= 3 && dups.length / titles.size >= 0.6) {
          throw new Error(`防重入拦截：本批 ${dups.length}/${titles.size} 个标题与项目已有计划同名，判定为同一份拆解重复落库（示例：${dups.slice(0, 5).join('、')}）。确属新增条目请显式传 allowDuplicates`);
        }
      }
    }
    db.transaction(() => {
      const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM plan_tasks WHERE project_id = ? AND archived = 0').get(projectId) as { m: number }).m;
      const ins = db.prepare(
        `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
           progress, status, assignee, sort_order, linked_task_id, kind, complexity, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      );
      clean.forEach((it, i) => {
        const duration = Math.max(1, Math.floor(Number(it.durationDays) || 1));
        const status = PLAN_STATUSES.has(it.status as PlanStatus) ? (it.status as PlanStatus) : 'todo';
        // T01001：kind 仅接受里程碑/普通/日常三类，非法值兜底为 normal（不破坏其它批量创建调用）
        const kind = it.kind === 'milestone' || it.kind === 'daily' ? it.kind : 'normal';
        // T00561：各行日期独立——开始日用自己的（空则今天），end 按工作日计算
        const start = it.startDate && DATE_RE.test(it.startDate) ? it.startDate : fmt(new Date());
        const end = calcEndDate(start, duration, cal);
        const id = uuid();
        ids.push(id);
        // T02122：createBatch 复杂度钳位（此前直写 it.complexity ?? null，外部 Agent/Excel 可把 0/7/3.5 原样落库）
        ins.run(id, projectId, it.title.trim(), it.description ?? '', start, end, duration, status, it.assignee ?? '', maxOrder + 1 + i, kind, clampComplexity(it.complexity), t, t);
      });
    })();
    // T01688 项 1：依赖解析与落库（在建行之后：需要全部 id 与标题才能互引）
    if (items.some((it) => it.depsOn?.length)) {
      const titleToId = new Map<string, string>();
      clean.forEach((it, i) => titleToId.set(it.title.trim(), ids[i]));
      const rowOf = (id: string) => db.prepare('SELECT kind, title FROM plan_tasks WHERE id = ?').get(id) as { kind: string; title: string } | undefined;
      clean.forEach((it, i) => {
        const id = ids[i];
        if (!id || !it.depsOn?.length) return;
        const parsed: Array<{ id: string; type: string }> = [];
        for (const dep of it.depsOn) {
          const key = dep.trim();
          if (!key) continue;
          let target = titleToId.get(key);
          if (!target) {
            const row = db.prepare('SELECT id FROM plan_tasks WHERE project_id = ? AND title = ? AND archived = 0').get(projectId, key) as { id: string } | undefined;
            target = row?.id;
          }
          if (!target) { warnings.push(`条目「${it.title}」的依赖「${key}」未解析到（依赖待补）`); continue; }
          parsed.push({ id: target, type: rowOf(target)?.kind === 'milestone' ? 'child' : 'serial' });
        }
        if (parsed.length > 0) this.update(id, { deps: JSON.stringify(parsed) });
      });
    }
    notifyChange('plans');
    return { inserted: clean.length, ids, warnings };
  },
};
