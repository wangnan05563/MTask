// T01483 隔离验证：TestCaseService 的 CRUD / 批量 / 覆盖度 / 排序语义。
// 与 verify-testcase-schema.js 的区别：本单还没有 HTTP 暴露面（路由在 T01484），
// 所以直接驱动编译产物 server/dist 里的服务层——临时数据目录 + initSchema()，不碰生产库。
// 运行：node scripts/verify-testcase-service.js（ABI 不匹配时由 t04-run-verify.py 自动换 electron-as-node）
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mtask-t01483-'));
process.env.MTask_DATA_DIR = TMP; // 必须在 require dist 之前设置：connection.ts 首次 getDb() 才解析路径

const { initSchema } = require(path.join(REPO, 'server/dist/db/schema'));
const { getDb } = require(path.join(REPO, 'server/dist/db/connection'));
const { TestCaseService } = require(path.join(REPO, 'server/dist/services/TestCaseService'));
const { changeBus } = require(path.join(REPO, 'server/dist/services/ChangeBus'));

let fail = 0;
const check = (name, cond, extra) => {
  if (!cond) fail++;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${extra === undefined || extra === '' ? '' : ' → ' + extra}`);
};
/** 期望服务层抛业务错误（routes/plans.ts 的 wrap() 会把它转成 400） */
const expectThrow = (name, fn, keyword) => {
  try {
    fn();
    check(name, false, '未抛错');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(name, !keyword || msg.includes(keyword), msg);
  }
};
const now = () => new Date().toISOString();

initSchema();
const db = getDb();

// ---------- 种子数据 ----------
const pidA = 't01483-proj-a';
const pidB = 't01483-proj-b';
const reqA1 = 't01483-req-a1';
const reqA2 = 't01483-req-a2';
const reqB1 = 't01483-req-b1';
const insProject = db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)');
const insReq = db.prepare(
  `INSERT INTO prd_requirements (id, project_id, req_no, title, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?)`,
);
insProject.run(pidA, 'T01483 主项目', now(), now());
insProject.run(pidB, 'T01483 另一项目', now(), now());
insReq.run(reqA1, pidA, 'REQ-001', '登录校验', now(), now());
insReq.run(reqA2, pidA, 'REQ-002', '导出用例', now(), now());
insReq.run(reqB1, pidB, 'REQ-001', '别的项目的需求', now(), now());

console.log('\n[场景1] 新建：自动编号 / 默认枚举 / 步骤落库');
const c1 = TestCaseService.create({ projectId: pidA, reqId: reqA1, title: '手机号+正确密码登录成功', steps: [{ action: '打开登录页', expected: '展示输入框' }, { action: '提交', expected: '进入首页' }] });
check('未传 caseNo 时自动编号 TC-001', c1.case_no === 'TC-001', c1.case_no);
const c2 = TestCaseService.create({ projectId: pidA, reqId: reqA1, title: '密码错误提示' });
check('第二条自动递增 TC-002', c2.case_no === 'TC-002', c2.case_no);
check('默认 priority=P1/type=functional', c1.priority === 'P1' && c1.type === 'functional', `${c1.priority}/${c1.type}`);
check('默认 status=draft/last_result=untested', c1.status === 'draft' && c1.last_result === 'untested', `${c1.status}/${c1.last_result}`);
check('步骤按数组顺序落 step_no 1..n', c1.steps.length === 2 && c1.steps[0].step_no === 1 && c1.steps[1].action === '提交', JSON.stringify(c1.steps.map((s) => s.step_no)));
check('列表返回附带关联需求摘要', c1.reqNo === 'REQ-001' && c1.reqTitle === '登录校验', `${c1.reqNo}/${c1.reqTitle}`);
const dirty = TestCaseService.create({ projectId: pidA, reqId: reqA1, title: '脏枚举容忍', priority: 'P9', type: 'integration', status: 'unknown-state' });
check('写入脏枚举回落默认（不因单字段非法整体失败）', dirty.priority === 'P1' && dirty.type === 'functional' && dirty.status === 'draft', `${dirty.priority}/${dirty.type}/${dirty.status}`);
expectThrow('标题为空被拒', () => TestCaseService.create({ projectId: pidA, title: '   ' }), '用例标题不能为空');
expectThrow('跨项目关联需求被拒', () => TestCaseService.create({ projectId: pidA, reqId: reqB1, title: '跨项目' }), '仅可关联同项目的需求');

console.log('\n[场景2] 孤儿用例与统计');
const orphan = TestCaseService.create({ projectId: pidA, reqId: '', title: '未挂需求的孤儿用例' });
check("reqId 传 '' 落 NULL", orphan.req_id === null, String(orphan.req_id));
const orphanList = TestCaseService.list({ projectId: pidA, orphanOnly: true });
check('orphanOnly 只出孤儿用例', orphanList.total === 1 && orphanList.items[0].id === orphan.id, `total=${orphanList.total}`);
const st = TestCaseService.stats(pidA);
check('stats 三段计数一致（total=linked+orphan）', st.total === 4 && st.linked === 3 && st.orphan === 1, JSON.stringify(st));

console.log('\n[场景3] 列表过滤 / 分页 / 非法枚举');
const page = TestCaseService.list({ projectId: pidA, limit: 2, offset: 0 });
check('分页 size 生效、total 仍为全量', page.items.length === 2 && page.total === 4, `items=${page.items.length} total=${page.total}`);
const page2 = TestCaseService.list({ projectId: pidA, limit: 2, offset: 2 });
check('offset 翻页不与首页重叠', page2.items[0].id !== page.items[0].id, page2.items.map((x) => x.case_no).join(','));
const all = TestCaseService.list({ projectId: pidA, limit: 0 });
check('limit≤0 走「全部」模式（返回全量 4 条）', all.items.length === 4, `items=${all.items.length}`);
const kw = TestCaseService.list({ projectId: pidA, q: '登录' });
check('关键词命中标题', kw.total === 1 && kw.items[0].id === c1.id, `total=${kw.total}`);
const literal = TestCaseService.list({ projectId: pidA, q: '100%' });
check('关键词里的 % 按字面匹配（不吞成全量）', literal.total === 0, `total=${literal.total}`);
const byReq = TestCaseService.list({ projectId: pidA, reqId: reqA2 });
check('按需求筛选命中 0 条', byReq.total === 0, `total=${byReq.total}`);
expectThrow('筛选用非法枚举显式报错', () => TestCaseService.list({ projectId: pidA, priority: 'P9' }), '非法优先级');

console.log('\n[场景4] PATCH：字段更新 / 重号 / 步骤整体重写');
const patched = TestCaseService.update(c2.id, { priority: 'P0', lastResult: 'fail', reqId: '' });
check('优先级与执行结果可改', patched.priority === 'P0' && patched.last_result === 'fail', `${patched.priority}/${patched.last_result}`);
check('reqId 传 "" 解除关联（chip 摘要转 null）', patched.req_id === null && patched.reqNo === null, String(patched.reqNo));
expectThrow('改成与 TC-001 重复的编号被拒', () => TestCaseService.update(c2.id, { caseNo: 'TC-001' }), '用例编号已存在');
const rewritten = TestCaseService.update(c1.id, { steps: [{ action: '仅保留一步', expected: '只校验展示' }] });
check('传 steps 即整表重写（2→1）', rewritten.steps.length === 1 && rewritten.steps[0].action === '仅保留一步', JSON.stringify(rewritten.steps.map((s) => s.action)));
const untouched = TestCaseService.update(c1.id, { module: '登录模块' });
check('不传 steps 时原步骤保持不动', untouched.steps.length === 1 && untouched.module === '登录模块', `steps=${untouched.steps.length}`);
expectThrow('更新不存在的用例', () => TestCaseService.update('no-such-id', { title: 'x' }), '用例不存在');

console.log('\n[场景5] duplicate：编号重排 + 结论重置 + 去重键不传播');
const dup = TestCaseService.duplicate([c1.id, dirty.id]);
check('复制出两条新用例', dup.ids.length === 2, dup.ids.join(','));
const d0 = TestCaseService.get(dup.ids[0]);
check('编号延续项目内最大序号（TC-005）', d0.case_no === 'TC-005', d0.case_no);
check('副本 status=draft / last_result=untested（复制资产不复制结论）', d0.status === 'draft' && d0.last_result === 'untested', `${d0.status}/${d0.last_result}`);
check('副本 source_key/source_hash 清空（P6 幂等键不随复制传播）', d0.source_key === '' && d0.source_hash === '', JSON.stringify([d0.source_key, d0.source_hash]));
check('副本步骤连带复制', d0.steps.length === 1 && d0.steps[0].step_no === 1, JSON.stringify(d0.steps.map((s) => s.action)));
expectThrow('duplicate 越界 id 被拒', () => TestCaseService.duplicate(['no-such-id']), '部分用例不存在');
expectThrow('跨项目混选被拒', () => TestCaseService.duplicate([c1.id, TestCaseService.create({ projectId: pidB, title: 'B 项目用例' }).id]), '批量操作仅限同一项目');

console.log('\n[场景6] batchPatch / batchRemove');
const batch = TestCaseService.batchPatch([c1.id, dirty.id, orphan.id], { type: 'smoke', priority: 'P2' });
check('批量改类型与优先级', batch.updated === 3, `updated=${batch.updated}`);
const afterBatch = TestCaseService.list({ projectId: pidA, type: 'smoke' });
check('批量结果可被筛选验证', afterBatch.total === 3, `total=${afterBatch.total}`);
check('空 patch 不动库（返回选中数）', TestCaseService.batchPatch([c1.id], {}).updated === 1);
expectThrow('批量改到别项目需求被拒', () => TestCaseService.batchPatch([c1.id], { reqId: reqB1 }), '仅可关联同项目的需求');
const removed = TestCaseService.batchRemove([dirty.id, orphan.id]);
check('批量删除返回条数', removed.deleted === 2, `deleted=${removed.deleted}`);
check('删除用例后其步骤一并消失', db.prepare('SELECT COUNT(*) AS c FROM case_steps WHERE case_id IN (?, ?)').get(dirty.id, orphan.id).c === 0, '');

console.log('\n[场景7] reorder：整范围重写顺序，无重复 sort_order');
// 前置：再补 3 条样本。此时项目内共 7 行：c1/c2/TC-005/TC-006（场景6 删了 dirty+orphan）+ 3 条新
[1, 2, 3].forEach((i) => TestCaseService.create({ projectId: pidA, reqId: reqA1, title: `排序样本 ${i}` }));
const seedOrder = TestCaseService.list({ projectId: pidA, limit: 0 });
check('排序范围含 duplicate 副本，共 7 行', seedOrder.total === 7, `total=${seedOrder.total}`);
const ids = seedOrder.items.map((x) => x.id);
const moved = TestCaseService.reorder(pidA, [ids[2], ids[0]]);
check('reorder 返回受影响行数（整范围）', moved.reordered === 7, `reordered=${moved.reordered}`);
const newOrder = TestCaseService.list({ projectId: pidA, limit: 0 }).items.map((x) => x.id);
// 拖动两行回填到彼此原占位上：位置 0/2 互换，未选中行按原序钉住
const expectedOrder = ids.map((id, i) => (i === 0 ? ids[2] : i === 2 ? ids[0] : id));
check('被拖两行换位、未选中行按原序占位', JSON.stringify(newOrder) === JSON.stringify(expectedOrder), newOrder.map((i) => i.slice(-6)).join(','));
const orders = db.prepare('SELECT sort_order FROM test_cases WHERE project_id = ? ORDER BY sort_order').all(pidA).map((r) => r.sort_order);
check('sort_order 连续 0..n-1 无重复', JSON.stringify(orders) === JSON.stringify(ids.map((_, i) => i)), orders.join(','));
expectThrow('reorder 越界 id 被拒', () => TestCaseService.reorder(pidA, ['no-such-id']), '不属于当前排序范围');
// 孤儿范围：c2 在场景4 已解除关联，应是唯一一行 req_id IS NULL
const orphanScope = TestCaseService.reorder(pidA, [c2.id], null);
check('reqId=null 时排序范围仅孤儿用例', orphanScope.reordered === 1, `reordered=${orphanScope.reordered}`);

console.log('\n[场景8] coverage：一次 GROUP BY 出全部指标（§6.2 禁 N+1）');
// 给 reqA2 挂两条用例，构造「有覆盖 / 零覆盖」混合态（此需求下场景10 要靠步骤行数验证级联）
TestCaseService.create({ projectId: pidA, reqId: reqA2, title: '导出 xlsx', type: 'ui', steps: [{ action: '点导出按钮', expected: '下载成功' }] });
TestCaseService.create({ projectId: pidA, reqId: reqA2, title: '导出 docx' });
const cov = TestCaseService.coverage(pidA);
check('需求总数=2', cov.total === 2, `total=${cov.total}`);
check('已覆盖=2 / 未覆盖=0', cov.covered === 2 && cov.uncovered === 0, `${cov.covered}/${cov.uncovered}`);
check('覆盖率 100.0%', cov.rate === 100, String(cov.rate));
check('byReq 带 caseCount 明细', cov.byReq.some((r) => r.reqNo === 'REQ-002' && r.caseCount === 2) && cov.byReq.some((r) => r.reqNo === 'REQ-001'), JSON.stringify(cov.byReq.map((r) => [r.reqNo, r.caseCount])));
// 零覆盖场景：新建项目内只有一条需求、无用例 → byReq 必须仍有该需求行（否则「仅显示未覆盖」永远取不到候选）
TestCaseService.create({ projectId: pidB, title: 'B 项目用例' });
const covB = TestCaseService.coverage(pidB);
check('零覆盖时 byReq 保留 caseCount=0 行', covB.total === 1 && covB.covered === 0 && covB.uncovered === 1 && covB.rate === 0 && covB.byReq[0].caseCount === 0, JSON.stringify(covB));

console.log('\n[场景9] N+1 自检：prepare 次数与行数无关');
/** 用 prepare 调用次数当探针：N+1 的话次数会随返回行数线性增长 */
const realPrepare = db.prepare.bind(db);
let prepares = 0;
db.prepare = (...args) => {
  prepares += 1;
  return realPrepare(...args);
};
const measure = (fn) => {
  prepares = 0;
  const out = fn();
  return { n: prepares, out };
};
const few = measure(() => TestCaseService.list({ projectId: pidA, limit: 2, offset: 0 }));
const many = measure(() => TestCaseService.list({ projectId: pidA, limit: 0 }));
check('列表取 2 条与取全量 prepare 次数相同（步骤一次 IN 取）', few.n === many.n, `2条=${few.n} 全量=${many.n} 行数=${few.out.items.length}/${many.out.items.length}`);
const covSmall = measure(() => TestCaseService.coverage(pidA));
const covMore = (() => {
  for (let i = 0; i < 6; i++) TestCaseService.create({ projectId: pidA, reqId: reqA1, title: `覆盖度噪声用例 ${i}` });
  return measure(() => TestCaseService.coverage(pidA));
})();
check('覆盖度用例数增加后 prepare 次数不变（一次 GROUP BY）', covSmall.n === covMore.n, `${covSmall.n} vs ${covMore.n}`);
db.prepare = realPrepare;

console.log('\n[场景10] 写操作全部广播 plans（§6.7，矩阵侧历史缺这一环）');
const kinds = [];
const onChange = (k) => kinds.push(k);
changeBus.on('change', onChange);
const last = TestCaseService.list({ projectId: pidA, limit: 1 }).items[0];
TestCaseService.update(last.id, { module: '广播校验' });
TestCaseService.batchPatch([last.id], { status: 'approved' });
TestCaseService.duplicate([last.id]);
TestCaseService.reorder(pidA, [last.id]);
TestCaseService.remove(last.id);
changeBus.off('change', onChange);
check('update/batchPatch/duplicate/reorder/remove 各广播一次 plans', kinds.filter((k) => k === 'plans').length === 5, kinds.join(','));

console.log('\n[场景11] 删除需求 → 用例与步骤级联消失（PRD §5.3）');
const before = db.prepare('SELECT COUNT(*) AS c FROM test_cases WHERE req_id = ?').get(reqA2).c;
check('需求下确有用例', before > 0, `count=${before}`);
const stepsUnderReq = db.prepare('SELECT COUNT(*) AS c FROM case_steps WHERE case_id IN (SELECT id FROM test_cases WHERE req_id = ?)').get(reqA2).c;
db.prepare('DELETE FROM prd_requirements WHERE id = ?').run(reqA2);
const afterCases = db.prepare('SELECT COUNT(*) AS c FROM test_cases WHERE req_id = ?').get(reqA2).c;
const afterSteps = db.prepare('SELECT COUNT(*) AS c FROM case_steps WHERE case_id IN (SELECT id FROM test_cases WHERE req_id = ?)').get(reqA2).c;
check('删除需求后其用例被 CASCADE 删除', afterCases === 0, `before=${before} after=${afterCases}`);
check('步骤随用例一并清空', afterSteps === 0 && stepsUnderReq > 0, `before=${stepsUnderReq} after=${afterSteps}`);

// 必须先关连接再删目录：Windows 下 better-sqlite3 持有文件句柄，直接 rmSync 会 EBUSY
try {
  db.close();
} catch (e) {
  console.log('[清理] 关闭连接异常（不影响结论）：' + (e instanceof Error ? e.message : String(e)));
}
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n==== 结论：${fail === 0 ? '全部通过' : fail + ' 项失败'} ====`);
process.exit(fail === 0 ? 0 : 1);
