/**
 * 迭代服务（T03186 / PRD PM-201）。
 *
 * 口径基线（整合版 D-02）：迭代是**项目下带起止日期、目标（goal）与完成定义（dod）的计划行集合**；
 * 任务通过既有的「计划→待办」关系间接参与，本服务不建任何任务级排期模型。
 *
 * PM-201⑦ 技术裁决：**零新表路径不可行**，故新增 `project_iterations` + `plan_tasks.iteration_id`。
 * 对照竞品版 PRD 提出的「迭代=计划区间视图 + deps:child 承载成员集合」方案，实测表达力不足：
 *  - `plan_tasks.deps` 的 child 边已被里程碑聚合占用（T02090 `milestoneChild`/`milestoneProgress`），
 *    同一语义位无法同时表达「属于某里程碑」与「属于某迭代」，借用即破坏既有排期收包；
 *  - 迭代自身要承载 goal/dod/status/归档位，区间视图只能塞进计划行 JSON，
 *    「归档只读」「禁止跨项目归属」「同一时间单归属」三条约束就没有单点写入路径可校验；
 *  - 区间视图无法留痕「中途加入/移出」（PM-201⑤），燃尽实际线只能拿当前状态猜历史。
 * 行为口径不因实现路径改变（PM-201⑦ 原文要求）：三条约束全部在服务层写入路径强制，见 attach / update / archive。
 */
import { getDb } from '../db/connection';
import { v4 as uuid } from 'uuid';
import { notifyChange } from './ChangeBus';
import {
  addWorkdays, buildCalendar, countWorkdaysBetween, fmtDate, isWorkday, isPastEndDate, ymdInTimezone,
} from '../util/workdays';
import type { WorkdayCal } from '../util/workdays';

/** 迭代状态（详细设计 §3.3）：todo 未开始 / doing 进行中 / done 已结束 */
export type IterationStatus = 'todo' | 'doing' | 'done';
const ITER_STATUSES = new Set<string>(['todo', 'doing', 'done']);

export interface IterationRow {
  id: string;
  project_id: string;
  name: string;
  goal: string;
  dod: string;
  start_date: string;
  end_date: string;
  status: IterationStatus;
  archived: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  /** 查询附带：未归档成员计划行数（PM-201①「归档迭代从有效分母排除」的分母口径） */
  memberCount?: number;
  /** 查询附带：成员中已完成的计划行数 */
  doneCount?: number;
}

/** 挂载结果：四个出口都必须可解释，不做静默丢弃（详细设计 §3.3） */
export interface AttachResult {
  attached: string[];
  /** 原属其它未归档迭代、本次改绑过来的行（PM-201③ 单归属的可见化） */
  moved: Array<{ planTaskId: string; fromIteration: string; fromName: string }>;
  /** 未挂载及原因 */
  skipped: Array<{ planTaskId: string; reason: string }>;
  /** 已挂载但排期落在迭代时间窗外（不丢弃，只说明） */
  outsideWindow: Array<{ planTaskId: string; reason: string }>;
}

export interface BurndownPoint {
  day: string;
  /** 剩余计划行数；当日无任何成员时仍为 0（真实值），只有窗口外才 null */
  remainingCount: number;
  remainingWorkdays: number;
  idealCount: number;
  idealWorkdays: number;
}

export interface BurndownResult {
  scope: { kind: 'iteration' | 'project'; id: string; name: string; startDate: string; endDate: string };
  points: BurndownPoint[];
  /** 实际可回溯窗口起点（首个有成员入场的业务日）——早于此的采样日属于「尚无范围」 */
  dataFrom: string | null;
  /** 无数据业务日（采样区间内落在范围外的日历日 / 尚未开跑的迭代） */
  missingDays: string[];
  tz: string;
  notes: string[];
  totals: { plans: number; done: number; undone: number; overdue: number; unknownCompleted: number };
}

function nowIso(): string {
  return new Date().toISOString();
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** 迭代起止日校验：格式合法 + 起 ≤ 止（起止日按 D-12 的「业务日」语义，只到日历日） */
function assertRange(start: string, end: string): void {
  if (!YMD.test(start) || !YMD.test(end)) throw new Error('起止日期应为 YYYY-MM-DD');
  if (end < start) throw new Error(`结束日（${end}）不能早于开始日（${start}）`);
}

/** ISO 时刻 → 该时刻在业务时区里的日历日（D-12：项目未配置时区则跟随系统时区） */
function dayOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return ymdInTimezone(d);
}

function loadCalendar(): WorkdayCal {
  const rows = getDb().prepare('SELECT date, kind FROM holidays').all() as Array<{ date: string; kind: string | null }>;
  return buildCalendar(rows);
}

/** [from, to] 区间内的业务日序列（含两端；仅工作日采样——剩余工期本身是工作日口径） */
function workdaySeries(from: string, to: string, cal: WorkdayCal): string[] {
  if (to < from) return [];
  const out: string[] = [];
  const d = new Date(`${from}T12:00:00`);
  const end = new Date(`${to}T12:00:00`);
  // 上限防脏数据（end_date 允许用户填到 2099）：区间超过 400 个采样日即截断并在 notes 说明
  for (let guard = 0; d <= end && guard < 400; d.setDate(d.getDate() + 1), guard++) {
    if (isWorkday(d, cal)) out.push(fmtDate(d));
  }
  return out;
}

/** 迭代行的公共取数：不存在/已归档语义由调用方决定 */
function fetchIteration(id: string): IterationRow | null {
  return (getDb().prepare('SELECT * FROM project_iterations WHERE id = ?').get(id) as IterationRow | undefined) ?? null;
}

function mustGetActiveIteration(id: string): IterationRow {
  const it = fetchIteration(id);
  if (!it) throw new Error('迭代不存在');
  return it;
}

/** 写入成员变更事件（PM-201⑤）：加入/移出逐条留痕，燃尽重建据此回溯，绝不回写既有事件 */
function logMembership(iterationId: string, projectId: string, planTaskId: string, kind: 'attach' | 'detach', detail: string): void {
  getDb().prepare(
    'INSERT INTO iteration_events (id, iteration_id, project_id, plan_task_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(uuid(), iterationId, projectId, planTaskId, kind, detail, nowIso());
}

/**
 * 计划行的完成时刻维护：迁入 done 记时间，迁出 done 清空（避免把「重新打开」误留成已完成）。
 * 调用点在 `PlanService` 主 UPDATE **之后**，此时行的 status 已是新值，因此清空条件只能看 `completed_at`
 * 本身，不能再拿 `status = 'done'` 当守卫（那样永远不成立，重新打开会残留完成时刻）。
 */
export function touchCompletedAt(db: ReturnType<typeof getDb>, planTaskId: string, status: string): void {
  if (status === 'done') db.prepare("UPDATE plan_tasks SET completed_at = COALESCE(completed_at, ?) WHERE id = ?").run(nowIso(), planTaskId);
  else db.prepare("UPDATE plan_tasks SET completed_at = NULL WHERE id = ? AND completed_at IS NOT NULL").run(planTaskId);
}

/** 单个成员在采样区间内的可回溯状态（燃尽重建的最小单元） */
interface SeriesItem {
  id: string;
  title: string;
  start_date: string;
  end_date: string;
  status: string;
  /** 入场日（迭代=挂载日；项目=窗口起点/创建日取晚者） */
  fromDay: string;
  /** 完成日；status!=='done' 时为 null */
  completedDay: string | null;
  /** 已完成但缺完成时刻（本功能上线前标的 done）：不计入剩余，只进 unknownCompleted 说明 */
  unknownCompleted: boolean;
}

function remainingWorkdaysOn(day: string, items: SeriesItem[], cal: WorkdayCal): number {
  const next = addWorkdays(day, 1, cal);
  let sum = 0;
  for (const i of items) {
    if (isDoneBy(i, day)) continue;
    const from = i.start_date > next ? i.start_date : next;
    sum += countWorkdaysBetween(from, i.end_date, cal);
  }
  return sum;
}

/** 采样日 d 该计划行是否已算完成（完成时刻未知的历史 done 行一律视为「进入范围时即已完成」，不伪造下降点） */
function isDoneBy(i: SeriesItem, day: string): boolean {
  if (i.status !== 'done') return false;
  return i.completedDay === null || i.completedDay <= day;
}

function remainingItemsOn(day: string, items: SeriesItem[]): SeriesItem[] {
  return items.filter((i) => i.fromDay <= day && !isDoneBy(i, day));
}

export const IterationService = {
  /** 项目下的迭代列表（默认只给未归档；includeArchived 一并返回并在 archived 位标注） */
  list(projectId: string, opts: { includeArchived?: boolean } = {}): IterationRow[] {
    const db = getDb();
    const where = ['project_id = ?'];
    if (!opts.includeArchived) where.push('archived = 0');
    const rows = db
      .prepare(`SELECT * FROM project_iterations WHERE ${where.join(' AND ')} ORDER BY start_date, created_at`)
      .all(projectId) as IterationRow[];
    const stats = db.prepare(
      `SELECT iteration_id, COUNT(*) AS c, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS d
         FROM plan_tasks WHERE project_id = ? AND archived = 0 AND iteration_id IS NOT NULL GROUP BY iteration_id`,
    ).all(projectId) as Array<{ iteration_id: string; c: number; d: number }>;
    const byId = new Map(stats.map((s) => [s.iteration_id, s]));
    return rows.map((r) => ({ ...r, memberCount: byId.get(r.id)?.c ?? 0, doneCount: byId.get(r.id)?.d ?? 0 }));
  },

  /** 迭代详情：含成员计划行（未归档），供迭代看板 */
  get(id: string): (IterationRow & { planTasks: unknown[] }) | null {
    const it = fetchIteration(id);
    if (!it) return null;
    const planTasks = getDb().prepare(
      'SELECT id, title, start_date, end_date, duration_days, progress, status, kind, iteration_id FROM plan_tasks WHERE iteration_id = ? AND archived = 0 ORDER BY sort_order',
    ).all(id);
    return { ...it, planTasks };
  },

  create(
    projectId: string,
    input: { name: string; goal?: string; dod?: string; startDate: string; endDate: string; status?: IterationStatus },
  ): IterationRow {
    const db = getDb();
    const name = String(input.name ?? '').trim();
    if (!name) throw new Error('迭代名称必填');
    assertRange(String(input.startDate ?? ''), String(input.endDate ?? ''));
    if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new Error('项目不存在');
    const status = ITER_STATUSES.has(String(input.status)) ? (input.status as IterationStatus) : 'todo';
    const id = uuid();
    const t = nowIso();
    db.prepare(
      `INSERT INTO project_iterations (id, project_id, name, goal, dod, start_date, end_date, status, archived, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
    ).run(id, projectId, name, input.goal ?? '', input.dod ?? '', input.startDate, input.endDate, status, t, t);
    notifyChange('plans');
    return fetchIteration(id)!;
  },

  /** 编辑（PM-201①：归档只读——归档后任何写入路径都被这里挡住） */
  update(id: string, patch: { name?: string; goal?: string; dod?: string; startDate?: string; endDate?: string; status?: IterationStatus }): IterationRow | null {
    const db = getDb();
    const cur = mustGetActiveIteration(id);
    if (cur.archived) throw new Error('迭代已归档，只读不可编辑');
    const name = patch.name === undefined ? cur.name : String(patch.name).trim();
    if (!name) throw new Error('迭代名称必填');
    const start = patch.startDate ?? cur.start_date;
    const end = patch.endDate ?? cur.end_date;
    assertRange(start, end);
    const status = patch.status !== undefined && ITER_STATUSES.has(String(patch.status)) ? (patch.status as IterationStatus) : cur.status;
    db.prepare(
      'UPDATE project_iterations SET name = ?, goal = ?, dod = ?, start_date = ?, end_date = ?, status = ?, updated_at = ? WHERE id = ?',
    ).run(name, patch.goal ?? cur.goal, patch.dod ?? cur.dod, start, end, status, nowIso(), id);
    notifyChange('plans');
    return fetchIteration(id);
  },

  /** 归档（PM-201①）：只读化 + 从有效分母排除；成员归属保留，便于回溯「这个迭代当初装了哪些计划」 */
  archive(id: string): boolean {
    const db = getDb();
    const cur = mustGetActiveIteration(id);
    if (cur.archived) return false;
    db.prepare('UPDATE project_iterations SET archived = 1, archived_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), id);
    notifyChange('plans');
    return true;
  },

  unarchive(id: string): boolean {
    const db = getDb();
    const cur = mustGetActiveIteration(id);
    if (!cur.archived) return false;
    db.prepare('UPDATE project_iterations SET archived = 0, archived_at = NULL, updated_at = ? WHERE id = ?').run(nowIso(), id);
    notifyChange('plans');
    return true;
  },

  /** 删除=仅解绑（详细设计 §3.3）：计划行一律保留，事件流保留（历史可回溯） */
  remove(id: string): { detached: number } {
    const db = getDb();
    const cur = mustGetActiveIteration(id);
    const detached = db.prepare('UPDATE plan_tasks SET iteration_id = NULL, updated_at = ? WHERE iteration_id = ?').run(nowIso(), cur.id).changes;
    db.prepare('DELETE FROM project_iterations WHERE id = ?').run(id);
    notifyChange('plans');
    return { detached };
  },

  /**
   * 挂载计划行（PM-201②③⑤）。
   *  - 跨项目归属：一律拒绝（禁止跨项目）；
   *  - 原属其它**未归档**迭代：改绑并回 `moved`（单归属由 plan_tasks.iteration_id 单列保证）；
   *  - 原属**已归档**迭代：直接接管，不算 moved（归档迭代已退出有效分母）；
   *  - 排期在迭代时间窗外：挂载成功，但回 `outsideWindow` 说明原因（不静默丢弃）。
   */
  attach(id: string, planTaskIds: string[], mode: 'add' | 'replace' = 'add'): AttachResult {
    const db = getDb();
    const it = mustGetActiveIteration(id);
    if (it.archived) throw new Error('迭代已归档，只读不可变更成员');
    const out: AttachResult = { attached: [], moved: [], skipped: [], outsideWindow: [] };
    const wanted = [...new Set((planTaskIds ?? []).map((s) => String(s)).filter(Boolean))];
    const rows = wanted.length
      ? (db.prepare(`SELECT id, project_id, title, start_date, end_date, archived, iteration_id FROM plan_tasks WHERE id IN (${wanted.map(() => '?').join(',')})`).all(...wanted) as Array<{
          id: string; project_id: string; title: string; start_date: string; end_date: string; archived: number; iteration_id: string | null;
        }>)
      : [];
    const found = new Map(rows.map((r) => [r.id, r]));
    for (const wantId of wanted) {
      if (!found.has(wantId)) out.skipped.push({ planTaskId: wantId, reason: '计划行不存在（可能已被彻底删除）' });
    }
    db.transaction(() => {
      if (mode === 'replace') {
        // 替换语义：本次清单之外的现成员先移出（逐条留痕）
        const current = db.prepare('SELECT id FROM plan_tasks WHERE iteration_id = ? AND archived = 0').all(id) as Array<{ id: string }>;
        for (const c of current) {
          if (found.has(c.id)) continue;
          db.prepare('UPDATE plan_tasks SET iteration_id = NULL, updated_at = ? WHERE id = ?').run(nowIso(), c.id);
          logMembership(it.id, it.project_id, c.id, 'detach', 'replace 模式移出');
        }
      }
      for (const r of rows) {
        if (r.project_id !== it.project_id) { out.skipped.push({ planTaskId: r.id, reason: '禁止跨项目归属：该行属于其它项目' }); continue; }
        if (r.archived) { out.skipped.push({ planTaskId: r.id, reason: '计划行已归档，不参与迭代统计' }); continue; }
        if (r.iteration_id === it.id) continue; // 幂等：已在册不重复留痕
        if (r.iteration_id) {
          const other = fetchIteration(r.iteration_id);
          if (other && !other.archived) out.moved.push({ planTaskId: r.id, fromIteration: other.id, fromName: other.name });
        }
        db.prepare('UPDATE plan_tasks SET iteration_id = ?, updated_at = ? WHERE id = ?').run(it.id, nowIso(), r.id);
        logMembership(it.id, it.project_id, r.id, 'attach', out.moved.some((m) => m.planTaskId === r.id) ? '改绑加入' : '加入迭代');
        out.attached.push(r.id);
        if (r.end_date < it.start_date || r.start_date > it.end_date) {
          out.outsideWindow.push({ planTaskId: r.id, reason: `排期 ${r.start_date}~${r.end_date} 超出迭代区间 ${it.start_date}~${it.end_date}` });
        }
      }
    })();
    notifyChange('plans');
    return out;
  },

  /** 移出（PM-201②⑤）：只动在册成员，其余按原因回说明 */
  detach(id: string, planTaskIds: string[]): { detached: string[]; skipped: Array<{ planTaskId: string; reason: string }> } {
    const db = getDb();
    const it = mustGetActiveIteration(id);
    if (it.archived) throw new Error('迭代已归档，只读不可变更成员');
    const detached: string[] = [];
    const skipped: Array<{ planTaskId: string; reason: string }> = [];
    const wanted = [...new Set((planTaskIds ?? []).map((s) => String(s)).filter(Boolean))];
    db.transaction(() => {
      for (const planId of wanted) {
        const row = db.prepare('SELECT id, iteration_id FROM plan_tasks WHERE id = ?').get(planId) as { id: string; iteration_id: string | null } | undefined;
        if (!row) { skipped.push({ planTaskId: planId, reason: '计划行不存在（可能已被彻底删除）' }); continue; }
        if (row.iteration_id !== it.id) { skipped.push({ planTaskId: planId, reason: '该行不属于本迭代，未做任何改动' }); continue; }
        db.prepare('UPDATE plan_tasks SET iteration_id = NULL, updated_at = ? WHERE id = ?').run(nowIso(), planId);
        logMembership(it.id, it.project_id, planId, 'detach', '移出迭代');
        detached.push(planId);
      }
    })();
    notifyChange('plans');
    return { detached, skipped };
  },

  /** 成员变更事件（PM-201⑤ 的可核对面：UI 与验收门都按这张表断言「历史未被重写」） */
  events(id: string, limit = 200): Array<{ id: string; plan_task_id: string; title: string | null; kind: string; detail: string; created_at: string }> {
    const rows = getDb().prepare(
      `SELECT e.id, e.plan_task_id, e.kind, e.detail, e.created_at, p.title
         FROM iteration_events e LEFT JOIN plan_tasks p ON p.id = e.plan_task_id
        WHERE e.iteration_id = ? ORDER BY e.created_at DESC LIMIT ?`,
    ).all(id, limit) as Array<{ id: string; plan_task_id: string; title: string | null; kind: string; detail: string; created_at: string }>;
    return rows;
  },

  /**
   * 迭代结束小结（PM-201⑥ 的取数段）：完成 / 未完成 / 逾期三份清单。
   * 逾期口径复用 D-12 的 `isPastEndDate`（项目未配置时区→系统时区，边界日当天不算逾期）。
   * 「一键发周报卡」与「跨结束日补生成」属周报卡链路，另单落地，本服务只保证清单可稳定复现。
   */
  summary(id: string, at: Date = new Date()): {
    iteration: IterationRow;
    totals: { plans: number; done: number; undone: number; overdue: number };
    done: unknown[];
    undone: unknown[];
    overdue: unknown[];
    notes: string[];
  } {
    const it = mustGetActiveIteration(id);
    const db = getDb();
    const rows = db.prepare(
      'SELECT id, title, start_date, end_date, duration_days, progress, status FROM plan_tasks WHERE iteration_id = ? AND archived = 0 ORDER BY sort_order',
    ).all(id) as Array<{ id: string; title: string; start_date: string; end_date: string; duration_days: number; progress: number; status: string }>;
    const done = rows.filter((r) => r.status === 'done');
    const undone = rows.filter((r) => r.status !== 'done');
    const overdue = undone.filter((r) => isPastEndDate(r.end_date, at));
    const notes: string[] = [];
    if (rows.length === 0) notes.push('本迭代暂无在册计划行');
    if (it.archived) notes.push('迭代已归档：小结为只读快照，统计分母不再随成员变更移动');
    return { iteration: it, totals: { plans: rows.length, done: done.length, undone: undone.length, overdue: overdue.length }, done, undone, overdue, notes };
  },

  /** 迭代燃尽（PM-201④ 双口径）：按业务日回溯剩余计划数与剩余工期 */
  burndown(id: string): BurndownResult {
    const it = mustGetActiveIteration(id);
    return buildBurndown({ kind: 'iteration', id: it.id, name: it.name, startDate: it.start_date, endDate: it.end_date }, it.project_id, it);
  },

  /**
   * 项目燃尽（无迭代归属时的整体进度口径）：范围=项目下未归档计划行，窗口由 from/to 指定（缺省取计划包络）。
   * 与迭代燃尽共用同一采样器，保证两套图不会出现第二个数字（概要设计 §2「口径单源」）。
   */
  projectBurndown(projectId: string, from?: string, to?: string): BurndownResult {
    const db = getDb();
    if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new Error('项目不存在');
    const span = db.prepare(
      "SELECT MIN(start_date) AS a, MAX(end_date) AS b FROM plan_tasks WHERE project_id = ? AND archived = 0 AND COALESCE(history_at, '') = ''",
    ).get(projectId) as { a: string | null; b: string | null };
    const startDate = (YMD.test(String(from ?? '')) ? String(from) : span.a) ?? fmtDate(new Date());
    const endDate = (YMD.test(String(to ?? '')) ? String(to) : span.b) ?? startDate;
    assertRange(startDate, endDate);
    const name = (db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string } | undefined)?.name ?? projectId;
    return buildBurndown({ kind: 'project', id: projectId, name, startDate, endDate }, projectId, null);
  },
};

/**
 * 采样器（迭代/项目两口径共用）。
 *
 * 为什么用事件流重建而不是「每天存一张快照」：PM-201⑤ 要求加入/移出留痕且不重写历史，
 * 事件流本身就是历史；快照表是 PM-205 的长唯一来源（>90 天事件不可用），由洞察单独立项，
 * 本期不提前造第二份数字。窗口起点前无任何成员的采样日记入 `missingDays`，不插值（D-12 / 评审 I1）。
 */
function buildBurndown(
  scope: { kind: 'iteration' | 'project'; id: string; name: string; startDate: string; endDate: string },
  projectId: string,
  iteration: IterationRow | null,
): BurndownResult {
  const db = getDb();
  const cal = loadCalendar();
  const today = ymdInTimezone(new Date());
  const notes: string[] = [];
  const items = scope.kind === 'iteration' ? iterationItems(scope.id, scope.startDate, db) : projectItems(projectId, scope.startDate, db);

  // 采样到「今天」为止：未来日没有实况，画出去就是伪造
  const sampledTo = scope.endDate > today ? today : scope.endDate;
  const fullSeries = workdaySeries(scope.startDate, scope.endDate, cal);
  const sampled = workdaySeries(scope.startDate, sampledTo, cal);
  if (scope.startDate > today) {
    notes.push(`迭代/范围尚未开始（起点 ${scope.startDate}），无实况数据可回溯`);
    return finish({ scope, items, fullSeries, sampled, cal, missingDays: fullSeries, notes, today, iteration });
  }
  const futureDays = fullSeries.filter((d) => d > sampledTo);
  notes.push(`实际线采样至 ${sampledTo}（区间终点与今天取早者）；${futureDays.length} 个未来业务日不预判`);
  return finish({
    scope, items, fullSeries, sampled, cal, missingDays: futureDays, notes, today, iteration,
  });
}

/** 迭代口径的入场项：入场日=首次挂载事件日；当前在册但没有挂载事件的行按区间起点补齐并说明 */
function iterationItems(iterationId: string, startDate: string, db: ReturnType<typeof getDb>): SeriesItem[] {
  const rows = db.prepare(
    `SELECT p.id, p.title, p.start_date, p.end_date, p.status, p.completed_at,
            (SELECT MIN(e.created_at) FROM iteration_events e WHERE e.iteration_id = p.iteration_id AND e.plan_task_id = p.id AND e.kind = 'attach') AS attached_at
       FROM plan_tasks p
      WHERE p.iteration_id = ? AND p.archived = 0
      ORDER BY p.sort_order`,
  ).all(iterationId) as Array<{ id: string; title: string; start_date: string; end_date: string; status: string; completed_at: string | null; attached_at: string | null }>;
  return rows.map((r) => toSeriesItem(r, r.attached_at ? dayOf(r.attached_at) ?? startDate : startDate));
}

/**
 * 项目口径的入场项：项目范围没有「成员变更」概念，行是否在范围内由**排期**决定（创建日只是记账时刻，
 * 拿它当入场日会把「今天补录的历史排期」整段判成无数据，图上一片空白）。
 * 真正不可知的只有完成时刻——由 `completed_at` 重建，缺失者按 unknownCompleted 说明，不伪造下降点。
 */
function projectItems(projectId: string, startDate: string, db: ReturnType<typeof getDb>): SeriesItem[] {
  const rows = db.prepare(
    `SELECT id, title, start_date, end_date, status, completed_at
       FROM plan_tasks WHERE project_id = ? AND archived = 0 AND COALESCE(history_at, '') = '' ORDER BY sort_order`,
  ).all(projectId) as Array<{ id: string; title: string; start_date: string; end_date: string; status: string; completed_at: string | null}>;
  return rows.map((r) => toSeriesItem(r, startDate));
}

function toSeriesItem(
  r: { id: string; title: string; start_date: string; end_date: string; status: string; completed_at: string | null },
  fromDay: string,
): SeriesItem {
  const completedDay = r.status === 'done' ? dayOf(r.completed_at) : null;
  return {
    id: r.id,
    title: r.title,
    start_date: r.start_date,
    end_date: r.end_date,
    status: r.status,
    fromDay,
    completedDay,
    // 上线前就标完的历史 done 行：完成时刻不可知，视为「入场时即已完成」，只计数不伪造下降点
    unknownCompleted: r.status === 'done' && !r.completed_at,
  };
}

/** 把采样项收敛成燃尽点列 + 理想线 + 汇总（迭代/项目共用，保证数字单源） */
function finish(args: {
  scope: BurndownResult['scope'];
  items: SeriesItem[];
  fullSeries: string[];
  sampled: string[];
  cal: WorkdayCal;
  missingDays: string[];
  notes: string[];
  today: string;
  iteration: IterationRow | null;
}): BurndownResult {
  const { scope, items, fullSeries, sampled, cal, notes } = args;
  const idealTotal = items.length;
  const idealWorkdayTotal = remainingWorkdaysOn(fullSeries[0] ?? scope.startDate, items.map((i) => ({ ...i, status: 'todo', completedDay: null })), cal);
  const span = Math.max(1, fullSeries.length - 1);
  const dataFrom = items.length ? items.map((i) => i.fromDay).sort()[0] : null;
  // 回溯窗口起点之前的采样日没有实况（那几天范围里还没有成员），画出来是「0 → 上升」的假下降线：
  // 按 D-12 缺失不插值，整段移入 missingDays，实际线从 dataFrom 起画；理想线仍按全区间比例定位。
  const burnable = sampled.filter((d) => !dataFrom || d >= dataFrom);
  const preWindow = sampled.filter((d) => dataFrom && d < dataFrom);
  const points: BurndownPoint[] = burnable.map((day) => {
    const remaining = remainingItemsOn(day, items);
    const idx = fullSeries.indexOf(day);
    const ratio = (fullSeries.length - 1 - (idx < 0 ? 0 : idx)) / span;
    return {
      day,
      remainingCount: remaining.length,
      remainingWorkdays: remainingWorkdaysOn(day, items, cal),
      idealCount: round1(idealTotal * ratio),
      idealWorkdays: round1(idealWorkdayTotal * ratio),
    };
  });
  const unknownCompleted = items.filter((i) => i.unknownCompleted).length;
  if (unknownCompleted > 0) notes.push(`${unknownCompleted} 条计划在本功能上线前已标完成、完成时刻不可知，按「入场即完成」处理，不计入实际剩余线`);
  if (dataFrom && dataFrom > scope.startDate) notes.push(`可回溯窗口自 ${dataFrom} 起（此前 ${preWindow.length} 个业务日尚无范围成员，不插值）`);
  if (dataFrom && burnable.length === 0) notes.push(`可回溯窗口起点（${dataFrom}）晚于区间终点，区间内无实况可画`);
  if (!args.iteration) notes.push('项目口径：范围=项目下未归档计划行（按排期判定在册），不可知的只有完成时刻——缺失者按「入场即完成」说明，不伪造下降点');
  // 逾期口径复用 D-12 单源函数（边界日当天不算逾期），不在这里再造第二套比较
  const at = new Date(`${args.today}T12:00:00`);
  return {
    scope,
    points,
    dataFrom,
    missingDays: [...preWindow, ...args.missingDays],
    tz: resolvedTz(),
    notes,
    totals: {
      plans: items.length,
      done: items.filter((i) => i.status === 'done').length,
      undone: items.filter((i) => i.status !== 'done').length,
      overdue: items.filter((i) => i.status !== 'done' && isPastEndDate(i.end_date, at)).length,
      unknownCompleted,
    },
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function resolvedTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'system';
  } catch {
    return 'system';
  }
}
