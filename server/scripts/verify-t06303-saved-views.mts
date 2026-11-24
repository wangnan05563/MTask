#!/usr/bin/env node
/**
 * T06303（REQ-009 / PRD §B1）保存视图契约门禁。
 *
 * 覆盖：项目隔离、名称去重（大小写不敏感）、创建/更新/复制/删除、私有/共享、
 * 非法类型/配置/名称拒绝；不触碰任务数据。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs server/scripts/verify-t06303-saved-views.mts
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';
import { ensureSavedViewSchema } from '../src/db/savedViewSchema.ts';
import { SavedViewError, SavedViewService } from '../src/services/SavedViewService.ts';

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  INSERT INTO projects (id, name) VALUES ('p-a', '保存视图 A'), ('p-b', '保存视图 B');
`);
ensureSavedViewSchema(db as unknown as Database.Database);
const svc = new SavedViewService(db as unknown as Database.Database);

// 1) 创建私有视图，列表回读配置
const created = svc.create('p-a', {
  name: '我的未验证待办', type: 'list',
  config: { search: '审批', priorityFilter: 'urgent', density: 'compact', boardHideEmpty: false },
  visibility: 'private', createdBy: 'web-ui',
});
assert.equal(created.projectId, 'p-a');
assert.equal(created.visibility, 'private');
assert.deepEqual(created.config, { search: '审批', priorityFilter: 'urgent', density: 'compact', boardHideEmpty: false });
assert.equal(svc.list('p-a').length, 1);

// 2) 项目隔离：同项目内可见，另一项目不可见
assert.equal(svc.list('p-b').length, 0);
const other = svc.create('p-b', { name: '我的未验证待办', type: 'board', config: { viewMode: 'board' } });
assert.equal(svc.list('p-b').length, 1);
assert.notEqual(other.id, created.id);

// 3) 名称大小写/空白归一后重名拒绝
assert.throws(() => svc.create('p-a', { name: '  我的未验证待办  ', type: 'list' }), (e) => e instanceof SavedViewError && e.status === 409);

// 4) 更新名称/类型/配置/共享范围
const updated = svc.update(created.id, {
  name: '我的紧急审批', type: 'table',
  config: { viewMode: 'table', search: '审批', fieldFilterField: 'f-1', density: 'comfortable' },
  visibility: 'project',
});
assert.equal(updated.name, '我的紧急审批');
assert.equal(updated.type, 'table');
assert.equal(updated.visibility, 'project');
assert.equal(updated.config.viewMode, 'table');

// 5) 复制自动避让重名，配置与共享范围保留
const copy1 = svc.copy(created.id);
assert.equal(copy1.name, '我的紧急审批（副本）');
assert.equal(copy1.visibility, 'project');
assert.deepEqual(copy1.config, updated.config);
const copy2 = svc.copy(created.id);
assert.equal(copy2.name, '我的紧急审批（副本 2）');
const named = svc.copy(created.id, '审批表格-指定名');
assert.equal(named.name, '审批表格-指定名');

// 6) 删除幂等边界：删除后不存在，再删 404
svc.delete(copy1.id);
svc.delete(copy2.id);
assert.equal(svc.list('p-a').length, 2); // created + named（两份副本已删除）
assert.throws(() => svc.delete(copy1.id), (e) => e instanceof SavedViewError && e.status === 404);

// 7) 非法输入拒绝
assert.throws(() => svc.create('p-a', { name: '  ', type: 'list' }), (e) => e instanceof SavedViewError && e.status === 400);
assert.throws(() => svc.create('p-a', { name: '错误类型', type: 'timeline' as never }), (e) => e instanceof SavedViewError && e.status === 400);
assert.throws(() => svc.create('p-a', { name: '错误配置', type: 'list', config: [] as never }), (e) => e instanceof SavedViewError && e.status === 400);
assert.throws(() => svc.create('p-a', { name: '错误共享', type: 'list', visibility: 'team' as never }), (e) => e instanceof SavedViewError && e.status === 400);
assert.throws(() => svc.list('p-missing'), (e) => e instanceof SavedViewError && e.status === 404);

console.log(JSON.stringify({
  pass: true,
  checks: 7,
  viewsInA: svc.list('p-a').length,
  viewsInB: svc.list('p-b').length,
}, null, 2));
db.close();
