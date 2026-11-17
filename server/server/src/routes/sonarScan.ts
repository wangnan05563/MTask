/**
 * 八期 §3.4.2「Sonar 质量扫描」接口层（T03376 / T03428 / T03432 / T03410）。
 *
 * - `POST /sonar/scan` 发起 job（SSE：`job`/`stage`/`log`/`done`/`aborted`/`error`），并发超限 429；
 * - `POST /sonar/scan/stop` 中止（掐子进程 + 回收快照目录）；
 * - `GET  /sonar/scan/env` 面板的不可用态数据源（缺 scanner/Java 时卡片置灰并给指引，不弹错误框）；
 * - `GET  /sonar/scan/running` 刷新后恢复运行徽标；
 * - `GET  /sonar/scan/job` 回读 console_job（历史结果与失败原因）。
 *
 * 与提取族同构：切 SSE 之前的问题一律 JSON 4xx（按 kind 走行内提示）；
 * 环境不满足时**不建 console_job**（AC-16「不产生错误弹窗与残留 job」）。
 */
import { Router } from 'express';
import { exportGate } from '../util/export-gate';
import { ExtractError } from '../services/gitExtract';
import { GitCollectError } from '../services/gitCollect';
import { SonarConfigError, projectKeyFor, readScanSettings, SONAR_SCAN_GATE, SCAN_LIMIT_DEFAULT } from '../services/sonarSettings';
import {
  SEVERITY_ORDER, ScanError, listRunningScans, runSonarScan, scanEnvState, sweepSonarFps, sweepSonarTmp,
} from '../services/sonarScan';
import type { ScanInput, ScanSeverity } from '../services/sonarScan';
import { ConsoleJobService } from '../services/ConsoleJobService';
import { scalarText } from '../util/scalarText';
import { startSseKeepalive } from './sseKeepalive'; // T04001：非模型长流同样怕静默被掐（JVM 扫描单阶段可 >300s）

export const sonarScanApi = Router();

/** jobId → 中止句柄 */
const controllers = new Map<string, AbortController>();

/** 参数校验类 kind：发生在 SSE 之前，按 HTTP 4xx 回（与提取族「切 SSE 前一律 JSON 4xx」同口径） */
const BAD_REQUEST_KINDS = new Set<string>(['bad-args', 'bad-severities', 'bad-cap']);

function errorShape(e: unknown): { status: number; body: { error: string; kind: string; hint?: string } } {
  if (e instanceof ScanError) {
    return { status: BAD_REQUEST_KINDS.has(e.kind) ? 400 : 200, body: { error: e.message, kind: e.kind, ...(e.hint ? { hint: e.hint } : {}) } };
  }
  if (e instanceof SonarConfigError) return { status: 400, body: { error: e.message, kind: e.kind } };
  if (e instanceof ExtractError) {
    let status: number;
    if (e.kind === 'no-tasks' || e.kind === 'no-links' || e.kind === 'empty') status = 400;
    else if (e.kind === 'task-not-found') status = 404;
    else if (e.kind === 'too-many-files' || e.kind === 'too-large') status = 413;
    else status = 400;
    return { status, body: { error: e.message, kind: e.kind } };
  }
  if (e instanceof GitCollectError) return { status: 200, body: { error: e.message, kind: e.kind } };
  return { status: 500, body: { error: e instanceof Error ? e.message : String(e), kind: 'failed' } };
}

function idsOf(raw: unknown, label = 'taskIds', optional = false): string[] {
  if (raw === undefined || raw === null) {
    if (optional) return [];
    throw new ScanError('bad-args', `${label} 需为数组`);
  }
  if (!Array.isArray(raw)) throw new ScanError('bad-args', `${label} 需为数组`);
  return raw.map((x) => String(x ?? '').trim()).filter(Boolean);
}

/** T04576：手动提交的来源仓库表（SHA → repoSub；缺省/空串=项目根仓库） */
function commitReposOf(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ScanError('bad-args', 'commitRepos 需为 { SHA: repoSub } 对象');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const sha = String(k ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new ScanError('bad-args', `commitRepos 的键必须是提交 SHA（收到「${String(k).slice(0, 40)}」）`);
    out[sha] = scalarText(v ?? '').trim();
  }
  return out;
}

function severitiesOf(raw: unknown): ScanSeverity[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || !raw.length) throw new ScanError('bad-severities', '回写阈值需为非空数组（可选：' + SEVERITY_ORDER.join(' / ') + '）');
  const out: ScanSeverity[] = [];
  for (const x of raw) {
    const s = String(x ?? '').trim().toLowerCase() as ScanSeverity;
    if (!SEVERITY_ORDER.includes(s)) throw new ScanError('bad-severities', `未知严重度「${String(x).slice(0, 16)}」，可选：${SEVERITY_ORDER.join(' / ')}`);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function capOf(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 200) throw new ScanError('bad-cap', '单次回写上限需为 1–200 的整数');
  return n;
}

/** 面板进页就要知道环境是否可用（不可用时卡片置灰 + 指引，扫描请求根本发不出去） */
sonarScanApi.get('/sonar/scan/env', async (req, res) => {
  try {
    const raw = scalarText(req.query.projectIds ?? '');
    const projectIds = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const state = await scanEnvState(projectIds);
    res.json({
      ...state,
      serverUrlConfigured: state.serverConfigured,
      scanLimit: readScanSettings().scanLimit,
      gate: SONAR_SCAN_GATE,
      // 行内提示「这个项目还没配 projectKey」的数据源，避免前端自己读映射（两套口径迟早漂移）
      missingProjectKeys: projectIds.filter((p) => !projectKeyFor(p)),
      // 面板的 projectKey 下拉同样只吃服务端算好的映射：前端不复制一份映射表
      keysForProjects: projectIds
        .map((projectId) => ({ projectId, sonarKey: projectKeyFor(projectId) }))
        .filter((x) => x.sonarKey),
    });
  } catch (e) {
    const { status, body } = errorShape(e);
    res.status(status).json(body);
  }
});

/** 刷新后恢复运行徽标（console_jobs 里 busy 的 sonar 行 + 当前阶段） */
sonarScanApi.get('/sonar/scan/running', (_req, res) => {
  res.json({ jobs: listRunningScans() });
});

/** 历史结果回读（只回运行态需要的字段，不回 prompt 明细） */
sonarScanApi.get('/sonar/scan/job', (req, res) => {
  const jobId = scalarText(req.query.jobId ?? '').trim();
  const row = jobId ? ConsoleJobService.get(jobId) : null;
  if (!row) return res.status(404).json({ error: '任务不存在', kind: 'job-not-found' });
  res.json({ jobId: row.id, status: row.status, title: row.title, answer: row.answer ?? '', error: row.error ?? '', createdAt: row.created_at });
});

/** 请求体 → ScanInput；非法值由 idsOf/severitiesOf/capOf 抛 ScanError（切 SSE 之前按 4xx 回） */
function scanInputOf(body: Record<string, unknown>): ScanInput {
  return {
    taskIds: idsOf(body.taskIds),
    commitIds: idsOf(body.commitIds, 'commitIds', true),
    commitRepos: commitReposOf(body.commitRepos),
    projectIds: idsOf(body.projectIds, 'projectIds', true),
    // scalarText：projectKey 只可能是文本，非字符串（如对象）按未配置处理而不是拼成 "[object Object]"
    projectKey: body.projectKey ? (scalarText(body.projectKey).trim() || undefined) : undefined,
    autoWriteBack: body.autoWriteBack === undefined ? true : body.autoWriteBack === true,
    severities: severitiesOf(body.severities),
    cap: capOf(body.cap),
  };
}

/** 环境预检（SSE 之前）：缺 scanner/Java/projectKey 时返回 400 体，可用时返回 null */
async function scanEnvRejection(): Promise<{ error: string; kind: string; hint: string } | null> {
  // 缺 scanner/Java 时既不该建 job，也不该让前端看到一个空的运行态
  const env = await scanEnvState();
  if (env.ok) return null;
  const noJavaKind = env.java.available ? 'no-project-key' : 'no-java';
  const kind = env.scanner.available ? noJavaKind : 'no-scanner';
  return { error: env.reasons[0], kind, hint: env.reasons.join('；') };
}

/** 发起扫描（SSE） */
sonarScanApi.post('/sonar/scan', exportGate(SONAR_SCAN_GATE, SCAN_LIMIT_DEFAULT), async (req, res) => {
  let input: ScanInput;
  try {
    input = scanInputOf((req.body ?? {}) as Record<string, unknown>);
    const rejection = await scanEnvRejection();
    if (rejection) return res.status(400).json(rejection);
  } catch (e) {
    const { status, body } = errorShape(e);
    return res.status(status).json(body);
  }
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  startSseKeepalive(res);
  const send = (event: string, payload: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  const controller = new AbortController();
  // 服务内部建 console_job 之后才知道 jobId：登记要发生在建号的那一刻，
  // 否则用户在窗口期点「中止」会掐不到任何东西
  let jobId = '';
  // 登记 + 立刻把 job 帧发给前端：中止按钮按 jobId 掐进程，晚一帧发就等于让用户点空
  const bind = (id: string) => { jobId = id; controllers.set(id, controller); send('job', { jobId: id }); };
  res.on('close', () => controller.abort());
  sweepSonarTmp();
  sweepSonarFps();
  try {
    const result = await runSonarScan(input, {
      job: bind,
      stage: (stage, detail) => send('stage', { stage, ...(detail ? { detail } : {}) }),
      log: (line) => send('log', { line }),
    }, {}, controller.signal);
    if (jobId) controllers.delete(jobId);
    send('done', result);
  } catch (e) {
    if (jobId) controllers.delete(jobId);
    if (controller.signal.aborted || (e instanceof ScanError && e.kind === 'aborted')) {
      send('aborted', { jobId, message: '已中止，快照目录与配置已回收' });
    } else {
      const { body } = errorShape(e);
      send('error', body);
    }
  } finally {
    if (jobId) controllers.delete(jobId);
    res.end();
  }
});

/** 中止：掐子进程并回收快照（幂等——job 已结束也回 ok，前端只需收掉运行徽标） */
sonarScanApi.post('/sonar/scan/stop', (req, res) => {
  const jobId = String(req.body?.jobId ?? '').trim();
  const c = controllers.get(jobId);
  if (c) c.abort();
  controllers.delete(jobId);
  res.json({ ok: true, aborted: !!c });
});
