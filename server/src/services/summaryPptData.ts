/**
 * T02855（六期 S4）：阶段性总结汇报 PPT 的取数层（PRD §6.1 / FR-5.1~FR-5.12）。
 *
 * 三件事，边界刻意收窄：
 *  1. **数字只来自库**——装配器 `summaryPptBuilder.ts` 不查库，只消费本文件产出的 `SummaryDeckData`；
 *  2. **口径复用既有单源**——任务活动口径走 `gatherSummaryBundle`（内部 `gatherReportData`），
 *     计划走 `PlanService.list`（archived=0 且非 history），问题走 `PlanService.listIssues`，
 *     覆盖度走 `TestCaseService.coverage`，里程碑子项计数走 `milestoneProgress.milestoneChildStats`；
 *     本文件不复制任何一条既有 SQL 的谓词。
 *  3. **不诚实的话不说**——`estimate_items` 无 actual/done_at（PRD 裁决 A-5），所以工作量默认走
 *     「不报本期人天（③）」，累计口径（①）需显式开启并带「累计估算，非本期实测」声明；
 *     分摊口径（②）按裁决**禁用**，传 `allocated` 直接抛错而不是悄悄换成别的口径。
 *
 * 只读：本文件不含任何 INSERT/UPDATE/DELETE，也不调 AI（FR-3.4 同族纪律）。
 */
import { getDb } from '../db/connection';
import { PlanService, type PlanStatus, type PlanTaskRow } from './PlanService';
import { TaskService } from './TaskService';
import { TestCaseService } from './TestCaseService';
import { milestoneChildStats } from './milestoneProgress';
import {
  buildSummaryPreflight,
  gatherSummaryBundle,
  type SummaryBundle,
  type SummaryPreflightResult,
} from './summaryPptService';
import type { CustomRange } from './summaryPptPeriod';
import type { ReportTaskRow, SummaryPeriod } from './ReportService';

// ---------- 工作量口径（PRD FR-5.8 / 裁决 A-5） ----------

/**
 * 三口径：`none` = 不报本期人天（裁决默认）、`cumulative` = 截至当前累计估算、
 * `allocated` = 按本期完成占比分摊。**`allocated` 是裁决明令禁用的口径**——保留枚举只为
 * 「传错要报错」而不是「能跑」：静默换成别的口径会让口径声明与页面数字对不上。
 */
export const WORKLOAD_CALIBERS = ['none', 'cumulative', 'allocated'] as const;
export type WorkloadCaliber = (typeof WORKLOAD_CALIBERS)[number];
export const DEFAULT_WORKLOAD_CALIBER: WorkloadCaliber = 'none';

/** 口径 → 页脚声明（PRD §7「工作量口径声明」；验收 14 直接断言这几串） */
export const WORKLOAD_FOOTER: Record<Exclude<WorkloadCaliber, 'allocated'>, string> = {
  none: '工作量口径：不报本期人天，只报完成项数与工期消耗（工期口径，非三点估算）',
  cumulative: '工作量口径：累计估算，非本期实测',
};

/** 生效口径：allocated 直接点名校验 A-5；cumulative 无估算行时回落 none 并在声明里说清原因 */
export function resolveWorkloadCaliber(caliber: WorkloadCaliber | undefined, estimateItems: number): {
  caliber: Exclude<WorkloadCaliber, 'allocated'>;
  footer: string;
} {
  const wanted = caliber ?? DEFAULT_WORKLOAD_CALIBER;
  if (wanted === 'allocated') {
    throw new Error('工作量口径 allocated（分摊）已被 PRD 裁决 A-5 禁用——请用 none（不报本期人天）或 cumulative（累计估算）');
  }
  if (wanted === 'cumulative' && estimateItems === 0) {
    return {
      caliber: 'none',
      footer: '无三点估算行，已回落「不报本期人天」口径：只报完成项数与工期消耗（工期口径，非三点估算）',
    };
  }
  return { caliber: wanted, footer: WORKLOAD_FOOTER[wanted] };
}

// ---------- 形状 ----------

export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  todo: '未开始',
  doing: '进行中',
  blocked: '阻塞',
  done: '已完成',
};

export const ISSUE_LEVEL_LABEL: Record<string, string> = {
  blocker: '阻塞级',
  suggested: '建议',
  info: '提示',
};

export interface SummaryPlanRow {
  id: string;
  title: string;
  status: PlanStatus;
  startDate: string;
  endDate: string;
  progress: number;
  complexity: number | null;
  overdue: boolean;
}

/** 里程碑两态（FR-5.5 / 验收 15）：有子项 = 聚合进度 + done/total；无子项 = 人工填报，不画进度条 */
export interface SummaryMilestone {
  id: string;
  title: string;
  status: PlanStatus;
  /** 读库内聚合值，不重算（PRD §6.1 milestones 行） */
  progress: number;
  hasChildren: boolean;
  done: number;
  total: number;
  endDate: string;
}

export interface SummaryIssue {
  question: string;
  level: string;
  status: string;
  answer: string;
}

export interface SummaryWorkload {
  caliber: Exclude<WorkloadCaliber, 'allocated'>;
  footer: string;
  estimateItems: number;
  /** 三点估算的 Σ likely（累计口径唯一的「人天」数字） */
  likelyDays: number;
  byPhase: Array<{ phase: string; items: number; likely: number }>;
  /** 口径③：完成项数与工期消耗（`duration_days` 之和，工作日口径） */
  donePlans: number;
  doneDurationDays: number;
  totalDurationDays: number;
  /** 复杂度 ≥4 的计划行数（风险页同源） */
  complexRows: number;
}

export interface SummaryCoverage {
  total: number;
  covered: number;
  uncovered: number;
  rate: number;
  byPriority: Array<{ priority: string; count: number }>;
}

export interface SummaryEventRow {
  title: string;
  kind: string;
  detail: string;
  at: string;
}

export interface SummaryDeliverables {
  docs: Array<{ filename: string; status: string; updatedAt: string }>;
  snapshots: Array<{ filename: string; createdAt: string }>;
  donePlanTitles: string[];
  donePlans: number;
  doneTasks: number;
}

export interface SummaryProjectData {
  id: string;
  name: string;
  workspace: string;
  tasks: { active: number; done: number; verified: number };
  plans: {
    total: number;
    byStatus: Record<PlanStatus, number>;
    overdue: number;
    blocked: number;
    avgProgress: number;
    rows: SummaryPlanRow[];
  };
  milestones: SummaryMilestone[];
  issues: SummaryIssue[];
  workload: SummaryWorkload;
  coverage: SummaryCoverage;
  events: SummaryEventRow[];
  deliverables: SummaryDeliverables;
  nextPlans: SummaryPlanRow[];
  nextMilestone: SummaryMilestone | null;
  risks: { overdue: number; blocked: number; complex: number; milestonesNotDone: number };
  counts: { requirements: number; prdDocs: number; testCases: number; estimates: number; snapshots: number };
}

export interface SummaryDeckData {
  period: SummaryPeriod;
  periodLabel: string;
  range: { start: string; end: string };
  /** 页面脚注的「数据截至」日期（本地时区 YYYY-MM-DD，同报表口径） */
  dataAsOf: string;
  /** S9 单源：覆盖率降级时页脚必须原样带出 footnote（FR-3.2） */
  coverage: SummaryEventCoverage;
  projects: SummaryProjectData[];
  preflight: SummaryPreflightResult;
}

export interface SummaryEventCoverage {
  ok: boolean;
  degraded: boolean;
  footnote: string;
  retentionDays: number;
}

export interface GatherDeckOptions {
  /** 工作量口径（缺省 none=裁决 A-5 的默认口径）；allocated 抛错 */
  workloadCaliber?: WorkloadCaliber;
  /** 注入「今天」（门禁夹具用）；缺省当前时间 */
  now?: Date;
  /** 已采集的 bundle（S5 流式链路复用，避免为校验与装配各跑一遍全量取数）；缺省自行采集 */
  bundle?: SummaryBundle;
}

// ---------- 小工具 ----------

/** 本地时区 YYYY-MM-DD（与 ReportService 的日期串同口径，避免 UTC 跨日错位） */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function statusOf(v: string): PlanStatus {
  return v === 'doing' || v === 'blocked' || v === 'done' ? v : 'todo';
}

/** 进度均值（四舍五入到整数百分比；空集合 = 0） */
function avgProgress(rows: PlanTaskRow[]): number {
  if (rows.length === 0) return 0;
  return Math.round(rows.reduce((a, r) => a + (Number(r.progress) || 0), 0) / rows.length);
}

/** 计划行 → 页面行（排序与逾期标记；`today` 是本地日期串，字符串比较与日期比较等价） */
function toRow(r: PlanTaskRow, today: string): SummaryPlanRow {
  const end = r.end_date ?? '';
  return {
    id: r.id,
    title: r.title,
    status: statusOf(r.status),
    startDate: r.start_date ?? '',
    endDate: end,
    progress: Math.round(Number(r.progress) || 0),
    complexity: typeof r.complexity === 'number' ? r.complexity : null,
    overdue: end !== '' && end < today && r.status !== 'done',
  };
}

/** 未完成计划按 start_date 升序（空日期排最后），Top N（FR-5.10） */
function upcoming(rows: SummaryPlanRow[], n: number): SummaryPlanRow[] {
  return rows
    .filter((r) => r.status !== 'done')
    .sort((a, b) => {
      if (a.startDate === b.startDate) return a.title.localeCompare(b.title, 'zh');
      if (a.startDate === '') return 1;
      if (b.startDate === '') return -1;
      return a.startDate < b.startDate ? -1 : 1;
    })
    .slice(0, n);
}

// ---------- 采集 ----------

function gatherWorkload(
  db: ReturnType<typeof getDb>,
  projectId: string,
  planRows: SummaryPlanRow[],
  caliber: WorkloadCaliber | undefined,
): SummaryWorkload {
  const estRows = db
    .prepare('SELECT phase, optimistic, likely, pessimistic FROM estimate_items WHERE project_id = ?')
    .all(projectId) as Array<{ phase: string | null; optimistic: number | null; likely: number | null; pessimistic: number | null }>;
  const phases = new Map<string, { items: number; likely: number }>();
  for (const r of estRows) {
    const k = (r.phase ?? '').trim() || '未分阶段';
    const cur = phases.get(k) ?? { items: 0, likely: 0 };
    cur.items += 1;
    cur.likely += Number(r.likely) || 0;
    phases.set(k, cur);
  }
  const resolved = resolveWorkloadCaliber(caliber, estRows.length);
  const done = planRows.filter((r) => r.status === 'done');
  return {
    caliber: resolved.caliber,
    footer: resolved.footer,
    estimateItems: estRows.length,
    likelyDays: Math.round(estRows.reduce((a, r) => a + (Number(r.likely) || 0), 0) * 10) / 10,
    byPhase: [...phases.entries()].map(([phase, v]) => ({ phase, items: v.items, likely: Math.round(v.likely * 10) / 10 })),
    donePlans: done.length,
    // 工期消耗在 `gatherProject` 里按计划行原值补齐（本函数只拿到页面行，没有 duration_days）
    doneDurationDays: 0,
    totalDurationDays: 0,
    complexRows: planRows.filter((r) => (r.complexity ?? 0) >= 4).length,
  };
}

function gatherProject(
  db: ReturnType<typeof getDb>,
  bundle: ReturnType<typeof gatherSummaryBundle>,
  id: string,
  index: number,
  today: string,
  caliber: WorkloadCaliber | undefined,
): SummaryProjectData {
  const name = bundle.projectNames[index] ?? '未命名项目';
  // `report.tasks[].status` 是本地化中文（待办/已完成），不能用 'done' 比；按项目聚合行才是同一口径的计数源
  const reportProject = bundle.report.projects.find((p) => p.name === name);
  const plans = PlanService.list(id);
  const rows = plans.map((r) => toRow(r, today));
  const milestoneRows = plans.filter((r) => r.kind === 'milestone');
  const milestones: SummaryMilestone[] = milestoneRows.map((r) => {
    const stats = milestoneChildStats(db, r.id);
    return {
      id: r.id,
      title: r.title,
      status: statusOf(r.status),
      progress: Math.round(Number(r.progress) || 0),
      hasChildren: stats.total > 0,
      done: stats.done,
      total: stats.total,
      endDate: r.end_date ?? '',
    };
  });

  const rawIssues = PlanService.listIssues(id);
  const issues: SummaryIssue[] = rawIssues
    .map((r) => ({
      question: String(r.question ?? ''),
      level: String(r.level ?? ''),
      status: String(r.status ?? ''),
      answer: String(r.answer ?? ''),
    }))
    .filter((r) => r.question !== '')
    // blocker 置顶（FR-5.7），其余保持 listIssues 的 sort_order 序
    .sort((a, b) => (a.level === 'blocker' ? -1 : 0) - (b.level === 'blocker' ? -1 : 0));

  const workload = gatherWorkload(db, id, rows, caliber);
  // 工期消耗按**计划行原值**求和（`duration_days` 不在页面行上，故单独取一次）
  const durationById = new Map(plans.map((p) => [p.id, Number(p.duration_days) || 0]));
  workload.doneDurationDays = Math.round(rows.filter((r) => r.status === 'done').reduce((a, r) => a + (durationById.get(r.id) ?? 0), 0) * 10) / 10;
  workload.totalDurationDays = Math.round(plans.reduce((a, p) => a + (Number(p.duration_days) || 0), 0) * 10) / 10;

  const coverage = TestCaseService.coverage(id);
  const priorityRows = db
    .prepare("SELECT priority, COUNT(*) AS n FROM test_cases WHERE project_id = ? GROUP BY priority ORDER BY priority")
    .all(id) as Array<{ priority: string; n: number }>;

  const since = bundle.range.start.toISOString();
  const events = TaskService.listEvents({ projectId: id, since, limit: 50 }).map((e) => ({
    title: e.title ?? '',
    kind: e.kind,
    detail: e.detail ?? '',
    at: e.created_at,
  }));

  const docs = PlanService.listPrdDocs(id).map((d) => ({
    filename: String(d.filename ?? ''),
    status: String(d.status ?? ''),
    updatedAt: String(d.updated_at ?? ''),
  }));
  const snapshots = db
    .prepare('SELECT filename, created_at FROM estimate_snapshots WHERE project_id = ? ORDER BY created_at DESC LIMIT 5')
    .all(id) as Array<{ filename: string; created_at: string }>;
  const donePlanTitles = rows.filter((r) => r.status === 'done').slice(0, 4).map((r) => r.title);
  const doneTasks = reportProject?.done ?? 0;

  const requirements = PlanService.listRequirements(id).length;
  const counts = {
    requirements,
    prdDocs: docs.length,
    // 用例数只能取 caseTotal：`coverage.total` 是需求数，直接当用例数会虚报（T02969）
    testCases: coverage.caseTotal,
    estimates: workload.estimateItems,
    snapshots: snapshots.length,
  };

  return {
    id,
    name,
    // 附录要写项目工作空间（FR-5.12）；`PlanService` 无该项目字段的公开读口，单取一条只读查询
    workspace: String(
      (db.prepare("SELECT COALESCE(workspace_path, '') AS ws FROM projects WHERE id = ?").get(id) as { ws: string } | undefined)?.ws ?? '',
    ),
    tasks: {
      active: reportProject?.total ?? 0,
      done: doneTasks,
      verified: reportProject?.verified ?? 0,
    },
    plans: {
      total: rows.length,
      byStatus: {
        todo: rows.filter((r) => r.status === 'todo').length,
        doing: rows.filter((r) => r.status === 'doing').length,
        blocked: rows.filter((r) => r.status === 'blocked').length,
        done: rows.filter((r) => r.status === 'done').length,
      },
      overdue: rows.filter((r) => r.overdue).length,
      blocked: rows.filter((r) => r.status === 'blocked').length,
      avgProgress: avgProgress(plans),
      rows,
    },
    milestones,
    issues,
    workload,
    coverage: {
      total: coverage.total,
      covered: coverage.covered,
      uncovered: coverage.uncovered,
      rate: coverage.rate,
      byPriority: priorityRows.map((r) => ({ priority: r.priority, count: r.n })),
    },
    events,
    deliverables: {
      docs: docs.slice(0, 5),
      snapshots: snapshots.map((s) => ({ filename: s.filename, createdAt: s.created_at })),
      donePlanTitles,
      donePlans: rows.filter((r) => r.status === 'done').length,
      doneTasks,
    },
    nextPlans: upcoming(rows, 5),
    nextMilestone: milestones.filter((m) => m.status !== 'done').sort((a, b) => (a.endDate < b.endDate ? -1 : 1))[0] ?? null,
    risks: {
      overdue: rows.filter((r) => r.overdue).length,
      blocked: rows.filter((r) => r.status === 'blocked').length,
      complex: rows.filter((r) => (r.complexity ?? 0) >= 4).length,
      milestonesNotDone: milestones.filter((m) => m.status !== 'done').length,
    },
    counts,
  };
}

/**
 * 采集入口（S4 装配器唯一数源）。
 * 项目顺序与范围同 `gatherSummaryBundle`（用户勾选序，空范围=全部未归档项目）。
 */
export function gatherSummaryDeckData(
  period: SummaryPeriod,
  projectIds?: string[],
  custom?: CustomRange,
  opts: GatherDeckOptions = {},
): SummaryDeckData {
  const bundle = opts.bundle ?? gatherSummaryBundle(period, projectIds, custom);
  const db = getDb();
  const now = opts.now ?? new Date();
  const today = ymd(now);
  const projects = bundle.projectIds.map((id, i) => gatherProject(db, bundle, id, i, today, opts.workloadCaliber));
  return {
    period: bundle.period,
    periodLabel: bundle.periodLabel,
    range: { start: bundle.range.start.toISOString(), end: bundle.range.end.toISOString() },
    dataAsOf: today,
    coverage: {
      ok: bundle.coverage.ok,
      degraded: bundle.coverage.degraded,
      footnote: bundle.coverage.footnote,
      retentionDays: bundle.coverage.retentionDays,
    },
    projects,
    preflight: buildSummaryPreflight(bundle),
  };
}

/** 合并版/单项目页的项目解析（大纲的 projectId 只在合并版出现） */
export function projectOf(deck: SummaryDeckData, projectId?: string): SummaryProjectData | undefined {
  if (projectId) return deck.projects.find((p) => p.id === projectId);
  return deck.projects.length === 1 ? deck.projects[0] : undefined;
}
