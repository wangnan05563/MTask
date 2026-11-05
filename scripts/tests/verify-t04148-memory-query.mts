// T04148 门脚本：记忆查询强制作用域 + 排序级联（PRD MEM-301 / MEM-303 / F6 / F13）。
// 运行：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t04148-memory-query.mts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'mtask-t04148-gate-'));
process.env.MTask_DATA_DIR = DIR;
const { initSchema } = await import('../../server/src/db/schema');
const { getDb, closeDb } = await import('../../server/src/db/connection');
const { queryMemories, MEMORY_QUERY_DEFAULT_LIMIT, MEMORY_QUERY_MAX_LIMIT } =
  await import('../../server/src/services/MemoryService');
const { resolveMemoryScope } = await import('../../server/src/util/memoryScope');

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};

initSchema();
const db = getDb();
const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * 86400000).toISOString();

const ins = db.prepare(`INSERT INTO memories
  (id,product_key,project_id,type,title,content,tags,source_task_id,source_kind,confidence,
   access_count,last_accessed_at,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const add = (o: {
  id: string; pk?: string; pid?: string | null; type: string; source?: string;
  title?: string; content?: string; tags?: string | null; updatedAt?: string; lastAccessed?: string | null;
}) => ins.run(
  o.id, o.pk ?? 'wiki', o.pid ?? null, o.type, o.title ?? `标题-${o.id}`, o.content ?? `内容-${o.id}`,
  o.tags ?? null, null, o.source ?? 'auto', 0.9, 0,
  o.lastAccessed ?? null, o.updatedAt ?? now.toISOString(), o.updatedAt ?? now.toISOString(),
);

// ---- 作用域隔离（MEM-301/C4）----
add({ id: 'm-a', pk: 'wiki', type: 'project' });
add({ id: 'm-b', pk: 'other', type: 'project' });
add({ id: 'm-c', pk: 'wiki', pid: 'p-1', type: 'project' });
add({ id: 'm-d', pk: 'wiki', pid: 'p-2', type: 'project' });
add({ id: 'm-e', pk: 'wiki', pid: 'p-1', type: 'project', updatedAt: daysAgo(1) });
db.prepare("UPDATE memories SET invalidated_at = ? WHERE id = 'm-e'").run(now.toISOString());
const scopeWikiP1 = { kind: 'ok', productKey: 'wiki', projectId: 'p-1' } as const;

const r1 = queryMemories(scopeWikiP1);
const ids1 = r1.map((r) => r.id);
check('跨产品零串扰', !ids1.includes('m-b'), ids1.join(','));
check('合并产品级共享', ids1.includes('m-a'), ids1.join(','));
check('本期特有可见', ids1.includes('m-c'), ids1.join(','));
check('同产品他期不可见', !ids1.includes('m-d'), ids1.join(','));
check('失效行默认不召回', !ids1.includes('m-e'), ids1.join(','));

// ---- 排序：类型权重 ----
db.prepare('DELETE FROM memories').run();
add({ id: 't-feedback', type: 'feedback', source: 'auto' });
add({ id: 't-user', type: 'user', source: 'auto' });
add({ id: 't-project', type: 'project', source: 'auto' });
add({ id: 't-reference', type: 'reference', source: 'auto' });
const typed = queryMemories({ kind: 'ok', productKey: 'wiki' }).map((r) => r.id);
check('类型权重 feedback>user>project>reference',
  typed.join(',') === 't-feedback,t-user,t-project,t-reference', typed.join(','));

// ---- 排序：溯源权重（manual 与 user_said 同档，F6）----
db.prepare('DELETE FROM memories').run();
add({ id: 's-said', type: 'project', source: 'user_said' });
add({ id: 's-manual', type: 'project', source: 'manual' });
add({ id: 's-auto', type: 'project', source: 'auto' });
add({ id: 's-inferred', type: 'project', source: 'inferred' });
add({ id: 's-tool', type: 'project', source: 'tool_output' });
const sourced = queryMemories({ kind: 'ok', productKey: 'wiki' }).map((r) => r.id);
const top2 = sourced.slice(0, 2);
check('manual 与 user_said 同档且高于 auto',
  top2.includes('s-said') && top2.includes('s-manual') &&
  sourced.indexOf('s-auto') === 2 && sourced.indexOf('s-inferred') === 3 && sourced.indexOf('s-tool') === 4,
  sourced.join(','));

// ---- 排序：访问衰减（§7.2 / MEM-305 降权）----
db.prepare('DELETE FROM memories').run();
add({ id: 'd-recent', type: 'project', source: 'auto', lastAccessed: daysAgo(10) });
add({ id: 'd-stale', type: 'project', source: 'auto', updatedAt: daysAgo(200) });
add({ id: 'd-middle', type: 'project', source: 'auto', updatedAt: daysAgo(90) });
const decayed = queryMemories({ kind: 'ok', productKey: 'wiki' }).map((r) => r.id);
check('30 天内访问 ×1.5 > 90 天 > 180 天以上 ×0.3',
  decayed.join(',') === 'd-recent,d-middle,d-stale', decayed.join(','));

// ---- limit 默认/上限 ----
db.prepare('DELETE FROM memories').run();
for (let i = 0; i < 25; i++) add({ id: `l-${i}`, type: 'project', source: 'auto' });
check('默认 limit=10', queryMemories({ kind: 'ok', productKey: 'wiki' }).length === MEMORY_QUERY_DEFAULT_LIMIT,
  String(MEMORY_QUERY_DEFAULT_LIMIT));
check('硬上限 20（请求 99 也只回 20）',
  queryMemories({ kind: 'ok', productKey: 'wiki' }, { limit: 99 }).length === MEMORY_QUERY_MAX_LIMIT,
  String(MEMORY_QUERY_MAX_LIMIT));

// ---- tags / query 过滤（F13）----
db.prepare('DELETE FROM memories').run();
add({ id: 'f-tag', type: 'project', title: '限流退避', content: '429', tags: '["限流","429"]' });
add({ id: 'f-other', type: 'project', title: '无关', content: '别的', tags: '["其他"]' });
check('tags 精确命中', queryMemories({ kind: 'ok', productKey: 'wiki' }, { tags: ['429'] }).map((r) => r.id).join(',') === 'f-tag');
check('关键字命中标题', queryMemories({ kind: 'ok', productKey: 'wiki' }, { query: '限流' }).map((r) => r.id).join(',') === 'f-tag');
check('通配符不越权（% 当字面量）',
  queryMemories({ kind: 'ok', productKey: 'wiki' }, { query: '%' }).length === 0);
check('非法 type 返回空集',
  queryMemories({ kind: 'ok', productKey: 'wiki' }, { type: 'bogus' }).length === 0);

// ---- 召回即访问（§7.2 数据来源）----
const before = db.prepare("SELECT access_count FROM memories WHERE id='f-tag'").get() as { access_count: number };
queryMemories({ kind: 'ok', productKey: 'wiki' }, { query: '限流' });
const after = db.prepare("SELECT access_count, last_accessed_at FROM memories WHERE id='f-tag'").get() as
  { access_count: number; last_accessed_at: string | null };
check('access_count 自增', after.access_count === before.access_count + 1, `${before.access_count}->${after.access_count}`);
check('last_accessed_at 已写入', !!after.last_accessed_at, String(after.last_accessed_at));

// ---- 作用域解析边界（C4 vs MEM-302）----
check('完全缺省 productKey 报错', resolveMemoryScope({}).kind === 'error');
check('空串 productKey 走空集+提示', (() => {
  const s = resolveMemoryScope({ productKey: '' });
  return s.kind === 'empty' && s.hint.includes('未绑定产品');
})());

try { closeDb(); rmSync(DIR, { recursive: true, force: true }); } catch { /* 清理失败不阻塞结论 */ }
console.log(`\n结果: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
