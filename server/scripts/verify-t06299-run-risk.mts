#!/usr/bin/env node
/**
 * T06299（REQ-007 / PRD §B7）风险拦截与审批暂停契约门禁。
 *
 * 覆盖：默认策略、R0~R3 分类、策略覆盖、allow/ask/block 三态、
 * 批准继续/拒绝终止、审批超时、不可篡改审计、项目不一致拒绝。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs server/scripts/verify-t06299-run-risk.mts
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';
import { ensureAgentRunRiskSchema } from '../src/db/agentRunRiskSchema.ts';
import { RunRiskError, RunRiskService, type RiskSignal } from '../src/services/RunRiskService.ts';

const START = '2026-11-24T03:00:00.000Z';
const PROJECT = 'p-risk';

function baseSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT NOT NULL, queue_id TEXT, parent_run_id TEXT,
      status TEXT NOT NULL, trigger_type TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', prompt_version TEXT NOT NULL DEFAULT '',
      tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, executor TEXT NOT NULL DEFAULT '',
      started_at TEXT, ended_at TEXT, error_code TEXT NOT NULL DEFAULT '', legacy_source TEXT NOT NULL DEFAULT '',
      legacy_ref TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE agent_run_steps (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL,
      input TEXT NOT NULL DEFAULT '', output TEXT NOT NULL DEFAULT '', duration_ms INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0, risk_level TEXT NOT NULL DEFAULT 'R0', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TRIGGER trg_agent_run_steps_immutable
    BEFORE UPDATE OF id, run_id, seq, type, input, output, risk_level, created_at
    ON agent_run_steps
    BEGIN
      SELECT RAISE(ABORT, 'agent_run_steps immutable fields cannot be updated');
    END;
    INSERT INTO projects (id, name) VALUES ('${PROJECT}', '十期风险拦截');
  `);
}

function seedRun(db: DatabaseSync, id: string, status = 'running', project = PROJECT): string {
  db.prepare(`INSERT INTO agent_runs
    (id, task_id, project_id, status, trigger_type, started_at, created_at, updated_at)
    VALUES (?, 't06299', ?, ?, 'manual', ?, ?, ?)`)
    .run(id, project, status, START, START, START);
  const stepId = `${id}-step-1`;
  db.prepare(`INSERT INTO agent_run_steps
    (id, run_id, seq, type, status, input, risk_level, created_at, updated_at)
    VALUES (?, ?, 0, 'tool', 'running', '{"tool":"write"}', 'R1', ?, ?)`)
    .run(stepId, id, START, START);
  return stepId;
}

function runRow(db: DatabaseSync, id: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as Record<string, unknown>;
}

function stepRow(db: DatabaseSync, id: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM agent_run_steps WHERE id = ?').get(id) as Record<string, unknown>;
}

function auditEvents(db: DatabaseSync, runId: string): string[] {
  return (db.prepare('SELECT event_type FROM agent_run_audit WHERE run_id = ? ORDER BY rowid ASC').all(runId) as { event_type: string }[])
    .map((row) => row.event_type);
}

const db = new DatabaseSync(':memory:');
baseSchema(db);
ensureAgentRunRiskSchema(db as unknown as Database.Database);
const svc = new RunRiskService(db as unknown as Database.Database, { approvalTimeoutMs: 60_000 });

// 1) 默认策略与默认来源
const policy = svc.getPolicy(PROJECT);
assert.deepEqual(policy.levels, { R0: 'allow', R1: 'allow', R2: 'ask', R3: 'block' });
assert.equal(policy.source, 'default');

// 2) 分类器：只读/可逆写/删除/批量/外发/不可逆
assert.equal(svc.classify({ operation: 'read', tool: 'read_file' }).level, 'R0');
assert.equal(svc.classify({ operation: 'write', tool: 'write_file' }).level, 'R1');
assert.equal(svc.classify({ operation: 'delete', target: 'config.json' }).level, 'R2');
assert.equal(svc.classify({ operation: 'write', batchSize: 10 }).level, 'R2');
assert.equal(svc.classify({ operation: 'external', tool: 'send_email' }).level, 'R3');
assert.equal(svc.classify({ operation: 'write', reversible: false }).level, 'R3');
assert.equal(svc.classify({ tool: 'npm publish' }).level, 'R3');
assert.equal(svc.classify({ tool: 'unknown_tool' }).level, 'R1');
assert.equal(svc.classify({ tool: 'unknown_tool' }).reasons[0], '未知动作，按可逆写保守处理');

// 3) 人工覆盖必须给理由，且来源标记 manual
assert.equal(svc.classify({ overrideLevel: 'R2', overrideReason: '人工确认可接受' }).source, 'manual');
assert.throws(
  () => svc.classify({ overrideLevel: 'R2' }),
  (e: unknown) => e instanceof RunRiskError && e.code === 'override_reason_required',
);

// 4) allow：R1 写动作放行，状态不变，只写 allowed 审计
const runAllow = 'run-allow';
const stepAllow = seedRun(db, runAllow);
const gateAllow = svc.gateStep({
  runId: runAllow, stepId: stepAllow, projectId: PROJECT,
  signal: { operation: 'write', tool: 'write_file', action: '创建文档' },
  actor: 'engine',
});
assert.equal(gateAllow.decision, 'allow');
assert.equal(gateAllow.level, 'R1');
assert.equal(gateAllow.approval, null);
assert.equal(runRow(db, runAllow).status, 'running');
assert.equal(stepRow(db, stepAllow).status, 'running');
assert.deepEqual(auditEvents(db, runAllow), ['allowed']);

// 5) ask：R2 删除进入 awaiting_approval，追加 approval 步骤，审批待处理
const runAsk = 'run-ask';
const stepAsk = seedRun(db, runAsk);
const gateAsk = svc.gateStep({
  runId: runAsk, stepId: stepAsk, projectId: PROJECT,
  signal: { operation: 'delete', target: 'old-config.json', action: '删除旧配置' },
  actor: 'engine', impact: '只影响旧配置文件', diff: '删除 3 行',
});
assert.equal(gateAsk.decision, 'ask');
assert.equal(gateAsk.level, 'R2');
assert.ok(gateAsk.approval, 'ask 必须生成审批');
assert.equal(gateAsk.approval?.status, 'pending');
assert.equal(runRow(db, runAsk).status, 'awaiting_approval');
assert.equal(stepRow(db, stepAsk).status, 'awaiting_approval');
const approvalStep = stepRow(db, gateAsk.approval!.approvalStepId!);
assert.equal(approvalStep.type, 'approval');
assert.equal(approvalStep.status, 'awaiting_approval');
assert.equal(approvalStep.risk_level, 'R2');
assert.deepEqual(auditEvents(db, runAsk), ['approval_requested']);

// 6) 批准：Run 回到 running，原步骤继续，审批步骤 succeeded，审计 approved
const approved = svc.decideApproval(gateAsk.approval!.id, 'approved', 'reviewer', '确认删除范围');
assert.equal(approved.status, 'approved');
assert.equal(runRow(db, runAsk).status, 'running');
assert.equal(stepRow(db, stepAsk).status, 'running');
assert.equal(stepRow(db, gateAsk.approval!.approvalStepId!).status, 'succeeded');
assert.deepEqual(auditEvents(db, runAsk), ['approval_requested', 'approved']);
assert.throws(
  () => svc.decideApproval(gateAsk.approval!.id, 'approved'),
  (e: unknown) => e instanceof RunRiskError && e.code === 'approval_not_pending',
);

// 7) 项目策略覆盖：R3 从 block 改为 ask；policy_changed 写审计
const updatedPolicy = svc.setPolicy(PROJECT, { R3: 'ask' }, 'admin');
assert.equal(updatedPolicy.levels.R3, 'ask');
assert.deepEqual(svc.getPolicy(PROJECT).levels, { R0: 'allow', R1: 'allow', R2: 'ask', R3: 'ask' });
assert.ok(svc.listAudit({ projectId: PROJECT, eventType: 'policy_changed' }).length >= 1);

// 8) 策略覆盖后 R3 进入 ask，不直接执行
const runR3Ask = 'run-r3-ask';
const stepR3Ask = seedRun(db, runR3Ask);
const gateR3Ask = svc.gateStep({
  runId: runR3Ask, stepId: stepR3Ask, projectId: PROJECT,
  signal: { operation: 'deploy', tool: 'deploy_prod', action: '部署生产' },
});
assert.equal(gateR3Ask.decision, 'ask');
assert.equal(gateR3Ask.level, 'R3');
assert.equal(gateR3Ask.approval?.status, 'pending');

// 9) 拒绝：Run 终止，原步骤 skipped，审批步骤 failed，审计 rejected
const rejected = svc.decideApproval(gateR3Ask.approval!.id, 'rejected', 'reviewer', '生产部署未获批');
assert.equal(rejected.status, 'rejected');
assert.equal(runRow(db, runR3Ask).status, 'cancelled');
assert.equal(runRow(db, runR3Ask).error_code, 'approval_rejected');
assert.ok(runRow(db, runR3Ask).ended_at);
assert.equal(stepRow(db, stepR3Ask).status, 'skipped');
assert.equal(stepRow(db, gateR3Ask.approval!.approvalStepId!).status, 'failed');
assert.deepEqual(auditEvents(db, runR3Ask), ['approval_requested', 'rejected']);

// 10) 恢复默认策略后 R3 直接 block：Run 取消、步骤 skipped、无审批、审计 blocked
svc.setPolicy(PROJECT, { R3: 'block' }, 'admin');
const runBlock = 'run-block';
const stepBlock = seedRun(db, runBlock);
const gateBlock = svc.gateStep({
  runId: runBlock, stepId: stepBlock, projectId: PROJECT,
  signal: { operation: 'permission', action: '授予管理员权限' },
});
assert.equal(gateBlock.decision, 'block');
assert.equal(gateBlock.level, 'R3');
assert.equal(gateBlock.approval, null);
assert.equal(runRow(db, runBlock).status, 'cancelled');
assert.equal(runRow(db, runBlock).error_code, 'risk_blocked');
assert.equal(stepRow(db, stepBlock).status, 'skipped');
assert.deepEqual(auditEvents(db, runBlock), ['blocked']);

// 11) 人工覆盖降低等级也写 override 审计，再按策略 allow
const runOverride = 'run-override';
const stepOverride = seedRun(db, runOverride);
const gateOverride = svc.gateStep({
  runId: runOverride, stepId: stepOverride, projectId: PROJECT,
  signal: { operation: 'delete', overrideLevel: 'R1', overrideReason: '已确认是临时文件', overrideActor: 'ops' },
});
assert.equal(gateOverride.decision, 'allow');
assert.equal(gateOverride.source, 'manual');
assert.deepEqual(auditEvents(db, runOverride).sort(), ['allowed', 'override']);

// 12) 审批超时：Run failed，审批 expired，审批步骤 failed，审计 expired
const runExpire = 'run-expire';
const stepExpire = seedRun(db, runExpire);
const gateExpire = svc.gateStep({
  runId: runExpire, stepId: stepExpire, projectId: PROJECT,
  signal: { operation: 'delete', target: 'batch-1' },
});
assert.ok(gateExpire.approval);
// 直接把 expires_at 改到过去，避免等待真实 60 秒
db.prepare('UPDATE agent_run_approvals SET expires_at = ? WHERE id = ?')
  .run('2026-11-24T02:59:00.000Z', gateExpire.approval!.id);
const expired = svc.expireApprovals('2026-11-24T03:00:00.000Z');
assert.equal(expired.length, 1);
assert.equal(expired[0].status, 'expired');
assert.equal(runRow(db, runExpire).status, 'failed');
assert.equal(runRow(db, runExpire).error_code, 'approval_timeout');
assert.equal(stepRow(db, stepExpire).status, 'failed');
assert.equal(stepRow(db, gateExpire.approval!.approvalStepId!).status, 'failed');
assert.deepEqual(auditEvents(db, runExpire), ['approval_requested', 'expired']);

// 13) 不可篡改：audit 行 UPDATE / DELETE 均被触发器拒绝
const auditRows = svc.listAudit({ projectId: PROJECT, limit: 1000 });
assert.ok(auditRows.length >= 10);
assert.throws(
  () => db.prepare('UPDATE agent_run_audit SET reason = ? WHERE id = ?').run('tampered', auditRows[0].id),
  /append-only/i,
);
assert.throws(
  () => db.prepare('DELETE FROM agent_run_audit WHERE id = ?').run(auditRows[0].id),
  /append-only/i,
);
assert.equal(svc.listAudit({ projectId: PROJECT, limit: 1000 }).length, auditRows.length);

// 14) Run 与项目不一致必须拒绝，不能跨项目套策略
const runOtherProject = 'run-other-project';
const stepOtherProject = seedRun(db, runOtherProject);
assert.throws(
  () => svc.gateStep({
    runId: runOtherProject, stepId: stepOtherProject, projectId: 'p-other',
    signal: { operation: 'write' },
  }),
  (e: unknown) => e instanceof RunRiskError && e.code === 'project_not_found',
);
db.prepare("INSERT INTO projects (id, name) VALUES ('p-other', '其他项目')").run();
assert.throws(
  () => svc.gateStep({
    runId: runOtherProject, stepId: stepOtherProject, projectId: 'p-other',
    signal: { operation: 'write' },
  }),
  (e: unknown) => e instanceof RunRiskError && e.code === 'project_mismatch',
);

// 15) 审计导出为合法 JSON 且保留事件
const exported = JSON.parse(svc.exportAudit({ projectId: PROJECT, limit: 1000 })) as { event_type?: string; eventType?: string }[];
assert.ok(exported.length >= 10);
assert.ok(exported.some((row) => (row.eventType ?? row.event_type) === 'blocked'));

console.log('T06299 run-risk contract PASS: 15 groups');
