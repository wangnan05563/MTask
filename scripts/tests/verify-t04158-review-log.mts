// T04158 门脚本：memory_review_log 表/接口/拒杀率统计/导出清单（PRD MEM-604 / F8）。
// 运行：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t04158-review-log.mts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const DIR = mkdtempSync(join(tmpdir(), 'mtask-t04158-gate-'));
process.env.MTask_DATA_DIR = DIR;
const express = (await import('express')).default;
const { initSchema } = await import('../../server/src/db/schema');
const { getDb, closeDb } = await import('../../server/src/db/connection');
const { memoriesApi } = await import('../../server/src/routes/memories');
const { exportBundle } = await import('../../server/src/services/SettingsService');

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};

initSchema();
const db = getDb();
check('memory_review_log 表已建', !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_review_log'").get());

const app = express();
app.use(express.json());
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

// ---- 写入校验 ----
let r = await call('POST', '/review-log', { batchId: 'b1', memoryId: 'm1', verdict: 'reject' });
check('reject 缺判据 400', r.status === 400 && String(r.json.error).includes('hitRule'));
r = await call('POST', '/review-log', { batchId: 'b1', memoryId: 'm1', verdict: 'bogus' });
check('非法 verdict 400', r.status === 400);
r = await call('POST', '/review-log', { batchId: 'b1', memoryId: 'm1', verdict: 'keep', reviewer: 'alice' });
check('keep 记录写入 201', r.status === 201 && r.json.ok === true, String(r.status));
r = await call('POST', '/review-log', { batchId: 'b1', memoryId: 'm2', verdict: 'reject', hitRule: 'Q3', reviewer: 'alice' });
check('reject 带判据写入 201', r.status === 201);
r = await call('POST', '/review-log', { batchId: 'b2', memoryId: 'm3', verdict: 'reject', hitRule: 'Q3' });
check('跨批次写入 201', r.status === 201);

// ---- 列表按批次过滤 ----
r = await call('GET', '/review-log?batchId=b1');
check('批次过滤只回 b1 两条', (r.json.rows as unknown[]).length === 2, String((r.json.rows as unknown[]).length));
r = await call('GET', '/review-log');
check('全量列表三条', (r.json.rows as unknown[]).length === 3, String((r.json.rows as unknown[]).length));

// ---- 拒杀率统计（规范 §10.2 告警线 40%）----
// T04890 口径修复：分母改为**全部评审样本数**（3 条评审：2 条 Q3 reject + 1 条 keep），
// 故 Q3 = 2/3 ≈ 0.667；「(未标注)」不再作为伪判据组输出（keep 行 hit_rule 为 NULL）。
r = await call('GET', '/review-log/stats');
const stats = r.json.stats as { hitRule: string; total: number; rejected: number; rejectRate: number }[];
const q3 = stats.find((s) => s.hitRule === 'Q3');
check('Q3 判据拒杀率按全局样本分母 2/3（非旧口径 100%）', q3?.total === 3 && q3?.rejected === 2 && Math.abs((q3?.rejectRate ?? 0) - 0.667) < 0.001, JSON.stringify(q3));
check('不再输出「(未标注)」伪判据组', !stats.some((s) => s.hitRule === '(未标注)'), JSON.stringify(stats.map((s) => s.hitRule)));

// ---- 导出清单必须包含评审记录（换机不丢回归基线）----
const bundle = await exportBundle();
check('导出包含 memory_review_log', Array.isArray(bundle.data.memory_review_log), String((bundle.data.memory_review_log as unknown[])?.length));
check('导出包含 memories', Array.isArray(bundle.data.memories));

await new Promise<void>((resolve) => srv.close(() => resolve()));
try { closeDb(); rmSync(DIR, { recursive: true, force: true }); } catch { /* 清理失败不阻塞结论 */ }
console.log(`\n结果: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exitCode = 1;
