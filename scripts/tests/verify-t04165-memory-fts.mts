// T04165 门脚本：FTS5 同步索引 + 相似记忆检索 + LIKE 降级（PRD Phase 2 语义判重）。
// 运行：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t04165-memory-fts.mts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'mtask-t04165-gate-'));
process.env.MTask_DATA_DIR = DIR;
const { initSchema } = await import('../../server/src/db/schema');
const { getDb, closeDb } = await import('../../server/src/db/connection');
const { similarMemories } = await import('../../server/src/services/MemoryService');

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};

initSchema();
const db = getDb();
check('memories_fts 虚拟表已建',
  !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'").get());

const now = new Date().toISOString();
const ins = db.prepare(`INSERT INTO memories
  (id,product_key,project_id,type,title,content,source_kind,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?)`);
ins.run('m-1', 'wiki', null, 'project', '网关限流', '429 需按指数退避重试', 'auto', now, now);
ins.run('m-2', 'wiki', null, 'project', '构建打包', '安装包体积优化', 'auto', now, now);
ins.run('m-3', 'other', null, 'project', '网关限流', '其它产品的同名记忆', 'auto', now, now);

// 触发器：插入即可被 FTS 命中
const ftsRows = db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH '\"网关限流\"*'").all() as { rowid: number }[];
check('插入后 FTS 索引可命中（含跨产品两条）', ftsRows.length === 2, String(ftsRows.length));

// 相似检索：FTS 优先 + 作用域隔离
let r = similarMemories({ kind: 'ok', productKey: 'wiki' }, '网关限流');
check('相似检索走 FTS', r.source === 'fts', r.source);
check('命中相关记忆', r.rows.some((m) => m.id === 'm-1'), r.rows.map((m) => m.id).join(','));
check('跨产品隔离', !r.rows.some((m) => m.id === 'm-3'), r.rows.map((m) => m.id).join(','));

// excludeId：判重时排除自身
r = similarMemories({ kind: 'ok', productKey: 'wiki' }, '网关限流', { excludeId: 'm-1' });
check('excludeId 排除自身', !r.rows.some((m) => m.id === 'm-1'));

// 更新同步：旧标题不再命中、新标题命中
db.prepare("UPDATE memories SET title = '构建打包优化' WHERE id = 'm-2'").run();
// 注意：新 token 是「构建打包优化」，若用前缀 `"构建打包"*` 仍会命中新值——这里必须用精确 token 匹配
const oldHit = db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH '构建打包'").all() as unknown[];
check('更新后旧 token 不再命中', oldHit.length === 0, String(oldHit.length));
r = similarMemories({ kind: 'ok', productKey: 'wiki' }, '构建打包优化');
check('更新后新内容可检索', r.rows.some((m) => m.id === 'm-2'), r.rows.map((m) => m.id).join(','));

// 删除同步
db.prepare("DELETE FROM memories WHERE id = 'm-1'").run();
r = similarMemories({ kind: 'ok', productKey: 'wiki' }, '网关限流');
check('删除后不再召回', !r.rows.some((m) => m.id === 'm-1'), r.rows.map((m) => m.id).join(','));

// FTS 不可用 → LIKE 降级（模拟未编译 FTS5）
db.exec('DROP TABLE memories_fts');
const fallback = similarMemories({ kind: 'ok', productKey: 'wiki' }, '安装包体积');
check('FTS 缺失时回退 LIKE', fallback.source === 'like', fallback.source);
check('降级仍能命中（内容子串）', fallback.rows.some((m) => m.id === 'm-2'), fallback.rows.map((m) => m.id).join(','));

try { closeDb(); rmSync(DIR, { recursive: true, force: true }); } catch { /* 清理失败不阻塞结论 */ }
console.log(`\n结果: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exitCode = 1;
