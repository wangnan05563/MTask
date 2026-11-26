#!/usr/bin/env node
/**
 * T06295（REQ-032 / PRD §A2）收件箱门禁。
 *
 * 用内存库直接调用 InboxService，覆盖：
 * - 增量 DDL / 唯一事件键 / 查询索引存在；
 * - 任务侧 AI 失败、待裁决、待验证三类事件入库，90 天外、归档、搁置、已转历史的任务不进入；
 * - 停滞执行会话进系统分类，重复同步不重复出现；
 * - 分类/状态/项目筛选与 open/unread 计数口径；
 * - read 清零、claim 排他且可取消、ignore 变终态、convert 生成任务并解决条目；
 * - 同一来源再次发生（新 ai_state_at / 新 todo→done 事件）时终态条目可重开；
 * - 源事件消失后 open 条目自动 resolved（source_cleared），旧条目不被 1k 截断误收敛；
 * - 1k 背景任务下首次同步 < 1.5s。
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import type Database from 'better-sqlite3';
import { INBOX_SCHEMA_SQL, ensureInboxSchema } from '../src/db/inboxSchema.ts';
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
    ruling_at TEXT,
    pinned INTEGER NOT NULL DEFAULT 0, progress INTEGER NOT NULL DEFAULT 0,
    history_at TEXT, updated_at TEXT NOT NULL
  );
  CREATE TABLE exec_sessions (
    id TEXT PRIMARY KEY, platform TEXT NOT NULL, status TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0, progress_reported INTEGER NOT NULL DEFAULT 0,
    phase TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, last_heartbeat TEXT NOT NULL,
    task_ids TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE task_events (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, task_no TEXT, project_id TEXT NOT NULL,
    kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
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
  'status', 'assignee', 'event_key', 'event_version', 'unread', 'resolution', 'created_at', 'updated_at', 'claimed_at',
  'claim_expires_at', 'resolved_at', 'last_seen_at']) {
  assert.ok(cols.includes(col), `inbox_items 缺列 ${col}`);
}
const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='inbox_items'").all() as Array<{ name: string }>)
  .map((r) => r.name);
assert.ok(indexes.includes('idx_inbox_items_event_key'), '缺 event_key 唯一索引');
assert.ok(indexes.includes('idx_inbox_items_open_type'), '缺 open+type 查询索引');
assert.ok(indexes.includes('idx_inbox_items_assignee'), '缺 assignee 查询索引');
assert.equal((db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='inbox_audit'").get() as { c: number }).c, 1, '缺 inbox_audit 审计表');

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

// 5) claim：排他、认领后可取消；status 仍 open
const claimed = service.claim(first.id);
assert.equal(claimed.assignee, '我');
assert.equal(claimed.status, 'open');
assert.ok(claimed.claimed_at, 'claim 应写 claimed_at');
assert.throws(() => service.claim(first.id), (e) => e instanceof InboxError && e.statusCode === 409, '重复 claim 应 409');
assert.throws(() => service.claim(first.id, '同事'), (e) => e instanceof InboxError && e.statusCode === 409, '他人 claim 应 409');
assert.throws(() => service.ignore(first.id, '同事'), (e) => e instanceof InboxError && e.statusCode === 403, '非认领人 ignore 应 403');
assert.throws(() => service.unclaim(first.id, '同事'), (e) => e instanceof InboxError && e.statusCode === 403, '非认领人 unclaim 应 403');
const released = service.unclaim(first.id);
assert.equal(released.assignee, '');
assert.equal(released.claimed_at, null);
const reclaimed = service.claim(first.id);
assert.equal(reclaimed.assignee, '我');
assert.equal(reclaimed.status, 'open');
assert.equal(service.summary().counts.open, 5, 'claim/unclaim 后 open 仍为 5');
assert.equal(service.list({ assignee: '我' }).total, 1, '按 assignee 筛选应只到 1 条');
assert.equal(service.list({ claimed: 'mine' }).total, 1, 'claimed=mine 应由服务端身份解析为 1 条');
assert.equal(service.list({ claimed: 'no' }).total, 4, '未认领筛选应剩 4 条');
assert.equal(service.audit(first.id).map((a) => a.action).sort().join(','), 'claim,claim,unclaim', 'claim/unclaim 应留审计');

// 5.1) 认领租约到期：不依赖人工取消，sync 自动释放并写审计
db.prepare('UPDATE inbox_items SET claim_expires_at = ? WHERE id = ?').run(stale, first.id);
service.sync();
const expired = service.list({ type: 'ai_failed' }).items.find((i) => i.id === first.id)!;
assert.equal(expired.assignee, '', '过期认领应自动释放');
assert.equal(expired.claim_expires_at, null, '释放后应清空租约时间');
assert.equal(service.list({ claimed: 'mine' }).total, 0, '过期后不应再算我认领');
assert.equal(service.audit(first.id)[0]?.detail, 'claim_expired', '自动释放应写审计');
// 5.2) 管理员强制释放：不等租约到期也能解锁
const forceClaimed = service.claim(first.id);
assert.equal(forceClaimed.assignee, '我');
const forced = service.forceUnclaim(first.id, '管理员');
assert.equal(forced.assignee, '', '强制释放应清空 assignee');
assert.equal(forced.claim_expires_at, null, '强制释放应清空租约');
assert.equal(service.audit(first.id)[0]?.detail, 'force_release', '强制释放应写审计');
assert.equal(service.list({ claimed: 'mine' }).total, 0, '强制释放后不应再算我认领');

// 6) ignore：终态、open 减一；终态必须清空认领信息，避免 UI 显示「我 · 已解决」
const decision = service.list({ type: 'decision' }).items[0];
const claimedDecision = service.claim(decision.id);
assert.equal(claimedDecision.assignee, '我');
const ignored = service.ignore(decision.id);
assert.equal(ignored.status, 'ignored');
assert.equal(ignored.resolution, 'ignored_by_user');
assert.equal(ignored.assignee, '', '终态应清空 assignee');
assert.equal(ignored.claimed_at, null, '终态应清空 claimed_at');
assert.equal(ignored.claim_expires_at, null, '终态应清空 claim_expires_at');
const reopenedManual = service.reopen(decision.id, '我');
assert.equal(reopenedManual.status, 'open');
assert.equal(reopenedManual.unread, true);
assert.equal(service.audit(decision.id)[0]?.action, 'reopen', '手动恢复应写审计');
assert.equal(service.ignore(decision.id, '我').status, 'ignored');
assert.equal(service.summary().counts.open, 4);
assert.equal(service.list({ status: 'ignored' }).total, 1);

// 7) convert：无 task_id 的系统条目转任务，条目变 resolved 并写 task_id
const system = service.list({ type: 'system' }).items[0];
assert.equal(service.claim(system.id).assignee, '我');
const converted = service.convert(system.id, 'p1');
assert.equal(converted.task.id, createdRows[0].id);
assert.equal(converted.task.project_id, 'p1');
assert.equal(converted.item.status, 'resolved');
assert.equal(converted.item.resolution, 'converted_to_task');
assert.equal(converted.item.task_id, converted.task.id);
assert.equal(converted.item.assignee, '', '转任务终态应清空 assignee');
assert.equal(converted.item.claim_expires_at, null, '转任务终态应清空租约');
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
assert.equal(gone.assignee, '', '自动收敛应清空 assignee');
assert.equal(service.audit(goneId)[0]?.action, 'source_cleared', '自动收敛应写审计');
assert.equal(service.summary().counts.open, 3, '自动收敛后 open 应剩 3（转任务后 3 条 + 手工塞入的 1 条再收敛）');

// 9) 同一来源再次发生：新 ai_state_at / 新 todo→done 事件应重开终态条目
const aiItem = service.list({ type: 'ai_failed' }).items.find((i) => i.task_id === 't1')!;
assert.equal(service.ignore(aiItem.id, '我').status, 'ignored');
const newAiAt = new Date().toISOString();
db.prepare('UPDATE tasks SET ai_state_at = ?, updated_at = ? WHERE id = ?').run(newAiAt, newAiAt, 't1');
service.sync();
const reopenedAi = service.list({ type: 'ai_failed' }).items.find((i) => i.id === aiItem.id)!;
assert.equal(reopenedAi.status, 'open', '新 ai_state_at 应重开被忽略的 AI 失败条目');
assert.equal(reopenedAi.assignee, '', '新事件实例应释放旧认领');
assert.equal(service.audit(aiItem.id)[0]?.action, 'reopen', '新事件实例应写 reopen 审计');
// 同一事件实例再次忽略后保持 ignored，不被每轮同步重新打开
assert.equal(service.ignore(reopenedAi.id, '我').status, 'ignored');
service.sync();
assert.equal(service.list({ status: 'ignored' }).items.find((i) => i.id === aiItem.id)?.status, 'ignored');

const verifyItem = service.list({ type: 'verify_pending' }).items[0];
assert.equal(service.ignore(verifyItem.id).status, 'ignored');
service.sync();
assert.equal(service.list({ status: 'ignored' }).items.find((i) => i.id === verifyItem.id)?.status, 'ignored', '同一完成实例重复同步不应重开');
const doneAt = new Date().toISOString();
db.prepare(`
  INSERT INTO task_events (id, task_id, task_no, project_id, kind, detail, created_at)
  VALUES (?, ?, ?, ?, 'status', 'todo → done', ?)
`).run('ev-t3-done', 't3', 'T-t3', 'p1', doneAt);
db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(doneAt, 't3');
service.sync();
const reopenedVerify = service.list({ type: 'verify_pending' }).items.find((i) => i.id === verifyItem.id)!;
assert.equal(reopenedVerify.status, 'open', '新的 todo→done 事件应重开待验证条目');
assert.equal(reopenedVerify.assignee, '');
// task_events 默认只保留 90 天：事件被裁剪后不能把已忽略条目又重开
assert.equal(service.ignore(reopenedVerify.id, '我').status, 'ignored');
db.prepare('DELETE FROM task_events WHERE id = ?').run('ev-t3-done');
service.sync();
assert.equal(service.list({ status: 'ignored' }).items.find((i) => i.id === verifyItem.id)?.status, 'ignored', '完成事件被裁剪后不应误重开');

// 10) 90 天窗口/LIMIT 之外的存量 open 条目：来源仍活跃时不能被误判 source_cleared
task('t9', '90 天外但仍失败的存量任务', 'p1', { ai: 'failed', updated: old });
db.prepare(`
  INSERT INTO inbox_items
    (id, type, source, task_id, project_id, title, body, severity, status, assignee, event_key,
     event_version, unread, resolution, created_at, updated_at, last_seen_at)
  VALUES (?, 'ai_failed', 'task', 't9', 'p1', '存量失败事件', '', 'danger', 'open', '',
          'task_ai_failed:t9', 'legacy', 0, '', ?, ?, ?)
`).run('old-active-item', recent, stale, stale);
service.sync();
const oldActive = service.list({ type: 'ai_failed' }).items.find((i) => i.id === 'old-active-item')!;
assert.equal(oldActive.status, 'open', '90 天窗口外的存量条目，来源仍活跃时不能自动收敛');
db.prepare('UPDATE tasks SET ai_state = ? WHERE id = ?').run('', 't9');
db.prepare('UPDATE inbox_items SET last_seen_at = ? WHERE id = ?').run(stale, 'old-active-item');
service.sync();
const oldGone = service.list({ status: 'resolved' }).items.find((i) => i.id === 'old-active-item')!;
assert.equal(oldGone.resolution, 'source_cleared', '来源消失后才应收敛');

// 11) 项目不属于收件箱的条目不存在
assert.equal(service.list({ projectId: 'sys-inbox' }).total, 0);

// 12) convert 原子性：建任务抛错时，条目不落到 resolved / task_id
db.prepare(`
  INSERT INTO inbox_items
    (id, type, source, task_id, project_id, title, body, severity, status, assignee, event_key, unread,
     resolution, created_at, updated_at, last_seen_at)
  VALUES (?, 'ai_failed', 'manual', NULL, 'p1', '原子回滚测试', '', 'danger', 'open', '', ?, 1, '', ?, ?, ?)
`).run('atomic-item', 'manual:atomic', recent, recent, recent);
const failingConvert = new InboxService(db as unknown as Database.Database, () => {
  throw new Error('create failed for atomic test');
});
assert.throws(() => failingConvert.convert('atomic-item', 'p1'), /create failed/);
const atomicRow = db.prepare('SELECT status, task_id, assignee FROM inbox_items WHERE id = ?').get('atomic-item') as {
  status: string; task_id: string | null; assignee: string;
};
assert.equal(atomicRow.status, 'open', 'convert 失败后条目必须仍 open');
assert.equal(atomicRow.task_id, null, 'convert 失败后不能写 task_id');
assert.equal(atomicRow.assignee, '', 'convert 失败后不能留下认领残留');
db.prepare('DELETE FROM inbox_items WHERE id = ?').run('atomic-item');

// 13) 老库迁移：补列、审计表、终态边界回填（解决后发生的新事件不能被吞）
const legacyDb = new DatabaseSync(':memory:');
legacyDb.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, task_no TEXT, project_id TEXT NOT NULL, title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo', ai_state TEXT NOT NULL DEFAULT '',
    ai_state_at TEXT NOT NULL DEFAULT '', ruling_at TEXT, updated_at TEXT NOT NULL
  );
  CREATE TABLE exec_sessions (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL, last_heartbeat TEXT NOT NULL
  );
  CREATE TABLE task_events (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE inbox_items (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, source TEXT NOT NULL, task_id TEXT, run_id TEXT,
    project_id TEXT, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', severity TEXT NOT NULL DEFAULT 'warning',
    status TEXT NOT NULL DEFAULT 'open', assignee TEXT NOT NULL DEFAULT '', event_key TEXT NOT NULL,
    unread INTEGER NOT NULL DEFAULT 1, resolution TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, claimed_at TEXT, resolved_at TEXT, last_seen_at TEXT NOT NULL
  );
  INSERT INTO projects (id, name) VALUES ('p1', '老库项目');
  INSERT INTO tasks (id, task_no, project_id, title, status, ai_state, ai_state_at, ruling_at, updated_at)
  VALUES ('legacy-task', 'T-legacy', 'p1', '老库任务', 'todo', 'failed', '${newAiAt ?? ''}', NULL, '${recent}');
  INSERT INTO inbox_items
    (id, type, source, task_id, project_id, title, body, severity, status, assignee, event_key, unread,
     resolution, created_at, updated_at, claimed_at, resolved_at, last_seen_at)
  VALUES
    ('terminal-newer', 'ai_failed', 'task', 'legacy-task', 'p1', '终态后新事件', '', 'danger', 'ignored', '',
     'task_ai_failed:legacy-terminal', 0, 'ignored_by_user', '${recent}', '${stale}', NULL, '${recent}', '${recent}'),
    ('terminal-same', 'ai_failed', 'task', 'legacy-task', 'p1', '同一实例', '', 'danger', 'ignored', '',
     'task_ai_failed:legacy-same', 0, 'ignored_by_user', '${recent}', '${stale}', NULL, '${recent}', '${recent}');
`);
// terminal-newer：来源时间（任务 ai_state_at）晚于 resolved_at，回填 legacy
// terminal-same：来源时间早于 resolved_at，回填来源时间
legacyDb.prepare('UPDATE tasks SET ai_state_at = ? WHERE id = ?').run(new Date(now - 3600000).toISOString(), 'legacy-task');
legacyDb.prepare('UPDATE inbox_items SET resolved_at = ? WHERE id = ?').run(new Date(now - 2 * 3600000).toISOString(), 'terminal-newer');
legacyDb.prepare('UPDATE inbox_items SET resolved_at = ? WHERE id = ?').run(new Date(now).toISOString(), 'terminal-same');
ensureInboxSchema(legacyDb as unknown as Database.Database);
const legacyCols = (legacyDb.prepare('PRAGMA table_info(inbox_items)').all() as Array<{ name: string }>).map((r) => r.name);
assert.ok(legacyCols.includes('event_version'), '老库应补 event_version');
assert.ok(legacyCols.includes('claim_expires_at'), '老库应补 claim_expires_at');
assert.equal(
  (legacyDb.prepare('SELECT event_version FROM inbox_items WHERE id = ?').get('terminal-newer') as { event_version: string }).event_version,
  'legacy', '解决后发生的新事件必须回填 legacy',
);
assert.notEqual(
  (legacyDb.prepare('SELECT event_version FROM inbox_items WHERE id = ?').get('terminal-same') as { event_version: string }).event_version,
  'legacy', '解决前发生的事件应回填真实版本',
);

// 14) 规模摄入：超过旧 LIMIT 1000 的活跃候选必须全部入箱，不能静默截断
const beforeScale = service.list({ type: 'ai_failed' }).total;
for (let i = 0; i < 1001; i += 1) {
  task(`scale-${i}`, `规模任务 ${i}`, 'p1', { ai: 'failed' });
}
service.sync();
assert.equal(service.list({ type: 'ai_failed' }).total, beforeScale + 1001, '>1000 活跃任务应全部入箱');

console.log(JSON.stringify({
  ok: true,
  first_sync_ms: Number(elapsed.toFixed(1)),
  open_after_actions: service.summary().counts.open,
  created_tasks: createdRows,
  indexes,
}, null, 2));
