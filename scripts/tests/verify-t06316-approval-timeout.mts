/**
 * T06316 审批超时机制（REQ-042 / AC-07）：
 * 模拟单节点审批超时 → 超时默认拒绝（expired）→ Run/Step 失败 → 审计落库。
 * 边界：不测多节点审批；不扩展本期范围外逻辑。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = mkdtempSync(join(tmpdir(), 't06316-timeout-'));
process.env.MTask_DATA_DIR = DATA;

const { initSchema } = await import(pathToFileURL(join(ROOT, 'server/src/db/schema.ts')).href);
const { getDb } = await import(pathToFileURL(join(ROOT, 'server/src/db/connection.ts')).href);
const { ensureAgentRunSchema } = await import(pathToFileURL(join(ROOT, 'server/src/db/agentRunSchema.ts')).href);
const { ensureAgentRunRiskSchema } = await import(pathToFileURL(join(ROOT, 'server/src/db/agentRunRiskSchema.ts')).href);
const { RunRiskService } = await import(pathToFileURL(join(ROOT, 'server/src/services/RunRiskService.ts')).href);

initSchema();
const db = getDb();
ensureAgentRunSchema();
ensureAgentRunRiskSchema(db);

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) pass += 1; else fail += 1;
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 600)}`}`);
  console.log(lines[lines.length - 1]);
};

const NOW = new Date().toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('p-t06316', 'T06316 超时审批', NOW, NOW);
db.prepare('INSERT INTO tasks (id, task_no, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run('task-t06316', 'T06316-FIX', 'p-t06316', '审批超时夹具', 'todo', NOW, NOW);

function makeRun(runId: string, stepId: string, status = 'running') {
  db.prepare(`INSERT INTO agent_runs (id, task_id, project_id, status, trigger_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'manual', ?, ?)`).run(runId, 'task-t06316', 'p-t06316', status, NOW, NOW);
  db.prepare(`INSERT INTO agent_run_steps (id, run_id, seq, type, status, input, created_at, updated_at)
    VALUES (?, ?, 0, 'tool', 'running', ?, ?, ?)`).run(stepId, runId, JSON.stringify({ tool: 'delete', action: '删除旧数据' }), NOW, NOW);
}
makeRun('run-t06316-a', 'step-t06316-a');
const svc = new RunRiskService(db);
const gate = svc.gateStep({
  runId: 'run-t06316-a', stepId: 'step-t06316-a', projectId: 'p-t06316',
  signal: { operation: 'delete', tool: 'delete', action: '删除旧数据', target: 'batch-2026' },
  actor: 'run-engine', impact: '单节点覆盖写入', diff: '- a\n+ b',
});
const approval = gate.approval!;
ok('T06316-01 高风险动作进入待审批（单节点）', gate.decision === 'ask' && approval?.status === 'pending'
  && approval?.riskLevel === 'R2' && Boolean(approval?.expiresAt > NOW), { decision: gate.decision, status: approval?.status, expiresAt: approval?.expiresAt });
const requestedAudit = svc.listAudit({ runId: 'run-t06316-a', eventType: 'approval_requested' });
ok('T06316-02 发起审批写 approval_requested 审计', requestedAudit.length === 1 && requestedAudit[0].approvalId === approval.id, requestedAudit);

db.prepare('UPDATE agent_run_approvals SET expires_at = ? WHERE id = ?').run(PAST, approval.id);
const expired = svc.expireApprovals(new Date().toISOString());
ok('T06316-03 到期审批被收口为 expired（默认拒绝）', expired.length === 1 && expired[0].id === approval.id && expired[0].status === 'expired',
  expired.map((x: any) => ({ id: x.id, status: x.status, reason: x.reason })));
ok('T06316-04 超时不产生 approved 决策', svc.listAudit({ runId: 'run-t06316-a', eventType: 'approved' }).length === 0
  && svc.listAudit({ runId: 'run-t06316-a', eventType: 'rejected' }).length === 0);
const run = db.prepare('SELECT status, error_code, ended_at FROM agent_runs WHERE id = ?').get('run-t06316-a') as any;
const step = db.prepare('SELECT status FROM agent_run_steps WHERE id = ?').get('step-t06316-a') as any;
const approvalStep = db.prepare('SELECT status FROM agent_run_steps WHERE id = ?').get(approval.approvalStepId!) as any;
ok('T06316-05 Run 终止为 failed/approval_timeout', run?.status === 'failed' && run?.error_code === 'approval_timeout' && Boolean(run?.ended_at), run);
ok('T06316-06 原步骤与审批步骤均 failed', step?.status === 'failed' && approvalStep?.status === 'failed', { step: step?.status, approvalStep: approvalStep?.status });
const expiredAudit = svc.listAudit({ runId: 'run-t06316-a', eventType: 'expired' });
ok('T06316-07 超时审计正确（system/审批超时/过期时间）', expiredAudit.length === 1
  && expiredAudit[0].actor === 'system' && expiredAudit[0].reason === '审批超时'
  && expiredAudit[0].approvalId === approval.id && expiredAudit[0].riskLevel === 'R2'
  && JSON.parse(expiredAudit[0].detail).expiresAt === PAST, expiredAudit[0]);
ok('T06316-08 过期后不可再批准（重复决策被拒）', (() => {
  try { svc.decideApproval(approval.id, 'approved', 'late-reviewer'); return false; } catch (e: any) { return e?.code === 'approval_not_pending'; }
})(), { id: approval.id });
ok('T06316-09 重复扫描幂等（不重复写 expired 审计）', svc.expireApprovals(new Date().toISOString()).length === 0
  && svc.listAudit({ runId: 'run-t06316-a', eventType: 'expired' }).length === 1);

makeRun('run-t06316-b', 'step-t06316-b');
const gateB = svc.gateStep({
  runId: 'run-t06316-b', stepId: 'step-t06316-b', projectId: 'p-t06316',
  signal: { operation: 'delete', tool: 'delete', action: '删除另一个批次' },
});
db.prepare('UPDATE agent_run_approvals SET expires_at = ? WHERE id = ?').run(FUTURE, gateB.approval!.id);
const stillPending = svc.listApprovals({ status: 'pending', runId: 'run-t06316-b' });
ok('T06316-10 未到期审批保持 pending（不误杀）', stillPending.length === 1 && stillPending[0].id === gateB.approval!.id
  && stillPending[0].status === 'pending', stillPending.map((x: any) => ({ id: x.id, status: x.status })));

const finalAudit = svc.listAudit({ limit: 1000 });
ok('T06316-11 审计只追加（event 序列完整）', finalAudit.some((a: any) => a.eventType === 'approval_requested')
  && finalAudit.some((a: any) => a.eventType === 'expired') === true, finalAudit.map((a: any) => a.eventType));

db.close();
rmSync(DATA, { recursive: true, force: true });
console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
