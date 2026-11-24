#!/usr/bin/env node
/**
 * T06296（REQ-003 / PRD §A3 / AC-02）全局搜索门禁。
 *
 * 覆盖：
 * - 任务与 Run 统一返回、分组计数、精确标题优先；
 * - `type:task|run|all`、`@me` 与非法结构化语法降级；
 * - 归档/历史资产/搁置默认排除并按桶回传 outOfSight；
 * - 原生 `agent_runs` 与旧 `exec_sessions` 同源；legacy 会话不重复成条；
 * - 空查询返回最近对象、零结果给建议；
 * - AC-02：1,000 份本地文档（任务正文）下 100 次搜索 P95 < 300ms。
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import type Database from 'better-sqlite3';
import { GlobalSearchService } from '../src/services/GlobalSearchService.ts';

const now = new Date().toISOString();
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, task_no TEXT, project_id TEXT NOT NULL, title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL DEFAULT 'normal',
    status TEXT NOT NULL DEFAULT 'todo', archived INTEGER NOT NULL DEFAULT 0,
    history_at TEXT, shelved INTEGER NOT NULL DEFAULT 0,
    ai_summary TEXT, handle_result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT NOT NULL, queue_id TEXT,
    parent_run_id TEXT, status TEXT NOT NULL, trigger_type TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
    prompt_version TEXT NOT NULL DEFAULT '', tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
    executor TEXT NOT NULL DEFAULT '', started_at TEXT, ended_at TEXT, error_code TEXT NOT NULL DEFAULT '',
    legacy_source TEXT NOT NULL DEFAULT '', legacy_ref TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE exec_sessions (
    id TEXT PRIMARY KEY, platform TEXT NOT NULL, session_id TEXT, task_ids TEXT NOT NULL,
    status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0, progress_reported INTEGER NOT NULL DEFAULT 0,
    phase TEXT NOT NULL DEFAULT '', last_heartbeat TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT
  );
  INSERT INTO projects (id, name) VALUES ('p1', '十期项目'), ('p2', '搜索专项');
`);

const taskInsert = db.prepare(`
  INSERT INTO tasks (id, task_no, project_id, title, description, priority, status, archived,
    history_at, shelved, ai_summary, handle_result, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const longDoc = '本地优先的搜索需要覆盖任务正文、Run 上下文、结果摘要与验收证据，避免依赖外部索引库。'.repeat(36);
function task(
  id: string, no: string, title: string, opts: {
    description?: string; status?: string; archived?: number; history?: string | null;
    shelved?: number; updated?: string; project?: string; priority?: string;
  } = {},
): void {
  taskInsert.run(
    id, no, opts.project ?? 'p1', title, opts.description ?? longDoc, opts.priority ?? 'normal',
    opts.status ?? 'todo', opts.archived ?? 0, opts.history ?? null, opts.shelved ?? 0,
    opts.description ? `摘要：${opts.description.slice(0, 40)}` : '', opts.description ? `结论：${opts.description.slice(-40)}` : '',
    now, opts.updated ?? now,
  );
}

// 1,000 份“文档” = 任务正文/结果/AI 摘要，满足 AC-02 的数据量口径。
for (let i = 0; i < 1000; i += 1) {
  task(`doc-${i}`, `T1${String(i).padStart(4, '0')}`, `搜索文档 ${i}`,
    { description: `第 ${i} 份文档。${longDoc}`, project: 'p2' });
}
// 精确标题 / 编号 / 范围外各一条
task('t-exact', 'T06296', '全局搜索服务', { description: '实现搜索 API 与前端浮层，支持任务与 Run 查询，不索引外部库。', priority: 'urgent' });
task('t-archived', 'T90001', '归档搜索旧稿', { archived: 1, description: '归档里的搜索文档' });
task('t-history', 'T90002', '历史搜索资产', { history: now, description: '历史资产里的搜索文档' });
task('t-shelved', 'T90003', '搁置搜索草稿', { shelved: 1, description: '搁置区里的搜索文档' });

const runInsert = db.prepare(`
  INSERT INTO agent_runs (id, task_id, project_id, status, trigger_type, model, executor,
    started_at, legacy_source, legacy_ref, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
runInsert.run('run-search-1', 't-exact', 'p1', 'running', 'manual', 'doubao', 'agent-main', now, '', '', now, now);
runInsert.run('run-legacy-1', 't-exact', 'p1', 'failed', 'legacy', 'workbuddy', '外部执行器', now,
  'exec_session', 'sess-search-1', now, now);

const sessionInsert = db.prepare(`
  INSERT INTO exec_sessions (id, platform, session_id, task_ids, status, progress,
    progress_reported, phase, last_heartbeat, started_at, finished_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
sessionInsert.run('sess-search-1', 'workbuddy', 'sess-search-1', '["t-exact"]', 'running', 42, 1,
  '执行全局搜索', '2026-11-24T09:00:00.000Z', now, null);
for (let i = 0; i < 120; i += 1) {
  sessionInsert.run(`sess-bg-${i}`, 'workbuddy', `sess-bg-${i}`, JSON.stringify([`doc-${i}`]),
    i % 2 ? 'done' : 'running', i % 100, 1, `阶段 ${i}`, `2026-11-24T08:${String(i % 60).padStart(2, '0')}:00.000Z`, now, null);
}

const service = new GlobalSearchService(db as unknown as Database.Database);

// 1) 任务与 Run 统一返回；精确标题优先；Run 含原生与旧执行会话
const all = service.search('全局搜索', { limit: 10 });
assert.equal(all.groups.length, 2, '应同时返回任务与 Run 两组');
assert.deepEqual(all.groups.map((g) => g.type), ['task', 'run']);
assert.equal(all.groups[0].items[0].taskNo, 'T06296', '精确标题 T06296 应排第一');
assert.ok(all.groups[1].items.some((h) => h.source === 'agent_run' && h.id === 'run-search-1'), '缺原生 Run');
assert.ok(all.groups[1].items.every((h) => h.id !== 'sess-search-1'), 'legacy Run 已由 agent_runs 合成，不应重复列执行会话');
assert.ok(all.groups[0].items[0].snippet.includes('前端浮层'), '任务命中应带上下文预览');
assert.ok(all.elapsedMs >= 0);
assert.equal(all.zeroResult, false);

// 2) type: 只裁剪对象组；type:all 恢复两组
assert.deepEqual(service.search('type:run 全局搜索').groups.map((g) => g.type), ['run']);
assert.deepEqual(service.search('type:task 全局搜索').groups.map((g) => g.type), ['task']);
assert.deepEqual(service.search('type:all 全局搜索').groups.map((g) => g.type), ['task', 'run']);

// 3) 编号精确命中、归档/历史/搁置默认不可见但范围外有计数
const byNo = service.search('T06296');
assert.equal(byNo.groups[0].items[0].id, 't-exact');
assert.ok(!service.search('归档搜索').groups[0].items.some((h) => h.id === 't-archived'), '归档任务不应出现在当前可见区');
assert.ok(service.search('归档搜索').outOfSight.archived >= 1, '归档桶应计数');
assert.ok(service.search('历史搜索').outOfSight.history >= 1, '历史资产桶应计数');
assert.ok(service.search('搁置搜索').outOfSight.shelved >= 1, '搁置桶应计数');

// 4) 非法结构化语法降级；@me 明示不生效
const degraded = service.search('status:oops 搜索');
assert.equal(degraded.degraded, true);
assert.match(degraded.hint, /查询语法有误|status:/);
const me = service.search('@me 全局搜索');
assert.match(me.hint, /@me/);

// 5) 零结果给建议；空查询返回最近对象
const none = service.search('不存在的关键词 zzz');
assert.equal(none.zeroResult, true);
assert.ok(none.suggestions.length >= 3);
assert.ok(service.search('').groups.every((g) => g.items.length > 0), '空查询按最近对象返回');

// 6) AC-02：1k 文档下 100 次搜索 P95 < 300ms
for (let i = 0; i < 10; i += 1) service.search('全局搜索');
const samples: number[] = [];
for (let i = 0; i < 100; i += 1) {
  const t0 = performance.now();
  service.search(i % 3 === 0 ? '全局搜索' : (i % 3 === 1 ? 'T06296' : '验收证据'));
  samples.push(performance.now() - t0);
}
samples.sort((a, b) => a - b);
const p50 = samples[Math.floor(samples.length * 0.5)];
const p95 = samples[Math.floor(samples.length * 0.95)];
assert.ok(p95 < 300, `AC-02 P95 超限：${p95.toFixed(1)}ms`);
console.log(`T06296 search gate PASS · 1k docs · P50=${p50.toFixed(1)}ms P95=${p95.toFixed(1)}ms (100 queries)`);
console.log(`groups=${all.groups.map((g) => `${g.type}:${g.total}`).join(' ')} elapsed=${all.elapsedMs}ms`);
