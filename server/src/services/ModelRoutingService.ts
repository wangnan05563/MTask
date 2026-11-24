import { v4 as uuid } from 'uuid';
import { getDb } from '../db/connection';

/**
 * T06311（REQ-038 / PRD §B9）：模型路由与成本预算。
 *
 * 产品口径：
 * - 不提供“手动指定模型”的路由入参；路由只吃任务特征、项目、Prompt、上下文长度、
 *   延迟上限、供应商健康与预算。
 * - 预算按项目 / 日 / 月 / 单 Run 四档计算；达到 warning_pct（默认 80%）只预警，
 *   达到 100% 时 stop_mode=stop 硬停、degrade 降级到预算内模型。
 * - 每次真实路由写 model_route_decisions 审计，含候选、选中、降级来源和预算横幅；
 *   模拟器（committed=0）不占预算。
 *
 * 边界：本服务不改 ai_tools、队列、执行会话与 ai_usage 的既有列；只读 ai_tools 与
 * ai_usage 健康样本，新数据全部落在 T06311 增量表。
 */

export type TaskType = 'general' | 'summary' | 'testcase' | 'document' | 'review' | 'code';
export type SupplierHealth = 'healthy' | 'degraded' | 'down';
export type BudgetState = 'ok' | 'warning' | 'hard_stop' | 'unconfigured';
export type StopMode = 'stop' | 'degrade';

export interface RoutingProfile {
  toolId: string;
  toolName: string;
  model: string;
  type: string;
  purpose: string;
  inputCostPer1K: number;
  outputCostPer1K: number;
  expectedLatencyMs: number;
  contextLimit: number;
  capabilities: string[];
  health: SupplierHealth;
  configured: boolean;
  updatedAt: string;
}

export interface ProfilePatch {
  inputCostPer1K?: number;
  outputCostPer1K?: number;
  expectedLatencyMs?: number;
  contextLimit?: number;
  capabilities?: string[] | string;
  health?: SupplierHealth;
}

export interface BudgetConfig {
  id: string;
  projectId: string;
  projectLimit: number;
  dailyLimit: number;
  monthlyLimit: number;
  runLimit: number;
  warningPct: number;
  stopMode: StopMode;
  updatedAt: string;
}

export interface BudgetPatch {
  projectLimit?: number;
  dailyLimit?: number;
  monthlyLimit?: number;
  runLimit?: number;
  warningPct?: number;
  stopMode?: StopMode;
}

export interface BudgetStatus {
  state: BudgetState;
  allowed: boolean;
  scope: 'project' | 'day' | 'month' | 'run' | '';
  scopeLabel: string;
  spent: number;
  limit: number;
  estimatedCost: number;
  percent: number;
  warningPct: number;
  headroom: number | null;
  message: string;
}

export interface RouteCandidate {
  toolId: string;
  toolName: string;
  model: string;
  inputCostPer1K: number;
  outputCostPer1K: number;
  expectedLatencyMs: number;
  contextLimit: number;
  capabilities: string[];
  health: SupplierHealth;
  healthSource: string;
  configured: boolean;
  estimatedCost: number;
  score: number;
  excludedReason: string;
}

export interface RouteRequest {
  projectId: string;
  taskId?: string;
  runId?: string;
  title?: string;
  description?: string;
  prompt?: string;
  taskType?: TaskType;
  /** 已量化的 Prompt 上下文 token；缺省按文本估算。 */
  contextTokens?: number;
  /** 预计输出 token；缺省 512。 */
  outputTokens?: number;
  /** 本次调用额外的单次成本上限（与预算表 run_limit 取更小值）。 */
  costLimit?: number;
  /** 延迟上限（毫秒）；超出则排除该候选。 */
  latencyBudgetMs?: number;
  /** true=写审计并占用预算；false=模拟器，不落库。默认 true。 */
  commit?: boolean;
  /** 校验/回归用：固定当前时间，便于日/月预算切片。 */
  at?: Date;
}

export interface RouteDecision {
  id: string;
  committed: boolean;
  projectId: string;
  taskId: string | null;
  runId: string | null;
  taskType: TaskType;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  estimatedLatencyMs: number;
  selectedToolId: string;
  selectedModel: string;
  downgradedFrom: string;
  budget: BudgetStatus;
  banner: string;
  reason: string;
  candidates: RouteCandidate[];
  createdAt: string;
}

export interface BudgetSnapshot {
  projectId: string;
  budget: BudgetConfig | null;
  spend: { project: number; day: number; month: number; run: number };
  scopes: Array<{ key: string; label: string; limit: number; spent: number; percent: number; state: BudgetState }>;
  state: BudgetState;
}

export class ModelRoutingError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly decision?: RouteDecision;

  constructor(code: string, message: string, statusCode = 400, decision?: RouteDecision) {
    super(message);
    this.name = 'ModelRoutingError';
    this.code = code;
    this.statusCode = statusCode;
    this.decision = decision;
  }
}

const TASK_TYPE_RULES: Array<{ type: Exclude<TaskType, 'general'>; re: RegExp }> = [
  { type: 'summary', re: /(总结|摘要|梳理|归纳|概括|汇总|summar|summary)/i },
  { type: 'testcase', re: /(测试|用例|验收|回归|test\s*case|testcase)/i },
  { type: 'review', re: /(评审|审查|审计|检查|review|audit)/i },
  { type: 'document', re: /(文档|说明|手册|readme|注释|doc)/i },
  { type: 'code', re: /(修复|重构|报错|异常|代码|实现|开发|功能|bug|fix|refactor|feature|code)/i },
];

function nowIso(): string {
  return new Date().toISOString();
}

function trimStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function finiteNonNegative(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function normalizeCapabilities(raw: unknown): string[] {
  const text = Array.isArray(raw) ? raw.join(',') : trimStr(raw);
  const items = text
    .split(/[,，|/\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  return items.length ? Array.from(new Set(items)) : ['general'];
}

/** 任务特征推断：只做确定性规则，不引入模型调用，保证路由本身可复现。 */
export function inferTaskType(text: string): TaskType {
  const s = (text || '').trim();
  if (!s) return 'general';
  for (const rule of TASK_TYPE_RULES) {
    if (rule.re.test(s)) return rule.type;
  }
  return 'general';
}

/** 轻量 token 估算：中日韩字符按 1.5 token、其余按 4 字符 1 token；仅用于预算预估。 */
export function estimateTokens(text: string): number {
  const s = text || '';
  const cjk = (s.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  const other = Math.max(0, s.length - cjk);
  return Math.max(1, Math.ceil(cjk * 1.5 + other / 4));
}

function healthPenalty(h: SupplierHealth): number {
  if (h === 'healthy') return 0;
  if (h === 'degraded') return 1;
  return Number.POSITIVE_INFINITY;
}

function normalizeValue(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return 0;
  if (max <= min) return 0.5;
  return Math.min(1, Math.max(0, (v - min) / (max - min)));
}

function localDayStart(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate(), 0, 0, 0, 0);
}

function localMonthStart(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), 1, 0, 0, 0, 0);
}

function budgetFromRow(row: Record<string, unknown>): BudgetConfig {
  return {
    id: String(row.id ?? ''),
    projectId: String(row.project_id ?? ''),
    projectLimit: Number(row.project_limit ?? 0),
    dailyLimit: Number(row.daily_limit ?? 0),
    monthlyLimit: Number(row.monthly_limit ?? 0),
    runLimit: Number(row.run_limit ?? 0),
    warningPct: Number(row.warning_pct ?? 80),
    stopMode: row.stop_mode === 'degrade' ? 'degrade' : 'stop',
    updatedAt: String(row.updated_at ?? ''),
  };
}

function getBudgetConfig(projectId: string): BudgetConfig | null {
  const row = getDb().prepare('SELECT * FROM model_budgets WHERE project_id = ?').get(projectId) as
    | Record<string, unknown>
    | undefined;
  return row ? budgetFromRow(row) : null;
}

function getSpend(projectId: string, runId: string | null | undefined, at: Date): BudgetSnapshot['spend'] {
  const db = getDb();
  const day = localDayStart(at).toISOString();
  const month = localMonthStart(at).toISOString();
  const project = db
    .prepare('SELECT COALESCE(SUM(estimated_cost), 0) AS v FROM model_route_decisions WHERE project_id = ? AND committed = 1')
    .get(projectId) as { v: number };
  const today = db
    .prepare(
      'SELECT COALESCE(SUM(estimated_cost), 0) AS v FROM model_route_decisions WHERE project_id = ? AND committed = 1 AND created_at >= ?',
    )
    .get(projectId, day) as { v: number };
  const thisMonth = db
    .prepare(
      'SELECT COALESCE(SUM(estimated_cost), 0) AS v FROM model_route_decisions WHERE project_id = ? AND committed = 1 AND created_at >= ?',
    )
    .get(projectId, month) as { v: number };
  const run = runId
    ? (db
        .prepare('SELECT COALESCE(SUM(estimated_cost), 0) AS v FROM model_route_decisions WHERE run_id = ? AND committed = 1')
        .get(runId) as { v: number })
    : { v: 0 };
  return { project: Number(project.v), day: Number(today.v), month: Number(thisMonth.v), run: Number(run.v) };
}

function evaluateBudget(
  projectId: string,
  estimatedCost: number,
  runId: string | null | undefined,
  at: Date,
): BudgetStatus {
  const budget = getBudgetConfig(projectId);
  if (!budget) {
    return {
      state: 'unconfigured',
      allowed: true,
      scope: '',
      scopeLabel: '',
      spent: 0,
      limit: 0,
      estimatedCost,
      percent: 0,
      warningPct: 80,
      headroom: null,
      message: '未配置预算，路由不做预算拦截',
    };
  }
  const spend = getSpend(projectId, runId, at);
  const scopes = [
    { key: 'project' as const, label: '项目', limit: budget.projectLimit, spent: spend.project },
    { key: 'day' as const, label: '今日', limit: budget.dailyLimit, spent: spend.day },
    { key: 'month' as const, label: '本月', limit: budget.monthlyLimit, spent: spend.month },
    { key: 'run' as const, label: '单 Run', limit: budget.runLimit, spent: spend.run },
  ];
  let hard: (typeof scopes)[number] | null = null;
  let warningScope: (typeof scopes)[number] | null = null;
  let maxPct = 0;
  let headroom: number | null = null;
  for (const s of scopes) {
    if (!(s.limit > 0)) continue;
    const projected = s.spent + Math.max(0, estimatedCost);
    const pct = (projected / s.limit) * 100;
    maxPct = Math.max(maxPct, pct);
    if (pct >= 100 - 1e-9) hard = hard ?? s;
    if (pct >= budget.warningPct - 1e-9) warningScope = warningScope ?? s;
    const remaining = Math.max(0, s.limit - s.spent);
    headroom = headroom === null ? remaining : Math.min(headroom, remaining);
  }
  const tight = hard ?? warningScope;
  const state: BudgetState = hard ? 'hard_stop' : warningScope ? 'warning' : 'ok';
  const label = tight?.label ?? '';
  const limit = tight?.limit ?? 0;
  const spent = tight?.spent ?? 0;
  const percent = limit > 0 ? (maxPct > 0 ? maxPct : (spent / limit) * 100) : 0;
  let message = '';
  if (state === 'hard_stop') {
    message = `预算硬性停止：${label}已用 ${spent.toFixed(4)} / ${limit.toFixed(4)}，本次预计 ${estimatedCost.toFixed(4)}，已超上限`;
  } else if (state === 'warning') {
    message = `预算预警：${label}已用 ${percent.toFixed(1)}%（${spent.toFixed(4)} / ${limit.toFixed(4)}），本次预计 ${estimatedCost.toFixed(4)}`;
  }
  return {
    state,
    allowed: state !== 'hard_stop' || budget.stopMode === 'degrade',
    scope: tight?.key ?? '',
    scopeLabel: label,
    spent,
    limit,
    estimatedCost,
    percent,
    warningPct: budget.warningPct,
    headroom,
    message,
  };
}

interface RawCandidate {
  toolId: string;
  toolName: string;
  model: string;
  type: string;
  purpose: string;
  maxTokens: number;
  timeoutMs: number;
  inputCostPer1K: number;
  outputCostPer1K: number;
  expectedLatencyMs: number;
  contextLimit: number;
  capabilities: string[];
  health: SupplierHealth;
  configured: boolean;
}

function recentHealth(toolId: string, base: SupplierHealth): { health: SupplierHealth; source: string } {
  const db = getDb();
  const rows = db
    .prepare('SELECT ok FROM ai_usage WHERE tool_id = ? ORDER BY created_at DESC LIMIT 20')
    .all(toolId) as Array<{ ok: number }>;
  if (!rows.length) return { health: base, source: 'profile' };
  const failRate = rows.filter((r) => !r.ok).length / rows.length;
  if (base === 'down') return { health: 'down', source: 'profile' };
  if (failRate >= 0.75) return { health: 'down', source: `usage:${(failRate * 100).toFixed(0)}%` };
  if (failRate >= 0.4) return { health: 'degraded', source: `usage:${(failRate * 100).toFixed(0)}%` };
  return { health: base, source: 'profile' };
}

function loadRawCandidates(): RawCandidate[] {
  const rows = getDb()
    .prepare(
      `SELECT t.id AS toolId, t.name AS toolName, t.model, t.type, t.purpose,
              t.max_tokens AS maxTokens, t.timeout_ms AS timeoutMs,
              p.input_cost_per_1k AS inputCostPer1K,
              p.output_cost_per_1k AS outputCostPer1K,
              p.expected_latency_ms AS expectedLatencyMs,
              p.context_limit AS contextLimit,
              p.capabilities, p.health, p.tool_id AS profiled
         FROM ai_tools t
         LEFT JOIN model_route_profiles p ON p.tool_id = t.id
        WHERE COALESCE(t.enabled, 1) = 1 AND COALESCE(t.archived, 0) = 0
        ORDER BY t.created_at ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    toolId: String(r.toolId ?? ''),
    toolName: String(r.toolName ?? ''),
    model: trimStr(r.model) || String(r.toolName ?? ''),
    type: String(r.type ?? ''),
    purpose: String(r.purpose ?? ''),
    maxTokens: Number(r.maxTokens ?? 0),
    timeoutMs: Number(r.timeoutMs ?? 0),
    inputCostPer1K: finiteNonNegative(r.inputCostPer1K, 0),
    outputCostPer1K: finiteNonNegative(r.outputCostPer1K, 0),
    expectedLatencyMs: finiteNonNegative(r.expectedLatencyMs, 0),
    contextLimit: finiteNonNegative(r.contextLimit, 0),
    capabilities: normalizeCapabilities(r.capabilities),
    health: r.health === 'down' || r.health === 'degraded' ? r.health : 'healthy',
    configured: r.profiled !== null && r.profiled !== undefined,
  }));
}

function estimateCost(c: RawCandidate, inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1000) * c.inputCostPer1K + (outputTokens / 1000) * c.outputCostPer1K;
}

function capabilityFit(c: RawCandidate, taskType: TaskType): number {
  if (c.capabilities.includes(taskType)) return 0;
  if (c.capabilities.includes('*')) return 0;
  if (taskType === 'general' && c.capabilities.includes('general')) return 0;
  if (c.capabilities.includes('general')) return 0.06;
  return 1;
}

function buildCandidates(
  taskType: TaskType,
  inputTokens: number,
  outputTokens: number,
  latencyBudgetMs: number | undefined,
): RouteCandidate[] {
  const raw = loadRawCandidates();
  const rows: RouteCandidate[] = [];
  for (const c of raw) {
    const health = recentHealth(c.toolId, c.health);
    const cost = estimateCost(c, inputTokens, outputTokens);
    const latency = c.expectedLatencyMs > 0 ? c.expectedLatencyMs : Math.min(c.timeoutMs || 30000, 30000);
    let excludedReason = '';
    if (c.contextLimit > 0 && inputTokens + outputTokens > c.contextLimit) {
      excludedReason = `上下文超出（${inputTokens + outputTokens} > ${c.contextLimit}）`;
    }
    if (!excludedReason && latencyBudgetMs && latencyBudgetMs > 0 && latency > latencyBudgetMs) {
      excludedReason = `延迟超出（${latency}ms > ${latencyBudgetMs}ms）`;
    }
    if (!excludedReason && health.health === 'down') {
      excludedReason = '供应商健康度 down';
    }
    rows.push({
      toolId: c.toolId,
      toolName: c.toolName,
      model: c.model,
      inputCostPer1K: c.inputCostPer1K,
      outputCostPer1K: c.outputCostPer1K,
      expectedLatencyMs: latency,
      contextLimit: c.contextLimit,
      capabilities: c.capabilities,
      health: health.health,
      healthSource: health.source,
      configured: c.configured,
      estimatedCost: cost,
      score: 0,
      excludedReason,
    });
  }
  const usable = rows.filter((r) => !r.excludedReason);
  if (!usable.length) return rows;
  const minCost = Math.min(...usable.map((r) => r.estimatedCost));
  const maxCost = Math.max(...usable.map((r) => r.estimatedCost));
  const minLatency = Math.min(...usable.map((r) => r.expectedLatencyMs));
  const maxLatency = Math.max(...usable.map((r) => r.expectedLatencyMs));
  for (const r of usable) {
    const nc = normalizeValue(r.estimatedCost, minCost, maxCost);
    const nl = normalizeValue(r.expectedLatencyMs, minLatency, maxLatency);
    const hp = healthPenalty(r.health);
    const fit = capabilityFit(
      {
        toolId: r.toolId, toolName: r.toolName, model: r.model, type: '', purpose: '',
        maxTokens: 0, timeoutMs: r.expectedLatencyMs, inputCostPer1K: r.inputCostPer1K,
        outputCostPer1K: r.outputCostPer1K, expectedLatencyMs: r.expectedLatencyMs,
        contextLimit: r.contextLimit, capabilities: r.capabilities, health: r.health, configured: r.configured,
      },
      taskType,
    );
    // 成本与延迟是主排序项；degraded 供应商保留可用，但用 0.5 权重压到成本/延迟之后，
    // 避免“便宜但 unhealthy”的模型在长上下文任务里压过稳定供应商。
    r.score = Number.isFinite(hp) ? 0.35 * nc + 0.10 * nl + 0.50 * hp + 0.05 * fit : Number.POSITIVE_INFINITY;
  }
  for (const r of rows) {
    if (r.excludedReason) r.score = Number.POSITIVE_INFINITY;
  }
  return rows.sort((a, b) => (a.score === b.score ? a.estimatedCost - b.estimatedCost : a.score - b.score));
}

function recordDecision(d: RouteDecision): void {
  getDb()
    .prepare(
      `INSERT INTO model_route_decisions
         (id, task_id, project_id, run_id, task_type, selected_tool_id, selected_model,
          estimated_cost, estimated_latency_ms, input_tokens, output_tokens, budget_status,
          budget_banner, downgraded_from, reason, candidates_json, committed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      d.id,
      d.taskId,
      d.projectId,
      d.runId,
      d.taskType,
      d.selectedToolId,
      d.selectedModel,
      d.estimatedCost,
      d.estimatedLatencyMs,
      d.inputTokens,
      d.outputTokens,
      d.budget.state,
      d.banner,
      d.downgradedFrom,
      d.reason,
      JSON.stringify(d.candidates),
      d.committed ? 1 : 0,
      d.createdAt,
    );
}

function makeDecision(args: {
  request: RouteRequest;
  taskType: TaskType;
  inputTokens: number;
  outputTokens: number;
  candidate: RouteCandidate | null;
  candidates: RouteCandidate[];
  budget: BudgetStatus;
  downgradedFrom: string;
  banner: string;
  reason: string;
  committed: boolean;
}): RouteDecision {
  const c = args.candidate;
  return {
    id: uuid(),
    committed: args.committed,
    projectId: trimStr(args.request.projectId),
    taskId: trimStr(args.request.taskId) || null,
    runId: trimStr(args.request.runId) || null,
    taskType: args.taskType,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    estimatedCost: c?.estimatedCost ?? 0,
    estimatedLatencyMs: c?.expectedLatencyMs ?? 0,
    selectedToolId: c?.toolId ?? '',
    selectedModel: c?.model ?? '',
    downgradedFrom: args.downgradedFrom ?? '',
    budget: args.budget,
    banner: args.banner,
    reason: args.reason,
    candidates: args.candidates,
    createdAt: nowIso(),
  };
}

function makeHardStop(args: {
  request: RouteRequest;
  taskType: TaskType;
  inputTokens: number;
  outputTokens: number;
  candidates: RouteCandidate[];
  budget: BudgetStatus;
}): RouteDecision {
  const message = args.budget.message || '预算硬性停止：本次调用会超出租户预算';
  return makeDecision({
    request: args.request,
    taskType: args.taskType,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    candidate: null,
    candidates: args.candidates,
    budget: { ...args.budget, state: 'hard_stop', message },
    downgradedFrom: '',
    banner: message,
    reason: message,
    committed: true,
  });
}

function routeLocked(request: RouteRequest): RouteDecision {
  const projectId = trimStr(request.projectId);
  if (!projectId) throw new ModelRoutingError('project_required', 'projectId 必填', 400);
  const at = request.at ?? new Date();
  const promptText = [request.title ?? '', request.description ?? '', request.prompt ?? ''].join('\n');
  const taskType = request.taskType ?? inferTaskType(promptText);
  const inputTokens = Math.max(1, Math.round(finiteNonNegative(request.contextTokens, estimateTokens(promptText))));
  const outputTokens = Math.max(1, Math.round(finiteNonNegative(request.outputTokens, 512)));
  const commit = request.commit !== false;
  const budget = getBudgetConfig(projectId);
  const candidates = buildCandidates(taskType, inputTokens, outputTokens, request.latencyBudgetMs);
  if (!candidates.length) throw new ModelRoutingError('no_candidate', '没有可用模型（全部被禁用或不可用）', 400);

  const runCap = Math.min(
    ...[request.costLimit, budget?.runLimit].filter((v): v is number => typeof v === 'number' && v > 0),
  );
  const cap = Number.isFinite(runCap) ? runCap : 0;
  const usable = candidates.filter((c) => !c.excludedReason);
  let eligible = usable.filter((c) => cap <= 0 || c.estimatedCost <= cap);
  if (!eligible.length) {
    const initial = evaluateBudget(projectId, 0, request.runId, at);
    const stop = makeHardStop({
      request, taskType, inputTokens, outputTokens, candidates,
      budget: {
        ...initial,
        state: 'hard_stop',
        allowed: false,
        scope: 'run',
        scopeLabel: '单 Run',
        limit: cap,
        estimatedCost: 0,
        headroom: 0,
        message: `预算硬性停止：没有模型能落在单 Run 上限 ${cap.toFixed(4)} 内`,
      },
    });
    stop.reason = stop.banner;
    if (commit) {
      recordDecision(stop);
      throw new ModelRoutingError('budget_hard_stop', stop.banner, 409, stop);
    }
    return stop;
  }

  let best = eligible[0];
  let downgradedFrom = usable.length && best && usable[0].toolId !== best.toolId ? `${usable[0].toolName}/${usable[0].model}` : '';
  let downgradeReason = downgradedFrom ? `单 Run 上限 ${cap.toFixed(4)}` : '';
  let status = evaluateBudget(projectId, best.estimatedCost, request.runId, at);
  if (status.state === 'hard_stop') {
    if (budget?.stopMode === 'degrade' && status.headroom !== null) {
      const fits = eligible.filter((c) => c.estimatedCost <= status.headroom!);
      if (fits.length) {
        const before = best;
        best = fits[0];
        if (!downgradedFrom) downgradedFrom = `${before.toolName}/${before.model}`;
        downgradeReason = `预算剩余 ${(status.headroom ?? 0).toFixed(4)}`;
        status = evaluateBudget(projectId, best.estimatedCost, request.runId, at);
      }
    }
    if (status.state === 'hard_stop') {
      const stop = makeHardStop({ request, taskType, inputTokens, outputTokens, candidates, budget: status });
      if (commit) {
        recordDecision(stop);
        throw new ModelRoutingError('budget_hard_stop', stop.banner, 409, stop);
      }
      return stop;
    }
  }

  let banner = status.message;
  if (downgradedFrom) {
    const before = downgradedFrom;
    banner = `已从 ${before} 降级到 ${best.toolName}/${best.model}：${downgradeReason || `预算剩余 ${(status.headroom ?? 0).toFixed(4)}`}，本次预计 ${best.estimatedCost.toFixed(4)}。`;
  }
  const reason = `任务类型=${taskType}；输入≈${inputTokens} tokens；候选 ${candidates.length} 个；选中 ${best.toolName}/${best.model}（成本 ${best.estimatedCost.toFixed(4)}，延迟 ${best.expectedLatencyMs}ms）`;
  const decision = makeDecision({
    request,
    taskType,
    inputTokens,
    outputTokens,
    candidate: best,
    candidates,
    budget: status,
    downgradedFrom,
    banner,
    reason,
    committed: commit,
  });
  if (commit) recordDecision(decision);
  return decision;
}

export const ModelRoutingService = {
  inferTaskType,
  estimateTokens,

  listProfiles(): RoutingProfile[] {
    const rows = getDb()
      .prepare(
        `SELECT t.id, t.name, t.model, t.type, t.purpose,
                p.input_cost_per_1k, p.output_cost_per_1k, p.expected_latency_ms,
                p.context_limit, p.capabilities, p.health, p.tool_id AS profiled, p.updated_at
           FROM ai_tools t
           LEFT JOIN model_route_profiles p ON p.tool_id = t.id
          WHERE COALESCE(t.archived, 0) = 0
          ORDER BY t.created_at ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      toolId: String(r.id ?? ''),
      toolName: String(r.name ?? ''),
      model: trimStr(r.model) || String(r.name ?? ''),
      type: String(r.type ?? ''),
      purpose: String(r.purpose ?? ''),
      inputCostPer1K: finiteNonNegative(r.input_cost_per_1k, 0),
      outputCostPer1K: finiteNonNegative(r.output_cost_per_1k, 0),
      expectedLatencyMs: finiteNonNegative(r.expected_latency_ms, 0),
      contextLimit: finiteNonNegative(r.context_limit, 0),
      capabilities: normalizeCapabilities(r.capabilities),
      health: r.health === 'down' || r.health === 'degraded' ? r.health : 'healthy',
      configured: r.profiled !== null && r.profiled !== undefined,
      updatedAt: String(r.updated_at ?? ''),
    }));
  },

  upsertProfile(toolId: string, patch: ProfilePatch): RoutingProfile {
    const id = trimStr(toolId);
    if (!id) throw new ModelRoutingError('tool_required', 'toolId 必填', 400);
    const row = getDb().prepare('SELECT * FROM ai_tools WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new ModelRoutingError('tool_not_found', `AI 工具不存在：${id}`, 404);
    const existing = getDb().prepare('SELECT * FROM model_route_profiles WHERE tool_id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    const inputCost = finiteNonNegative(patch.inputCostPer1K, Number(existing?.input_cost_per_1k ?? 0));
    const outputCost = finiteNonNegative(patch.outputCostPer1K, Number(existing?.output_cost_per_1k ?? 0));
    const latency = finiteNonNegative(patch.expectedLatencyMs, Number(existing?.expected_latency_ms ?? 0));
    const context = finiteNonNegative(patch.contextLimit, Number(existing?.context_limit ?? 0));
    const caps = normalizeCapabilities(patch.capabilities ?? existing?.capabilities ?? 'general');
    const health: SupplierHealth =
      patch.health === 'down' || patch.health === 'degraded' || patch.health === 'healthy'
        ? patch.health
        : existing?.health === 'down' || existing?.health === 'degraded'
          ? (existing.health as SupplierHealth)
          : 'healthy';
    getDb()
      .prepare(
        `INSERT INTO model_route_profiles
           (tool_id, input_cost_per_1k, output_cost_per_1k, expected_latency_ms, context_limit, capabilities, health, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tool_id) DO UPDATE SET
           input_cost_per_1k = excluded.input_cost_per_1k,
           output_cost_per_1k = excluded.output_cost_per_1k,
           expected_latency_ms = excluded.expected_latency_ms,
           context_limit = excluded.context_limit,
           capabilities = excluded.capabilities,
           health = excluded.health,
           updated_at = excluded.updated_at`,
      )
      .run(id, inputCost, outputCost, latency, context, caps.join(','), health, nowIso());
    const profile = this.listProfiles().find((p) => p.toolId === id);
    if (!profile) throw new ModelRoutingError('profile_not_found', '画像写入失败', 500);
    return profile;
  },

  getBudget(projectId: string): BudgetConfig | null {
    return getBudgetConfig(trimStr(projectId));
  },

  upsertBudget(projectId: string, patch: BudgetPatch): BudgetConfig {
    const pid = trimStr(projectId);
    if (!pid) throw new ModelRoutingError('project_required', 'projectId 必填', 400);
    const project = getDb().prepare('SELECT id FROM projects WHERE id = ?').get(pid);
    if (!project) throw new ModelRoutingError('project_not_found', `项目不存在：${pid}`, 404);
    const existing = getBudgetConfig(pid);
    const warning = finiteNonNegative(patch.warningPct, existing?.warningPct ?? 80);
    if (warning <= 0 || warning >= 100) throw new ModelRoutingError('warning_invalid', 'warningPct 必须在 0~100 之间', 400);
    const stopMode: StopMode = patch.stopMode === 'degrade' || patch.stopMode === 'stop'
      ? patch.stopMode
      : existing?.stopMode ?? 'stop';
    const id = existing?.id ?? uuid();
    const values = {
      projectLimit: finiteNonNegative(patch.projectLimit, existing?.projectLimit ?? 0),
      dailyLimit: finiteNonNegative(patch.dailyLimit, existing?.dailyLimit ?? 0),
      monthlyLimit: finiteNonNegative(patch.monthlyLimit, existing?.monthlyLimit ?? 0),
      runLimit: finiteNonNegative(patch.runLimit, existing?.runLimit ?? 0),
    };
    getDb()
      .prepare(
        `INSERT INTO model_budgets
           (id, project_id, project_limit, daily_limit, monthly_limit, run_limit, warning_pct, stop_mode, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           project_limit = excluded.project_limit,
           daily_limit = excluded.daily_limit,
           monthly_limit = excluded.monthly_limit,
           run_limit = excluded.run_limit,
           warning_pct = excluded.warning_pct,
           stop_mode = excluded.stop_mode,
           updated_at = excluded.updated_at`,
      )
      .run(id, pid, values.projectLimit, values.dailyLimit, values.monthlyLimit, values.runLimit, warning, stopMode, nowIso());
    const next = getBudgetConfig(pid);
    if (!next) throw new ModelRoutingError('budget_not_found', '预算写入失败', 500);
    return next;
  },

  budgetSnapshot(projectId: string, at = new Date()): BudgetSnapshot {
    const pid = trimStr(projectId);
    if (!pid) throw new ModelRoutingError('project_required', 'projectId 必填', 400);
    const budget = getBudgetConfig(pid);
    const spend = getSpend(pid, null, at);
    if (!budget) {
      return {
        projectId: pid,
        budget: null,
        spend,
        scopes: [],
        state: 'unconfigured',
      };
    }
    const scopes = [
      { key: 'project', label: '项目', limit: budget.projectLimit, spent: spend.project },
      { key: 'day', label: '今日', limit: budget.dailyLimit, spent: spend.day },
      { key: 'month', label: '本月', limit: budget.monthlyLimit, spent: spend.month },
      { key: 'run', label: '单 Run', limit: budget.runLimit, spent: spend.run },
    ].filter((s) => s.limit > 0);
    let overall: BudgetState = 'ok';
    const mapped = scopes.map((s) => {
      const percent = s.limit > 0 ? (s.spent / s.limit) * 100 : 0;
      const state: BudgetState = percent >= 100 ? 'hard_stop' : percent >= budget.warningPct ? 'warning' : 'ok';
      if (state === 'hard_stop' || (state === 'warning' && overall === 'ok')) overall = state;
      return { ...s, percent, state };
    });
    return { projectId: pid, budget, spend, scopes: mapped, state: overall };
  },

  route(request: RouteRequest): RouteDecision {
    return routeLocked(request);
  },

  listDecisions(projectId: string, limit = 50): RouteDecision[] {
    const pid = trimStr(projectId);
    if (!pid) throw new ModelRoutingError('project_required', 'projectId 必填', 400);
    const rows = getDb()
      .prepare(
        `SELECT * FROM model_route_decisions WHERE project_id = ?
          ORDER BY created_at DESC LIMIT ?`,
      )
      .all(pid, Math.max(1, Math.min(200, Math.round(limit))) as number) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id ?? ''),
      committed: Number(r.committed) === 1,
      projectId: String(r.project_id ?? ''),
      taskId: r.task_id ? String(r.task_id) : null,
      runId: r.run_id ? String(r.run_id) : null,
      taskType: String(r.task_type ?? 'general') as TaskType,
      inputTokens: Number(r.input_tokens ?? 0),
      outputTokens: Number(r.output_tokens ?? 0),
      estimatedCost: Number(r.estimated_cost ?? 0),
      estimatedLatencyMs: Number(r.estimated_latency_ms ?? 0),
      selectedToolId: String(r.selected_tool_id ?? ''),
      selectedModel: String(r.selected_model ?? ''),
      downgradedFrom: String(r.downgraded_from ?? ''),
      budget: {
        state: String(r.budget_status ?? 'unconfigured') as BudgetState,
        allowed: String(r.budget_status ?? '') !== 'hard_stop',
        scope: '',
        scopeLabel: '',
        spent: 0,
        limit: 0,
        estimatedCost: Number(r.estimated_cost ?? 0),
        percent: 0,
        warningPct: 0,
        headroom: null,
        message: String(r.budget_banner ?? ''),
      },
      banner: String(r.budget_banner ?? ''),
      reason: String(r.reason ?? ''),
      candidates: (() => {
        try {
          return JSON.parse(String(r.candidates_json ?? '[]')) as RouteCandidate[];
        } catch {
          return [];
        }
      })(),
      createdAt: String(r.created_at ?? ''),
    }));
  },

  costAttribution(projectId: string): Array<{
    projectId: string; model: string; toolId: string; runId: string; decisions: number; estimatedCost: number;
  }> {
    const pid = trimStr(projectId);
    if (!pid) throw new ModelRoutingError('project_required', 'projectId 必填', 400);
    const rows = getDb()
      .prepare(
        `SELECT project_id, selected_model, selected_tool_id, COALESCE(run_id, '') AS run_id,
                COUNT(*) AS decisions, COALESCE(SUM(estimated_cost), 0) AS estimated_cost
           FROM model_route_decisions
          WHERE project_id = ? AND committed = 1
          GROUP BY project_id, selected_model, selected_tool_id, COALESCE(run_id, '')
          ORDER BY estimated_cost DESC`,
      )
      .all(pid) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      projectId: String(r.project_id ?? ''),
      model: String(r.selected_model ?? ''),
      toolId: String(r.selected_tool_id ?? ''),
      runId: String(r.run_id ?? ''),
      decisions: Number(r.decisions ?? 0),
      estimatedCost: Number(r.estimated_cost ?? 0),
    }));
  },

  costAttributionCsv(projectId: string): string {
    const rows = this.costAttribution(projectId);
    const head = ['project_id', 'model', 'tool_id', 'run_id', 'decisions', 'estimated_cost'];
    const body = rows.map((r) => [r.projectId, r.model, r.toolId, r.runId, String(r.decisions), r.estimatedCost.toFixed(6)]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    return [head.join(','), ...body].join('\n') + '\n';
  },
};
