// T04164 门脚本：随机抽样评审（每批 20 条、不抽 TOP、不含失效行、上限 50）（MEM-604 / 规范 §10.2）。
// 运行：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t04164-review-sample.mts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const DIR = mkdtempSync(join(tmpdir(), 'mtask-t04164-gate-'));
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
const ins = db.prepare(`INSERT INTO memories
  (id,product_key,project_id,type,title,content,source_kind,created_at,updated_at,invalidated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)`);
for (let i = 0; i < 60; i++) {
  ins.run(`m-${i}`, 'wiki', null, 'project', `样本${i}`, `内容${i}`, 'auto', now, now, null);
}
for (let i = 0; i < 5; i++) {
  ins.run(`x-${i}`, 'wiki', null, 'project', `失效${i}`, '已失效内容', 'auto', now, now, now);
}

const app = express();
app.use(express.json());
app.use('/api/memories', memoriesApi);
const srv = app.listen(0);
const port = (srv.address() as AddressInfo).port;
const call = async (path: string) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/memories${path}`);
  return { status: r.status, json: await r.json() as Record<string, unknown> };
};

const first = await call('/review-sample?productKey=wiki');
const rows1 = first.json.memories as { id: string }[];
check('默认每批 20 条', rows1.length === 20, String(rows1.length));
check('返回批次号（rev- 前缀）', typeof first.json.batchId === 'string' && String(first.json.batchId).startsWith('rev-'), String(first.json.batchId));
check('样本不含失效行', rows1.every((r) => !r.id.startsWith('x-')), rows1.map((r) => r.id).join(','));
check('样本非 TOP（未固定取前 20 条）', !rows1.every((r, i) => r.id === `m-${i}`));

const second = await call('/review-sample?productKey=wiki');
const rows2 = second.json.memories as { id: string }[];
const same = rows1.every((r) => rows2.some((r2) => r2.id === r.id));
check('两次抽样集合不同（随机抽取）', !same, `${rows1.slice(0, 3).map((r) => r.id)} vs ${rows2.slice(0, 3).map((r) => r.id)}`);

const big = await call('/review-sample?productKey=wiki&batchSize=99');
check('批量请求被硬上限 50 截断', (big.json.memories as unknown[]).length === 50, String((big.json.memories as unknown[]).length));

const empty = await call('/review-sample?productKey=');
check('未绑产品返回空样本+hint', (empty.json.memories as unknown[]).length === 0 && String(empty.json.hint).includes('未绑定产品'));
const missing = await call('/review-sample');
check('缺省作用域 400（C4）', missing.status === 400);

await new Promise<void>((resolve) => srv.close(() => resolve()));
try { closeDb(); rmSync(DIR, { recursive: true, force: true }); } catch { /* 清理失败不阻塞结论 */ }
console.log(`\n结果: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exitCode = 1;
