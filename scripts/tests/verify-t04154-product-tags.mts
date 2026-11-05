// T04154 门脚本：产品标签重命名（三表同事务）/ 合并 / 孤儿清单 / 清理 / 挂回（PRD MEM-505/107/108）。
// 运行：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t04154-product-tags.mts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const DIR = mkdtempSync(join(tmpdir(), 'mtask-t04154-gate-'));
process.env.MTask_DATA_DIR = DIR;
const express = (await import('express')).default;
const { initSchema } = await import('../../server/src/db/schema');
const { getDb, closeDb } = await import('../../server/src/db/connection');
const { memoriesApi } = await import('../../server/src/routes/memories');

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};

initSchema();
const db = getDb();
const now = new Date().toISOString();
const addP = db.prepare(`INSERT INTO projects (id,name,description,product_key,memory_auto_extract,archived,history_at,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?)`);
addP.run('p-old', '旧产品项目', '', 'old', 1, 0, null, now, now);
addP.run('p-wiki', 'Wiki 项目', '', 'wiki', 1, 0, null, now, now);
addP.run('p-rebind', '待挂回项目', '', '', 1, 0, null, now, now);
db.prepare(`INSERT INTO memories (id,product_key,project_id,type,title,content,source_kind,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?)`).run('m-old', 'old', null, 'project', '旧记忆', '内容', 'auto', now, now);
db.prepare(`INSERT INTO memory_review_queue (id,product_key,project_id,title,content,type,source_kind,created_at)
  VALUES (?,?,?,?,?,?,?,?)`).run('q-old', 'old', null, '候选', '内容', 'project', 'auto', now);

const app = express();
app.use(express.json());
app.use('/api/memories', memoriesApi);
const srv = app.listen(0);
const port = (srv.address() as AddressInfo).port;
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/memories${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json() as Record<string, unknown> };
};

// ---- MEM-107：重命名三表同事务 ----
let r = await call('POST', '/product-tags/rename', { oldKey: 'old', newKey: '  NewTag  ' });
check('重命名成功且归一化', r.status === 200 && r.json.ok === true && r.json.mergedIntoExisting === false, JSON.stringify(r.json));
check('项目随重命名更新', (db.prepare("SELECT COUNT(*) AS c FROM projects WHERE product_key='newtag'").get() as { c: number }).c === 1);
check('记忆随重命名更新', (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE product_key='newtag' AND id='m-old'").get() as { c: number }).c === 1);
check('待确认队列随重命名更新', (db.prepare("SELECT COUNT(*) AS c FROM memory_review_queue WHERE product_key='newtag' AND id='q-old'").get() as { c: number }).c === 1);

// ---- 合并语义：新标签已存在 ----
r = await call('POST', '/product-tags/rename', { oldKey: 'newtag', newKey: 'wiki' });
check('重命名到已存在标签＝合并', r.status === 200 && r.json.mergedIntoExisting === true, JSON.stringify(r.json));
check('合并后只剩 wiki 一个标签',
  (db.prepare("SELECT COUNT(*) AS c FROM projects WHERE product_key IN ('newtag','wiki') AND product_key='newtag'").get() as { c: number }).c === 0);
r = await call('POST', '/product-tags/rename', { oldKey: '', newKey: 'x' });
check('空原标签 400', r.status === 400);
r = await call('POST', '/product-tags/rename', { oldKey: 'wiki', newKey: '  ' });
check('新标签为空 400', r.status === 400);

// ---- MEM-108：孤儿标签清单 ----
db.prepare(`INSERT INTO memories (id,product_key,project_id,type,title,content,source_kind,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?)`).run('m-orphan', 'orphan', null, 'project', '孤儿记忆', '内容', 'auto', now, now);
r = await call('GET', '/product-tags/orphans');
const orphans = r.json.orphans as { productKey: string; memoryCount: number }[];
check('孤儿标签可见', orphans.some((o) => o.productKey === 'orphan' && o.memoryCount === 1), JSON.stringify(orphans));
check('在用标签不算孤儿', !orphans.some((o) => o.productKey === 'wiki'));

// ---- 清理孤儿（在用标签必须拒绝）----
r = await call('DELETE', '/product-tags/wiki');
check('在用标签拒绝清理', r.status === 400 && String(r.json.error).includes('仍被项目引用'));
r = await call('DELETE', '/product-tags/orphan');
check('孤儿标签清理成功', r.status === 200 && r.json.deleted === 1, String(r.json.deleted));
check('清理后记忆已删除', (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE id='m-orphan'").get() as { c: number }).c === 0);

// ---- 挂回项目 ----
db.prepare(`INSERT INTO memories (id,product_key,project_id,type,title,content,source_kind,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?)`).run('m-orphan2', 'orphan2', null, 'project', '待挂回', '内容', 'auto', now, now);
r = await call('POST', '/product-tags/orphan2/reattach', { projectId: 'p-rebind' });
check('孤儿挂回成功', r.status === 200 && r.json.ok === true);
check('目标项目已绑定该标签',
  (db.prepare("SELECT product_key FROM projects WHERE id='p-rebind'").get() as { product_key: string }).product_key === 'orphan2');
r = await call('GET', '/product-tags/orphans');
check('挂回后不再是孤儿', !(r.json.orphans as { productKey: string }[]).some((o) => o.productKey === 'orphan2'));
r = await call('POST', '/product-tags/orphan2/reattach', { projectId: 'p-wiki' });
check('目标项目已绑其它标签时拒绝挂回', r.status === 400 && String(r.json.error).includes('拒绝挂回'));

await new Promise<void>((resolve) => srv.close(() => resolve()));
try { closeDb(); rmSync(DIR, { recursive: true, force: true }); } catch { /* 清理失败不阻塞结论 */ }
console.log(`\n结果: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exitCode = 1;
