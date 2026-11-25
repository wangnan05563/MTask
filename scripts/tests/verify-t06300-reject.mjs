/**
 * T06300 AC-07 拒绝路径最小验收：R2 高风险动作 -> 待审批 -> 人工拒绝 -> 审计 rejected。
 * 只写隔离测试库 C:/Users/hspcadmin/AppData/Local/Temp/t06300-ui，不碰生产库。
 */
import { DatabaseSync } from 'node:sqlite';

const DB = 'C:/Users/hspcadmin/AppData/Local/Temp/t06300-ui/mtask.db';
const API = 'http://127.0.0.1:5198';
const TAG = Date.now().toString(36);
const PROJECT = `p-t06300-reject-${TAG}`;
const TASK = `task-t06300-reject-${TAG}`;
const SESSION = `sess-t06300-reject-${TAG}`;
const RUN = `run-t06300-reject-${TAG}`;
const STEP = `${RUN}-s1`;
const checks = [];
const say = (name, ok, extra) => {
  checks.push({ name, ok: !!ok, extra });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 1200)}`}`);
};

const db = new DatabaseSync(DB);
const now = new Date().toISOString();
try {
  db.prepare('DELETE FROM agent_run_approvals WHERE run_id = ?').run(RUN);
  db.prepare('DELETE FROM agent_run_steps WHERE run_id = ?').run(RUN);
  db.prepare('DELETE FROM agent_runs WHERE id = ?').run(RUN);
  db.prepare('DELETE FROM exec_sessions WHERE id = ?').run(SESSION);
  db.prepare('DELETE FROM tasks WHERE project_id = ?').run(PROJECT);
  db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT);
  db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(PROJECT, 'T06300 AC-07 拒绝验证', now, now);
  db.prepare('INSERT INTO tasks (id, task_no, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(TASK, `T06300-REJECT-${TAG}`, PROJECT, 'AC-07 拒绝审计验证', 'todo', now, now);
  db.prepare(`INSERT INTO exec_sessions
    (id, platform, session_id, task_ids, status, progress, progress_reported, phase, last_heartbeat, started_at)
    VALUES (?, 'workbuddy', ?, ?, 'active', 70, 1, ?, ?, ?)`)
    .run(SESSION, 'wb-t06300-reject', JSON.stringify([TASK]), '等待高风险审批', now, now);
  db.prepare(`INSERT INTO agent_runs
    (id, task_id, project_id, status, trigger_type, model, prompt_version, tokens, cost, executor, started_at, legacy_source, legacy_ref, created_at, updated_at)
    VALUES (?, ?, ?, 'running', 'manual', 'doubao', 'prd-b7-v1', 0, 0, 'workbuddy', ?, 'exec_session', ?, ?, ?)`)
    .run(RUN, TASK, PROJECT, now, SESSION, now, now);
  db.prepare(`INSERT INTO agent_run_steps (id, run_id, seq, type, status, input, output, duration_ms, cost, risk_level, created_at, updated_at)
    VALUES (?, ?, 0, 'prompt', 'succeeded', ?, ?, 0, 0, 'R0', ?, ?)`)
    .run(`${RUN}-s0`, RUN, JSON.stringify({ prompt: 'AC-07 拒绝审计验证' }), '已解析任务与项目上下文', now, now);
  db.prepare(`INSERT INTO agent_run_steps (id, run_id, seq, type, status, input, output, duration_ms, cost, risk_level, created_at, updated_at)
    VALUES (?, ?, 1, 'tool', 'running', ?, '', 0, 0, 'R2', ?, ?)`)
    .run(STEP, RUN, JSON.stringify({ tool: 'delete_file', path: 'server/data/mtask.db' }), now, now);
} finally { db.close(); }

try {
  const gate = await fetch(`${API}/api/run-risk/gate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      runId: RUN, stepId: STEP, projectId: PROJECT,
      signal: { operation: 'delete', target: 'server/data/mtask.db', action: '覆盖并删除生产数据文件' },
      actor: 'workbuddy/T06300-reject',
      impact: '将删除 server/data/mtask.db（含任务与审计），不可恢复。',
      diff: '--- a/server/data/mtask.db\n+++ /dev/null\n@@ -1,1 +0,0 @@\n- mtask.db\n',
      preview: 'rm -f server/data/mtask.db',
    }),
  }).then((r) => r.json());
  say('AC07-01 R2 门禁创建待审批', gate?.decision === 'ask' && Boolean(gate?.approval?.id), { decision: gate?.decision, approvalId: gate?.approval?.id });
  if (!gate?.approval?.id) throw new Error('未创建审批，无法继续');

  const res = await fetch(`${API}/api/run-risk/approvals/${gate.approval.id}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'rejected', actor: 'web-ui', reason: 'AC-07 拒绝审计验证' }),
  }).then((r) => r.json());
  say('AC07-02 拒绝返回 rejected', res?.status === 'rejected' && res?.decidedBy === 'web-ui', { status: res?.status, decidedBy: res?.decidedBy });
  const db2 = new DatabaseSync(DB);
  const run = db2.prepare('SELECT status, error_code FROM agent_runs WHERE id = ?').get(RUN);
  db2.close();
  say('AC07-03 Run 终止为 cancelled/approval_rejected', run?.status === 'cancelled' && run?.error_code === 'approval_rejected', run);

  const audit = await fetch(`${API}/api/run-risk/audit?runId=${RUN}&limit=50`).then((r) => r.json());
  const rejected = (audit?.rows || []).filter((row) => row.eventType === 'rejected');
  const requested = (audit?.rows || []).filter((row) => row.eventType === 'approval_requested');
  say('AC07-04 审计写入 rejected 事件', rejected.length === 1 && rejected[0].actor === 'web-ui', {
    rejected, auditCount: audit?.count,
  });
  say('AC07-05 审计序列含 approval_requested -> rejected', requested.length === 1 && rejected.length === 1
    && requested[0].approvalId === gate.approval.id && rejected[0].approvalId === gate.approval.id,
  { requested: requested.map((x) => x.eventType), rejected: rejected.map((x) => x.eventType) });

  const summary = { pass: checks.filter((x) => x.ok).length, fail: checks.filter((x) => !x.ok).length, checks };
  const fs = await import('node:fs');
  fs.writeFileSync('C:/Users/hspcadmin/AppData/Local/Temp/t06300-reject-result.json', JSON.stringify(summary, null, 2), 'utf8');
  console.log(`[t06300-reject] pass=${summary.pass} fail=${summary.fail}`);
  if (summary.fail) process.exitCode = 1;
} catch (e) {
  say('AC07-99 验收中断', false, String(e?.stack || e));
  process.exitCode = 2;
}
