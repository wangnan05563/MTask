#!/usr/bin/env node
/**
 * T06295（REQ-032 / PRD §A2）收件箱门禁。
 *
 * 用内存库直接调用 InboxService，覆盖：
 * - 增量 DDL / 唯一事件键 / 查询索引存在；
 * - 任务侧 AI 失败、待裁决、待验证三类事件入库，90 天外、归档、搁置、已转历史的任务不进入；
 * - 停滞执行会话进系统分类，重复同步不重复出现；
 * - 分类/状态/项目筛选与 open/unread 计数口径；
 * - read 清零、claim 不改变 open、ignore 变终态、convert 生成任务并解决条目；
 * - 源事件消失后 open 条目自动 resolved（source_cleared）；
 * - 1k 背景任务下首次同步 < 1.5s。
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import type Database from 'better-sqlite3';
import { INBOX_SCHEMA_SQL } from '../src/db/inboxSchema.ts';
import { InboxError, InboxService } from '../src/services/InboxService.ts';
import type { TaskInput, TaskView } from '../src/services/TaskService.ts';

const now = Date.now();
const recent = new Date(now - 3600000).toISOString();
const old = new Date(now - 100 * 86400000).toISOString();
const stale = new Date(now - 20 * 60000).toISOString();

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, task_no TEXT, project_id TEXT NOT NULL, title TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal', status TEXT NOT NULL DEFAULT 'todo',
    ai_state TEXT NOT NULL DEFAULT '', ai_state_at TEXT NOT NULL DEFAULT '',
    verified INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
    shelved INTEGER NOT NULL DEFAULT 0, ruling_state TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0, progress INTEGER NOT NULL DEFAULT 0,
    history_at TEXT, updated_at TEXT NOT NULL
  );
  CREATE TABLE exec_sessions (
    id TEXT PRIMARY KEY, platform TEXT NOT NULL, status TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0, progress_reported INTEGER NOT NULL DEFAULT 0,
    phase TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, last_heartbeat TEXT NOT NULL,
    task_ids TEXT NOT NULL DEFAULT '[]'
  );
  INSERT INTO projects (id, name) VALUES ('p1', '十期项目'), ('p2', '其它项目'), ('sys-inbox', '收件箱');
`);
db.exec(INBOX_SCHEMA_SQL);

const taskInsert = db.prepare(`
  INSERT INTO tasks (id, task_no, project_id, title, status, ai_state, verified, archived, shelved,
    ruling_state, history_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
function task(
  id: string, title: string, project: string, opts: {
    status?: string; ai?: string; verified?: number; archived?: number; shelved?: number;
    ruling?: string; history?: string | null; updated?: string;
  } = {},
): void {
  taskInsert.run(
    id, `T-${id}`, project, title,
    opts.status ?? 'todo', opts.ai ?? '', opts.verified ?? 0,
    opts.archived ?? 0, opts.shelved ?? 0, opts.ruling ?? '',
    opts.history ?? null, opts.updated ?? recent,
  );
}

// 三类任务事件
task('t1', 'AI 失败任务', 'p1', { ai: 'failed' });
task('t2', '待裁决任务', 'p2', { ruling: '待裁决' });
task('t3', '待验证任务', 'p1', { status: 'done' });
// 不应进入收件箱：已验证 / 90 天外 / 归档 / 搁置 / 已转历史
task('t4', '已验证任务', 'p1', { status: 'done', verified: 1 });
task('t5', '90 天外失败', 'p1', { ai: 'failed', updated: old });
task('t6', '已归档失败', 'p1', { ai: 'failed', archived: 1 });
task('t7', '已搁置失败', 'p1', { ai: 'failed', shelved: 1 });
task('t8', '已转历史失败', 'p1', { ai: 'failed', history: recent });
// 背景任务：只影响同步扫描成本，不产生条目
for (let i = 0; i < 1000; i += 1) {
  task(`bg-${i}`, `背景任务 ${i}`, 'p2', { status: 'done', verified: 1 });
}

db.prepare(`
  INSERT INTO exec_sessions (id, platform, status, phase, started_at, last_heartbeat)
  VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)
`).run(
  's1', 'workbuddy', 'stalled', '构造页面', recent, recent,
  's2', 'workbuddy', 'stalled', '回归测试', recent, recent,
  's3', 'workbuddy', 'running', '执行中', recent, recent,
);

let created = 0;
const createdRows: Array<{ id: string; title: string; projectId: string }> = [];
const createTask = (input: TaskInput): TaskView => {
  created += 1;
  const id = `created-${created}`;
  const taskNo = `T9000${created}`;
  taskInsert.run(id, taskNo, input.projectId, input.title, 'todo', '', 0, 0, 0, '', null, new Date().toISOString());
  createdRows.push({ id, title: input.title, projectId: input.projectId });
  return { id, task_no: taskNo, title: input.title, project_id: input.projectId, status: 'todo' } as unknown as TaskView;
};

const service = new InboxService(db as unknown as Database.Database, createTask);

// 1) DDL 与索引
const cols = (db.prepare('PRAGMA table_info(inbox_items)').all() as Array<{ name: string }>).map((r) => r.name);
for (const col of ['id', 'type', 'source', 'task_id', 'run_id', 'project_id', 'title', 'body', 'severity',
  'status', 'assignee', 'event_key', 'unread', 'resolution', 'created_at', 'updated_at', 'claimed_at',
  'resolved_at', 'last_seen_at']) {
  assert.ok(cols.includes(col), `inbox_items 缺列 ${col}`);
}
const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='inbox_items'").all() as Array<{ name: string }>)
  .map((r) => r.name);
assert.ok(indexes.includes('idx_inbox_items_event_key'), '缺 event_key 唯一索引');
assert.ok(indexes.includes('idx_inbox_items_open_type'), '缺 open+type 查询索引');

// 2) 首次同步：3 条任务 + 2 条停滞会话；重复同步不新增
const start = performance.now();
service.sync();
const elapsed = performance.now() - start;
assert.ok(elapsed < 1500, `1k 背景任务首次同步耗时过高：${elapsed.toFixed(1)}ms`);

let list = service.list({ status: 'open' });
assert.equal(list.total, 5, `open 应为 5，实际 ${list.total}`);
assert.deepEqual(
  list.items.map((i) => i.title).sort(),
  ['AI 失败任务', '待裁决任务', '待验证任务', '执行会话停滞：回归测试', '执行会话停滞：构造页面'].sort(),
);
assert.deepEqual(list.counts, { open: 5, unread: 5, decision: 1, ai_failed: 1, verify_pending: 1, system: 2 });
assert.equal(db.prepare('SELECT COUNT(*) AS c FROM inbox_items').get()!.c, 5, '首次同步条目数应为 5');

service.sync();
assert.equal(db.prepare('SELECT COUNT(*) AS c FROM inbox_items').get()!.c, 5, '重复同步不应新增条目');
assert.equal(service.list({ status: 'open' }).total, 5, '重复同步后 open 仍为 5');

// 3) 分类 / 状态 / 项目筛选
assert.equal(service.list({ type: 'ai_failed' }).total, 1);
assert.equal(service.list({ type: 'decision' }).total, 1);
assert.equal(service.list({ projectId: 'p2' }).total, 1, 'p2 只有待裁决任务');
assert.equal(service.list({ projectId: 'p2' }).counts.system, 0, '系统条目无项目归属');
assert.equal(service.list({ status: 'ignored' }).total, 0);
assert.equal(service.summary().counts.open, 5);

// 4) read：指定 id 清零后全部清零；open 数不变
const first = list.items.find((i) => i.type === 'ai_failed')!;
assert.equal(service.markRead([first.id]), 1, '指定 id 应清 1 条未读');
assert.equal(service.summary().counts.unread, 4, '剩余 4 条未读');
assert.equal(service.markRead(), 4, '全部 read 应再清 4 条');
assert.equal(service.markRead(), 0, 'read 必须幂等');
assert.equal(service.summary().counts.unread, 0);
assert.equal(service.summary().counts.open, 5, 'read 不改变 open');

// 5) claim：assignee=我、claimed_at 写入，但 status 仍 open
const claimed = service.claim(first.id);
assert.equal(claimed.assignee, '我');
assert.equal(claimed.status, 'open');
assert.ok(claimed.claimed_at, 'claim 应写 claimed_at');
const claimedAgain = service.claim(first.id);
assert.equal(claimedAgain.claimed_at, claimed.claimed_at, '重复 claim 不应改 claimed_at');
assert.equal(service.summary().counts.open, 5, 'claim 后 open 仍为 5');

// 6) ignore：终态、open 减一
const decision = service.list({ type: 'decision' }).items[0];
const ignored = service.ignore(decision.id);
assert.equal(ignored.status, 'ignored');
assert.equal(ignored.resolution, 'ignored_by_user');
assert.equal(service.summary().counts.open, 4);
assert.equal(service.list({ status: 'ignored' }).total, 1);

// 7) convert：无 task_id 的系统条目转任务，条目变 resolved 并写 task_id
const system = service.list({ type: 'system' }).items[0];
const converted = service.convert(system.id, 'p1');
assert.equal(converted.task.id, createdRows[0].id);
assert.equal(converted.task.project_id, 'p1');
assert.equal(converted.item.status, 'resolved');
assert.equal(converted.item.resolution, 'converted_to_task');
assert.equal(converted.item.task_id, converted.task.id);
assert.equal(service.summary().counts.open, 3, '转任务后 open 再减一');
assert.equal(service.list({ status: 'resolved' }).total, 1);

// 已有任务的条目不可转任务；系统收件箱项目不可作为目标
assert.throws(() => service.convert(first.id, 'p1'), (e) => e instanceof InboxError && e.statusCode === 409);
assert.throws(() => service.convert(system.id, 'sys-inbox'), (e) => e instanceof InboxError);
assert.throws(() => service.convert(system.id, 'missing'), (e) => e instanceof InboxError);

// 8) 源事件消失自动收敛：手工塞一条 20 分钟未刷新、源已不存在的 open 条目
const goneId = 'gone-item';
db.prepare(`
  INSERT INTO inbox_items
    (id, type, source, task_id, project_id, title, body, severity, status, assignee, event_key, unread,
     resolution, created_at, updated_at, last_seen_at)
  VALUES (?, 'ai_failed', 'task', NULL, 'p1', '已消失事件', '', 'danger', 'open', '', ?, 0, '', ?, ?, ?)
`).run(goneId, `task_ai_failed:${goneId}`, recent, stale, stale);
service.sync();
const gone = service.list({ status: 'resolved' }).items.find((i) => i.id === goneId);
assert.ok(gone, '消失事件应被自动收敛为 resolved');
assert.equal(gone.resolution, 'source_cleared');
assert.equal(service.summary().counts.open, 3, '自动收敛后 open 应剩 3（转任务后 3 条 + 手工塞入的 1 条再收敛）');

// 9) 项目不属于收件箱的条目不存在
assert.equal(service.list({ projectId: 'sys-inbox' }).total, 0);

console.log(JSON.stringify({
  ok: true,
  first_sync_ms: Number(elapsed.toFixed(1)),
  open_after_actions: service.summary().counts.open,
  created_tasks: createdRows,
  indexes,
}, null, 2));
