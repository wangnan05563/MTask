/**
 * T06244~T06282（十期）派发入口与自动触发验收入口。
 *
 * 这条验收腿只跑隔离临时库，不碰真实 MTask 数据：
 * - 策略默认值/校验/endpoint 安全边界；
 * - 候选查询的项目范围、任务闸门、平台偏好、冷却与自动闸门；
 * - A 就绪池、D 人工应急、B0 失败降级；
 * - 临时 CodeBuddy 网关下的 B0 受理、dispatch_attempts 审计、queue kind=dispatch、幂等；
 * - 审计清理。
 *
 * 运行：npm run verify:t06244
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TMP = `D:/tmp/t06244-${process.pid}`;
const DATA_DIR = join(TMP, 'data');
process.env.MTask_DATA_DIR = DATA_DIR;

let pass = 0;
let fail = 0;
const lines: string[] = [];
let gateway: ReturnType<typeof createServer> | null = null;
let closeDb: (() => void) | null = null;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 3000)}`}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  const schema = await import('../../server/src/db/schema.ts');
  schema.initSchema();
  const conn = await import('../../server/src/db/connection.ts');
  const db = conn.getDb();
  closeDb = () => conn.closeDb();
  const { setSetting } = await import('../../server/src/services/AppSettings.ts');
  const { TaskService } = await import('../../server/src/services/TaskService.ts');
  const policy = await import('../../server/src/services/DispatchPolicy.ts');
  const { DispatchScheduler } = await import('../../server/src/services/DispatchScheduler.ts');
  const { PushDispatcher } = await import('../../server/src/services/PushDispatcher.ts');
  const { QueueService } = await import('../../server/src/services/QueueService.ts');
  const { AIService } = await import('../../server/src/services/AIService.ts');
  const attempts = await import('../../server/src/services/DispatchAttempts.ts');

  const now = new Date().toISOString();
  const projectId = 'p10-test-project';
  db.prepare(`INSERT OR IGNORE INTO projects (id, name, description, created_at, updated_at) VALUES (?, '十期派发测试', '', ?, ?)`).run(projectId, now, now);

  let runSeq = 0;
  const submits: Array<{ id: string; payload: string }> = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/api/v1/health') return json(res, { status: 'ok' });
    if (req.method === 'GET' && url.pathname === '/api/v1/auth/status') return json(res, { authEnabled: false });
    // 异常注入腿：同一条假网关按 endpoint 前缀模拟 401 / 404 / SSE 断流
    if (req.method === 'POST' && url.pathname === '/authfail/api/v1/runs') return json(res, { error: { code: 'AUTH', message: 'unauthorized' } }, 401);
    if (req.method === 'POST' && url.pathname === '/notfound/api/v1/runs') return json(res, { error: { code: 'NOT_FOUND', message: 'not found' } }, 404);
    if (req.method === 'POST' && url.pathname === '/sseless/api/v1/runs') return json(res, { data: { runId: 'sseless-run' } });
    if (req.method === 'GET' && url.pathname.startsWith('/sseless/api/v1/runs/')) return json(res, { error: { code: 'NOT_FOUND', message: 'stream gone' } }, 404);
    if (req.method === 'POST' && url.pathname === '/api/v1/runs') {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}') as { id?: string };
      const runId = `run-${++runSeq}`;
      submits.push({ id: body.id ?? '', payload: raw });
      return json(res, { data: { runId } });
    }
    const stream = /^\/api\/v1\/runs\/([^/]+)\/stream$/.exec(url.pathname);
    if (req.method === 'GET' && stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('event: accepted\ndata: {"status":"accepted"}\n\n');
      res.write('event: message\ndata: {"status":"completed","content":{"markdown":"fake gateway ok"}}\n\n');
      res.write('event: done\ndata: {}\n\n');
      return res.end();
    }
    return json(res, { error: { code: 'NOT_FOUND', message: 'fake gateway 未实现该路径' } }, 404);
  });
  gateway = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const gatewayEndpoint = `http://127.0.0.1:${port}`;

  const toolId = 'p10-b0';
  db.prepare(`INSERT INTO ai_tools (id, name, type, purpose, endpoint, model, timeout_ms, enabled, created_at, updated_at)
    VALUES (?, '十期假 B0', 'codebuddy-gateway', 'develop', ?, 'codebuddy', 3000, 1, ?, ?)`)
    .run(toolId, gatewayEndpoint, now, now);
  const { cacheClear } = await import('../../server/src/util/ttl-cache.ts');
  cacheClear('aitools');

  const mkTask = (id: string, patch: Partial<Record<'monitor_ready' | 'dispatch_auto' | 'monitor_preferred_platform' | 'dispatch_last_at' | 'ai_state' | 'shelved' | 'archived', string | number | null>> = {}) => {
    db.prepare(`INSERT INTO tasks (id, project_id, title, status, priority, created_at, updated_at, archived, ai_state, monitor_ready, shelved, dispatch_auto, monitor_preferred_platform, dispatch_last_at)
      VALUES (?, ?, ?, 'todo', 'normal', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id, projectId, `任务-${id}`, now, now,
        patch.archived ?? 0,
        patch.ai_state ?? '',
        patch.monitor_ready ?? 0,
        patch.shelved ?? 0,
        patch.dispatch_auto ?? null,
        patch.monitor_preferred_platform ?? null,
        patch.dispatch_last_at ?? null,
      );
    db.prepare('UPDATE tasks SET task_no = ? WHERE id = ?').run(`T${id.toUpperCase()}`, id);
  };

  // ---- 策略默认值与 endpoint 安全 ----
  const defaults = policy.readPolicy();
  ok('默认 autoEnabled=false', defaults.autoEnabled === false, defaults);
  ok('默认冷却 5 分钟', defaults.cooldownMs === 300_000, defaults.cooldownMs);
  ok('默认每轮 5 条', defaults.maxPerTick === 5, defaults.maxPerTick);
  ok('默认 allowAutoD=false', defaults.allowAutoD === false, defaults.allowAutoD);
  ok('默认项目范围为空（不启用）', defaults.scopeProjectIds.length === 0, defaults.scopeProjectIds);
  let httpRemote = '';
  try { policy.assertEndpointAllowed('http://example.com/gateway'); } catch (e) { httpRemote = String(e); }
  ok('远程 HTTP endpoint 被拒', Boolean(httpRemote), httpRemote);
  let userinfo = '';
  try { policy.assertEndpointAllowed('http://user:pass@127.0.0.1:1234'); } catch (e) { userinfo = String(e); }
  ok('URL 内嵌口令被拒', Boolean(userinfo), userinfo);
  let loopback = '';
  try { policy.assertEndpointAllowed('http://127.0.0.1:1234/api/v1'); } catch (e) { loopback = String(e); }
  ok('回环 HTTP 允许', !loopback, loopback);
  ok('endpoint 脱敏去除 query/userinfo', policy.sanitizeEndpoint('http://u:p@127.0.0.1:1234/a?token=x#h') === 'http://127.0.0.1:1234/a', policy.sanitizeEndpoint('http://u:p@127.0.0.1:1234/a?token=x#h'));

  // ---- 候选查询 ----
  mkTask('cand-ready', { monitor_ready: 1 });
  mkTask('cand-off', { monitor_ready: 1, dispatch_auto: 0 });
  mkTask('cand-d', { monitor_ready: 1, monitor_preferred_platform: 'd-gui' });
  mkTask('cand-cool', { monitor_ready: 1, dispatch_last_at: now });
  mkTask('cand-shelved', { monitor_ready: 1, shelved: 1 });
  mkTask('cand-not-ready', { monitor_ready: 0 });
  ok('空范围无候选', DispatchScheduler.candidates({ limit: 20 }).length === 0);
  policy.savePolicy({
    autoEnabled: true, defaultChannel: 'auto', b0ToolId: toolId,
    scopeProjectIds: [projectId], trigger: 'ready', intervalMs: 30000, cooldownMs: 300000,
    maxPerTick: 5, maxAttempts: 3, allowFallbackA: true, retentionDays: 30,
  });
  const staleUpdate = policy.readConfigView().updatedAt;
  policy.savePolicy({ autoEnabled: true }, staleUpdate);
  let conflict = '';
  try {
    policy.savePolicy({ autoEnabled: false }, staleUpdate);
  } catch (e) {
    conflict = e instanceof Error ? e.message : String(e);
  }
  ok('旧版本配置保存被拒绝', conflict.includes('配置已被其他窗口修改'), { conflict, staleUpdate, current: policy.readConfigView().updatedAt });
  const cands = DispatchScheduler.candidates({ limit: 20 });
  const ids = cands.map((c) => c.id);
  ok('范围内就绪任务被选中', ids.includes('cand-ready'), ids);
  ok('dispatch_auto=0 被排除', !ids.includes('cand-off'), ids);
  ok('平台偏好 d-gui 被排除', !ids.includes('cand-d'), ids);
  ok('冷却中的任务被排除', !ids.includes('cand-cool'), ids);
  ok('搁置任务被排除', !ids.includes('cand-shelved'), ids);
  ok('未就绪任务被排除', !ids.includes('cand-not-ready'), ids);

  // ---- 1 万任务候选查询性能（AC-24）----
  db.prepare(`INSERT OR IGNORE INTO projects (id, name, description, created_at, updated_at) VALUES ('p10-perf', '十期性能项目', '', ?, ?)`).run(now, now);
  const insertPerf = db.prepare(`INSERT INTO tasks (id, project_id, title, status, priority, created_at, updated_at, archived, ai_state, monitor_ready, shelved, dispatch_auto, monitor_preferred_platform, dispatch_last_at)
    VALUES (?, 'p10-perf', '性能任务', 'todo', 'normal', ?, ?, 0, '', 1, 0, NULL, NULL, NULL)`);
  db.transaction(() => {
    for (let i = 0; i < 10000; i += 1) insertPerf.run(`perf-${i}`, now, now);
  })();
  policy.savePolicy({
    autoEnabled: true, defaultChannel: 'auto', b0ToolId: toolId,
    scopeProjectIds: [projectId, 'p10-perf'], trigger: 'ready', intervalMs: 30000, cooldownMs: 300000,
    maxPerTick: 5, maxAttempts: 3, allowFallbackA: true, retentionDays: 30,
  });
  const perfT0 = performance.now();
  const perfRows = DispatchScheduler.candidates({ projectId: 'p10-perf', limit: 50 });
  const perfMs = performance.now() - perfT0;
  const taskIndexes = (db.prepare("PRAGMA index_list('tasks')").all() as Array<{ name: string }>).map((r) => r.name);
  ok('1 万任务候选查询 <500ms', perfMs < 500 && perfRows.length > 0, { ms: Math.round(perfMs), rows: perfRows.length });
  ok('候选索引 idx_tasks_dispatch_due 存在', taskIndexes.includes('idx_tasks_dispatch_due'), taskIndexes);

  const dry = await DispatchScheduler.tick({ dryRun: true });
  ok('dry-run 不写审计', Number((db.prepare('SELECT COUNT(*) AS n FROM dispatch_attempts').get() as { n: number }).n) === 0);
  ok('dry-run 返回候选', dry.reason === 'dry_run' && dry.candidateCount >= 1, { reason: dry.reason, candidateCount: dry.candidateCount });

  // ---- A 就绪池 ----
  mkTask('a-only');
  const ar = await PushDispatcher.dispatch('TA-ONLY', 'a', { actor: 'manual' });
  mkTask('manual-latency');
  const manualT0 = performance.now();
  const manualLatency = await PushDispatcher.dispatch('TMANUAL-LATENCY', 'a', { actor: 'manual' });
  const manualMs = performance.now() - manualT0;
  ok('AC-23 手动派发受理 <1s', manualLatency.ok && manualMs < 1000, { ms: Math.round(manualMs), code: manualLatency.code });
  const aRow = db.prepare('SELECT monitor_ready, monitor_preferred_platform, ai_state FROM tasks WHERE id = ?').get('a-only') as { monitor_ready: number; monitor_preferred_platform: string | null; ai_state: string };
  ok('A 通道成功归位就绪池', ar.ok && ar.channel === 'A' && ar.state === 'ready', ar);
  ok('A 通道写 monitor_ready=1 / mcp', aRow.monitor_ready === 1 && aRow.monitor_preferred_platform === 'mcp', aRow);
  const aAttempt = attempts.listAttempts({ taskNo: 'TA-ONLY', limit: 5 })[0];
  ok('A 尝试落审计', aAttempt?.channel === 'A' && aAttempt.state === 'ready', aAttempt);

  // ---- D 只标记人工，不自动执行 ----
  mkTask('d-only');
  const dr = await PushDispatcher.dispatch('TD-ONLY', 'd', { actor: 'manual', allowD: true });
  const dRow = db.prepare('SELECT ai_state, monitor_ready, monitor_preferred_platform, exec_session_id FROM tasks WHERE id = ?').get('d-only') as { ai_state: string; monitor_ready: number; monitor_preferred_platform: string | null; exec_session_id: string | null };
  ok('D 返回待人工确认', dr.state === 'manual' && dr.code === 'D_MANUAL_ONLY' && !dr.ok, dr);
  ok('D 不自动开 GUI/不改任务完成态', dRow.ai_state === 'failed' && dRow.monitor_ready === 0 && dRow.monitor_preferred_platform === 'd-gui' && dRow.exec_session_id === null, dRow);

  // ---- 前置校验异常（EX-06/07/08）----
  mkTask('invalid-archived', { archived: 1 });
  const archived = await PushDispatcher.dispatch('TINVALID-ARCHIVED', 'a', { actor: 'manual' });
  ok('归档任务拒绝派发', archived.code === 'TASK_ARCHIVED', archived);
  mkTask('invalid-done');
  db.prepare("UPDATE tasks SET status='done' WHERE id='invalid-done'").run();
  const doneTask = await PushDispatcher.dispatch('TINVALID-DONE', 'a', { actor: 'manual' });
  ok('已完成任务拒绝派发', doneTask.code === 'TASK_NOT_TODO', doneTask);
  mkTask('invalid-running');
  db.prepare("UPDATE tasks SET ai_state='running' WHERE id='invalid-running'").run();
  const runningTask = await PushDispatcher.dispatch('TINVALID-RUNNING', 'a', { actor: 'manual' });
  ok('running 任务拒绝派发，避免双跑', runningTask.code === 'TASK_RUNNING', runningTask);

  // ---- B0 未配置：auto 手动入口仍能回落 A ----
  setSetting('dispatch.b0ToolId', 'missing-tool');
  mkTask('auto-fallback-a');
  const afr = await PushDispatcher.dispatch('TAUTO-FALLBACK-A', 'auto', { actor: 'manual', allowD: true });
  ok('B0 未配置时 auto 回落 A', afr.channel === 'A' && afr.state === 'ready' && afr.attempts.some((x) => x.code === 'B0_NOT_CONFIGURED'), afr);
  const afAttempts = attempts.listAttempts({ taskNo: 'TAUTO-FALLBACK-A', limit: 10 });
  ok('B0 失败 + A 成功均落审计', afAttempts.filter((x) => x.channel === 'B0' && x.state === 'failed').length >= 1 && afAttempts.some((x) => x.channel === 'A' && x.state === 'ready'), afAttempts.map((x) => `${x.channel}:${x.state}`));

  // ---- 自动链路失败绝不自动 D ----
  mkTask('auto-no-d');
  const noDPolicy = { ...policy.readPolicy(), allowFallbackA: false };
  const andr = await PushDispatcher.dispatchAuto('TAUTO-NO-D', noDPolicy, 'auto-no-d-key');
  const andRow = db.prepare('SELECT ai_state, monitor_preferred_platform FROM tasks WHERE id = ?').get('auto-no-d') as { ai_state: string; monitor_preferred_platform: string | null };
  ok('自动链路失败返回 D_MANUAL_ONLY', andr.code === 'D_MANUAL_ONLY' && !andr.ok, andr);
  ok('自动链路不写 d-gui 人工标记', andRow.ai_state === '' && andRow.monitor_preferred_platform === null, andRow);

  // ---- 自动调度：supervisor 关闭仍运行、maxPerTick 限量、readyMark 关闭 ----
  db.prepare(`INSERT OR IGNORE INTO projects (id, name, description, created_at, updated_at) VALUES ('p10-auto', '十期自动项目', '', ?, ?)`).run(now, now);
  for (let i = 0; i < 7; i += 1) mkTask(`auto-many-${i}`, { monitor_ready: 1 });
  db.prepare("UPDATE tasks SET project_id='p10-auto' WHERE id LIKE 'auto-many-%'").run();
  policy.savePolicy({
    autoEnabled: true, defaultChannel: 'auto', b0ToolId: toolId,
    scopeProjectIds: ['p10-auto'], trigger: 'ready', intervalMs: 30000, cooldownMs: 300000,
    maxPerTick: 5, maxAttempts: 3, allowFallbackA: true, retentionDays: 30,
  });
  setSetting('supervisor.enabled', '0');
  setSetting('supervisor.readyMarkEnabled', '1');
  const tickRun = await DispatchScheduler.tick({ force: true });
  ok('supervisor.enabled=0 时自动调度仍运行', tickRun.ran && tickRun.dispatched === 5 && tickRun.success === 5, tickRun);
  const autoAttempts = attempts.listAttempts({ taskNo: 'TAUTO-MANY-0', limit: 5 });
  ok('自动一轮逐条写 attempt', autoAttempts.length >= 1, autoAttempts.length);
  setSetting('supervisor.readyMarkEnabled', '0');
  const readyOff = await DispatchScheduler.tick({ force: true });
  ok('readyMark 关闭时自动候选为空并提示', readyOff.reason === 'ready_mark_disabled' && readyOff.candidateCount === 0, readyOff);
  setSetting('supervisor.readyMarkEnabled', '1');

  // 已有 sending 内部 job 的任务不能被重启后的调度器重推
  mkTask('sending-guard', { monitor_ready: 1 });
  const guardQueue = QueueService.create('发送中守卫', new Date().toISOString().slice(0, 10), 'dispatch');
  const guardJobs = QueueService.addJobs(guardQueue.id, [{ taskId: 'sending-guard', toolId }]);
  db.prepare("UPDATE queue_jobs SET status='sending' WHERE id=?").run(guardJobs[0].id);
  const guardCandidates = DispatchScheduler.candidates({ projectId: 'p10-auto', limit: 20 });
  ok('sending job 对应任务不被重推', !guardCandidates.some((c) => c.id === 'sending-guard'), guardCandidates.map((c) => c.id));
  ok('默认队列列表只含 manual', !QueueService.list('manual').some((item) => item.id === guardQueue.id), QueueService.list('manual').map((item) => item.kind));
  ok('kind=all 能看到内部 dispatch 队列', QueueService.list('all').some((item) => item.id === guardQueue.id && item.kind === 'dispatch'), QueueService.list('all').map((item) => item.kind));

  // ---- B0 假网关受理 + queue kind=dispatch + 幂等 ----
  policy.savePolicy({
    autoEnabled: true, defaultChannel: 'auto', b0ToolId: toolId,
    scopeProjectIds: [projectId], trigger: 'ready', intervalMs: 30000, cooldownMs: 300000,
    maxPerTick: 5, maxAttempts: 3, allowFallbackA: true, retentionDays: 30,
  });
  setSetting('dispatch.b0ToolId', toolId);
  mkTask('b0-ok');
  const br = await PushDispatcher.dispatch('TB0-OK', 'b0', { actor: 'manual' });
  ok('B0 假网关受理为 running', br.ok && br.channel === 'B0' && br.state === 'running' && Boolean(br.attempts[0]?.ticket), br);
  const b0Queue = br.attempts[0]?.queueId ? QueueService.getById(br.attempts[0].queueId) : null;
  ok('B0 队列 kind=dispatch', b0Queue?.kind === 'dispatch', b0Queue);
  const b0Audit = attempts.listAttempts({ taskNo: 'TB0-OK', limit: 5 })[0];
  ok('B0 审计带 ticket/job/queue', Boolean(b0Audit?.ticket && b0Audit.job_id && b0Audit.queue_id), b0Audit);
  ok('假网关收到任务正文', submits.length >= 1 && submits[submits.length - 1].payload.includes('b0-ok'), submits.length);

  // ---- 异常注入：401 / 404 / 端口不通 / SSE 断流（AC-27/AC-23）----
  const addTool = (id: string, name: string, endpoint: string) => {
    db.prepare(`INSERT INTO ai_tools (id, name, type, purpose, endpoint, model, timeout_ms, enabled, created_at, updated_at)
      VALUES (?, ?, 'codebuddy-gateway', 'develop', ?, 'codebuddy', 3000, 1, ?, ?)`).run(id, name, endpoint, now, now);
    cacheClear('aitools');
  };
  addTool('p10-authfail', '十期 401 网关', `${gatewayEndpoint}/authfail`);
  addTool('p10-notfound', '十期 404 网关', `${gatewayEndpoint}/notfound`);
  addTool('p10-refused', '十期 端口不通', 'http://127.0.0.1:1');
  addTool('p10-sseless', '十期 断流网关', `${gatewayEndpoint}/sseless`);

  const b0Only = async (taskNo: string, tool: string, taskId: string) => {
    mkTask(taskId);
    setSetting('dispatch.b0ToolId', tool);
    cacheClear('aitools');
    return PushDispatcher.dispatch(taskNo, 'b0', { actor: 'manual' });
  };
  const authFail = await b0Only('TB0-AUTHFAIL', 'p10-authfail', 'b0-authfail');
  ok('B0 401 映射 B0_AUTH_FAILED', authFail.code === 'B0_AUTH_FAILED' && authFail.state === 'failed', authFail);
  const notFound = await b0Only('TB0-NOTFOUND', 'p10-notfound', 'b0-notfound');
  ok('B0 404 映射路径错误提示', notFound.code === 'B0_UNREACHABLE' && /404|路径不存在/.test(notFound.detail), notFound);
  const refused = await b0Only('TB0-REFUSED', 'p10-refused', 'b0-refused');
  ok('B0 端口不通映射 B0_UNREACHABLE', refused.code === 'B0_UNREACHABLE' && refused.state === 'failed', refused);

  setSetting('dispatch.b0ToolId', 'p10-sseless');
  cacheClear('aitools');
  mkTask('b0-sseless');
  const ss = await PushDispatcher.dispatch('TB0-SSELESS', 'b0', { actor: 'manual' });
  ok('SSE 断流先受理为 running', ss.ok && ss.state === 'running' && Boolean(ss.attempts[0]?.ticket), ss);
  await sleep(300);
  await QueueService.pollPending(AIService.buildPoller());
  const ssJob = ss.attempts[0]?.jobId ? QueueService.getJob(ss.attempts[0].jobId) : null;
  ok('SSE 断流后 queue_job 收口失败', ssJob?.status === 'failed' || ssJob?.status === 'timeout', ssJob);
  setSetting('dispatch.b0ToolId', toolId);
  cacheClear('aitools');

  // ---- 幂等 ----
  const idem = 'idem-p10-b0';
  mkTask('idem');
  const i1 = await PushDispatcher.dispatch('TIDEM', 'b0', { actor: 'api', idempotencyKey: idem });
  const i2 = await PushDispatcher.dispatch('TIDEM', 'b0', { actor: 'api', idempotencyKey: idem });
  ok('同幂等键第二次被拒', i1.ok && i2.code === 'DISPATCH_DUPLICATE', { i1: i1.code, i2: i2.code });
  ok('重复请求返回已有 attempt', i2.attempts.length === 1 && i2.attempts[0].attemptId === i1.attemptId, i2.attempts);

  // 让后台 SSE 完成，再跑一次轮询，验证 queue_jobs 仍是权威状态
  await sleep(700);
  await QueueService.pollPending(AIService.buildPoller());
  const b0Job = br.attempts[0]?.jobId ? QueueService.getJob(br.attempts[0].jobId) : null;
  ok('B0 queue_job 收敛为 success', b0Job?.status === 'success', b0Job);

  // ---- 审计脱敏 ----
  attempts.recordAttempt({
    taskId: 'b0-ok', taskNo: 'TB0-OK', channel: 'B0', state: 'failed', actor: 'manual',
    detail: 'Authorization: Bearer secret123 apiKey=abc password=pw',
  });
  const redacted = attempts.listAttempts({ taskNo: 'TB0-OK', limit: 1 })[0]?.detail ?? '';
  ok('审计 detail 脱敏 Bearer/API key/password', !redacted.includes('secret123') && !redacted.includes('abc') && !redacted.includes('pw='), redacted);

  // ---- 审计清理 ----
  db.prepare(`INSERT INTO dispatch_attempts (id, task_id, task_no, channel, state, fallback_reason, detail, actor, idempotency_key, created_at)
    VALUES ('old-attempt', 'b0-ok', 'TB0-OK', 'B0', 'failed', '', '', 'manual', '', ?)`)
    .run(new Date(Date.now() - 2 * 86400000).toISOString());
  const cleaned = attempts.cleanupAttempts(1);
  ok('按保留天数清理旧审计', cleaned >= 1, cleaned);

  // ---- AC-04：仅 B0 且网关工具被停用，不回退 A ----
  db.prepare("UPDATE ai_tools SET enabled = 0 WHERE id = ?").run(toolId);
  cacheClear('aitools');
  mkTask('b0-missing');
  const bm = await PushDispatcher.dispatch('TB0-MISSING', 'b0', { actor: 'manual' });
  ok('AC-04 仅 B0 未配置返回 B0_NOT_CONFIGURED 且不回退 A', bm.code === 'B0_NOT_CONFIGURED' && bm.attempts.length === 1 && bm.attempts[0]?.channel === 'B0', bm);
  db.prepare("UPDATE ai_tools SET enabled = 1 WHERE id = ?").run(toolId);
  cacheClear('aitools');

  // ---- AC-21：人工队列多 Job 单条失败隔离 / 失败项重试 ----
  mkTask('batch-ok-1');
  mkTask('batch-fail');
  mkTask('batch-ok-2');
  const batchQueue = QueueService.create('P10 批量隔离', new Date().toISOString().slice(0, 10));
  const batchJobs = QueueService.addJobs(batchQueue.id, [
    { taskId: 'batch-ok-1', toolId },
    { taskId: 'batch-fail', toolId },
    { taskId: 'batch-ok-2', toolId },
  ]);
  await QueueService.submitAll(batchQueue.id, async (job) => {
    if (job.task_id === 'batch-fail') throw new Error('模拟单条提交失败');
    return { ok: true, content: 'batch ok' };
  });
  const batchRows = batchJobs.map((j) => QueueService.getJob(j.id));
  const statusOf = (taskId: string) => batchRows.find((j) => j?.task_id === taskId)?.status;
  ok('AC-21 单条失败后其余 job 继续完成', statusOf('batch-ok-1') === 'success' && statusOf('batch-fail') === 'failed' && statusOf('batch-ok-2') === 'success', batchRows.map((j) => `${j?.task_id}:${j?.status}`));
  ok('AC-21 失败 job 保留可重试状态', QueueService.getJob(batchJobs[1].id)?.error?.includes('模拟单条提交失败') === true, QueueService.getJob(batchJobs[1].id));
  QueueService.retryJob(batchQueue.id, batchJobs[1].id);
  ok('AC-21 失败项可重置为排队中', QueueService.getJob(batchJobs[1].id)?.status === 'queued', QueueService.getJob(batchJobs[1].id));
  await QueueService.submitAll(batchQueue.id, async () => ({ ok: true, content: 'batch retry ok' }));
  ok('AC-21 重试后仅失败项重新提交成功', QueueService.getJob(batchJobs[1].id)?.status === 'success' && QueueService.getJob(batchJobs[0].id)?.status === 'success' && QueueService.getJob(batchJobs[2].id)?.status === 'success', QueueService.listJobs(batchQueue.id).map((j) => `${j.task_id}:${j.status}`));

  // ---- AC-25：敏感信息不落日志/响应/明文库 ----
  const secret = 'P10-SECRET-DO-NOT-LEAK-9271';
  const { encrypt } = await import('../../server/src/util/crypto.ts');
  const { ConfigService } = await import('../../server/src/services/ConfigService.ts');
  const { logService } = await import('../../server/src/services/logService.ts');
  db.prepare(`INSERT INTO ai_tools (id, name, type, purpose, endpoint, api_key_enc, model, timeout_ms, enabled, created_at, updated_at)
    VALUES ('p10-secret', 'P10 secret gateway', 'codebuddy-gateway', 'develop', ?, ?, 'codebuddy', 3000, 1, ?, ?)`)
    .run(gatewayEndpoint, encrypt(secret), now, now);
  cacheClear('aitools');
  policy.savePolicy({ b0ToolId: 'p10-secret' });
  mkTask('secret-task');
  const secretDispatch = await PushDispatcher.dispatch('TSECRET', 'b0', { actor: 'manual' });
  const safeConfig = JSON.stringify(ConfigService.list());
  const secretAttempts = JSON.stringify(attempts.listAttempts({ taskNo: 'TSECRET', limit: 20 }));
  const secretLogs = JSON.stringify(logService.list(0).items);
  const rawTool = db.prepare("SELECT api_key_enc FROM ai_tools WHERE id='p10-secret'").get() as { api_key_enc: string };
  const secretInDb = (() => {
    for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>) {
      const rows = db.prepare(`SELECT * FROM "${t.name}"`).all();
      if (JSON.stringify(rows).includes(secret)) return t.name;
    }
    return '';
  })();
  ok('AC-25 配置视图只暴露掩码不含明文', safeConfig.includes('"hasApiKey":true') && !safeConfig.includes(secret), safeConfig.slice(0, 500));
  ok('AC-25 派发响应/审计不含网关口令', !JSON.stringify(secretDispatch).includes(secret) && !secretAttempts.includes(secret), secretAttempts.slice(0, 500));
  ok('AC-25 运行日志不含网关口令', !secretLogs.includes(secret), secretLogs.slice(0, 500));
  ok('AC-25 数据库只存密文，无明文', Boolean(rawTool.api_key_enc) && !rawTool.api_key_enc.includes(secret) && !secretInDb, { secretInDb });
  policy.savePolicy({ b0ToolId: toolId });
  cacheClear('aitools');

  // ---- EX-15：自动调度并发单飞 ----
  const [tickA, tickB] = await Promise.all([
    DispatchScheduler.tick({ force: true }),
    DispatchScheduler.tick({ force: true }),
  ]);
  ok('EX-15 并发 tick 仅一轮执行，另一轮返回 busy', [tickA.reason, tickB.reason].filter((r) => r === 'busy').length === 1, { a: tickA.reason, b: tickB.reason });

  // ---- 构建/安全源码锚点 ----
  const schedulerSource = (await import('node:fs')).readFileSync(join(process.cwd(), 'server/src/services/DispatchScheduler.ts'), 'utf8');
  const dispatcherSource = (await import('node:fs')).readFileSync(join(process.cwd(), 'server/src/services/PushDispatcher.ts'), 'utf8');
  ok('调度器不依赖 SupervisorService', !schedulerSource.includes('SupervisorService.') && !schedulerSource.includes("from './SupervisorService'"), 'source anchor');
  ok('调度器不调用 LLM chat', !schedulerSource.includes('chat('), 'source anchor');
  ok('自动链路强制 allowD=false', dispatcherSource.includes('allowD: false') && dispatcherSource.includes('dispatchAuto'), 'source anchor');

  console.log(lines.join('\n'));
  console.log(`\n[t06244] pass=${pass} fail=${fail}`);
  if (fail) process.exitCode = 1;
}

main()
  .catch((e) => {
    fail += 1;
    lines.push(`[FAIL] 验收脚本异常：${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    console.error(lines.join('\n'));
    console.error(`\n[t06244] pass=${pass} fail=${fail}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { gateway?.close(); } catch { /* ignore */ }
    try { closeDb?.(); } catch { /* ignore */ }
    await sleep(80);
    try { rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 仍占用时保留临时库，便于排查 */ }
  });
