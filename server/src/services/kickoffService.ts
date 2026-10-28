/**
 * 「项目启动会 PPT 生成」服务端（PRD-项目启动会PPT生成）。
 *
 * 施工契约见 `docs/技术方案-项目启动会PPT生成.md`：
 * - §2.1 / T02095：前置校验（FR-2）——**只读、零 AI 调用**（FR-2.3）；
 * - §3.1 / T02096：资料采集 Bundle（一次读，装配期只读）；
 * - §2.2 §3.2 / T02096：大纲生成（1 次 `askJson`）与 schema 校验（不合格即触发自带重试）。
 *
 * 校验取数一律复用各 Service 既有查询而不是自开聚合 SQL：校验值必须与页面实际条数一致
 * （PRD 验收 3），另起一套查询迟早漂移。`workloadSource` 同理取估算汇总的 `countedKeys`，
 * 不自数估算行——汇总会排除里程碑/小计等不参算角色，自数的条数与 PPT 工作量页口径必然对不上。
 */
import { statSync, readdirSync } from 'node:fs';
import { getDb } from '../db/connection';
import { dumpDiagText } from '../util/diagDump'; // T02311：失败旁证落盘（S-03：不经本服务直写文件系统）
import { PlanService } from './PlanService';
import type { PlanTaskRow, RequirementRow } from './PlanService';
import { TestCaseService } from './TestCaseService';
import { AIService } from './AIService';
import { estimatesSnapshot } from '../routes/estimates';
import { saveReportBuffer, discardReport } from './ReportService'; // T02103：生成物落盘/下载令牌单源（纠偏 C3）；T02144：放弃即回收
import { downloadSafeName } from '../util/export-name'; // T02104：下载名洗到必然过白名单
import { toManMonth, type EstimateSummary } from './estimate-engine';

type Coverage = ReturnType<typeof TestCaseService.coverage>;

// ---------- 前置校验（§2.1 · FR-2，只读零 AI） ----------

export type PreflightKey = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7';
/** ✓ / ⚠ / ✕（FR-2.2）：`warn` 是可降级继续，`fail` 是缺料 */
export type PreflightStatus = 'ok' | 'warn' | 'fail';

export interface PreflightItem {
  key: PreflightKey;
  label: string;
  /** 实际条数（面板 checklist 直接显示，与对应端点返回一致） */
  count: number;
  status: PreflightStatus;
  /** 一句「怎么补」，warn 级还要说明降级后果 */
  note: string;
  /** 前端深链：`plan?menu=*` 落项目管理面板，`report?card=*` 落 AI 工作台卡片 */
  deepLink: string;
  /** 硬缺失项（P1/P2/P3）：三项同时 fail 才整体阻塞（FR-2.4） */
  hard: boolean;
}

export interface PreflightResult {
  projectId: string;
  projectName: string;
  items: PreflightItem[];
  blocked: boolean;
  /** fail 的硬项 key，供「按钮置灰 + 点名 3 条深链」（验收 2） */
  missingHard: PreflightKey[];
  workloadSource: 'estimate' | 'duration';
}

/** FR-2.1 判定阈值单源（改这里而不是散在各项里） */
const MIN_PRD_DOCS = 1;
const MIN_REQUIREMENTS = 3; // <3 视为「未梳理」
const MIN_PLANS = 3;
const MIN_DATE_FILL_RATE = 0.6; // 起止日期填充率，低于则时间线页无法绘制
const MIN_WORKLOAD_FILL_RATE = 0.8; // 复杂度/工期非空率，低于则工作量页留降级标记

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 10;
}

/** 安全字符串化：null/undefined 出空串，对象出 JSON 文本——避免 `String(obj)` 落到「[object Object]」把脏值带进 PPT */
function asText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v) ?? '';
}

/** 与工作空间实际语义一致：路径存在且是目录才算「可引用素材」（同 `WorkspaceService.getProjectWorkspace` 的三条守卫） */
function workspaceInfo(projectId: string): { path: string | null; reason: string } {
  const row = getDb()
    .prepare('SELECT workspace_path FROM projects WHERE id = ?')
    .get(projectId) as { workspace_path: string | null } | undefined;
  const path = row?.workspace_path ?? '';
  if (!path) return { path: null, reason: '该项目未配置工作空间（项目管理 → 选择工作空间）' };
  try {
    if (!statSync(path).isDirectory()) return { path: null, reason: `工作空间路径不是目录：${path}` };
  } catch {
    return { path: null, reason: `工作空间目录不可访问（已移动或删除？）：${path}` };
  }
  return { path, reason: '' };
}

/** P1~P7 与 Bundle 的同一次读取结果（采集期只 gather 一次，装配期只读） */
interface KickoffInputs {
  projectId: string;
  projectName: string;
  docs: Array<Record<string, unknown>>;
  reqs: RequirementRow[];
  plans: PlanTaskRow[];
  milestones: PlanTaskRow[];
  cases: { total: number; linked: number; orphan: number };
  cov: Coverage;
  ws: { path: string | null; reason: string };
  summary: EstimateSummary;
}

function gatherInputs(projectId: string): KickoffInputs {
  if (!projectId) throw new Error('projectId 必填');
  const plans = PlanService.list(projectId); // 已滤归档（T00442 语义）
  return {
    projectId,
    projectName: PlanService.getProjectBrief(projectId).name,
    docs: PlanService.listPrdDocs(projectId),
    reqs: PlanService.listRequirements(projectId),
    plans,
    milestones: plans.filter((p) => p.kind === 'milestone'),
    cases: TestCaseService.stats(projectId),
    cov: TestCaseService.coverage(projectId),
    ws: workspaceInfo(projectId),
    summary: estimatesSnapshot(projectId).summary,
  };
}

/** P3/P6 填充率与 P2 关联数的中间口径（buildPreflight 拆出的局部统计，避免主函数嵌套三元膨胀） */
interface KickoffFillRates {
  dated: number;
  rated: number;
  linkedReq: number;
  assigned: number;
  dateRateOk: boolean;
  workloadRateOk: boolean;
}

function fillRatesOf(g: KickoffInputs): KickoffFillRates {
  // P3 的日期口径要起止都有：时间线按 min(start)~max(end) 线性映射，缺任一端就画不出条
  const dated = g.plans.filter((p) => !!p.start_date?.trim() && !!p.end_date?.trim()).length;
  const rated = g.plans.filter((p) => p.complexity != null || (p.duration_days ?? 0) > 0).length;
  const linkedReq = g.reqs.filter((r) => r.linkedPlans.length > 0).length;
  const dateRateOk = g.plans.length > 0 && dated / g.plans.length >= MIN_DATE_FILL_RATE;
  const workloadRateOk = g.plans.length > 0 && rated / g.plans.length >= MIN_WORKLOAD_FILL_RATE;
  return { dated, rated, linkedReq, assigned: assigneesOf(g.plans).length, dateRateOk, workloadRateOk };
}

function p3Status(planCount: number, dateRateOk: boolean): PreflightStatus {
  if (planCount < MIN_PLANS) return 'fail';
  return dateRateOk ? 'ok' : 'warn';
}

function p3Note(planCount: number, dated: number, dateRateOk: boolean, assigned: number): string {
  if (planCount < MIN_PLANS) {
    return `未归档计划仅 ${planCount} 条（<${MIN_PLANS}）——用 AI 工作台「从 PRD 导入项目计划」拆分 WBS`;
  }
  const gap = assigneeGapNote(planCount, assigned);
  if (dateRateOk) {
    return dated === planCount
      ? `${planCount} 条计划均有起止日期，时间线页按真实排期绘制${gap}`
      : `${dated}/${planCount} 条有起止日期（${pct(dated, planCount)}%，≥60%）——剩余 ${planCount - dated} 条无排期，时间线页画不出这些条${gap}`;
  }
  return `${planCount} 条计划中 ${planCount - dated} 条缺起止日期（填充率 ${pct(dated, planCount)}%，<60%）——时间线页将降级为列表，请在项目管理页补齐日期${gap}`;
}

/**
 * T02204：承担人一条不填时，预检必须把它点名为缺口。
 * 此前这里沉默，模型只能从「承担人：0 人」这句汇总里抄出一个**像结论的数**写进人员分工页——
 * 页面读起来是「本项目无承担人」，而真相是「库里没填」，二者在启动会上是两个完全不同的动作。
 * 不新增预检项（P1~P7 是页面/门/前端三处镜像的既有口径），把缺口挂在同源的 P3 文案上。
 */
function assigneeGapNote(planCount: number, assigned: number): string {
  if (planCount === 0 || assigned > 0) return '';
  return `；${planCount} 条计划均未填承担人——人员分工页按「${KICKOFF_PLACEHOLDER}」口径，别把「未填」写成「0 人」`;
}

function p5Note(total: number, cov: Coverage): string {
  if (total === 0) return '本期未建用例——覆盖率页改写「测试策略按 PRD 验收标准描述」';
  const uncoveredNote = cov.uncovered > 0 ? `（${cov.uncovered} 条需求未覆盖，页面上如实标注）` : '';
  return `${total} 条用例，需求覆盖率 ${cov.rate}%${uncoveredNote}`;
}

function p6Note(rated: number, planCount: number, workloadRateOk: boolean): string {
  if (planCount === 0) return '无计划行可校验——工作量页无数据源';
  if (workloadRateOk) {
    return `${rated}/${planCount} 条有计划数据（${pct(rated, planCount)}%），工作量页数据完整`;
  }
  return `仅 ${rated}/${planCount} 条有计划数据（${pct(rated, planCount)}%，<80%）——工作量页页脚标注「工期由排期推导，建议复核」`;
}

/** 硬缺失三项（P1/P2/P3，FR-2.4 阻塞判定口径） */
function corePreflightItems(g: KickoffInputs, r: KickoffFillRates): PreflightItem[] {
  return [
    {
      key: 'P1',
      label: 'PRD 文档',
      count: g.docs.length,
      hard: true,
      deepLink: 'plan?menu=prd',
      status: g.docs.length >= MIN_PRD_DOCS ? 'ok' : 'fail',
      note: g.docs.length >= MIN_PRD_DOCS
        ? `${g.docs.length} 份原文，背景页/技术页据此引用`
        : `还没有 PRD 原文——在「项目管理 → PRD 管理」导入，或用 AI 工作台「原始需求生成 PRD」卡片生成`,
    },
    {
      key: 'P2',
      label: '需求矩阵',
      count: g.reqs.length,
      hard: true,
      deepLink: 'plan?menu=matrix',
      status: g.reqs.length >= MIN_REQUIREMENTS ? 'ok' : 'fail',
      note: g.reqs.length >= MIN_REQUIREMENTS
        ? `${g.reqs.length} 条需求，其中 ${r.linkedReq} 条已关联计划`
        : `需求矩阵仅 ${g.reqs.length} 条（<${MIN_REQUIREMENTS} 视为未梳理）——矩阵面板可直接补录，或走「从 PRD 导入项目计划」批量提取`,
    },
    {
      key: 'P3',
      label: '项目计划',
      count: g.plans.length,
      hard: true,
      deepLink: 'report?card=prd-import',
      status: p3Status(g.plans.length, r.dateRateOk),
      note: p3Note(g.plans.length, r.dated, r.dateRateOk, r.assigned),
    },
  ];
}

/** 可降级五项（P4~P7，warn 级只留痕不阻塞） */
function supportPreflightItems(g: KickoffInputs, r: KickoffFillRates): PreflightItem[] {
  return [
    {
      key: 'P4',
      label: '里程碑',
      count: g.milestones.length,
      hard: false,
      deepLink: 'plan',
      status: g.milestones.length >= 1 ? 'ok' : 'warn',
      note: g.milestones.length >= 1
        ? `${g.milestones.length} 个里程碑，时间线页绘制菱形节点`
        : '没有里程碑行（计划类型=阶段里程碑）——时间线页降级为按日期排序的计划列表',
    },
    {
      key: 'P5',
      label: '测试用例',
      count: g.cases.total,
      hard: false,
      deepLink: 'report?card=tc-gen',
      status: g.cases.total > 0 ? 'ok' : 'warn',
      note: p5Note(g.cases.total, g.cov),
    },
    {
      key: 'P6',
      label: '复杂度/工期',
      count: r.rated,
      hard: false,
      deepLink: 'plan',
      status: r.workloadRateOk ? 'ok' : 'warn',
      note: p6Note(r.rated, g.plans.length, r.workloadRateOk),
    },
    {
      key: 'P7',
      label: '工作空间',
      count: g.ws.path ? 1 : 0,
      hard: false,
      deepLink: 'plan',
      status: g.ws.path ? 'ok' : 'warn',
      note: g.ws.path ? `${g.ws.path} 可访问，技术章节可引用其中素材` : `${g.ws.reason}——技术章节只写计划口径`,
    },
  ];
}

function buildPreflight(g: KickoffInputs): PreflightResult {
  const rates = fillRatesOf(g);
  const items: PreflightItem[] = [...corePreflightItems(g, rates), ...supportPreflightItems(g, rates)];

  const hardItems = items.filter((i) => i.hard);
  const missingHard = hardItems.filter((i) => i.status === 'fail').map((i) => i.key);
  return {
    projectId: g.projectId,
    projectName: g.projectName,
    items,
    // FR-2.4：P1+P2+P3 同时 ✕ 才阻塞（部分缺失仍可生成，页面上留痕）
    blocked: hardItems.length > 0 && missingHard.length === hardItems.length,
    missingHard,
    workloadSource: g.summary.countedKeys.length > 0 ? 'estimate' : 'duration',
  };
}

export function preflight(projectId: string): PreflightResult {
  return buildPreflight(gatherInputs(projectId));
}

// ---------- 资料采集 Bundle（§3.1） ----------

/** PRD 摘要预算：与 `util/prdContext.ts` 的保头保尾策略同口径（该常量未 export，此处单源定义，不跨模块改私有符号） */
const KICKOFF_PRD_LIMIT = 6000;
/** 风险规则：进度落后于排期推算的期望值达这个百分点才算命中（FR-4.8） */
const RISK_LAG_PP = 15;
const RISK_COMPLEXITY_MIN = 4;

export interface WorkloadStat {
  source: 'estimate' | 'duration';
  /** duration 分支没有三点，乐观/悲观如实置空，不用期望值冒充区间 */
  manDays: { expected: number; optimistic: number | null; pessimistic: number | null };
  manMonth: number;
  quote: { p50ManDays: number; p84ManDays: number } | null;
  phases: Array<{ phase: string; expected: number; rowCount: number }>;
  /** 按 plan_tasks.complexity 自行聚合（EstimateSummary 无此字段，纠偏 C2） */
  complexity: Array<{ level: string; count: number }>;
  counted: number;
  /** 页脚动态文案（验收 6） */
  footer: string;
  /** 人月换算因子（估算配置单源，页面文字与计算必须同一个数） */
  manDaysPerManMonth: number;
  /** 两种口径都取不到数（无估算行且 Σ duration_days=0）：页面出占位而不是「0 人天」 */
  noData: boolean;
  /** FR-2.2：warn 级降级必须在页面上留痕的页脚小字，不适用时为 null */
  reviewTrace: string | null;
}

/** 缺失数据的页面占位用词单源（FR-4.1：占位可见，但禁止据此编造人名/日期） */
export const KICKOFF_PLACEHOLDER = '待补充';

export interface KickoffRisk {
  item: string;
  impact: string;
  mitigation: string;
  source: string;
}

export interface KickoffBundle {
  project: { id: string; name: string; workspacePath: string };
  /** 全部 PRD 文档的轻量元数据（正文只取最新一篇，见 prdDoc） */
  prdDocs: Array<{ id: string; filename: string; updatedAt: string; contentChars: number }>;
  prdDoc: { id: string; filename: string; updatedAt: string; contentMd: string } | null;
  prdExcerpt: string;
  /** 摘要是否被截断（风险 R5，端点据此回 truncated） */
  prdTruncated: boolean;
  requirements: RequirementRow[];
  plans: PlanTaskRow[];
  milestones: PlanTaskRow[];
  coverage: { total: number; caseTotal: number; covered: number; uncovered: number; rate: number };
  assignees: Array<{ name: string; planCount: number }>;
  risks: KickoffRisk[];
  workload: WorkloadStat;
  preflight: PreflightResult;
  workspaceNote?: string;
  dataAsOf: string;
}

function trimKickoffPrd(content: string, docId: string): { text: string; truncated: boolean } {
  if (content.length <= KICKOFF_PRD_LIMIT) return { text: content, truncated: false };
  const half = Math.floor(KICKOFF_PRD_LIMIT / 2);
  return {
    text: `${content.slice(0, half)}\n\n……（中段略去 ${content.length - KICKOFF_PRD_LIMIT} 字符，全文见 PRD 文档 ${docId}）……\n\n${content.slice(-half)}`,
    truncated: true,
  };
}

function complexityDist(plans: PlanTaskRow[]): Array<{ level: string; count: number }> {
  const buckets = new Map<string, number>();
  for (const p of plans) {
    const level = p.complexity == null ? '未评定' : String(p.complexity);
    buckets.set(level, (buckets.get(level) ?? 0) + 1);
  }
  return ['1', '2', '3', '4', '5', '未评定']
    .filter((level) => buckets.has(level))
    .map((level) => ({ level, count: buckets.get(level) as number }));
}

/**
 * 工作量口径（§5 · FR-4.6）：优先估算引擎汇总，无估算行降级 Σ duration_days。
 * 降级分支排除 `kind='milestone'`——里程碑工期是其下子任务之和（T01001 二轮），
 * 一起累加会把同一批工作量算两遍，报价页数字直接翻倍。
 * P6（复杂度/工期填充率）warn 时按 FR-2.2 在页脚留痕，不允许只在 UI 提示。
 */
export function workloadOf(summary: EstimateSummary, plans: PlanTaskRow[], preflight: PreflightResult): WorkloadStat {
  const dist = complexityDist(plans);
  const p6Warn = preflight.items.find((i) => i.key === 'P6')?.status === 'warn';
  if (summary.countedKeys.length > 0) {
    const dm = summary.directManDays;
    return {
      source: 'estimate',
      manDays: { expected: dm.expected, optimistic: dm.optimistic, pessimistic: dm.pessimistic },
      manMonth: Math.round(toManMonth(dm.expected, summary.config) * 100) / 100,
      quote: { p50ManDays: summary.quote.p50ManDays, p84ManDays: summary.quote.p84ManDays },
      phases: summary.phases.map((p) => ({ phase: p.phase, expected: p.expected, rowCount: p.rowCount })),
      complexity: dist,
      counted: summary.countedKeys.length,
      manDaysPerManMonth: summary.config.manDaysPerManMonth,
      // T02156：P84 是期望×分布因子的派生量，原值直出会带 43.020620726159656 这种浮点尾巴，
      // 脚注按 1 位小数呈现；P50 与 manDays.expected 同源（验收 6 的比对值），取整不改变其值
      footer: `工作量来源：估算引擎（P50 ${Math.round(summary.quote.p50ManDays * 10) / 10} 人天 / P84 ${Math.round(summary.quote.p84ManDays * 10) / 10} 人天）`,
      noData: false,
      reviewTrace: null,
    };
  }
  const execPlans = plans.filter((p) => p.kind !== 'milestone');
  const execDays = execPlans.reduce((s, p) => s + (p.duration_days ?? 0), 0);
  // 0 人天是「没填」而不是「工作量是零」——出占位，别让读者拿 0 当结论
  const noData = execDays === 0;
  const durationReviewTrace = p6Warn ? '本页工期由排期推导，未经估算复核' : null;
  return {
    source: 'duration',
    manDays: { expected: execDays, optimistic: null, pessimistic: null },
    manMonth: noData ? 0 : Math.round(toManMonth(execDays, summary.config) * 100) / 100,
    quote: null,
    phases: [],
    complexity: dist,
    counted: execPlans.length,
    manDaysPerManMonth: summary.config.manDaysPerManMonth,
    footer: noData ? '工作量数据待补充（无估算行、计划未填工期）' : '工期口径，非三点估算',
    noData,
    reviewTrace: noData ? null : durationReviewTrace,
  };
}

/** 按起止日期线性推算的期望进度（自然日）；日期缺失/倒挂返回 null 不猜 */
function expectedProgress(p: PlanTaskRow, today: number): number | null {
  const s = Date.parse(p.start_date);
  const e = Date.parse(p.end_date);
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return null;
  return Math.round(Math.min(1, Math.max(0, (today - s) / (e - s))) * 100);
}

/** 风险条目由本地规则枚举（FR-4.8），AI 只在第 2 段改措辞——数字与事实不经模型 */
function risksOf(g: KickoffInputs, today = Date.now()): KickoffRisk[] {
  const risks: KickoffRisk[] = [];
  for (const p of g.plans.filter((x) => x.status === 'blocked')) {
    risks.push({
      item: `计划「${p.title}」当前为阻塞态`,
      impact: '该计划及其后继无法按期开工',
      mitigation: '会上明确阻塞责任方与解除时限',
      source: 'plan_tasks.status=blocked',
    });
  }
  for (const p of g.plans.filter((x) => x.kind !== 'milestone' && x.status !== 'done')) {
    const exp = expectedProgress(p, today);
    if (exp === null || exp - p.progress < RISK_LAG_PP) continue;
    risks.push({
      item: `计划「${p.title}」进度落后 ${exp - p.progress} 个百分点（实际 ${p.progress}% / 按排期应到 ${exp}%）`,
      impact: '按当前速度将延期至排期之外',
      mitigation: '确认是否压缩范围或增派人手',
      source: 'plan_tasks.progress vs 起止排期',
    });
  }
  const unlinked = g.reqs.filter((r) => r.linkedPlans.length === 0).length;
  if (unlinked > 0) {
    risks.push({
      item: `${unlinked} 条需求未关联任何计划`,
      impact: '这部分范围没有排期承载，容易漏交付',
      mitigation: '会上逐条确认纳入本期或列入范围外',
      source: 'prd_requirements.linkedPlans',
    });
  }
  const heavy = g.plans.filter((p) => (p.complexity ?? 0) >= RISK_COMPLEXITY_MIN).length;
  if (heavy > 0) {
    risks.push({
      item: `${heavy} 条计划复杂度 ≥${RISK_COMPLEXITY_MIN}`,
      impact: '单条体量偏大，估与做都易失控',
      mitigation: '按「≥4 建议拆分」口径拆到可交付粒度',
      source: 'plan_tasks.complexity',
    });
  }
  if (risks.length === 0) {
    risks.push({
      item: '系统内暂无风险信号',
      impact: '—',
      mitigation: '会上由各方补充口头风险并记录',
      source: '本地规则枚举（4 条）',
    });
  }
  return risks;
}

function assigneesOf(plans: PlanTaskRow[]): Array<{ name: string; planCount: number }> {
  const byName = new Map<string, number>();
  for (const p of plans) {
    const name = (p.assignee ?? '').trim();
    if (!name) continue;
    byName.set(name, (byName.get(name) ?? 0) + 1);
  }
  return [...byName.entries()]
    .map(([name, planCount]) => ({ name, planCount }))
    .sort((a, b) => b.planCount - a.planCount || a.name.localeCompare(b.name));
}

/** 工作空间只给顶层条目摘要（FR-4.2 素材线索），不做全量遍历 */
function workspaceNote(wsPath: string | null): string | undefined {
  if (!wsPath) return undefined;
  try {
    const names = readdirSync(wsPath, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.'))
      .slice(0, 12)
      .map((e) => `${e.name}${e.isDirectory() ? '/' : ''}`);
    return names.length ? `工作空间 ${wsPath} 顶层：${names.join('、')}` : undefined;
  } catch {
    return undefined;
  }
}

export function collectBundle(projectId: string): KickoffBundle {
  const g = gatherInputs(projectId);
  const newest = g.docs[0];
  const docId = newest ? String(newest.id) : '';
  const detail = docId ? PlanService.getPrdDoc(docId) : null;
  const contentMd = detail ? asText(detail.content_md) : '';
  const excerpt = docId ? trimKickoffPrd(contentMd, docId) : { text: '', truncated: false };
  const now = new Date();
  const pf = buildPreflight(g);
  return {
    project: { id: g.projectId, name: g.projectName, workspacePath: g.ws.path ?? '' },
    prdDocs: g.docs.map((d) => ({
      id: String(d.id),
      filename: asText(d.filename),
      updatedAt: asText(d.updated_at ?? d.created_at),
      contentChars: Number(d.content_chars ?? 0),
    })),
    prdDoc: docId
      ? { id: docId, filename: asText(detail?.filename), updatedAt: asText(detail?.updated_at), contentMd }
      : null,
    prdExcerpt: excerpt.text,
    prdTruncated: excerpt.truncated,
    requirements: g.reqs,
    plans: g.plans,
    milestones: g.milestones,
    coverage: { total: g.cov.total, caseTotal: g.cov.caseTotal, covered: g.cov.covered, uncovered: g.cov.uncovered, rate: g.cov.rate },
    assignees: assigneesOf(g.plans),
    risks: risksOf(g),
    workload: workloadOf(g.summary, g.plans, pf),
    preflight: pf,
    workspaceNote: workspaceNote(g.ws.path),
    dataAsOf: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
  };
}

// ---------- 大纲生成与校验（§2.2 §3.2） ----------

export const KICKOFF_SECTIONS = [
  '封面',
  '议程',
  '项目团队介绍',
  '项目背景',
  '项目需求',
  '项目范围',
  '项目计划',
  '工作量评估',
  '测试与质量策略',
  '项目风险',
  '沟通管理',
  '附录',
] as const;
export const KICKOFF_LAYOUTS = ['cover', 'toc', 'twoCol', 'table', 'chart', 'timeline', 'list', 'flow', 'chip', 'section', 'thanks'] as const;
export const KICKOFF_DATA_KEYS = [
  'prdDoc',
  'reqList',
  'reqStats',
  'planRows',
  'milestones',
  'coverage',
  'assignees',
  'risks',
  'workload',
  'workspace',
  'timeline',
  'preflight',
] as const;

export type KickoffLayout = (typeof KICKOFF_LAYOUTS)[number];
export type KickoffDataKey = (typeof KICKOFF_DATA_KEYS)[number];

export interface KickoffOutlineItem {
  section: string;
  title: string;
  bullets: string[];
  dataKeys: KickoffDataKey[];
  layout: KickoffLayout;
}

export interface KickoffOutlineResult {
  outline: KickoffOutlineItem[];
  truncated: boolean;
  warnings: string[];
  projectName: string;
  dataAsOf: string;
}

/** 页数 12~18（FR-3.2）；标题 ≤30 字、每条 bullet ≤42 字、每页 ≤6 条（§3.2 §4） */
const PAGE_MIN = 12;
const PAGE_MAX = 18;
const TITLE_MAX = 30;
const BULLET_MAX_CHARS = 42;
const BULLET_MAX_LINES = 6;

/**
 * 从模型输出里抠出大纲数组。不复用 `PlanComplexity.extractJson`：那个只认顶层 JSON 数组，
 * 而大纲同样常见 `{"outline":[...]}` 包装，这里两种都收（askJson 的 parse 抛错即判无效，故必须稳健）。
 */
/** 模型爱把 JSON 包进代码围栏：解析前先剥外壳（大纲段与措辞段共用） */
function stripFence(content: string): string {
  const s = content.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  return (fence ? fence[1] : s).trim();
}

/**
 * T02166：AI 常见「合规语义 + 尾逗号」输出（`{"a":1,}` / `[1,2,]`），`JSON.parse` 直抛；
 * `askJson` 温度 0 重试同一模型大概率再出同样尾巴，等于把可用的 AI 结果判成失败。
 * 这里只剥**结构位**的尾逗号（跳过字符串字面量与转义），把「解析器太严」这一类
 * 与数据无关的失败从降级路径里剔出去；真正的语义违规仍由 `wordingFromAi` 硬约束拦下。
 */
export function stripJsonTrailingCommas(raw: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      out += c;
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < raw.length && /\s/.test(raw[j])) j++;
      if (raw[j] === ']' || raw[j] === '}') continue;
    }
    out += c;
  }
  return out;
}

/**
 * T03589：模型把中文引号当 JSON 字符串分隔符（`[「总 11」「已完成 8 项」]`）。
 * 中文模型在「bullet 里用「」包裹名称」的提示词下，会把这条排版习惯外溢到结构位——
 * 结构位的 `「` 在合法 JSON 里不可能出现，故只在此处改写，字符串内部的「」原样保留。
 *
 * 顺带补「相邻值之间漏逗号」：模型连写两个引号串时（`["a""b"]`）同样非法，
 * 而合法 JSON 的字符串收尾后只可能跟 `,` `]` `}` `:`，其余一律补分隔符。
 */
export function repairChineseJsonQuotes(raw: string): { text: string; fixed: number } {
  const CLOSER: Record<string, string> = { '「': '」', '『': '』', '“': '”' };
  let out = '';
  let fixed = 0;
  let mode: 'out' | 'ascii' | 'corner' = 'out';
  let closer = '';
  // 收尾后看下一个非空白字符：只有 `,` `]` `}` `:` 是合法后继，其余补逗号
  const needComma = (at: number): boolean => {
    for (let j = at + 1; j < raw.length; j++) {
      if (/\s/.test(raw[j])) continue;
      return !',]}:'.includes(raw[j]);
    }
    return false;
  };
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (mode === 'out') {
      if (c === '"') { mode = 'ascii'; out += c; continue; }
      const cl = CLOSER[c];
      if (cl) { mode = 'corner'; closer = cl; out += '"'; fixed += 1; continue; }
      out += c;
      continue;
    }
    if (mode === 'ascii') {
      // 合法 JSON 的字符串内部可能真有「」（如 bullet 正文引用名称），此时只认 ASCII 双引号收尾；
      // 反斜杠成对消费，避免把 `\"` 的引号误判成收尾
      if (c === '\\' && i + 1 < raw.length) { out += c + raw[i + 1]; i += 1; continue; }
      out += c;
      if (c === '"') {
        mode = 'out';
        if (needComma(i)) { out += ','; fixed += 1; }
      }
      continue;
    }
    if (c === closer) {
      out += '"';
      mode = 'out';
      fixed += 1;
      if (needComma(i)) { out += ','; fixed += 1; }
      continue;
    }
    // 中文引号串内部的 ASCII 双引号是内容，必须转义；反斜杠交给 relaxIllegalEscapes 统一处置
    if (c === '"') { out += '\\"'; fixed += 1; continue; }
    out += c;
  }
  return { text: out, fixed };
}

/** 剥围栏 + 修中文引号 + 修尾逗号后的安全解析；三处 askJson parse 回调共用 */
export function parseAiJson(content: string, hits?: string[]): unknown {
  const quotes = repairChineseJsonQuotes(stripFence(content));
  noteEscapeHits(hits, quotes.fixed, 'JSON 非 ASCII 引号/漏分隔符');
  const relaxed = relaxIllegalEscapes(quotes.text);
  noteEscapeHits(hits, relaxed.fixed, 'JSON');
  return JSON.parse(stripJsonTrailingCommas(relaxed.text));
}

/**
 * T02311：白名单外非法转义的有约束清洗。模型偶发输出 `\d` / `\'` / 未双写的 `\`，
 * `JSON.parse` 直抛「Bad escaped character in JSON at position N」——而合法 JSON 的每个
 * 反斜杠后面只可能跟 `"` `\` `/` `b` `f` `n` `r` `t` `u` 七种字符。
 *
 * **必须边走边认转义态**（成对消费合法转义），不能用无状态正则：无状态正则会把我方合法的
 * `\\`（如 Windows 路径 `D:\\code`）的后半个反斜杠误判为非法——它的后一个字符是 `c`，
 * 不在白名单里——双写后反而造出 `\\\c` 这种**真非法**序列。2026-10-17 真链路 41981 轮
 * 就这么把一份合法 JSON 改崩（A-01 400「Bad escaped character at position 512」），
 * 而 41980 轮的 `\d` 是独立非法转义，两种输入对无状态正则一过一崩。
 *
 * 命中计次由调用方追 warning——不静默改写（与尾逗号修复、超长 bullet 裁剪同一口径）。
 */
export function relaxIllegalEscapes(raw: string): { text: string; fixed: number } {
  let out = '';
  let fixed = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const next = raw[i + 1];
    if (next !== undefined && '"\\/bfnrtu'.includes(next)) {
      out += c + next; // 合法转义：成对消费，不判定
      i++;
      continue;
    }
    out += '\\\\'; // 非法转义：只双写这一个反斜杠，其后字符下一轮照常判定
    fixed += 1;
  }
  return { text: out, fixed };
}

/** 清洗命中即追一条 warning（调用方传入收集数组；无数组则静默修正，供无 warning 通道的路径用） */
function noteEscapeHits(hits: string[] | undefined, fixed: number, what: string): void {
  if (fixed > 0 && hits) hits.push(`${what} 含 ${fixed} 处白名单外非法转义（如 \\d），已双写修正`);
}

/**
 * T02311：大纲失败的证据面——把厂商原始响应全文落盘到数据目录（与库同源，门与排障都能找），
 * 供事后定性「模型输出非法 vs 我方预处理改坏」。只补证据、不改行为：留档失败不阻断主流程。
 * 落盘走 util/diagDump（S-03：kickoffService 不自己碰文件系统，报告/旁证通道分立）。
 */
function dumpOutlineRaw(raw: string): string {
  return dumpDiagText('kickoff-outline-raw', raw);
}

/** 失败注记：JSON.parse 报错位置前后各 120 字符切片 + 原始响应留档文件名（parseTarget=实际送进 JSON.parse 的串） */
function outlineParseFailNote(err: unknown, parseTarget: string, raw: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  let note = '';
  const pos = /position (\d+)/.exec(msg);
  if (pos) {
    const p = Number(pos[1]);
    const from = Math.max(0, p - 120);
    note += `\n报错上下文（[${from}..${p + 120}]）：${JSON.stringify(parseTarget.slice(from, p + 120))}`;
  }
  const file = dumpOutlineRaw(raw);
  if (file) note += `\n厂商原始响应已留档：${file}（${raw.length} 字符）`;
  return note;
}

function parseOutlinePayload(content: string, hits?: string[]): unknown {
  const relaxed = relaxIllegalEscapes(stripFence(content));
  noteEscapeHits(hits, relaxed.fixed, '大纲 JSON');
  const body = relaxed.text;
  let firstErr: unknown;
  try {
    const direct = JSON.parse(stripJsonTrailingCommas(body)) as unknown;
    if (Array.isArray(direct)) return direct;
    if (direct && typeof direct === 'object' && Array.isArray((direct as { outline?: unknown }).outline)) {
      return (direct as { outline: unknown }).outline;
    }
  } catch (e) {
    firstErr = e; // 落到下面的取片断（prose 包裹数组的常见形态），两路都失败才在末尾统一注记
  }
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) {
    // 连数组括号都没有：此时第一路报错比「未找到」信息量大，带上它（含留档注记）
    throw new Error(firstErr instanceof Error
      ? `${firstErr.message}${outlineParseFailNote(firstErr, body, content)}`
      : '未找到大纲 JSON 数组');
  }
  const sliced = body.slice(start, end + 1);
  try {
    return JSON.parse(stripJsonTrailingCommas(sliced)) as unknown;
  } catch (e) {
    // 第二路也失败：以第二路报错为准（更接近真正送解析的串），注记位置上下文 + 落档原始响应
    const err = e ?? firstErr;
    throw new Error(`${err instanceof Error ? err.message : String(err)}${outlineParseFailNote(err, sliced, content)}`);
  }
}

/** dataKeys 逐项校验 + 去重（§3.2）：含未知项即硬失败，触发 askJson 自带重试 */
function dedupeDataKeys(rawKeys: unknown[], at: string): KickoffDataKey[] {
  const dataKeys: KickoffDataKey[] = [];
  for (const k of rawKeys) {
    const key = String(k);
    if (!(KICKOFF_DATA_KEYS as readonly string[]).includes(key)) {
      throw new Error(`${at} dataKeys 含未知项「${key}」（可用 ${KICKOFF_DATA_KEYS.join(' / ')}）`);
    }
    if (!dataKeys.includes(key as KickoffDataKey)) dataKeys.push(key as KickoffDataKey);
  }
  return dataKeys;
}

/**
 * 单条 bullet 超字数：首轮硬失败（模型能自己改对——42 字是提示词第 5 条的硬约束）；超行数属版式收敛走截断。
 * 重试轮仍超限（T02223）不再整稿判废——裁到上限 + 省略号收口并记 warning（同 T02172 dataKeys 口径）：
 * 真链路实测两家 agnes 工具四轮全 400 都是「单条 bullet 超出 42 字」，「有内容但写长了」不该等于「没有内容」。
 * 判据与裁剪均按码点：装配层 `checkPageText` 用 `[...b].length` 判「超出 42 字」，裁后 42 码点不再二次越界。
 */
function normalizeBulletChars(bullets: string[], at: string, warnings: string[], lenient: boolean): void {
  for (let i = 0; i < bullets.length; i++) {
    const pts = [...bullets[i]];
    if (pts.length <= BULLET_MAX_CHARS) continue;
    if (!lenient) throw new Error(`${at} 单条 bullet 超出 ${BULLET_MAX_CHARS} 字：${pts.slice(0, 20).join('')}…`);
    bullets[i] = pts.slice(0, BULLET_MAX_CHARS - 1).join('') + '…';
    warnings.push(`${at} 第 ${i + 1} 条 bullet ${pts.length} 字超出 ${BULLET_MAX_CHARS} 字，重试后仍超限，已裁剪为 ${BULLET_MAX_CHARS} 字（省略号收口）`);
  }
}

/** 章节名归一：缺失补「正文」，不在标准清单只记 warning 保留原值（不把可用大纲打死） */
function normalizeSection(rawSection: unknown, at: string, warnings: string[]): string {
  const sectionRaw = asText(rawSection).trim();
  if (!sectionRaw) {
    warnings.push(`${at} 未给章节，已补「正文」`);
    return '正文';
  }
  if (!(KICKOFF_SECTIONS as readonly string[]).includes(sectionRaw)) {
    warnings.push(`${at} 章节「${sectionRaw}」不在标准清单，保留原值`);
  }
  return sectionRaw;
}

/** 标题归一：缺失硬失败，超长截断 + 记 warning（§3.2 版式收敛口径） */
function normalizeTitle(rawTitle: unknown, at: string, warnings: string[]): string {
  const title = asText(rawTitle).trim();
  if (!title) throw new Error(`${at} 缺少标题`);
  if (title.length > TITLE_MAX) {
    warnings.push(`${at} 标题 ${title.length} 字超出 ${TITLE_MAX} 字，已截断`);
    return title.slice(0, TITLE_MAX);
  }
  return title;
}

/** 单页 schema 校验与规范化（validateOutline 的逐页体，拆出来压低认知复杂度） */
function validateOutlinePage(v: unknown, index: number, warnings: string[], lenient: boolean): KickoffOutlineItem {
  const at = `第 ${index + 1} 页`;
  if (!v || typeof v !== 'object') throw new Error(`${at} 不是对象`);
  const o = v as Record<string, unknown>;
  const layout = asText(o.layout);
  if (!(KICKOFF_LAYOUTS as readonly string[]).includes(layout)) {
    throw new Error(`${at} layout「${layout || '空'}」不在枚举（可用 ${KICKOFF_LAYOUTS.join(' / ')}）`);
  }
  const rawKeys = Array.isArray(o.dataKeys) ? o.dataKeys : [];
  const dataKeys = dedupeDataKeys(rawKeys, at);
  const rawBullets = Array.isArray(o.bullets) ? o.bullets : [];
  const bullets = rawBullets.map((b) => String(b ?? '').trim()).filter((b) => b.length > 0);
  normalizeBulletChars(bullets, at, warnings, lenient);
  if (bullets.length > BULLET_MAX_LINES) {
    warnings.push(`${at} bullet ${bullets.length} 条超出 ${BULLET_MAX_LINES} 条，已截断`);
    bullets.length = BULLET_MAX_LINES;
  }
  const section = normalizeSection(o.section, at, warnings);
  const title = normalizeTitle(o.title, at, warnings);
  // T02156：章节页/结束页是纯版式页（编号+标题/致谢），挂 dataKeys 只会被装配层忽略——
  // 这里显式清空并记 warning，让面板能看见「这页本不带数」而不是静默吃掉
  if ((layout === 'section' || layout === 'thanks') && dataKeys.length > 0) {
    warnings.push(`${at} 是${layout === 'section' ? '章节页' : '结束页'}，dataKeys 已被清空（该页只渲染编号与标题）`);
    dataKeys.length = 0;
  }
  return { section, title, bullets, dataKeys, layout: layout as KickoffLayout };
}

/**
 * schema 校验（§3.2）：在 `askJson` 的 parse 回调内逐条硬失败，不合格即抛错触发自带重试。
 * 只对「模型能自己改对」的项硬失败（页数/layout/dataKeys/bullet 字数/必含页）；
 * 标题超长、bullet 超行这类属版式收敛，规范化 + 记 warnings，不把可用大纲打死。
 *
 * `lenientDataKeys`（T02172）：提示词里「一页 dataKeys ≤2」原本是**软约束**——模型给 3 块时
 * 全靠版面兜底，于是同页图表被压到不可读（见 T02166 派生）。现在首轮按硬约束抛错走 RETRY；
 * 重试轮仍超限就不再打死整份大纲，截断为前 2 个并在 warnings 点名被去掉的键（有回执的软着陆）。
 *
 * `lenientBullets`（T02223）：同族口径——超长 bullet 首轮抛错走 RETRY，重试轮裁到 `BULLET_MAX_CHARS`
 * （省略号收口）+ warnings 点名，不再整稿判废。
 */
export function validateOutline(raw: unknown, opts: { lenientDataKeys?: boolean; lenientBullets?: boolean } = {}): { outline: KickoffOutlineItem[]; warnings: string[] } {
  if (!Array.isArray(raw)) throw new Error('大纲必须是 JSON 数组');
  if (raw.length < PAGE_MIN || raw.length > PAGE_MAX) {
    throw new Error(`页数 ${raw.length} 不在 ${PAGE_MIN}~${PAGE_MAX} 区间`);
  }
  const warnings: string[] = [];
  const outline: KickoffOutlineItem[] = raw.map((v, i) => validateOutlinePage(v, i, warnings, opts.lenientBullets === true));
  outline.forEach((p, i) => assertDataKeyBudget(p, i, outline, warnings, opts.lenientDataKeys === true));
  // 必含两页（FR-4.5 时间线 / FR-4.6 工作量）——缺任一页等于稿子不可用，硬失败让模型补齐
  if (!outline.some((p) => p.dataKeys.includes('timeline'))) throw new Error(`大纲缺少时间线页（须有一页 dataKeys 含 'timeline'）`);
  if (!outline.some((p) => p.dataKeys.includes('workload'))) throw new Error(`大纲缺少工作量页（须有一页 dataKeys 含 'workload'）`);
  return { outline, warnings };
}

/** 一页可挂的数据块上限：3 块加要点必然挤爆版面（装配层只能压扁或整块省略） */
const DATA_KEYS_MAX = 2;

/**
 * `dataKeys ≤ ${DATA_KEYS_MAX}` 的执行体。严格模式抛错（触发自带重试）；
 * 宽松模式截断——但**全稿唯一的必含键（timeline/workload）优先保留**：
 * 截断把唯一的时间线页截没了，就是用软约束制造了一次硬失败。
 */
function assertDataKeyBudget(
  page: KickoffOutlineItem,
  index: number,
  outline: KickoffOutlineItem[],
  warnings: string[],
  lenient: boolean
): void {
  if (page.dataKeys.length <= DATA_KEYS_MAX) return;
  const at = `第 ${index + 1} 页`;
  if (!lenient) {
    throw new Error(`${at} dataKeys ${page.dataKeys.length} 个超出 ${DATA_KEYS_MAX} 个上限（${page.dataKeys.join('/')}）——一页 3 块加要点会挤爆版面`);
  }
  const uniqueRequired = page.dataKeys.filter(
    (k) => (k === 'timeline' || k === 'workload') && outline.filter((q) => q.dataKeys.includes(k)).length === 1
  );
  const kept = [...uniqueRequired, ...page.dataKeys.filter((k) => !uniqueRequired.includes(k))].slice(0, DATA_KEYS_MAX);
  const dropped = page.dataKeys.filter((k) => !kept.includes(k));
  warnings.push(`${at} dataKeys ${page.dataKeys.length} 个超出 ${DATA_KEYS_MAX} 个上限，重试后仍超限，已截断为 ${kept.join('/')}（去掉：${dropped.join('/')}）`);
  page.dataKeys.length = 0;
  page.dataKeys.push(...kept);
}

// T02293：导出给验收门做**运行时取值**——门要判「样例事实段是否真被拼进提示词」，
// 只能拿到产品实际送出的那份文本；用正则读源码等于把拼接写法也锁死（判据 1）。
export const OUTLINE_SYSTEM = `你是项目启动会 PPT 的大纲编排器。只输出一个 JSON 数组，不要任何解释文字、不要代码围栏之外的内容。
数组每个元素是一页，形如 {"section":"","title":"","bullets":["",""],"dataKeys":[""],"layout":""}，约束逐条遵守：
1. 页数 ${PAGE_MIN}~${PAGE_MAX}；
2. section 只能取：${KICKOFF_SECTIONS.join(' / ')}；
3. layout 只能取：${KICKOFF_LAYOUTS.join(' / ')}；
4. dataKeys 只能取：${KICKOFF_DATA_KEYS.join(' / ')}；一页可多个，但**最多 2 个**（3 个数据块加要点必然挤爆版面，装配层只能整块省略，页面就缺内容）；
5. 每页 bullets ≤${BULLET_MAX_LINES} 条，每条 ≤${BULLET_MAX_CHARS} 字；
6. 必须至少一页 dataKeys 含 "timeline"，至少一页 dataKeys 含 "workload"；
   ⚠ 常见错误：把 layout 设成 "timeline" 但 dataKeys 里没有 "timeline" 这个键（如
   \`{layout:'timeline', dataKeys:['milestones','planRows']}\`）——这**不算**时间线页，会被判定
   「大纲缺少时间线页」整稿退回。正确写法：该页 dataKeys 必须含 "timeline" 键本身（可再带 planRows）；
7. 铁律：凡涉及条数、合计、覆盖率、日期等数字，一律只写 dataKeys 引用，由系统按库内真实数据填充——严禁自行写数字或改写数字；
8. 只依据【资料齐备性】里标注为可用的数据源，未标注可用的不要引用（引用缺失源会导致页面空壳）；
9. 页面角色（T02156 恒生模板五页面）：第 1 页 cover（封面），第 2 页 toc（目录）；
   每个大章节开始可用一页 section 作章节页（只写章节名标题，dataKeys 置空，bullets 可空）；
   最后一页用 thanks 作结束页（标题写致谢语，dataKeys 置空）；
   其余内容页按数据形态选 twoCol/table/chart/timeline/list；
   T02198 图示版式：里程碑阶段链用 layout:'flow'（dataKeys 写 milestones），人员分工标签用 layout:'chip'
   （dataKeys 写 assignees），两者各至多一页；节点与标签文字由系统按库内真值绘制，bullets 不复述阶段名与人名、不自造步骤。
10. T02166：bullets 必须引用【样例事实】里给过的具体名称（用「」包裹）；不得空写「各方配合」「相关任务有序推进」这类无指代套话。
   名称只能照抄【样例事实】里出现过的，不得自造、不得改写；数字仍归 dataKeys 覆盖，bullets 不写数字。
11. T02166：bullets 不是数据块的目录——不得写「××分布见数据」「详见下表」「计划起止时间见数据」这类只指路不自证的空指针句；
    一条要点要把一件事说完（谁/什么/处于什么状态），具体名称按第 10 条从【样例事实】照抄。
12. T02204（可机检锚点，逐页自查）：每一页的 bullets 里**至少 1 条用「」包住一个具体名称**，全稿带「」指代的 bullets 不低于 6 成——
    写不出指代的那条就是套话，删掉它或改写成人/事/状态，不要留空句占位。
    「」里只放**名称本体**（≤12 字，从【样例事实】清单项或【PRD 摘要】的模块名/术语里照抄，不得改写、不得自造）；
    不得把整段原文、代码标识符、文件路径、统计句塞进「」或塞进同一条 bullet——第 5 条每条 ≤${BULLET_MAX_CHARS} 字是硬门，
    加指代的方式是换掉句子里的废话，不是把句子加长（超长＝整页判废重来，比少一个指代严重得多）。
    「待补充」这类占位词**不计入指代配额**：只有空源页可以写它，其它页拿它凑数同样按套话处理。
    数据源为空时（【资料齐备性】标 warn/fail 的项，如未填承担人）照实写「待补充」并点名要补什么，
    不得把「没填」写成「0 人 / 0 条」这类看着像结论的数；第 7 条不变——本条不授权你写统计数字，条数/占比一律走 dataKeys。`;

const OUTLINE_SYSTEM_RETRY = `只输出 JSON 数组（${PAGE_MIN}~${PAGE_MAX} 个元素），元素：{section,title,bullets,dataKeys,layout}。
section∈[${KICKOFF_SECTIONS.join('|')}] layout∈[${KICKOFF_LAYOUTS.join('|')}] dataKeys⊆[${KICKOFF_DATA_KEYS.join('|')}]
每页 dataKeys **≤${DATA_KEYS_MAX} 个**（超出会被系统截断）；
bullets 每条≤${BULLET_MAX_CHARS}字；必须至少一页 dataKeys 含 "timeline"（只把 layout 设成 'timeline' 而 dataKeys 里没这个键不算，会被整稿退回）、至少一页 dataKeys 含 "workload"；数字一律用 dataKeys 表示，禁止编造数字。
第 1 页 cover、第 2 页 toc、末页 thanks；章节分隔用 section（dataKeys 空）；阶段链用 flow、人员标签用 chip（各至多一页）。
每页至少 1 条 bullets 用「」照抄输入里出现过的具体名称，全稿带「」指代的 bullets ≥6 成；
「」内只放 ≤12 字的名称本体（不放整段原文、路径、代码标识符），整条仍≤${BULLET_MAX_CHARS}字——放不下就删废话，别加长句子；「待补充」不计入指代配额；
空源写「待补充」，不写「0 人」这类像结论的数。`;

/** 齐备性摘要 + 真实计数：喂给模型的是口径与可用源，数字仍由装配层覆盖（FR-3.4） */
export function outlineFacts(b: KickoffBundle): string {
  const status = b.preflight.items.map((i) => `${i.key} ${i.label}=${i.count}（${i.status}）`).join('；');
  const byStatus = new Map<string, number>();
  for (const p of b.plans) byStatus.set(p.status, (byStatus.get(p.status) ?? 0) + 1);
  const priority = new Map<string, number>();
  for (const r of b.requirements) {
    const k = (r.priority ?? '').trim() || '未标注';
    priority.set(k, (priority.get(k) ?? 0) + 1);
  }
  const dates = b.plans.map((p) => p.start_date).filter(Boolean).sort((x, y) => x.localeCompare(y));
  const ends = b.plans.map((p) => p.end_date).filter(Boolean).sort((x, y) => x.localeCompare(y));
  const usable = b.preflight.items.filter((i) => i.status === 'ok').map((i) => i.key);
  const priorityFacts = [...priority.entries()].map(([k, v]) => `${k} ${v}`).join('、') || '无';
  const statusFacts = [...byStatus.entries()].map(([k, v]) => `${k} ${v}`).join('、') || '无';
  const coverageFacts = b.coverage.caseTotal
    ? `${b.coverage.caseTotal} 条用例；需求覆盖率 ${b.coverage.rate}%（已覆盖 ${b.coverage.covered}/${b.coverage.total}）`
    : '本期未建用例——覆盖率页改写测试策略口径，不出百分比结论';
  const complexityFacts = b.workload.complexity.map((c) => `${c.level}:${c.count}`).join(' ');
  const workloadTrace = b.workload.noData ? '（无估算行且计划未填工期，工作量页出占位，不要写成 0 人天）' : '';
  const assigneeNames = b.assignees.slice(0, 8).map((a) => `${a.name} ${a.planCount}条`).join('、');
  // T02204：空源不喂「承担人：0 人」。这句喂进去，模型抄出来的就是「承担人配置：0 人」——
  // 数字像结论、实为「库里没填」，真链路门 A-02a 把它判成无锚点套话是对的（它确实不指代任何事实）。
  // 改喂缺口口径后，页面写「待补充」，与装配层占位词同源（KICKOFF_PLACEHOLDER）。
  const assigneeFacts = b.assignees.length
    ? `承担人：${b.assignees.length} 人（${assigneeNames}）`
    : `承担人：${KICKOFF_PLACEHOLDER}（${b.plans.length} 条计划均未填）——人员分工页只写「承担人${KICKOFF_PLACEHOLDER}，需在项目计划行补齐」，严禁写「0 人」这类像结论的数`;
  // T02166：样例事实——把真实的名称摊给模型（仅名称，数字仍归 dataKeys 覆盖）。
  // 此前只喂汇总统计，模型只能编「各方配合到位」类套话；补需求/进行中/阻塞/已完成计划
  // 与里程碑名，让 bullets 有可指代的具体项，页面文本才和 dataKeys 表格形成呼应而不是空转。
  const clip = (s: string, n = 18) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const reqSamples = b.requirements
    .slice(0, 5)
    .map((r) => `${r.req_no ?? ''} ${clip(r.title ?? '')}`.trim())
    .filter((s) => s.length > 0);
  const doingSamples = b.plans
    .filter((p) => p.status === 'doing')
    .slice(0, 4)
    .map((p) => clip(p.title));
  const blockedSamples = b.plans
    .filter((p) => p.status === 'blocked')
    .slice(0, 3)
    .map((p) => clip(p.title));
  // T02204：补齐「已完成」一维——进度/成果页此前无名称可指代，只能写成「各模块有序推进」。
  const doneSamples = b.plans
    .filter((p) => p.status === 'done')
    .slice(0, 4)
    .map((p) => clip(p.title));
  const milestoneSamples = b.milestones.slice(0, 5).map((m) => `${clip(m.title)}（${m.end_date || KICKOFF_PLACEHOLDER}）`);
  return [
    `项目：${b.project.name}（数据截至 ${b.dataAsOf}）`,
    `资料齐备性：${status}`,
    `可用数据源（校验 ✓ 的项）：${usable.join('、') || '无'}`,
    `需求 ${b.requirements.length} 条，优先级分布：${priorityFacts}`,
    `计划 ${b.plans.length} 条（里程碑 ${b.milestones.length} 条），状态分布：${statusFacts}`,
    `排期范围：${dates[0] ?? '无'} ~ ${ends.at(-1) ?? '无'}`,
    `测试用例覆盖率：${coverageFacts}`,
    `工作量口径：${b.workload.source === 'estimate' ? '估算引擎' : '排期工期推导'}，参与行数 ${b.workload.counted}，复杂度分布 ${complexityFacts}${workloadTrace}`,
    assigneeFacts,
    `本地风险信号：${b.risks.length} 条（${b.risks.map((r) => r.item).join('；')}）`,
    `样例事实（bullets 只能引用下列名称，不得杜撰；数字仍由 dataKeys 覆盖）：` +
      `需求样例 ${reqSamples.length ? reqSamples.map((s) => `「${s}」`).join('、') : '无'}` +
      `；进行中计划 ${doingSamples.length ? doingSamples.map((s) => `「${s}」`).join('、') : '无'}` +
      `；阻塞计划 ${blockedSamples.length ? blockedSamples.map((s) => `「${s}」`).join('、') : '无'}` +
      `；已完成计划 ${doneSamples.length ? doneSamples.map((s) => `「${s}」`).join('、') : '无'}` +
      `；里程碑 ${milestoneSamples.length ? milestoneSamples.map((s) => `「${s}」`).join('、') : '无'}`,
    b.workspaceNote ?? '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * FR-2.4 服务端二次拦截：UI 置灰不是保险，绕过面板直接调用同样要拒。
 * 大纲段与生成段共用同一条口径（两处各写一遍迟早漂移）。
 */
function guardKickoffBlocked(bundle: KickoffBundle): void {
  if (!bundle.preflight.blocked) return;
  throw new Error(`资料不足，不能生成启动会稿：${bundle.preflight.missingHard.join('、')} 全部缺失——请先补齐 PRD 原文 / 需求矩阵 / 项目计划`);
}

export async function kickoffOutline(projectId: string, toolId: string, extraNote?: string): Promise<KickoffOutlineResult> {
  const bundle = collectBundle(projectId);
  guardKickoffBlocked(bundle);
  const user = `【资料齐备性与真实计数】\n${outlineFacts(bundle)}\n\n【PRD 摘要】\n${bundle.prdExcerpt || '（无 PRD 原文）'}${
    extraNote ? `\n\n【用户补充要求】\n${extraNote}` : ''
  }\n\n请按上述约束输出 ${PAGE_MIN}~${PAGE_MAX} 页的大纲 JSON 数组。`;
  // T02172：dataKeys 上限的执行时机——第 1 次解析严格（超限抛错，让 askJson 用 RETRY 提示再问一轮），
  // 第 2 次解析起转软（截断 + warning 点名）。用解析回调的调用次数当轮次，不去改 askJson 的通用重试协议。
  let parseRound = 0;
  // T02311：清洗命中与失败留档的证据收集数组（跨 askJson 两次尝试累计；成功路径转 warnings，失败路径已拼进错误文本）
  const cleanHits: string[] = [];
  const ai = await AIService.askJson<{ outline: KickoffOutlineItem[]; warnings: string[] }>(
    toolId,
    OUTLINE_SYSTEM,
    user,
    (content) => {
      parseRound++;
      try {
        return validateOutline(parseOutlinePayload(content, cleanHits), { lenientDataKeys: parseRound > 1, lenientBullets: parseRound > 1 });
      } catch (e) {
        // T02311：schema 类失败（页码/缺页/超长未收窄）同样留档原始响应——「模型到底输出了什么」
        // 是定性的一半证据；parse 类失败已在 parseOutlinePayload 内注记（含位置切片），不重复落档。
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('厂商原始响应已留档')) throw e;
        const file = dumpOutlineRaw(content);
        throw new Error(file ? `${msg}\n厂商原始响应已留档：${file}（${content.length} 字符）` : msg);
      }
    },
    {
      retrySystem: OUTLINE_SYSTEM_RETRY,
      // T02314：把首轮具体违规原因原样回喂给模型——「大纲缺少时间线页（须有一页 dataKeys 含
      // 'timeline'）」比静态精简提示词更能让它改对（真链路 41981/41982/41983 三轮连续栽在
      // 「用了 timeline 版式但没放 timeline 数据键」，静态重试提示词已声明过该要求仍不遵守）。
      retrySystemFromError: (lastError) => `${OUTLINE_SYSTEM_RETRY}\n\n【上一轮输出被拒的原因，必须逐条修正后重新输出】\n${lastError}`,
      temperature: 0,
    },
  );
  if (!ai.ok || ai.data === undefined) throw new Error(`AI 未返回合规大纲：${ai.error ?? '未知原因'}`);
  const warnings = [...ai.data.warnings];
  for (const hit of new Set(cleanHits)) warnings.push(hit);
  if (bundle.prdTruncated) warnings.push(`PRD 摘要超出 ${KICKOFF_PRD_LIMIT} 字已保头保尾截断（全文见 PRD 文档 ${bundle.prdDoc?.id ?? ''}）`);
  if (ai.retried) warnings.push('首轮大纲不合 schema，已自动重试 1 次后通过');
  return {
    outline: ai.data.outline,
    truncated: bundle.prdTruncated,
    warnings,
    projectName: bundle.project.name,
    dataAsOf: bundle.dataAsOf,
  };
}

// ---------- 流式生成（§2.3 · T02103） ----------

/** 装配中途收手时抛出的消息（builder 与 service 单源：SSE `error`、门禁断言、面板提示都认这句） */
export const KICKOFF_ABORT_MSG = '启动会稿装配已中止（客户端断开或用户取消）';
/** 第 2 段措辞润色失败的降级告警用词（技术方案 §2.3 逐字；面板据此说明「稿子仍出了，风险页用的是本地条目」） */
export const KICKOFF_WORDING_FALLBACK_MSG = '风险措辞 AI 失败，已用本地条目';

const RISK_ITEM_MAX = 60;
const RISK_IMPACT_MAX = 40;
const RISK_MITIGATION_MAX = 40;
/** 用户可编辑后送进来的页数上限：只兜「明显失控」，12~18 的编排铁律属大纲段（validateOutline） */
const OUTLINE_PAGE_MAX = 40;

const WORDING_SYSTEM = `你是项目启动会的会议主持稿撰写人。输入全部是系统按本地规则从库里取出的事实（风险条目、沟通口径），你只做一件事：把它们改写成会上好念、客户好懂的表述。
硬性约束（违反任意一条即视为无效）：
1. 条目数量与顺序必须与输入完全一致；不得新增、删除、合并、调序；输入没给的清单就回空数组 []。
2. 数字（条数、百分比、复杂度值）必须逐字沿用输入里出现过的，严禁新增输入里没有的数字——数字由系统从库里取，不由你写。
3. 「」内的计划名/需求名只能照抄输入里出现过的，不得改写、不得另起名字。
4. 长度上限：风险 item ≤60 字、impact ≤40 字、mitigation ≤40 字；沟通口径每条 ≤42 字。
5. 统一简体中文；不要「可能/大概/据了解」这类推责话术，也不要替客户下结论。
6. 只输出一个 JSON：{"risks":[{"item":"…","impact":"…","mitigation":"…"}],"comms":["…"]}，不要代码围栏之外的解释文字。source（数据出处）由系统保留，不要输出。`;

/** 措辞润色的入参与落点：风险页取 bundle.risks，沟通页取那一页大纲自己的 bullets（两处都有页面归宿，不造没落点的字段） */
export interface KickoffWordingLocal {
  risks: KickoffRisk[];
  comms: string[];
}

export interface KickoffWording {
  risks: KickoffRisk[];
  comms: string[];
}

function numbersOf(s: string): string[] {
  return s.match(/\d+(?:\.\d+)?/g) ?? [];
}

function quotedOf(s: string): string[] {
  return s.match(/「[^」]*」/g) ?? [];
}

/** 单字段回锁：非空 + 长度 + 数字白名单 + 「」名称白名单（池=该条本地原文） */
function pinField(v: unknown, pool: string, maxLen: number, label: string): string {
  if (typeof v !== 'string') throw new Error(`${label} 必须是字符串`);
  const s = v.trim();
  if (!s) throw new Error(`${label} 为空`);
  const len = [...s].length;
  if (len > maxLen) throw new Error(`${label} 超 ${maxLen} 字（实际 ${len}）`);
  for (const n of numbersOf(s)) {
    if (!numbersOf(pool).includes(n)) throw new Error(`${label} 出现系统数据里没有的数字「${n}」`);
  }
  // T02204：名称白名单按去空白比对。系统自己的本地文案里也带「」术语（如「≥4 建议拆分」），
  // 模型照抄时吞掉那个空格是排版抖动，不是编造——按字面比对时它每次都判「出现系统数据里没有的
  // 名称」并整段回退本地条目，风险页的措辞润色等于没做。名称本体不同照样咬（幽灵模块）。
  const poolFlat = pool.replace(/\s+/g, '');
  for (const q of quotedOf(s)) {
    if (!poolFlat.includes(q.replace(/\s+/g, ''))) throw new Error(`${label} 出现系统数据里没有的名称 ${q}`);
  }
  return s;
}

/**
 * 把模型改写回来的措辞钉回本地事实（纯函数，门禁 W 组逐条断言）：
 * 条目数与顺序必须一致（AI 增删风险＝替客户改结论），数字与「」名称必须在本地池里出现过，
 * `source` 一律保留本地值——溯源是「这条数字从哪张表来的」，不是措辞，不经模型（FR-3.4 / R4）。
 */
export function wordingFromAi(local: KickoffWordingLocal, raw: unknown): KickoffWording {
  const o = (raw ?? {}) as Record<string, unknown>;
  const listOf = (v: unknown, expectLen: number, key: string): unknown[] => {
    if (v == null) {
      if (expectLen === 0) return [];
      throw new Error(`缺 ${key} 数组（本次需要 ${expectLen} 条）`);
    }
    if (!Array.isArray(v)) throw new Error(`${key} 必须是数组`);
    return v;
  };
  const rawRisks = listOf(o.risks, local.risks.length, 'risks');
  const rawComms = listOf(o.comms, local.comms.length, 'comms');
  if (rawRisks.length !== local.risks.length) {
    throw new Error(`风险条目数 ${rawRisks.length} 与系统枚举的 ${local.risks.length} 不一致（不得增删、不得合并）`);
  }
  if (rawComms.length !== local.comms.length) {
    throw new Error(`沟通口径条数 ${rawComms.length} 与系统给出的 ${local.comms.length} 不一致（不得增删）`);
  }
  const risks = local.risks.map((r, i) => {
    const row = (rawRisks[i] ?? {}) as Record<string, unknown>;
    const pool = `${r.item} ${r.impact} ${r.mitigation} ${r.source}`;
    const no = `第 ${i + 1} 条风险`;
    return {
      item: pinField(row.item, pool, RISK_ITEM_MAX, `${no} item`),
      impact: pinField(row.impact, pool, RISK_IMPACT_MAX, `${no} impact`),
      mitigation: pinField(row.mitigation, pool, RISK_MITIGATION_MAX, `${no} mitigation`),
      source: r.source,
    };
  });
  const commPool = local.comms.join(' ');
  const comms = local.comms.map((_, i) => pinField(rawComms[i], commPool, BULLET_MAX_CHARS, `第 ${i + 1} 条沟通口径`));
  return { risks, comms };
}

/** 大纲形状校验：入参是用户在面板上编辑过的 JSON，不校验就是把 undefined 送进装配器 */
export function assertOutlineShape(raw: unknown): KickoffOutlineItem[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('outline 必须是非空数组（请先在面板确认大纲）');
  if (raw.length > OUTLINE_PAGE_MAX) throw new Error(`大纲页数 ${raw.length} 超出上限 ${OUTLINE_PAGE_MAX} 页`);
  return raw.map((it, i) => {
    const pageNo = i + 1;
    const o = (it ?? {}) as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    if (!title) throw new Error(`第 ${pageNo} 页缺标题（title）`);
    if (typeof o.layout !== 'string' || !KICKOFF_LAYOUTS.includes(o.layout as KickoffLayout)) {
      throw new Error(`第 ${pageNo} 页版式「${String(o.layout)}」不在枚举（${KICKOFF_LAYOUTS.join(' / ')}）`);
    }
    if (!Array.isArray(o.dataKeys)) throw new Error(`第 ${pageNo} 页缺 dataKeys 数组`);
    for (const k of o.dataKeys) {
      if (typeof k !== 'string' || !KICKOFF_DATA_KEYS.includes(k as KickoffDataKey)) {
        throw new Error(`第 ${pageNo} 页含未知数据键「${String(k)}」（可用：${KICKOFF_DATA_KEYS.join(' / ')}）`);
      }
    }
    if (o.bullets != null && !Array.isArray(o.bullets)) throw new Error(`第 ${pageNo} 页 bullets 必须是数组`);
    const bullets = (Array.isArray(o.bullets) ? o.bullets : []).map((x, bi) => {
      if (typeof x !== 'string') throw new Error(`第 ${pageNo} 页第 ${bi + 1} 条要点不是字符串`);
      return x.trim();
    }).filter(Boolean);
    const section = typeof o.section === 'string' && o.section.trim() ? o.section.trim() : '正文';
    return { section, title, bullets, dataKeys: o.dataKeys as KickoffDataKey[], layout: o.layout as KickoffLayout };
  });
}

/** 下载名（§2.4）；非法字符清洗与下载端点接线归 T02104，本层只定前后缀与日期形态 */
export function kickoffFileName(projectName: string, dataAsOf: string): string {
  // 洗到必然通过下载白名单（T02104）：项目名里的 `&`「（）」等字符若原样拼进文件名，
  // `report/ai-download` 会整体回退成 `MTask-ai-report.xlsx`——用户点 pptx 却拿到 xlsx 名，且无人报错。
  const safeBase = `项目启动会-${projectName}-${dataAsOf.replaceAll('-', '')}`;
  return `${downloadSafeName(safeBase, '项目启动会')}.pptx`;
}

function wordingUserPrompt(local: KickoffWordingLocal, projectName: string): string {
  const riskBlock = local.risks.length
    ? local.risks.map((r, i) => `${i + 1}. 风险：${r.item}\n   影响：${r.impact}\n   应对：${r.mitigation}\n   出处：${r.source}`).join('\n')
    : '（本次未提供风险清单）';
  const commBlock = local.comms.length ? local.comms.map((c, i) => `${i + 1}. ${c}`).join('\n') : '（本次未提供沟通口径）';
  // T02823：契约键（AP57 防护）。仅追加一行，不改上方任何中文指令——LLM 仍按「条数分别为 N 与 M」输出；
  // 本行供自动化验收门(mock)稳定读取条数，不再依赖解析「风险：」/「【沟通口径」等易随措辞重构而漂移的中文形态。
  // 版本号 v1 即契约标识：格式若变则升 v2 并同步四门正则，禁止静默改写既有门。
  const contractKey = `【契约键·kickoff-wording·v1】risks=${local.risks.length} comms=${local.comms.length}`;
  return [
    `【项目】${projectName}`,
    `【风险条目（系统按本地规则枚举，事实与数字不可改）】\n${riskBlock}`,
    `【沟通口径（来自大纲的沟通管理页）】\n${commBlock}`,
    `请按约束输出 {"risks":[${local.risks.length ? '…' : ''}],"comms":[${local.comms.length ? '…' : ''}]}，条数分别为 ${local.risks.length} 与 ${local.comms.length}。`,
    contractKey,
  ].join('\n\n');
}

/** 沟通管理页：AI 措辞的第二个落点（FR-4.9「协作口径由 AI 生成」），没有这页就不索要 comms */
function commPageOf(outline: KickoffOutlineItem[]): number {
  return outline.findIndex((o) => /沟通|协作/.test(`${o.section}${o.title}`));
}

/** 这次大纲是否需要第 2 段措辞：既无风险页也无沟通页就别烧配额 */
function needsWording(outline: KickoffOutlineItem[], commIdx: number): boolean {
  return outline.some((o) => o.dataKeys.includes('risks') || /风险/.test(`${o.section}${o.title}`)) || commIdx >= 0;
}

/** 第 2 段 AI（风险/沟通措辞）：一次 askJson；任何失败都不阻断生成，回本地条目并如实记 warning */
async function polishWording(
  bundle: KickoffBundle,
  toolId: string,
  local: KickoffWordingLocal,
  warnings: string[],
  signal?: AbortSignal,
): Promise<KickoffWording> {
  const fallback = (): KickoffWording => ({ risks: bundle.risks, comms: local.comms });
  try {
    const ai = await AIService.askJson<KickoffWording>(
      toolId,
      WORDING_SYSTEM,
      wordingUserPrompt(local, bundle.project.name),
      // T02166：走带尾逗号修复的统一解析器——此前直接 JSON.parse(stripFence(...)) 会把
      // 「AI 语义合规但输出尾逗号」判成解析失败，风险页永远走本地条目（本地条目措辞偏生硬）
      (content) => wordingFromAi(local, parseAiJson(content)),
      // T02141：带上 signal——客户端断开时本轮不再等完整响应、也不重试（此前只在下一次 await 后收手，配额已烧）
      { temperature: 0, signal },
    );
    if (!ai.ok || ai.data === undefined) {
      warnings.push(`${KICKOFF_WORDING_FALLBACK_MSG}（原因：${ai.error ?? '未知'}）`);
      return fallback();
    }
    if (ai.retried) warnings.push('风险/沟通措辞首轮不合约束，已自动重试 1 次后通过');
    return ai.data;
  } catch (e) {
    // runtimeWithModel 在工具未配 model 时同步抛错：同样只降级，不让措辞把整份稿拖死
    warnings.push(`${KICKOFF_WORDING_FALLBACK_MSG}（原因：${e instanceof Error ? e.message : String(e)}）`);
    return fallback();
  }
}

export interface KickoffStreamResult {
  token: string;
  fileName: string;
  pageCount: number;
  warnings: string[];
}

/**
 * 启动会 PPT 流式生成（§2.3）：采集 → 第 2 段措辞 → 逐页装配（每页一条 `stage`）→ 落盘换令牌。
 * 中止语义（验收 9）：`signal` 命中即抛错收手，全程只有一个落盘点（令牌），
 * 所以断连/取消后临时目录里不会有任何半成品或孤儿令牌。
 */
export async function kickoffPptStream(
  projectId: string,
  toolId: string,
  rawOutline: unknown,
  onStage: (msg: string) => void,
  signal?: AbortSignal,
): Promise<KickoffStreamResult> {
  const outline = assertOutlineShape(rawOutline);
  onStage('正在采集启动会资料…');
  const bundle = collectBundle(projectId);
  guardKickoffBlocked(bundle);
  if (signal?.aborted) throw new Error(KICKOFF_ABORT_MSG);
  onStage(
    `已采集：需求 ${bundle.requirements.length} 条 / 计划 ${bundle.plans.length} 条 / 里程碑 ${bundle.milestones.length} 个，` +
      `风险 ${bundle.risks.length} 条`,
  );

  const warnings: string[] = [];
  if (bundle.prdTruncated) warnings.push(`PRD 摘要超出 ${KICKOFF_PRD_LIMIT} 字已保头保尾截断（全文见 PRD 文档 ${bundle.prdDoc?.id ?? ''}）`);

  const commIdx = commPageOf(outline);
  let built = { outline, risks: bundle.risks };
  if (needsWording(outline, commIdx)) {
    const local: KickoffWordingLocal = {
      risks: outline.some((o) => o.dataKeys.includes('risks') || /风险/.test(`${o.section}${o.title}`)) ? bundle.risks : [],
      comms: commIdx < 0 ? [] : outline[commIdx].bullets,
    };
    onStage(`风险/沟通措辞润色中（条目 ${local.risks.length} + ${local.comms.length}）…`);
    const w = await polishWording(bundle, toolId, local, warnings, signal);
    // 兜底收手：abort 也可能落在「模型已回、尚未画页」的窗口里；T02141 后模型等待期本身也能被 abort 掐断
    if (signal?.aborted) throw new Error(KICKOFF_ABORT_MSG);
    built = {
      outline: outline.map((o, i) => (i === commIdx && w.comms.length === o.bullets.length ? { ...o, bullets: w.comms } : o)),
      risks: local.risks.length ? w.risks : bundle.risks,
    };
  } else {
    onStage('大纲没有风险页与沟通页，跳过措辞润色（不消耗模型配额）。');
  }

  const { buildKickoffPpt, expandTimelinePages } = await import('./kickoffBuilder'); // 动态加载：builder 静态引用本模块常量，两侧都静态 import 会成环
  const bundleForBuild = { ...bundle, risks: built.risks };
  // T02171：计划排不下一页会展开成续页——进度按真实渲染页数计，否则出现「页 12/11」
  const renderTotal = expandTimelinePages(bundleForBuild, built.outline).length;
  onStage(`开始逐页装配 ${renderTotal} 页…`);
  const assembled = await buildKickoffPpt(bundleForBuild, built.outline, {
    onPage: (pageNo, item) => onStage(`页 ${pageNo}/${renderTotal} 已装配：${item.section}`),
    signal,
  });
  const token = saveReportBuffer(assembled.buffer);
  // T02144：中止恰好落在「已落盘、尚未回报」的窗口时，done 事件不会再有人接收，令牌随前端状态归零丢失
  //  → 立刻回收，不给 DATA_DIR/tmp 留孤儿（启动/每小时清扫是兜底，这里是最早的收口点）
  if (signal?.aborted) {
    discardReport(token);
    throw new Error(KICKOFF_ABORT_MSG);
  }
  onStage('文件已生成，可在左侧下载。');
  return {
    token,
    fileName: kickoffFileName(bundle.project.name, bundle.dataAsOf),
    pageCount: assembled.pageCount,
    warnings: [...warnings, ...assembled.warnings],
  };
}
