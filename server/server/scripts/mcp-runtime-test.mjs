/**
 * MCP 运行时端到端验证（进程内，无需拉起 HTTP 服务）。
 *
 * 用 SDK 的 InMemoryTransport 把 Client 与 createMCPServer 直连链路起来，
 * 真实执行工具处理函数并读写 SQLite，以规避沙箱环境派生 HTTP 服务进程的不确定性。
 *
 * 用法：node mcp-runtime-test.mjs  （MTask_DATA_DIR 自动指向系统临时目录）
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 必须先于服务模块加载设置数据目录（getDb 在首次调用时读取它）
process.env.MTask_DATA_DIR = mkdtempSync(join(tmpdir(), 'mcp-runtime-'));
const file = (p) => pathToFileURL(join(__dirname, '..', 'dist', `${p}.js`)).href;

const { initSchema } = await import(file('db/schema'));
const { getDb } = await import(file('db/connection'));
initSchema();

// 种子：插入一个项目，供任务创建/迁移测试使用
const seed = getDb().prepare('INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
  .run('proj-seed', '种子项目', '', new Date().toISOString(), new Date().toISOString());

const { createMCPServer } = await import(file('mcp/server'));
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

let failed = 0, passed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${detail}`); }
};

const server = await createMCPServer();
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: 'mtask-rt-test', version: '1.0.0' }, { capabilities: {} });
await client.connect(clientTransport);

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n') ?? '';
  return { isError: Boolean(r.isError), text, structured: r.structuredContent };
};

// 枚举工具
const tools = (await client.listTools()).tools;
check('枚举工具 >= 10', tools.length >= 10, `tools=${tools.length}`);

// 只读
const proj = await call('mtask_list_projects', {});
check('列出项目(含种子)', !proj.isError && proj.structured.projects.some((p) => p.id === 'proj-seed'), proj.text.slice(0, 60));

const gather = await call('mtask_gather_report_data', { period: 'week' });
check('聚合周期数据', !gather.isError && Array.isArray(gather.structured.data?.tasks), gather.text.slice(0, 60));

const exp = await call('mtask_export_data', {});
check('导出全量数据', !exp.isError && exp.structured.bundle?.app === 'mtask', exp.text.slice(0, 60));

// 任务写
const created = await call('mtask_create_task', { projectId: 'proj-seed', title: '运行时验证任务', priority: 'high' });
const taskId = created.structured?.task?.id;
check('创建任务', !created.isError && !!taskId, created.text.slice(0, 60));

const updated = await call('mtask_update_task', { id: taskId, status: 'done', description: '已联调' });
check('更新任务', !updated.isError && updated.structured?.task?.status === 'done', updated.text.slice(0, 60));

const archived = await call('mtask_set_tasks_archived', { taskIds: [taskId], archived: true });
check('归档任务', !archived.isError, archived.text.slice(0, 60));

// 提示词
const cat = await call('mtask_create_prompt_category', { name: '运行时分类' });
const catId = cat.structured?.category?.id;
const pr = await call('mtask_create_prompt', { categoryId: catId, title: '运行提示词', content: 'x' });
const prId = pr.structured?.prompt?.id;
check('创建提示词分类+提示词', !!catId && !!prId && !pr.isError, pr.text.slice(0, 60));

// 迁移：导出再导回（keep 走 upsert 路径）与 overwrite（全量重建）双路径
const bundle = exp.structured.bundle;
const impK = await call('mtask_import_data', { data: bundle, mode: 'keep' });
check('导入(bundle, keep)', !impK.isError && impK.structured?.result?.imported >= 0, impK.text.slice(0, 80));
const impO = await call('mtask_import_data', { data: bundle, mode: 'overwrite' });
check('导入(bundle, overwrite)', !impO.isError && impO.structured?.result?.imported >= 0, impO.text.slice(0, 80));

// 异常：空标题、非法项目、非法周期
const emptyTitle = await call('mtask_create_task', { projectId: 'proj-seed', title: ' ' });
check('空标题被拒', emptyTitle.isError, emptyTitle.text.slice(0, 60));

const badProj = await call('mtask_create_task', { projectId: 'no-such', title: 'x' });
check('不存在项目报错', badProj.isError, badProj.text.slice(0, 60));

const badPeriod = await call('mtask_gather_report_data', { period: 'year' });
check('非法周期被拒', badPeriod.isError, badPeriod.text.slice(0, 60));

await client.close().catch(() => {});
await server.close().catch(() => {});
await getDb().close();

console.log(`\n运行时测试：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);