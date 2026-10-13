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
import { PlanService } from './PlanService';
import type { PlanTaskRow, RequirementRow } from './PlanService';
import { TestCaseService } from './TestCaseService';
import { AIService } from './AIService';
import { estimatesSnapshot } from '../routes/estimates';
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

function buildPreflight(g: KickoffInputs): PreflightResult {
  // P3 的日期口径要起止都有：时间线按 min(start)~max(end) 线性映射，缺任一端就画不出条
  const dated = g.plans.filter((p) => !!p.start_date?.trim() && !!p.end_date?.trim()).length;
  const rated = g.plans.filter((p) => p.complexity != null || (p.duration_days ?? 0) > 0).length;
  const linkedReq = g.reqs.filter((r) => r.linkedPlans.length > 0).length;
  const dateRateOk = g.plans.length > 0 && dated / g.plans.length >= MIN_DATE_FILL_RATE;
  const workloadRateOk = g.plans.length > 0 && rated / g.plans.length >= MIN_WORKLOAD_FILL_RATE;

  const items: PreflightItem[] = [
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
        ? `${g.reqs.length} 条需求，其中 ${linkedReq} 条已关联计划`
        : `需求矩阵仅 ${g.reqs.length} 条（<${MIN_REQUIREMENTS} 视为未梳理）——矩阵面板可直接补录，或走「从 PRD 导入项目计划」批量提取`,
    },
    {
      key: 'P3',
      label: '项目计划',
      count: g.plans.length,
      hard: true,
      deepLink: 'report?card=prd-import',
      status: g.plans.length < MIN_PLANS ? 'fail' : dateRateOk ? 'ok' : 'warn',
      note:
        g.plans.length < MIN_PLANS
          ? `未归档计划仅 ${g.plans.length} 条（<${MIN_PLANS}）——用 AI 工作台「从 PRD 导入项目计划」拆分 WBS`
          : !dateRateOk
            ? `${g.plans.length} 条计划中 ${g.plans.length - dated} 条缺起止日期（填充率 ${pct(dated, g.plans.length)}%，<60%）——时间线页将降级为列表，请在项目管理页补齐日期`
            : dated === g.plans.length
              ? `${g.plans.length} 条计划均有起止日期，时间线页按真实排期绘制`
              : `${dated}/${g.plans.length} 条有起止日期（${pct(dated, g.plans.length)}%，≥60%）——剩余 ${g.plans.length - dated} 条无排期，时间线页画不出这些条`,
    },
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
      note:
        g.cases.total === 0
          ? '本期未建用例——覆盖率页改写「测试策略按 PRD 验收标准描述」'
          : `${g.cases.total} 条用例，需求覆盖率 ${g.cov.rate}%${g.cov.uncovered > 0 ? `（${g.cov.uncovered} 条需求未覆盖，页面上如实标注）` : ''}`,
    },
    {
      key: 'P6',
      label: '复杂度/工期',
      count: rated,
      hard: false,
      deepLink: 'plan',
      status: workloadRateOk ? 'ok' : 'warn',
      note:
        g.plans.length === 0
          ? '无计划行可校验——工作量页无数据源'
          : workloadRateOk
            ? `${rated}/${g.plans.length} 条有计划数据（${pct(rated, g.plans.length)}%），工作量页数据完整`
            : `仅 ${rated}/${g.plans.length} 条有计划数据（${pct(rated, g.plans.length)}%，<80%）——工作量页页脚标注「工期由排期推导，建议复核」`,
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
}

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
  coverage: { total: number; covered: number; uncovered: number; rate: number };
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
 */
function workloadOf(summary: EstimateSummary, plans: PlanTaskRow[]): WorkloadStat {
  const dist = complexityDist(plans);
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
      footer: `工作量来源：估算引擎（P50 ${summary.quote.p50ManDays} 人天 / P84 ${summary.quote.p84ManDays} 人天）`,
    };
  }
  const execDays = plans.filter((p) => p.kind !== 'milestone').reduce((s, p) => s + (p.duration_days ?? 0), 0);
  return {
    source: 'duration',
    manDays: { expected: execDays, optimistic: null, pessimistic: null },
    manMonth: Math.round(toManMonth(execDays, summary.config) * 100) / 100,
    quote: null,
    phases: [],
    complexity: dist,
    counted: plans.filter((p) => p.kind !== 'milestone').length,
    footer: '工期口径，非三点估算',
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
  const contentMd = detail ? String(detail.content_md ?? '') : '';
  const excerpt = docId ? trimKickoffPrd(contentMd, docId) : { text: '', truncated: false };
  const now = new Date();
  return {
    project: { id: g.projectId, name: g.projectName, workspacePath: g.ws.path ?? '' },
    prdDocs: g.docs.map((d) => ({
      id: String(d.id),
      filename: String(d.filename ?? ''),
      updatedAt: String(d.updated_at ?? d.created_at ?? ''),
      contentChars: Number(d.content_chars ?? 0),
    })),
    prdDoc: docId
      ? { id: docId, filename: String(detail?.filename ?? ''), updatedAt: String(detail?.updated_at ?? ''), contentMd }
      : null,
    prdExcerpt: excerpt.text,
    prdTruncated: excerpt.truncated,
    requirements: g.reqs,
    plans: g.plans,
    milestones: g.milestones,
    coverage: { total: g.cov.total, covered: g.cov.covered, uncovered: g.cov.uncovered, rate: g.cov.rate },
    assignees: assigneesOf(g.plans),
    risks: risksOf(g),
    workload: workloadOf(g.summary, g.plans),
    preflight: buildPreflight(g),
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
export const KICKOFF_LAYOUTS = ['cover', 'toc', 'twoCol', 'table', 'chart', 'timeline', 'list'] as const;
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
function parseOutlinePayload(content: string): unknown {
  const s = content.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  const body = (fence ? fence[1] : s).trim();
  try {
    const direct = JSON.parse(body) as unknown;
    if (Array.isArray(direct)) return direct;
    if (direct && typeof direct === 'object' && Array.isArray((direct as { outline?: unknown }).outline)) {
      return (direct as { outline: unknown }).outline;
    }
  } catch {
    /* 落到下面的取片断 */
  }
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('未找到大纲 JSON 数组');
  return JSON.parse(body.slice(start, end + 1)) as unknown;
}

/**
 * schema 校验（§3.2）：在 `askJson` 的 parse 回调内逐条硬失败，不合格即抛错触发自带重试。
 * 只对「模型能自己改对」的项硬失败（页数/layout/dataKeys/bullet 字数/必含页）；
 * 标题超长、bullet 超行这类属版式收敛，规范化 + 记 warnings，不把可用大纲打死。
 */
export function validateOutline(raw: unknown): { outline: KickoffOutlineItem[]; warnings: string[] } {
  if (!Array.isArray(raw)) throw new Error('大纲必须是 JSON 数组');
  if (raw.length < PAGE_MIN || raw.length > PAGE_MAX) {
    throw new Error(`页数 ${raw.length} 不在 ${PAGE_MIN}~${PAGE_MAX} 区间`);
  }
  const warnings: string[] = [];
  const outline: KickoffOutlineItem[] = raw.map((v, i) => {
    const at = `第 ${i + 1} 页`;
    if (!v || typeof v !== 'object') throw new Error(`${at} 不是对象`);
    const o = v as Record<string, unknown>;
    const layout = String(o.layout ?? '');
    if (!(KICKOFF_LAYOUTS as readonly string[]).includes(layout)) {
      throw new Error(`${at} layout「${layout || '空'}」不在枚举（可用 ${KICKOFF_LAYOUTS.join(' / ')}）`);
    }
    const rawKeys = Array.isArray(o.dataKeys) ? o.dataKeys : [];
    const dataKeys: KickoffDataKey[] = [];
    for (const k of rawKeys) {
      const key = String(k);
      if (!(KICKOFF_DATA_KEYS as readonly string[]).includes(key)) {
        throw new Error(`${at} dataKeys 含未知项「${key}」（可用 ${KICKOFF_DATA_KEYS.join(' / ')}）`);
      }
      if (!dataKeys.includes(key as KickoffDataKey)) dataKeys.push(key as KickoffDataKey);
    }
    const rawBullets = Array.isArray(o.bullets) ? o.bullets : [];
    const bullets = rawBullets.map((b) => String(b ?? '').trim()).filter((b) => b.length > 0);
    for (const b of bullets) {
      if (b.length > BULLET_MAX_CHARS) throw new Error(`${at} 单条 bullet 超出 ${BULLET_MAX_CHARS} 字：${b.slice(0, 20)}…`);
    }
    if (bullets.length > BULLET_MAX_LINES) {
      warnings.push(`${at} bullet ${bullets.length} 条超出 ${BULLET_MAX_LINES} 条，已截断`);
      bullets.length = BULLET_MAX_LINES;
    }
    const sectionRaw = String(o.section ?? '').trim();
    if (!sectionRaw) warnings.push(`${at} 未给章节，已补「正文」`);
    else if (!(KICKOFF_SECTIONS as readonly string[]).includes(sectionRaw)) warnings.push(`${at} 章节「${sectionRaw}」不在标准清单，保留原值`);
    const section = sectionRaw || '正文';
    let title = String(o.title ?? '').trim();
    if (!title) throw new Error(`${at} 缺少标题`);
    if (title.length > TITLE_MAX) {
      warnings.push(`${at} 标题 ${title.length} 字超出 ${TITLE_MAX} 字，已截断`);
      title = title.slice(0, TITLE_MAX);
    }
    return { section, title, bullets, dataKeys, layout: layout as KickoffLayout };
  });
  // 必含两页（FR-4.5 时间线 / FR-4.6 工作量）——缺任一页等于稿子不可用，硬失败让模型补齐
  if (!outline.some((p) => p.dataKeys.includes('timeline'))) throw new Error(`大纲缺少时间线页（须有一页 dataKeys 含 'timeline'）`);
  if (!outline.some((p) => p.dataKeys.includes('workload'))) throw new Error(`大纲缺少工作量页（须有一页 dataKeys 含 'workload'）`);
  return { outline, warnings };
}

const OUTLINE_SYSTEM = `你是项目启动会 PPT 的大纲编排器。只输出一个 JSON 数组，不要任何解释文字、不要代码围栏之外的内容。
数组每个元素是一页，形如 {"section":"","title":"","bullets":["",""],"dataKeys":[""],"layout":""}，约束逐条遵守：
1. 页数 ${PAGE_MIN}~${PAGE_MAX}；
2. section 只能取：${KICKOFF_SECTIONS.join(' / ')}；
3. layout 只能取：${KICKOFF_LAYOUTS.join(' / ')}；
4. dataKeys 只能取：${KICKOFF_DATA_KEYS.join(' / ')}；一页可多个；
5. 每页 bullets ≤${BULLET_MAX_LINES} 条，每条 ≤${BULLET_MAX_CHARS} 字；
6. 必须至少一页 dataKeys 含 "timeline"，至少一页 dataKeys 含 "workload"；
7. 铁律：凡涉及条数、合计、覆盖率、日期等数字，一律只写 dataKeys 引用，由系统按库内真实数据填充——严禁自行写数字或改写数字；
8. 只依据【资料齐备性】里标注为可用的数据源，未标注可用的不要引用（引用缺失源会导致页面空壳）。`;

const OUTLINE_SYSTEM_RETRY = `只输出 JSON 数组（${PAGE_MIN}~${PAGE_MAX} 个元素），元素：{section,title,bullets,dataKeys,layout}。
section∈[${KICKOFF_SECTIONS.join('|')}] layout∈[${KICKOFF_LAYOUTS.join('|')}] dataKeys⊆[${KICKOFF_DATA_KEYS.join('|')}]
bullets 每条≤${BULLET_MAX_CHARS}字；必须有含 timeline 的一页和含 workload 的一页；数字一律用 dataKeys 表示，禁止编造数字。`;

/** 齐备性摘要 + 真实计数：喂给模型的是口径与可用源，数字仍由装配层覆盖（FR-3.4） */
function outlineFacts(b: KickoffBundle): string {
  const status = b.preflight.items.map((i) => `${i.key} ${i.label}=${i.count}（${i.status}）`).join('；');
  const byStatus = new Map<string, number>();
  for (const p of b.plans) byStatus.set(p.status, (byStatus.get(p.status) ?? 0) + 1);
  const priority = new Map<string, number>();
  for (const r of b.requirements) {
    const k = (r.priority ?? '').trim() || '未标注';
    priority.set(k, (priority.get(k) ?? 0) + 1);
  }
  const dates = b.plans.map((p) => p.start_date).filter(Boolean).sort();
  const ends = b.plans.map((p) => p.end_date).filter(Boolean).sort();
  const usable = b.preflight.items.filter((i) => i.status === 'ok').map((i) => i.key);
  return [
    `项目：${b.project.name}（数据截至 ${b.dataAsOf}）`,
    `资料齐备性：${status}`,
    `可用数据源（校验 ✓ 的项）：${usable.join('、') || '无'}`,
    `需求 ${b.requirements.length} 条，优先级分布：${[...priority.entries()].map(([k, v]) => `${k} ${v}`).join('、') || '无'}`,
    `计划 ${b.plans.length} 条（里程碑 ${b.milestones.length} 条），状态分布：${[...byStatus.entries()].map(([k, v]) => `${k} ${v}`).join('、') || '无'}`,
    `排期范围：${dates[0] ?? '无'} ~ ${ends[ends.length - 1] ?? '无'}`,
    `测试用例覆盖率：${b.coverage.rate}%（已覆盖 ${b.coverage.covered}/${b.coverage.total}）`,
    `工作量口径：${b.workload.source === 'estimate' ? '估算引擎' : '排期工期推导'}，参与行数 ${b.workload.counted}，复杂度分布 ${b.workload.complexity.map((c) => `${c.level}:${c.count}`).join(' ')}`,
    `承担人：${b.assignees.length} 人${b.assignees.length ? `（${b.assignees.slice(0, 8).map((a) => `${a.name} ${a.planCount}条`).join('、')}）` : ''}`,
    `本地风险信号：${b.risks.length} 条（${b.risks.map((r) => r.item).join('；')}）`,
    b.workspaceNote ?? '',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function kickoffOutline(projectId: string, toolId: string, extraNote?: string): Promise<KickoffOutlineResult> {
  const bundle = collectBundle(projectId);
  if (bundle.preflight.blocked) {
    // FR-2.4 服务端二次拦截：UI 置灰不是保险，绕过面板直接调用同样要拒
    throw new Error(`资料不足，不能生成启动会稿：${bundle.preflight.missingHard.join('、')} 全部缺失——请先补齐 PRD 原文 / 需求矩阵 / 项目计划`);
  }
  const user = `【资料齐备性与真实计数】\n${outlineFacts(bundle)}\n\n【PRD 摘要】\n${bundle.prdExcerpt || '（无 PRD 原文）'}${
    extraNote ? `\n\n【用户补充要求】\n${extraNote}` : ''
  }\n\n请按上述约束输出 ${PAGE_MIN}~${PAGE_MAX} 页的大纲 JSON 数组。`;
  const ai = await AIService.askJson<{ outline: KickoffOutlineItem[]; warnings: string[] }>(
    toolId,
    OUTLINE_SYSTEM,
    user,
    (content) => validateOutline(parseOutlinePayload(content)),
    { retrySystem: OUTLINE_SYSTEM_RETRY, temperature: 0 },
  );
  if (!ai.ok || ai.data === undefined) throw new Error(`AI 未返回合规大纲：${ai.error ?? '未知原因'}`);
  const warnings = [...ai.data.warnings];
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
