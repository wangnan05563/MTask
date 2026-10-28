/**
 * T03237（PRD PM-205）：项目洞察的日快照机制。
 *
 * 为什么需要独立快照：`task_events` 默认只保留 90 天（`EventRetention`），用它重建长历史会在
 * 清理后静默变短、且事件是过程留痕而非按日读数。CFD/周期时间/逾期趋势/吞吐的长历史唯一来源
 * 是这里每天冻结的一行读数，**不从事件表回填历史**（PM-205「不伪造历史」），因此：
 * - 只采集当天；启动即采一轮，之后每 30 分钟刷新当天读数（当日快照随时间推进收敛到收盘态）；
 * - 缺失日期不做补造，读取方按 `missing` 标注「数据积累中」；
 * - 可回溯起点＝该项目最早的 `stat_date`，早于它的日期一律视为不可回溯。
 *
 * 口径：
 * - 统计日/时区遵循 D-12：系统时区下 `ymdInTimezone` 的日历日；每行落 `stat_date + tz`；
 * - 累计列（todo/done）只数未归档任务；当日新增/完成同样只数未归档——归档是「隐藏」，
 *   但历史快照已冻结，之后归档不会改写过去的行；
 * - 完成时刻优先取当日 `task_events` 中最后一次 `→ done`（重开再完成以最后一次为准），
 *   无事件时仅对「当天创建且当天完成」的任务回落到 `updated_at`，避免把老任务今天的编辑当成完成；
 * - 逾期列直接复用 `OverdueRateService`（G-4 同一口径：边界日当天不算到期、无日期/已归档不进分母）。
 */
import { randomUUID } from 'crypto';
import { getDb } from '../db/connection';
import { fmtDate, isRealYmd, parseYmd, systemTz, ymdInTimezone } from '../util/workdays';
import { OverdueRateService } from './OverdueRateService';

/** 单次查询的时间范围上限（含端点）：再长请分段，避免图表一次拉几百天拖慢响应 */
const MAX_RANGE_DAYS = 366;
/** 默认窗口：近 30 天（PM-205 图表默认口径） */
const DEFAULT_RANGE_DAYS = 30;
/** 当天快照刷新间隔：同日读数随事件推进更新，但不改写已过去的日子 */
const REFRESH_INTERVAL_MS = 30 * 60_000;

export const ACCUMULATING_NOTE = '数据积累中';

export interface SnapshotDay {
  date: string;
  /** true＝当天没有快照行（早于可回溯起点或采集中断），读数一律 null 而非 0 */
  missing: boolean;
  todo: number | null;
  done: number | null;
  created: number | null;
  completed: number | null;
  dueTotal: number | null;
  overdue: number | null;
  cycleP50Hours: number | null;
  cycleP90Hours: number | null;
}

export interface SnapshotRangeReport {
  projectId: string;
  projectName: string;
  tz: string;
  today: string;
  from: string;
  to: string;
  traceableFrom: string | null;
  lastSnapshot: string | null;
  days: SnapshotDay[];
  missingDates: string[];
  cycle: { sampleCount: number; p50Hours: number | null; p90Hours: number | null };
  note: string;
}

export interface SnapshotCoverageProject {
  projectId: string;
  projectName: string;
  traceableFrom: string | null;
  lastSnapshot: string | null;
  snapshotDays: number;
  /** 窗口内（不早于可回溯起点）没有快照的日期；无快照时为 [] */
  missingDates: string[];
}

export interface SnapshotCoverageReport {
  tz: string;
  today: string;
  window: { from: string; to: string };
  projects: SnapshotCoverageProject[];
  note: string;
}

export interface SnapshotCaptureReport {
  at: string;
  tz: string;
  projects: number;
  cycleSamples: number;
  capturedAt: string;
}

interface SnapshotRow {
  project_id: string;
  stat_date: string;
  tz: string;
  todo_count: number;
  done_count: number;
  created_count: number;
  completed_count: number;
  due_total: number;
  overdue_count: number;
  captured_at: string;
}

/** 形状 + 可解析 + 往返一致：挡住 2026-02-30 / 2026-13-01 这类「形状合法但不存在的日期」 */

function addDays(ymd: string, n: number): string {
  const d = parseYmd(ymd);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    out.push(d);
    if (out.length > MAX_RANGE_DAYS) break;
  }
  return out;
}

/** 统计日的本地零点边界（ISO 串）——任务 created_at/updated_at 均按 ISO UTC 存储 */
function dayBounds(statDate: string): [string, string] {
  const start = parseYmd(statDate);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start.toISOString(), end.toISOString()];
}

/** 线性插值百分位（与常见 p50/p90 读法一致）；无样本返回 null */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const v = lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  return Math.round(v * 100) / 100;
}

interface Acc {
  todo: number;
  done: number;
  created: number;
  completed: number;
  dueTotal: number;
  overdue: number;
  samples: Array<{ taskId: string; hours: number }>;
}

function emptyAcc(): Acc {
  return { todo: 0, done: 0, created: 0, completed: 0, dueTotal: 0, overdue: 0, samples: [] };
}

export class MetricSnapshotService {
  /**
   * 采集当天快照（幂等：同项目同日重复采集以最新读数为准）。
   * `at` 只允许当天——历史不从事件表回填，传过去日期会报错而不是静默造数。
   */
  static capture(at?: string): SnapshotCaptureReport {
    const db = getDb();
    const tz = systemTz();
    const today = ymdInTimezone(new Date(), tz);
    const statDate = at ? String(at) : today;
    if (!isRealYmd(statDate)) throw new Error(`at 需为有效的 YYYY-MM-DD，收到：${statDate}`);
    if (statDate !== today) {
      throw new Error(`仅允许采集当天快照（历史不从事件表回填，缺失区间显示「${ACCUMULATING_NOTE}」）；今天为 ${today}`);
    }

    const [startIso, endIso] = dayBounds(statDate);
    const nowIso = new Date().toISOString();
    const projects = db.prepare('SELECT id FROM projects').all() as Array<{ id: string }>;
    const counts = db.prepare(
      `SELECT project_id,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done_count,
              SUM(CASE WHEN status = 'done' THEN 0 ELSE 1 END) AS todo_count
         FROM tasks WHERE archived = 0 GROUP BY project_id`,
    ).all() as Array<{ project_id: string; done_count: number; todo_count: number }>;
    const createdRows = db.prepare(
      `SELECT project_id, COUNT(*) AS n FROM tasks
        WHERE archived = 0 AND created_at >= ? AND created_at < ? GROUP BY project_id`,
    ).all(startIso, endIso) as Array<{ project_id: string; n: number }>;
    // 当日最后一次「→ done」（重开再完成以最后一次为准）；事件表已清理的旧完成不再计入当天
    const statusEvents = db.prepare(
      `SELECT task_id, created_at FROM task_events
        WHERE kind = 'status' AND detail LIKE '%→ done' AND created_at >= ? AND created_at < ?
        ORDER BY created_at`,
    ).all(startIso, endIso) as Array<{ task_id: string; created_at: string }>;
    const doneEventAt = new Map<string, string>();
    for (const e of statusEvents) doneEventAt.set(e.task_id, e.created_at);
    const doneTasks = db.prepare(
      'SELECT id, project_id, created_at, updated_at FROM tasks WHERE archived = 0 AND status = \'done\'',
    ).all() as Array<{ id: string; project_id: string; created_at: string; updated_at: string }>;

    const due = OverdueRateService.report({ at: statDate });

    const byProject = new Map<string, Acc>();
    for (const p of projects) byProject.set(p.id, emptyAcc());
    const accOf = (projectId: string): Acc => {
      const a = byProject.get(projectId) ?? emptyAcc();
      byProject.set(projectId, a);
      return a;
    };
    for (const r of counts) {
      const a = accOf(r.project_id);
      a.done = r.done_count ?? 0;
      a.todo = r.todo_count ?? 0;
    }
    for (const r of createdRows) accOf(r.project_id).created = r.n ?? 0;
    for (const r of due.projects) {
      const a = accOf(r.projectId);
      a.dueTotal = r.dueTotal;
      a.overdue = r.overdue;
    }

    for (const t of doneTasks) {
      const createdMs = Date.parse(t.created_at);
      let completedAt = doneEventAt.get(t.id) ?? '';
      if (!completedAt) {
        const createdInDay = t.created_at >= startIso && t.created_at < endIso;
        const updatedInDay = t.updated_at >= startIso && t.updated_at < endIso;
        if (createdInDay && updatedInDay) completedAt = t.updated_at;
      }
      if (!completedAt) continue;
      const hours = (Date.parse(completedAt) - createdMs) / 3_600_000;
      if (!Number.isFinite(hours) || hours < 0 || hours > 24 * 365 * 5) continue;
      const a = accOf(t.project_id);
      a.completed += 1;
      a.samples.push({ taskId: t.id, hours: Math.round(hours * 10000) / 10000 });
    }

    let cycleSamples = 0;
    const write = db.transaction(() => {
      for (const [projectId, a] of byProject) {
        db.prepare(
          `INSERT INTO metric_day_snapshots
             (id, project_id, stat_date, tz, todo_count, done_count, created_count, completed_count,
              due_total, overdue_count, captured_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id, stat_date) DO UPDATE SET
             tz = excluded.tz, todo_count = excluded.todo_count, done_count = excluded.done_count,
             created_count = excluded.created_count, completed_count = excluded.completed_count,
             due_total = excluded.due_total, overdue_count = excluded.overdue_count,
             captured_at = excluded.captured_at`,
        ).run(randomUUID(), projectId, statDate, tz, a.todo, a.done, a.created, a.completed,
          a.dueTotal, a.overdue, nowIso, nowIso);
        // 当天重采先清后写：任务被重开/取消完成后，样本不能残留
        db.prepare('DELETE FROM metric_day_cycle_samples WHERE project_id = ? AND stat_date = ?')
          .run(projectId, statDate);
        const ins = db.prepare(
          'INSERT INTO metric_day_cycle_samples (project_id, stat_date, task_id, cycle_hours) VALUES (?, ?, ?, ?)',
        );
        for (const s of a.samples) {
          ins.run(projectId, statDate, s.taskId, s.hours);
          cycleSamples += 1;
        }
      }
    });
    write();

    return { at: statDate, tz, projects: projects.length, cycleSamples, capturedAt: nowIso };
  }

  /** 按项目 + 时间范围出日快照序列；缺失日期显式标记，绝不把缺失读成 0 */
  static range(args: { projectId?: string; from?: string; to?: string }): SnapshotRangeReport {
    const db = getDb();
    const tz = systemTz();
    const today = ymdInTimezone(new Date(), tz);
    const projectId = String(args.projectId ?? '').trim();
    if (!projectId) throw new Error('projectId 必填');
    const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) as
      { id: string; name: string } | undefined;
    if (!project) throw new Error('项目不存在');

    const firstRow = db.prepare('SELECT MIN(stat_date) AS d FROM metric_day_snapshots WHERE project_id = ?')
      .get(projectId) as { d: string | null };
    const lastRow = db.prepare('SELECT MAX(stat_date) AS d FROM metric_day_snapshots WHERE project_id = ?')
      .get(projectId) as { d: string | null };
    const traceableFrom = firstRow.d ?? null;

    const to = args.to ? String(args.to) : today;
    const from = args.from ? String(args.from) : addDays(today, -(DEFAULT_RANGE_DAYS - 1));
    if (!isRealYmd(from) || !isRealYmd(to)) throw new Error(`from/to 需为有效的 YYYY-MM-DD，收到：${from} ~ ${to}`);
    if (from > to) throw new Error('起始日期不能晚于结束日期');
    const dates = eachDay(from, to);
    if (dates[dates.length - 1] !== to) throw new Error(`时间范围过大（≤${MAX_RANGE_DAYS} 天）`);

    const rows = db.prepare(
      'SELECT * FROM metric_day_snapshots WHERE project_id = ? AND stat_date >= ? AND stat_date <= ? ORDER BY stat_date',
    ).all(projectId, from, to) as SnapshotRow[];
    const samples = db.prepare(
      'SELECT stat_date, cycle_hours FROM metric_day_cycle_samples WHERE project_id = ? AND stat_date >= ? AND stat_date <= ?',
    ).all(projectId, from, to) as Array<{ stat_date: string; cycle_hours: number }>;
    const samplesByDay = new Map<string, number[]>();
    for (const s of samples) {
      const list = samplesByDay.get(s.stat_date) ?? [];
      list.push(s.cycle_hours);
      samplesByDay.set(s.stat_date, list);
    }
    const byDate = new Map(rows.map((r) => [r.stat_date, r]));

    const days: SnapshotDay[] = dates.map((date) => {
      const r = byDate.get(date);
      if (!r) {
        return {
          date, missing: true, todo: null, done: null, created: null, completed: null,
          dueTotal: null, overdue: null, cycleP50Hours: null, cycleP90Hours: null,
        };
      }
      const daySamples = samplesByDay.get(date) ?? [];
      return {
        date,
        missing: false,
        todo: r.todo_count,
        done: r.done_count,
        created: r.created_count,
        completed: r.completed_count,
        dueTotal: r.due_total,
        overdue: r.overdue_count,
        cycleP50Hours: percentile(daySamples, 0.5),
        cycleP90Hours: percentile(daySamples, 0.9),
      };
    });
    const pooled = samples.map((s) => s.cycle_hours);
    const missingDates = days.filter((d) => d.missing).map((d) => d.date);

    return {
      projectId,
      projectName: project.name,
      tz,
      today,
      from,
      to,
      traceableFrom,
      lastSnapshot: lastRow.d ?? null,
      days,
      missingDates,
      cycle: { sampleCount: pooled.length, p50Hours: percentile(pooled, 0.5), p90Hours: percentile(pooled, 0.9) },
      note: traceableFrom
        ? `可回溯起点 ${traceableFrom}；早于该日期或没有快照的日期显示「${ACCUMULATING_NOTE}」（日快照不从事件表回填）`
        : `尚未积累日快照：洞察数据从首次采集日开始，缺失区间显示「${ACCUMULATING_NOTE}」`,
    };
  }

  /** 各项目的快照覆盖与近 30 天缺失日——页面上「可回溯起点/数据积累中」的数据源 */
  static coverage(args: { projectId?: string } = {}): SnapshotCoverageReport {
    const db = getDb();
    const tz = systemTz();
    const today = ymdInTimezone(new Date(), tz);
    const windowFrom = addDays(today, -(DEFAULT_RANGE_DAYS - 1));
    const rows = args.projectId
      ? db.prepare('SELECT id, name FROM projects WHERE id = ?').all(String(args.projectId)) as Array<{ id: string; name: string }>
      : db.prepare('SELECT id, name FROM projects ORDER BY sort_weight DESC, name').all() as Array<{ id: string; name: string }>;
    if (args.projectId && rows.length === 0) throw new Error('项目不存在');

    const projects: SnapshotCoverageProject[] = rows.map((p) => {
      const stat = db.prepare(
        'SELECT MIN(stat_date) AS first_date, MAX(stat_date) AS last_date, COUNT(*) AS n FROM metric_day_snapshots WHERE project_id = ?',
      ).get(p.id) as { first_date: string | null; last_date: string | null; n: number };
      const traceableFrom = stat.first_date;
      let missingDates: string[] = [];
      if (traceableFrom) {
        const from = traceableFrom > windowFrom ? traceableFrom : windowFrom;
        const present = new Set(
          (db.prepare(
            'SELECT stat_date FROM metric_day_snapshots WHERE project_id = ? AND stat_date >= ? AND stat_date <= ?',
          ).all(p.id, from, today) as Array<{ stat_date: string }>).map((r) => r.stat_date),
        );
        missingDates = eachDay(from, today).filter((d) => !present.has(d));
      }
      return {
        projectId: p.id,
        projectName: p.name,
        traceableFrom,
        lastSnapshot: stat.last_date,
        snapshotDays: stat.n,
        missingDates,
      };
    });

    return {
      tz,
      today,
      window: { from: windowFrom, to: today },
      projects,
      note: `统计日按 ${tz} 时区；日快照不从事件表回填，缺失日期显示「${ACCUMULATING_NOTE}」`,
    };
  }

  /** 启动即采一轮 + 定时刷新当天读数；单轮失败只记日志，不影响业务 */
  static startSnapshotTimer(intervalMs = REFRESH_INTERVAL_MS): ReturnType<typeof setInterval> {
    const tick = () => {
      try {
        MetricSnapshotService.capture();
      } catch (e) {
        console.error('[metrics-snapshot] 采集失败:', e);
      }
    };
    tick();
    return setInterval(tick, intervalMs);
  }
}
