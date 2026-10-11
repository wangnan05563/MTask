// T02070 回归断言：tasks.status 恒为 todo|done 二元（口径裁决 + 写入口守卫）。
// 用法：<node22runtime> scripts/verify-t02070-status-binary.mjs
//   前提：better-sqlite3 与运行 node ABI 匹配（本机 ABI127 runtime 可用；Node24 会 ERR_DLOPEN_FAILED）
//   走隔离实例：MTask_PORT + MTask_DATA_DIR=临时目录，绝不碰用户生产库
//
// 口径（工单第 1 条裁决）：待办**不做**第三态。中间态由 progress（0~100）承载、「AI 在途」由
// ai_state（running/unread/failed）承载；消费侧（待办/已完成页签、AI 待处理与监控队列 SQL、
// 抽屉与移动端 STATUS_LABEL）全按二元二分，写进 doing 不会报错，而是让任务从两个页签同时消失
// 并永久脱离队列——所以本脚本断言的是「第三值进不了库」，而不是「第三值能被看见」。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 39700 + (process.pid % 40);
const API = `http://127.0.0.1:${PORT}/api`;
const DIR = mkdtempSync(join(tmpdir(), 't02070-status-'));

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name} :: ${detail}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (path, body) => {
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const patch = async (path, body) => {
  const res = await fetch(`${API}${path}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const get = async (path) => (await fetch(`${API}${path}`)).json().catch(() => null);

let server;
try {
  const occupied = await fetch(`${API}/health`).then(() => true).catch(() => false);
  check('S00 目标端口启动前未被占用', occupied === false, API);
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
  check('S0 隔离实例已就绪', up, `${DIR}`);
  if (!up) throw new Error('服务未启动');

  const pj = await post('/projects', { name: 'T02070 待办状态二元守卫' });
  const pid = pj.body?.data?.id ?? pj.body?.id;
  check('S1 测试项目已建', !!pid, String(pid));

  // ---- 建单口：第三值拒收且不落库 ----
  const badCreate = await post('/tasks', { projectId: pid, title: 'W-建单-doing', status: 'doing' });
  check('W-01 POST /tasks status=doing → 400', badCreate.status === 400, `status=${badCreate.status} body=${JSON.stringify(badCreate.body?.error ?? badCreate.body)}`);
  const ghost = await get(`/tasks?projectId=${pid}&limit=500`);
  check('W-02 被拒的行未落库（活跃列表无「W-建单-doing」）', !ghost.some((t) => t.title === 'W-建单-doing'), `活跃行数=${ghost.length}`);

  const blockedCreate = await post('/tasks', { projectId: pid, title: 'W-建单-blocked', status: 'blocked' });
  const numCreate = await post('/tasks', { projectId: pid, title: 'W-建单-空串', status: '' });
  check('W-03 POST 同样拒收 blocked / 空串', blockedCreate.status === 400 && numCreate.status === 400, `blocked=${blockedCreate.status} 空串=${numCreate.status}`);

  // ---- 正常路径不被误伤 ----
  const t1 = await post('/tasks', { projectId: pid, title: 'W-正常待办' });
  const t1id = t1.body?.data?.id ?? t1.body?.id;
  check('W-04 不传 status 仍默认 todo', t1.status === 201 && (t1.body?.data ?? t1.body)?.status === 'todo', `status=${(t1.body?.data ?? t1.body)?.status}`);
  const okCreate = await post('/tasks', { projectId: pid, title: 'W-显式-done', status: 'done' });
  check('W-05 显式 status=done 正常放行', okCreate.status === 201 && (okCreate.body?.data ?? okCreate.body)?.status === 'done', `status=${(okCreate.body?.data ?? okCreate.body)?.status}`);

  const badPatch = await patch(`/tasks/${t1id}`, { status: 'doing' });
  check('W-06 PATCH status=doing → 400', badPatch.status === 400, `status=${badPatch.status}`);
  const afterBad = (await get(`/tasks?projectId=${pid}&limit=500`)).find((t) => t.id === t1id);
  check('W-07 拒写后原状态不变（仍 todo，未变成不可见行）', afterBad?.status === 'todo', `status=${afterBad?.status}`);

  const okPatch = await patch(`/tasks/${t1id}`, { status: 'done' });
  check('W-08 PATCH status=done 正常生效', okPatch.status === 200 && (okPatch.body?.data ?? okPatch.body)?.status === 'done', `status=${(okPatch.body?.data ?? okPatch.body)?.status}`);
  const noStatusPatch = await patch(`/tasks/${t1id}`, { title: 'W-正常待办-改名' });
  check('W-09 不带 status 的 PATCH 不受守卫影响（状态保持 done）', noStatusPatch.status === 200 && (noStatusPatch.body?.data ?? noStatusPatch.body)?.status === 'done', `status=${(noStatusPatch.body?.data ?? noStatusPatch.body)?.status}`);

  // ---- 队列消费面：二元口径下待办仍可被 AI 领取 ----
  const t2 = await post('/tasks', { projectId: pid, title: 'W-队列可领取' });
  const t2id = t2.body?.data?.id ?? t2.body?.id;
  const pending = await get(`/tasks?projectId=${pid}&status=todo&limit=500`);
  check('W-10 新建待办仍在 status=todo 队列侧（AI 待处理可见）', pending.some((t) => t.id === t2id), `todo 行数=${pending.length}`);

  // ---- 存量库整体不变量：活跃 + 归档都不存在第三种状态 ----
  const arch = await get(`/tasks?projectId=${pid}&archived=1&limit=500`);
  const stray = [...ghost, ...arch, ...pending].filter((t) => !['todo', 'done'].includes(t.status));
  check('W-11 本库无第三态游离行（两个页签都不会漏行）', stray.length === 0, `游离=${stray.map((s) => `${s.title}:${s.status}`).join(',') || '无'}`);

  // ---- 既有边界保持既有口径：批量口 / CSV 口本来就拒绝第三值 ----
  const batchBad = await post('/tasks/batch', { ids: [t1id], action: 'status', value: 'doing' });
  check('W-12 批量改状态口仍拒第三值（既有校验未被绕过）', batchBad.status === 400, `status=${batchBad.status} body=${JSON.stringify(batchBad.body)}`);

  console.log(`\nverify-t02070: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) process.exitCode = 1;
} catch (e) {
  console.error('ABORT', e);
  process.exitCode = 2;
} finally {
  // 隔离实例要先退出再删目录：better-sqlite3 仍持有 mtask.db 句柄时 rmSync 会 EBUSY
  if (server) {
    server.kill();
    await new Promise((r) => { server.on('exit', r); setTimeout(r, 5000); });
  }
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* 收尾失败不影响断言结论 */ }
}
