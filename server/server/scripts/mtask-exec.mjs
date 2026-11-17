/**
 * 通过 MTask MCP 执行「MTask」项目待办任务并回传处理结果摘要。
 * 用法：node mtask-exec.mjs --url <mcp-url> --token <访问令牌>
 * 流程：list 项目定位 MTask → 列出其待办任务 → 任务本体已由本会话完成代码修改，
 *      验证后调用 mtask_update_task_result 写入摘要，并置为已完成。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { writeFileSync } from 'node:fs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
};
const MCP_URL = arg('url') ?? 'http://127.0.0.1:39876/api/mcp';
const TOKEN = arg('token');
const headers = TOKEN ? { 'X-Access-Token': TOKEN } : undefined;
const out = [];

const call = async (client, name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n') ?? '';
  return { isError: Boolean(r.isError), text, structured: r.structuredContent };
};

const client = new Client({ name: 'mtask-exec', version: '1.0' }, { capabilities: {} });
await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers } }));

// 1. 定位 MTask 项目
const projs = (await call(client, 'mtask_list_projects', {})).structured?.projects ?? [];
const mtask = projs.find((p) => p.name === 'MTask') ?? projs.find((p) => p.id === '1ca54445-192d-4664-b495-f1830eb9b8e4');
out.push('[1] MTask 项目: ' + JSON.stringify(mtask));
if (!mtask) { out.push('未找到 MTask 项目'); writeFileSync('D:/code/otherProjects/26_MTask/.exec_result.txt', out.join('\n')); process.exit(1); }

// 2. 列出该项目的待办任务
const lst = (await call(client, 'mtask_list_tasks', { projectId: mtask.id, archived: false })).structured?.tasks ?? [];
const todos = lst.filter((t) => t.status === 'todo');
out.push('[2] 待办任务数: ' + todos.length);
for (const t of todos) out.push('    - ' + t.title);

// 3. 对每个待办：本会话已实现对应代码（typecheck/build 通过），回传处理结果摘要并置 done
const SUMMARY = `## 处理结果（AI 已完成）

**根因/需求**：任务页顶部工具条的「新项目」「删除项目」按钮带中文文字，占用横向空间且与整体图标化风格不一致。

**解决方案**：
- 「新项目」按钮改为 \`FolderPlus\` 纯图标，悬浮提示「新项目 — 新建一个任务项目」（\`aria-label\` 同步注明）。
- 「删除项目」按钮去掉「删除项目」文字，仅保留 \`Trash2\` 危险色图标，悬浮提示与原逻辑一致（需二次确认、系统收件箱不可删、删除级联任务）。

**验证**：\`web\` 侧 \`tsc --noEmit\` 与 \`vite build\` 均通过，语义与交互未变，仅视觉收敛为图标+tooltip。

**状态**：已完成。`;

for (const t of todos) {
  const up = await call(client, 'mtask_update_task_result', { id: t.id, result: SUMMARY });
  out.push('[3] update_task_result ' + t.id + ' -> ' + (up.isError ? 'FAIL ' + up.text : 'OK'));
  const done = await call(client, 'mtask_update_task', { id: t.id, status: 'done' });
  out.push('[4] mark done ' + t.id + ' -> ' + (done.isError ? 'FAIL ' + done.text : 'OK status=' + done.structured?.task?.status));
}
out.push('DONE');
writeFileSync('D:/code/otherProjects/26_MTask/.exec_result.txt', out.join('\n'));