// T00707 遗留补验 + D-6 修复回归：AI 解析环节真实调用（agnes-2.5-flash，OpenAI 兼容端点）
// 用法：AGNES_KEY=sk-xxx node t00707-ai-regression.mjs [baseUrl] [prdMdPath] [prdDocxPath]
// API Key 仅经环境变量注入，不落盘、不入库外泄（仅写入隔离实例 DB）。
// T00714（D-6 修复后）：md 长文档触顶截断时服务端显式报错（含「截断」字样）而非静默 400；
// 本脚本对 md 版接受两种结局（成功解析 / 显式截断错误），docx 版预期成功并提供导入闭环数据。
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:39901';
const PRD_MD = process.argv[3] ?? 'D:/code/otherProjects/28_AIMsg/docs/需求规格说明书_高情商聊天回复助手.md';
const PRD_DOCX = process.argv[4] ?? 'C:/Users/hspcadmin/AppData/Local/Temp/需求规格说明书_高情商聊天回复助手.docx';
const ENDPOINT = process.env.AGNES_BASE ?? 'https://apihub.agnes-ai.com/v1';
const MODEL = process.env.AGNES_MODEL ?? 'agnes-2.5-flash';
const KEY = process.env.AGNES_KEY;
if (!KEY) { console.error('缺少 AGNES_KEY'); process.exit(2); }

const results = [];
const ok = (id, name, pass, detail) => { results.push({ id, name, status: pass ? 'PASS' : 'FAIL', detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name} :: ${detail}`); };
const api = async (method, path, body, headers = {}) => {
  const res = await fetch(BASE + path, {
    method,
    signal: AbortSignal.timeout(420000),
    headers: body instanceof Buffer ? { 'Content-Type': 'application/octet-stream', ...headers } : { 'Content-Type': 'application/json', ...headers },
    body: body instanceof Buffer ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null; try { json = await res.json(); } catch { /* html */ }
  return { status: res.status, json };
};

const main = async () => {
  // P-02 创建 AI 工具配置（隔离库）
  const tool = await api('POST', '/api/aitools', {
    name: 'agnes-2.5-flash-T00707', type: 'openai-compatible', purpose: 'develop',
    endpoint: ENDPOINT, apiKey: KEY, model: MODEL,
    maxTokens: 16384, timeoutMs: 360000, remark: 'T00707 遗留补验临时配置',
  });
  const toolId = tool.json?.id;
  ok('P-02', '创建 AI 工具配置（隔离库）', (tool.status === 200 || tool.status === 201) && !!toolId, `status=${tool.status} id=${toolId} type=${tool.json?.type ?? '?'}`);

  // TC-AI-00 连接测试（ConfigService.testDraft）
  const t0 = Date.now();
  const test = await api('POST', '/api/aitools/test', { type: 'openai-compatible', endpoint: ENDPOINT, apiKey: KEY, model: MODEL });
  ok('TC-AI-00', `端点连接测试（${((Date.now() - t0) / 1000).toFixed(1)}s）`, test.status === 200 && (test.json?.ok ?? test.json?.success) !== false,
    `status=${test.status} resp=${JSON.stringify(test.json).slice(0, 160)}`);

  // 建被测项目
  const proj = await api('POST', '/api/projects', { name: `T00707-AI回归-${Date.now() % 100000}` });
  const projectId = proj.json?.id;

  // TC-AI-01 真实 AI 解析 PRD（markdown）——D-6 修复后接受两种结局：
  //   a) 200 成功解析；b) 400 且错误信息明确包含「截断」（显式检测，不再是误导性的「无效 JSON」）
  const t1 = Date.now();
  const parse = await api('POST', `/api/plans/ai-parse-prd?projectId=${projectId}&toolId=${toolId}&filename=PRD.md`, readFileSync(PRD_MD));
  const dt1 = ((Date.now() - t1) / 1000).toFixed(1);
  const r = parse.json ?? {};
  const reqs = Array.isArray(r.requirements) ? r.requirements : [];
  const drafts = Array.isArray(r.drafts) ? r.drafts : [];
  const mdTruncated = parse.status === 400 && typeof r.error === 'string' && r.error.includes('截断');
  ok('TC-AI-01', `真实 AI 解析 PRD（markdown，${dt1}s）`,
    (parse.status === 200 && r.ok === true && reqs.length > 0 && drafts.length > 0) || mdTruncated,
    parse.status === 200
      ? `需求 ${reqs.length} 条 / 计划 ${drafts.length} 条 coverageWarn="${r.coverageWarn ?? ''}"`
      : `status=${parse.status} error="${String(r.error ?? '').slice(0, 160)}" ${mdTruncated ? '→ 显式截断提示（D-6 修复生效）' : '→ 非预期失败'}`);

  // TC-AI-04 docx 路径（docxToMarkdown 提取 + AI）——docx 提取文本较短，预期成功
  const t2 = Date.now();
  const parseDocx = await api('POST', `/api/plans/ai-parse-prd?projectId=${projectId}&toolId=${toolId}&filename=PRD.docx`, readFileSync(PRD_DOCX));
  const rd = parseDocx.json ?? {};
  const dreqs = Array.isArray(rd.requirements) ? rd.requirements : [];
  const ddrafts = Array.isArray(rd.drafts) ? rd.drafts : [];
  ok('TC-AI-04', `docx 上传解析链路（${((Date.now() - t2) / 1000).toFixed(1)}s）`,
    parseDocx.status === 200 && rd.ok === true && dreqs.length > 0,
    `status=${parseDocx.status} 需求 ${dreqs.length} 条 / 计划 ${ddrafts.length} 条`);

  // D-6 断言：md 触顶时必须显式报截断；且 ai_usage 记 ok=false（不再静默）
  if (mdTruncated) {
    const usage = await api('GET', '/api/ai/usage?days=1');
    const hit = (usage.json?.recent ?? []).find((x) => x.ok === 0 && String(x.error ?? '').includes('截断'));
    ok('TC-AI-05', 'D-6：截断场景显式报错 + ai_usage 记失败',
      !!hit,
      hit ? `ai_usage error="${String(hit.error).slice(0, 120)}"` : 'ai_usage recent 中未找到截断失败记录');
  } else {
    ok('TC-AI-05', 'D-6：md 版未触发截断（本次输出未超限），显式检测逻辑待长文档场景覆盖', true,
      'md 解析成功返回，截断分支未触发（行为依赖端点输出上限，属环境变量级差异）');
  }

  // 结构合规 + 导入闭环：使用成功解析的一侧（md 优先，截断时用 docx 结果）
  const useMd = reqs.length > 0 && drafts.length > 0;
  const R = useMd ? reqs : dreqs;
  const D = useMd ? drafts : ddrafts;
  const srcLabel = useMd ? 'md' : 'docx';
  const noSet = new Set(R.map((x) => x.reqNo));
  const dupNos = R.length - noSet.size;
  const badDrafts = D.filter((d) => !(d.title && d.durationDays >= 1));
  const ghostNos = [...new Set(D.flatMap((d) => d.reqNos ?? []).filter((n) => !noSet.has(n)))];
  const emptyStart = D.filter((d) => d.startDate === '').length;
  const p0Keys = ['FR-1.1', 'FR-1.5', 'FR-3.1', 'FR-3.5', 'FR-4.1', 'FR-4.2', 'FR-6.1', 'FR-6.2', 'FR-6.4'];
  const blob = JSON.stringify(R);
  const p0Hit = p0Keys.filter((k) => blob.includes(k));
  ok('TC-AI-02', `解析结构合规（${srcLabel}；reqNo 唯一 / 工期≥1 / startDate 空串 / 无幽灵编号）`,
    R.length > 0 && dupNos === 0 && badDrafts.length === 0 && emptyStart === D.length && ghostNos.length === 0,
    `重复reqNo=${dupNos} 非法计划=${badDrafts.length} startDate空串 ${emptyStart}/${D.length} 幽灵编号=[${ghostNos.join(',')}] P0覆盖 ${p0Hit.length}/${p0Keys.length}=[${p0Hit.join(',')}]`);

  // TC-AI-03 导入 AI 结果 → 矩阵覆盖闭环
  const imp = await api('POST', '/api/plans/import-prd', { projectId, requirements: R, plans: D, createTasks: true });
  const matrix = ((await api('GET', `/api/plans/prd-requirements?projectId=${projectId}`)).json ?? []);
  const covered = matrix.filter((x) => (x.linkedPlans?.length ?? 0) + (x.linkedTasks?.length ?? 0) > 0).length;
  const uncovered = matrix.filter((x) => (x.linkedPlans?.length ?? 0) + (x.linkedTasks?.length ?? 0) === 0).map((x) => x.req_no);
  ok('TC-AI-03', `导入 AI 结果并验证矩阵覆盖（${covered}/${matrix.length} 需求被关联）`,
    imp.status === 200 && matrix.length === R.length,
    `矩阵行=${matrix.length}（导入需求 ${R.length}）已覆盖=${covered} 未覆盖=[${uncovered.slice(0, 12).join(',')}] 计划=${imp.json?.plans} 待办=${imp.json?.tasks} unlinkedReqNos=[${(imp.json?.unlinkedReqNos ?? []).join(',')}]`);

  // 汇总 + 样本留档
  const fail = results.filter((x) => x.status === 'FAIL');
  console.log(`\n==== AI 回归 SUMMARY: ${results.length - fail.length}/${results.length} passed ====${fail.length ? '\nFAIL: ' + fail.map((f) => f.id).join(', ') : ''}`);
  console.log(`\n[需求样例前 6 条（${srcLabel}）]`);
  for (const x of R.slice(0, 6)) console.log(`- ${x.reqNo} [${x.priority}] ${x.title} @${x.sourceRef}`);
  console.log(`[计划样例前 6 条（${srcLabel}）]`);
  for (const d of D.slice(0, 6)) console.log(`- ${d.title} (${d.durationDays}d, reqNos=[${(d.reqNos ?? []).join(',')}])`);
  if (uncovered.length) console.log(`[未覆盖需求全列表] ${uncovered.join(', ')}`);
};

main().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(1); });
