/**
 * T06298（REQ-036 / PRD §B6）：单 Run 追踪详情只读契约。
 *
 * 本服务只解决「Run 详情页读什么」：
 * - 原生 `agent_runs` + `agent_run_steps` 存在时，按 Run ID / legacy 映射读取真实步骤；
 * - 生产库尚未落 `agent_runs`、或旧会话没有原生映射时，用 `exec_sessions` 合成只读兼容视图；
 * - 合成视图使用稳定的 `legacy:exec_session:<id>` ID，不改旧表，也不把空表伪装成已验收。
 *
 * 完整的 Run 列表 / 旧 queue_job / ai_usage 回填仍归 T06332，本服务不越界写库。
 */
import type Database from 'better-sqlite3';
import { getDb } from '../db/connection';
import type {
  AgentLegacyRunSource,
  AgentRunStatus,
  AgentRunStepStatus,
  AgentRunStepType,
  AgentRunTriggerType,
  AgentRunRiskLevel,
} from '../db/agentRunSchema';

const LEGACY_EXEC_PREFIX = 'legacy:exec_session:';
const COST_EPSILON = 0.005;

export interface RunTraceStep {
  id: string;
  seq: number;
  type: AgentRunStepType;
  status: AgentRunStepStatus;
  input: string;
  output: string;
  durationMs: number;
  cost: number;
  riskLevel: AgentRunRiskLevel;
  createdAt: string;
  updatedAt: string;
  /** 旧执行会话合成视图：UI 需明确标注，不能当作原始 RunStep */
  synthetic: boolean;
}

export interface RunCostSlice {
  key: string;
  label: string;
  cost: number;
  pct: number;
}

export type RunApprovalState = 'none' | 'pending' | 'approved' | 'rejected' | 'skipped';

export interface RunApprovalInfo {
  status: RunApprovalState;
  label: string;
  stepId: string | null;
  updatedAt: string | null;
}

export interface RunTrace {
  id: string;
  taskId: string;
  taskNo: string | null;
  taskTitle: string | null;
  projectId: string;
  projectName: string | null;
  status: AgentRunStatus;
  triggerType: AgentRunTriggerType;
  model: string;
  promptVersion: string;
  tokens: number;
  cost: number;
  executor: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  errorCode: string;
  legacySource: AgentLegacyRunSource;
  legacyRef: string;
  source: 'native' | 'legacy_exec_session';
  legacy: boolean;
  steps: RunTraceStep[];
  stepCostTotal: number;
  unattributedCost: number;
  costBreakdown: RunCostSlice[];
  approval: RunApprovalInfo;
  warnings: string[];
  generatedAt: string;
}

interface NativeRunRow {
  id: string;
  task_id: string;
  project_id: string;
  status: string;
  trigger_type: string;
  model: string;
  prompt_version: string;
  tokens: number;
  cost: number;
  executor: string;
  started_at: string | null;
  ended_at: string | null;
  error_code: string;
  legacy_source: string;
  legacy_ref: string;
  created_at: string;
  updated_at: string;
  task_no: string | null;
  task_title: string | null;
  project_name: string | null;
}

interface NativeStepRow {
  id: string;
  run_id: string;
  seq: number;
  type: string;
  status: string;
  input: string;
  output: string;
  duration_ms: number;
  cost: number;
  risk_level: string;
  created_at: string;
  updated_at: string;
}

interface ExecSessionRow {
  id: string;
  platform: string;
  session_id: string | null;
  task_ids: string;
  status: string;
  progress: number;
  progress_reported: number;
  phase: string;
  last_heartbeat: string;
  started_at: string;
  finished_at: string | null;
}

interface TaskBriefRow {
  id: string;
  task_no: string | null;
  title: string;
  project_id: string;
  project_name: string | null;
}

const STEP_TYPE_LABEL: Record<AgentRunStepType, string> = {
  prompt: 'Prompt',
  tool: '工具调用',
  observation: '观察',
  decision: '决策',
  artifact: '产物',
  approval: '审批',
};

const APPROVAL_LABEL: Record<RunApprovalState, string> = {
  none: '无审批',
  pending: '等待审批',
  approved: '已批准',
  rejected: '已拒绝',
  skipped: '已跳过',
};

function asRunStatus(value: string): AgentRunStatus {
  const allowed: AgentRunStatus[] = ['queued', 'running', 'paused', 'awaiting_approval', 'succeeded', 'failed', 'cancelled'];
  return allowed.includes(value as AgentRunStatus) ? value as AgentRunStatus : 'running';
}

function asTriggerType(value: string): AgentRunTriggerType {
  const allowed: AgentRunTriggerType[] = ['manual', 'queue', 'api', 'schedule', 'retry', 'legacy'];
  return allowed.includes(value as AgentRunTriggerType) ? value as AgentRunTriggerType : 'legacy';
}

function asStepType(value: string): AgentRunStepType {
  const allowed: AgentRunStepType[] = ['prompt', 'tool', 'observation', 'decision', 'artifact', 'approval'];
  return allowed.includes(value as AgentRunStepType) ? value as AgentRunStepType : 'observation';
}

function asStepStatus(value: string): AgentRunStepStatus {
  const allowed: AgentRunStepStatus[] = ['pending', 'running', 'awaiting_approval', 'succeeded', 'failed', 'skipped'];
  return allowed.includes(value as AgentRunStepStatus) ? value as AgentRunStepStatus : 'pending';
}

function asRiskLevel(value: string): AgentRunRiskLevel {
  const allowed: AgentRunRiskLevel[] = ['R0', 'R1', 'R2', 'R3'];
  return allowed.includes(value as AgentRunRiskLevel) ? value as AgentRunRiskLevel : 'R0';
}

function asLegacySource(value: string): AgentLegacyRunSource {
  const allowed: AgentLegacyRunSource[] = ['', 'queue_job', 'exec_session', 'ai_usage'];
  return allowed.includes(value as AgentLegacyRunSource) ? value as AgentLegacyRunSource : '';
}

function parseTaskIds(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function isoDurationMs(startedAt: string | null, endedAt: string | null): number | null {
  if (!startedAt || !endedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function legacyStatus(status: string): AgentRunStatus {
  switch (status) {
    case 'done': return 'succeeded';
    case 'failed': return 'failed';
    case 'aborted': return 'cancelled';
    case 'stalled': return 'paused';
    default: return 'running';
  }
}

function legacyStepStatus(status: string): AgentRunStepStatus {
  switch (status) {
    case 'done': return 'succeeded';
    case 'failed': return 'failed';
    case 'aborted': return 'skipped';
    case 'stalled': return 'pending';
    default: return 'running';
  }
}

function finalDecisionStatus(status: string): AgentRunStepStatus {
  switch (status) {
    case 'done': return 'succeeded';
    case 'failed': return 'failed';
    case 'aborted': return 'skipped';
    default: return 'pending';
  }
}

function approvalFromSteps(steps: readonly RunTraceStep[]): RunApprovalInfo {
  const approval = [...steps].reverse().find((s) => s.type === 'approval');
  if (!approval) return { status: 'none', label: APPROVAL_LABEL.none, stepId: null, updatedAt: null };
  let status: RunApprovalState;
  if (approval.status === 'succeeded') status = 'approved';
  else if (approval.status === 'failed') status = 'rejected';
  else if (approval.status === 'skipped') status = 'skipped';
  else status = 'pending';
  return { status, label: APPROVAL_LABEL[status], stepId: approval.id, updatedAt: approval.updatedAt || null };
}

function breakdownFromSteps(steps: readonly RunTraceStep[], runCost: number): {
  stepCostTotal: number; unattributedCost: number; costBreakdown: RunCostSlice[];
} {
  const sums = new Map<AgentRunStepType, number>();
  for (const step of steps) {
    if (step.cost <= 0) continue;
    sums.set(step.type, (sums.get(step.type) ?? 0) + step.cost);
  }
  const stepCostTotal = [...sums.values()].reduce((a, b) => a + b, 0);
  const positiveRun = Math.max(0, runCost);
  const unattributedCost = positiveRun > stepCostTotal + COST_EPSILON ? positiveRun - stepCostTotal : 0;
  const denominator = Math.max(positiveRun, stepCostTotal, 0.0001);
  const costBreakdown: RunCostSlice[] = (Object.keys(STEP_TYPE_LABEL) as AgentRunStepType[])
    .map((type) => ({
      key: type,
      label: STEP_TYPE_LABEL[type],
      cost: Math.round((sums.get(type) ?? 0) * 10000) / 10000,
      pct: Math.round(((sums.get(type) ?? 0) / denominator) * 1000) / 10,
    }))
    .filter((slice) => slice.cost > 0);
  if (unattributedCost > 0) {
    costBreakdown.push({
      key: 'unattributed',
      label: '未归因差额',
      cost: Math.round(unattributedCost * 10000) / 10000,
      pct: Math.round((unattributedCost / denominator) * 1000) / 10,
    });
  }
  return { stepCostTotal, unattributedCost, costBreakdown };
}

export class RunTraceService {
  private readonly db: Database.Database;

  constructor(db: Database.Database = getDb()) {
    this.db = db;
  }

  /**
   * 读取单个 Run。`ref` 支持：
   * - 原生 Run ID；
   * - `legacy:exec_session:<exec_sessions.id>`；
   * - 直接传 `exec_sessions.id`（执行会话卡片的兼容入口）。
   * 找不到时返回 null，由路由转 404。
   */
  getRun(ref: string): RunTrace | null {
    const raw = String(ref ?? '').trim();
    if (!raw) return null;
    const sessionRef = raw.startsWith(LEGACY_EXEC_PREFIX) ? raw.slice(LEGACY_EXEC_PREFIX.length) : '';

    if (this.hasTable('agent_runs')) {
      const native = this.findNative(raw, sessionRef);
      if (native) return native;
    }

    const sessionId = sessionRef || raw;
    const session = this.findExecSession(sessionId);
    if (!session) return null;
    return this.buildLegacyExecSession(session);
  }

  private findNative(ref: string, legacySessionRef: string): RunTrace | null {
    const base = `SELECT ar.*, t.task_no AS task_no, t.title AS task_title, p.name AS project_name
      FROM agent_runs ar
      LEFT JOIN tasks t ON t.id = ar.task_id
      LEFT JOIN projects p ON p.id = ar.project_id`;
    let row = this.db.prepare(`${base} WHERE ar.id = ?`).get(ref) as NativeRunRow | undefined;
    if (!row && legacySessionRef) {
      row = this.db.prepare(
        `${base} WHERE ar.legacy_source = 'exec_session' AND ar.legacy_ref = ? LIMIT 1`,
      ).get(legacySessionRef) as NativeRunRow | undefined;
    }
    if (!row) return null;

    const stepRows = this.hasTable('agent_run_steps')
      ? this.db.prepare('SELECT * FROM agent_run_steps WHERE run_id = ? ORDER BY seq ASC').all(row.id) as NativeStepRow[]
      : [];
    const steps: RunTraceStep[] = stepRows.map((s) => ({
      id: s.id,
      seq: s.seq,
      type: asStepType(s.type),
      status: asStepStatus(s.status),
      input: s.input ?? '',
      output: s.output ?? '',
      durationMs: Number.isFinite(s.duration_ms) ? Math.max(0, s.duration_ms) : 0,
      cost: Number.isFinite(s.cost) ? Math.max(0, s.cost) : 0,
      riskLevel: asRiskLevel(s.risk_level),
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      synthetic: false,
    }));
    const { stepCostTotal, unattributedCost, costBreakdown } = breakdownFromSteps(steps, Number(row.cost) || 0);
    const warnings: string[] = [];
    if (stepCostTotal > Number(row.cost) + COST_EPSILON) {
      warnings.push(`步骤成本合计 ${stepCostTotal.toFixed(4)} 高于 Run 成本 ${Number(row.cost).toFixed(4)}，请检查成本写入`);
    }
    if (row.legacy_source && row.legacy_ref) {
      warnings.push(`该 Run 已通过旧记录映射统一 ID（${row.legacy_source}:${row.legacy_ref}），步骤来自原生 RunStep`);
    }

    return {
      id: row.id,
      taskId: row.task_id,
      taskNo: row.task_no ?? null,
      taskTitle: row.task_title ?? null,
      projectId: row.project_id,
      projectName: row.project_name ?? null,
      status: asRunStatus(row.status),
      triggerType: asTriggerType(row.trigger_type),
      model: row.model ?? '',
      promptVersion: row.prompt_version ?? '',
      tokens: Number.isFinite(row.tokens) ? Math.max(0, row.tokens) : 0,
      cost: Number.isFinite(row.cost) ? Math.max(0, row.cost) : 0,
      executor: row.executor ?? '',
      startedAt: row.started_at ?? null,
      endedAt: row.ended_at ?? null,
      durationMs: isoDurationMs(row.started_at, row.ended_at),
      errorCode: row.error_code ?? '',
      legacySource: asLegacySource(row.legacy_source),
      legacyRef: row.legacy_ref ?? '',
      source: 'native',
      legacy: Boolean(row.legacy_source),
      steps,
      stepCostTotal,
      unattributedCost,
      costBreakdown,
      approval: approvalFromSteps(steps),
      warnings,
      generatedAt: new Date().toISOString(),
    };
  }

  private findExecSession(sessionId: string): ExecSessionRow | null {
    if (!sessionId || !this.hasTable('exec_sessions')) return null;
    return (this.db.prepare('SELECT * FROM exec_sessions WHERE id = ?').get(sessionId) as ExecSessionRow | undefined) ?? null;
  }

  private findTaskForSession(session: ExecSessionRow): TaskBriefRow | null {
    const ids = parseTaskIds(session.task_ids);
    if (ids.length === 0) return null;
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT t.id, t.task_no, t.title, t.project_id, p.name AS project_name
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.id IN (${placeholders})`,
    ).all(...ids) as TaskBriefRow[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const task = byId.get(id);
      if (task) return task;
    }
    return null;
  }

  /**
   * 旧 exec_session 兼容视图：
   * 仅从现有会话状态合成 3 个只读观察步骤；不伪造 Prompt、工具调用、成本或审批。
   * 稳定 ID 不落库，T06332 的持久 mapping 完成前也不会产生重复 Run。
   */
  private buildLegacyExecSession(session: ExecSessionRow): RunTrace {
    const task = this.findTaskForSession(session);
    const status = legacyStatus(session.status);
    const startedMs = Date.parse(session.started_at);
    const heartbeatMs = Date.parse(session.last_heartbeat);
    const finishedMs = session.finished_at ? Date.parse(session.finished_at) : Number.NaN;
    const elapsedToHeartbeat = Number.isFinite(startedMs) && Number.isFinite(heartbeatMs) && heartbeatMs >= startedMs
      ? heartbeatMs - startedMs : 0;
    const elapsedToFinish = Number.isFinite(startedMs) && Number.isFinite(finishedMs) && finishedMs >= startedMs
      ? finishedMs - startedMs : null;
    const progressPct = Math.max(0, Math.min(100, Math.round(Number(session.progress) || 0)));
    const taskIds = parseTaskIds(session.task_ids);
    const now = new Date().toISOString();
    const stepStatus = legacyStepStatus(session.status);
    const finalStatus = finalDecisionStatus(session.status);
    const sessionStatusText = session.status === 'done' ? '已完成'
      : session.status === 'failed' ? '执行失败'
        : session.status === 'aborted' ? '已中止'
          : session.status === 'stalled' ? '已停滞' : '执行中';

    const steps: RunTraceStep[] = [
      {
        id: `${LEGACY_EXEC_PREFIX}${session.id}:step-0`,
        seq: 0,
        type: 'observation',
        status: 'succeeded',
        input: JSON.stringify({ platform: session.platform, sessionId: session.session_id, taskIds }),
        output: `外部执行平台 ${session.platform} 已建立会话`,
        durationMs: 0,
        cost: 0,
        riskLevel: 'R0',
        createdAt: session.started_at,
        updatedAt: session.started_at,
        synthetic: true,
      },
      {
        id: `${LEGACY_EXEC_PREFIX}${session.id}:step-1`,
        seq: 1,
        type: 'observation',
        status: stepStatus,
        input: JSON.stringify({
          phase: session.phase || '',
          progress: progressPct,
          progressReported: session.progress_reported === 1,
          lastHeartbeat: session.last_heartbeat,
        }),
        output: [
          session.phase ? `阶段：${session.phase}` : '阶段：未上报',
          session.progress_reported === 1 ? `进度：${progressPct}%` : '进度：平台未上报',
        ].join('；'),
        durationMs: elapsedToHeartbeat,
        cost: 0,
        riskLevel: 'R0',
        createdAt: session.last_heartbeat,
        updatedAt: session.last_heartbeat,
        synthetic: true,
      },
      {
        id: `${LEGACY_EXEC_PREFIX}${session.id}:step-2`,
        seq: 2,
        type: 'decision',
        status: finalStatus,
        input: JSON.stringify({ sessionStatus: session.status }),
        output: `会话状态：${sessionStatusText}`,
        durationMs: elapsedToFinish ?? 0,
        cost: 0,
        riskLevel: 'R0',
        createdAt: session.finished_at ?? session.last_heartbeat,
        updatedAt: session.finished_at ?? session.last_heartbeat,
        synthetic: true,
      },
    ];

    const warnings = [
      '旧执行会话兼容视图：步骤由会话状态合成，不是原始 RunStep。',
      '旧会话未记录模型成本与 Token；Run 数据映射/回填完成后可回放成本。',
    ];
    if (!task) warnings.push('该会话没有可解析的关联任务，任务链与项目归因缺失。');

    return {
      id: `${LEGACY_EXEC_PREFIX}${session.id}`,
      taskId: task?.id ?? '',
      taskNo: task?.task_no ?? null,
      taskTitle: task?.title ?? null,
      projectId: task?.project_id ?? '',
      projectName: task?.project_name ?? null,
      status,
      triggerType: 'legacy',
      model: '',
      promptVersion: '',
      tokens: 0,
      cost: 0,
      executor: session.platform,
      startedAt: session.started_at ?? null,
      endedAt: session.finished_at ?? null,
      durationMs: elapsedToFinish,
      errorCode: '',
      legacySource: 'exec_session',
      legacyRef: session.id,
      source: 'legacy_exec_session',
      legacy: true,
      steps,
      stepCostTotal: 0,
      unattributedCost: 0,
      costBreakdown: [],
      approval: { status: 'none', label: APPROVAL_LABEL.none, stepId: null, updatedAt: null },
      warnings,
      generatedAt: now,
    };
  }

  private hasTable(name: string): boolean {
    try {
      return this.db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      ).get(name) !== undefined;
    } catch {
      return false;
    }
  }
}
