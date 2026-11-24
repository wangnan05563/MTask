/**
 * T06299（REQ-007 / PRD §B7）：风险分级、项目策略、审批暂停与审计。
 *
 * 这是 Run 引擎执行步骤前的门禁：引擎把「准备执行什么」交给本服务，
 * 本服务只做三件事：分类风险、按项目策略裁决、把需要人工确认的动作落成审批。
 * 本服务不执行工具、不自动批准；批准后由引擎继续执行。
 *
 * 验收口径：
 * - R0 只读 / R1 可逆写 / R2 覆盖删除批量 / R3 外发部署权限不可逆；
 * - 默认 R0/R1 allow、R2 ask、R3 block，可按项目覆盖；
 * - ask 时 Run/Step 进入 awaiting_approval，并追加一条 approval 步骤；
 * - block/reject/超时均写不可篡改审计；拒绝在动作执行前发生，因此无需回滚。
 */
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { getDb } from '../db/connection';
import type { AgentRunRiskLevel, AgentRunStatus } from '../db/agentRunSchema';

export type RiskDecision = 'allow' | 'ask' | 'block';
export type RiskSource = 'classifier' | 'manual';
export type RiskOperation = 'read' | 'write' | 'delete' | 'batch' | 'external' | 'deploy' | 'permission';

export interface RiskSignal {
  /** 引擎显式声明的动作类型；未声明时用 tool/action/target/command 做保守分类。 */
  operation?: RiskOperation;
  tool?: string;
  action?: string;
  target?: string;
  command?: string;
  /** 动作是否可逆；false 直接升到 R3。 */
  reversible?: boolean;
  /** 批量条数；>=2 视为批量。 */
  batchSize?: number;
  /** 人工覆盖分类器结果；必须同时给理由，否则拒绝。 */
  overrideLevel?: AgentRunRiskLevel;
  overrideReason?: string;
  overrideActor?: string;
}

export interface RiskClassification {
  level: AgentRunRiskLevel;
  source: RiskSource;
  reasons: string[];
}

export interface RunRiskPolicy {
  projectId: string;
  levels: Record<AgentRunRiskLevel, RiskDecision>;
  source: 'default' | 'project';
  updatedBy: string;
  updatedAt: string | null;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';

export interface RunApproval {
  id: string;
  runId: string;
  stepId: string | null;
  approvalStepId: string | null;
  projectId: string;
  riskLevel: AgentRunRiskLevel;
  action: string;
  impact: string;
  diff: string;
  preview: string;
  requester: string;
  status: ApprovalStatus;
  reason: string;
  decidedBy: string;
  decidedAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export type AuditEventType =
  | 'allowed'
  | 'approval_requested'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'blocked'
  | 'policy_changed'
  | 'override';

export interface RunRiskAudit {
  id: string;
  runId: string;
  stepId: string;
  approvalId: string;
  projectId: string;
  eventType: AuditEventType;
  riskLevel: AgentRunRiskLevel | '';
  action: string;
  actor: string;
  reason: string;
  detail: string;
  createdAt: string;
}

export interface GateInput {
  runId: string;
  stepId: string;
  projectId: string;
  signal: RiskSignal;
  actor?: string;
  impact?: string;
  diff?: string;
  preview?: string;
}

export interface GateResult {
  level: AgentRunRiskLevel;
  source: RiskSource;
  reasons: string[];
  decision: RiskDecision;
  auditId: string;
  approval: RunApproval | null;
}

export class RunRiskError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RunRiskError';
    this.code = code;
  }
}

const DEFAULT_LEVELS: Record<AgentRunRiskLevel, RiskDecision> = {
  R0: 'allow',
  R1: 'allow',
  R2: 'ask',
  R3: 'block',
};

const OPERATION_LEVEL: Record<RiskOperation, AgentRunRiskLevel> = {
  read: 'R0',
  write: 'R1',
  delete: 'R2',
  batch: 'R2',
  external: 'R3',
  deploy: 'R3',
  permission: 'R3',
};

const LEVEL_ORDER: Record<AgentRunRiskLevel, number> = { R0: 0, R1: 1, R2: 2, R3: 3 };

const KEYWORD_RULES: Array<{ level: AgentRunRiskLevel; pattern: RegExp; reason: string }> = [
  {
    level: 'R3',
    pattern: /\b(deploy|publish|release|rollback|webhook|send|email|sms|upload|export|permission|grant|revoke|sudo|chmod|rm\s+-rf|drop\s+table|truncate|format|credential|secret|token)\b|部署|发布|上线|外发|发送邮件|发送短信|上传|导出|授予权限|吊销|回收权限|删除权限|格式化|清空磁盘|不可逆/i,
    reason: '命中 R3 动作：外发、部署、权限或不可逆操作',
  },
  {
    level: 'R2',
    pattern: /\b(delete|remove|overwrite|batch|bulk|truncate|replace\s+all|clean)\b|删除|移除|覆盖|批量|全量替换|清空|重置/i,
    reason: '命中 R2 动作：覆盖、删除或批量写',
  },
  {
    level: 'R1',
    pattern: /\b(write|create|update|edit|rename|copy|move|mkdir|apply|patch)\b|写入|创建|更新|编辑|重命名|复制|移动|修改/i,
    reason: '命中 R1 动作：可逆写',
  },
  {
    level: 'R0',
    pattern: /\b(read|get|list|search|inspect|view|stat|find|query)\b|读取|查询|列出|搜索|查看|检查/i,
    reason: '命中 R0 动作：只读',
  },
];

const POLICY_ACTIONS: RiskDecision[] = ['allow', 'ask', 'block'];
const APPROVAL_STATUSES: ApprovalStatus[] = ['pending', 'approved', 'rejected', 'expired', 'cancelled'];
const AUDIT_EVENTS: AuditEventType[] = ['allowed', 'approval_requested', 'approved', 'rejected', 'expired', 'blocked', 'policy_changed', 'override'];

function isRiskLevel(value: unknown): value is AgentRunRiskLevel {
  return value === 'R0' || value === 'R1' || value === 'R2' || value === 'R3';
}

function isDecision(value: unknown): value is RiskDecision {
  return value === 'allow' || value === 'ask' || value === 'block';
}

function policyValue(value: unknown): RiskDecision {
  if (!isDecision(value)) throw new RunRiskError('invalid_policy', `策略只允许 allow/ask/block，收到：${String(value)}`);
  return value;
}

function maxLevel(a: AgentRunRiskLevel, b: AgentRunRiskLevel): AgentRunRiskLevel {
  return LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b;
}

function nowIso(): string {
  return new Date().toISOString();
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function rowToApproval(row: Record<string, unknown>): RunApproval {
  return {
    id: asString(row.id),
    runId: asString(row.run_id),
    stepId: row.step_id ? asString(row.step_id) : null,
    approvalStepId: row.approval_step_id ? asString(row.approval_step_id) : null,
    projectId: asString(row.project_id),
    riskLevel: isRiskLevel(row.risk_level) ? row.risk_level : 'R2',
    action: asString(row.action),
    impact: asString(row.impact),
    diff: asString(row.diff),
    preview: asString(row.preview),
    requester: asString(row.requester),
    status: (APPROVAL_STATUSES.includes(row.status as ApprovalStatus) ? row.status : 'pending') as ApprovalStatus,
    reason: asString(row.reason),
    decidedBy: asString(row.decided_by),
    decidedAt: row.decided_at ? asString(row.decided_at) : null,
    expiresAt: asString(row.expires_at),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

export class RunRiskService {
  private readonly db: Database.Database;
  private readonly approvalTimeoutMs: number;

  constructor(db: Database.Database = getDb(), opts: { approvalTimeoutMs?: number } = {}) {
    this.db = db;
    this.approvalTimeoutMs = Math.max(60_000, opts.approvalTimeoutMs ?? 24 * 60 * 60 * 1000);
  }

  /** 读取项目策略；没有显式配置时返回 PRD §B7 默认值。 */
  getPolicy(projectId: string): RunRiskPolicy {
    const id = this.requireProjectId(projectId);
    const row = this.hasTable('agent_run_risk_policies')
      ? this.db.prepare('SELECT * FROM agent_run_risk_policies WHERE project_id = ?').get(id) as Record<string, unknown> | undefined
      : undefined;
    if (!row) {
      return { projectId: id, levels: { ...DEFAULT_LEVELS }, source: 'default', updatedBy: '', updatedAt: null };
    }
    return {
      projectId: id,
      levels: {
        R0: policyValue(row.r0_action),
        R1: policyValue(row.r1_action),
        R2: policyValue(row.r2_action),
        R3: policyValue(row.r3_action),
      },
      source: 'project',
      updatedBy: asString(row.updated_by),
      updatedAt: asString(row.updated_at) || null,
    };
  }

  /**
   * 保存项目策略。未提供的等级沿用当前值；只接受 allow/ask/block。
   * policy_changed 也写审计，避免策略被悄悄改成全 allow。
   */
  setPolicy(projectId: string, input: Partial<Record<AgentRunRiskLevel, RiskDecision>>, actor = 'api'): RunRiskPolicy {
    const id = this.requireProjectId(projectId);
    if (!this.hasTable('agent_run_risk_policies')) throw new RunRiskError('schema_missing', '风险策略表尚未初始化，请先重启/迁移 MTask');
    const current = this.getPolicy(id);
    const levels: Record<AgentRunRiskLevel, RiskDecision> = { ...current.levels };
    for (const level of ['R0', 'R1', 'R2', 'R3'] as AgentRunRiskLevel[]) {
      if (input[level] !== undefined) levels[level] = policyValue(input[level]);
    }
    const now = nowIso();
    this.db.prepare(`INSERT INTO agent_run_risk_policies
      (project_id, r0_action, r1_action, r2_action, r3_action, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        r0_action=excluded.r0_action, r1_action=excluded.r1_action,
        r2_action=excluded.r2_action, r3_action=excluded.r3_action,
        updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
      .run(id, levels.R0, levels.R1, levels.R2, levels.R3, asString(actor) || 'api', now);
    this.insertAudit({
      projectId: id, eventType: 'policy_changed', riskLevel: '', action: 'set_policy',
      actor: asString(actor) || 'api', reason: '项目风险策略变更',
      detail: JSON.stringify({ before: current.levels, after: levels }),
      createdAt: now,
    });
    return this.getPolicy(id);
  }

  /**
   * 分类器：显式 operation 为第一信号，关键词为第二信号，取更高等级。
   * 未知动作保守按 R1；人工覆盖必须给理由，并会在 gateStep 里写 override 审计。
   */
  classify(signal: RiskSignal): RiskClassification {
    const override = signal.overrideLevel;
    if (override !== undefined) {
      if (!isRiskLevel(override)) throw new RunRiskError('invalid_override', `风险覆盖等级非法：${String(override)}`);
      const reason = asString(signal.overrideReason).trim();
      if (!reason) throw new RunRiskError('override_reason_required', '人工覆盖风险等级必须填写理由');
      return { level: override, source: 'manual', reasons: [reason] };
    }

    let level: AgentRunRiskLevel = 'R1';
    const reasons: string[] = [];
    if (signal.operation && OPERATION_LEVEL[signal.operation]) {
      level = OPERATION_LEVEL[signal.operation];
      reasons.push(`显式动作类型：${signal.operation}`);
    }
    if (signal.reversible === false) {
      level = maxLevel(level, 'R3');
      reasons.push('动作被标记为不可逆');
    }
    if (typeof signal.batchSize === 'number' && signal.batchSize >= 2) {
      level = maxLevel(level, 'R2');
      reasons.push(`批量动作：${signal.batchSize} 条`);
    }

    const text = [signal.tool, signal.action, signal.target, signal.command].filter(Boolean).join(' ');
    if (text) {
      for (const rule of KEYWORD_RULES) {
        if (rule.pattern.test(text)) {
          level = maxLevel(level, rule.level);
          reasons.push(rule.reason);
        }
      }
    }
    if (!reasons.length) reasons.push('未知动作，按可逆写保守处理');
    return { level, source: 'classifier', reasons };
  }

  /**
   * 执行步骤前的门禁。必须由真实 Run/Step 调用：
   * - block：取消 Run，原步骤 skipped；
   * - ask：Run/Step 进入 awaiting_approval，并追加 approval 步骤；
   * - allow：只写审计，不改状态。
   */
  gateStep(input: GateInput): GateResult {
    const runId = asString(input.runId).trim();
    const stepId = asString(input.stepId).trim();
    const projectId = this.requireProjectId(input.projectId);
    if (!runId || !stepId) throw new RunRiskError('invalid_gate', 'gateStep 必须提供 runId 与 stepId');
    if (!this.hasTable('agent_runs') || !this.hasTable('agent_run_steps')) throw new RunRiskError('schema_missing', 'Run/RunStep 表尚未初始化');

    const run = this.db.prepare('SELECT id, project_id, status FROM agent_runs WHERE id = ?').get(runId) as
      { id: string; project_id: string; status: AgentRunStatus } | undefined;
    if (!run) throw new RunRiskError('run_not_found', `Run 不存在：${runId}`);
    if (run.project_id !== projectId) throw new RunRiskError('project_mismatch', `Run ${runId} 不属于项目 ${projectId}`);
    if (!['queued', 'running', 'paused'].includes(run.status)) {
      throw new RunRiskError('run_not_gateable', `Run ${runId} 当前状态 ${run.status} 不可再做风险门禁`);
    }
    const step = this.db.prepare('SELECT id, run_id, status FROM agent_run_steps WHERE id = ?').get(stepId) as
      { id: string; run_id: string; status: string } | undefined;
    if (!step) throw new RunRiskError('step_not_found', `RunStep 不存在：${stepId}`);
    if (step.run_id !== runId) throw new RunRiskError('step_run_mismatch', `RunStep ${stepId} 不属于 Run ${runId}`);

    const classification = this.classify(input.signal);
    const policy = this.getPolicy(projectId);
    const decision = policy.levels[classification.level];
    const now = nowIso();
    const actor = asString(input.actor) || 'run-engine';
    const baseDetail = JSON.stringify({
      signal: input.signal,
      reasons: classification.reasons,
      policy: policy.levels,
      impact: input.impact ?? '',
      diff: input.diff ?? '',
      preview: input.preview ?? '',
    });

    if (classification.source === 'manual') {
      this.insertAudit({
        runId, stepId, projectId, eventType: 'override', riskLevel: classification.level,
        action: asString(input.signal.action) || asString(input.signal.tool) || 'override',
        actor: asString(input.signal.overrideActor) || actor,
        reason: asString(input.signal.overrideReason),
        detail: baseDetail, createdAt: now,
      });
    }

    if (decision === 'block') {
      this.updateStepStatus(stepId, 'skipped', now);
      this.updateRunTerminal(runId, 'cancelled', 'risk_blocked', now);
      const auditId = this.insertAudit({
        runId, stepId, projectId, eventType: 'blocked', riskLevel: classification.level,
        action: asString(input.signal.action) || asString(input.signal.tool) || 'gate',
        actor, reason: '项目策略 block 拦截高风险动作', detail: baseDetail, createdAt: now,
      });
      return { ...classification, decision, auditId, approval: null };
    }

    if (decision === 'allow') {
      const auditId = this.insertAudit({
        runId, stepId, projectId, eventType: 'allowed', riskLevel: classification.level,
        action: asString(input.signal.action) || asString(input.signal.tool) || 'gate',
        actor, reason: '项目策略 allow', detail: baseDetail, createdAt: now,
      });
      return { ...classification, decision, auditId, approval: null };
    }

    const approvalId = uuid();
    const approvalStepId = uuid();
    const expiresAt = new Date(Date.now() + this.approvalTimeoutMs).toISOString();
    const nextSeq = this.nextStepSeq(runId);
    this.db.prepare(`INSERT INTO agent_run_steps
      (id, run_id, seq, type, status, input, output, duration_ms, cost, risk_level, created_at, updated_at)
      VALUES (?, ?, ?, 'approval', 'awaiting_approval', ?, '', 0, 0, ?, ?, ?)`)
      .run(approvalStepId, runId, nextSeq, JSON.stringify({
        approvalId,
        riskLevel: classification.level,
        action: input.signal.action ?? '',
        impact: input.impact ?? '',
        diff: input.diff ?? '',
        preview: input.preview ?? '',
      }), classification.level, now, now);
    this.db.prepare(`INSERT INTO agent_run_approvals
      (id, run_id, step_id, approval_step_id, project_id, risk_level, action, impact, diff, preview,
       requester, status, reason, decided_by, decided_at, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', '', NULL, ?, ?, ?)`)
      .run(approvalId, runId, stepId, approvalStepId, projectId, classification.level,
        asString(input.signal.action) || asString(input.signal.tool) || 'run_step',
        asString(input.impact), asString(input.diff), asString(input.preview),
        actor, expiresAt, now, now);
    this.updateStepStatus(stepId, 'awaiting_approval', now);
    this.updateRunStatus(runId, 'awaiting_approval', now);
    const auditId = this.insertAudit({
      runId, stepId, projectId, approvalId, eventType: 'approval_requested', riskLevel: classification.level,
      action: asString(input.signal.action) || asString(input.signal.tool) || 'gate',
      actor, reason: '项目策略 ask，等待人工审批', detail: baseDetail, createdAt: now,
    });
    return { ...classification, decision, auditId, approval: this.getApproval(approvalId) };
  }

  /** 批准后 Run 回到 running，由引擎继续执行；拒绝发生在执行前，终止 Run 即可，无需回滚副作用。 */
  decideApproval(approvalId: string, decision: 'approved' | 'rejected', actor = 'reviewer', reason = ''): RunApproval {
    const id = asString(approvalId).trim();
    if (!id) throw new RunRiskError('invalid_approval', 'approvalId 不能为空');
    this.expireApprovals();
    const row = this.db.prepare('SELECT * FROM agent_run_approvals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new RunRiskError('approval_not_found', `审批不存在：${id}`);
    const approval = rowToApproval(row);
    if (approval.status !== 'pending') throw new RunRiskError('approval_not_pending', `审批状态为 ${approval.status}，不可重复决策`);
    if (decision !== 'approved' && decision !== 'rejected') throw new RunRiskError('invalid_decision', `决策只允许 approved/rejected，收到：${String(decision)}`);
    const now = nowIso();
    const status: ApprovalStatus = decision;
    this.db.prepare(`UPDATE agent_run_approvals
      SET status = ?, reason = ?, decided_by = ?, decided_at = ?, updated_at = ?
      WHERE id = ?`).run(status, asString(reason), asString(actor) || 'reviewer', now, now, id);
    if (approval.stepId) this.updateStepStatus(approval.stepId, decision === 'approved' ? 'running' : 'skipped', now);
    if (approval.approvalStepId) {
      // agent_run_steps 的 output 属不可变字段（T06293 触发器）；审批结论只落 audit，
      // 步骤本身用 succeeded/failed 表达结果，避免 UPDATE OF output 被 ABORT。
      this.db.prepare('UPDATE agent_run_steps SET status = ?, updated_at = ? WHERE id = ?')
        .run(decision === 'approved' ? 'succeeded' : 'failed', now, approval.approvalStepId);
    }
    if (decision === 'approved') {
      this.updateRunStatus(approval.runId, 'running', now);
    } else {
      this.updateRunTerminal(approval.runId, 'cancelled', 'approval_rejected', now);
    }
    this.insertAudit({
      runId: approval.runId, stepId: approval.stepId ?? '', approvalId: id, projectId: approval.projectId,
      eventType: decision, riskLevel: approval.riskLevel, action: approval.action,
      actor: asString(actor) || 'reviewer', reason: asString(reason), detail: JSON.stringify({ decision }),
      createdAt: now,
    });
    return this.requireApproval(id);
  }

  /** 超时审批收口：Run/Step 置 failed，审计 event=expired；返回本轮过期的审批。 */
  expireApprovals(now = nowIso()): RunApproval[] {
    if (!this.hasTable('agent_run_approvals')) return [];
    const rows = this.db.prepare(`SELECT * FROM agent_run_approvals
      WHERE status = 'pending' AND expires_at <= ? ORDER BY expires_at ASC`).all(now) as Record<string, unknown>[];
    const expired: RunApproval[] = [];
    for (const row of rows) {
      const approval = rowToApproval(row);
      this.db.prepare(`UPDATE agent_run_approvals SET status = 'expired', reason = ?, updated_at = ? WHERE id = ?`)
        .run('审批超时', now, approval.id);
      if (approval.stepId) this.updateStepStatus(approval.stepId, 'failed', now);
      if (approval.approvalStepId) {
        this.db.prepare('UPDATE agent_run_steps SET status = ?, updated_at = ? WHERE id = ?')
          .run('failed', now, approval.approvalStepId);
      }
      this.updateRunTerminal(approval.runId, 'failed', 'approval_timeout', now);
      this.insertAudit({
        runId: approval.runId, stepId: approval.stepId ?? '', approvalId: approval.id, projectId: approval.projectId,
        eventType: 'expired', riskLevel: approval.riskLevel, action: approval.action,
        actor: 'system', reason: '审批超时', detail: JSON.stringify({ expiresAt: approval.expiresAt }),
        createdAt: now,
      });
      expired.push(this.requireApproval(approval.id));
    }
    return expired;
  }

  getApproval(approvalId: string): RunApproval | null {
    if (!this.hasTable('agent_run_approvals')) return null;
    const row = this.db.prepare('SELECT * FROM agent_run_approvals WHERE id = ?').get(asString(approvalId)) as Record<string, unknown> | undefined;
    return row ? rowToApproval(row) : null;
  }

  private requireApproval(approvalId: string): RunApproval {
    const approval = this.getApproval(approvalId);
    if (!approval) throw new RunRiskError('approval_not_found', `审批不存在：${approvalId}`);
    return approval;
  }

  listApprovals(filter: { status?: ApprovalStatus; projectId?: string; runId?: string; limit?: number } = {}): RunApproval[] {
    if (!this.hasTable('agent_run_approvals')) return [];
    if (filter.status === 'pending') this.expireApprovals();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.status) { clauses.push('status = ?'); params.push(filter.status); }
    if (filter.projectId) { clauses.push('project_id = ?'); params.push(filter.projectId); }
    if (filter.runId) { clauses.push('run_id = ?'); params.push(filter.runId); }
    const limit = Math.max(1, Math.min(500, Math.floor(filter.limit ?? 100)));
    const sql = `SELECT * FROM agent_run_approvals ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY created_at DESC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(rowToApproval);
  }

  listAudit(filter: { projectId?: string; runId?: string; eventType?: AuditEventType; limit?: number } = {}): RunRiskAudit[] {
    if (!this.hasTable('agent_run_audit')) return [];
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.projectId) { clauses.push('project_id = ?'); params.push(filter.projectId); }
    if (filter.runId) { clauses.push('run_id = ?'); params.push(filter.runId); }
    if (filter.eventType && AUDIT_EVENTS.includes(filter.eventType)) { clauses.push('event_type = ?'); params.push(filter.eventType); }
    const limit = Math.max(1, Math.min(1000, Math.floor(filter.limit ?? 200)));
    const rows = this.db.prepare(`SELECT * FROM agent_run_audit
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ${limit}`)
      .all(...params) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: asString(row.id),
      runId: asString(row.run_id),
      stepId: asString(row.step_id),
      approvalId: asString(row.approval_id),
      projectId: asString(row.project_id),
      eventType: (AUDIT_EVENTS.includes(row.event_type as AuditEventType) ? row.event_type : 'allowed') as AuditEventType,
      riskLevel: isRiskLevel(row.risk_level) ? row.risk_level : '',
      action: asString(row.action),
      actor: asString(row.actor),
      reason: asString(row.reason),
      detail: asString(row.detail),
      createdAt: asString(row.created_at),
    }));
  }

  /** 审计导出：默认 JSON，调用方可直接落盘；内容按 created_at 倒序。 */
  exportAudit(filter: { projectId?: string; runId?: string; eventType?: AuditEventType; limit?: number } = {}): string {
    return JSON.stringify(this.listAudit(filter), null, 2);
  }

  private requireProjectId(projectId: string): string {
    const id = asString(projectId).trim();
    if (!id) throw new RunRiskError('invalid_project', 'projectId 不能为空');
    if (this.hasTable('projects')) {
      const row = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(id);
      if (!row) throw new RunRiskError('project_not_found', `项目不存在：${id}`);
    }
    return id;
  }

  private hasTable(name: string): boolean {
    return Boolean(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name));
  }

  private nextStepSeq(runId: string): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), -1) AS max_seq FROM agent_run_steps WHERE run_id = ?').get(runId) as { max_seq: number };
    return Number(row.max_seq) + 1;
  }

  private updateStepStatus(stepId: string, status: string, now: string): void {
    this.db.prepare('UPDATE agent_run_steps SET status = ?, updated_at = ? WHERE id = ?').run(status, now, stepId);
  }

  private updateRunStatus(runId: string, status: AgentRunStatus, now: string): void {
    this.db.prepare('UPDATE agent_runs SET status = ?, updated_at = ? WHERE id = ?').run(status, now, runId);
  }

  private updateRunTerminal(runId: string, status: AgentRunStatus, errorCode: string, now: string): void {
    this.db.prepare('UPDATE agent_runs SET status = ?, error_code = ?, ended_at = ?, updated_at = ? WHERE id = ?')
      .run(status, errorCode, now, now, runId);
  }

  private insertAudit(input: {
    runId?: string; stepId?: string; approvalId?: string; projectId: string;
    eventType: AuditEventType; riskLevel: AgentRunRiskLevel | ''; action: string;
    actor: string; reason: string; detail: string; createdAt: string;
  }): string {
    if (!this.hasTable('agent_run_audit')) throw new RunRiskError('schema_missing', '审计表尚未初始化');
    const id = uuid();
    this.db.prepare(`INSERT INTO agent_run_audit
      (id, run_id, step_id, approval_id, project_id, event_type, risk_level, action, actor, reason, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.runId ?? '', input.stepId ?? '', input.approvalId ?? '', input.projectId,
        input.eventType, input.riskLevel, input.action, input.actor, input.reason, input.detail, input.createdAt);
    return id;
  }
}
