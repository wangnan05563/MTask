// T04151 门脚本：记忆 REST CRUD/待确认/标签 + MCP 七件工具注册（PRD MEM-401/402/403）。
// 运行：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t04151-memory-api.mts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const DIR = mkdtempSync(join(tmpdir(), 'mtask-t04151-gate-'));
process.env.MTask_DATA_DIR = DIR;
const express = (await import('express')).default;
const { initSchema } = await import('../../server/src/db/schema');
const { getDb, closeDb } = await import('../../server/src/db/connection');
const { memoriesApi } = await import('../../server/src/routes/memories');
const { createMCPServer } = await import('../../server/src/mcp/server');

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};

initSchema();
const db = getDb();
const now = new Date().toISOString();
db.prepare(`INSERT INTO projects (id,name,description,product_key,memory_auto_extract,archived,history_at,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?)`).run('p-wiki', 'Wiki 项目', '', 'wiki', 1, 0, null, now, now);
db.prepare(`INSERT INTO projects (id,name,description,product_key,memory_auto_extract,archived,history_at,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?)`).run('p-other', 'Other 项目', '', 'other', 1, 0, null, now, now);

const app = express();
app.use(express.json());
// 与 index.ts 实际挂载一致：api(='/api') 下再挂 '/memories'，Router 内 '/' 即 /api/memories
app.use('/api/memories', memoriesApi);
const srv = app.listen(0);
const port = (srv.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}/api/memories`;
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json() as Record<string, unknown> };
};

// ---- 作用域边界（C4 / MEM-302）----
let r = await call('GET', '');
check('REST 缺省作用域 400', r.status === 400 && String(r.json.error).includes('C4'));
r = await call('GET', '?productKey=');
check('REST 空串作用域 200 + hint', r.status === 200 && r.json.hint === '该项目未绑定产品标签');
r = await call('GET', '?projectId=p-other');
check('REST 按 projectId 解析作用域', r.status === 200 && r.json.ok === true);

// ---- 新增（正常 + PII 转队列）----
r = await call('POST', '', { productKey: 'wiki', type: 'project', title: '网关限流', content: '429 指数退避', tags: ['限流'] });
check('新增记忆 201', r.status === 201 && r.json.ok === true, String(r.status));
const memId = String(r.json.id);
r = await call('POST', '', { productKey: 'wiki', type: 'project', title: '联系方式', content: '电话 13800138000' });
check('PII 内容转待确认 202', r.status === 202 && r.json.queued === true, String(r.status));
const pendingId = String(r.json.id);
r = await call('POST', '', { productKey: 'wiki', type: 'bogus', title: 'x', content: 'y' });
check('非法 type 400', r.status === 400);

// ---- 列表 / 召回 / 注入块 ----
r = await call('GET', '?productKey=wiki');
check('列表只回本产品有效行', r.status === 200 && (r.json.memories as unknown[]).length === 1, JSON.stringify(r.json.total));
r = await call('GET', '?productKey=wiki&mode=context');
check('mode=context 返回注入块', r.status === 200 && String(r.json.block).startsWith('<memory-context '));
r = await call('GET', '/query?productKey=wiki&query=限流');
check('query 端点命中关键字', (r.json.memories as { id: string }[]).some((m) => m.id === memId));

// ---- 待确认队列 + 确认入库 ----
r = await call('GET', '/pending?productKey=wiki');
check('待确认队列可见', (r.json.memories as { id: string }[]).some((m) => m.id === pendingId));
r = await call('POST', `/pending/${pendingId}/confirm`, { productKey: 'wiki' });
check('确认后入库', r.status === 200 && r.json.ok === true);
r = await call('GET', '?productKey=wiki');
check('确认条已进 memories', (r.json.memories as { id: string }[]).some((m) => m.id === pendingId));
r = await call('GET', '/pending?productKey=wiki');
check('确认后队列清空', (r.json.memories as unknown[]).length === 0);

// ---- 跨产品改删被拒（MEM-403）----
r = await call('PATCH', `/${memId}`, { productKey: 'other', title: '越权改' });
check('跨产品编辑 404', r.status === 404, String(r.status));
r = await call('PATCH', `/${memId}`, { productKey: 'wiki', title: '网关限流（新）', tags: ['429'] });
check('同产品编辑 200', r.status === 200 && r.json.ok === true);
r = await call('DELETE', `/${pendingId}?productKey=other`);
check('跨产品删除 404', r.status === 404, String(r.status));
r = await call('DELETE', `/${memId}?productKey=wiki`);
check('同产品删除 200', r.status === 200 && r.json.ok === true);
check('物理删除生效', (db.prepare('SELECT COUNT(*) AS c FROM memories WHERE id = ?').get(memId) as { c: number }).c === 0);

// ---- 产品标签清单 ----
r = await call('GET', '/product-tags');
const tags = r.json as unknown as { productKey: string; projectCount: number; memoryCount: number }[];
check('标签清单含 wiki/other', tags.some((t) => t.productKey === 'wiki') && tags.some((t) => t.productKey === 'other'), JSON.stringify(tags));

// ---- MCP 七件工具注册（MEM-401）----
const mcp = await createMCPServer();
const registered = Object.keys((mcp as unknown as { _registeredTools: Record<string, unknown> })._registeredTools ?? {});
const expected = [
  'mtask_save_memory', 'mtask_query_memories', 'mtask_list_memories',
  'mtask_update_memory', 'mtask_delete_memory', 'mtask_list_product_tags', 'mtask_list_pending_memories',
];
check('MCP 七件工具全部注册', expected.every((n) => registered.includes(n)), expected.filter((n) => !registered.includes(n)).join(','));

await new Promise<void>((resolve) => srv.close(() => resolve()));
try { closeDb(); rmSync(DIR, { recursive: true, force: true }); } catch { /* 清理失败不阻塞结论 */ }
console.log(`\n结果: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exitCode = 1;
