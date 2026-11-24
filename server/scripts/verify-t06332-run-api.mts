#!/usr/bin/env node
/**
 * T06332（REQ-036 / PRD §B6）Run 查询 / 旧数据映射服务门禁。
 *
 * 覆盖：
 * - queue_job / exec_session / 可归因 ai_usage 三类旧记录 → 稳定合成 Run；
 * - 同一 legacy 记录重复映射幂等，不新增 Run/Step；旧表行数与 DDL 不变；
 * - 无任务归属的 ai_usage 明确跳过，不伪造 task_id/project_id；
 * - Run 列表按任务编号、项目、状态、legacy_source 过滤与分页；
 * - 映射后的详情/步骤沿用 RunTraceService，字段、步骤排序与旧库快照一致；
 * - 重复映射刷新旧会话终态时，派生步骤重建且总行数不增长。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs server/scripts/verify-t06332-run-api.mts
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { AGENT_RUN_SCHEMA_SQL } from '../src/db/agentRunSchema.ts';
import { RunLegacyMapper, legacyRunId } from '../src/services/RunLegacyMapper.ts';
import { RunQueryService, RunQueryError } from '../src/services/RunQueryService.ts';
import { RunTraceService } from '../src/services/RunTraceService.ts';

const T = '2026-11-24T02:00:00.000Z';
const T1 = '2026-11-24T02:00:01.000Z';
const T5 = '2026-11-24T02:00:05.000Z';

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, task_no TEXT, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo', archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE ai_tools (id TEXT PRIMARY KEY, name TEXT NOT NULL, model TEXT);
  CREATE TABLE queues (id TEXT PRIMARY KEY, name TEXT NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL);
  CREATE TABLE queue_jobs (
    id TEXT PRIMARY KEY, queue_id TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    tool_id TEXT NOT NULL REFERENCES ai_tools(id) ON DELETE CASCADE,
    order_index INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'queued',
    request_payload TEXT, response_payload TEXT, error TEXT, sent_at TEXT, finished_at TEXT
  );
  CREATE TABLE exec_sessions (
    id TEXT PRIMARY KEY, platform TEXT NOT NULL, session_id TEXT, task_ids TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', progress REAL NOT NULL DEFAULT 0, progress_reported INTEGER NOT NULL DEFAULT 0,
    phase TEXT NOT NULL DEFAULT '', last_heartbeat TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT
  );
  CREATE TABLE ai_usage (
    id TEXT PRIMARY KEY, tool_id TEXT, tool_name TEXT NOT NULL, model TEXT DEFAULT '', kind TEXT NOT NULL,
    ok INTEGER NOT NULL DEFAULT 1, duration_ms INTEGER NOT NULL DEFAULT 0, content_chars INTEGER NOT NULL DEFAULT 0,
    error TEXT, card_key TEXT NOT NULL DEFAULT 'unknown', stage TEXT NOT NULL DEFAULT '',
    job_id TEXT NOT NULL DEFAULT '', prompt_tokens INTEGER, completion_tokens INTEGER, total_tokens INTEGER,
    created_at TEXT NOT NULL
  );
`);
db.exec(AGENT_RUN_SCHEMA_SQL);

db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('p1', 'MTask十期', T, T);
db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('p2', 'MTask其他', T, T);
db.prepare(`INSERT INTO tasks (id, task_no, project_id, title, status, archived, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('t1', 'T06332', 'p1', 'Run 查询与映射', 'doing', 0, T, T);
db.prepare(`INSERT INTO tasks (id, task_no, project_id, title, status, archived, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('t2', 'T06334', 'p2', '菜单布局优化', 'todo', 0, T, T);
db.prepare('INSERT INTO ai_tools (id, name, model) VALUES (?, ?, ?)').run('tool1', '豆包工具', 'doubao-pro');
db.prepare('INSERT INTO queues (id, name, date, status, created_at) VALUES (?, ?, ?, ?, ?)')
  .run('q1', '夜间队列', '2026-11-24', 'finished', T);

const insertQueue = db.prepare(`INSERT INTO queue_jobs
  (id, queue_id, task_id, tool_id, order_index, status, request_payload, response_payload, error, sent_at, finished_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
insertQueue.run('j-ok', 'q1', 't1', 'tool1', 1, 'success', '{"prompt":"run"}', '{"receipt":"OK"}', null, T, T5);
insertQueue.run('j-fail', 'q1', 't2', 'tool1', 2, 'failed', '{"prompt":"x"}', null, 'tool timeout', T, T5);
insertQueue.run('j-queued', 'q1', 't1', 'tool1', 3, 'queued', '{"prompt":"queued"}', null, null, null, null);

const insertSession = db.prepare(`INSERT INTO exec_sessions
  (id, platform, session_id, task_ids, status, progress, progress_reported, phase, last_heartbeat, started_at, finished_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
insertSession.run('s-done', 'workbuddy', 'ext-1', JSON.stringify(['t1']), 'done', 100, 1, '完成提交', T5, T, T5);
insertSession.run('s-active', 'trae', 'ext-2', JSON.stringify(['t2']), 'active', 42, 1, '读取仓库', T1, T, null);
insertSession.run('s-orphan', 'relay', 'ext-3', '[]', 'stalled', 0, 0, '', T1, T, null);

const insertUsage = db.prepare(`INSERT INTO ai_usage
  (id, tool_id, tool_name, model, kind, ok, duration_ms, content_chars, error, card_key, stage, job_id,
   prompt_tokens, completion_tokens, total_tokens, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
insertUsage.run('u-queue', 'tool1', '豆包工具', 'doubao-pro', 'organize', 1, 1500, 800, null, 'task.organize', 'summary', 'j-ok', 80, 40, 120, T5);
insertUsage.run('u-task', 'tool1', '豆包工具', 'doubao-pro', 'develop', 0, 500, 0, 'model error', 'task.develop', 'code', 't2', 7, 3, null, T5);
insertUsage.run('u-none', 'tool1', '豆包工具', 'doubao-pro', 'memory', 1, 900, 200, null, 'memory_extract', 'extract', 'memory_extract', 10, 10, 20, T5);

const oldTables = ['queue_jobs', 'exec_sessions', 'ai_usage'];
const oldSql = new Map<string, string>();
const oldCounts = new Map<string, number>();
for (const table of oldTables) {
  oldSql.set(table, (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string }).sql);
  oldCounts.set(table, Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c));
}

const mapper = new RunLegacyMapper(db);
const query = new RunQueryService(db);
const trace = new RunTraceService(db);

// 1) 三类旧记录首次映射：可归因记录全部入新表，无归属用量跳过
const first = mapper.map({ limit: 100 });
assert.equal(first.scanned, 9);
assert.equal(first.inserted, 7);
assert.equal(first.existing, 0);
assert.equal(first.skipped, 2);
assert.equal(first.failed, 0);
assert.equal(first.skippedByReason.no_task_attribution, 2);
assert.equal(first.counts.agentRuns, 7);
assert.equal(first.counts.agentRunSteps, 17);

// 稳定 ID 形状
assert.equal(legacyRunId('queue_job', 'j-ok'), 'legacy:queue_job:j-ok');
assert.equal(legacyRunId('exec_session', 's-done'), 'legacy:exec_session:s-done');
assert.equal(legacyRunId('ai_usage', 'u-queue'), 'legacy:ai_usage:u-queue');
assert.ok(first.items.some((item) => item.runId === 'legacy:queue_job:j-ok' && item.action === 'inserted'));
assert.ok(first.items.some((item) => item.source === 'ai_usage' && item.ref === 'u-none'
  && item.reason === 'no_task_attribution'));

// 2) 旧表行数与 DDL 不变
for (const table of oldTables) {
  assert.equal(Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c), oldCounts.get(table));
  assert.equal((db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string }).sql, oldSql.get(table));
}

// 3) 重复映射幂等：不新增、不改 ID、步骤总数不变
const second = mapper.map({ limit: 100 });
assert.equal(second.inserted, 0);
assert.equal(second.existing, 7);
assert.equal(second.skipped, 2);
assert.equal(second.counts.agentRuns, 7);
assert.equal(second.counts.agentRunSteps, 17);
const idsAfterSecond = db.prepare('SELECT id FROM agent_runs ORDER BY id').all() as { id: string }[];
assert.equal(idsAfterSecond.filter((r) => r.id.startsWith('legacy:queue_job:')).length, 3);
assert.equal(idsAfterSecond.filter((r) => r.id.startsWith('legacy:exec_session:')).length, 2);
assert.equal(idsAfterSecond.filter((r) => r.id.startsWith('legacy:ai_usage:')).length, 2);

// 4) 列表：按任务编号、项目、状态、来源过滤
const all = query.list({ limit: 50 });
assert.equal(all.total, 7);
assert.equal(all.items.length, 7);
assert.equal(all.items.filter((r) => r.status === 'queued').length, 1);
const byTaskNo = query.list({ taskId: 'T06332', limit: 50 });
assert.equal(byTaskNo.total, 4);
assert.deepEqual(new Set(byTaskNo.items.map((r) => r.legacySource)), new Set(['queue_job', 'exec_session', 'ai_usage']));
const byProject = query.list({ projectId: 'p2', limit: 50 });
assert.equal(byProject.total, 3);
const succeeded = query.list({ status: 'succeeded', limit: 50 });
assert.equal(succeeded.total, 3);
const failed = query.list({ status: 'failed', limit: 50 });
assert.equal(failed.total, 2);
const usageOnly = query.list({ legacySource: 'ai_usage', limit: 50 });
assert.equal(usageOnly.total, 2);
const paging = query.list({ limit: 2, offset: 1 });
assert.equal(paging.items.length, 2);
assert.equal(paging.total, 7);
assert.equal(paging.limit, 2);
assert.equal(paging.offset, 1);
assert.throws(() => query.list({ status: 'unknown' }), (e: unknown) => e instanceof RunQueryError && (e as RunQueryError).code === 'invalid_status');

// 5) 详情/步骤：映射后走原生 agent_runs，字段与快照正确
const queueRun = trace.getRun('legacy:queue_job:j-ok');
assert.ok(queueRun, 'mapped queue run should be readable');
assert.equal(queueRun.source, 'native');
assert.equal(queueRun.taskNo, 'T06332');
assert.equal(queueRun.projectId, 'p1');
assert.equal(queueRun.status, 'succeeded');
assert.equal(queueRun.model, 'doubao-pro');
assert.equal(queueRun.triggerType, 'legacy');
assert.equal(queueRun.steps.length, 3);
assert.deepEqual(queueRun.steps.map((s) => s.seq), [0, 1, 2]);
assert.equal(queueRun.steps[1].output, '{"receipt":"OK"}');
assert.equal(queueRun.steps[1].riskLevel, 'R1');
assert.ok(queueRun.warnings.some((w) => w.includes('queue_job:j-ok')));

const usageRun = trace.getRun('legacy:ai_usage:u-task');
assert.ok(usageRun, 'attributed usage run should be readable');
assert.equal(usageRun.taskNo, 'T06334');
assert.equal(usageRun.status, 'failed');
assert.equal(usageRun.tokens, 10);
assert.equal(usageRun.errorCode, 'ai_usage_error');
assert.equal(usageRun.steps.length, 1);
assert.equal(usageRun.steps[0].status, 'failed');
assert.match(usageRun.steps[0].output, /model error/);

// 6) 旧会话终态刷新：Run 状态推进、派生步骤重建但总数不增长
db.prepare("UPDATE exec_sessions SET status='failed', phase='测试失败', last_heartbeat=?, finished_at=? WHERE id='s-done'")
  .run(T5, T5);
const refreshed = mapper.map({ sources: ['exec_session'], limit: 100 });
assert.equal(refreshed.inserted, 0);
assert.equal(refreshed.existing, 2);
assert.equal(refreshed.counts.agentRuns, 7);
assert.equal(refreshed.counts.agentRunSteps, 17);
const failedSessionRun = trace.getRun('legacy:exec_session:s-done');
assert.ok(failedSessionRun);
assert.equal(failedSessionRun.status, 'failed');
assert.equal(failedSessionRun.steps.length, 3);
assert.equal(failedSessionRun.steps[2].output, '会话状态：执行失败');

// 7) 非法参数与表缺失
assert.throws(() => mapper.map({ sources: ['bogus'] }), /invalid_source/);
const emptyDb = new Database(':memory:');
assert.throws(() => new RunLegacyMapper(emptyDb).map({ limit: 1 }), /schema_missing/);
assert.throws(() => new RunQueryService(emptyDb).list(), (e: unknown) => e instanceof RunQueryError && (e as RunQueryError).code === 'schema_missing');

console.log(JSON.stringify({
  verdict: 'PASS',
  first: { scanned: first.scanned, inserted: first.inserted, skipped: first.skipped, runs: first.counts.agentRuns, steps: first.counts.agentRunSteps },
  list: { total: all.total, byTask: byTaskNo.total, byProject: byProject.total, succeeded: succeeded.total, failed: failed.total, usage: usageOnly.total },
  sampleRunId: 'legacy:queue_job:j-ok',
}, null, 2));

db.close();
emptyDb.close();
