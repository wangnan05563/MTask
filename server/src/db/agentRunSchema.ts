import { getDb } from './connection';

/**
 * T06293（REQ-036 / PRD §B6）：统一 Agent Run 模型。
 *
 * 只做增量表，不修改任何旧表。旧队列/执行会话/用量记录通过
 * legacy_source + legacy_ref 合成 Run 标识，原表保持只读。
 *
 * 模型字段与 PRD 的对应关系：
 * - trigger_type ↔ trigger（避开 SQLite 关键字 TRIGGER）
 * - tokens ↔ tokens；cost 为十进制金额
 * - executor 记录执行者（平台/会话/Agent 名），不复制执行会话表内容
 * - started_at / ended_at 允许为空：排队中或历史补录尚未开始时为 NULL
 *
 * 首版使用 CREATE TABLE IF NOT EXISTS 幂等建表；若 CHECK 约束需要演进，
 * 必须另走整表重建迁移，不能假设 IF NOT EXISTS 会更新旧定义。
 */
const AGENT_RUN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_runs (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  queue_id         TEXT REFERENCES queues(id) ON DELETE SET NULL,
  parent_run_id    TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'queued'
                     CHECK(status IN ('queued','running','paused','awaiting_approval','succeeded','failed','cancelled')),
  trigger_type     TEXT NOT NULL DEFAULT 'manual'
                     CHECK(trigger_type IN ('manual','queue','api','schedule','retry','legacy')),
  model            TEXT NOT NULL DEFAULT '',
  prompt_version   TEXT NOT NULL DEFAULT '',
  tokens           INTEGER NOT NULL DEFAULT 0 CHECK(tokens >= 0),
  cost             REAL NOT NULL DEFAULT 0 CHECK(cost >= 0),
  executor         TEXT NOT NULL DEFAULT '',
  started_at       TEXT,
  ended_at         TEXT,
  error_code       TEXT NOT NULL DEFAULT '',
  legacy_source    TEXT NOT NULL DEFAULT ''
                     CHECK(legacy_source IN ('','queue_job','exec_session','ai_usage')),
  legacy_ref       TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CONSTRAINT ck_agent_runs_legacy_pair CHECK (
    (legacy_source = '' AND legacy_ref = '') OR
    (legacy_source <> '' AND legacy_ref <> '')
  )
);

-- 各读取路径的复合索引：首页/项目的最近 Run、任务详情时间线、状态筛选、队列归属与父子追踪。
CREATE INDEX IF NOT EXISTS idx_agent_runs_project_started
  ON agent_runs(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_task_started
  ON agent_runs(task_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status_started
  ON agent_runs(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_queue
  ON agent_runs(queue_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_parent
  ON agent_runs(parent_run_id);
-- 旧数据合成映射幂等：同一来源的同一旧记录只能生成一个 Run；原生 Run 空 ref 不受限。
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_legacy
  ON agent_runs(legacy_source, legacy_ref)
  WHERE legacy_ref <> '';

CREATE TABLE IF NOT EXISTS agent_run_steps (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL CHECK(seq >= 0),
  type         TEXT NOT NULL
                 CHECK(type IN ('prompt','tool','observation','decision','artifact','approval')),
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK(status IN ('pending','running','awaiting_approval','succeeded','failed','skipped')),
  input        TEXT NOT NULL DEFAULT '',
  output       TEXT NOT NULL DEFAULT '',
  duration_ms  INTEGER NOT NULL DEFAULT 0 CHECK(duration_ms >= 0),
  cost         REAL NOT NULL DEFAULT 0 CHECK(cost >= 0),
  risk_level   TEXT NOT NULL DEFAULT 'R0'
                 CHECK(risk_level IN ('R0','R1','R2','R3')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- 步骤按 run + 序号严格唯一，时间线可稳定排序；同 run 内的状态过滤走第二条索引。
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_steps_seq
  ON agent_run_steps(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_agent_run_steps_status
  ON agent_run_steps(run_id, status);
`;

/** PRD §B6 的 Run 状态枚举；与 DDL 的 CHECK 保持一致。 */
export const AGENT_RUN_STATUSES = [
  'queued',
  'running',
  'paused',
  'awaiting_approval',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/** 触发来源；legacy 仅用于旧队列/执行会话/用量记录的合成 Run。 */
export const AGENT_RUN_TRIGGER_TYPES = ['manual', 'queue', 'api', 'schedule', 'retry', 'legacy'] as const;
export type AgentRunTriggerType = (typeof AGENT_RUN_TRIGGER_TYPES)[number];

/** PRD §B6 的步骤类型：Prompt、工具、观察、决策、产物、审批。 */
export const AGENT_RUN_STEP_TYPES = ['prompt', 'tool', 'observation', 'decision', 'artifact', 'approval'] as const;
export type AgentRunStepType = (typeof AGENT_RUN_STEP_TYPES)[number];

export const AGENT_RUN_STEP_STATUSES = [
  'pending',
  'running',
  'awaiting_approval',
  'succeeded',
  'failed',
  'skipped',
] as const;
export type AgentRunStepStatus = (typeof AGENT_RUN_STEP_STATUSES)[number];

/** R0 只读 / R1 可逆写 / R2 覆盖删除批量 / R3 外发部署权限不可逆。 */
export const AGENT_RUN_RISK_LEVELS = ['R0', 'R1', 'R2', 'R3'] as const;
export type AgentRunRiskLevel = (typeof AGENT_RUN_RISK_LEVELS)[number];

export type AgentLegacyRunSource = '' | 'queue_job' | 'exec_session' | 'ai_usage';

/** Run 领域对象（camelCase），落库时由仓储层映射到 agent_runs 的 snake_case 列。 */
export interface AgentRun {
  id: string;
  taskId: string;
  projectId: string;
  queueId: string | null;
  parentRunId: string | null;
  status: AgentRunStatus;
  triggerType: AgentRunTriggerType;
  model: string;
  promptVersion: string;
  tokens: number;
  cost: number;
  executor: string;
  startedAt: string | null;
  endedAt: string | null;
  errorCode: string;
  legacySource: AgentLegacyRunSource;
  legacyRef: string;
  createdAt: string;
  updatedAt: string;
}

/** 步骤领域对象；input/output 以 TEXT 保存，调用方可放 JSON 或纯文本。 */
export interface AgentRunStep {
  id: string;
  runId: string;
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
}

/** 在现有数据库上幂等创建 Run / RunStep 增量表与索引。 */
export function ensureAgentRunSchema(): void {
  getDb().exec(AGENT_RUN_SCHEMA_SQL);
}
