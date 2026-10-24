/**
 * 「阶段性项目总结汇报 PPT」服务端采集与前置校验（PRD-阶段性项目总结汇报PPT §3.3 FR-3，六期 S2）。
 *
 * 纪律（与 `kickoffService.preflight` 同族但口径不同，逐条以本 PRD 为准）：
 * - **只读、零 AI 调用**（FR-3.4）：本文件不得出现 AIService 调用，也不得写库；
 * - **S1 口径复用 `gatherReportData`**（PRD §3.3 明示「口径同 gatherReportData」）：不自开一条
 *   活动任务 SQL，否则校验数与周报面板必然漂移；
 * - **S9 判据与页脚文案单源在 `summaryPptPeriod.assessEventCoverage`**：本文件只是消费者，
 *   不再产第二份「事件仅覆盖最近 N 天」文案；
 * - **硬阻塞口径是 S1 ✕ 或 S2 ✕ 即阻塞**（FR-3.3），与 kickoff 的「三项全缺才阻塞」不同，勿照抄。
 */
import { getDb } from '../db/connection';
import { ACTIVE_PROJECT_WHERE } from '../util/projectRouting';
import {
  gatherReportData,
  periodLabelOf,
  periodRange,
  validateProjectIds,
  type ReportData,
  type SummaryPeriod,
} from './ReportService';
import { assertCustomRange, assertSummaryPeriod, assessEventCoverage, DAY_MS, type CustomRange, type EventCoverage } from './summaryPptPeriod';

// ---------- 校验项形状 ----------

export type SummaryPreflightKey = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7' | 'S8' | 'S9';
/** ✓ / ⚠ / ✕：`warn` 是可降级继续（但必须在页面上留痕，FR-3.2），`fail` 是缺料 */
export type SummaryPreflightStatus = 'ok' | 'warn' | 'fail';

export interface SummaryPreflightItem {
  key: SummaryPreflightKey;
  label: string;
  /** 实际条数（面板 checklist 直接显示；S9 为「本期可覆盖天数」，S8 为「配了工作空间的项目数」） */
  count: number;
  status: SummaryPreflightStatus;
  /** 一句「怎么补」，warn 级还要说明降级后果 */
  note: string;
  /** 前端深链：真实存在的页签/卡片键（`tasks`/`plan`/`plan?menu=*`/`report?card=*`/`settings`），空串=无可跳转处 */
  deepLink: string;
  /** 硬缺失项（S1/S2）：任一 fail 即整体阻塞（FR-3.3） */
  hard: boolean;
}

export interface SummaryPreflightResult {
  period: SummaryPeriod;
  periodLabel: string;
  /** 本期窗口（ISO 串，左闭右开）——与 `gatherReportData` 用的是同一次 `periodRange` 结果 */
  periodRange: { start: string; end: string };
  projectIds: string[];
  projectNames: string[];
  items: SummaryPreflightItem[];
  blocked: boolean;
  /** fail 的硬项 key，供「按钮置灰 + 点名深链」 */
  missingHard: SummaryPreflightKey[];
  /** S9 事件覆盖判据原样透出（生成期页脚也要用，不让 UI 侧重算第二遍） */
  coverage: EventCoverage;
}

// ---------- 判定阈值单源（PRD §3.3 表） ----------

export const MIN_ACTIVE_TASKS = 1;
export const MIN_PLAN_TASKS = 3;
/** `plan_tasks.start_date` 非空率下限，低于则进展/时间线页无法绘制 */
export const MIN_PLAN_DATE_RATE = 0.6;
export const MIN_MILESTONES = 1;
export const MIN_REQUIREMENTS = 3;
export const MIN_PRD_DOCS = 1;

function rate(n: number, d: number): number {
  return d === 0 ? 0 : n / d;
}
/** 百分比文本（一位小数）：note 里给人看的填充率 */
function pctText(n: number, d: number): string {
  return d === 0 ? '0' : String(Math.round((n / d) * 1000) / 10);
}

// ---------- 采集 Bundle（§3.4 第 1 步：一次读，校验与装配共用） ----------

export interface SummaryBundle {
  period: SummaryPeriod;
  periodLabel: string;
  /** 取数用左闭右开区间；展示用「含」的上界见 `range.endInclusive`（T02944） */
  range: ReturnType<typeof periodRange>;
  /** 项目范围（空范围已按「全部未归档项目」展开，后续所有取数只用这份 ids） */
  projectIds: string[];
  projectNames: string[];
  /** S1 数据源：周报聚合结果原样复用（条数、按项目分块、计划联动行都在里面） */
  report: ReportData;
  /** 范围内一个未归档项目也没有（全部已归档）：此时各条数一律为 0，不能让 S1 把归档项目的活动算进来 */
  scopeEmpty: boolean;
  /** S2：未归档计划总数 + start_date 非空数 + 缺日期样例标题（点名用，最多 5 条） */
  plans: { total: number; dated: number; missingDateTitles: string[] };
  /** S3 */
  milestones: number;
  /** S4 */
  requirements: number;
  /** S5：总份数与确认版份数 */
  prdDocs: { total: number; confirmed: number };
  /** S6 */
  testCases: number;
  /** S7 */
  estimates: number;
  /** S8：配了可引用工作空间的项目数 */
  workspaces: number;
  /** S9 */
  coverage: EventCoverage;
}

/** 空范围 = 全部未归档项目（PRD FR-2.2），按 sort_weight 取序；解析结果显式传给各处取数 */
function resolveProjectIds(db: ReturnType<typeof getDb>, requested: string[]): string[] {
  if (requested.length > 0) return requested;
  return (db
    .prepare(`SELECT id FROM projects WHERE ${ACTIVE_PROJECT_WHERE} ORDER BY sort_weight, created_at`)
    .all() as Array<{ id: string }>).map((r) => r.id);
}

function projectNamesInOrder(db: ReturnType<typeof getDb>, ids: string[]): string[] {
  if (ids.length === 0) return [];
  const rows = db
    .prepare(`SELECT id, name FROM projects WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as Array<{ id: string; name: string }>;
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  return ids.map((id) => byId.get(id) ?? '未命名项目');
}

/** `project_id IN (?)` 片段：空 ids 时回落到「本函数不接受空范围」——范围在 gather 里已展开 */
function inClause(ids: string[]): string {
  return `IN (${ids.map(() => '?').join(',')})`;
}

/**
 * 一次采集：S1~S9 全部只读取数。
 * 校验项条数必须与各面板实际条数一致，所以谓词逐字照抄各 Service 既有查询：
 * `plan_tasks` 用 `PlanService.list` 的 `archived=0 AND COALESCE(history_at,'')=''`，
 * `test_cases` 用 `TestCaseService.stats` 的无归档过滤口径。
 */
export function gatherSummaryBundle(period: SummaryPeriod, projectIds?: string[], custom?: CustomRange): SummaryBundle {
  const db = getDb();
  const range = periodRange(period, custom); // custom 非法时在此抛 PeriodRangeError（文案单源）
  const ids = resolveProjectIds(db, projectIds ?? []);
  // 无未归档项目时用 `1 = 0` 而不是省略条件：省略会退化成「全库计数」，把归档项目的资料算进本期
  const where = ids.length > 0 ? `AND project_id ${inClause(ids)}` : 'AND 1 = 0';
  // 范围已被 resolveProjectIds 展开成显式 ids（含「全部未归档」情形），S1 与 S2~S8 共用同一份
  const report = gatherReportData(period, ids, custom);

  const planRows = db
    .prepare(
      `SELECT title, start_date FROM plan_tasks
       WHERE archived = 0 AND COALESCE(history_at, '') = '' ${where}`,
    )
    .all(...ids) as Array<{ title: string; start_date: string | null }>;
  const dated = planRows.filter((r) => (r.start_date ?? '') !== '').length;
  const missingDateTitles = planRows.filter((r) => (r.start_date ?? '') === '').slice(0, 5).map((r) => r.title);

  const milestones = (db
    .prepare(
      `SELECT COUNT(*) AS n FROM plan_tasks
       WHERE archived = 0 AND COALESCE(history_at, '') = '' AND kind = 'milestone' ${where}`,
    )
    .get(...ids) as { n: number }).n;
  const requirements = (db
    .prepare(`SELECT COUNT(*) AS n FROM prd_requirements WHERE 1 = 1 ${where}`)
    .get(...ids) as { n: number }).n;
  const prdDocRows = db
    .prepare(`SELECT id, status FROM prd_docs WHERE 1 = 1 ${where}`)
    .all(...ids) as Array<{ id: string; status: string | null }>;
  const testCases = (db
    .prepare(`SELECT COUNT(*) AS n FROM test_cases WHERE 1 = 1 ${where}`)
    .get(...ids) as { n: number }).n;
  const estimates = (db
    .prepare(`SELECT COUNT(*) AS n FROM estimate_items WHERE 1 = 1 ${where}`)
    .get(...ids) as { n: number }).n;
  const workspaces = ids.length === 0
    ? 0
    : (db
        .prepare(
          `SELECT COUNT(*) AS n FROM projects
           WHERE id ${inClause(ids)} AND COALESCE(workspace_path, '') <> ''`,
        )
        .get(...ids) as { n: number }).n;

  return {
    period,
    periodLabel: periodLabelOf(period),
    range,
    projectIds: ids,
    projectNames: projectNamesInOrder(db, ids),
    report,
    scopeEmpty: ids.length === 0,
    plans: { total: planRows.length, dated, missingDateTitles },
    milestones,
    requirements,
    prdDocs: { total: prdDocRows.length, confirmed: prdDocRows.filter((r) => r.status === 'confirmed').length },
    testCases,
    estimates,
    workspaces,
    coverage: assessEventCoverage(range.start.getTime()),
  };
}

// ---------- 按项目拆分的事实（S3 大纲段的提示词素材，采集口径仍归本文件） ----------

export interface ProjectFacts {
  id: string;
  name: string;
  /** 任务口径来自 `report.projects`（gatherReportData 已算好，不重开 SQL） */
  tasks: { total: number; done: number; verified: number };
  plans: { total: number; overdue: number; blocked: number; doing: number };
  milestones: number;
  requirements: number;
  testCases: number;
  estimates: number;
  /** 计划标题样例（合并版大纲要能写「」指代，最多 3 条） */
  samples: string[];
}

/**
 * 逐项目事实：给 S3 大纲段拼「每项目摘要」用。
 * 任务口径**只从传入的 report 里读**（同一份 `gatherReportData` 结果），不另开活动任务 SQL；
 * 计划/里程碑逐字复用 S2 的 `archived=0` 且非 history 谓词；其余表按项目分组计数。
 * `ids` 必须是 `gatherSummaryBundle` 已展开的范围（空=没有未归档项目，直接回空数组）。
 */
export function gatherProjectFacts(period: SummaryPeriod, projectIds: string[], custom?: CustomRange, report?: ReportData): ProjectFacts[] {
  const db = getDb();
  const ids = projectIds;
  if (ids.length === 0) return [];
  const rep = report ?? gatherReportData(period, ids, custom);
  const where = `AND project_id ${inClause(ids)}`;
  const planRows = db
    .prepare(
      `SELECT project_id, title, status, end_date FROM plan_tasks
       WHERE archived = 0 AND COALESCE(history_at, '') = '' ${where}`,
    )
    .all(...ids) as Array<{ project_id: string; title: string; status: string; end_date: string | null }>;
  const milestoneRows = db
    .prepare(
      `SELECT project_id, COUNT(*) AS n FROM plan_tasks
       WHERE archived = 0 AND COALESCE(history_at, '') = '' AND kind = 'milestone' ${where}
       GROUP BY project_id`,
    )
    .all(...ids) as Array<{ project_id: string; n: number }>;
  const countBy = (sql: string) =>
    db.prepare(sql).all(...ids) as Array<{ project_id: string; n: number }>;
  const reqBy = countBy(`SELECT project_id, COUNT(*) AS n FROM prd_requirements WHERE 1 = 1 ${where} GROUP BY project_id`);
  const caseBy = countBy(`SELECT project_id, COUNT(*) AS n FROM test_cases WHERE 1 = 1 ${where} GROUP BY project_id`);
  const estBy = countBy(`SELECT project_id, COUNT(*) AS n FROM estimate_items WHERE 1 = 1 ${where} GROUP BY project_id`);
  const msBy = new Map(milestoneRows.map((r) => [r.project_id, r.n]));
  const toMap = (rows: Array<{ project_id: string; n: number }>) => new Map(rows.map((r) => [r.project_id, r.n]));
  const reqMap = toMap(reqBy);
  const caseMap = toMap(caseBy);
  const estMap = toMap(estBy);
  // report.projects 以「项目名」聚合（gatherReportData 的既有形态），这里按名字回填任务口径
  const taskByName = new Map(rep.projects.map((p) => [p.name, p]));
  const today = new Date().toISOString().slice(0, 10);
  return ids.map((id) => {
    const name = projectNamesInOrder(db, [id])[0] ?? '未命名项目';
    const t = taskByName.get(name);
    const mine = planRows.filter((r) => r.project_id === id);
    return {
      id,
      name,
      tasks: { total: t?.total ?? 0, done: t?.done ?? 0, verified: t?.verified ?? 0 },
      plans: {
        total: mine.length,
        overdue: mine.filter((r) => (r.end_date ?? '') !== '' && (r.end_date as string) < today && r.status !== 'done').length,
        blocked: mine.filter((r) => r.status === 'blocked').length,
        doing: mine.filter((r) => r.status === 'doing').length,
      },
      milestones: msBy.get(id) ?? 0,
      requirements: reqMap.get(id) ?? 0,
      testCases: caseMap.get(id) ?? 0,
      estimates: estMap.get(id) ?? 0,
      samples: mine.filter((r) => r.title).slice(0, 3).map((r) => r.title),
    };
  });
}

// ---------- 校验项构建（FR-3.1 表逐行对应） ----------

function itemS1(b: SummaryBundle): SummaryPreflightItem {
  const n = b.scopeEmpty ? 0 : b.report.tasks.length;
  return {
    key: 'S1',
    label: '周期内活动数据',
    count: n,
    hard: true,
    deepLink: 'tasks',
    status: n >= MIN_ACTIVE_TASKS ? 'ok' : 'fail',
    note:
      n >= MIN_ACTIVE_TASKS
        ? `本期 ${n} 条任务有活动（口径同周报：updated_at 落在 ${b.periodLabel} 区间）`
        : b.scopeEmpty
          ? '当前没有未归档项目（范围=全部未归档项目）——先去项目管理新建或恢复项目'
          : `${b.periodLabel}区间内没有任何任务改动记录——换更长周期，或先去「任务管理」录入并回写进展`,
  };
}

function itemS2(b: SummaryBundle): SummaryPreflightItem {
  const { total, dated, missingDateTitles } = b.plans;
  const dateOk = total >= MIN_PLAN_TASKS && rate(dated, total) >= MIN_PLAN_DATE_RATE;
  const titles = missingDateTitles.join('、');
  return {
    key: 'S2',
    label: '项目计划',
    count: total,
    hard: true,
    deepLink: 'report?card=prd-import',
    status: dateOk ? 'ok' : 'fail',
    note: dateOk
      ? `${total} 条计划，${dated} 条有起始日期（${pctText(dated, total)}%）`
      : total < MIN_PLAN_TASKS
        ? `计划仅 ${total} 条（<${MIN_PLAN_TASKS} 条无法成页）——走「从 PRD 导入项目计划」卡片批量生成`
        : `${total} 条计划中仅 ${dated} 条填了起始日期（${pctText(dated, total)}% < ${pctText(MIN_PLAN_DATE_RATE, 1)}%）——补齐这些计划的日期：${titles || '（无缺日期行）'}`,
  };
}

function itemS3(b: SummaryBundle): SummaryPreflightItem {
  const n = b.milestones;
  return {
    key: 'S3',
    label: '里程碑',
    count: n,
    hard: false,
    deepLink: 'plan',
    status: n >= MIN_MILESTONES ? 'ok' : 'warn',
    note: n >= MIN_MILESTONES
      ? `${n} 个里程碑，进展页绘制时间线`
      : '没有里程碑行（计划类型=阶段里程碑）——进展页降级为按阶段分组并在页脚注记',
  };
}

function itemS4(b: SummaryBundle): SummaryPreflightItem {
  const n = b.requirements;
  return {
    key: 'S4',
    label: '需求矩阵',
    count: n,
    hard: false,
    deepLink: 'plan?menu=matrix',
    status: n >= MIN_REQUIREMENTS ? 'ok' : 'warn',
    note: n >= MIN_REQUIREMENTS
      ? `${n} 条需求，需求页可列明细`
      : `需求矩阵仅 ${n} 条（<${MIN_REQUIREMENTS} 视为未梳理）——需求页只写统计不列表`,
  };
}

function itemS5(b: SummaryBundle): SummaryPreflightItem {
  const { total, confirmed } = b.prdDocs;
  return {
    key: 'S5',
    label: 'PRD 文档',
    count: total,
    hard: false,
    deepLink: 'plan?menu=prd',
    status: total >= MIN_PRD_DOCS ? 'ok' : 'warn',
    note:
      total >= MIN_PRD_DOCS
        ? `${total} 份原文，其中确认版 ${confirmed} 份${confirmed === 0 ? '（背景页将引用评审中文稿，建议先置为确认版）' : ''}`
        : '没有 PRD 原文——背景页降级为只写项目描述',
  };
}

function itemS6(b: SummaryBundle): SummaryPreflightItem {
  const n = b.testCases;
  return {
    key: 'S6',
    label: '测试用例',
    count: n,
    hard: false,
    deepLink: 'report?card=tc-gen',
    status: n > 0 ? 'ok' : 'warn',
    note: n > 0 ? `${n} 条用例，质量页出覆盖率与 P0~P3 分布` : '本期未建用例——质量页改文字策略',
  };
}

function itemS7(b: SummaryBundle): SummaryPreflightItem {
  const n = b.estimates;
  return {
    key: 'S7',
    label: '估算数据',
    count: n,
    hard: false,
    deepLink: 'plan',
    status: n > 0 ? 'ok' : 'warn',
    note: n > 0
      ? `${n} 行三点估算，工作量页可取估算人天`
      : '无三点估算——工作量页走 Σ duration_days 并在页脚声明「工期口径，非三点估算」',
  };
}

function itemS8(b: SummaryBundle): SummaryPreflightItem {
  const n = b.workspaces;
  return {
    key: 'S8',
    label: '工作空间',
    count: n,
    hard: false,
    deepLink: 'plan',
    status: n > 0 ? 'ok' : 'warn',
    note: n > 0 ? `${n} 个项目配置了工作空间，技术素材页可引用` : '均未配置工作空间——技术素材页省略',
  };
}

/**
 * S9 事件覆盖率：`count` 给「本期实际能被事件覆盖的天数」（`end - coveredFrom`），
 * ⚠ 时把单源脚注原样搬进 note——降级留痕的文案与「本期动态」页页脚必须是同一串（FR-3.2）。
 */
function itemS9(b: SummaryBundle): SummaryPreflightItem {
  const c = b.coverage;
  const coveredDays = Math.max(0, Math.ceil((b.range.end.getTime() - c.coveredFromMs) / DAY_MS));
  return {
    key: 'S9',
    label: '事件覆盖率',
    count: coveredDays,
    hard: false,
    // 保留期是设置项，无对应面板深链（生成面板 T02857 若需要可加「去设置」按钮）
    deepLink: '',
    status: c.ok ? 'ok' : 'warn',
    note: c.ok
      ? c.retentionDays <= 0
        ? '事件保留期已关闭清理，动态全量可覆盖'
        : `保留期 ${c.retentionDays} 天 ≥ 周期起点，本期动态完整`
      : `${c.footnote}；「本期动态」页将按此窗口降级并在页脚留痕`,
  };
}

export function buildSummaryPreflight(b: SummaryBundle): SummaryPreflightResult {
  const items: SummaryPreflightItem[] = [
    itemS1(b),
    itemS2(b),
    itemS3(b),
    itemS4(b),
    itemS5(b),
    itemS6(b),
    itemS7(b),
    itemS8(b),
    itemS9(b),
  ];
  const missingHard = items.filter((i) => i.hard && i.status === 'fail').map((i) => i.key);
  return {
    period: b.period,
    periodLabel: b.periodLabel,
    periodRange: { start: b.range.start.toISOString(), end: b.range.end.toISOString() },
    projectIds: b.projectIds,
    projectNames: b.projectNames,
    items,
    // FR-3.3：S1 ✕ 或 S2 ✕ 即阻塞（不是「全缺才阻塞」）；S9 ⚠ 永不阻塞
    blocked: missingHard.length > 0,
    missingHard,
    coverage: b.coverage,
  };
}

/**
 * 生成前硬阻塞守卫（S3 大纲与 S5 流式共用）：S1/S2 fail 时拒，绕过面板也拦得住。
 * 文案单源——两处入口各抄一份会在改阈值时漂成两句话。
 */
export function assertSummaryNotBlocked(preflight: SummaryPreflightResult): void {
  if (!preflight.blocked) return;
  throw new Error(`资料不足，不能生成总结汇报稿：${preflight.missingHard.join('、')} 缺失——请先补齐周期内活动数据与项目计划`);
}

/** 前置校验入口（端点 `GET /api/plans/summary-preflight` 的唯一被调方） */
export function summaryPreflight(period: unknown, projectIds?: string[], custom?: CustomRange): SummaryPreflightResult {
  const p = assertSummaryPeriod(period);
  const { ids, error } = validateProjectIds(projectIds);
  if (error) throw new Error(error);
  if (p === 'custom') {
    const rangeError = assertCustomRange(custom);
    if (rangeError) throw new Error(rangeError);
  }
  return buildSummaryPreflight(gatherSummaryBundle(p, ids, custom));
}
