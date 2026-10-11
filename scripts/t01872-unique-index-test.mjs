// T01872：需求编号项目内唯一的**库层**约束断言——直接跑真实迁移代码 initSchema()，不复刻 DDL
// 用法：<node22runtime> scripts/t01872-unique-index-test.mjs [baseUrl]
//   第 2 参可选（隔离实例 baseUrl）：传了才跑「服务层口径未被索引改变」的 API 断言
// 前提：better-sqlite3 需与运行 node 的 ABI 匹配（本机 ABI127 runtime 可用；Node24 会 ERR_DLOPEN_FAILED）
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const require_ = createRequire(join(ROOT, 'package.json'));
const BASE = process.argv[2] ?? '';
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`PASS ${name} :: ${detail}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};

const dir = mkdtempSync(join(tmpdir(), 't01872-idx-'));
process.env.MTask_DATA_DIR = dir;
const { initSchema } = require_(join(ROOT, 'server', 'dist', 'db', 'schema.js'));
// 连接单例在 connection.js——closeDb 后 getDb() 会按当前 MTask_DATA_DIR 重开，用于模拟「下次启动」
const { getDb, closeDb: closeDbFn } = require_(join(ROOT, 'server', 'dist', 'db', 'connection.js'));

const idxRow = (db) => db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name='uniq_prd_req_project_no'").get();
const insReq = (db) => db.prepare(
  'INSERT INTO prd_requirements (id, project_id, req_no, title, content, source_ref, priority, status, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
);
const now = new Date().toISOString();
const seed = (db, id, pid, no, order) => insReq(db).run(id, pid, no, `需求 ${no}`, '', 'T01872', 'normal', 'todo', order, now, now);

try {
  // ---- P1 干净库：迁移应建立部分唯一索引 ----
  initSchema();
  let db = getDb();
  db.prepare('INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run('t01872-pa', 'T01872 甲项目', '', 0, now, now);
  db.prepare('INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run('t01872-pb', 'T01872 乙项目', '', 0, now, now);

  const idx = idxRow(db);
  check('I-01 干净库启动后唯一索引已建立', !!idx, `name=${idx?.name ?? '无'}`);
  check('I-02 索引是排除空值的部分唯一索引（空编号行不参与唯一性）',
    !!idx && /UNIQUE/i.test(idx.sql) && /WHERE\s+req_no\s+IS\s+NOT\s+NULL\s+AND\s+req_no\s*<>\s*''/i.test(idx.sql.replace(/\s+/g, ' ')),
    `sql=${String(idx?.sql).replace(/\s+/g, ' ')}`);

  // ---- P2 约束行为 ----
  seed(db, 't01872-r1', 't01872-pa', 'REQ-01', 1);
  seed(db, 't01872-r2', 't01872-pa', 'REQ-02', 2);
  check('I-03 不同编号正常写入', true, 'REQ-01 / REQ-02 入库');

  let dupErr = '';
  try { seed(db, 't01872-r3', 't01872-pa', 'REQ-01', 3); } catch (e) { dupErr = String(e.message ?? e); }
  check('I-04 同项目字面同号直写被拒（绕过服务层也写不进去）',
    /UNIQUE|CONSTRAINT/i.test(dupErr), dupErr.slice(0, 90) || '未报错——索引未生效');
  check('I-05 被拒的行确实没落库',
    db.prepare("SELECT COUNT(*) AS c FROM prd_requirements WHERE id='t01872-r3'").get().c === 0,
    `c=${db.prepare("SELECT COUNT(*) AS c FROM prd_requirements WHERE id='t01872-r3'").get().c}`);

  seed(db, 't01872-r4', 't01872-pb', 'REQ-01', 1);
  check('I-06 跨项目同编号仍允许（索引按 project_id 分组）', true, '乙项目 REQ-01 入库');

  seed(db, 't01872-r5', 't01872-pa', '', 5);
  seed(db, 't01872-r6', 't01872-pa', '', 6);
  check('I-07 空串编号多行共存（不破坏「未编号」既有行为）', true, '两行 req_no=\'\' 入库');
  insReq(db).run('t01872-r7', 't01872-pa', null, '需求（NULL 编号）', '', 'T01872', 'normal', 'todo', 7, now, now);
  insReq(db).run('t01872-r8', 't01872-pa', null, '需求（NULL 编号）', '', 'T01872', 'normal', 'todo', 8, now, now);
  check('I-08 NULL 编号多行共存', true, '两行 req_no=NULL 入库');

  seed(db, 't01872-r9', 't01872-pa', 'REQ-002', 9);
  check('I-09 同一性混写（REQ-02 / REQ-002）字面不同仍可入库——索引只挡字面同号，等价判定由服务层守',
    true, 'REQ-002 入库（口径见结果文档）');

  // ---- P3 存量重复时的容错迁移：只告警不建索引、绝不改号、下次启动自动重试 ----
  db.exec('DROP INDEX uniq_prd_req_project_no');
  seed(db, 't01872-d1', 't01872-pa', 'REQ-09', 20);
  seed(db, 't01872-d2', 't01872-pa', 'REQ-09', 21);
  seed(db, 't01872-d3', 't01872-pb', 'UC-03', 22);
  seed(db, 't01872-d4', 't01872-pb', 'UC-03', 23);
  closeDbFn();

  const warns = [];
  const originWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  let throwMsg = '';
  try { initSchema(); } catch (e) { throwMsg = String(e.message ?? e); } finally { console.warn = originWarn; }
  check('I-10 存量有重复编号时迁移不抛错（不把后端搞崩）', throwMsg === '', throwMsg || 'initSchema 正常返回');

  db = getDb();
  check('I-11 有存量重复时索引保持未建立（下次启动自动重试）', !idxRow(db), `idx=${idxRow(db)?.name ?? '无'}`);
  check('I-12 重复行未被自动改号（用户手里的引用编号不动）',
    db.prepare("SELECT COUNT(*) AS c FROM prd_requirements WHERE req_no='REQ-09'").get().c === 2
    && db.prepare("SELECT COUNT(*) AS c FROM prd_requirements WHERE req_no='UC-03'").get().c === 2,
    `REQ-09×${db.prepare("SELECT COUNT(*) AS c FROM prd_requirements WHERE req_no='REQ-09'").get().c} UC-03×${db.prepare("SELECT COUNT(*) AS c FROM prd_requirements WHERE req_no='UC-03'").get().c}`);
  check('I-13 降级必须留痕：告警点名重复组数与编号',
    warns.some((w) => /唯一索引未建立/.test(w) && /2 组/.test(w) && /REQ-09/.test(w)),
    `warn=${(warns.find((w) => /索引/.test(w)) ?? '无').slice(0, 140)}`);

  // 重复清零后应能补建索引（幂等重试路径）
  db.exec("DELETE FROM prd_requirements WHERE id IN ('t01872-d2','t01872-d4')");
  closeDbFn();
  initSchema();
  db = getDb();
  check('I-14 存量重复清零后，下次启动自动补建索引', !!idxRow(db), `idx=${idxRow(db)?.name ?? '无'}`);

  // ---- P4（可选）服务层口径未被索引改变 ----
  if (BASE) {
    const post = async (p, b) => {
      const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify(b) });
      let j = null; try { j = await r.json(); } catch { /* ignore */ }
      return { status: r.status, j };
    };
    const proj = await post('/api/projects', { name: `T01872-服务层口径-${Date.now() % 100000}` });
    const pid = proj.j?.id;
    const a = await post('/api/plans/prd-requirements', { projectId: pid, reqNo: 'REQ-01', title: '首行' });
    const b = await post('/api/plans/prd-requirements', { projectId: pid, reqNo: 'REQ-01', title: '撞号行' });
    check('I-15 走接口的撞号仍是服务层的友好拒绝（不是 500 SQLITE_CONSTRAINT）',
      a.status < 400 && b.status >= 400 && b.status < 500, `first=${a.status} dup=${b.status} error=${String(b.j?.error ?? '').slice(0, 60)}`);
    const mix = await post('/api/plans/prd-requirements', { projectId: pid, reqNo: 'REQ-1', title: '混写撞号' });
    check('I-16 同一性混写同样被服务层拒绝（等价判定不因索引放松）',
      mix.status >= 400 && mix.status < 500, `status=${mix.status} error=${String(mix.j?.error ?? '').slice(0, 60)}`);
    const empty1 = await post('/api/plans/prd-requirements', { projectId: pid, reqNo: '', title: '空编号一' });
    const empty2 = await post('/api/plans/prd-requirements', { projectId: pid, reqNo: '', title: '空编号二' });
    check('I-17 接口写空编号多行不受索引影响', empty1.status < 400 && empty2.status < 400, `${empty1.status}/${empty2.status}`);
  } else {
    console.log('SKIP I-15~I-17（未传 baseUrl）——完整跑法：node scripts/t01872-unique-index-test.mjs http://127.0.0.1:39923');
  }
} finally {
  try { closeDbFn?.(); } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

console.log(`\n== T01872 唯一索引：pass=${pass} fail=${fail} ==`);
process.exitCode = fail ? 1 : 0;
