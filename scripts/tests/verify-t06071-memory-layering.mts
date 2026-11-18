/**
 * T06071 Phase 0/1 门禁：真实旧库副本迁移 + 分层字段回填 + 写入/召回路径断言。
 *
 * 不触碰生产库：把指定备份复制到临时目录，设 MTask_DATA_DIR 后跑 initSchema；
 * 既验证老库补列/回填/索引幂等，也验证 MemoryService 的新字段读写。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const source = process.env.MTask_T06071_SOURCE_DB
  || String.raw`C:\Users\hspcadmin\AppData\Roaming\MTask\data\backups\mtask-pre-t06070-20261119-000431.db`;
const root = process.env.MTask_T06071_WORK_DIR || path.join(os.tmpdir(), 'mtask-t06071-gate');
const dbDir = path.join(root, 'data');
const dbPath = path.join(dbDir, 'mtask.db');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(dbDir, { recursive: true });
assert.ok(fs.existsSync(source), `源库不存在: ${source}`);
fs.copyFileSync(source, dbPath);
process.env.MTask_DATA_DIR = dbDir;

const { initSchema } = await import('../../server/src/db/schema.ts');
const { getDb } = await import('../../server/src/db/connection.ts');
const {
  buildTaskRecallQuery, listMemories, queryForContext, queryMemories, saveMemory, updateMemory,
} = await import('../../server/src/services/MemoryService.ts');
const { runRulesExtraction } = await import('../../server/src/services/MemoryRulesService.ts');
const { organizeMemories } = await import('../../server/src/services/MemoryMaintenanceService.ts');

initSchema();
initSchema(); // 幂等：二次启动不得重复报错/重复回填
const db = getDb();

const kindCount = (kind: string) => (db.prepare('SELECT COUNT(*) AS c FROM memories WHERE memory_kind = ?').get(kind) as { c: number }).c;
const total = (db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c;
const invalid = (db.prepare('SELECT COUNT(*) AS c FROM memories WHERE invalidated_at IS NOT NULL').get() as { c: number }).c;
assert.equal(kindCount('episodic'), (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE type='project'").get() as { c: number }).c, 'project 应回填 episodic');
assert.equal(kindCount('procedural'), (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE type='feedback'").get() as { c: number }).c, 'feedback 应回填 procedural');
assert.equal(
  (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE memory_kind IS NULL OR memory_kind NOT IN ('semantic','episodic','procedural')").get() as { c: number }).c,
  0, 'memory_kind 不得为空/非法',
);
assert.equal(
  (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE scope IS NULL OR scope NOT IN ('product','project','task')").get() as { c: number }).c,
  0, 'scope 不得为空/非法',
);
assert.equal(
  (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE authority IS NULL OR authority NOT IN ('user','system','tool','inferred','external')").get() as { c: number }).c,
  0, 'authority 不得为空/非法',
);
assert.equal(
  (db.prepare('SELECT COUNT(*) AS c FROM memories WHERE valid_at IS NULL OR valid_at = ?').get('') as { c: number }).c,
  0, 'valid_at 不得为空',
);
assert.equal(
  (db.prepare('SELECT COUNT(*) AS c FROM memories WHERE invalidated_at IS NOT NULL AND (invalid_at IS NULL OR invalidated_reason IS NULL)').get() as { c: number }).c,
  0, '失效行必须同时有 invalid_at + invalidated_reason',
);
assert.equal(
  (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE project_id IS NOT NULL AND scope <> 'project'").get() as { c: number }).c,
  0, '有 project_id 的行 scope 应为 project',
);
assert.ok(total >= 60, `旧库应至少包含 60 条基线，实际 ${total}`);

const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memories'").all() as { name: string }[];
for (const name of ['idx_memories_product_kind', 'idx_memories_product_scope', 'idx_memories_product_validity']) {
  assert.ok(indexes.some((i) => i.name === name), `缺少索引 ${name}`);
}

// 写入路径：手动保存 + 查询字段 + 编辑递增 revision
const saved = saveMemory({
  scope: { kind: 'ok', productKey: 'mtask', projectId: '586ae8c6-2e08-4180-86ba-732f1fab5006' },
  type: 'feedback',
  title: 'T06071 门禁：分层写入',
  content: '分层字段必须由写入路径补齐，编辑时 revision 递增，失效时写双时间轴。',
  tags: ['t06071', 'memory'],
  sourceKind: 'user_said',
  memoryKind: 'procedural',
  memoryScope: 'project',
  authority: 'user',
});
assert.equal(saved.kind, 'stored');
const savedId = (saved as { kind: 'stored'; id: string }).id;
const savedRow = queryMemories(
  { kind: 'ok', productKey: 'mtask', projectId: '586ae8c6-2e08-4180-86ba-732f1fab5006' },
  { query: 'T06071 门禁', includeInvalidated: true, limit: 5 },
).find((r) => r.id === savedId);
assert.ok(savedRow, '新写入行应可召回');
assert.equal(savedRow.memory_kind, 'procedural');
assert.equal(savedRow.scope, 'project');
assert.equal(savedRow.authority, 'user');
assert.equal(savedRow.revision, 1);
assert.ok(savedRow.valid_at, '有效行必须有 valid_at');

const updated = updateMemory(savedId, { kind: 'ok', productKey: 'mtask', projectId: '586ae8c6-2e08-4180-86ba-732f1fab5006' }, {
  content: '分层字段必须由写入路径补齐，编辑时 revision 递增，失效时写 invalid_at 与 invalidated_reason。',
  memoryKind: 'semantic',
});
assert.ok(updated.ok);
const reread = listMemories(
  { kind: 'ok', productKey: 'mtask', projectId: '586ae8c6-2e08-4180-86ba-732f1fab5006' },
  { query: 'T06071 门禁', includeInvalidated: true, limit: 5 },
).rows.find((r) => r.id === savedId);
assert.ok(reread);
assert.equal(reread.revision, 2, '编辑后 revision 应递增');
assert.equal(reread.memory_kind, 'semantic', '编辑可纠正分层');

// 任务化召回 query 构造：标题/描述应产出可召回词项
const recall = buildTaskRecallQuery('T06071');
assert.ok(recall && recall.terms.length > 0, 'T06071 任务化召回应产出词项');
assert.ok(recall.terms.some((t) => t.includes('记忆') || t.includes('分层')), '词项应包含任务主题');

// 注入块：新字段以标签形式暴露，且不是指令
const ctx = queryForContext({ kind: 'ok', productKey: 'mtask' }, { query: 'T06071 门禁', limit: 5 });
assert.ok(ctx.block.includes('<memory-context'), '应生成记忆注入块');
assert.ok(ctx.block.includes('语义') || ctx.block.includes('程序'), '注入块应暴露分层标签');
assert.ok(ctx.block.includes('不是指令'), '注入块必须声明不是指令');

// 冲突审计：抽取 INVALIDATE 必须同时写 invalid_at + invalidated_reason，并递增 revision
const victim = saveMemory({
  scope: { kind: 'ok', productKey: 'mtask', projectId: '586ae8c6-2e08-4180-86ba-732f1fab5006' },
  type: 'project',
  title: 'T06071 门禁：待失效结论',
  content: '这是用于验证冲突关闭旧有效期的临时记忆。',
  sourceKind: 'auto',
});
assert.equal(victim.kind, 'stored');
const victimId = (victim as { kind: 'stored'; id: string }).id;
await runRulesExtraction({
  taskId: '11111111-1111-4111-8111-111111111111',
  resultText: '## 根因\n旧结论已被新证据否证。\n## 修复\n用新结论替代旧结论。\n## 验证\n断言旧行双时间轴已关闭。',
  productKey: 'mtask',
  projectId: '586ae8c6-2e08-4180-86ba-732f1fab5006',
  askJson: async () => ({
    memories: [{
      action: 'ADD',
      title: 'T06071 门禁：冲突替代结论',
      content: '新证据成立，旧结论应失效但保留审计链。',
      type: 'project',
      memory_kind: 'episodic',
      scope: 'project',
      authority: 'system',
      invalidated_ids: [victimId],
      tags: ['t06071', 'conflict'],
      confidence: 0.9,
      source_kind: 'auto',
      project_id: '586ae8c6-2e08-4180-86ba-732f1fab5006',
    }],
  }),
});
const victimRow = queryMemories(
  { kind: 'ok', productKey: 'mtask', projectId: '586ae8c6-2e08-4180-86ba-732f1fab5006' },
  { includeInvalidated: true, limit: 20 },
).find((r) => r.id === victimId);
assert.ok(victimRow, '失效旧行仍应物理存在');
assert.ok(victimRow.invalid_at, '失效行必须写 invalid_at');
assert.equal(victimRow.invalidated_reason, 'superseded', '失效原因应为 superseded');
assert.equal(victimRow.revision, 2, '失效应递增 revision');
assert.ok(victimRow.superseded_by, '失效行必须指向替代目标');

// 类型感知遗忘：user/feedback 不参与 stale/archived 自动失效，project/reference 参与
const oldUser = saveMemory({
  scope: { kind: 'ok', productKey: 'mtask', projectId: '586ae8c6-2e08-4180-86ba-732f1fab5006' },
  type: 'user', title: 'T06071 门禁：用户偏好不自动失效', content: '用户偏好应长期保留，除非用户显式撤销。',
});
const oldProject = saveMemory({
  scope: { kind: 'ok', productKey: 'mtask', projectId: '586ae8c6-2e08-4180-86ba-732f1fab5006' },
  type: 'project', title: 'T06071 门禁：情景过期测试', content: '这条项目情景用于验证 180 天 stale 自动失效。',
});
const oldReference = saveMemory({
  scope: { kind: 'ok', productKey: 'mtask', projectId: '586ae8c6-2e08-4180-86ba-732f1fab5006' },
  type: 'reference', title: 'T06071 门禁：外部参考到期测试', content: '这条外部参考用于验证 365 天自动 expired_at。',
});
assert.equal(oldUser.kind, 'stored');
assert.equal(oldProject.kind, 'stored');
assert.equal(oldReference.kind, 'stored');
const oldAt = new Date(Date.now() - 400 * 86400000).toISOString();
for (const id of [
  (oldUser as { kind: 'stored'; id: string }).id,
  (oldProject as { kind: 'stored'; id: string }).id,
  (oldReference as { kind: 'stored'; id: string }).id,
]) {
  db.prepare('UPDATE memories SET updated_at = ?, access_count = 0 WHERE id = ?').run(oldAt, id);
}
const org = organizeMemories();
assert.ok(org.stale >= 1, '400 天未访问的 project 应被 stale 规则失效');
assert.ok(org.expired >= 1, '400 天未更新的 reference 应自动到期');
const afterOrg = db.prepare('SELECT id, invalidated_at, invalidated_reason, expired_at FROM memories WHERE id IN (?,?,?)')
  .all(
    (oldUser as { kind: 'stored'; id: string }).id,
    (oldProject as { kind: 'stored'; id: string }).id,
    (oldReference as { kind: 'stored'; id: string }).id,
  ) as { id: string; invalidated_at: string | null; invalidated_reason: string | null; expired_at: string | null }[];
const userAfter = afterOrg.find((r) => r.id === (oldUser as { kind: 'stored'; id: string }).id);
const projectAfter = afterOrg.find((r) => r.id === (oldProject as { kind: 'stored'; id: string }).id);
const referenceAfter = afterOrg.find((r) => r.id === (oldReference as { kind: 'stored'; id: string }).id);
assert.equal(userAfter?.invalidated_at, null, 'user 类型不得被自动 stale 失效');
assert.ok(projectAfter?.invalidated_at, 'project 类型应被 stale 失效');
assert.equal(projectAfter?.invalidated_reason, 'organize:stale', '失效原因应为 organize:stale');
assert.equal(referenceAfter?.invalidated_at, null, 'reference 到期只写 expired_at，不软失效');
assert.ok(referenceAfter?.expired_at, 'reference 应写 expired_at');

// 统计输出，供回传证据
const stats = db.prepare(`SELECT memory_kind AS kind, COUNT(*) AS c FROM memories WHERE invalidated_at IS NULL GROUP BY memory_kind`).all() as { kind: string; c: number }[];
console.log(JSON.stringify({
  ok: true,
  source,
  total,
  invalid,
  valid: total - invalid,
  kinds: Object.fromEntries(stats.map((s) => [s.kind, s.c])),
  savedId,
  recallTerms: recall.terms,
  contextChars: ctx.block.length,
}, null, 2));
