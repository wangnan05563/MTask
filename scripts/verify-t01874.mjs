// T01874：计划「彻底删除」的破坏面回传 + 派生孤儿待办连带归档断言。
// 用法：<node22runtime> scripts/verify-t01874.mjs
//   前提：better-sqlite3 与运行 node ABI 匹配（本机 ABI127 runtime 可用；Node24 会 ERR_DLOPEN_FAILED）
//   走隔离实例：MTask_PORT + MTask_DATA_DIR=临时目录，绝不碰用户生产库
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 39600 + (process.pid % 40);
const BASE = `http://127.0.0.1:${PORT}`;
const API = `${BASE}/api`;
const DIR = mkdtempSync(join(tmpdir(), 't01874-purge-'));

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name} :: ${detail}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jget = async (path) => (await fetch(`${API}${path}`)).json();
const post = async (path, body) => {
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const del = async (path) => {
  const res = await fetch(`${API}${path}`, { method: 'DELETE' });
  return { status: res.status, body: await res.json().catch(() => null) };
};

let server;
try {
  const occupied = await fetch(`${API}/health`).then(() => true).catch(() => false);
  check('S00 目标端口启动前未被占用（断言不会误连其他实例）', occupied === false, BASE);
  if (occupied) throw new Error('端口已被占用，终止以免对错误实例取证');
  server = spawn(
    process.execPath,
    [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'],
    { cwd: join(ROOT, 'server'), env: { ...process.env, MTask_DATA_DIR: DIR, MTask_PORT: String(PORT), MTask_LOG_DIR: DIR }, stdio: 'ignore' },
  );
  let up = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${API}/health`)).ok) { up = true; break; } } catch { /* 未就绪 */ }
    await sleep(300);
  }
  check('S0 隔离实例已就绪', up, `${DIR} / ${BASE}`);
  if (!up) throw new Error('服务未启动');

  const pj = await post('/projects', { name: 'T01874 删除计划归档断言' });
  const pid = pj.body?.data?.id ?? pj.body?.id;
  check('S1 测试项目已建', !!pid, String(pid));

  const planByTitle = async (title) => (await jget(`/plans?projectId=${pid}`)).find((p) => p.title === title);
  const taskByTitle = async (title, archived = false) =>
    (await jget(`/tasks?projectId=${pid}&archived=${archived ? 1 : 0}&limit=500`)).find((t) => t.title === title);
  const reqByTitle = async (title) => (await jget(`/plans/prd-requirements?projectId=${pid}`)).find((r) => r.title === title);

  // ---------- A1/A8/A9：复现报单场景——PRD 导入的计划删除后派生待办成孤儿 ----------
  const imp = await post('/plans/import-prd', {
    projectId: pid,
    requirements: [{ reqNo: 'REQ-01', title: '需求甲' }],
    plans: [{ title: '计划Z', reqNos: ['REQ-01'] }],
    createTasks: true,
  });
  check('A1a PRD 导入建出计划+派生待办', imp.status === 200 && imp.body?.plans === 1 && imp.body?.tasks === 1, JSON.stringify(imp.body));

  const planZ = await planByTitle('计划Z');
  const todoZ = await taskByTitle('[PRD] 计划Z');
  check('A1b 派生待办存在且带需求关联', !!planZ && !!todoZ && todoZ.archived === false, `plan=${planZ?.id} todo=${todoZ?.id}`);

  const reqBefore = await reqByTitle('需求甲');
  check('A1c 删除前矩阵两侧关联各 1 条', reqBefore?.linkedPlans?.length === 1 && reqBefore?.linkedTasks?.length === 1,
    `plans=${reqBefore?.linkedPlans?.length} tasks=${reqBefore?.linkedTasks?.length}`);

  await post(`/plans/${planZ.id}/archive`);
  const impact = await jget(`/plans/${planZ.id}/purge-impact`);
  check('A2 purge-impact 预览连带条数（只读预览，与删除结果同源）',
    impact?.strippedTasksArchived === 1 && impact?.strippedReqLinks === 1, JSON.stringify(impact));
  check('A2b 预览后不落库（计划仍在归档区、待办仍未归档）',
    !!(await jget('/plans/archived')).find((p) => p.id === planZ.id) && !!(await taskByTitle('[PRD] 计划Z')), '');

  const delRes = await del(`/plans/${planZ.id}`);
  check('A3 DELETE 回传破坏面对象（原实现只回 true）',
    delRes.status === 200 && delRes.body?.deleted === true && delRes.body?.strippedTasksArchived === 1 && delRes.body?.strippedReqLinks === 1,
    JSON.stringify(delRes.body));

  const todoZArchived = await taskByTitle('[PRD] 计划Z', true);
  check('A4 派生孤儿待办已连带归档（不再是无源孤儿）', !!todoZArchived && !!todoZArchived.archived_at, `archived_at=${todoZArchived?.archived_at}`);
  check('A5 未活跃列表不再出现该待办/该计划',
    !(await taskByTitle('[PRD] 计划Z')) && !(await planByTitle('计划Z')), '');
  check('A6 数据不删：物理删的是计划行，待办行保留可还原', !!todoZArchived && todoZArchived.title === '[PRD] 计划Z', `id=${todoZArchived?.id}`);

  await post('/archive/restore', { taskIds: [todoZArchived.id] });
  const reqAfterRestore = await reqByTitle('需求甲');
  check('A7 还原待办后需求关联原样回来（req_ids 未被破坏）',
    !!(await taskByTitle('[PRD] 计划Z')) && reqAfterRestore?.linkedTasks?.length === 1,
    `linkedTasks=${reqAfterRestore?.linkedTasks?.length}`);

  // ---------- A8：仍有其它来源的待办一律不动（不误伤） ----------
  const manual = await post('/tasks', { projectId: pid, title: '手工待办（仅关联计划）', description: '' });
  const manualId = manual.body?.data?.id ?? manual.body?.id;
  const planM = await post('/plans', { projectId: pid, title: '计划M', durationDays: 2 });
  const planMid = planM.body?.data?.id ?? planM.body?.id;
  await post(`/plans/${planMid}/link`, { taskId: manualId });
  const impactM = await jget(`/plans/${planMid}/purge-impact`);
  await post(`/plans/${planMid}/archive`);
  const delM = await del(`/plans/${planMid}`);
  check('A8 手工待办仅“关联”该计划 → 不计入连带、不被归档',
    impactM?.strippedTasksArchived === 0 && delM.body?.strippedTasksArchived === 0 && !!(await taskByTitle('手工待办（仅关联计划）')),
    JSON.stringify({ impactM, del: delM.body }));

  // ---------- A9：待办同时被另一未归档计划指向 → 不动；另一计划也删后才归档 ----------
  const planC = await post('/plans', { projectId: pid, title: '计划C', durationDays: 2 });
  const planCid = planC.body?.data?.id ?? planC.body?.id;
  await post(`/plans/${planCid}/create-todo`);
  const todoC = await taskByTitle('[计划] 计划C');
  const planD = await post('/plans', { projectId: pid, title: '计划D', durationDays: 2 });
  const planDid = planD.body?.data?.id ?? planD.body?.id;
  await post(`/plans/${planDid}/link`, { taskId: todoC.id });
  await post(`/plans/${planDid}/archive`);
  const delD = await del(`/plans/${planDid}`);
  check('A9a 派生待办仍被未归档计划 C 指向 → 删 D 不归档它',
    delD.body?.strippedTasksArchived === 0 && !!(await taskByTitle('[计划] 计划C')), JSON.stringify(delD.body));
  await post(`/plans/${planCid}/archive`);
  const delC = await del(`/plans/${planCid}`);
  check('A9b 最后一个来源计划也删除 → 归档派生待办',
    delC.body?.strippedTasksArchived === 1 && !!(await taskByTitle('[计划] 计划C', true)), JSON.stringify(delC.body));

  // ---------- A10：待办是别的任务子任务（parent_id）→ 另有来源，不动 ----------
  const parent = await post('/tasks', { projectId: pid, title: '父待办', description: '' });
  const parentId = parent.body?.data?.id ?? parent.body?.id;
  const planE = await post('/plans', { projectId: pid, title: '计划E', durationDays: 2 });
  const planEid = planE.body?.data?.id ?? planE.body?.id;
  await post(`/plans/${planEid}/create-todo`);
  const todoE = await taskByTitle('[计划] 计划E');
  await fetch(`${API}/tasks/${todoE.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parentId }) });
  await post(`/plans/${planEid}/archive`);
  const delE = await del(`/plans/${planEid}`);
  check('A10 派生待办挂在别的任务下 → 不归档（避免父进度被连带改动）',
    delE.body?.strippedTasksArchived === 0 && !!(await taskByTitle('[计划] 计划E')), JSON.stringify(delE.body));

  // ---------- A11/A12：口径边界不变 ----------
  const planF = await post('/plans', { projectId: pid, title: '计划F', durationDays: 2 });
  const planFid = planF.body?.data?.id ?? planF.body?.id;
  const delActive = await del(`/plans/${planFid}`);
  check('A11 未归档计划仍不可彻底删除（口径不变：deleted:false）',
    delActive.body?.deleted === false && delActive.body?.strippedTasksArchived === 0 && !!(await planByTitle('计划F')),
    JSON.stringify(delActive.body));
  const ghost = await jget(`/plans/no-such-plan-id/purge-impact`);
  check('A12 不存在的计划：预览回 0 条而非报错', ghost?.strippedTasksArchived === 0 && ghost?.strippedReqLinks === 0, JSON.stringify(ghost));

  const others = (await jget('/projects')).filter((p) => !String(p.id).startsWith('sys-') && p.id !== pid);
  check('S99 隔离库内无其它业务项目（断言未污染）', others.length === 0, JSON.stringify(others.map((p) => p.name)));
} finally {
  if (server) {
    server.kill();
    await sleep(1500);
  }
  const stillUp = await fetch(`${API}/health`).then(() => true).catch(() => false);
  check('Z1 隔离实例已退出（不留进程占用端口/锁库文件）', stillUp === false, BASE);
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* Windows 句柄未释放时忽略 */ }
}
console.log(`\n合计 PASS=${pass} FAIL=${fail}`);
