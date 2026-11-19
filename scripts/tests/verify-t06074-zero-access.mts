/**
 * T06074 门禁：zero-access 基线、任务化召回只读投影、类型感知复核建议。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.env.MTask_T06074_WORK_DIR || path.join(os.tmpdir(), 'mtask-t06074-gate');
const dbDir = path.join(root, 'data');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(dbDir, { recursive: true });
process.env.MTask_DATA_DIR = dbDir;

const { initSchema } = await import('../../server/src/db/schema.ts');
const { getDb } = await import('../../server/src/db/connection.ts');
const {
  evaluateRecallCoverage, getMemoryCoverage, getZeroAccessSuggestions, queryMemories, saveMemory,
} = await import('../../server/src/services/MemoryService.ts');

initSchema();
const db = getDb();
const now = new Date().toISOString();
const projectId = 'p-t06074';
db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)')
  .run(projectId, 'T06074 评估项目', now, now);
db.prepare('UPDATE projects SET product_key = ? WHERE id = ?').run('mtask', projectId);
db.prepare(`INSERT INTO tasks (id,task_no,project_id,title,description,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?)`).run(
  't-t06074', 'T06074', projectId,
  'T06074 记忆召回评估 zero-access 基线',
  '验证任务化召回覆盖评估只读、不污染 access_count，并产出压降投影。',
  now, now,
);

const scope = { kind: 'ok' as const, productKey: 'mtask' };
const seed = (title: string, type = 'project', extra: Record<string, unknown> = {}) => {
  const r = saveMemory({
    scope, type, title, content: `${title}：用于 T06074 门禁。`, sourceKind: 'manual', ...extra,
  });
  assert.equal(r.kind, 'stored', `seed failed: ${title}`);
  return (r as { kind: 'stored'; id: string }).id;
};

// 8 条能被同名任务词项命中 + 2 条无关零访问 + 1 条 user（必须保留）
const hitIds: string[] = [];
for (let i = 0; i < 8; i++) hitIds.push(seed(`T06074 记忆召回评估 命中 ${i}`));
const unrelatedIds = [seed('无关旧结论 A'), seed('无关旧结论 B')];
const userMemoryId = seed('用户偏好：回答使用中文', 'user');
const beforeCounts = new Map<string, number>();
for (const id of [...hitIds, ...unrelatedIds, userMemoryId]) {
  beforeCounts.set(id, (db.prepare('SELECT access_count FROM memories WHERE id = ?').get(id) as { access_count: number }).access_count);
}

const coverage = getMemoryCoverage(scope);
assert.equal(coverage.total, 11, `有效记忆应为 11，实际 ${coverage.total}`);
assert.equal(coverage.zeroAccess, 11, '新种子记忆应全部是零访问基线');

const report = evaluateRecallCoverage(scope, { sampleLimit: 5, targetPct: 30 });
assert.equal(report.sampledTasks, 1, '应抽到 T06074 任务');
assert.equal(report.hitTasks, 1, '同名任务词项应命中');
assert.equal(report.uniqueHitMemories, 8, `应命中 8 条，实际 ${report.uniqueHitMemories}`);
assert.equal(report.activeTotal, 11);
assert.equal(report.zeroAccessBefore, 11);
assert.equal(report.zeroAccessAfterProjection, 3, '投影零访问应为 3 条');
assert.equal(report.projectedZeroAccessPct, 27.3);
assert.equal(report.targetReached, true, '投影应低于 30% 目标线');
assert.ok(report.note.includes('只读'), '报告必须明确只读口径');

// 评估不得改变访问计数
for (const [id, before] of beforeCounts) {
  const after = (db.prepare('SELECT access_count FROM memories WHERE id = ?').get(id) as { access_count: number }).access_count;
  assert.equal(after, before, `评估不得写访问计数：${id}`);
}

// 类型感知建议：user 必须 keep，project 应进入 review/archive 建议，不自动删除
const suggestion = getZeroAccessSuggestions(scope, { candidateLimit: 20 });
assert.equal(suggestion.totalZeroAccess, 11);
assert.ok(suggestion.groups.some((g) => g.type === 'user' && g.action === 'keep'), 'user 型零访问必须标 keep');
assert.ok(suggestion.groups.some((g) => g.type === 'project' && g.action === 'review'), 'project 型零访问应进入复核');
assert.equal((db.prepare('SELECT COUNT(*) AS c FROM memories WHERE product_key = ?').get('mtask') as { c: number }).c, 11, '建议不得删除记忆');

// 显式只读召回与默认召回仍可区分：默认召回会写计数
const hitId = hitIds[0];
queryMemories(scope, { terms: ['T06074'], limit: 20, trackAccess: false });
assert.equal((db.prepare('SELECT access_count FROM memories WHERE id = ?').get(hitId) as { access_count: number }).access_count, 0);
queryMemories(scope, { terms: ['T06074'], limit: 20 });
assert.equal((db.prepare('SELECT access_count FROM memories WHERE id = ?').get(hitId) as { access_count: number }).access_count, 1);

console.log(JSON.stringify({
  ok: true,
  coverage: { total: coverage.total, zeroAccess: coverage.zeroAccess, pct: coverage.zeroAccessPct },
  report: {
    sampledTasks: report.sampledTasks, hitTasks: report.hitTasks, hitRate: report.hitRate,
    uniqueHitMemories: report.uniqueHitMemories,
    zeroAccessAfterProjection: report.zeroAccessAfterProjection,
    projectedZeroAccessPct: report.projectedZeroAccessPct,
    targetReached: report.targetReached,
  },
  suggestionGroups: suggestion.groups,
}, null, 2));
