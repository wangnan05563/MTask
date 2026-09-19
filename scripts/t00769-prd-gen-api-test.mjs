// T00769 API 级断言：原始需求生成 PRD（SSE 流式）+ 批量问题 + 录入 PRD 管理视图链路
// 用法：node t00769-prd-gen-api-test.mjs [baseUrl] [toolId]
// 说明：流式端点真实调用 LLM（AGNES_KEY），耗时约 1-2 分钟；老式格式/校验类断言不依赖 LLM。
const BASE = process.argv[2] ?? 'http://127.0.0.1:39903';
const TOOL_ID = process.argv[3] ?? process.env.MTASK_TEST_TOOL_ID ?? '';
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
const proj = (await api('POST', '/api/projects', { name: `T00769-PRD生成-${Date.now() % 100000}` })).json;
const pid = proj.id;
check('P-01 创建项目', !!pid, `id=${pid}`);

// 自动创建临时 AI 工具（隔离库；key 从 agnes 内置技能配置读取）
let autoToolId = TOOL_ID;
if (!autoToolId) {
  try {
    const { readFileSync } = await import('node:fs'); const cfg = readFileSync(`${process.env.USERPROFILE}/.workbuddy/skills/agnes-image-2.5-flash/config.yaml`, 'utf8');
    const key = /api_key:\s*"([^"]+)"/.exec(cfg)?.[1] ?? '';
    const tool = await api('POST', '/api/aitools', {
      name: 'agnes-2.5-flash-T00769', type: 'openai-compatible', purpose: 'develop',
      endpoint: 'https://apihub.agnes-ai.com/v1', apiKey: key, model: 'agnes-2.5-flash',
      maxTokens: 16384, timeoutMs: 600000, remark: 'T00769 流式生成临时配置',
    });
    autoToolId = tool.json?.id ?? '';
    check('P-02 自动创建 AI 工具', !!autoToolId, `id=${autoToolId}`);
  } catch (e) {
    console.log(`SKIP 流式生成断言（自动建工具失败：${String(e).slice(0, 80)}）`);
  }
}

// ---- 校验类（不依赖 LLM） ----
const noBody = await fetch(`${BASE}/api/plans/prd-generate-stream?projectId=${pid}&toolId=${autoToolId}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(0) });
check('V-1 空文件 400', noBody.status === 400, `status=${noBody.status}`);
const docFile = await fetch(`${BASE}/api/plans/prd-generate-stream?projectId=${pid}&toolId=placeholder&filename=a.doc`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('x') });
{
  const j = await docFile.json().catch(() => ({}));
  check('V-2 老式 .doc 拒绝（结构化 400）', docFile.status === 400, `status=${docFile.status}`);
  check('V-3 .doc 错误信息含另存提示', JSON.stringify(j).includes('另存为 .docx'), `error=${j.error}`);
}
const badProj = await fetch(`${BASE}/api/plans/prd-generate-stream?projectId=nonexistent&toolId=placeholder&filename=a.md`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('# x') });
{
  const j = await badProj.json().catch(() => ({}));
  check('V-4 项目不存在（结构化 400）', badProj.status === 400 && j.error === '项目不存在', `status=${badProj.status} error=${j.error}`);
}

// ---- 批量问题入库（不依赖 LLM） ----
const doc = await api('POST', '/api/plans/prd-docs', { projectId: pid, filename: '手建PRD.md', contentMd: '# 手建 PRD\n\n- 功能A\n' });
const batch = await api('POST', '/api/plans/prd-issues/batch', {
  projectId: pid, prdId: doc.json.id,
  items: [
    { question: '票据状态机是否含「拒签」分支？', level: 'blocker', answer: '含' },
    { question: '是否对接异常票据库？', level: 'suggested' },
    { question: '默认排序按创建时间', level: 'info' },
    { question: '我自定义的问题', level: 'custom', answer: '自定义结论' },
  ],
});
check('B-1 批量录入 4 条（含 level）', batch.status === 200 && batch.json.length === 4, `status=${batch.status} count=${batch.json?.length}`);
const levelOk = (batch.json ?? []).every((x, i) => x.level === ['blocker', 'suggested', 'info', 'custom'][i]);
check('B-2 level 原样落库', levelOk, `levels=[${(batch.json ?? []).map((x) => x.level).join(',')}]`);
const emptyBatch = await api('POST', '/api/plans/prd-issues/batch', { projectId: pid, items: [] });
check('B-3 空 items 400', emptyBatch.status === 400, `error=${emptyBatch.json?.error}`);
const listIss = (await api('GET', `/api/plans/prd-issues?projectId=${pid}`)).json ?? [];
check('B-4 列表可见 4 条', listIss.length === 4, `count=${listIss.length}`);

// ---- 流式生成（真实 LLM；无 toolId 时跳过） ----
if (!autoToolId) {
  console.log('SKIP 流式生成断言（未传 toolId）——仅完成校验/批量/录入链路');
} else {
  const md = Buffer.from([
    '# 银承承兑签收功能需求',
    '',
    '业务会上口头确认：',
    '1. 收到银承后，经办人可以签收或拒绝',
    '2. 签收后票据状态变为持有',
    '3. 金额1000万以上的要双人复核',
  ].join('\n')).toString('base64');
  const events = [];
  const res = await fetch(`${BASE}/api/plans/prd-generate-stream?projectId=${pid}&toolId=${autoToolId}&filename=${encodeURIComponent('银承签收需求.md')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentBase64: md }),
  });
  check('S-1 SSE 响应头', (res.headers.get('content-type') ?? '').includes('text/event-stream'), res.headers.get('content-type'));
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const ev = /^event: (.+)$/m.exec(block)?.[1] ?? '';
      const data = /^data: (.+)$/m.exec(block)?.[1] ?? '{}';
      events.push({ ev, data: JSON.parse(data) });
    }
  }
  const stages = events.filter((e) => e.ev === 'stage');
  const chunks = events.filter((e) => e.ev === 'chunk');
  const done = events.find((e) => e.ev === 'done');
  const err = events.find((e) => e.ev === 'error');
  check('S-2 有阶段日志', stages.length >= 4, `stages=${stages.map((s) => s.data.msg).join(' | ').slice(0, 160)}`);
  check('S-3 正文流式增量', chunks.length >= 3 && chunks.reduce((a, c) => a + c.data.text.length, 0) > 500, `chunks=${chunks.length} chars=${chunks.reduce((a, c) => a + c.data.text.length, 0)}`);
  check('S-4 无 error 事件', !err, err?.data?.error?.slice(0, 120) ?? '');
  check('S-5 done 含 PRD 与问题', !!done && done.data.prdMd.length > 500 && Array.isArray(done.data.issues),
    `prdMd=${done?.data?.prdMd?.length}ch issues=${done?.data?.issues?.length} levels=[${(done?.data?.issues ?? []).map((i) => i.level).join(',')}]`);
  check('S-6 PRD 含原文关键点（原文一字不改原则）', !!done && done.data.prdMd.includes('双人复核'), '');
  check('S-7 阶段含内置技能加载与源码上下文', stages.some((s) => s.data.msg.includes('内置技能')) && stages.some((s) => s.data.msg.includes('源码上下文')), '');

  // ---- 录入链路：done 结果 → prd_docs + 批量问题 ----
  if (done) {
    const save = await api('POST', '/api/plans/prd-docs', { projectId: pid, filename: '银承签收PRD.md', contentMd: done.data.prdMd, status: 'confirmed' });
    check('L-1 PRD 录入管理视图（确认版）', save.status === 200 && save.json.status === 'confirmed', `id=${save.json?.id} status=${save.json?.status}`);
    if (done.data.issues.length > 0) {
      const bi = await api('POST', '/api/plans/prd-issues/batch', {
        projectId: pid, prdId: save.json.id,
        items: done.data.issues.map((i) => ({ question: i.question, level: i.level })),
      });
      check('L-2 AI 问题批量入库', bi.status === 200 && bi.json.length === done.data.issues.length, `count=${bi.json?.length}`);
    }
    const finalDoc = (await api('GET', `/api/plans/prd-docs/${save.json.id}`)).json;
    check('L-3 管理视图可读回全文', finalDoc.content_md.length === done.data.prdMd.length, `chars=${finalDoc.content_md?.length}`);
  }
}

console.log(`==== T00769 SUMMARY: ${pass}/${pass + fail} passed ====`);
process.exit(fail > 0 ? 1 : 0);
