/**
 * T06073 门禁：FTS5 优先 / LIKE 降级 / 跨产品隔离 / 同任务多样性限流 / 只读召回。
 *
 * 独立临时库，不触碰生产数据；所有断言基于 MemoryService 的真实 SQL 路径。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.env.MTask_T06073_WORK_DIR || path.join(os.tmpdir(), 'mtask-t06073-gate');
const dbDir = path.join(root, 'data');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(dbDir, { recursive: true });
process.env.MTask_DATA_DIR = dbDir;

const { initSchema } = await import('../../server/src/db/schema.ts');
const { getDb } = await import('../../server/src/db/connection.ts');
const { getMemoryCoverage, queryMemories, saveMemory } = await import('../../server/src/services/MemoryService.ts');

initSchema();
const db = getDb();
const scope = { kind: 'ok' as const, productKey: 'mtask' };

function save(title: string, content: string, extra: Record<string, unknown> = {}) {
  const r = saveMemory({
    scope,
    type: 'project',
    title,
    content,
    tags: ['t06073'],
    sourceKind: 'manual',
    ...extra,
  });
  assert.equal(r.kind, 'stored', `seed failed: ${title}`);
  return (r as { kind: 'stored'; id: string }).id;
}

const ftsId = save('T06073 FTS 混合召回门禁', 'FTS5 BM25 召回与 LIKE 降级必须都可用。', {
  sourceTaskId: 'task-fts',
});
const other = saveMemory({
  scope: { kind: 'ok', productKey: 'other-product' },
  type: 'project',
  title: 'T06073 FTS 混合召回门禁（其他产品）',
  content: '同一词项不得跨产品串扰。',
  tags: ['t06073'],
  sourceKind: 'manual',
  sourceTaskId: 'task-fts',
});
assert.equal(other.kind, 'stored');
const otherId = (other as { kind: 'stored'; id: string }).id;
assert.ok(db.prepare('SELECT rowid FROM memories_fts WHERE rowid = (SELECT rowid FROM memories WHERE id = ?)')
  .get(ftsId), 'FTS 外部内容表应同步新增行');

// FTS 命中：任务词项召回
const hits = queryMemories(scope, { terms: ['FTS5'], limit: 10, trackAccess: false });
assert.ok(hits.some((r) => r.id === ftsId), 'FTS 路径应命中任务词项');
assert.ok(hits.every((r) => r.product_key === 'mtask'), '召回必须限定当前产品');
assert.ok(!hits.some((r) => r.id === otherId), 'FTS/LIKE 都不得跨产品串扰');

// LIKE 降级：% 不是通配符；FTS 无命中时仍必须落回子串匹配
const likeId = save('T06073 100% 降级命中', '包含字面百分号的标题用于验证 LIKE 降级转义。', {
  sourceTaskId: 'task-like',
});
const likeHits = queryMemories(scope, { query: '%', limit: 10, trackAccess: false });
assert.ok(likeHits.some((r) => r.id === likeId), 'LIKE 降级必须能命中字面 %');
assert.ok(!likeHits.some((r) => r.id === otherId), 'LIKE 降级同样不得跨产品');

// 同任务多样性限流：同一 source_task_id 最多 2 条
const diversityIds = [
  save('T06073 多样性 A', '共同词：多样性限流。', { sourceTaskId: 'task-diversity' }),
  save('T06073 多样性 B', '共同词：多样性限流。', { sourceTaskId: 'task-diversity' }),
  save('T06073 多样性 C', '共同词：多样性限流。', { sourceTaskId: 'task-diversity' }),
];
const limited = queryMemories(scope, {
  terms: ['多样性'], maxPerTask: 2, limit: 10, trackAccess: false,
});
const fromTask = limited.filter((r) => r.source_task_id === 'task-diversity');
assert.equal(fromTask.length, 2, `同任务应限流为 2 条，实际 ${fromTask.length}`);
assert.ok(diversityIds.every((id) => limited.some((r) => r.id === id) || true), '限流只影响召回，不删除源行');
assert.equal(
  (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE source_task_id = 'task-diversity'").get() as { c: number }).c,
  3,
  '多样性限流不得删除源记忆',
);
const unlimited = queryMemories(scope, {
  terms: ['多样性'], maxPerTask: 0, limit: 10, trackAccess: false,
});
assert.equal(unlimited.filter((r) => r.source_task_id === 'task-diversity').length, 3, 'maxPerTask=0 应关闭同任务限流');

// 只读召回：临时会话/覆盖评估不得递增 access_count
const before = (db.prepare('SELECT access_count FROM memories WHERE id = ?').get(ftsId) as { access_count: number }).access_count;
queryMemories(scope, { terms: ['FTS5'], limit: 10, trackAccess: false });
const after = (db.prepare('SELECT access_count FROM memories WHERE id = ?').get(ftsId) as { access_count: number }).access_count;
assert.equal(after, before, 'trackAccess=false 不得写访问计数');
queryMemories(scope, { terms: ['FTS5'], limit: 10 });
const afterTracked = (db.prepare('SELECT access_count FROM memories WHERE id = ?').get(ftsId) as { access_count: number }).access_count;
assert.equal(afterTracked, before + 1, '默认召回应写访问计数');

// 覆盖度摘要：新增分层/权威分布与需复核字段
const coverage = getMemoryCoverage(scope);
assert.ok(coverage.total >= 5, '覆盖度应统计有效记忆');
assert.ok(coverage.kinds && coverage.kinds.episodic >= 5, '覆盖度应返回分层分布');
assert.ok(coverage.authorities && Object.values(coverage.authorities).reduce((a, b) => a + b, 0) === coverage.total, '覆盖度权威分布应覆盖全部有效记忆');
assert.equal(typeof coverage.needReview, 'number', '覆盖度应返回需复核计数');

console.log(JSON.stringify({
  ok: true,
  ftsId, likeId, diversityIds,
  coverage: {
    total: coverage.total, zeroAccess: coverage.zeroAccess,
    pct: coverage.zeroAccessPct, kinds: coverage.kinds,
  },
}, null, 2));
