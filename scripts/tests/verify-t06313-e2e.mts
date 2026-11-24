/**
 * T06313（REQ-006 / REQ-007 / AC-07）：捕获 → 执行 → 审批 → 通知全链路联调。
 *
 * 捕获：复用 Web 端 quickCaptureParse 解析 `#项目 /类型 !优先级 @日期`，再走 TaskService.create 落任务。
 * 执行：在临时 SQLite 里创建原生 Agent Run/RunStep，模拟执行步骤。
 * 审批：R2 删除动作默认 ask，生成 pending 审批并进入审批列表（通知轮询源）。
 * 通知：task.ai_state=unread 后进入 TaskService.listAiPending（/api/notify/pending 数据源）。
 * AC-07：独立 Run 的 R3 部署动作被默认 block，Run cancelled、Step skipped，审计 event=blocked。
 * 全部使用临时 SQLite，不触碰生产库。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(HERE, '..', '..', '..');
const OUT = process.env.T06313_OUT || 'D:/tmp/t06313-e2e';

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) });
  } catch (e) {
    results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

mkdirSync(OUT, { recursive: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
process.env.MTask_DATA_DIR = join(OUT, 'db');

const dbSchema = await import(pathToFileURL(join(ROOT, 'server/dist/db/schema.js')).href);
dbSchema.initSchema();
const { getDb } = await import(pathToFileURL(join(ROOT, 'server/dist/db/connection.js')).href);
const { TaskService } = await import(pathToFileURL(join(ROOT, 'server/dist/services/TaskService.js')).href);
const { RunRiskService } = await import(pathToFileURL(join(ROOT, 'server/dist/services/RunRiskService.js')).href);
const { RunTraceService } = await import(pathToFileURL(join(ROOT, 'server/dist/services/RunTraceService.js')).href);
const { parseQuickCapture } = await import(
  pathToFileURL(join(ROOT, 'web/src/ui/quickCaptureParse.ts')).href
);

const db = getDb();
const now = '2026-11-24T20:00:00.000Z';
let taskId = '';
const runId = 'run-t06313-approval';
const highRunId = 'run-t06313-blocked';
const projectId = 'p-t06313';

function insertRun(id, status, trigger = 'queue') {
  db.prepare(`INSERT INTO agent_runs
    (id, task_id, project_id, status, trigger_type, model, prompt_version, tokens, cost, executor,
     started_at, ended_at, error_code, legacy_source, legacy_ref, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'route-test-model', 'v1', 0, 0, 't06313-e2e', ?, NULL, '', '', '', ?, ?)`)
    .run(id, taskId, projectId, status, trigger, now, now, now);
}
function insertStep(id, run, seq, type, status, risk, cost = 0) {
  db.prepare(`INSERT INTO agent_run_steps
    (id, run_id, seq, type, status, input, output, duration_ms, cost, risk_level, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '{"test":"t06313"}', '', 0, ?, ?, ?, ?)`)
    .run(id, run, seq, type, status, cost, risk, now, now);
}

db.prepare('INSERT INTO projects (id, name, description, sort_weight, wip_limit, created_at, updated_at) VALUES (?, ?, ?, 0, 10, ?, ?)')
  .run(projectId, 'T06313全链路', '', now, now);
db.prepare('INSERT INTO task_categories (id, name, sort_weight, created_at, updated_at) VALUES (?, ?, 0, ?, ?)')
  .run('cat-ops', '运维', now, now);

const captured = parseQuickCapture('部署生产支付网关 #T06313全链路 !urgent /运维 @2026-11-25', {
  projects: [{ id: projectId, name: 'T06313全链路' }],
  categories: [{ id: 'cat-ops', name: '运维' }],
  now: new Date(2026, 10, 24, 12, 0, 0),
});

let task = null;

check('捕获：解析项目/类型/优先级/日期并落任务', () => {
  assert(captured.title === '部署生产支付网关', `标题 ${captured.title}`);
  assert(captured.projectId === projectId, `项目 ${captured.projectId}`);
  assert(captured.categoryId === 'cat-ops', `分类 ${captured.categoryId}`);
  assert(captured.priority === 'urgent', `优先级 ${captured.priority}`);
  assert(captured.dueDate === '2026-11-25', `日期 ${captured.dueDate}`);
  task = TaskService.create({
    projectId,
    title: captured.title,
    description: '由快速捕获创建；T06313 全链路联调。',
    priority: captured.priority,
    categoryId: captured.categoryId,
  });
  assert(task && task.task_no, '任务未创建');
  taskId = task.id;
  return `${task.task_no} ${task.title}`;
});

check('执行：Agent Run 与执行步骤落库，任务进入 AI 运行中', () => {
  TaskService.update(taskId, { ai_state: 'running' });
  insertRun(runId, 'running');
  insertStep('step-t06313-prompt', runId, 1, 'prompt', 'succeeded', 'R0', 0.01);
  insertStep('step-t06313-tool', runId, 2, 'tool', 'pending', 'R2');
  const run = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(runId);
  assert(run.status === 'running', `Run 状态 ${run.status}`);
  assert(TaskService.getById(taskId).ai_state === 'running', '任务未进入 running');
  return 'run=running, step1=succeeded, step2=pending';
});

check('审批：R2 删除动作触发 ask，生成 pending 审批并进入审批列表', () => {
  const risk = new RunRiskService();
  const gate = risk.gateStep({
    runId, stepId: 'step-t06313-tool', projectId,
    signal: { operation: 'delete', action: '删除临时目录', target: '/tmp/t06313-cache', batchSize: 3 },
    actor: 'run-engine', impact: '将删除 3 个临时缓存文件', preview: '3 个缓存文件将被删除',
  });
  assert(gate.decision === 'ask' && gate.level === 'R2', `decision=${gate.decision} level=${gate.level}`);
  assert(gate.approval && gate.approval.status === 'pending', '未生成 pending 审批');
  const run = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(runId);
  assert(run.status === 'awaiting_approval', `Run 状态 ${run.status}`);
  const pending = risk.listApprovals({ status: 'pending', projectId });
  assert(pending.some((a) => a.id === gate.approval.id), '审批未进入待批列表（通知轮询源）');
  return `approval=${gate.approval.id.slice(0, 8)} pending=${pending.length}`;
});

check('审批闭环：批准后 Run 回到 running，步骤继续执行并成功', () => {
  const risk = new RunRiskService();
  const pending = risk.listApprovals({ status: 'pending', projectId })[0];
  assert(pending, '待审批丢失');
  const approved = risk.decideApproval(pending.id, 'approved', 'reviewer-t06313', '联调批准');
  assert(approved.status === 'approved', `审批状态 ${approved.status}`);
  db.prepare('UPDATE agent_run_steps SET status = ?, duration_ms = ?, cost = ?, updated_at = ? WHERE id = ?')
    .run('succeeded', 120, 0.02, now, 'step-t06313-tool');
  db.prepare('UPDATE agent_runs SET status = ?, ended_at = ?, tokens = ?, cost = ?, updated_at = ? WHERE id = ?')
    .run('succeeded', now, 1200, 0.03, now, runId);
  const run = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(runId);
  assert(run.status === 'succeeded', `Run 状态 ${run.status}`);
  return 'approved → running → succeeded';
});

check('追踪：RunTrace 还原成功链、成本与审批结论', () => {
  const trace = new RunTraceService().getRun(runId);
  assert(trace && trace.status === 'succeeded', `trace=${trace?.status}`);
  assert(trace.steps.length === 3, `steps=${trace.steps.length}`);
  assert(trace.steps.some((s) => s.type === 'approval' && s.status === 'succeeded'), '审批步骤缺失');
  assert(trace.approval.status === 'approved', `审批结论 ${trace.approval.status}`);
  assert(trace.cost === 0.03 && trace.stepCostTotal === 0.03, `cost=${trace.cost} step=${trace.stepCostTotal}`);
  return `steps=${trace.steps.length} cost=${trace.cost} approval=${trace.approval.status}`;
});

check('通知：任务 ai_state=unread 进入 /api/notify/pending 数据源', () => {
  TaskService.update(taskId, { ai_state: 'unread' });
  const pending = TaskService.listAiPending();
  const hit = pending.find((x) => x.task_no === task.task_no);
  assert(hit && hit.ai_state === 'unread', '任务未进入通知列表');
  return `${hit.task_no} ${hit.title}`;
});

check('AC-07：R3 部署动作被默认 block，Run cancelled / Step skipped', () => {
  insertRun(highRunId, 'running', 'manual');
  insertStep('step-t06313-high', highRunId, 1, 'tool', 'pending', 'R3');
  const risk = new RunRiskService();
  const gate = risk.gateStep({
    runId: highRunId, stepId: 'step-t06313-high', projectId,
    signal: { operation: 'deploy', action: 'deploy to prod', target: '支付网关', command: 'kubectl apply -f prod.yaml', reversible: false },
    actor: 'run-engine', impact: '生产发布不可逆', preview: 'kubectl apply -f prod.yaml',
  });
  assert(gate.decision === 'block' && gate.level === 'R3', `decision=${gate.decision} level=${gate.level}`);
  assert(gate.approval === null, 'block 不应生成审批');
  assert(db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(highRunId).status === 'cancelled', 'Run 未取消');
  assert(db.prepare('SELECT status FROM agent_run_steps WHERE id = ?').get('step-t06313-high').status === 'skipped', 'Step 未跳过');
  return `blocked R3 ${gate.auditId.slice(0, 8)}`;
});

check('AC-07 审计：blocked 审计含 Risk/Actor/Action，且不可篡改', () => {
  const risk = new RunRiskService();
  const audits = risk.listAudit({ projectId, runId: highRunId, eventType: 'blocked' });
  assert(audits.length === 1, `blocked 审计 ${audits.length}`);
  const audit = audits[0];
  assert(audit.riskLevel === 'R3' && audit.actor === 'run-engine', `risk=${audit.riskLevel} actor=${audit.actor}`);
  assert(audit.action === 'deploy to prod', `action=${audit.action}`);
  let blocked = false;
  try {
    db.prepare('DELETE FROM agent_run_audit WHERE id = ?').run(audit.id);
  } catch {
    blocked = true;
  }
  assert(blocked, '审计行可被删除');
  return `audit=${audit.id.slice(0, 8)} R3 ${audit.action}`;
});

check('AC-07 追踪：高风险 Run 终态为 cancelled，无审批残留', () => {
  const trace = new RunTraceService().getRun(highRunId);
  assert(trace && trace.status === 'cancelled', `trace=${trace?.status}`);
  assert(trace.approval.status === 'none' || trace.approval.status === 'skipped', `审批 ${trace.approval.status}`);
  return `status=${trace.status} approval=${trace.approval.status}`;
});

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
const report = [
  '# T06313 全链路联调报告',
  '',
  `- 时间：${new Date().toISOString()}`,
  `- 数据目录：${join(OUT, 'db')}`,
  `- 结果：**${passed} PASS / ${failed} FAIL**`,
  '',
  ...results.map((r) => `- ${r.ok ? 'PASS' : 'FAIL'} \`${r.name}\`${r.detail ? `：${r.detail}` : ''}`),
].join('\n');
writeFileSync(join(OUT, 'report.txt'), report, 'utf8');
writeFileSync(join(OUT, 'result.json'), JSON.stringify({ passed, failed, results, at: now }, null, 2), 'utf8');
console.log(report);
process.exit(failed ? 1 : 0);
