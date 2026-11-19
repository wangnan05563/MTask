/**
 * T06076 队列采纳链路专项回归（隔离数据目录，不触碰生产库）。
 * 覆盖：质量门 → force 采纳 → 处理结果/AI 摘要隔离 → 幂等 → 撤回边界 → 旧入口匹配 → 待采纳汇总。
 * 运行：npm run verify:t06076-queue-adopt
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtask-t06076-queue-'));
process.env.MTask_DATA_DIR = dataDir;

const { initSchema } = await import('../server/src/db/schema');
const { getDb } = await import('../server/src/db/connection');
const { TaskService } = await import('../server/src/services/TaskService');
const { QueueService } = await import('../server/src/services/QueueService');

const db = getDb();
const now = () => new Date().toISOString();

function cleanup() {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
}

try {
  initSchema();
  const projectId = 'p-t06076';
  db.prepare('INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(projectId, 'T06076 隔离项目', '', now(), now());

  const payload = '## 根因\n知识截止于 2026 年 7 月，无法实时检索 2026 年 11 月 19 日资讯。\n\n## 影响范围\n仅为背景整理，未包含来源链接。';
  const task = TaskService.create({
    projectId,
    title: 'T06076 队列采纳回归',
    description: '请整理今日资讯并标注来源链接。',
    status: 'done',
  });
  db.prepare('UPDATE tasks SET ai_summary = ?, ai_summary_at = ? WHERE id = ?').run('原有 AI 摘要，不能被覆盖', now(), task.id);

  const queue = QueueService.create('T06076 回归队列', now().slice(0, 10));
  const toolId = 'tool-t06076';
  db.prepare(`INSERT INTO ai_tools (id, name, type, endpoint, created_at, updated_at)
              VALUES (?, ?, 'openai-compat', 'https://example.com', ?, ?)`).run(toolId, 'T06076 回归工具', now(), now());
  const jobId = 'j-t06076';
  db.prepare(`INSERT INTO queue_jobs (id, queue_id, task_id, tool_id, order_index, status, response_payload, sent_at, finished_at)
              VALUES (?, ?, ?, ?, 0, 'success', ?, ?, ?)`).run(jobId, queue.id, task.id, toolId, payload, now(), now());

  // 1) 质量门：自述无实时数据 + 描述要求来源但正文无链接 → 无 force 拒绝
  assert.throws(() => QueueService.adoptJob(queue.id, jobId), /回执质量待确认/);
  console.log('quality gate: PASS');

  // 2) force 采纳：写 handle_result，ai_summary 不动，adopted_at/快照落库
  const adopted = QueueService.adoptJob(queue.id, jobId, true);
  assert.equal(adopted.task.status, 'done');
  assert.equal((adopted.task.handle_result ?? '').trim(), payload.trim());
  assert.equal(adopted.task.ai_summary, '原有 AI 摘要，不能被覆盖');
  assert.ok(adopted.job.adopted_at);
  assert.ok((adopted.job.adopt_snapshot ?? '').length > 0);
  assert.equal(QueueService.listJobs(queue.id).find((j) => j.id === jobId)?.adopted_at !== '', true);
  console.log('adopt writes handle_result: PASS');

  // 3) 幂等：重复采纳不覆盖
  const again = QueueService.adoptJob(queue.id, jobId, true);
  assert.equal(again.already, true);
  assert.equal((again.task.handle_result ?? '').trim(), payload.trim());
  console.log('adopt idempotent: PASS');

  // 4) 撤回：采纳前为空结果时回落 todo，不制造 done+空结果
  const undone = QueueService.unadoptJob(queue.id, jobId);
  assert.equal(undone.task.status, 'todo');
  assert.equal((undone.task.handle_result ?? '').trim(), '');
  assert.equal(QueueService.listJobs(queue.id)[0].adopted_at, '');
  console.log('unadopt restores todo: PASS');

  // 5) 旧入口匹配：正文带结尾换行仍应命中队列回执并补 adopted_at
  const legacy = QueueService.adoptTaskContent(task.id, payload.trim() + '\n');
  assert.equal((legacy.handle_result ?? '').trim(), payload.trim());
  assert.equal(QueueService.listJobs(queue.id)[0].adopted_at !== '', true);
  QueueService.unadoptJob(queue.id, jobId);
  console.log('legacy adopt matches trailing newline: PASS');

  // 6) 待采纳汇总：成功且未采纳为 1；采纳后为 0
  const queue2 = QueueService.create('T06076 汇总队列', now().slice(0, 10));
  const job2 = 'j-t06076-2';
  db.prepare(`INSERT INTO queue_jobs (id, queue_id, task_id, tool_id, order_index, status, response_payload, sent_at, finished_at)
              VALUES (?, ?, ?, ?, 0, 'success', ?, ?, ?)`).run(job2, queue2.id, task.id, toolId, '干净回执，含来源 https://example.com', now(), now());
  assert.equal(QueueService.summary().find((q) => q.id === queue2.id)?.job_unadopted, 1);
  QueueService.adoptJob(queue2.id, job2, true);
  assert.equal(QueueService.summary().find((q) => q.id === queue2.id)?.job_unadopted, 0);
  console.log('summary job_unadopted: PASS');

  // 7) 撤回安全阀：采纳后手改结果应拒绝自动撤回
  TaskService.update(task.id, { handle_result: '人工改写后的结果' });
  assert.throws(() => QueueService.unadoptJob(queue2.id, job2), /处理结果在采纳后已被修改/);
  console.log('unadopt rejects manual edit: PASS');

  console.log('==== T06076 QUEUE ADOPT SUMMARY: 7/7 passed ====');
} finally {
  cleanup();
}
