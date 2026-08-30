/**
 * API 冒烟测试：验证骨架核心链路。
 * 用法：先启动 server，再 node scripts/smoke.mjs（或 node smoke.mjs）
 * 覆盖：健康检查 → 项目 CRUD → 任务创建/完成/归档 → AI 工具配置(加密脱敏) → 队列构建与发送(占位适配器) → 归档删除
 */
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:39876/api';
let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

async function main() {
  console.log('== MTask API 冒烟测试 ==\n');

  // 1. 健康检查
  const health = await call('GET', '/health');
  check('健康检查', health.status === 200 && health.data?.ok === true, JSON.stringify(health.data));

  // 2. 项目 CRUD
  const proj = await call('POST', '/projects', { name: '冒烟测试项目', description: 'auto' });
  check('创建项目', proj.status === 201 && proj.data?.id, JSON.stringify(proj.data));
  const projectId = proj.data?.id;
  const projects = await call('GET', '/projects');
  check('项目列表含新项目', projects.data?.some((p) => p.id === projectId));

  // 3. 任务创建 → 完成 → 归档
  const task = await call('POST', '/tasks', { projectId, title: '实现登录页', priority: 'high' });
  check('创建任务', task.status === 201 && task.data?.status === 'todo', JSON.stringify(task.data));
  const taskId = task.data?.id;
  const done = await call('PATCH', `/tasks/${taskId}`, { status: 'done' });
  check('标记完成', done.data?.status === 'done');
  const arch = await call('POST', '/archive', { taskIds: [taskId] });
  check('归档任务', arch.data?.[0]?.archived === true);
  const archList = await call('GET', '/tasks?archived=1');
  check('归档列表含该任务', archList.data?.some((t) => t.id === taskId));
  const restore = await call('POST', '/archive/restore', { taskIds: [taskId] });
  check('还原任务', restore.data?.[0]?.archived === false);
  await call('POST', '/archive', { taskIds: [taskId] });
  const del = await call('DELETE', '/archive', { taskIds: [taskId] });
  check('删除归档任务', del.data?.removed === 1, JSON.stringify(del.data));

  // 4. AI 工具配置：密钥加密 + 脱敏
  const tool = await call('POST', '/aitools', {
    name: 'DeepSeek 测试', type: 'openai-compatible', purpose: 'develop',
    endpoint: 'https://api.deepseek.com', apiKey: 'sk-test-1234567890', model: 'deepseek-chat',
  });
  check('创建 AI 工具', tool.status === 201 && tool.data?.id, JSON.stringify(tool.data));
  const toolId = tool.data?.id;
  check('密钥脱敏(无明文)', !String(tool.data?.apiKeyMasked).includes('sk-test'));
  check('密钥脱敏(有掩码)', typeof tool.data?.apiKeyMasked === 'string' && tool.data.apiKeyMasked.includes('****'));
  const types = await call('GET', '/aitools/types');
  check('适配器类型列表', Array.isArray(types.data) && types.data.includes('openai-compatible'));

  // 4.1 FR3.4 默认工具绑定
  const setDef = await call('POST', `/aitools/${toolId}/set-default`, { kind: 'organize' });
  check('设为默认整理工具', setDef.data?.organize === toolId, JSON.stringify(setDef.data));
  const defaults = await call('GET', '/aitools/defaults');
  check('查询默认工具', defaults.data?.organize === toolId);

  // 5. 队列构建 + 发送（占位适配器，返回文本回执）
  const q = await call('POST', '/queues', { name: '2026-08-19 冒烟队列', date: '2026-08-19' });
  check('创建队列', q.status === 201 && q.data?.status === 'draft');
  const queueId = q.data?.id;
  const task2 = await call('POST', '/tasks', { projectId, title: '队列任务', priority: 'normal' });
  const jobs = await call('POST', `/queues/${queueId}/jobs`, { items: [{ taskId: task2.data.id, toolId }] });
  check('加入队列作业', jobs.status === 201 && Array.isArray(jobs.data) && jobs.data.length === 1);
  const sent = await call('POST', `/queues/${queueId}/send`);
  check('队列发送完成', sent.data?.every?.((j) => j.status === 'success'), JSON.stringify(sent.data));
  check('回执为文本(待人工合并)', typeof sent.data?.[0]?.response_payload === 'string' && sent.data[0].response_payload.includes('占位结果'));
  const queueDetail = await call('GET', `/queues/${queueId}`);
  check('队列含 request 快照', queueDetail.data?.jobs?.[0]?.request_payload?.includes('队列任务'));

  // 5.1 采纳：审阅回执文本 → 保存到任务并置 done（仅保存文本，待人工合并）
  const adopt = await call('POST', `/tasks/${task2.data.id}/adopt`, { content: sent.data[0].response_payload });
  check('采纳后任务置为 done', adopt.data?.status === 'done');
  check('采纳后 ai_summary 保存文本', adopt.data?.ai_summary?.includes('占位结果'));

  // 6. 清理测试数据
  await call('DELETE', `/projects/${projectId}`);
  await call('DELETE', `/aitools/${toolId}`);
  const finalProjects = await call('GET', '/projects');
  check('清理完成', !finalProjects.data?.some((p) => p.id === projectId));

  console.log(`\n== 结果：通过 ${pass} / 失败 ${fail} ==`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('冒烟测试异常:', e); process.exit(1); });
