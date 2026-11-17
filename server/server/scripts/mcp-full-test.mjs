/**
 * MTask MCP 接口全量测试（ESM，node 直接运行）。
 * 覆盖全部 18 个工具的正常路径 + 参数分支 + 协议/鉴权场景。
 * 建议配合 mcp-run.mjs --script 在隔离服务上运行，避免污染真实数据。
 * 用法：node mcp-full-test.mjs [--url ...] [--token ...]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
};
const MCP_URL = arg('url') ?? 'http://127.0.0.1:39876/api/mcp';
const TOKEN = arg('token');

let failed = 0, passed = 0;
let group = '';
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  PASS  [${group}] ${name}`); }
  else { failed++; console.log(`  FAIL  [${group}] ${name} ${detail}`); }
};
const section = (t) => { group = t; console.log(`--- ${t} ---`); };

const headers = TOKEN ? { 'X-Access-Token': TOKEN } : undefined;
const call = async (client, name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n') ?? '';
  return { isError: Boolean(r.isError), text, structured: r.structuredContent };
};
const cap = (s, n = 70) => (s && s.length > n ? s.slice(0, n) + '…' : s);

// ---------- 协议层（裸 HTTP 直连，不经 MCP 会话） ----------
section('协议层');
{
  const r = await fetch(MCP_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: '{"jsonrpc":"2.0","method":"tools/list","id":1,"params":{}}',
  }).catch(() => null);
  check('非 initialize 且无会话被拒(400)', r && r.status === 400, `status=${r?.status}`);
  if (r) {
    const b = await r.json().catch(() => ({}));
    check('错误码为 -32000', b?.error?.code === -32000, `code=${b?.error?.code}`);
  }
  const r2 = await fetch(MCP_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2025-03-26","clientInfo":{"name":"x"}}}',
  }).catch(() => null);
  check('缺 clientInfo.version 被拒(400)', r2 && r2.status === 400, `status=${r2?.status}`);
}

const client = new Client({ name: 'mtask-full', version: '1.0' }, { capabilities: {} });
const ok = await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers } }))
  .then(() => true).catch(() => false);
check('握手连接', ok);
if (!ok) {
  console.log(`\n[全量] 结果：${passed} 通过 / ${failed} 失败（握手失败终止）`);
  process.exit(failed ? 1 : 0);
}

// ---------- 任务管理 ----------
section('任务管理');
const proj = await call(client, 'mtask_list_projects', {});
const projects = proj.structured?.projects ?? [];
check('list_projects 返回数组', Array.isArray(projects) && projects.length > 0);
const pid = projects[0]?.id;
const pid2 = projects[1]?.id ?? pid;

const c1 = await call(client, 'mtask_create_task', { projectId: pid, title: '[full] 正常任务', priority: 'urgent', status: 'todo' });
check('create_task 正常', !c1.isError && !!c1.structured?.task?.id, cap(c1.text));
check('create_task 反映 urgent', c1.structured?.task?.priority === 'urgent');
const t1 = c1.structured?.task?.id;

const c2 = await call(client, 'mtask_create_task', { projectId: pid, title: '[full] 完成态', status: 'done' });
const t2 = c2.structured?.task?.id;
check('create_task 缺省优先级', !c2.isError && c2.structured?.task?.status === 'done');

const c3 = await call(client, 'mtask_create_task', { title: '[full] 缺省项目' });
check('create_task 缺省项目落默认', !c3.isError && !!c3.structured?.task?.project_id, cap(c3.text));

const c4 = await call(client, 'mtask_create_task', { projectId: pid, title: '   ' });
check('create_task 空标题被拒', c4.isError, cap(c4.text));
const c5 = await call(client, 'mtask_create_task', { projectId: 'no-such-project', title: 'x' });
check('create_task 坏项目被拒', c5.isError, cap(c5.text));

const l1 = await call(client, 'mtask_list_tasks', { archived: false });
check('list_tasks 全部含新任务', !l1.isError && Array.isArray(l1.structured?.tasks) && l1.structured.tasks.some((t) => t.id === t1), cap(l1.text));
const l2 = await call(client, 'mtask_list_tasks', { projectId: pid, archived: false });
check('list_tasks 按项目过滤', !l2.isError && l2.structured?.tasks?.every((t) => t.project_id === pid), cap(l2.text));

const g1 = await call(client, 'mtask_get_task', { id: t1 });
check('get_task 存在', !g1.isError && g1.structured?.task?.id === t1, cap(g1.text));
const g2 = await call(client, 'mtask_get_task', { id: 'no-such-id' });
check('get_task 不存在报错', g2.isError, cap(g2.text));

const u1 = await call(client, 'mtask_update_task', { id: t1, title: '[full] 已改', priority: 'high', verified: true, pinned: true });
check('update_task 多字段', !u1.isError && u1.structured?.task?.title === '[full] 已改' && u1.structured?.task?.verified === true, cap(u1.text));
const uNullCat = await call(client, 'mtask_update_task', { id: t1, categoryId: null });
check('update_task 清分类(null)不报错', !uNullCat.isError, cap(uNullCat.text));

const r1 = await call(client, 'mtask_update_task_result', { id: t1, result: '**根因**：WAL 文件锁\n**方案**：health 放行鉴权' });
check('update_task_result 同步处理结果', !r1.isError && r1.structured?.task?.handle_result === '**根因**：WAL 文件锁\n**方案**：health 放行鉴权', cap(r1.text));
const rErr = await call(client, 'mtask_update_task_result', { id: t1, result: '' });
check('update_task_result 空结果拒绝', rErr.isError, cap(rErr.text));
const rNoId = await call(client, 'mtask_update_task_result', { id: 'no-such-id', result: 'x' });
check('update_task_result 不存在任务报错', rNoId.isError, cap(rNoId.text));

// 任务编号（taskNo）定位：创建/查询/更新/回传结果均可按编号
const taskNo1 = c1.structured?.task?.task_no;
check('create_task 携带 task_no', !!taskNo1 && /^T\d{5}$/.test(taskNo1), 'no=' + taskNo1);
const gByNo = await call(client, 'mtask_get_task', { taskNo: taskNo1 });
check('get_task 按 taskNo 查询', !gByNo.isError && gByNo.structured?.task?.id === t1, cap(gByNo.text));
const uByNo = await call(client, 'mtask_update_task', { taskNo: taskNo1, status: 'done' });
check('update_task 按 taskNo 更新', !uByNo.isError && uByNo.structured?.task?.status === 'done', cap(uByNo.text));
const gMissing = await call(client, 'mtask_get_task', { taskNo: 'T99999' });
check('get_task 不存在 taskNo 报错', gMissing.isError, cap(gMissing.text));
const gNoLocate = await call(client, 'mtask_get_task', {});
check('get_task 无 id/taskNo 报错', gNoLocate.isError, cap(gNoLocate.text));
const rByNo = await call(client, 'mtask_update_task_result', { taskNo: taskNo1, result: '编号定位写入的处理结果' });
check('update_task_result 按 taskNo 回传', !rByNo.isError && rByNo.structured?.task?.handle_result === '编号定位写入的处理结果', cap(rByNo.text));
const rMissing = await call(client, 'mtask_update_task_result', { taskNo: 'T99999', result: 'x' });
check('update_task_result 不存在 taskNo 报错', rMissing.isError, cap(rMissing.text));
// 恢复待办状态，避免影响后续归档/移动断言
await call(client, 'mtask_update_task', { id: t1, status: 'todo' });

const mv1 = await call(client, 'mtask_move_tasks', { taskIds: [t2], projectId: pid2 });
const afterMove = await call(client, 'mtask_get_task', { id: t2 });
check('move_tasks 移动到目标项目', !mv1.isError && afterMove.structured?.task?.project_id === pid2, cap(mv1.text));
const mvBad = await call(client, 'mtask_move_tasks', { taskIds: [t2], projectId: 'no-such-p' });
check('move_tasks 坏项目报错', mvBad.isError, cap(mvBad.text));
const mvEmpty = await call(client, 'mtask_move_tasks', { taskIds: [], projectId: pid });
check('move_tasks 空数组可处理', !mvEmpty.isError, cap(mvEmpty.text));

const ar = await call(client, 'mtask_set_tasks_archived', { taskIds: [t1], archived: true });
const arList = await call(client, 'mtask_list_tasks', { projectId: pid, archived: true });
check('归档后出现在归档列表', !ar.isError && arList.structured?.tasks?.some((t) => t.id === t1), cap(ar.text));
await call(client, 'mtask_set_tasks_archived', { taskIds: [t1], archived: false });
const arEmpty = await call(client, 'mtask_set_tasks_archived', { taskIds: [], archived: true });
check('归档空数组可处理', !arEmpty.isError, cap(arEmpty.text));

// ---------- 提示词管理 ----------
section('提示词管理');
const cgs = await call(client, 'mtask_list_prompt_categories', {});
check('list_prompt_categories', !cgs.isError && Array.isArray(cgs.structured?.categories), cap(cgs.text));

const newCat = await call(client, 'mtask_create_prompt_category', { name: '[full] 测试分类', description: 'd' });
const catId = newCat.structured?.category?.id;
check('create_prompt_category 正常', !newCat.isError && !!catId, cap(newCat.text));
const emptyCat = await call(client, 'mtask_create_prompt_category', { name: '   ' });
check('create_prompt_category 空名拒绝', emptyCat.isError, cap(emptyCat.text));

const p1 = await call(client, 'mtask_create_prompt', { categoryId: catId, title: '[full] 提示A', content: 'hello' });
const p1id = p1.structured?.prompt?.id;
check('create_prompt 正常', !p1.isError && !!p1id, cap(p1.text));
const pEmptyTitle = await call(client, 'mtask_create_prompt', { categoryId: catId, title: '  ' });
check('create_prompt 空标题拒绝', pEmptyTitle.isError, cap(pEmptyTitle.text));

const lp1 = await call(client, 'mtask_list_prompts', { categoryId: catId });
check('list_prompts 按分类', !lp1.isError && lp1.structured?.prompts?.length >= 1, cap(lp1.text));
const lpK = await call(client, 'mtask_list_prompts', { keyword: '提示A' });
check('list_prompts 关键词检索', !lpK.isError && lpK.structured?.prompts?.some((x) => x.id === p1id), cap(lpK.text));

const up = await call(client, 'mtask_update_prompt', { id: p1id, title: '[full] 提示A2', pinned: true });
check('update_prompt 正常', !up.isError && up.structured?.prompt?.title === '[full] 提示A2', cap(up.text));
const upNone = await call(client, 'mtask_update_prompt', { id: p1id });
check('update_prompt 无字段拒绝', upNone.isError, cap(upNone.text));

const del = await call(client, 'mtask_delete_prompt', { id: p1id });
check('delete_prompt 正常', !del.isError, cap(del.text));
const delAgain = await call(client, 'mtask_delete_prompt', { id: p1id });
check('delete_prompt 不存在幂等', !delAgain.isError, cap(delAgain.text));

// ---------- 周报生成 ----------
section('周报生成');
for (const period of ['day', 'week', 'month']) {
  const g = await call(client, 'mtask_gather_report_data', { period });
  check(`gather_report_data ${period}`, !g.isError && g.structured?.data, cap(g.text));
}
const gBad = await call(client, 'mtask_gather_report_data', { period: 'year' });
check('gather_report_data 非法周期拒绝', gBad.isError, cap(gBad.text));

for (const format of ['xlsx', 'docx', 'pdf', 'pptx']) {
  const r = await call(client, 'mtask_generate_report', { period: 'week', format });
  check(`generate_report ${format}`, !r.isError && !!r.structured?.filename && r.structured?.size > 0, cap(r.text));
}
const rBad = await call(client, 'mtask_generate_report', { period: 'week', format: 'csv' });
check('generate_report 非法格式拒绝', rBad.isError, cap(rBad.text));

const aiBadPeriod = await call(client, 'mtask_ai_generate_report', { period: 'year', format: 'xlsx', toolId: 't' });
check('ai_generate_report 非法周期拒绝', aiBadPeriod.isError, cap(aiBadPeriod.text));
const aiBadFormat = await call(client, 'mtask_ai_generate_report', { period: 'week', format: 'md', toolId: 'no-such-tool' });
check('ai_generate_report 非法格式拒绝', aiBadFormat.isError, cap(aiBadFormat.text));
const aiNoTool = await call(client, 'mtask_ai_generate_report', { period: 'week', format: 'xlsx', toolId: 'no-such-tool' });
check('ai_generate_report 坏 toolId 报错', aiNoTool.isError, cap(aiNoTool.text));

// ---------- 数据迁移 ----------
section('数据迁移');
const exp = await call(client, 'mtask_export_data', {});
check('export_data 结构完整', !exp.isError && exp.structured?.bundle?.app === 'mtask' && !!exp.structured?.bundle?.data, cap(exp.text));
const impBad = await call(client, 'mtask_import_data', { data: 'not-a-bundle', mode: 'overwrite' });
check('import_data 坏数据拒绝', impBad.isError, cap(impBad.text));

await client.close().catch(() => {});
console.log(`\n[全量] 结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);