#!/usr/bin/env node
/**
 * T01298 验证脚本：队列菜单删除能力
 * 1) 移除单个任务项（DELETE /queues/:id/jobs/:jobId）——成功后队列剩余数正确；
 * 2) sending（在途）项移除被拒（400）；
 * 3) 删除整个队列（DELETE /queues/:id）——队列消失、queue_jobs 级联清空；
 * 4) running 状态的队列删除被拒（400）。
 * 隔离环境：临时数据目录 + 独立端口，起 src/index.ts（tsx）。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 39912;
const BASE = `http://127.0.0.1:${PORT}/api`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mtask-qdel-'));
const REPO = path.resolve(__dirname, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra) {
  const flag = cond ? 'PASS' : 'FAIL';
  if (!cond) failures += 1;
  console.log(`  [${flag}] ${name}${extra ? ' → ' + extra : ''}`);
}

async function waitHealth(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return true; } catch (_) { /* 未就绪 */ }
    await sleep(500);
  }
  return false;
}
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });

(async () => {
  console.log(`[setup] 临时数据目录: ${TMP}`);
  const server = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsx', 'src/index.ts'],
    { cwd: path.join(REPO, 'server'), env: { ...process.env, MTask_DATA_DIR: TMP, MTask_PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const logs = [];
  server.stdout.on('data', (d) => logs.push(String(d)));
  server.stderr.on('data', (d) => logs.push(String(d)));

  try {
    if (!(await waitHealth())) throw new Error('服务启动超时：\n' + logs.join(''));

    // 准备：项目 + 任务 + AI 工具
    const mk = async (path, data) => j(await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }));
    const proj = await mk('/projects', { name: '队列删除验证' });
    const task = await mk('/tasks', { projectId: proj.body.id, title: '验证：队列删除' });
    const tool = await mk('/aitools', { name: '验证工具', type: 'workbuddy', endpoint: 'http://127.0.0.1:9' });
    console.log(`[setup] project=${proj.status} task=${task.status} tool=${tool.status}`);
    if (proj.status !== 201 || task.status >= 300 || tool.status >= 300) {
      console.error('setup 响应：', JSON.stringify({ proj, task, tool }, null, 2).slice(0, 2000));
      throw new Error('setup 失败');
    }
    const queue = await mk('/queues', { name: '验证队列', date: '2026-09-28' });
    const jobs = await mk(`/queues/${queue.body.id}/jobs`, { items: [{ taskId: task.body.id, toolId: tool.body.id }, { taskId: task.body.id, toolId: tool.body.id }] });
    console.log(`[setup] queue=${queue.status} jobs=${jobs.status}`);
    if (jobs.status !== 201) { console.error('jobs 响应：', JSON.stringify(jobs, null, 2).slice(0, 2000)); throw new Error('加任务项失败'); }
    const queueId = queue.body.id;
    console.log(`[setup] 队列 ${queueId} 含 ${jobs.body.length} 个任务项`);
    const qd = (p) => `${BASE}/queues/${queueId}${p}`;
    const jd = (i) => `${BASE}/queues/${queueId}/jobs/${jobs.body[i].id}`;

    console.log('\n[场景1] 移除单个任务项');
    let r = await j(await fetch(jd(0), { method: 'DELETE' }));
    check('DELETE 单个任务项返回 204', r.status === 204);
    const q1 = (await j(await fetch(qd('')))).body;
    check('移除后队列剩余 1 个任务项', (q1.jobs ?? []).length === 1, `剩余 ${(q1.jobs ?? []).length}`);

    console.log('\n[场景2] sending（在途）项移除被拒');
    const Database = require(path.join(REPO, 'node_modules', 'better-sqlite3'));
    const dbFile = path.join(TMP, 'mtask.db');
    const sqlite = new Database(dbFile);
    sqlite.prepare("UPDATE queue_jobs SET status = 'sending' WHERE id = ?").run(jobs.body[1].id);
    r = await j(await fetch(jd(1), { method: 'DELETE' }));
    check('sending 项移除返回 400', r.status === 400, `status=${r.status} error=${r.body?.error ?? ''}`);
    check('错误信息为「任务正在发送中，不可移除」', (r.body?.error ?? '').includes('不可移除'));
    sqlite.prepare("UPDATE queue_jobs SET status = 'queued' WHERE id = ?").run(jobs.body[1].id);

    console.log('\n[场景3] 删除整个队列（级联清理任务项）');
    r = await j(await fetch(qd(''), { method: 'DELETE' }));
    check('DELETE 队列返回 204', r.status === 204);
    const gone = await j(await fetch(qd('')));
    check('删除后 GET 队列返回 404', gone.status === 404, `status=${gone.status}`);
    const left = sqlite.prepare('SELECT COUNT(*) AS n FROM queue_jobs WHERE queue_id = ?').get(queueId).n;
    check('queue_jobs 随级联清空', left === 0, `剩余 ${left}`);

    console.log('\n[场景4] running 队列删除被拒');
    const q2 = (await j(await fetch(`${BASE}/queues`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '运行中队列', date: '2026-09-28' }) }))).body;
    sqlite.prepare("UPDATE queues SET status = 'running' WHERE id = ?").run(q2.id);
    r = await j(await fetch(`${BASE}/queues/${q2.id}`, { method: 'DELETE' }));
    check('running 队列删除返回 400', r.status === 400, `status=${r.status} error=${r.body?.error ?? ''}`);
    check('错误信息为「队列正在发送中，不可删除」', (r.body?.error ?? '').includes('不可删除'));
    sqlite.close();

    console.log(failures === 0 ? '\nALL PASS' : `\nHAS FAILURE (${failures})`);
    process.exitCode = failures === 0 ? 0 : 1;
  } catch (e) {
    console.error('验证异常：', e);
    console.error('服务日志：\n' + logs.join(''));
    process.exitCode = 1;
  } finally {
    // Windows 下 SIGTERM 杀不掉 npx.cmd 的子进程树，孤儿 server 会占住 stdio 管道导致本脚本永不退出
    if (process.platform === 'win32' && server.pid) {
      spawn('taskkill', ['/F', '/T', '/PID', String(server.pid)], { stdio: 'ignore' });
    } else {
      server.kill('SIGTERM');
    }
  }
})();
