/**
 * T06299（REQ-007 / PRD §B7）：Run 风险分级、项目策略与审批暂停的增量表。
 *
 * 设计边界：
 * - 只新增风险策略、审批与审计三张表；不改 `agent_runs` / `agent_run_steps` 的既有定义。
 * - 审批记录可推进状态（pending → approved/rejected/expired），审计只追加、不可更新/删除。
 * - `agent_run_audit` 不建外键：Run/步骤清理后审计仍要留痕。
 */
import type Database from 'better-sqlite3';
import { getDb } from './connection';

const RUN_RISK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_run_risk_policies (
  project_id    TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  r0_action     TEXT NOT NULL DEFAULT 'allow'
                  CHECK(r0_action IN ('allow','ask','block')),
  r1_action     TEXT NOT NULL DEFAULT 'allow'
                  CHECK(r1_action IN ('allow','ask','block')),
  r2_action     TEXT NOT NULL DEFAULT 'ask'
                  CHECK(r2_action IN ('allow','ask','block')),
  r3_action     TEXT NOT NULL DEFAULT 'block'
                  CHECK(r3_action IN ('allow','ask','block')),
  updated_by    TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_run_approvals (
  id                 TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  step_id            TEXT REFERENCES agent_run_steps(id) ON DELETE SET NULL,
  approval_step_id   TEXT REFERENCES agent_run_steps(id) ON DELETE SET NULL,
  project_id         TEXT NOT NULL,
  risk_level         TEXT NOT NULL CHECK(risk_level IN ('R0','R1','R2','R3')),
  action             TEXT NOT NULL DEFAULT '',
  impact             TEXT NOT NULL DEFAULT '',
  diff               TEXT NOT NULL DEFAULT '',
  preview            TEXT NOT NULL DEFAULT '',
  requester          TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK(status IN ('pending','approved','rejected','expired','cancelled')),
  reason             TEXT NOT NULL DEFAULT '',
  decided_by         TEXT NOT NULL DEFAULT '',
  decided_at         TEXT,
  expires_at         TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_run_approvals_pending
  ON agent_run_approvals(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_run_approvals_project
  ON agent_run_approvals(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_run_approvals_run
  ON agent_run_approvals(run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_run_audit (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL DEFAULT '',
  step_id       TEXT NOT NULL DEFAULT '',
  approval_id   TEXT NOT NULL DEFAULT '',
  project_id    TEXT NOT NULL DEFAULT '',
  event_type    TEXT NOT NULL
                  CHECK(event_type IN ('allowed','approval_requested','approved','rejected','expired','blocked','policy_changed','override')),
  risk_level    TEXT NOT NULL DEFAULT '' CHECK(risk_level IN ('','R0','R1','R2','R3')),
  action        TEXT NOT NULL DEFAULT '',
  actor         TEXT NOT NULL DEFAULT '',
  reason        TEXT NOT NULL DEFAULT '',
  detail        TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_run_audit_project
  ON agent_run_audit(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_run_audit_run
  ON agent_run_audit(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_run_audit_type
  ON agent_run_audit(event_type, created_at DESC);

-- PRD §B7：审批审计不可篡改。审计行只允许 INSERT，任何 UPDATE/DELETE 都直接失败。
CREATE TRIGGER IF NOT EXISTS trg_agent_run_audit_no_update
BEFORE UPDATE ON agent_run_audit
BEGIN
  SELECT RAISE(ABORT, 'agent_run_audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_run_audit_no_delete
BEFORE DELETE ON agent_run_audit
BEGIN
  SELECT RAISE(ABORT, 'agent_run_audit is append-only');
END;
`;

/** 幂等创建风险策略、审批与审计表；调用方需先确保 agent_runs / agent_run_steps 已存在。 */
export function ensureAgentRunRiskSchema(db: Database.Database = getDb()): void {
  db.exec(RUN_RISK_SCHEMA_SQL);
}
