// T00707：PRD 导入与需求跟踪矩阵 —— API 级测试脚本（隔离环境：独立端口 + 独立数据目录）
// 被测：MTask server 的 /api/plans/import-prd、/api/plans/prd-requirements*、/api/plans/ai-parse-prd
// 运行：node t00707-prd-matrix-api-test.mjs [baseUrl]
const BASE = process.argv[2] ?? 'http://127.0.0.1:39901';
const results = [];
const ok = (id, name, pass, detail) => { results.push({ id, name, status: pass ? 'PASS' : 'FAIL', detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name} :: ${detail}`); };

async function api(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: body instanceof Buffer ? { 'Content-Type': 'application/octet-stream', ...headers } : { 'Content-Type': 'application/json', ...headers },
    body: body instanceof Buffer ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON（如 413 html） */ }
  return { status: res.status, json };
}

// 从 PRD（需求规格说明书_高情商聊天回复助手.md）提取的代表性需求（Agent 充当 AI 解析角色，确定性构造）
const REQS = [
  { reqNo: 'REQ-001', title: 'FR-1.1 平台接入：微信/钉钉通知监听（只读）', content: '捕获成功率 ≥ 95%', sourceRef: '§3.1 FR-1.1', priority: 'high' },
  { reqNo: 'REQ-002', title: 'FR-1.2 实时监听并提取消息字段', content: '字段提取正确率 ≥ 95%', sourceRef: '§3.1 FR-1.2', priority: 'high' },
  { reqNo: 'REQ-003', title: 'FR-1.5 内容缺失兜底', content: '空载荷 100% 触发兜底而非幻觉生成', sourceRef: '§3.1 FR-1.5', priority: 'high' },
  { reqNo: 'REQ-004', title: 'FR-3.1 云端 LLM 高情商候选生成', content: '候选 2-3 条，成功率 ≥ 95%，不编造事实', sourceRef: '§3.3 FR-3.1', priority: 'high' },
  { reqNo: 'REQ-005', title: 'FR-3.5 安全护栏：拒绝冒犯/违法内容', content: '红队拦截率 ≥ 99%', sourceRef: '§3.3 FR-3.5', priority: 'high' },
  { reqNo: 'REQ-006', title: 'FR-4.2 注入输入框/复制，不自动发送', content: '注入/复制成功率 ≥ 99%', sourceRef: '§3.4 FR-4.2', priority: 'high' },
  { reqNo: 'REQ-007', title: 'FR-6.1 消息正文仅使用时上云，短期缓存 ≤7 天', content: '超期自动清除', sourceRef: '§3.6 FR-6.1', priority: 'high' },
  { reqNo: 'REQ-008', title: 'FR-6.4 风险消息处置（反诈骗）', content: '诈骗样本拒绝率 ≥ 99%', sourceRef: '§3.6 FR-6.4', priority: 'high' },
  { reqNo: 'REQ-009', title: 'FR-3.6 离线/弱网降级（本地模板兜底）', content: '断网 100% 模板兜底', sourceRef: '§3.3 FR-3.6', priority: 'normal' },
  { reqNo: 'REQ-010', title: 'NFR 性能：候选生成 P95 < 3s', content: '含网络', sourceRef: '§4 NFR', priority: 'normal' },
];
const PLANS = [
  { title: '1 项目启动', description: '管理节点', durationDays: 1, reqNos: [] },
  { title: '1.1 需求评审', description: '管理节点', durationDays: 1, reqNos: [] },
  { title: '2.1 通知监听捕获服务开发（微信/钉钉）', description: '通知监听只读捕获', durationDays: 5, reqNos: ['REQ-001', 'REQ-002'] },
  { title: '2.2 内容缺失兜底与手动粘贴补全', description: '空载荷兜底', durationDays: 2, reqNos: ['REQ-003'] },
  { title: '3.1 云端 LLM 候选生成与安全护栏', description: '生成+护栏', durationDays: 5, reqNos: ['REQ-004', 'REQ-005'] },
  { title: '4.1 输入法候选条注入与复制交付', description: 'IME 交付', durationDays: 8, reqNos: ['REQ-006'] },
  { title: '5.1 隐私合规：正文短时上云与反诈骗处置', description: '隐私+反诈', durationDays: 3, reqNos: ['REQ-007', 'REQ-008'] },
  { title: '5.2 离线弱网本地模板降级', description: '降级路径', durationDays: 2, reqNos: ['REQ-009'] },
];

const main = async () => {
  // P-01 创建被测项目
  const proj = await api('POST', '/api/projects', { name: `T00707-PRD导入测试-${Date.now() % 100000}` });
  const projectId = proj.json?.id;
  ok('P-01', '创建被测项目', (proj.status === 200 || proj.status === 201) && !!projectId, `status=${proj.status} id=${projectId}`);

  // TC-01 正常导入（10 需求 + 8 计划 + 同步待办）
  const imp = await api('POST', '/api/plans/import-prd', { projectId, requirements: REQS, plans: PLANS, createTasks: true });
  ok('TC-01', 'import-prd 正常导入', imp.status === 200 && imp.json?.ok !== false,
    `status=${imp.status} resp=${JSON.stringify(imp.json)}`);

  // TC-02 返回计数一致性
  const c = imp.json ?? {};
  ok('TC-02', '导入返回计数（10/8/8）', c.requirements === 10 && c.plans === 8 && c.tasks === 8,
    `requirements=${c.requirements} plans=${c.plans} tasks=${c.tasks}`);

  // TC-03 计划落库与排期行为（PRD AI 流程声明 startDate 空 → 「系统按工作日串行排期」）
  const plans = (await api('GET', `/api/plans?projectId=${projectId}`)).json ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const starts = [...new Set(plans.map((p) => p.start_date))];
  const imported = plans.filter((p) => PLANS.some((x) => x.title === p.title));
  ok('TC-03', `计划落库 8 条（实际 ${imported.length}）`, imported.length === 8,
    `start_date 集合=${JSON.stringify(starts)}（PRD 流程声明「按工作日串行排期」，实测 ${starts.length === 1 && starts[0] === today ? '全部同一天=今天，非串行' : '非同日'}）`);

  // TC-04 矩阵关联正确性（req → linkedPlans / linkedTasks）
  const matrix = (await api('GET', `/api/plans/prd-requirements?projectId=${projectId}`)).json ?? [];
  const byNo = Object.fromEntries(matrix.map((r) => [r.req_no, r]));
  const titleOf = (rid, list) => list.filter((p) => (p.req_ids ? JSON.parse(p.req_ids) : []).includes(rid)).map((p) => p.title);
  const planRows = imported;
  let linkOk = true; const linkDetail = [];
  const expectMap = { REQ: {} };
  for (const p of PLANS) for (const n of p.reqNos) (expectMap.REQ[n] ??= new Set()).add(p.title);
  for (const r of matrix) {
    const expectPlans = [...(expectMap.REQ[r.req_no] ?? [])];
    const gotPlans = (r.linkedPlans ?? []).map((x) => x.title).sort();
    const want = [...expectPlans].sort();
    if (JSON.stringify(gotPlans) !== JSON.stringify(want)) { linkOk = false; linkDetail.push(`${r.req_no}: 期望[${want}] 实际[${gotPlans}]`); }
  }
  const t4 = byNo['REQ-001'];
  const taskLinked = (t4?.linkedTasks ?? []).every((x) => String(x.title).startsWith('[PRD]'));
  ok('TC-04', '矩阵「需求→计划/待办」关联与导入 reqNos 一致', linkOk && !!t4 && taskLinked,
    linkOk ? `REQ-001 linkedPlans=${t4.linkedPlans.length} linkedTasks(全部带[PRD]前缀)=${t4.linkedTasks.length}` : linkDetail.join(' | '));

  // TC-05 待办同步：[PRD] 前缀 + req_ids 携带
  const tasks = (await api('GET', `/api/tasks?projectId=${projectId}`)).json ?? [];
  const prdTasks = tasks.filter((t) => String(t.title).startsWith('[PRD]'));
  const taskWithReq = prdTasks.filter((t) => t.req_ids && JSON.parse(t.req_ids).length > 0);
  ok('TC-05', `同步待办 8 条且携带 req_ids（实际 ${prdTasks.length}/${taskWithReq.length}）`, prdTasks.length === 8 && taskWithReq.length === 6,
    `带关联的待办应 6 条（2 个管理节点无需求关联）：${prdTasks.length} 条 [PRD] 待办、${taskWithReq.length} 条带 req_ids`);

  // TC-06 重复标题计划的关联错位（缺陷探针：两条同 title 不同 reqNos）
  const dup = await api('POST', '/api/plans/import-prd', {
    projectId,
    requirements: [{ reqNo: 'REQ-011', title: '重复标题探针需求A' }, { reqNo: 'REQ-012', title: '重复标题探针需求B' }],
    plans: [
      { title: '6.1 重复标题验证', description: '第一条', reqNos: ['REQ-011'] },
      { title: '6.1 重复标题验证', description: '第二条', reqNos: ['REQ-012'] },
    ],
  });
  const plans2 = (await api('GET', `/api/plans?projectId=${projectId}`)).json ?? [];
  const dupRows = plans2.filter((p) => p.title === '6.1 重复标题验证');
  const reqIdsOf = (p) => (p.req_ids ? JSON.parse(p.req_ids) : []);
  const m2 = ((await api('GET', `/api/plans/prd-requirements?projectId=${projectId}`)).json ?? []);
  const n11 = m2.find((r) => r.req_no === 'REQ-011'); const n12 = m2.find((r) => r.req_no === 'REQ-012');
  const a11 = (n11?.linkedPlans ?? []).length; const a12 = (n12?.linkedPlans ?? []).length;
  ok('TC-06', '重复标题计划各自正确关联（期望 A→REQ-011、B→REQ-012）', dupRows.length === 2 && a11 === 1 && a12 === 1,
    `同名计划 ${dupRows.length} 条；REQ-011 关联 ${a11} 条计划、REQ-012 关联 ${a12} 条计划（返回计数 plans=${dup.json?.plans}）→ ${a11 !== 1 || a12 !== 1 ? '【缺陷】标题匹配 find 命中同一行，后者覆盖前者' : '各自正确'}`);

  // TC-07 无效 reqNos 静默丢弃
  const ghost = await api('POST', '/api/plans/import-prd', {
    projectId,
    plans: [{ title: '7.1 幽灵需求编号计划', reqNos: ['REQ-999'] }],
  });
  const plans3 = (await api('GET', `/api/plans?projectId=${projectId}`)).json ?? [];
  const ghostRow = plans3.find((p) => p.title === '7.1 幽灵需求编号计划');
  ok('TC-07', 'reqNos 引用不存在编号：计划创建但关联静默丢弃', ghost.status === 200 && ghostRow && reqIdsOf(ghostRow).length === 0,
    `req_ids=${ghostRow?.req_ids}（无任何告警返回，前端无从得知 REQ-999 未命中）`);

  // TC-08 关联调整 link/unlink 双向同步
  const tmpReq = (await api('POST', '/api/plans/prd-requirements', { projectId, title: '临时需求-关联调整测试' })).json;
  const anyPlan = plans3.find((p) => p.title === '1 项目启动');
  await api('POST', `/api/plans/prd-requirements/${tmpReq.id}/link`, { kind: 'plan', targetId: anyPlan.id, linked: true });
  const m3 = ((await api('GET', `/api/plans/prd-requirements?projectId=${projectId}`)).json ?? []);
  const linked = m3.find((r) => r.id === tmpReq.id);
  const afterLink = (linked?.linkedPlans ?? []).some((x) => x.id === anyPlan.id);
  await api('POST', `/api/plans/prd-requirements/${tmpReq.id}/link`, { kind: 'plan', targetId: anyPlan.id, linked: false });
  const m4 = ((await api('GET', `/api/plans/prd-requirements?projectId=${projectId}`)).json ?? []);
  const unlinked = (m4.find((r) => r.id === tmpReq.id)?.linkedPlans ?? []).length === 0;
  ok('TC-08', 'link/unlink 建立与解除关联并在矩阵双向同步', afterLink && unlinked, `link 后矩阵可见=${afterLink}，unlink 后清空=${unlinked}`);

  // TC-09 需求删除 → 计划/待办悬空引用同步清理
  await api('POST', `/api/plans/prd-requirements/${tmpReq.id}/link`, { kind: 'plan', targetId: anyPlan.id, linked: true });
  const del = await api('DELETE', `/api/plans/prd-requirements/${tmpReq.id}`);
  const plans4 = (await api('GET', `/api/plans?projectId=${projectId}`)).json ?? [];
  const stillRef = plans4.some((p) => reqIdsOf(p).includes(tmpReq.id));
  const m5 = ((await api('GET', `/api/plans/prd-requirements?projectId=${projectId}`)).json ?? []);
  ok('TC-09', '删除需求后：矩阵行消失且计划 req_ids 无悬空引用', del.status === 200 && !m5.some((r) => r.id === tmpReq.id) && !stillRef,
    `矩阵行已删=${!m5.some((r) => r.id === tmpReq.id)}，计划悬空引用残留=${stillRef}`);

  // TC-10 需求更新（PATCH）反映到矩阵
  const n001 = byNo['REQ-001'] ?? m5.find((r) => r.req_no === 'REQ-001');
  const up = await api('PATCH', `/api/plans/prd-requirements/${n001.id}`, { status: 'doing', priority: 'urgent' });
  const m6 = ((await api('GET', `/api/plans/prd-requirements?projectId=${projectId}`)).json ?? []);
  const n001b = m6.find((r) => r.id === n001.id);
  ok('TC-10', '需求状态/优先级更新生效', up.status === 200 && n001b?.status === 'doing' && n001b?.priority === 'urgent',
    `status=${n001b?.status} priority=${n001b?.priority}`);

  // TC-11 边界：空导入 → 400
  const empty = await api('POST', '/api/plans/import-prd', { projectId, requirements: [], plans: [] });
  ok('TC-11', '空导入返回 400（没有可导入条目）', empty.status === 400, `status=${empty.status} error=${empty.json?.error}`);

  // TC-12 边界：不存在的项目 → 400
  const noproj = await api('POST', '/api/plans/import-prd', { projectId: 'nonexistent-id', requirements: REQS });
  ok('TC-12', '不存在项目返回 400（项目不存在）', noproj.status === 400, `status=${noproj.status} error=${noproj.json?.error}`);

  // TC-13 跨项目关联校验（项目B需求 → 项目A计划）
  const projB = (await api('POST', '/api/projects', { name: `T00707-跨项目探针-${Date.now() % 100000}` })).json;
  const planB = (await api('POST', '/api/plans', { projectId: projB.id, title: 'B项目计划' })).json;
  const xlink = await api('POST', `/api/plans/prd-requirements/${n001.id}/link`, { kind: 'plan', targetId: planB.id, linked: true });
  ok('TC-13', '跨项目关联应被拒绝', xlink.status === 400, `status=${xlink.status}（200=允许跨项目关联 → 数据一致性缺陷）`);

  // TC-14 异常文件：.doc 格式 → 友好 400（文本提取层拦截，无需 AI）
  const doc = await api('POST', '/api/plans/ai-parse-prd?projectId=x&toolId=nonexistent&filename=prd.doc', Buffer.from('dummy'));
  ok('TC-14', '老式 .doc 返回 400 + 可操作提示', doc.status === 400 && String(doc.json?.error ?? '').includes('.docx'), `error=${doc.json?.error}`);

  // TC-15 空文件 → 400
  const emptyFile = await api('POST', '/api/plans/ai-parse-prd?projectId=x&toolId=t&filename=a.md', Buffer.alloc(0));
  ok('TC-15', '空文件返回 400', emptyFile.status === 400, `error=${emptyFile.json?.error}`);

  // TC-16 超大文件（31MB > 30mb 上限）
  const big = await api('POST', '/api/plans/ai-parse-prd?projectId=x&toolId=t&filename=big.md', Buffer.alloc(31 * 1024 * 1024, 97));
  ok('TC-16', `超大文件被拒（实际 ${big.status}）`, big.status >= 400, `status=${big.status}`);

  // TC-17 合法 md + 不存在的 AI 工具 → 400 错误路径（不落库）
  const md = await api('POST', '/api/plans/ai-parse-prd?projectId=x&toolId=nonexistent-tool&filename=prd.md', Buffer.from('# PRD\n需求一'));
  ok('TC-17', 'AI 工具无效时返回 400 且不落库', md.status === 400, `status=${md.status} error=${String(md.json?.error).slice(0, 80)}`);

  // 汇总
  const fail = results.filter((r) => r.status === 'FAIL');
  console.log(`\n==== SUMMARY: ${results.length - fail.length}/${results.length} passed ====${fail.length ? '\nFAIL: ' + fail.map((f) => f.id).join(', ') : ''}`);
};

main().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(1); });
