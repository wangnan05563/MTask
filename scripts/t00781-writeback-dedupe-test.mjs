// T00781 断言：PRD 回写判重稳定锚点 + 首行小节边缘
// 用法：node t00781-writeback-dedupe-test.mjs [baseUrl]
const BASE = process.argv[2] ?? 'http://127.0.0.1:39906';
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`PASS ${name} :: ${detail}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};
const api = async (m, p, b) => {
  const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const proj = (await api('POST', '/api/projects', { name: `T00781-${Date.now() % 100000}` })).json;
const pid = proj.id;

// ---- 场景一：回写 → 编辑问题文本 → 再回写，应被锚点拦住（旧实现会重复写入） ----
const doc = (await api('POST', '/api/plans/prd-docs', {
  projectId: pid, filename: 'PRD-锚点.md', contentMd: '# 售后 PRD\n\n## 功能需求\n\n- 退货流程\n',
})).json;
const iss = (await api('POST', '/api/plans/prd-issues', {
  projectId: pid, prdId: doc.id, question: '退货是否支持部分退货？',
})).json;
await api('PATCH', `/api/plans/prd-issues/${iss.id}`, { answer: '支持，按明细行退货', status: 'resolved' });
const wb1 = await api('POST', `/api/plans/prd-issues/${iss.id}/writeback`);
check('W-1 首次回写成功', wb1.status === 200, `status=${wb1.status}`);
const afterFirst = (await api('GET', `/api/plans/prd-docs/${doc.id}`)).json;
check('W-2 正文含稳定锚点', (afterFirst.content_md ?? '').includes(`<!-- issue:${iss.id} -->`), (afterFirst.content_md ?? '').slice(0, 120));

// 编辑问题文本（锚点不变，文本变）
await api('PATCH', `/api/plans/prd-issues/${iss.id}`, { question: '退货是否支持部分退货？（补充：含赠品场景）' });
const wb2 = await api('POST', `/api/plans/prd-issues/${iss.id}/writeback`);
check('W-3 改问题文本后再回写被拒（锚点判重生效）', wb2.status === 400 && (wb2.json?.error ?? '').includes('已回写'), `status=${wb2.status} error=${wb2.json?.error}`);
const afterSecond = (await api('GET', `/api/plans/prd-docs/${doc.id}`)).json;
const countQ = (afterSecond.content_md.match(/### Q：/g) ?? []).length;
check('W-4 正文未堆积重复结论（Q 条目仍为 1）', countQ === 1, `count=${countQ}`);

// ---- 场景二：节位于文档首行（原 indexOf 判不到 → 会追加第二个同名节） ----
const doc2 = (await api('POST', '/api/plans/prd-docs', {
  projectId: pid, filename: 'PRD-首行节.md', contentMd: '## 待确认问题结论\n',
})).json;
const iss2 = (await api('POST', '/api/plans/prd-issues', {
  projectId: pid, prdId: doc2.id, question: '发票重开时限是几天？',
})).json;
await api('PATCH', `/api/plans/prd-issues/${iss2.id}`, { answer: '30 天', status: 'resolved' });
const wb3 = await api('POST', `/api/plans/prd-issues/${iss2.id}/writeback`);
check('W-5 首行节场景回写成功', wb3.status === 200, `status=${wb3.status}`);
const after3 = (await api('GET', `/api/plans/prd-docs/${doc2.id}`)).json;
const secCount = (after3.content_md.match(/^##[ \t]+待确认问题结论[ \t]*$/gm) ?? []).length;
check('W-6 未产生重复同名节（节标题仅 1 处）', secCount === 1, `secCount=${secCount}`);
check('W-7 结论写入节内', (after3.content_md ?? '').includes('**结论**：30 天'), (after3.content_md ?? '').slice(0, 120));

// ---- 场景三：无该节时仍追加（原行为保持） ----
const doc3 = (await api('POST', '/api/plans/prd-docs', {
  projectId: pid, filename: 'PRD-无节.md', contentMd: '# 只有正文\n',
})).json;
const iss3 = (await api('POST', '/api/plans/prd-issues', {
  projectId: pid, prdId: doc3.id, question: '是否需要短信通知？',
})).json;
await api('PATCH', `/api/plans/prd-issues/${iss3.id}`, { answer: '需要', status: 'resolved' });
const wb4 = await api('POST', `/api/plans/prd-issues/${iss3.id}/writeback`);
const after4 = (await api('GET', `/api/plans/prd-docs/${doc3.id}`)).json;
check('W-8 无节时自动创建节并写入', wb4.status === 200 && (after4.content_md ?? '').includes('## 待确认问题结论'), `status=${wb4.status}`);

// ---- 场景四：未确认/空结论仍拒绝（既有约束不回归） ----
const iss4 = (await api('POST', '/api/plans/prd-issues', { projectId: pid, prdId: doc.id, question: '未确认问题？' })).json;
const wb5 = await api('POST', `/api/plans/prd-issues/${iss4.id}/writeback`);
check('W-9 未确认问题回写被拒', wb5.status === 400 && (wb5.json?.error ?? '').includes('尚未确认'), `error=${wb5.json?.error}`);

console.log(`==== T00781 SUMMARY: ${pass}/${pass + fail} passed ====`);
process.exit(fail > 0 ? 1 : 0);
