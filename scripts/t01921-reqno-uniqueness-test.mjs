// T01921（T01867 复验修正）API 级断言：需求编号按「同一性」判重与顺延
// 复现用户反馈场景：存量矩阵是 REQ-01 两位写法，增量 PRD 解析出 REQ-001 三位写法，
// 修复前按字符串判重 → 不冲突 → 原样落库 → 同项目 REQ-01..REQ-12 与 REQ-001..REQ-020 并存。
// 用法：node t01921-reqno-uniqueness-test.mjs [baseUrl]
const BASE = process.argv[2] ?? 'http://127.0.0.1:39901';
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

const proj = (await api('POST', '/api/projects', { name: `T01921-编号同一性-${Date.now() % 100000}` })).json;
const pid = proj.id;
check('P-01 创建项目', !!pid, `id=${pid}`);

// ---- 存量：手工建 REQ-01..REQ-12（两位写法，模拟历史矩阵）----
for (let i = 1; i <= 12; i++) {
  const no = `REQ-${String(i).padStart(2, '0')}`;
  const r = await api('POST', '/api/plans/prd-requirements', { projectId: pid, reqNo: no, title: `存量需求 ${no}` });
  if (i === 1 || i === 12) check(`S-0${i} 存量 ${no} 落库`, r.status === 200 || r.status === 201, `status=${r.status} reqNo=${r.json?.req_no ?? r.json?.reqNo}`);
}

// ---- 增量：导入 REQ-001..REQ-020（三位写法，AI 每次从 001 起号）----
const reqs = Array.from({ length: 20 }, (_, i) => {
  const no = `REQ-${String(i + 1).padStart(3, '0')}`;
  return { reqNo: no, title: `增量需求 ${no}`, content: `原文要点 ${no}`, sourceRef: `§${i + 1}`, priority: 'normal' };
});
const plans = reqs.map((r, i) => ({ title: `WBS 1.${i + 1} ${r.title}`, description: '按编号关联', durationDays: 1, startDate: '', reqNos: [r.reqNo], kind: 'normal' }));
const imp = await api('POST', '/api/plans/import-prd', { projectId: pid, requirements: reqs, plans, prdMd: '# 增量 PRD\n', prdFilename: 'T01921-增量.md' });
const map = imp.json?.reqNoMap ?? [];
check('I-01 增量导入成功', imp.status === 200 || imp.status === 201, `status=${imp.status} insertedReq=${imp.json?.insertedRequirements}`);
check('I-02 20 条全部顺延（回传 20 条 from→to）', map.length === 20, `reqNoMap=${map.length}`);
check('I-03 首条 REQ-001→REQ-013（跨过存量最大号 12，位宽取 3）', map[0]?.from === 'REQ-001' && map[0]?.to === 'REQ-013', `${map[0]?.from}→${map[0]?.to}`);
check('I-04 末条 REQ-020→REQ-032（批内不自撞）', map[19]?.from === 'REQ-020' && map[19]?.to === 'REQ-032', `${map[19]?.from}→${map[19]?.to}`);

const rows = (await api('GET', `/api/plans/prd-requirements?projectId=${pid}`)).json ?? [];
const nos = rows.map((r) => String(r.req_no ?? r.reqNo ?? '')).filter(Boolean);
check('R-01 矩阵共 32 行（12 存量 + 20 增量，存量未被改写）', nos.length === 32, `count=${nos.length}`);
check('R-02 存量 REQ-01..REQ-12 原样保留', Array.from({ length: 12 }, (_, i) => `REQ-${String(i + 1).padStart(2, '0')}`).every((no) => nos.includes(no)), `sample=${nos.slice(0, 3).join(',')}`);
check('R-03 增量落在 REQ-013..REQ-032', Array.from({ length: 20 }, (_, i) => `REQ-${String(i + 13).padStart(3, '0')}`).every((no) => nos.includes(no)), `sample=${nos.slice(-3).join(',')}`);
check('R-04 无编号缺失/空号', nos.length === 32 && nos.every((no) => /^REQ-\d+$/.test(no)), `bad=${nos.filter((no) => !/^REQ-\d+$/.test(no)).join(',')}`);

// ---- 顺延后的计划关联不断链：增量计划应挂到本批新行 ----
const detail = (await api('GET', `/api/plans/prd-requirements?projectId=${pid}`)).json ?? [];
const byNo = new Map(detail.map((r) => [String(r.req_no ?? r.reqNo ?? ''), r]));
const newLinked = Array.from({ length: 20 }, (_, i) => `REQ-${String(i + 13).padStart(3, '0')}`)
  .filter((no) => ((byNo.get(no)?.linkedPlans ?? []).length) > 0);
check('M-01 增量 20 行的计划关联全部落到本批新行（按请求编号回填不断链）', newLinked.length === 20, `linked=${newLinked.length}/20`);
const legacyTouched = Array.from({ length: 12 }, (_, i) => `REQ-${String(i + 1).padStart(2, '0')}`)
  .filter((no) => ((byNo.get(no)?.linkedPlans ?? []).length) > 0);
check('M-02 存量 12 行未被增量计划误挂（关联数不变）', legacyTouched.length === 0, `touched=${legacyTouched.join(',')}`);

// ---- 重复编号可见化：修复前混写会报 0 组；现在应报出同号多行 ----
const dupA = (await api('GET', `/api/plans/prd-requirements/duplicates?projectId=${pid}`)).json ?? {};
check('D-01 正常顺延后 0 组重复', (dupA.groups ?? []).length === 0, `groups=${(dupA.groups ?? []).length}`);

// 造混写脏数据：把某行改成与存量同一性的另一写法，应被改号校验拦住
const newRow = rows.find((r) => String(r.req_no ?? r.reqNo) === 'REQ-013');
const collide = await api('PATCH', `/api/plans/prd-requirements/${newRow.id ?? newRow._id}`, { reqNo: 'REQ-01' });
check('D-02 改号撞存量（REQ-01 vs REQ-013 同一性）被拒', collide.status >= 400, `status=${collide.status} error=${collide.json?.error}`);
// ---- 存量脏数据的可见化：横幅按同一性分组（variants 展平写法）需真实脏数据，
//     而修复后 API 已拒绝再造混写，故此处断言「再造被拒」+「干净项目 0 组」两点。
const collideNew = await api('POST', '/api/plans/prd-requirements', { projectId: pid, reqNo: 'REQ-1', title: '手工撞号' });
check('D-03 手工新增撞号（REQ-1 vs 存量 REQ-01，写法无关）被拒', collideNew.status >= 400, `status=${collideNew.status} error=${collideNew.json?.error}`);
const collideNew2 = await api('POST', '/api/plans/prd-requirements', { projectId: pid, reqNo: 'REQ-13', title: '撞顺延行' });
check('D-03b 手工新增撞顺延行（REQ-13 vs REQ-013）被拒', collideNew2.status >= 400, `status=${collideNew2.status} error=${collideNew2.json?.error}`);
const auto = await api('POST', '/api/plans/prd-requirements', { projectId: pid, reqNo: '', title: '留空自动编号' });
const autoNo = String(auto.json?.req_no ?? auto.json?.reqNo ?? '');
check('D-04 留空自动编号续到 REQ-033（接续项目现有最大序号 32，两位/三位写法不影响）', autoNo === 'REQ-033', `reqNo=${autoNo}`);

// 不同前缀不得误合并：REQ-05 与 UC-05 是两个号
const p3 = (await api('POST', '/api/projects', { name: `T01921-前缀-${Date.now() % 100000}` })).json;
for (const no of ['REQ-05', 'UC-05']) {
  await api('POST', '/api/plans/prd-requirements', { projectId: p3.id, reqNo: no, title: `前缀 ${no}` });
}
const dupP3 = (await api('GET', `/api/plans/prd-requirements/duplicates?projectId=${p3.id}`)).json ?? {};
const g3 = dupP3.groups ?? [];
const nosP3 = ((await api('GET', `/api/plans/prd-requirements?projectId=${p3.id}`)).json ?? []).map((r) => String(r.req_no ?? r.reqNo ?? ''));
check('D-05 不同前缀不误合并（REQ-05 与 UC-05 并存、0 组重复）', nosP3.includes('REQ-05') && nosP3.includes('UC-05') && g3.length === 0, `nos=${nosP3.join(',')} groups=${g3.length}`);
const caseCollide = await api('POST', '/api/plans/prd-requirements', { projectId: p3.id, reqNo: 'req-05', title: '大小写撞号' });
check('D-06 大小写同前缀视为同号（req-05 被拒）', caseCollide.status >= 400, `status=${caseCollide.status} error=${caseCollide.json?.error}`);

console.log(`\n== T01921 编号同一性：pass=${pass} fail=${fail} ==`);
console.log(`PROJECTS ${pid},${p3.id}`);
process.exit(fail ? 1 : 0);
