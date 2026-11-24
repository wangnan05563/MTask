/**
 * T06305（REQ-010 / PRD §B2）模板实例化契约测试。
 *
 * 覆盖：内置模板可读、自定义模板 CRUD、任务模板实例化→撤销归档、
 * 项目模板实例化→撤销删项目、项目被继续编辑时拒绝整体撤销、
 * 内置只读、非法 schema/重名/缺 projectId 的错误码。
 *
 * 运行：先起隔离服务，再
 *   node node_modules/tsx/dist/cli.mjs server/scripts/verify-t06305-templates.mts
 * 环境：MTASK_BASE_URL 默认 http://127.0.0.1:5203
 */
const BASE = process.env.MTASK_BASE_URL || 'http://127.0.0.1:5203';

let checks = 0;
function ok(cond: unknown, label: string, detail?: unknown): void {
  checks += 1;
  if (!cond) {
    console.error(`[FAIL] ${label}`, detail ?? '');
    process.exit(1);
  }
  console.log(`[PASS] ${label}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
}
async function req(path: string, init?: RequestInit): Promise<Response> { return fetch(`${BASE}${path}`, init); }
async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await req(path, init);
  const body = await r.text();
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body) as T;
}
async function expectStatus(path: string, init: RequestInit, status: number): Promise<string> {
  const r = await req(path, init);
  const body = await r.text();
  if (r.status !== status) throw new Error(`${path} expected ${status} got ${r.status}: ${body.slice(0, 300)}`);
  return body;
}
const post = (path: string, body: unknown) => json(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

interface Template { id: string; type: 'task' | 'project'; name: string; builtin: boolean; schema: Record<string, unknown> }
interface InstanceResult { instanceId: string; type: string; projectId: string; projectName: string; tasks: Array<{ id: string; title: string }> }

const health = await json<{ ok: boolean }>('/api/health');
ok(health.ok === true, '测试服务就绪', health);

const project = await post('/api/projects', { name: `T06305 模板契约 ${Date.now()}` }) as { id: string; name: string };
ok(Boolean(project.id), '任务模板目标项目创建', project);

const list = await json<{ rows: Template[] }>('/api/templates');
ok(list.rows.some((t) => t.type === 'task' && t.name === '功能开发任务' && t.builtin), '内置任务模板存在', list.rows.map((t) => `${t.type}:${t.name}`));
ok(list.rows.some((t) => t.type === 'project' && t.name === '标准交付项目' && t.builtin), '内置项目模板存在', list.rows.map((t) => `${t.type}:${t.name}`));
const builtinTask = list.rows.find((t) => t.type === 'task' && t.builtin)!;
const builtinProject = list.rows.find((t) => t.type === 'project' && t.builtin)!;

await expectStatus(`/api/templates/${builtinTask.id}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '改内置' }),
}, 403);
await expectStatus(`/api/templates/${builtinTask.id}`, { method: 'DELETE' }, 403);
ok(true, '内置模板不可改/不可删');

const custom = await post('/api/templates', {
  type: 'task', name: `T06305 自定义任务 ${Date.now()}`,
  description: '自定义任务模板',
  schema: { title: 'T06305 自定义任务', description: '来自自定义模板', priority: 'high', status: 'todo' },
}) as Template;
ok(custom.builtin === false && custom.type === 'task', '自定义任务模板创建', { id: custom.id, builtin: custom.builtin });
await expectStatus('/api/templates', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'task', name: custom.name, schema: { title: 'x' } }),
}, 409);
ok(true, '同类型重名模板拒绝');
await expectStatus('/api/templates', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'task', name: `坏模板 ${Date.now()}`, schema: { description: '缺标题' } }),
}, 400);
ok(true, '非法任务模板 schema 拒绝');
await expectStatus(`/api/templates/${custom.id}/instantiate`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
}, 400);
ok(true, '任务模板缺 projectId 拒绝');

const taskInst = await post(`/api/templates/${custom.id}/instantiate`, { projectId: project.id }) as InstanceResult;
ok(taskInst.tasks.length === 1 && taskInst.tasks[0].title === 'T06305 自定义任务', '任务模板实例化建 1 条任务', taskInst);
const todoRows = await json<Array<{ id: string; title: string; description: string; priority: string }>>(
  `/api/tasks?projectId=${encodeURIComponent(project.id)}&status=todo&limit=100`,
);
const createdTask = todoRows.find((t) => t.id === taskInst.tasks[0].id);
ok(Boolean(createdTask && createdTask.description === '来自自定义模板' && createdTask.priority === 'high'), '实例任务字段落库正确', createdTask);

const undo1 = await post(`/api/templates/instances/${taskInst.instanceId}/undo`, {}) as { ok: boolean; undoneTaskIds: string[] };
ok(undo1.ok && undo1.undoneTaskIds.includes(taskInst.tasks[0].id), '任务实例撤销', undo1);
const archivedRows = await json<Array<{ id: string; archived: boolean }>>(
  `/api/tasks?projectId=${encodeURIComponent(project.id)}&archived=1&limit=100`,
);
ok(archivedRows.some((t) => t.id === taskInst.tasks[0].id && t.archived === true), '撤销后任务进入归档', archivedRows.map((t) => t.id));
await expectStatus(`/api/templates/instances/${taskInst.instanceId}/undo`, { method: 'POST' }, 409);
ok(true, '重复撤销拒绝');

const customProject = await post('/api/templates', {
  type: 'project', name: `T06305 自定义项目 ${Date.now()}`,
  description: '两任务项目模板',
  schema: {
    description: '项目模板描述',
    tasks: [
      { title: 'T06305 项目任务甲', description: '甲', priority: 'high' },
      { title: 'T06305 项目任务乙', description: '乙', priority: 'low', status: 'done' },
    ],
  },
}) as Template;
const projInst = await post(`/api/templates/${customProject.id}/instantiate`, {}) as InstanceResult;
ok(projInst.tasks.length === 2 && projInst.projectName.startsWith(customProject.name), '项目模板实例化建项目+2 任务', projInst);
const projects = await json<Array<{ id: string; name: string }>>('/api/projects');
ok(projects.some((p) => p.id === projInst.projectId && p.name === projInst.projectName), '项目行已创建', { projectId: projInst.projectId });
const projTodo = await json<Array<{ id: string; title: string; status: string }>>(`/api/tasks?projectId=${encodeURIComponent(projInst.projectId)}&limit=100`);
ok(projTodo.length === 2, '项目模板任务落库 2 条', projTodo.map((t) => `${t.title}:${t.status}`));

const undoProj = await post(`/api/templates/instances/${projInst.instanceId}/undo`, {}) as { ok: boolean; deletedProjectId: string };
ok(undoProj.ok && undoProj.deletedProjectId === projInst.projectId, '项目实例撤销删除项目', undoProj);
const projectsAfter = await json<Array<{ id: string }>>('/api/projects');
ok(!projectsAfter.some((p) => p.id === projInst.projectId), '撤销后项目已不存在');

// 项目被继续编辑：整体撤销必须拒绝，避免误删后续任务
const guardInst = await post(`/api/templates/${customProject.id}/instantiate`, { name: `T06305 守卫项目 ${Date.now()}` }) as InstanceResult;
await post('/api/tasks', { projectId: guardInst.projectId, title: 'T06305 后续手工任务' });
const guardBody = await expectStatus(`/api/templates/instances/${guardInst.instanceId}/undo`, { method: 'POST' }, 409);
ok(guardBody.includes('已被继续编辑'), '项目新增任务后拒绝整体撤销', guardBody.slice(0, 180));

console.log(JSON.stringify({ pass: true, checks, projectId: project.id, customTaskTemplate: custom.id, customProjectTemplate: customProject.id }));
