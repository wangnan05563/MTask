// T04153 门脚本：产品内项目清单 + 项目级自动抽取开关 + 跨产品 403（PRD MEM-503/504）。
// 运行：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t04153-memory-isolation.mts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const DIR = mkdtempSync(join(tmpdir(), 'mtask-t04153-gate-'));
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
addP.run('p-wiki', 'Wiki 项目', '', 'wiki', 1, 0, null, now, now);
addP.run('p-other', 'Other 项目', '', 'other', 1, 0, null, now, now);

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

// MEM-503：项目下拉只列本产品项目（跨产品项目在入口就不可见）
const list = await call('GET', '/projects?productKey=wiki');
const ids = (list.json.projects as { id: string }[]).map((p) => p.id);
check('项目清单只含本产品项目', ids.length === 1 && ids[0] === 'p-wiki', ids.join(','));

// MEM-504：开关读写
let r = await call('PATCH', '/projects/p-wiki', { productKey: 'wiki', enabled: false });
check('本产品项目可关闭自动抽取', r.status === 200 && r.json.enabled === false, String(r.status));
check('落库 memory_auto_extract=0',
  (db.prepare('SELECT memory_auto_extract FROM projects WHERE id = ?').get('p-wiki') as { memory_auto_extract: number }).memory_auto_extract === 0);
r = await call('PATCH', '/projects/p-wiki', { productKey: 'wiki', enabled: true });
check('可重新开启', r.status === 200 && r.json.enabled === true);

// MEM-503：跨产品改开关被拒
r = await call('PATCH', '/projects/p-other', { productKey: 'wiki', enabled: false });
check('跨产品改开关 403', r.status === 403, String(r.status));
check('被拒后对方开关未被改动',
  (db.prepare('SELECT memory_auto_extract FROM projects WHERE id = ?').get('p-other') as { memory_auto_extract: number }).memory_auto_extract === 1);
r = await call('PATCH', '/projects/p-wiki', { productKey: 'wiki', enabled: 'no' });
check('enabled 非布尔 400', r.status === 400);

await new Promise<void>((resolve) => srv.close(() => resolve()));
try { closeDb(); rmSync(DIR, { recursive: true, force: true }); } catch { /* 清理失败不阻塞结论 */ }
console.log(`\n结果: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exitCode = 1;
