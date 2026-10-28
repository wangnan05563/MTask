/**
 * T03194（PRD PM-204 里程碑达成预测 / D-03）：里程碑**专属**预测模型 + 出数。
 *
 * 与 AI-204（计划行时间进度：时间已过比例 vs 完成进度）不是同一对象，故不套同一公式（D-03）：
 * 里程碑的「完成率」来自子项（`deps` 中 `type='child'` 边，口径 A 唯一父子标记，与
 * `milestoneProgress.recalcMilestoneProgress` 同一分母），「剩余工作量」来自子项剩余工作日。
 *
 * 模型（可解释、可复算，`model='milestone-children-v1'`）：
 * 1. 完成率 = 已完成子项数 ÷ 未归档子项数（与进度聚合同口径，避免面板两块数字打架）；
 * 2. 单子项总工作日：`duration_days` 优先；缺工期时用 `start_date~end_date` 区间工作日；
 *    两者都缺 → **缺失**（D-05/§487 缺失值不得静默按 0，整体不给预测日期）；
 * 3. 单子项剩余 = ceil(总工作日 × (1 − progress%))，已完成子项不参与；
 * 4. 剩余工作日串行排期：从业务日（D-12 时区）起**含当天**连续排，落点即预测完成日；
 * 5. 与计划结束日（里程碑包络 `end_date`）比较给出提前/延后工作日数；无结束日只给预测日期、不判偏差。
 * 同一业务日、同一数据 + 同一日历（holidays 表）→ 同输出（纯计算，无随机、无历史回溯）。
 *
 * 「预测值，非承诺」恒随出数返回（`disclaimer`），消费侧不得省略。
 */
import { getDb } from '../db/connection';
import { childParentIds } from '../util/milestoneChild';
import { advanceWorkdaysInclusive, buildCalendar, countWorkdaysBetween, countWorkdaysOrMissing, isRealYmd, ymdInTimezone, type WorkdayCal } from '../util/workdays';
import { resolveProjectTz } from './ProjectTimeZone'; // T03268：单项目口径按项目时区取业务日

export type ForecastVerdict = 'done' | 'not-predictable' | 'on-track' | 'ahead' | 'behind' | 'no-planned-end';

export interface ForecastChild {
  id: string;
  title: string;
  status: string;
  progress: number;
  durationDays: number | null;
  /** 该子项总工作日；缺工期且缺排期时为 null（不计 0） */
  totalWorkdays: number | null;
  /** 剩余工作日；已完成或缺失时为 null */
  remainingWorkdays: number | null;
  /** 缺失字段名（如 ['排期']），非空即该子项不可计入剩余量 */
  missing: string[];
}

export interface MilestoneForecast {
  milestoneId: string;
  projectId: string;
  projectName: string;
  title: string;
  status: string;
  progress: number;
  childrenTotal: number;
  childrenDone: number;
  /** 完成率 0..1；无子项时 null（不报 0%） */
  completionRate: number | null;
  /** 未完成子项剩余工作日合计；存在缺失子项时为 null（部分已知量不能冒充合计） */
  remainingWorkdays: number | null;
  /** 预测完成日 YYYY-MM-DD；不可预测时为 null */
  forecastDate: string | null;
  /** 计划结束日（包络）；未排期时 null */
  plannedEnd: string | null;
  /** 正=延后、负=提前（工作日）；缺预测日或计划结束日时为 null */
  varianceWorkdays: number | null;
  verdict: ForecastVerdict;
  /** 人类可读的计算依据，与 verdict 同一数据源 */
  basis: string;
  children: ForecastChild[];
}

export interface MilestoneForecastReport {
  /** 业务日（YYYY-MM-DD，D-12：调用方/系统时区） */
  at: string;
  tz: string;
  model: 'milestone-children-v1';
  disclaimer: string;
  milestones: MilestoneForecast[];
  summary: { total: number; predicted: number; done: number; notPredictable: number };
}

const DISCLAIMER = '预测值，非承诺';

function loadCalendar(): WorkdayCal {
  const rows = getDb().prepare('SELECT date, kind FROM holidays').all() as Array<{ date: string; kind: string | null }>;
  return buildCalendar(rows);
}

const clampProgress = (v: number): number => (Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0);

/** 单子项总工作日：duration_days 优先，其次排期区间；两者都缺 → null */
function childTotalWorkdays(row: PlanRow, cal: WorkdayCal): number | null {
  const dur = Number(row.duration_days);
  if (Number.isFinite(dur) && dur > 0) return Math.floor(dur);
  return countWorkdaysOrMissing(row.start_date, row.end_date, cal);
}

interface PlanRow {
  id: string; project_id: string; title: string; kind: string | null; status: string;
  progress: number; start_date: string; end_date: string; duration_days: number; deps: string | null;
}

function forecastChild(row: PlanRow, cal: WorkdayCal): ForecastChild {
  const progress = clampProgress(Number(row.progress));
  const total = childTotalWorkdays(row, cal);
  const missing: string[] = [];
  if (total === null) missing.push('排期');
  let remaining: number | null = null;
  if (row.status !== 'done' && total !== null) {
    remaining = Math.ceil((total * (100 - progress)) / 100);
    if (remaining < 0) remaining = 0;
  }
  // 已完成子项不参与剩余量：进度列可能停在 96% 之类的残值，带进合计会把预测日推后
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    progress,
    durationDays: Number.isFinite(Number(row.duration_days)) && Number(row.duration_days) > 0 ? Number(row.duration_days) : null,
    totalWorkdays: total,
    remainingWorkdays: remaining,
    missing,
  };
}

function verdictOf(variance: number | null, done: boolean, predictable: boolean): ForecastVerdict {
  if (done) return 'done';
  if (!predictable) return 'not-predictable';
  if (variance === null) return 'no-planned-end';
  if (variance > 0) return 'behind';
  if (variance < 0) return 'ahead';
  return 'on-track';
}

function buildBasis(f: {
  childrenTotal: number; childrenDone: number; remaining: number | null; forecastDate: string | null;
  plannedEnd: string | null; variance: number | null; missing: string[]; done: boolean; at: string;
}): string {
  if (f.done) return '里程碑已完成，不再预测';
  if (f.childrenTotal === 0) return '无子项，不预测';
  const head = `子项 ${f.childrenDone}/${f.childrenTotal} 完成`;
  if (f.remaining === null) {
    return `${head}；${f.missing.length} 个子项缺工期且缺排期，剩余工作量不可计算，暂不给预测日期（缺失不按 0 计）`;
  }
  const tail = f.forecastDate ? `自 ${f.at} 起串行排 ${f.remaining} 个工作日，预测 ${f.forecastDate}` : '无预测日期';
  if (f.plannedEnd === null) return `${head}；${tail}；里程碑未排期，不判提前/延后`;
  if (f.variance === null) return `${head}；${tail}；计划结束 ${f.plannedEnd}`;
  const v = f.variance === 0 ? '与计划一致' : f.variance > 0 ? `延后 ${f.variance} 个工作日` : `提前 ${-f.variance} 个工作日`;
  return `${head}；${tail}；计划结束 ${f.plannedEnd}，${v}`;
}

function forecastOne(ms: PlanRow & { project_name: string }, children: PlanRow[], at: string, cal: WorkdayCal): MilestoneForecast {
  const done = ms.status === 'done';
  const doneChildren = children.filter((c) => c.status === 'done');
  const open = children.filter((c) => c.status !== 'done');
  const childForecasts = children.map((c) => forecastChild(c, cal));
  const missing = childForecasts.filter((c) => c.missing.length > 0 && c.status !== 'done').map((c) => c.title);
  const knownRemaining = childForecasts
    .filter((c) => c.status !== 'done' && c.remainingWorkdays !== null)
    .reduce((s, c) => s + (c.remainingWorkdays ?? 0), 0);
  const predictable = !done && children.length > 0 && missing.length === 0;
  const remainingWorkdays = predictable ? knownRemaining : null;
  const forecastDate = predictable ? advanceWorkdaysInclusive(at, remainingWorkdays ?? 0, cal) : null;
  const plannedEnd = isRealYmd(ms.end_date || '') ? ms.end_date : null;
  let variance: number | null = null;
  if (forecastDate && plannedEnd) {
    if (forecastDate > plannedEnd) variance = countWorkdaysBetween(plannedEnd, forecastDate, cal);
    else if (forecastDate < plannedEnd) variance = -countWorkdaysBetween(forecastDate, plannedEnd, cal);
    else variance = 0;
  }
  // remaining=0 且仍有未完成子项（进度 100% 但状态未收口）：预测日就是业务日，同样可解释
  return {
    milestoneId: ms.id,
    projectId: ms.project_id,
    projectName: ms.project_name,
    title: ms.title,
    status: ms.status,
    progress: clampProgress(Number(ms.progress)),
    childrenTotal: children.length,
    childrenDone: doneChildren.length,
    completionRate: children.length === 0 ? null : Math.round((doneChildren.length / children.length) * 10000) / 10000,
    remainingWorkdays,
    forecastDate,
    plannedEnd,
    varianceWorkdays: predictable ? variance : null,
    verdict: verdictOf(predictable ? variance : null, done, predictable),
    basis: buildBasis({
      childrenTotal: children.length, childrenDone: doneChildren.length, remaining: remainingWorkdays,
      forecastDate, plannedEnd, variance, missing, done, at,
    }),
    children: childForecasts,
  };
}

export class MilestoneForecastService {
  static report(args: { projectId?: string; at?: string } = {}): MilestoneForecastReport {
    const db = getDb();
    // T03268：项目视图按其时区取业务日；跨项目总览（无 projectId）按系统时区
    const { tz } = resolveProjectTz(args.projectId);
    if (args.at && !isRealYmd(args.at)) throw new Error(`at 需为 YYYY-MM-DD，收到：${args.at}`);
    // 业务日只看「时区下的日历日」（D-12）；入参 at 已是日历日，不再二次换算
    const at = args.at ?? ymdInTimezone(new Date(), tz);
    if (args.projectId && !db.prepare('SELECT id FROM projects WHERE id = ?').get(args.projectId)) {
      throw new Error('项目不存在');
    }
    // 一次取全量未归档计划行：按 child 边分组（父子标记单源），避免逐里程碑 N+1
    const rows = db.prepare(
      `SELECT t.id, t.project_id, p.name AS project_name, t.title, t.kind, t.status, t.progress,
              t.start_date, t.end_date, t.duration_days, t.deps
         FROM plan_tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.archived = 0${args.projectId ? ' AND t.project_id = ?' : ''}`,
    ).all(...(args.projectId ? [args.projectId] : [])) as Array<PlanRow & { project_name: string }>;
    const cal = loadCalendar();
    const childrenByParent = new Map<string, PlanRow[]>();
    for (const r of rows) {
      for (const parentId of childParentIds(r.deps)) {
        const list = childrenByParent.get(parentId) ?? [];
        list.push(r);
        childrenByParent.set(parentId, list);
      }
    }
    const milestones = rows
      .filter((r) => r.kind === 'milestone')
      .map((m) => forecastOne(m, childrenByParent.get(m.id) ?? [], at, cal))
      .sort((a, b) => a.projectName.localeCompare(b.projectName) || a.title.localeCompare(b.title));
    const summary = {
      total: milestones.length,
      predicted: milestones.filter((m) => m.forecastDate !== null).length,
      done: milestones.filter((m) => m.verdict === 'done').length,
      notPredictable: milestones.filter((m) => m.verdict === 'not-predictable').length,
    };
    return { at, tz, model: 'milestone-children-v1', disclaimer: DISCLAIMER, milestones, summary };
  }
}
