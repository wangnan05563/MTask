// T01484 隔离验证：测试用例路由（PRD §6.1~§6.3）的注册顺序、参数收窄与错误语义。
// 起隔离实例（临时数据目录 + 独立端口），不触碰生产库；全部走真实 HTTP。
// 运行：node scripts/verify-testcase-routes.js [--port 39922]
//
// 本脚本的核心价值是「反向断言注册顺序」：Express 按注册顺序匹配，静态段一旦排在
// /test-cases/:id 之后，GET /test-cases/meta 会变成「id=meta 的详情查询」并返回
// 400 用例不存在——只看状态码看不出来，必须断言响应体里确实是枚举/覆盖度结构。
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SERVER_DIR = path.join(REPO, 'server');
const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 39922);
const BASE = `http://127.0.0.1:${PORT}/api`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mtask-t01484-'));

let fail = 0;
const check = (name, cond, extra) => {
  if (!cond) fail++;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${extra ? ' → ' + extra : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 运行时探测：必须实例化内存库才会真正加载原生模块（只 require 是假阳性） */
function pickRuntime() {
  const electronBin = path.join(REPO, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const probe = "const D=require('better-sqlite3'); new D(':memory:').close();";
  const candidates = [{ cmd: process.execPath, env: {} }, ...(fs.existsSync(electronBin) ? [{ cmd: electronBin, env: { ELECTRON_RUN_AS_NODE: '1' } }] : [])];
  for (const c of candidates) {
    const r = spawnSync(c.cmd, ['-e', probe], { cwd: SERVER_DIR, env: { ...process.env, ...c.env }, encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  throw new Error('没有可加载 better-sqlite3 的运行时：先执行 scripts\\native-switch.bat dev|electron');
}

const req = async (method, p, body) => {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text };
};
const errOf = (r) => (r.json && r.json.error) || r.text.slice(0, 120);

async function waitHealth(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return true; } catch (_) { /* 未就绪 */ }
    await sleep(500);
  }
  return false;
}

(async () => {
  const rt = pickRuntime();
  console.log(`[setup] 运行时: ${path.basename(rt.cmd)}｜端口 ${PORT}｜临时数据目录: ${TMP}`);
  const server = spawn(rt.cmd, ['dist/index.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, ...rt.env, MTask_DATA_DIR: TMP, MTask_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  server.stdout.on('data', (d) => logs.push(String(d)));
  server.stderr.on('data', (d) => logs.push(String(d)));

  const now = () => new Date().toISOString();
  const pid = `t01484-proj-${Date.now()}`;
  const reqId = `t01484-req-${Date.now()}`;
  const TC = '/plans/test-cases';

  try {
    if (!(await waitHealth())) throw new Error('服务启动超时：\n' + logs.join(''));

    console.log('\n[场景1] 种项目与需求（走 dbadmin 通用表接口）');
    const p1 = await req('POST', '/dbadmin/tables/projects/rows', { id: pid, name: 'T01484 验证项目', created_at: now(), updated_at: now() });
    check('项目创建成功', p1.status < 300, `status=${p1.status}`);
    const r1 = await req('POST', '/dbadmin/tables/prd_requirements/rows', { id: reqId, project_id: pid, req_no: 'REQ-001', title: '登录校验', created_at: now(), updated_at: now() });
    check('需求创建成功', r1.status < 300, `status=${r1.status}`);

    console.log('\n[场景2] 注册顺序铁律：静态段必须不被 /:id 抢占');
    const meta = await req('GET', `${TC}/meta?projectId=${pid}`);
    check('GET /test-cases/meta 返回枚举而非「用例不存在」', meta.status === 200 && Array.isArray(meta.json.priority) && meta.json.priority[0] === 'P0', errOf(meta));
    check('meta 带中文标签与默认值（前端 select 单源）', meta.json.priorityLabel?.P0 === 'P0 关键' && meta.json.defaults?.priority === 'P1' && Array.isArray(meta.json.modules), JSON.stringify(meta.json.priorityLabel));
    check('meta 缺 projectId 报 400', (await req('GET', `${TC}/meta`)).status === 400);
    const cov = await req('GET', `${TC}/coverage?projectId=${pid}`);
    check('GET /test-cases/coverage 返回覆盖度结构而非详情查询', cov.status === 200 && typeof cov.json.rate === 'number' && Array.isArray(cov.json.byReq), errOf(cov));

    console.log('\n[场景3] POST /test-cases：新建（自动编号 + 步骤 + 关联摘要）');
    const created = await req('POST', TC, { projectId: pid, reqId, title: '手机号+正确密码登录成功', steps: [{ action: '打开登录页', expected: '展示输入框' }, { action: '提交', expected: '进入首页' }] });
    const c1 = created.json ?? {};
    check('返回新建行且自动编号 TC-001', created.status === 200 && c1.case_no === 'TC-001', errOf(created));
    check('步骤随主体一次提交', Array.isArray(c1.steps) && c1.steps.length === 2 && c1.steps[1].step_no === 2, JSON.stringify(c1.steps?.map?.((s) => s.step_no)));
    check('返回体带关联需求摘要 reqNo/reqTitle', c1.reqNo === 'REQ-001' && c1.reqTitle === '登录校验', `${c1.reqNo}/${c1.reqTitle}`);
    const c2 = await req('POST', TC, { projectId: pid, title: '未挂需求的孤儿用例', priority: 'P9', type: 'integration' });
    check('脏枚举走回落：创建不报错且落默认值', c2.status === 200 && c2.json.priority === 'P1' && c2.json.type === 'functional', `${c2.json.priority}/${c2.json.type}`);
    const c3 = await req('POST', TC, { projectId: pid, reqId, title: '导出 xlsx', steps: [{ action: '点导出', expected: '下载成功' }] });
    check('第三条编号递增 TC-003', c3.status === 200 && c3.json.case_no === 'TC-003', c3.json?.case_no);
    const bad = await req('POST', TC, { projectId: pid });
    check('缺 title 返回 400 必填文案', bad.status === 400 && /必填/.test(bad.text), errOf(bad));

    console.log('\n[场景4] GET 列表：过滤 / 分页 / 非法枚举');
    const list = await req('GET', `${TC}?projectId=${pid}`);
    check('列表返回 {total, items} 且 total=3', list.status === 200 && list.json.total === 3 && list.json.items.length === 3, `total=${list.json.total}`);
    const one = await req('GET', `${TC}?projectId=${pid}&limit=1&offset=1`);
    check('limit/offset 服务端分页（items=1，total 仍 3）', one.json.items?.length === 1 && one.json.total === 3, `items=${one.json.items?.length} total=${one.json.total}`);
    const orphans = await req('GET', `${TC}?projectId=${pid}&orphanOnly=true`);
    check('orphanOnly=true 命中 1 条孤儿', orphans.json.total === 1 && orphans.json.items[0].id === c2.json.id, errOf(orphans));
    const kw = await req('GET', `${TC}?projectId=${pid}&q=${encodeURIComponent('登录')}`);
    check('中文关键词过滤生效', kw.json.total === 1, `total=${kw.json.total}`);
    const byReq = await req('GET', `${TC}?projectId=${pid}&reqId=${reqId}`);
    check('按需求筛选命中 2 条', byReq.json.total === 2, `total=${byReq.json.total}`);
    const badEnum = await req('GET', `${TC}?projectId=${pid}&priority=P9`);
    check('非法筛选枚举报 400（不静默放大结果集）', badEnum.status === 400 && /非法优先级/.test(badEnum.text), errOf(badEnum));
    const noPid = await req('GET', TC);
    check('缺 projectId 报 400', noPid.status === 400 && /projectId 必填/.test(noPid.text), errOf(noPid));

    console.log('\n[场景5] GET /:id 与 PATCH /:id');
    const got = await req('GET', `${TC}/${c1.id}`);
    check('GET /test-cases/:id 返回单条含步骤', got.status === 200 && got.json.steps.length === 2, errOf(got));
    const miss = await req('GET', `${TC}/no-such-case-id`);
    check('不存在的 id 报 400 用例不存在', miss.status === 400 && /用例不存在/.test(miss.text), errOf(miss));
    const patched = await req('PATCH', `${TC}/${c1.id}`, { priority: 'P0', lastResult: 'fail' });
    check('PATCH 单字段即存（P0/fail）', patched.status === 200 && patched.json.priority === 'P0' && patched.json.last_result === 'fail', `${patched.json.priority}/${patched.json.last_result}`);
    const unlink = await req('PATCH', `${TC}/${c1.id}`, { reqId: '' });
    check("PATCH reqId:'' 解除关联（不是「不改」）", unlink.status === 200 && unlink.json.req_id === null && unlink.json.reqNo === null, `req_id=${unlink.json.req_id}`);
    const dupNo = await req('PATCH', `${TC}/${c2.json.id}`, { caseNo: 'TC-001' });
    check('改重号报 400 用例编号已存在', dupNo.status === 400 && /用例编号已存在/.test(dupNo.text), errOf(dupNo));
    const rewrite = await req('PATCH', `${TC}/${c1.id}`, { steps: [{ action: '仅一步', expected: '只看展示' }] });
    check('PATCH steps 整表重写 2→1', rewrite.json.steps?.length === 1 && rewrite.json.steps[0].action === '仅一步', JSON.stringify(rewrite.json.steps?.map?.((s) => s.action)));
    const keep = await req('PATCH', `${TC}/${c1.id}`, { module: '登录模块' });
    check('不传 steps 时步骤保持', keep.json.steps?.length === 1 && keep.json.module === '登录模块', `steps=${keep.json.steps?.length}`);

    console.log('\n[场景6] 批量静态段：/batch、/reorder、/duplicate（PATCH/DELETE 带 body）');
    const batchPatch = await req('PATCH', `${TC}/batch`, { ids: [c1.id, c3.json.id], patch: { type: 'smoke', status: 'approved' } });
    check('PATCH /test-cases/batch 未被 /:id 吞（返回 updated=2）', batchPatch.status === 200 && batchPatch.json.updated === 2, errOf(batchPatch));
    const smoke = await req('GET', `${TC}?projectId=${pid}&type=smoke`);
    check('批量结果可被筛选复核', smoke.json.total === 2, `total=${smoke.json.total}`);
    const badBatch = await req('PATCH', `${TC}/batch`, { ids: [], patch: { type: 'ui' } });
    check('空 ids 报 400 而非全量改', badBatch.status === 400 && /ids 需为非空字符串数组/.test(badBatch.text), errOf(badBatch));
    const reorder = await req('POST', `${TC}/reorder`, { projectId: pid, ids: [c3.json.id, c1.id] });
    check('POST /test-cases/reorder 成功', reorder.status === 200 && reorder.json.reordered === 3, errOf(reorder));
    const afterOrder = await req('GET', `${TC}?projectId=${pid}`);
    check('排序后首条为被前置的用例', afterOrder.json.items[0].id === c3.json.id, afterOrder.json.items.map((x) => x.case_no).join(','));
    // 孤儿范围得等到上一步「unlink 把 c1 也变成孤儿」之后再算，写死 1 行是错的期望
    const orphanCount = (await req('GET', `${TC}?projectId=${pid}&orphanOnly=true`)).json.total;
    const orphanScope = await req('POST', `${TC}/reorder`, { projectId: pid, reqId: null, ids: [c2.json.id] });
    check('reorder reqId=null 只重写孤儿范围', orphanScope.json?.reordered === orphanCount && orphanCount >= 1, `reordered=${orphanScope.json?.reordered} 孤儿=${orphanCount}`);
    const dup = await req('POST', `${TC}/duplicate`, { ids: [c3.json.id] });
    check('POST /test-cases/duplicate 返回新 id 列表', dup.status === 200 && dup.json.ids?.length === 1, errOf(dup));
    const dupRow = await req('GET', `${TC}/${dup.json.ids[0]}`);
    check('副本编号重排为 TC-004 且步骤连带', dupRow.json.case_no === 'TC-004' && dupRow.json.steps.length === 1, `${dupRow.json.case_no}/${dupRow.json.steps?.length}`);
    const dupOverreach = await req('POST', `${TC}/duplicate`, { ids: ['no-such-id'] });
    check('越界 id 报 400 部分用例不存在', dupOverreach.status === 400 && /部分用例不存在/.test(dupOverreach.text), errOf(dupOverreach));

    console.log('\n[场景7] 删除：DELETE /:id 与 DELETE /batch（带 body）');
    const delOne = await req('DELETE', `${TC}/${c2.json.id}`);
    check('DELETE /test-cases/:id 返回 {ok:true}', delOne.status === 200 && delOne.json.ok === true, errOf(delOne));
    const delBatch = await req('DELETE', `${TC}/batch`, { ids: [dup.json.ids[0]] });
    check('DELETE /test-cases/batch 未被 /:id 吞（返回 deleted=1）', delBatch.status === 200 && delBatch.json.deleted === 1, errOf(delBatch));
    const gone = await req('GET', `${TC}/${c2.json.id}`);
    check('删除后再查为 400 用例不存在', gone.status === 400 && /用例不存在/.test(gone.text), errOf(gone));
    // 正向对照：幸存用例的步骤仍能搜到，否则「残留 0 条」可能只是 search 参数从来没生效
    const stepsAlive = await req('GET', `/dbadmin/tables/case_steps/rows?search=${c1.id}`);
    check('对照：幸存用例的步骤仍在（search 通道本身有效）', Array.isArray(stepsAlive.json.rows) && stepsAlive.json.rows.length === 1, `命中 ${(stepsAlive.json.rows ?? []).length} 条`);
    const stepsGone = await req('GET', `/dbadmin/tables/case_steps/rows?search=${dup.json.ids[0]}`);
    check('删除用例后其步骤一并消失', (stepsGone.json.rows ?? []).length === 0, `残留 ${(stepsGone.json.rows ?? []).length} 条`);
    const finalList = await req('GET', `${TC}?projectId=${pid}`);
    check('剩余 2 条用例', finalList.json.total === 2, `total=${finalList.json.total}`);

    console.log('\n[场景8] 回归：既有计划/矩阵路由未被新块遮蔽（/:id 仍归 PlanService）');
    const plan = await req('POST', '/plans', { projectId: pid, title: '计划条目回归', startDate: '2026-10-05', durationDays: 2 });
    check('POST /plans 仍可用', plan.status === 200 && plan.json.id, errOf(plan));
    const planPatch = await req('PATCH', `/plans/${plan.json.id}`, { progress: 50 });
    check('PATCH /plans/:id 仍走计划更新（progress=50）', planPatch.status === 200 && planPatch.json.progress === 50, errOf(planPatch));
    const planDel = await req('DELETE', `/plans/${plan.json.id}`);
    check('DELETE /plans/:id 仍走计划删除', planDel.status === 200, errOf(planDel));
    const matrix = await req('GET', `/plans/prd-requirements?projectId=${pid}`);
    check('GET /plans/prd-requirements 不受影响', matrix.status === 200 && Array.isArray(matrix.json), `rows=${Array.isArray(matrix.json) ? matrix.json.length : '-'}`);
  } finally {
    server.kill();
    await sleep(500);
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n==== 结论：${fail === 0 ? '全部通过' : fail + ' 项失败'} ====`);
  if (fail > 0) console.log('[server 日志尾]\n' + logs.join('').split('\n').slice(-12).join('\n'));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
