/**
 * T01285（PRD FR-4.6 / §9 第 5 步）：监督审计落库——每轮**进入决策流程**的 tick 写一行 `monitor_runs`，
 * 记录「AI 看到了什么、想做什么、护栏拦了什么、实际落地了什么」，前端「监督审计」视图据此回溯
 * 「AI 为什么这么做」（FR-5.3）。
 *
 * 独立成模块（与 SupervisorGuard / SupervisorExecutor 同构）：本模块**只读写审计数据、不裁决不执行**，
 * 写侧输入是 tick 各阶段的产出，输出是一行审计记录——测试可直接喂结果断言落库内容，
 * 无需构造 LLM、护栏配置与真实动作；读侧（T01286 / FR-5.3）供状态面板与 `mtask_supervisor_status`
 * 反查「最近一轮 AI 想做什么」，与写侧同处一文件以保证列语义与解析口径一致。
 *
 * 只写「决策轮次」不写空转轮次（`ran=true` 才调用）：空转/熔断/叠轮每 30s 一次，
 * 若也落库会以 2880 行/天的速度把审计表刷成噪声，真出事时反而找不到有效记录。
 * FR-4.6 的「每次决策与动作」指的是决策轮次，空转轮次既无决策也无动作。
 *
 * 结构对齐 `monitor_runs` 既有 7 列（T01268 建表，不改表）：`snapshot` 存**摘要**而非全量快照——
 * 全量快照含待办/会话明细，每 30s 一行会让库快速膨胀，而审计要回答的是「规模与状态」。
 * 待办截断计数、就绪数、停滞数、降级标记等额外信息一并塞进该 JSON（列语义即「快照摘要」）。
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection';

/** 快照摘要来源：只取计数与状态，结构化最小接口——MonitorSnapshot 天然兼容（同 SupervisorGuard 的做法） */
export interface AuditSnapshot {
  generatedAt: string;
  /** 待办池（受 PENDING_LIMIT 截断，故需与 pendingTotal 区分） */
  pending: Array<{ ready: boolean }>;
  /** 待办池全量计数 */
  pendingTotal: number;
  sessions: Array<{ stale: boolean }>;
  failed: unknown[];
  budget: {
    usedTokens: number;
    maxTokens: number;
    concurrent: number;
    maxConcurrent: number;
  };
}

/** 本轮动作计划（LLM 输出；降级轮次为护栏前生成的人工升级动作） */
export interface AuditAction {
  type: string;
  taskId?: string;
  platform?: string;
  toPlatform?: string;
  reason: string;
}

/** 落地结果（ApplyOutcome 天然兼容） */
export interface AuditOutcome {
  type: string;
  taskId?: string;
  status: string;
  detail: string;
  createdTaskNo?: string;
}

/** 决策 LLM 元信息（SupervisorDecision 天然兼容） */
export interface AuditDecision {
  model: string;
  ok: boolean;
  durationMs: number;
  error?: string;
  /** T01289：本轮决策消耗的 token（含重试累计） */
  usage?: { totalTokens: number };
}

export interface AuditRunInput {
  snapshot: AuditSnapshot;
  /** 本轮动作计划：LLM 输出；降级轮次为空则由 tick 传入降级产物（此时 decision.ok=false 可区分） */
  actions: AuditAction[];
  /** 落地结果（护栏放行动作的实际执行产出） */
  executed: AuditOutcome[];
  /** 护栏拦截原因去重汇总（空串=未拦截） */
  blockedBy: string;
  /** 本轮被拦截的动作数（详情只有原因汇总，计数让前端知道规模） */
  blockedCount: number;
  decision: AuditDecision;
  /** 本轮新标记就绪的待办数（T01280） */
  readyMarked?: number;
  /** 本轮新标记停滞的会话数（观测层兜底） */
  stalledMarked: number;
}

/** 快照摘要：规模与状态，不存明细列表（理由见文件头） */
function summarize(input: AuditRunInput): Record<string, unknown> {
  const s = input.snapshot;
  return {
    generatedAt: s.generatedAt,
    pending: s.pending.length,
    pendingTotal: s.pendingTotal,
    // 就绪判定口径与排水一致（serial 前置完成、parallel 不阻塞）
    pendingReady: s.pending.filter((p) => p.ready).length,
    sessions: s.sessions.length,
    staleSessions: s.sessions.filter((x) => x.stale).length,
    failed: s.failed.length,
    concurrent: s.budget.concurrent,
    maxConcurrent: s.budget.maxConcurrent,
    usedTokens: s.budget.usedTokens,
    maxTokens: s.budget.maxTokens,
    // T01289：快照里的 usedTokens 是**本轮开始前**的累计（LLM 看到的现状），本轮消耗单列一栏——
    // 审计的价值在「这一轮花了多少」，只记前置累计会让人误读成「本轮没花钱」（REQ-019 成本可回溯）
    decisionTokens: input.decision.usage?.totalTokens ?? 0,
    readyMarked: input.readyMarked ?? 0,
    stalledMarked: input.stalledMarked,
    // 降级标记：decision.ok=false 时 actions 非 LLM 产出，前端须能区分「AI 说的」与「系统兜底的」
    degraded: !input.decision.ok,
    decisionError: input.decision.error,
    decisionMs: input.decision.durationMs,
    blockedCount: input.blockedCount,
  };
}

/**
 * 写一行审计。**仅在进入决策流程（`ran=true`）的轮次调用**（理由见文件头）。
 *
 * 失败只记日志不上抛：审计是旁路留痕，写不进去不该拖垮本轮排水与动作落地——
 * 但必须留痕（console.error 会被 LogService 环形缓冲捕获），否则「审计坏了」会完全不可见。
 */
export function recordMonitorRun(input: AuditRunInput): void {
  try {
    getDb()
      .prepare(
        'INSERT INTO monitor_runs (id, ran_at, snapshot, actions, applied, blocked_by, model) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        randomUUID(),
        new Date().toISOString(),
        JSON.stringify(summarize(input)),
        JSON.stringify(input.actions),
        JSON.stringify(input.executed),
        input.blockedBy ?? '',
        input.decision.model ?? '',
      );
  } catch (e) {
    console.error('[supervisor] 审计写入失败（本轮记录丢失）:', e);
  }
}

/** 审计列表行：JSON 列已解析为对象/数组，供前端直接消费 */
export interface MonitorRunRow {
  id: string;
  ranAt: string;
  snapshot: Record<string, unknown> | null;
  actions: unknown[];
  applied: unknown[];
  blockedBy: string;
  model: string;
}

/** 列表默认条数与上限：审计每决策轮一行，上限 200 条足够回溯且不拖慢面板 */
const LIST_DEFAULT_LIMIT = 30;
const LIST_MAX_LIMIT = 200;

/** 解析 JSON 对象列；坏行按 null 兜底——单行脏数据不该让整页审计不可读 */
function parseObject(raw: string | null): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw || 'null');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 解析 JSON 数组列；坏行按空数组兜底 */
function parseArray(raw: string | null): unknown[] {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** 读最近若干条审计（FR-5.3）：走 idx_monitor_runs_ran 倒序，limit 收口在 [1, 200] */
export function listMonitorRuns(limit?: number): MonitorRunRow[] {
  const n = Number.isFinite(limit) && (limit as number) > 0
    ? Math.min(Math.trunc(limit as number), LIST_MAX_LIMIT)
    : LIST_DEFAULT_LIMIT;
  const rows = getDb()
    .prepare('SELECT id, ran_at, snapshot, actions, applied, blocked_by, model FROM monitor_runs ORDER BY ran_at DESC LIMIT ?')
    .all(n) as Array<{
      id: string;
      ran_at: string;
      snapshot: string | null;
      actions: string | null;
      applied: string | null;
      blocked_by: string | null;
      model: string | null;
    }>;
  return rows.map((r) => ({
    id: r.id,
    ranAt: r.ran_at,
    snapshot: parseObject(r.snapshot),
    actions: parseArray(r.actions),
    applied: parseArray(r.applied),
    blockedBy: r.blocked_by ?? '',
    model: r.model ?? '',
  }));
}
