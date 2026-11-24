#!/usr/bin/env node
/**
 * T06299 REST 冒烟：对已启动的测试 API 验证「策略→门禁→审批→审计」完整闭环。
 * 用法：MTASK_TEST_DB=<db path> MTASK_TEST_PORT=5197 node ... smoke-t06299-api.mts
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const dbPath = process.env.MTASK_TEST_DB ?? '';
const port = Number(process.env.MTASK_TEST_PORT ?? 5197);
const base = `http://127.0.0.1:${port}/api`;
assert.ok(dbPath, 'MTASK_TEST_DB required');

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON');
const now = '2026-11-24T03:10:00.000Z';
// 审计表 append-only，不能复用同一个 projectId：每次冒烟用唯一作用域，避免上次行的审计被重复统计。
const suffix = String(Date.now());
const projectId = `p-t06299-api-${suffix}`;
const taskId = `t-t06299-api-${suffix}`;

db.prepare('DELETE FROM agent_runs WHERE project_id = ?').run(projectId);
db.prepare('DELETE FROM tasks WHERE project_id = ?').run(projectId);
db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(projectId, 'T06299 API 冒烟', now, now);
db.prepare('INSERT INTO tasks (id, task_no, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
  .run(taskId, `T06299-API-${suffix}`, projectId, '风险拦截 API 冒烟', now, now);

function addRun(runId: string, status = 'running'): string {
  db.prepare(`INSERT INTO agent_runs (id, task_id, project_id, status, trigger_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'manual', ?, ?)`).run(runId, taskId, projectId, status, now, now);
  const stepId = `${runId}-step`;
  db.prepare(`INSERT INTO agent_run_steps (id, run_id, seq, type, status, input, risk_level, created_at, updated_at)
    VALUES (?, ?, 0, 'tool', 'running', '{"tool":"smoke"}', 'R1', ?, ?)`).run(stepId, runId, now, now);
  return stepId;
}

async function json(path: string, init?: RequestInit): Promise<Record<string, any>> {
  const res = await fetch(`${base}${path}`, init);
  const body = await res.json() as Record<string, any>;
  assert.ok(res.ok, `${path} ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

const runAskId = `run-api-ask-${suffix}`;
const runBlockId = `run-api-block-${suffix}`;
const runRejectId = `run-api-reject-${suffix}`;
const runAsk = addRun(runAskId);
const runBlock = addRun(runBlockId);
const runReject = addRun(runRejectId);

// 1) 默认策略
const policy = await json(`/run-risk/policy/${projectId}`);
assert.deepEqual(policy.levels, { R0: 'allow', R1: 'allow', R2: 'ask', R3: 'block' });

// 2) R2 ask：审批创建、Run/Step 暂停
const askGate = await json('/run-risk/gate', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    runId: runAskId, stepId: runAsk, projectId,
    signal: { operation: 'delete', target: 'old.json', action: '删除旧文件' },
    actor: 'api-smoke', impact: '旧文件', diff: '-3 行',
  }),
});
assert.equal(askGate.decision, 'ask');
assert.equal(askGate.approval.status, 'pending');
assert.equal((await json('/run-risk/approvals', { method: 'GET' })).count, 1);

// 3) 批准：审计 approved，审批步骤完成
const afterApprove = await json(`/run-risk/approvals/${askGate.approval.id}/decision`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ decision: 'approved', actor: 'smoke-reviewer', reason: '范围确认' }),
});
assert.equal(afterApprove.status, 'approved');
const auditApproved = await json(`/run-risk/audit?projectId=${projectId}&runId=${runAskId}`);
assert.deepEqual(auditApproved.rows.map((row: any) => row.eventType).sort(), ['approval_requested', 'approved']);

// 4) R3 block：无审批、Run 取消、审计 blocked
const blockGate = await json('/run-risk/gate', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    runId: runBlockId, stepId: runBlock, projectId,
    signal: { operation: 'permission', action: '授予管理员权限' },
  }),
});
assert.equal(blockGate.decision, 'block');
const auditBlocked = await json(`/run-risk/audit?projectId=${projectId}&runId=${runBlockId}`);
assert.equal(auditBlocked.rows[0].eventType, 'blocked');

// 5) R2 ask 后拒绝：Run 取消，审计 rejected
const rejectGate = await json('/run-risk/gate', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    runId: runRejectId, stepId: runReject, projectId,
    signal: { operation: 'delete', target: 'prod-config.json' },
  }),
});
assert.equal(rejectGate.decision, 'ask');
const afterReject = await json(`/run-risk/approvals/${rejectGate.approval.id}/decision`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ decision: 'rejected', actor: 'smoke-reviewer', reason: '生产配置不可删' }),
});
assert.equal(afterReject.status, 'rejected');
const auditRejected = await json(`/run-risk/audit?projectId=${projectId}&runId=${runRejectId}`);
assert.deepEqual(auditRejected.rows.map((row: any) => row.eventType).sort(), ['approval_requested', 'rejected']);

// 6) 审计不可篡改：通过 API 无法删除，直接 SQL 也拒绝
const auditAll = await json(`/run-risk/audit?projectId=${projectId}&limit=1000`);
assert.ok(auditAll.count >= 5);
assert.throws(() => {
  db.prepare('DELETE FROM agent_run_audit WHERE id = ?').run(auditAll.rows[0].id);
}, /append-only/i);

console.log('T06299 REST smoke PASS: policy/gate/approve/block/reject/audit');
db.close();
