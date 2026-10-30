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
  /** 最早一次入场日（迭代=挂载事件日；项目=窗口起点）——决定可回溯窗口起点 */
  fromDay: string;
  /**
   * 在册区间（PM-201⑤）：迭代口径按事件流回放成 [进, 出) 的若干段，移出/改绑只封段不删史；
   * 项目口径恒为整窗一段。采样日落在任一段内才计入剩余，否则等于「把当前状态倒灌回历史」。
   */
  spans: Array<{ from: string; to: string | null }>;
  /** 完成日；status!=='done' 时为 null */
  completedDay: string | null;
  /** 已完成但缺完成时刻（本功能上线前标的 done）：不计入剩余，只进 unknownCompleted 说明 */
  unknownCompleted: boolean;
}

/** 采样日是否落在该行的在册区间内 */
function isOnScope(i: SeriesItem, day: string): boolean {
  return i.spans.some((s) => s.from <= day && (s.to === null || day < s.to));
}

function remainingWorkdaysOn(day: string, items: SeriesItem[], cal: WorkdayCal): number {
  const next = addWorkdays(day, 1, cal);
  let sum = 0;
  for (const i of items) {
    if (isDoneBy(i, day)) continue;
    const from = i.start_date > next ? i.start_date : next; // NOSONAR - 按字典序取较晚者；操作数是 ISO 日期串，Math.max 会转成 NaN，该规则不适用
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
  return items.filter((i) => isOnScope(i, day) && !isDoneBy(i, day));
}

/* ---------------- 周报卡（PM-201⑥ 的「可发周报卡 + 补生成且仅一份」腿，T03227） ---------------- */

/** 卡的存储位：仍写 `iteration_events`（零新表延续），以 kind='weekly_card' 与成员变更事件同表分流 */
const CARD_KIND = 'weekly_card';

/** 卡片里的一条计划行快照：固化当时读到的字段，后续改名/改状态都不回溯改写这张卡 */
export interface WeeklyCardItem {
  id: string;
  title: string;
  start_date: string;
  end_date: string;
  status: string;
  progress: number;
  duration_days: number;
}

export interface WeeklyCardBody {
  cardId: string;
  iterationId: string;
  projectId: string;
  name: string;
  period: { start: string; end: string };
  goal: string;
  dod: string;
  generatedAt: string;
  /** 谁生成了这张卡：手点「发周报卡」/ 启动补生成。同迭代只有首份留痕，重放不再覆盖 */
  trigger: 'manual' | 'backfill';
  totals: { plans: number; done: number; undone: number; overdue: number };
  lists: { done: WeeklyCardItem[]; undone: WeeklyCardItem[]; overdue: WeeklyCardItem[] };
  notes: string[];
}

export interface WeeklyCard extends WeeklyCardBody {
  /** 可复制/可粘贴到周报正文的纯文本版面；不依赖前端渲染，验收也按这一列断言 */
  markdown: string;
}

/**
 * 卡片正文版面。刻意用纯文本拼接（不是模板字符串里塞中文再渲染），因为这张卡要能被
 * 复制出去当周报正文用：读屏播报、粘贴到 IM、验收断言都读这一份，前端再排一遍只会造出第二个口径。
 */
function renderCardMarkdown(b: WeeklyCardBody): string {
  const d = (v: string) => (v || '—');
  const row = (i: WeeklyCardItem): string => `  - ${i.title}（${d(i.start_date)}~${d(i.end_date)}，进度 ${i.progress}%，${i.status === 'done' ? '已完成' : '未完成'}）`;
  const col = (label: string, list: WeeklyCardItem[]): string =>
    list.length === 0 ? `${label}：无` : `${label}（${list.length}）：\n${list.map(row).join('\n')}`;
  return [
    `【迭代周报卡】${b.name}`,
    `范围：${d(b.period.start)} ~ ${d(b.period.end)}　生成：${b.generatedAt.slice(0, 19).replace('T', ' ')}（${b.trigger === 'backfill' ? '启动补生成' : '手动发布'}）`,
    b.goal ? `目标：${b.goal}` : '',
    b.dod ? `完成定义：${b.dod}` : '',
    `小结：在册 ${b.totals.plans} · 完成 ${b.totals.done} · 未完成 ${b.totals.undone} · 逾期 ${b.totals.overdue}`,
    col('已完成', b.lists.done),
    col('未完成', b.lists.undone),
    col('逾期', b.lists.overdue),
    ...b.notes.map((n) => `备注：${n}`),
  ].filter(Boolean).join('\n');
}

/** 读卡：无卡或 detail JSON 损坏都按 null（损坏走日志，不让一张坏卡把整个面板拖红） */
function readWeeklyCard(id: string): WeeklyCard | null {
  const row = getDb().prepare(
    'SELECT detail FROM iteration_events WHERE iteration_id = ? AND kind = ? ORDER BY created_at LIMIT 1',
  ).get(id, CARD_KIND) as { detail: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.detail) as WeeklyCard; } catch { return null; }
}

/** 结束日是否已跨过 `at` 所在业务日；与 summary 的逾期口径共用 isPastEndDate，避免两套判据 */
function isIterationPastEnd(it: IterationRow, at: Date): boolean {
  return isPastEndDate(it.end_date, at);
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
    const status = patch.status !== undefined && ITER_STATUSES.has(String(patch.status)) ? patch.status : cur.status;
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
    const wanted = [...new Set((planTaskIds ?? []).map(String).filter(Boolean))];
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
          if (other && !other.archived) {
            out.moved.push({ planTaskId: r.id, fromIteration: other.id, fromName: other.name });
            // 离开也要在**原迭代**留痕（PM-201⑤）：不记这一条，原迭代的燃尽就只能靠「当前还在册的行」倒推，
            // 该行被改绑走之后它在原迭代每一天的贡献会凭空消失——等于替原迭代改写了过去。
            logMembership(other.id, other.project_id, r.id, 'detach', `改绑至迭代「${it.name}」`);
          }
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
    const wanted = [...new Set((planTaskIds ?? []).map(String).filter(Boolean))];
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
        WHERE e.iteration_id = ? AND e.kind IN ('attach', 'detach') ORDER BY e.created_at DESC LIMIT ?`,
    ).all(id, limit) as Array<{ id: string; plan_task_id: string; title: string | null; kind: string; detail: string; created_at: string }>;
    return rows;
  },

  /**
   * 迭代结束小结（PM-201⑥ 的取数段）：完成 / 未完成 / 逾期三份清单。
   * 逾期口径复用 D-12 的 `isPastEndDate`（项目未配置时区→系统时区，边界日当天不算逾期）。
   * 「发周报卡」与「跨结束日补生成」复用本方法的返回（见下方 publishWeeklyCard），清单口径只有一处定义。
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

  /** 已发布的周报卡（PM-201⑥）：一迭代一份，无卡返回 null */
  weeklyCard(id: string): WeeklyCard | null {
    mustGetActiveIteration(id);
    return readWeeklyCard(id);
  },

  /**
   * 发周报卡（PM-201⑥）：把当下的结束小结固化成一张可复制的卡片，写入 `iteration_events`（kind='weekly_card'），零新表。
   * 「仅一份」由 schema 的偏唯一索引 uniq_iteration_weekly_card 在库层兜底，本方法先查后写只是把重复路径变成可读回执：
   *  已存在（含并发/重放撞索引）→ `{ created:false, card: 既有卡 }`，绝不生成第二张，也不改写首张的触发方与时间。
   * 归档迭代同样可发：卡片是小结的只读快照，不是成员变更，不受「归档只读」约束（那条约束只管 update/attach/detach）。
   */
  publishWeeklyCard(id: string, at: Date = new Date(), trigger: 'manual' | 'backfill' = 'manual'): { card: WeeklyCard; created: boolean } {
    const it = mustGetActiveIteration(id);
    const existing = readWeeklyCard(id);
    if (existing) return { card: existing, created: false };
    const s = IterationService.summary(id, at);
    const lite = (rows: unknown[]): WeeklyCardItem[] => rows.map((r) => {
      const x = r as { id: string; title: string; start_date: string; end_date: string; status: string; progress: number; duration_days: number };
      return { id: x.id, title: x.title, start_date: x.start_date, end_date: x.end_date, status: x.status, progress: x.progress, duration_days: x.duration_days };
    });
    const base: WeeklyCardBody = {
      cardId: uuid(), iterationId: it.id, projectId: it.project_id, name: it.name,
      period: { start: it.start_date, end: it.end_date }, goal: it.goal, dod: it.dod,
      generatedAt: nowIso(), trigger, totals: s.totals,
      lists: { done: lite(s.done), undone: lite(s.undone), overdue: lite(s.overdue) }, notes: s.notes,
    };
    const card: WeeklyCard = { ...base, markdown: renderCardMarkdown(base) };
    try {
      getDb().prepare(
        `INSERT INTO iteration_events (id, iteration_id, project_id, plan_task_id, kind, detail, created_at)
         VALUES (?, ?, ?, '', ?, ?, ?)`,
      ).run(card.cardId, it.id, it.project_id, CARD_KIND, JSON.stringify(card), card.generatedAt);
    } catch (e) {
      const raced = readWeeklyCard(id);
      if (raced) return { card: raced, created: false }; // 撞 uniq_iteration_weekly_card：回读首份，不抛给调用方
      throw e;
    }
    notifyChange('plans');
    return { card, created: true };
  },

  /**
   * 启动补生成（PM-201⑥ 后半句「应用关闭期间跨过结束日时在下次启动补生成且仅一份」）。
   * 口径单源：判据就是「结束日已跨过 + 尚无 weekly_card 事件」，所以重复调用/多轮定时都只会扫到空集——
   * 已生成的迭代不再进候选，候选内每条由 publishWeeklyCard 的库层唯一索引保证一份。
   * 归档迭代不进补生成：归档=从有效分母排除（PM-201①），补一张卡等于把已退出统计的对象重新拉回视野。
   */
  backfillWeeklyCards(at: Date = new Date()): { generated: Array<{ iterationId: string; name: string }>; scanned: number } {
    const rows = getDb().prepare(
      `SELECT i.* FROM project_iterations i
        WHERE i.archived = 0
          AND NOT EXISTS (SELECT 1 FROM iteration_events e WHERE e.iteration_id = i.id AND e.kind = ?)
        ORDER BY i.end_date`,
    ).all(CARD_KIND) as IterationRow[];
    const generated: Array<{ iterationId: string; name: string }> = [];
    for (const it of rows) {
      if (!isIterationPastEnd(it, at)) continue;
      const out = IterationService.publishWeeklyCard(it.id, at, 'backfill');
      if (out.created) generated.push({ iterationId: it.id, name: it.name });
    }
    return { generated, scanned: rows.length };
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
  const sampledTo = scope.endDate > today ? today : scope.endDate; // NOSONAR - 按字典序取较早者；操作数是 ISO 日期串，Math.min 会转成 NaN，该规则不适用
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

/**
 * 迭代口径的入场项：在册区间由 `iteration_events` 回放而成（PM-201⑤「不重写历史」的取数面）。
 * 不能只按 `iteration_id = 本迭代` 取行——那样一条计划行被移出或改绑之后，
 * 它在本迭代**历史每一天**的贡献会一起消失，图上等于替本迭代改写了过去。
 * 当前在册但没有挂载事件的行（本功能上线前挂上的）按区间起点补齐并说明。
 */
function iterationItems(iterationId: string, startDate: string, db: ReturnType<typeof getDb>): SeriesItem[] {
  const rows = db.prepare(
    `SELECT p.id, p.title, p.start_date, p.end_date, p.status, p.completed_at, p.iteration_id
       FROM plan_tasks p
      WHERE p.archived = 0
        AND (p.iteration_id = ? OR EXISTS (
              SELECT 1 FROM iteration_events e
               WHERE e.iteration_id = ? AND e.plan_task_id = p.id AND e.kind IN ('attach', 'detach')))
      ORDER BY p.sort_order`,
  ).all(iterationId, iterationId) as Array<{
    id: string; title: string; start_date: string; end_date: string; status: string; completed_at: string | null; iteration_id: string | null;
  }>;
  const evs = db.prepare(
    `SELECT plan_task_id, kind, created_at FROM iteration_events
      WHERE iteration_id = ? AND kind IN ('attach', 'detach') ORDER BY plan_task_id, created_at`,
  ).all(iterationId) as Array<{ plan_task_id: string; kind: string; created_at: string }>;
  const byPlan = new Map<string, Array<{ kind: string; day: string }>>();
  for (const e of evs) {
    const day = dayOf(e.created_at);
    if (!day) continue;
    const list = byPlan.get(e.plan_task_id) ?? [];
    list.push({ kind: e.kind, day });
    byPlan.set(e.plan_task_id, list);
  }
  return rows.map((r) => {
    const timeline = byPlan.get(r.id) ?? [];
    const spans: Array<{ from: string; to: string | null }> = [];
    let open: { from: string } | null = null;
    for (const t of timeline) {
      if (t.kind === 'attach') {
        open ??= { from: t.day };
      } else if (open) {
        spans.push({ from: open.from, to: t.day });
        open = null;
      }
    }
    // 仍在本迭代里的行必须留一段开区间：事件缺失（本功能上线前挂的）或只有 detach 的异常库态都补一段，
    // 补的起点取「已有事件的最晚一天」，否则当前看板有成员而燃尽只剩历史段，两处口径会打架。
    const stillMember = r.iteration_id === iterationId;
    if (open) spans.push({ from: open.from, to: null });
    if (stillMember && !spans.some((s) => s.to === null)) spans.push({ from: timeline.at(-1)?.day ?? startDate, to: null });
    // 只剩「移出」而没有「加入」的记录（异常库态）：不给它编造一段贡献，画成零宽度即不入任何采样日
    if (!spans.length) spans.push({ from: startDate, to: startDate });
    spans.sort((a, b) => (a.from < b.from ? -1 : 1));
    return toSeriesItem(r, spans[0].from, spans);
  });
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
  spans?: Array<{ from: string; to: string | null }>,
): SeriesItem {
  const completedDay = r.status === 'done' ? dayOf(r.completed_at) : null;
  return {
    id: r.id,
    title: r.title,
    start_date: r.start_date,
    end_date: r.end_date,
    status: r.status,
    fromDay,
    spans: spans ?? [{ from: fromDay, to: null }],
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
  const dataFrom = items.length ? items.map((i) => i.fromDay).sort((a, b) => a.localeCompare(b))[0] : null;
  // 回溯窗口起点之前的采样日没有实况（那几天范围里还没有成员），画出来是「0 → 上升」的假下降线：
  // 按 D-12 缺失不插值，整段移入 missingDays，实际线从 dataFrom 起画；理想线仍按全区间比例定位。
  const burnable = sampled.filter((d) => !dataFrom || d >= dataFrom);
  const preWindow = sampled.filter((d) => dataFrom && d < dataFrom);
  const points: BurndownPoint[] = burnable.map((day) => {
    const remaining = remainingItemsOn(day, items);
    const idx = fullSeries.indexOf(day);
    const ratio = (fullSeries.length - 1 - Math.max(0, idx)) / span;
    return {
      day,
      remainingCount: remaining.length,
      // 剩余工期只累计「当日确实剩余」的那些行：把 items 整片喂进去会把尚未入场的排期提前算进历史，
      // 于是剩余数在降、剩余工期却不降——两条线讲的是同一天的事，取数集合必须是同一个。
      remainingWorkdays: remainingWorkdaysOn(day, remaining, cal),
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
