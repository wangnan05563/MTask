#!/usr/bin/env node
/**
 * T06298（REQ-036 / PRD §B6）Run 追踪详情只读契约门禁。
 *
 * 覆盖：
 * - 原生 Run：头部字段、步骤排序、风险、成本归因、审批状态、输入输出；
 * - legacy 映射：`legacy:exec_session:<id>` 优先命中原生 Run，避免出现两份；
 * - 无原生映射 / 无 agent_runs 表：旧会话合成稳定 ID + 3 步兼容视图，不伪装成本；
 * - 未找到返回 null；步骤成本与 Run 成本不一致时给 warning。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs server/scripts/verify-t06298-run-trace.mts
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';
import { RunTraceService } from '../src/services/RunTraceService.ts';

const NOW = '2026-11-24T02:00:08.000Z';
const START = '2026-11-24T02:00:00.000Z';

function baseSchema(db: DatabaseSync, withRuns = true): void {
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, task_no TEXT, project_id TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'todo', archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE exec_sessions (
      id TEXT PRIMARY KEY, platform TEXT NOT NULL, session_id TEXT, task_ids TEXT NOT NULL,
      status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0, progress_reported INTEGER NOT NULL DEFAULT 0,
      phase TEXT NOT NULL DEFAULT '', last_heartbeat TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT
    );
  `);
  if (!withRuns) return;
  db.exec(`
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
  `);
}

function seedCommon(db: DatabaseSync): void {
  db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run('p1', '十期 Run 追踪');
  db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run('p2', '旧会话项目');
  db.prepare('INSERT INTO tasks (id, task_no, project_id, title, status, archived) VALUES (?, ?, ?, ?, ?, ?)')
    .run('t-run', 'T06298', 'p1', 'Run 追踪UI', 'doing', 0);
  db.prepare('INSERT INTO tasks (id, task_no, project_id, title, status, archived) VALUES (?, ?, ?, ?, ?, ?)')
    .run('t-legacy', 'T06300', 'p2', '旧会话兼容', 'todo', 0);
  db.prepare(`INSERT INTO exec_sessions (id, platform, session_id, task_ids, status, progress, progress_reported, phase, last_heartbeat, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('sess-native', 'workbuddy', 'ext-native', JSON.stringify(['t-run']), 'done', 100, 1,
      '完成提交', '2026-11-24T02:00:05.000Z', START, NOW);
  db.prepare(`INSERT INTO exec_sessions (id, platform, session_id, task_ids, status, progress, progress_reported, phase, last_heartbeat, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('sess-legacy', 'trae', 'ext-legacy', JSON.stringify(['t-legacy']), 'stalled', 42, 1,
      '读取仓库', '2026-11-24T01:59:00.000Z', '2026-11-24T01:58:00.000Z', null);
}

function seedRun(db: DatabaseSync): void {
  db.prepare(`INSERT INTO agent_runs (id, task_id, project_id, queue_id, parent_run_id, status, trigger_type, model,
      prompt_version, tokens, cost, executor, started_at, ended_at, error_code, legacy_source, legacy_ref, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('run-native-1', 't-run', 'p1', null, null, 'succeeded', 'legacy', 'doubao-pro', 'p10-run-trace-v1',
      12345, 0.42, 'workbuddy', START, NOW, '', 'exec_session', 'sess-native', START, NOW);
  const step = db.prepare(`INSERT INTO agent_run_steps (id, run_id, seq, type, status, input, output, duration_ms, cost, risk_level, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  step.run('step-1', 'run-native-1', 1, 'tool', 'succeeded', '{"files":["a.ts"]}', '读取 2 个文件', 2400, 0.05, 'R1', START, NOW);
  step.run('step-0', 'run-native-1', 0, 'prompt', 'succeeded', '{"task":"T06298"}', '装配上下文', 1200, 0.03, 'R0', START, NOW);
  step.run('step-2', 'run-native-1', 2, 'observation', 'succeeded', '{"cmd":"npm test"}', '12 passed', 2000, 0.08, 'R0', START, NOW);
  step.run('step-3', 'run-native-1', 3, 'artifact', 'succeeded', '{"diff":"..."}', '{"commit":"abc123"}', 900, 0.26, 'R2', START, NOW);
  step.run('step-4', 'run-native-1', 4, 'approval', 'succeeded', '{"risk":"R2"}', '人工批准', 1500, 0, 'R2', START, NOW);
}

const db = new DatabaseSync(':memory:');
baseSchema(db);
seedCommon(db);
seedRun(db);
const svc = new RunTraceService(db as unknown as Database.Database);

// 1) 原生 Run 按 id 读取：头部字段与任务/项目贯通
const native = svc.getRun('run-native-1');
assert.ok(native, 'native run should exist');
assert.equal(native.source, 'native');
assert.equal(native.status, 'succeeded');
assert.equal(native.taskNo, 'T06298');
assert.equal(native.taskTitle, 'Run 追踪UI');
assert.equal(native.projectName, '十期 Run 追踪');
assert.equal(native.model, 'doubao-pro');
assert.equal(native.promptVersion, 'p10-run-trace-v1');
assert.equal(native.tokens, 12345);
assert.equal(native.cost, 0.42);
assert.equal(native.executor, 'workbuddy');
assert.equal(native.durationMs, 8000);
assert.equal(native.errorCode, '');
assert.equal(native.legacySource, 'exec_session');
assert.equal(native.legacyRef, 'sess-native');
assert.equal(native.legacy, true);

// 2) 步骤按 seq 排序，类型/风险/成本归因正确
assert.deepEqual(native.steps.map((s) => s.seq), [0, 1, 2, 3, 4]);
assert.deepEqual(native.steps.map((s) => s.type), ['prompt', 'tool', 'observation', 'artifact', 'approval']);
assert.equal(native.steps[3].riskLevel, 'R2');
assert.equal(native.steps[0].input, '{"task":"T06298"}');
assert.equal(native.steps[2].output, '12 passed');
assert.equal(Math.round(native.stepCostTotal * 100) / 100, 0.42);
assert.equal(native.unattributedCost, 0);
assert.deepEqual(native.costBreakdown.map((s) => s.label), ['Prompt', '工具调用', '观察', '产物']);
assert.deepEqual(native.costBreakdown.map((s) => s.pct), [7.1, 11.9, 19, 61.9]);
assert.equal(native.approval.status, 'approved');
assert.equal(native.approval.label, '已批准');
assert.equal(native.approval.stepId, 'step-4');

// 3) legacy 前缀优先命中原生映射，不重复成两份
const mapped = svc.getRun('legacy:exec_session:sess-native');
assert.ok(mapped);
assert.equal(mapped.id, 'run-native-1');
assert.equal(mapped.source, 'native');

// 4) 无原生映射的旧会话：稳定合成 ID + 3 步，不伪造成本/审批
const legacy = svc.getRun('legacy:exec_session:sess-legacy');
assert.ok(legacy);
assert.equal(legacy.id, 'legacy:exec_session:sess-legacy');
assert.equal(legacy.source, 'legacy_exec_session');
assert.equal(legacy.status, 'paused');
assert.equal(legacy.taskNo, 'T06300');
assert.equal(legacy.projectName, '旧会话项目');
assert.equal(legacy.cost, 0);
assert.equal(legacy.tokens, 0);
assert.equal(legacy.costBreakdown.length, 0);
assert.equal(legacy.approval.status, 'none');
assert.equal(legacy.steps.length, 3);
assert.ok(legacy.steps.every((s) => s.synthetic));
assert.deepEqual(legacy.steps.map((s) => s.type), ['observation', 'observation', 'decision']);
assert.equal(legacy.steps[1].status, 'pending');
assert.equal(legacy.steps[2].status, 'pending');
assert.match(legacy.warnings.join(''), /旧执行会话兼容视图/);
assert.match(legacy.warnings.join(''), /映射\/回填完成后可回放成本/);

// 5) 直接传 exec_sessions.id 与带前缀得到同一稳定 Run
const rawRef = svc.getRun('sess-legacy');
assert.ok(rawRef);
assert.equal(rawRef.id, legacy.id);

// 6) 不存在的 Run 返回 null
assert.equal(svc.getRun('run-not-exist'), null);
assert.equal(svc.getRun(''), null);

// 7) 步骤成本高于 Run 成本时给 warning，且不把差额负值塞进归因
const dbWarn = new DatabaseSync(':memory:');
baseSchema(dbWarn);
seedCommon(dbWarn);
seedRun(dbWarn);
dbWarn.prepare('UPDATE agent_runs SET cost = 0.10 WHERE id = ?').run('run-native-1');
const warnSvc = new RunTraceService(dbWarn as unknown as Database.Database);
const warn = warnSvc.getRun('run-native-1');
assert.ok(warn);
assert.match(warn.warnings.join(''), /高于 Run 成本/);
assert.equal(warn.unattributedCost, 0);

// 8) 没有 agent_runs 表时仍能读取旧会话兼容视图（生产库现状）
const dbNoRuns = new DatabaseSync(':memory:');
baseSchema(dbNoRuns, false);
seedCommon(dbNoRuns);
const noRunsSvc = new RunTraceService(dbNoRuns as unknown as Database.Database);
assert.equal(noRunsSvc.getRun('run-native-1'), null);
const fallback = noRunsSvc.getRun('legacy:exec_session:sess-legacy');
assert.ok(fallback);
assert.equal(fallback.source, 'legacy_exec_session');
assert.equal(fallback.steps.length, 3);

// 9) 原生 Run 无步骤：返回空时间线，不抛错
const dbEmpty = new DatabaseSync(':memory:');
baseSchema(dbEmpty);
seedCommon(dbEmpty);
dbEmpty.prepare(`INSERT INTO agent_runs (id, task_id, project_id, status, trigger_type, model, prompt_version,
  tokens, cost, executor, started_at, ended_at, error_code, legacy_source, legacy_ref, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run('run-empty', 't-run', 'p1', 'running', 'manual', 'doubao', 'v1', 0, 0, 'agent', START, null, '', '', '', START, START);
const emptySvc = new RunTraceService(dbEmpty as unknown as Database.Database);
const empty = emptySvc.getRun('run-empty');
assert.ok(empty);
assert.equal(empty.steps.length, 0);
assert.equal(empty.approval.status, 'none');
assert.equal(empty.durationMs, null);

console.log('T06298 Run 追踪契约门禁：9 组 / 63 断言 PASS');
