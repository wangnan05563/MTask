#!/usr/bin/env node
/**
 * T06332 REST 冒烟：对已启动的隔离 API 验证 Run 列表 / 步骤 / 旧数据映射闭环。
 *
 * 用法：MTASK_TEST_DB=<db path> MTASK_TEST_PORT=<port> node ... smoke-t06332-api.mts
 * 前置：隔离服务已启动，`agent_runs` / `agent_run_steps` 已由启动流程建好。
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const dbPath = process.env.MTASK_TEST_DB ?? '';
const port = Number(process.env.MTASK_TEST_PORT ?? 5218);
const base = `http://127.0.0.1:${port}/api`;
assert.ok(dbPath, 'MTASK_TEST_DB required');

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
const now = '2026-11-24T03:20:00.000Z';
const end = '2026-11-24T03:20:05.000Z';
const suffix = String(Date.now());
const projectId = `p-t06332-${suffix}`;
const task1 = `t-t06332-a-${suffix}`;
const task2 = `t-t06332-b-${suffix}`;
const taskNo1 = `T06332-API-A-${suffix}`;
const taskNo2 = `T06332-API-B-${suffix}`;
const toolId = `tool-t06332-${suffix}`;
const queueId = `q-t06332-${suffix}`;
const jobOk = `j-t06332-ok-${suffix}`;
const jobFail = `j-t06332-fail-${suffix}`;
const jobQueued = `j-t06332-queued-${suffix}`;
const sessionDone = `s-t06332-done-${suffix}`;
const sessionActive = `s-t06332-active-${suffix}`;
const sessionOrphan = `s-t06332-orphan-${suffix}`;
const usageQueue = `u-t06332-queue-${suffix}`;
const usageTask = `u-t06332-task-${suffix}`;
const usageNone = `u-t06332-none-${suffix}`;

db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(projectId, 'T06332 API 冒烟', now, now);
db.prepare(`INSERT INTO tasks (id, task_no, project_id, title, status, archived, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, 0, ?, ?)`).run(task1, taskNo1, projectId, 'Run 查询 API', 'doing', now, now);
db.prepare(`INSERT INTO tasks (id, task_no, project_id, title, status, archived, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, 0, ?, ?)`).run(task2, taskNo2, projectId, 'Run 映射 API', 'todo', now, now);
db.prepare('INSERT INTO ai_tools (id, name, type, endpoint, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run(toolId, 'T06332 工具', 'openai', 'http://127.0.0.1/mock', 'doubao-pro', now, now);
db.prepare('INSERT INTO queues (id, name, date, status, created_at) VALUES (?, ?, ?, ?, ?)')
  .run(queueId, 'T06332 队列', '2026-11-24', 'finished', now);

const insertJob = db.prepare(`INSERT INTO queue_jobs
  (id, queue_id, task_id, tool_id, order_index, status, request_payload, response_payload, error, sent_at, finished_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
insertJob.run(jobOk, queueId, task1, toolId, 1, 'success', '{"prompt":"api"}', '{"receipt":"OK"}', null, now, end);
insertJob.run(jobFail, queueId, task2, toolId, 2, 'failed', '{"prompt":"fail"}', null, 'API timeout', now, end);
insertJob.run(jobQueued, queueId, task1, toolId, 3, 'queued', '{"prompt":"queued"}', null, null, null, null);

const insertSession = db.prepare(`INSERT INTO exec_sessions
  (id, platform, session_id, task_ids, status, progress, progress_reported, phase, last_heartbeat, started_at, finished_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
insertSession.run(sessionDone, 'workbuddy', 'api-ext-1', JSON.stringify([task1]), 'done', 100, 1, '完成提交', end, now, end);
insertSession.run(sessionActive, 'trae', 'api-ext-2', JSON.stringify([task2]), 'active', 42, 1, '读取仓库', end, now, null);
insertSession.run(sessionOrphan, 'relay', 'api-ext-3', '[]', 'stalled', 0, 0, '', end, now, null);

const insertUsage = db.prepare(`INSERT INTO ai_usage
  (id, tool_id, tool_name, model, kind, ok, duration_ms, content_chars, error, card_key, stage, job_id,
   prompt_tokens, completion_tokens, total_tokens, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
insertUsage.run(usageQueue, toolId, 'T06332 工具', 'doubao-pro', 'organize', 1, 1500, 800, null, 'task.organize', 'summary', jobOk, 80, 40, 120, end);
insertUsage.run(usageTask, toolId, 'T06332 工具', 'doubao-pro', 'develop', 0, 500, 0, 'model error', 'task.develop', 'code', task2, null, null, null, end);
insertUsage.run(usageNone, toolId, 'T06332 工具', 'doubao-pro', 'memory', 1, 900, 200, null, 'memory_extract', 'extract', 'memory_extract', 10, 10, 20, end);

const oldTables = ['queue_jobs', 'exec_sessions', 'ai_usage'];
const oldCounts = new Map<string, number>();
for (const table of oldTables) oldCounts.set(table, Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c));

async function json(path: string, init?: RequestInit): Promise<Record<string, any>> {
  const res = await fetch(`${base}${path}`, init);
  const body = await res.json() as Record<string, any>;
  assert.ok(res.ok, `${path} ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

try {
  // 1) 首次映射：7 条可归因 + 2 条无归属跳过
  const first = await json('/runs/legacy-map', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sources: ['queue_job', 'exec_session', 'ai_usage'], limit: 1000 }),
  });
  assert.equal(first.inserted, 7, 'first mapping should insert 7 runs');
  assert.ok(first.skipped >= 2, 'unattributed legacy rows should be skipped');
  assert.ok(first.skippedByReason.no_task_attribution >= 2);
  assert.ok(first.counts.agentRuns >= 7);
  assert.ok(first.counts.agentRunSteps >= 17);

  // 2) 幂等重跑
  const second = await json('/runs/legacy-map', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sources: ['queue_job', 'exec_session', 'ai_usage'], limit: 1000 }),
  });
  assert.equal(second.inserted, 0);
  assert.ok(second.existing >= 7);
  assert.ok(second.counts.agentRuns >= 7);
  assert.ok(second.counts.agentRunSteps >= 17);

  // 3) 列表过滤
  const byTask = await json(`/runs?taskId=${encodeURIComponent(taskNo1)}&limit=50`);
  assert.equal(byTask.total, 4);
  assert.equal(byTask.items.length, 4);
  const byProject = await json(`/runs?projectId=${encodeURIComponent(projectId)}&limit=50`);
  assert.equal(byProject.total, 7);
  const succeeded = await json('/runs?status=succeeded&limit=50');
  assert.ok(succeeded.total >= 3);
  const failed = await json('/runs?status=failed&limit=50');
  assert.ok(failed.total >= 2);
  const usage = await json('/runs?legacySource=ai_usage&limit=50');
  assert.ok(usage.total >= 2);

  // 4) 详情与步骤
  const detail = await json(`/runs/${encodeURIComponent(`legacy:queue_job:${jobOk}`)}`);
  assert.equal(detail.id, `legacy:queue_job:${jobOk}`);
  assert.equal(detail.taskId, task1);
  assert.equal(detail.model, 'doubao-pro');
  assert.equal(detail.status, 'succeeded');
  assert.equal(detail.steps.length, 3);
  assert.equal(detail.steps[1].output, '{"receipt":"OK"}');
  assert.ok(detail.warnings.some((w: string) => w.includes('queue_job')));

  const steps = await json(`/runs/${encodeURIComponent(`legacy:queue_job:${jobOk}`)}/steps`);
  assert.equal(steps.runId, `legacy:queue_job:${jobOk}`);
  assert.equal(steps.stepCount, 3);
  assert.deepEqual(steps.steps.map((s: any) => s.seq), [0, 1, 2]);

  const usageDetail = await json(`/runs/${encodeURIComponent(`legacy:ai_usage:${usageTask}`)}`);
  assert.equal(usageDetail.status, 'failed');
  assert.equal(usageDetail.errorCode, 'ai_usage_error');
  assert.equal(usageDetail.steps.length, 1);

  // 5) 旧表行数与定义不变
  for (const table of oldTables) {
    assert.equal(Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c), oldCounts.get(table), `${table} row count changed`);
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string }).sql;
    assert.ok(sql.includes('CREATE TABLE'), `${table} DDL missing`);
  }

  console.log(JSON.stringify({
    verdict: 'PASS',
    first: { inserted: first.inserted, skipped: first.skipped, runs: first.counts.agentRuns, steps: first.counts.agentRunSteps },
    second: { inserted: second.inserted, existing: second.existing },
    list: { byTask: byTask.total, byProject: byProject.total, usage: usage.total },
    sampleRunId: `legacy:queue_job:${jobOk}`,
  }, null, 2));
} finally {
  db.close();
}
