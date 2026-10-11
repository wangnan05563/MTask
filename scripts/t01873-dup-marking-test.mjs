// T01873 API 级断言：重复需求编号分组需带回「命中行 id + 矩阵顺序」，供矩阵行内标记与一键定位使用
// 用法：node t01873-dup-marking-test.mjs [baseUrl] [隔离实例的 mtask.db 路径]
// 说明：修复后服务层已拒绝再造同号行，重复编号只能以「存量脏数据」形态存在，
//       因此完整分组断言需直写**隔离实例**的库文件造脏数据（传第 2 参）；
//       不传第 2 参时只跑契约类断言（干净项目 0 组 + 合法写入不产生重复），可安全进常规回归编排。
import { DatabaseSync } from 'node:sqlite';

const BASE = process.argv[2] ?? 'http://127.0.0.1:39922';
const DB = process.argv[3] ?? '';
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS ${name} :: ${detail}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
}
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

const proj = (await api('POST', '/api/projects', { name: `T01873-行内标记-${Date.now() % 100000}` })).json;
const pid = proj.id;
check('P-01 创建项目', !!pid, `id=${pid}`);

// ---- 干净项目：0 组，且响应形状仍是 {groups:[...]} ----
const clean = (await api('GET', `/api/plans/prd-requirements/duplicates?projectId=${pid}`)).json ?? {};
check('C-01 无重复时 groups 为空数组', Array.isArray(clean.groups) && clean.groups.length === 0, `groups=${JSON.stringify(clean.groups)}`);

for (const no of ['REQ-01', 'REQ-02', 'UC-01']) {
  await api('POST', '/api/plans/prd-requirements', { projectId: pid, reqNo: no, title: `基线 ${no}` });
}
await api('POST', '/api/plans/prd-requirements', { projectId: pid, reqNo: '', title: '基线（空编号）' });
const beforeDirty = (await api('GET', `/api/plans/prd-requirements?projectId=${pid}`)).json ?? [];
const dupBefore = (await api('GET', `/api/plans/prd-requirements/duplicates?projectId=${pid}`)).json ?? {};
check('C-02 合法写入后仍 0 组（空编号行不参与分组）', dupBefore.groups.length === 0, `rows=${beforeDirty.length} groups=${dupBefore.groups.length}`);

if (!DB) {
  console.log('\nSKIP 脏数据分组断言（未传隔离库路径）—— 完整跑法：node t01873-dup-marking-test.mjs <baseUrl> <mtask.db>');
  console.log(`\n== T01873：pass=${pass} fail=${fail} ==`);
  process.exit(fail ? 1 : 0);
}

// ---- 造修复前的存量脏数据：同一编号两位/三位混写 + 字面同号两行 + 干扰前缀 ----
const db = new DatabaseSync(DB);
// T01872 之后库层有了 (project_id, req_no) 部分唯一索引，字面同号直写会被 SQLITE_CONSTRAINT 拒掉。
// 本夹具要模拟的是「索引建立之前遗留的存量脏数据」（矩阵行内标记服务的正是这批历史行），
// 故先移除索引再播种；索引自身的约束行为由 scripts/t01872-unique-index-test.mjs 断言。
db.exec('DROP INDEX IF EXISTS uniq_prd_req_project_no');
const ins = db.prepare('INSERT INTO prd_requirements (id, project_id, req_no, title, content, source_ref, priority, status, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const stamp = new Date().toISOString();
// id 带本次运行标记：同一隔离库可反复跑（每次是新项目，但主键不能复用）
const tag = Date.now().toString(36);
const seed = (id, no, title, order) => ins.run(id, pid, no, title, no, 'T01873', 'normal', 'todo', order, stamp, stamp);
seed(`t01873-${tag}-a1`, 'REQ-01', '脏数据·与基线 REQ-01 字面同号', 101);
seed(`t01873-${tag}-b1`, 'REQ-002', '脏数据·与基线 REQ-02 混写同号', 102);
seed(`t01873-${tag}-b2`, 'REQ-02', '脏数据·与上一行字面同号', 103);
seed(`t01873-${tag}-c1`, 'UC-010', '干扰·不同序号同前缀', 104);
db.close();

const dup = (await api('GET', `/api/plans/prd-requirements/duplicates?projectId=${pid}`)).json ?? {};
const groups = dup.groups ?? [];
check('D-01 两组重复被识别（干扰前缀不成组）', groups.length === 2, `groups=${groups.map((g) => `${g.variants.join('/')}×${g.count}`).join(' | ')}`);

const gMix = groups.find((g) => [...g.variants].sort().join(',') === 'REQ-002,REQ-02');
check('D-02 混写组带 ids 且 ids 长度 = count', !!gMix && Array.isArray(gMix.ids) && gMix.ids.length === gMix.count, `g=${JSON.stringify(gMix)}`);
check('D-03 混写组识别到 3 行（基线 REQ-02 + REQ-002 + REQ-02）', !!gMix && gMix.count === 3, `count=${gMix?.count}`);

const gReq01 = groups.find((g) => g.variants.join(',') === 'REQ-01');
check('D-04 纯字面同号组 ids=2（含基线行）', !!gReq01 && gReq01.count === 2 && gReq01.ids.length === 2, `g=${JSON.stringify(gReq01)}`);
check('D-05 同前缀不同序号不误合并（UC-01 / UC-010 不在任何组）', groups.every((g) => !g.reqNo.startsWith('UC')), `reqNos=${groups.map((g) => g.reqNo).join(',')}`);

// ---- ids 顺序 = 矩阵顺序（面板「直达第一行」依赖 ids[0] 是最靠前的那行） ----
const rows = (await api('GET', `/api/plans/prd-requirements?projectId=${pid}`)).json ?? [];
const orderIdx = new Map(rows.map((r, i) => [r.id, i]));
check('D-06 每组 ids 均命中矩阵现有行', groups.every((g) => g.ids.every((id) => orderIdx.has(id))), `rows=${rows.length} groups=${groups.length}`);
check('D-07 每组 ids 按矩阵顺序升序', groups.every((g) => g.ids.every((id, i) => i === 0 || orderIdx.get(g.ids[i]) > orderIdx.get(g.ids[i - 1]))), `groups=${groups.length}`);
const mixIds = (gMix?.ids ?? []).map((id) => `${String(orderIdx.get(id))}:${rows[orderIdx.get(id)]?.req_no}`).join('→');
check('D-08 ids[0] 即该组最靠前一行（面板直达目标）', !!gMix && orderIdx.get(gMix.ids[0]) === Math.min(...gMix.ids.map((x) => orderIdx.get(x))), `序列=${mixIds}`);

// ---- 服务层仍守住新数据 ----
const collide = await api('POST', '/api/plans/prd-requirements', { projectId: pid, reqNo: 'REQ-2', title: '再造撞号' });
check('D-09 服务层拒绝再造混写同号', collide.status >= 400, `status=${collide.status} error=${collide.json?.error}`);
const after = (await api('GET', `/api/plans/prd-requirements/duplicates?projectId=${pid}`)).json ?? {};
check('D-10 拒绝后分组数不变', (after.groups ?? []).length === groups.length, `before=${groups.length} after=${(after.groups ?? []).length}`);

console.log(`\n== T01873 行内标记数据面：pass=${pass} fail=${fail} ==`);
console.log(`PROJECTS ${pid}`);
process.exit(fail ? 1 : 0);
