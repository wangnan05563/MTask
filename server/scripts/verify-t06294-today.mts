#!/usr/bin/env node
/**
 * T06294（REQ-001 / AC-01）Today View 聚合门禁。
 *
 * 用 5k 任务的内存库直接调用 buildTodayView，覆盖：
 * - 今日行动池只取未归档、未搁置、待办中的置顶/高优先级，最多 7 条且按置顶→优先级排序；
 * - 等我处理包含未完成 AI 失败/未读/待裁决、已完成待验证、近 7 天完成未读，排除 10 天前历史未读；
 * - 项目筛选与在跑会话/无会话 running 兜底；
 * - 5k 数据构造 + 聚合全程 < 3s（AC-01 的服务端预算）。
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { buildTodayView } from '../src/services/TodayService.ts';

const now = Date.now();
const recent = new Date(now - 86400000).toISOString().slice(0, 19);
const old = new Date(now - 10 * 86400000).toISOString().slice(0, 19);
const started = new Date(now - 2 * 3600000).toISOString();

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
`);
db.exec("INSERT INTO projects (id, name) VALUES ('p1', '十期项目'), ('p2', '其它项目')");

type Seed = {
  id: string; title: string; priority?: string; status?: string; aiState?: string;
  verified?: number; pinned?: number; ruling?: string; project?: string; updated?: string;
  progress?: number;
};
const seeds: Seed[] = [];
let n = 0;
const add = (seed: Omit<Seed, 'id' | 'title'> & { title?: string }) => {
  n += 1;
  seeds.push({
    id: `task-${n}`,
    title: seed.title ?? `任务 ${n}`,
    priority: seed.priority ?? 'normal',
    status: seed.status ?? 'todo',
    aiState: seed.aiState ?? '',
    verified: seed.verified ?? 0,
    pinned: seed.pinned ?? 0,
    ruling: seed.ruling ?? '',
    project: seed.project ?? 'p1',
    updated: seed.updated ?? recent,
    progress: seed.progress ?? 0,
  });
};

// 背景：4,900 条普通待办（p2），不应进入今日三组
for (let i = 0; i < 4900; i += 1) add({ project: 'p2', title: `背景任务 ${i}` });
// 今日候选：100 条紧急/高优先级 + 5 条置顶普通；期望只展示 7 条，置顶排第一
for (let i = 0; i < 100; i += 1) add({ priority: i % 2 ? 'urgent' : 'high', title: `高优先级 ${i}` });
for (let i = 0; i < 5; i += 1) add({ pinned: 1, title: `置顶 ${i}` });
// 等我处理：50 未完成未读、5 未完成失败、3 待裁决、80 已完成待验证、20 近 7 天完成未读；另 100 条 10 天前完成未读必须排除
for (let i = 0; i < 50; i += 1) add({ aiState: 'unread', title: `未读待办 ${i}` });
for (let i = 0; i < 5; i += 1) add({ aiState: 'failed', title: `失败待办 ${i}` });
for (let i = 0; i < 3; i += 1) add({ ruling: '待裁决', title: `待裁决 ${i}` });
for (let i = 0; i < 80; i += 1) add({ status: 'done', verified: 0, title: `待验证 ${i}`, updated: i % 2 ? recent : old });
for (let i = 0; i < 20; i += 1) add({ status: 'done', verified: 1, aiState: 'unread', title: `近期完成未读 ${i}` });
for (let i = 0; i < 100; i += 1) add({ status: 'done', verified: 1, aiState: 'unread', title: `历史完成未读 ${i}`, updated: old });
// 在跑兜底：一个 running 任务没有活跃会话
add({ aiState: 'running', title: '无会话运行中', progress: 37 });

const insert = db.prepare(`
  INSERT INTO tasks (id, task_no, project_id, title, priority, status, ai_state, ai_state_at,
    verified, archived, shelved, ruling_state, pinned, progress, history_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, NULL, ?)
`);
for (const [index, seed] of seeds.entries()) {
  insert.run(
    seed.id, `T${String(index + 1).padStart(5, '0')}`, seed.project!, seed.title!,
    seed.priority!, seed.status!, seed.aiState!, recent, seed.verified!, seed.ruling!,
    seed.pinned!, seed.progress!, seed.updated!,
  );
}

const insertSession = db.prepare(`
  INSERT INTO exec_sessions (id, platform, status, progress, progress_reported, phase, started_at, last_heartbeat, task_ids)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
insertSession.run('s-p1', 'workbuddy', 'active', 42, 1, '实现 Today View', started, recent, '["task-5001"]');
insertSession.run('s-p2', 'doubao', 'active', 10, 0, '背景任务', started, recent, '["task-1"]');
insertSession.run('s-stalled', 'doubao', 'stalled', 0, 0, '卡住', old, old, '["task-5002"]');

const t0 = performance.now();
const all = buildTodayView(db as never, '');
const elapsed = performance.now() - t0;

assert.equal(all.summary.today_candidates, 105, '今日候选应为 100 高优先级 + 5 置顶');
assert.equal(all.summary.today, 7, '首屏最多 7 条今日行动');
assert.equal(all.today.length, 7);
assert.equal(all.today[0].title, '置顶 0', '置顶必须排在最高优先级之前');
assert.equal(all.summary.waiting, 158, '等我处理只含当前工作集，排除 10 天前历史未读');
assert.equal(all.waiting.counts.ai_failed, 5);
assert.equal(all.waiting.counts.ai_unread, 70, '50 未读待办 + 20 近期完成未读');
assert.equal(all.waiting.counts.verify_pending, 80);
assert.equal(all.waiting.counts.ruling_pending, 3);
assert.equal(all.waiting.items[0].reason, 'ai_failed', '失败任务优先出现在等我处理');
assert.equal(all.summary.running, 3, '两个活跃会话 + 一个无会话 running 兜底');
assert.equal(all.running.active_sessions, 2);
assert.ok(all.running.items.some((x) => x.kind === 'task' && x.title === '无会话运行中'), '无会话 running 任务必须兜底可见');
assert.equal(all.summary.alerts, 2, 'AI 失败 + 在最近会话中停滞');

const p1 = buildTodayView(db as never, 'p1');
assert.equal(p1.summary.today_candidates, 105);
assert.equal(p1.summary.waiting, 158);
assert.equal(p1.summary.running, 2, '项目筛选后只保留 p1 的活跃会话 + 无会话兜底');
assert.deepEqual(p1.today.map((x) => x.project_id), Array(7).fill('p1'));

const p2 = buildTodayView(db as never, 'p2');
assert.equal(p2.summary.today_candidates, 0);
assert.equal(p2.summary.waiting, 0);
assert.equal(p2.summary.running, 1, 'p2 只保留自己的活跃会话');

assert.ok(elapsed < 3000, `5k 任务聚合耗时 ${elapsed.toFixed(1)}ms 超过 AC-01 3s 预算`);
console.log(JSON.stringify({
  ok: true,
  tasks: seeds.length,
  elapsed_ms: Number(elapsed.toFixed(1)),
  summary: all.summary,
  waiting_counts: all.waiting.counts,
  running: all.running.items.map((x) => ({ kind: x.kind, title: x.title, progress: x.progress })),
}, null, 2));
