// T00770 API 级断言：PRD 文档生命周期 + 待确认问题 + 回写
// 用法：node t00770-prd-manage-api-test.mjs [baseUrl]
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

// ---- 准备 ----
const proj = (await api('POST', '/api/projects', { name: `T00770-PRD管理-${Date.now() % 100000}` })).json;
const pid = proj.id;
check('P-01 创建项目', !!pid, `id=${pid}`);

// ---- 文档生命周期 ----
const created = await api('POST', '/api/plans/prd-docs', {
  projectId: pid, filename: '订单中心 PRD v1.md', contentMd: '# 订单中心 PRD\n\n## 功能范围\n- 下单\n- 支付回调\n',
});
check('D-1 新建 PRD（默认 status=prd）', created.status === 201 || created.status === 200,
  `status=${created.status} doc.status=${created.json?.status}`);

const dupProj = await api('POST', '/api/plans/prd-docs', { projectId: 'nonexistent', filename: 'x.md', contentMd: 'x' });
check('D-2 项目不存在返回 400', dupProj.status === 400, `status=${dupProj.status} error=${dupProj.json?.error}`);

const emptyMd = await api('POST', '/api/plans/prd-docs', { projectId: pid, filename: '空.md', contentMd: '' });
check('D-3 空内容文档允许创建（占位文档）', emptyMd.status === 200 || emptyMd.status === 201, `status=${emptyMd.status}`);

const list = (await api('GET', `/api/plans/prd-docs?projectId=${pid}`)).json ?? [];
check('D-4 列表含 status 字段', list.length === 2 && list.every((d) => d.status === 'prd'),
  `count=${list.length} statuses=[${list.map((d) => d.status).join(',')}]`);

const detail = (await api('GET', `/api/plans/prd-docs/${created.json.id}`)).json;
check('D-5 详情含完整 Markdown 原文', detail.content_md.includes('支付回调'), `chars=${detail.content_md?.length}`);

const edited = await api('PUT', `/api/plans/prd-docs/${created.json.id}`, {
  contentMd: '# 订单中心 PRD\n\n## 功能范围\n- 下单\n- 支付回调\n- 退款\n',
  filename: '订单中心 PRD v2.md',
});
check('D-6 编辑（PUT 全量覆盖 + 改名）', edited.json?.filename === '订单中心 PRD v2.md' && edited.json?.content_md.includes('退款'),
  `filename=${edited.json?.filename}`);

const confirmed = await api('PATCH', `/api/plans/prd-docs/${created.json.id}/status`, { status: 'confirmed' });
check('D-7 状态流转 prd→confirmed', confirmed.json?.status === 'confirmed', `status=${confirmed.json?.status}`);

const badStatus = await api('PATCH', `/api/plans/prd-docs/${created.json.id}/status`, { status: 'published' });
check('D-8 非法状态返回 400', badStatus.status === 400, `status=${badStatus.status} error=${badStatus.json?.error}`);

const back = await api('PATCH', `/api/plans/prd-docs/${created.json.id}/status`, { status: 'prd' });
check('D-9 状态流转 confirmed→prd', back.json?.status === 'prd', `status=${back.json?.status}`);

// ---- 待确认问题 ----
const badIssue = await api('POST', '/api/plans/prd-issues', { projectId: pid, question: '' });
check('I-1 空问题返回 400', badIssue.status === 400, `status=${badIssue.status}`);

const iss = await api('POST', '/api/plans/prd-issues', { projectId: pid, prdId: created.json.id, question: '退款期限是 7 天还是 15 天？' });
check('I-2 新增问题（open）', iss.json?.status === 'open' && iss.json?.prd_id === created.json.id,
  `status=${iss.json?.status} prd_id=${!!iss.json?.prd_id}`);

const issFree = await api('POST', '/api/plans/prd-issues', { projectId: pid, question: '本项目是否含售后模块？' });
check('I-3 项目级问题（无 prd_id）', issFree.json?.prd_id === null || issFree.json?.prd_id === undefined, `prd_id=${issFree.json?.prd_id}`);

const listIss = (await api('GET', `/api/plans/prd-issues?projectId=${pid}`)).json ?? [];
check('I-4 列表 2 条', listIss.length === 2, `count=${listIss.length}`);

const listIssDoc = (await api('GET', `/api/plans/prd-issues?projectId=${pid}&prdId=${created.json.id}`)).json ?? [];
check('I-5 按文档过滤仅 1 条', listIssDoc.length === 1, `count=${listIssDoc.length}`);

const noAnswer = await api('PATCH', `/api/plans/prd-issues/${iss.json.id}`, { status: 'resolved' });
check('I-6 无结论不能标记已确认（400）', noAnswer.status === 400, `status=${noAnswer.status} error=${noAnswer.json?.error}`);

// H-1 回归：空串结论 + resolved 必须同样被拒（原先可绕过并清空已确认结论）
const h1 = await api('PATCH', `/api/plans/prd-issues/${iss.json.id}`, { answer: '   ', status: 'resolved' });
check('I-6b 空串结论 + resolved 被拒（H-1 修复）', h1.status === 400, `status=${h1.status} error=${h1.json?.error}`);

const wbEarly = await api('POST', `/api/plans/prd-issues/${iss.json.id}/writeback`);
check('I-7 未确认不能回写（400）', wbEarly.status === 400, `status=${wbEarly.status} error=${wbEarly.json?.error}`);

const resolved = await api('PATCH', `/api/plans/prd-issues/${iss.json.id}`, { answer: '统一 15 天（自签收日起）', status: 'resolved' });
check('I-8 填结论并确认', resolved.json?.status === 'resolved', `status=${resolved.json?.status}`);

const wbFree = await api('POST', `/api/plans/prd-issues/${issFree.json.id}/writeback`);
check('I-9 项目级问题不能回写（400）', wbFree.status === 400, `error=${wbFree.json?.error}`);

// ---- 回写 ----
const wb = await api('POST', `/api/plans/prd-issues/${iss.json.id}/writeback`);
const docAfter = (await api('GET', `/api/plans/prd-docs/${created.json.id}`)).json;
const hasSection = docAfter.content_md.includes('## 待确认问题结论');
const hasEntry = docAfter.content_md.includes('### Q：退款期限是 7 天还是 15 天？') && docAfter.content_md.includes('统一 15 天');
check('W-1 回写后文档含结论节与条目', wb.status !== 400 && hasSection && hasEntry,
  `status=${wb.status} section=${hasSection} entry=${hasEntry}`);

const wbDup = await api('POST', `/api/plans/prd-issues/${iss.json.id}/writeback`);
check('W-2 重复回写被拒（400）', wbDup.status === 400, `error=${wbDup.json?.error}`);

// 节后追加第二条问题（验证条目插入节内而非文档尾）
const iss2 = await api('POST', '/api/plans/prd-issues', { projectId: pid, prdId: created.json.id, question: '支付渠道先接哪几家？' });
await api('PATCH', `/api/plans/prd-issues/${iss2.json.id}`, { answer: '微信 + 支付宝', status: 'resolved' });
await api('POST', `/api/plans/prd-issues/${iss2.json.id}/writeback`);
const docAfter2 = (await api('GET', `/api/plans/prd-docs/${created.json.id}`)).json;
const secIdx = docAfter2.content_md.indexOf('## 待确认问题结论');
const tail = docAfter2.content_md.slice(secIdx);
const inSection = tail.indexOf('### Q：支付渠道先接哪几家？') < tail.indexOf('**结论**：微信 + 支付宝') + 50;
check('W-3 第二条回写仍在结论节内', inSection, `section_len=${tail.length}`);

// ---- 删除 ----
const delDoc = await api('DELETE', `/api/plans/prd-docs/${created.json.id}`);
check('X-1 删除文档', delPost(delDoc), `status=${delDoc.status}`);
const issuesAfter = (await api('GET', `/api/plans/prd-issues?projectId=${pid}`)).json ?? [];
check('X-2 文档删除后其问题级联清理', issuesAfter.length === 1, `remain=${issuesAfter.length}（仅剩项目级 1 条）`);

function delPost(r) { return r.status === 200 || r.status === 204; }

console.log(`==== T00770 SUMMARY: ${pass}/${pass + fail} passed ====`);
process.exit(fail > 0 ? 1 : 0);
