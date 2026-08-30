/**
 * MTask MCP 接口冒烟测试（ESM，node 直接运行）。
 *
 * 用法（先启动 MCP server，可带/不带访问令牌）：
 *   node mcp-smoke.mjs [--url http://127.0.0.1:39876/api/mcp] [--token <访问令牌>]
 *
 * 覆盖场景：
 *   1. 握手初始化成功，能枚举到工具
 *   2. 只读工具：列出项目 / 聚合周期数据 / 导出全量数据
 *   3. 写工具：创建任务、更新任务、归档/还原、创建/更新/删除提示词
 *   4. 异常场景：空标题创建任务、不存在的项目 id 创建任务（应返回 isError）
 *   5. 鉴权：未带令牌时 HTTP 握手被拒（401）；带令牌时通过
 *
 * 断言结果打印 PASS/FAIL 并在实际有断言失败时以非零码退出。
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
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${detail}`); }
};

// 带令牌时的请求头（MCP 传输层 requestInit 统一注入）
const headers = TOKEN ? { 'X-Access-Token': TOKEN } : undefined;

// ---------- 场景5：鉴权（HTTP 层） ----------
if (TOKEN) {
  const probeNoToken = await fetch(MCP_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{}}',
  });
  check('未带令牌访问被拒(401)', probeNoToken.status === 401, `status=${probeNoToken.status}`);

  const probeWithToken = await fetch(MCP_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Access-Token': TOKEN },
    body: '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{}}',
  });
  // 带令牌时通过鉴权层，若缺 sessionId 会进 MCP 层返回 400（非 401 即鉴权通过）
  check('带令牌可通过鉴权', probeWithToken.status !== 401, `status=${probeWithToken.status}`);
}

// ---------- 握手（MCP 层） ----------
let client;
{
  const c = new Client({ name: 'mtask-smoke' }, { capabilities: {} });
  const ok = await c.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers } }))
    .then(() => true).catch(() => false);
  check(`握手${TOKEN ? '（带令牌）' : '（公开端点）'}`, ok);
  if (!ok) {
    console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
    process.exit(failed ? 1 : 0);
  }
  client = c;
}

// ---------- 场景1：枚举工具 ----------
const tools = (await client.listTools()).tools;
check('枚举工具非空', tools.length >= 10, `tools=${tools.length}`);

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n') ?? '';
  return { isError: Boolean(r.isError), text, structured: r.structuredContent };
};

// ---------- 场景2：只读 ----------
const proj = await call('mtask_list_projects', {});
check('列出项目（只读）', !proj.isError, proj.text.slice(0, 80));
let projectId;
try { projectId = proj.structured.projects[0]?.id; } catch { projectId = undefined; }
check('存在可用项目', !!projectId, '请先在前端创建项目');

const gather = await call('mtask_gather_report_data', { period: 'week' });
check('聚合周期数据', !gather.isError && gather.structured.data, gather.text.slice(0, 60));

const exp = await call('mtask_export_data', {});
check('导出全量数据', !exp.isError && exp.structured.bundle?.app === 'mtask', exp.text.slice(0, 60));

// ---------- 场景3：写工具（任务） ----------
const created = await call('mtask_create_task', { projectId, title: '[smoke] MCP 测试任务', priority: 'high' });
const taskId = created.structured?.task?.id;
check('创建任务', !created.isError && !!taskId, created.text.slice(0, 60));

const updated = await call('mtask_update_task', { id: taskId, status: 'done', description: '已联调' });
check('更新任务', !updated.isError && updated.structured?.task?.status === 'done', updated.text.slice(0, 60));

const archived = await call('mtask_set_tasks_archived', { taskIds: [taskId], archived: true });
check('归档任务', !archived.isError, archived.text.slice(0, 60));
await call('mtask_set_tasks_archived', { taskIds: [taskId], archived: false });

// ---------- 场景3（提示词） ----------
const createdCat = await call('mtask_create_prompt_category', { name: '[smoke] MCP 分类' });
const catId = createdCat.structured?.category?.id;
const createdP = await call('mtask_create_prompt', { categoryId: catId, title: '[smoke] 提示词', content: 'hi' });
const promId = createdP.structured?.prompt?.id;
check('创建提示词分类+提示词', !!catId && !createdP.isError, createdP.text.slice(0, 60));

const listP = await call('mtask_list_prompts', { categoryId: catId });
check('按分类列出提示词', !listP.isError && Array.isArray(listP.structured?.prompts), listP.text.slice(0, 60));

await call('mtask_delete_prompt', { id: promId });
const cleanCheck = await call('mtask_delete_prompt', { id: promId });
check('删除提示词（幂等）', !cleanCheck.isError, cleanCheck.text.slice(0, 60));

// ---------- 场景4：异常 ----------
const emptyTitle = await call('mtask_create_task', { projectId, title: '  ' });
check('空标题创建被拒', emptyTitle.isError, emptyTitle.text.slice(0, 60));

const badProj = await call('mtask_create_task', { projectId: 'no-such-project', title: 'x' });
check('不存在的项目 id 报错', badProj.isError, badProj.text.slice(0, 60));

const badPeriod = await (async () => {
  try { await call('mtask_gather_report_data', { period: 'year' }); return { isError: false }; }
  catch (e) { return { isError: true }; }
})();
check('非法周期参数被拒', badPeriod.isError);

await client.close().catch(() => {});

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);