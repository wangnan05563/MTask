// T00763：PRD 导入与 AI 上下文关联 —— API 级测试脚本（隔离环境：独立端口 + 独立数据目录）
// 覆盖：PRD 原文落库 / 矩阵行 prdDoc 关联 / 查看接口 / 反向更新（含空体 400）/ 上下文解析（超长截断）
// 运行：node t00763-prd-context-test.mjs [baseUrl]
import { readFileSync } from 'node:fs';
const BASE = process.argv[2] ?? 'http://127.0.0.1:39902';
const results = [];
const ok = (id, name, pass, detail) => { results.push({ id, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name} :: ${detail}`); };
const api = async (method, path, body, headers = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: body instanceof Buffer ? { 'Content-Type': 'application/octet-stream', ...headers } : { 'Content-Type': 'application/json', ...headers },
    body: body instanceof Buffer ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null; try { json = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, json };
};

// 构造 >12000 字符的 PRD 原文（验证落库完整 + 上下文解析截断标记）
const PRD_MD = ['# 高情商聊天回复助手 需求规格说明书（T00763 测试样本）', ''];
for (let i = 1; i <= 200; i++) PRD_MD.push(`## FR-${i} 功能点 ${i}`, '', `这是第 ${i} 条功能的详细描述内容，包含验收标准与边界条件说明，用于撑起足够长的 PRD 原文以覆盖截断逻辑。`.repeat(2), '');

const main = async () => {
  // P-01 创建被测项目
  const proj = await api('POST', '/api/projects', { name: `T00763-PRD关联测试-${Date.now() % 100000}` });
  const projectId = proj.json?.id;
  ok('P-01', '创建被测项目', (proj.status === 200 || proj.status === 201) && !!projectId, `status=${proj.status} id=${projectId}`);

  // TC-01 携带 PRD 原文导入（10 需求 + 2 计划 + 同步待办）→ 返回 prdId
  const reqs = Array.from({ length: 10 }, (_, i) => ({ reqNo: `REQ-${String(i + 1).padStart(3, '0')}`, title: `FR-${i + 1} 功能点${i + 1}`, content: `验收：指标 ${i + 1}`, sourceRef: `§3.${i + 1}`, priority: i < 3 ? 'high' : 'normal' }));
  const plans = [
    { title: '1 项目启动', description: '管理节点', durationDays: 1, reqNos: [] },
    { title: '2 核心功能开发', description: '开发主体', durationDays: 5, reqNos: ['REQ-001', 'REQ-002'] },
  ];
  const imp = await api('POST', '/api/plans/import-prd', { projectId, requirements: reqs, plans, createTasks: true, prdMd: PRD_MD.join('\n'), prdFilename: '需求规格说明书_T00763.md' });
  const prdId = imp.json?.prdId;
  ok('TC-01', 'import-prd 携带 PRD 原文导入并返回 prdId', imp.status === 200 && typeof prdId === 'string' && prdId.length > 10,
    `status=${imp.status} prdId=${prdId} resp=${JSON.stringify(imp.json).slice(0, 140)}`);

  // TC-02 矩阵行携带 prdDoc（需求 → PRD 文档关联）
  const matrix = (await api('GET', `/api/plans/prd-requirements?projectId=${projectId}`)).json ?? [];
  const withDoc = matrix.filter((r) => r.prdDoc?.id === prdId);
  ok('TC-02', '矩阵 10 行均关联 prdDoc', matrix.length === 10 && withDoc.length === 10,
    `rows=${matrix.length} 关联=${withDoc.length} 首行=${JSON.stringify(matrix[0]?.prdDoc)}`);

  // TC-03 文档列表（元信息，content_chars 与原文长度一致）
  const docs = (await api('GET', `/api/plans/prd-docs?projectId=${projectId}`)).json ?? [];
  const expectChars = PRD_MD.join('\n').length;
  ok('TC-03', 'prd-docs 列表返回且 content_chars 一致', docs.length === 1 && docs[0].content_chars === expectChars,
    `count=${docs.length} content_chars=${docs[0]?.content_chars} 期望=${expectChars}`);

  // TC-04 文档详情：完整原文逐字保留（不截断不丢失）
  const doc = (await api('GET', `/api/plans/prd-docs/${prdId}`)).json ?? {};
  ok('TC-04', 'prd-docs 详情逐字保留原文', doc.content_md === PRD_MD.join('\n') && doc.filename === '需求规格说明书_T00763.md',
    `len=${doc.content_md?.length} 期望=${PRD_MD.join('\n').length} filename=${doc.filename}`);

  // TC-05 反向更新（全量覆盖）
  const revised = PRD_MD.join('\n').replace('高情商聊天回复助手 需求规格说明书（T00763 测试样本）', '高情商聊天回复助手 需求规格说明书（v2 修订版）');
  const upd = await api('PUT', `/api/plans/prd-docs/${prdId}`, { contentMd: revised });
  ok('TC-05', '反向更新全量覆盖生效', upd.status === 200 && upd.json?.content_md?.includes('v2 修订版'),
    `status=${upd.status} 含修订标记=${upd.json?.content_md?.includes('v2 修订版')}`);

  // TC-06 反向更新空内容 → 400
  const bad = await api('PUT', `/api/plans/prd-docs/${prdId}`, { contentMd: '   ' });
  ok('TC-06', '反向更新空内容返回 400', bad.status === 400, `status=${bad.status} error=${bad.json?.error}`);

  // TC-07 上下文解析（服务端函数级，经独立连接直查同一隔离库）：
  //   任务（导入生成的待办）→ req_ids → prd_id → 原文（>6000 字符应保头保尾截断）
  const tasks = (await api('GET', `/api/tasks?projectId=${projectId}&archived=false`)).json ?? [];
  const linkedTask = tasks.find((t) => t.title.startsWith('[PRD] 2 核心功能开发'));
  const { execFileSync } = await import('node:child_process');
  const utilPath = new URL('../server/dist/util/prdContext.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const probe = `const c = require(${JSON.stringify(utilPath)}).resolvePrdContext({ taskId: ${JSON.stringify(linkedTask?.id)} });
console.log(JSON.stringify(c ? { prdId: c.prdId, len: c.content.length, hasCut: c.content.includes('中段略去'), tailMark: c.content.includes('v2 修订版') } : null));`;
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const tmpDir = mkdtempSync(join(process.env.TEMP ?? 'D:/tmp', 't00763-'));
  const probeFile = join(tmpDir, 'probe.cjs');
  writeFileSync(probeFile, probe, 'utf8');
  let ctxOut = '';
  try {
    ctxOut = execFileSync(process.execPath, [probeFile], { env: { ...process.env, MTask_DATA_DIR: 'D:/tmp/mtask-t00763' }, encoding: 'utf8' }).trim();
  } catch (e) { ctxOut = 'ERR ' + String(e.message).slice(0, 200); }
  let ctx = null; try { ctx = JSON.parse(ctxOut); } catch { /* 解析失败按 FAIL 处理 */ }
  ok('TC-07', '任务反查 PRD 上下文（超长保头保尾截断 + 反向更新内容可见）',
    !!ctx && ctx.prdId === prdId && ctx.len <= 6000 + 200 && ctx.hasCut && ctx.tailMark,
    `ctx=${ctxOut.slice(0, 200)}`);

  // TC-08 未关联 PRD 的任务 → 解析返回 null（不误注入）
  const freeTask = (await api('POST', '/api/tasks', { projectId, title: '无PRD关联任务' })).json;
  const probe2 = `console.log(String(require(${JSON.stringify(utilPath)}).resolvePrdContext({ taskId: ${JSON.stringify(freeTask?.id)} })));`;
  const probe2File = join(tmpDir, 'probe2.cjs');
  writeFileSync(probe2File, probe2, 'utf8');
  let ctx2 = '';
  try {
    ctx2 = execFileSync(process.execPath, [probe2File], { env: { ...process.env, MTask_DATA_DIR: 'D:/tmp/mtask-t00763' }, encoding: 'utf8' }).trim();
  } catch (e) { ctx2 = 'ERR ' + String(e.message).slice(0, 120); }
  ok('TC-08', '未关联 PRD 的任务解析为 null', ctx2 === 'null', `result=${ctx2}`);

  // TC-09 上下文解析兼容 planId 入口
  const planList = (await api('GET', `/api/plans?projectId=${projectId}`)).json ?? [];
  const linkedPlan = planList.find((p) => p.title === '2 核心功能开发');
  const probe3 = `const c = require(${JSON.stringify(utilPath)}).resolvePrdContext({ planId: ${JSON.stringify(linkedPlan?.id)} });console.log(c ? 'HIT:' + c.prdId : 'null');`;
  const probe3File = join(tmpDir, 'probe3.cjs');
  writeFileSync(probe3File, probe3, 'utf8');
  let ctx3 = '';
  try {
    ctx3 = execFileSync(process.execPath, [probe3File], { env: { ...process.env, MTask_DATA_DIR: 'D:/tmp/mtask-t00763' }, encoding: 'utf8' }).trim();
  } catch (e) { ctx3 = 'ERR ' + String(e.message).slice(0, 120); }
  ok('TC-09', '计划条目反查 PRD 上下文命中', ctx3 === `HIT:${prdId}`, `result=${ctx3}`);

  // TC-10 兼容回归：不带 prdMd 的导入照常工作（不产生文档）
  const imp2 = await api('POST', '/api/plans/import-prd', { projectId, requirements: [{ reqNo: 'REQ-101', title: '兼容回归需求' }], plans: [] });
  const docs2 = (await api('GET', `/api/plans/prd-docs?projectId=${projectId}`)).json ?? [];
  ok('TC-10', '不带 prdMd 的导入向后兼容（文档数不变）', imp2.status === 200 && imp2.json?.prdId === undefined && docs2.length === 1,
    `status=${imp2.status} prdId=${imp2.json?.prdId} docs=${docs2.length}`);

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n==== SUMMARY: ${passed}/${results.length} passed ====`);
  process.exit(passed === results.length ? 0 : 1);
};
main().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(1); });
