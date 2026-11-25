/**
 * T06332（REQ-036 / PRD §B6）：旧队列 / 执行会话 / 用量记录 → 统一 Run 映射。
 *
 * 设计边界：
 * - 只读旧表，所有写入只落 `agent_runs` / `agent_run_steps` 两张新表；
 * - 同一 `legacy_source + legacy_ref` 只允许一个 Run，ID 固定为 `legacy:<source>:<ref>`；
 * - 旧表没有任务归属时（典型是 `ai_usage`），不伪造 `task_id/project_id`，明确记入 skipped；
 * - legacy 步骤是“由旧记录派生的快照”，重复映射时整体重建，保证内容跟随旧记录终态；
 *   原生 AgentRunStep 仍保持追加不可变，不受本服务影响。
 */
import type Database from 'better-sqlite3';

export const RUN_LEGACY_SOURCES = ['queue_job', 'exec_session', 'ai_usage'] as const;
export type RunLegacySourceName = (typeof RUN_LEGACY_SOURCES)[number];

export interface LegacyMapOptions {
  sources?: unknown;
  limit?: unknown;
  offset?: unknown;
}

export interface LegacyMapItem {
  source: RunLegacySourceName;
  ref: string;
  runId: string;
  action: 'inserted' | 'existing' | 'skipped' | 'failed';
  reason?: string;
  taskId?: string;
  projectId?: string;
}

export interface LegacyMapResult {
  sources: RunLegacySourceName[];
  limit: number;
  offset: number;
  scanned: number;
  inserted: number;
  existing: number;
  skipped: number;
  failed: number;
  skippedByReason: Record<string, number>;
  counts: { agentRuns: number; agentRunSteps: number };
  items: LegacyMapItem[];
  generatedAt: string;
}

interface QueueJobRow {
  id: string;
  queue_id: string;
  task_id: string;
  tool_id: string;
  order_index: number;
  status: string;
  request_payload: string | null;
  response_payload: string | null;
  error: string | null;
  sent_at: string | null;
  finished_at: string | null;
  task_no: string | null;
  task_title: string;
  project_id: string;
  project_name: string;
  tool_model: string | null;
  queue_name: string | null;
}

interface ExecSessionRow {
  id: string;
  platform: string;
  session_id: string | null;
  task_ids: string;
  status: string;
  progress: number;
  progress_reported: number;
  phase: string;
  last_heartbeat: string;
  started_at: string;
  finished_at: string | null;
}

interface UsageRow {
  id: string;
  tool_id: string | null;
  tool_name: string;
  model: string | null;
  kind: string;
  ok: number;
  duration_ms: number;
  content_chars: number;
  error: string | null;
  card_key: string;
  stage: string;
  job_id: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  created_at: string;
  queue_id: string | null;
  queue_task_id: string | null;
  queue_task_no: string | null;
  queue_task_title: string | null;
  queue_project_id: string | null;
  queue_project_name: string | null;
  direct_task_id: string | null;
  direct_task_no: string | null;
  direct_task_title: string | null;
  direct_project_id: string | null;
  direct_project_name: string | null;
}

interface DesiredStep {
  id: string;
  seq: number;
  type: 'prompt' | 'tool' | 'observation' | 'decision' | 'artifact' | 'approval';
  status: 'pending' | 'running' | 'awaiting_approval' | 'succeeded' | 'failed' | 'skipped';
  input: string;
  output: string;
  durationMs: number;
  cost: number;
  riskLevel: 'R0' | 'R1' | 'R2' | 'R3';
  createdAt: string;
  updatedAt: string;
}

interface DesiredRun {
  id: string;
  taskId: string;
  projectId: string;
  queueId: string | null;
  status: 'queued' | 'running' | 'paused' | 'awaiting_approval' | 'succeeded' | 'failed' | 'cancelled';
  model: string;
  promptVersion: string;
  tokens: number;
  cost: number;
  executor: string;
  startedAt: string | null;
  endedAt: string | null;
  errorCode: string;
  legacySource: RunLegacySourceName;
  legacyRef: string;
  createdAt: string;
  updatedAt: string;
  steps: DesiredStep[];
}

export function legacyRunId(source: RunLegacySourceName, ref: string): string {
  return `legacy:${source}:${ref}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function normalizeSources(raw: unknown): RunLegacySourceName[] {
  if (raw === undefined || raw === null || raw === '') return [...RUN_LEGACY_SOURCES];
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  const picked = list
    .map((x) => String(x).trim())
    .filter((x): x is RunLegacySourceName => (RUN_LEGACY_SOURCES as readonly string[]).includes(x));
  if (picked.length === 0) throw new Error('invalid_source');
  return [...new Set(picked)];
}

function parseTaskIds(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function durationBetween(startAt: string | null, endAt: string | null): number {
  if (!startAt || !endAt) return 0;
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : 0;
}

function queueRunStatus(status: string): DesiredRun['status'] {
  switch (status) {
    case 'success': return 'succeeded';
    case 'failed':
    case 'timeout': return 'failed';
    case 'sending': return 'running';
    default: return 'queued';
  }
}

function queueStepStatus(status: string): DesiredStep['status'] {
  switch (status) {
    case 'success': return 'succeeded';
    case 'failed':
    case 'timeout': return 'failed';
    case 'sending': return 'running';
    default: return 'pending';
  }
}

function execRunStatus(status: string): DesiredRun['status'] {
  switch (status) {
    case 'done': return 'succeeded';
    case 'failed': return 'failed';
    case 'aborted': return 'cancelled';
    case 'stalled': return 'paused';
    default: return 'running';
  }
}

function execStepStatus(status: string): DesiredStep['status'] {
  switch (status) {
    case 'done': return 'succeeded';
    case 'failed': return 'failed';
    case 'aborted': return 'skipped';
    case 'stalled': return 'pending';
    default: return 'running';
  }
}

function execFinalStepStatus(status: string): DesiredStep['status'] {
  switch (status) {
    case 'done': return 'succeeded';
    case 'failed': return 'failed';
    case 'aborted': return 'skipped';
    default: return 'pending';
  }
}

function queueStatusText(status: string): string {
  switch (status) {
    case 'success': return '成功';
    case 'failed': return '失败';
    case 'timeout': return '超时';
    case 'sending': return '发送中';
    default: return '排队中';
  }
}

function execStatusText(status: string): string {
  switch (status) {
    case 'done': return '已完成';
    case 'failed': return '执行失败';
    case 'aborted': return '已中止';
    case 'stalled': return '已停滞';
    default: return '执行中';
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return 'null';
  }
}

export class RunLegacyMapper {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  private hasTable(name: string): boolean {
    try {
      return this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(name) !== undefined;
    } catch {
      return false;
    }
  }

  private assertSchema(): void {
    if (!this.hasTable('agent_runs') || !this.hasTable('agent_run_steps')) throw new Error('schema_missing');
  }

  private recordSkip(result: LegacyMapResult, item: LegacyMapItem, reason: string): void {
    result.skipped += 1;
    result.skippedByReason[reason] = (result.skippedByReason[reason] ?? 0) + 1;
    if (result.items.length < 200) result.items.push({ ...item, action: 'skipped', reason });
  }

  private recordFailure(result: LegacyMapResult, item: Omit<LegacyMapItem, 'action'>, reason: string): void {
    result.failed += 1;
    result.skippedByReason[reason] = (result.skippedByReason[reason] ?? 0) + 1;
    if (result.items.length < 200) result.items.push({ ...item, action: 'failed', reason });
  }

  /**
   * 将旧记录同步到新表：
   * - 已有映射：刷新状态/结束时间/错误码与派生步骤；
   * - 无映射：插入稳定 ID 的 Run；
   * - 无法归因：返回 skipped，不写任何表。
   */
  map(options: LegacyMapOptions = {}): LegacyMapResult {
    this.assertSchema();
    const sources = normalizeSources(options.sources);
    const limit = clampInt(options.limit, 100, 1, 1000);
    const offset = clampInt(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const result: LegacyMapResult = {
      sources,
      limit,
      offset,
      scanned: 0,
      inserted: 0,
      existing: 0,
      skipped: 0,
      failed: 0,
      skippedByReason: {},
      counts: { agentRuns: 0, agentRunSteps: 0 },
      items: [],
      generatedAt: nowIso(),
    };

    for (const source of sources) {
      if (source === 'queue_job') this.mapQueueJobs(result, limit, offset);
      else if (source === 'exec_session') this.mapExecSessions(result, limit, offset);
      else if (source === 'ai_usage') this.mapUsage(result, limit, offset);
    }

    result.counts.agentRuns = Number((this.db.prepare('SELECT COUNT(*) AS c FROM agent_runs').get() as { c: number }).c) || 0;
    result.counts.agentRunSteps = Number((this.db.prepare('SELECT COUNT(*) AS c FROM agent_run_steps').get() as { c: number }).c) || 0;
    result.generatedAt = nowIso();
    return result;
  }

  private mapQueueJobs(result: LegacyMapResult, limit: number, offset: number): void {
    if (!this.hasTable('queue_jobs')) {
      this.recordSkip(result, { source: 'queue_job', ref: '', runId: '', action: 'skipped' }, 'queue_jobs_table_missing');
      return;
    }
    const rows = this.db.prepare(`
      SELECT j.*, t.task_no, t.title AS task_title, t.project_id,
             p.name AS project_name, at.model AS tool_model, q.name AS queue_name
        FROM queue_jobs j
        JOIN tasks t ON t.id = j.task_id
        JOIN projects p ON p.id = t.project_id
        LEFT JOIN ai_tools at ON at.id = j.tool_id
        LEFT JOIN queues q ON q.id = j.queue_id
       ORDER BY COALESCE(j.finished_at, j.sent_at, '') DESC, j.rowid DESC
       LIMIT ? OFFSET ?
    `).all(limit, offset) as QueueJobRow[];

    for (const row of rows) {
      result.scanned += 1;
      const run = this.queueRunFromRow(row);
      this.persist(result, run, { source: 'queue_job', ref: row.id, runId: run.id, taskId: run.taskId, projectId: run.projectId });
    }
  }

  private queueRunFromRow(row: QueueJobRow): DesiredRun {
    const runId = legacyRunId('queue_job', row.id);
    const baseTime = row.sent_at || row.finished_at || nowIso();
    const status = queueRunStatus(row.status);
    const stepStatus = queueStepStatus(row.status);
    const finalStatus: DesiredStep['status'] = status === 'succeeded' ? 'succeeded' : status === 'failed' ? 'failed' : 'pending';
    const errorCode = status === 'failed' ? (row.status === 'timeout' ? 'queue_job_timeout' : 'queue_job_failed') : '';
    const stepOutput = row.response_payload || row.error || (status === 'succeeded' ? '队列回执成功' : status === 'failed' ? '队列执行失败' : '等待回执');
    const queueText = queueStatusText(row.status);
    const payload = row.request_payload || '';
    const toolInput = safeJson({ toolId: row.tool_id, model: row.tool_model ?? '', queueId: row.queue_id, orderIndex: row.order_index });

    return {
      id: runId,
      taskId: row.task_id,
      projectId: row.project_id,
      queueId: row.queue_id,
      status,
      model: row.tool_model ?? '',
      promptVersion: '',
      tokens: 0,
      cost: 0,
      executor: row.queue_name ? `queue:${row.queue_name}` : `queue:${row.queue_id}`,
      startedAt: row.sent_at,
      endedAt: row.finished_at,
      errorCode,
      legacySource: 'queue_job',
      legacyRef: row.id,
      createdAt: baseTime,
      updatedAt: nowIso(),
      steps: [
        {
          id: `${runId}:step-0`,
          seq: 0,
          type: 'prompt',
          status: stepStatus === 'pending' ? 'pending' : 'succeeded',
          input: safeJson({ taskId: row.task_id, taskNo: row.task_no, projectId: row.project_id, queueId: row.queue_id }),
          output: payload,
          durationMs: 0,
          cost: 0,
          riskLevel: 'R0',
          createdAt: baseTime,
          updatedAt: baseTime,
        },
        {
          id: `${runId}:step-1`,
          seq: 1,
          type: 'tool',
          status: stepStatus,
          input: toolInput,
          output: stepOutput,
          durationMs: durationBetween(row.sent_at, row.finished_at),
          cost: 0,
          riskLevel: 'R1',
          createdAt: baseTime,
          updatedAt: row.finished_at || baseTime,
        },
        {
          id: `${runId}:step-2`,
          seq: 2,
          type: 'decision',
          status: finalStatus,
          input: safeJson({ queueStatus: row.status }),
          output: `队列状态：${queueText}`,
          durationMs: 0,
          cost: 0,
          riskLevel: 'R0',
          createdAt: row.finished_at || baseTime,
          updatedAt: row.finished_at || baseTime,
        },
      ],
    };
  }

  private mapExecSessions(result: LegacyMapResult, limit: number, offset: number): void {
    if (!this.hasTable('exec_sessions')) {
      this.recordSkip(result, { source: 'exec_session', ref: '', runId: '', action: 'skipped' }, 'exec_sessions_table_missing');
      return;
    }
    const rows = this.db.prepare(`
      SELECT * FROM exec_sessions
       ORDER BY started_at DESC, rowid DESC
       LIMIT ? OFFSET ?
    `).all(limit, offset) as ExecSessionRow[];

    for (const row of rows) {
      result.scanned += 1;
      const task = this.firstTaskForSession(row);
      if (!task) {
        this.recordSkip(result, {
          source: 'exec_session', ref: row.id, runId: legacyRunId('exec_session', row.id), action: 'skipped',
        }, 'no_task_attribution');
        continue;
      }
      const run = this.execRunFromRow(row, task);
      this.persist(result, run, { source: 'exec_session', ref: row.id, runId: run.id, taskId: run.taskId, projectId: run.projectId });
    }
  }

  private firstTaskForSession(row: ExecSessionRow): { id: string; task_no: string | null; title: string; project_id: string; project_name: string } | null {
    const ids = parseTaskIds(row.task_ids);
    if (ids.length === 0) return null;
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT t.id, t.task_no, t.title, t.project_id, p.name AS project_name
        FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.id IN (${placeholders})
    `).all(...ids) as { id: string; task_no: string | null; title: string; project_id: string; project_name: string }[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const hit = byId.get(id);
      if (hit) return hit;
    }
    return null;
  }

  private execRunFromRow(row: ExecSessionRow, task: { id: string; project_id: string }): DesiredRun {
    const runId = legacyRunId('exec_session', row.id);
    const status = execRunStatus(row.status);
    const stepStatus = execStepStatus(row.status);
    const finalStatus = execFinalStepStatus(row.status);
    const startedMs = Date.parse(row.started_at);
    const heartbeatMs = Date.parse(row.last_heartbeat);
    const finishedMs = row.finished_at ? Date.parse(row.finished_at) : Number.NaN;
    const elapsedToHeartbeat = Number.isFinite(startedMs) && Number.isFinite(heartbeatMs) && heartbeatMs >= startedMs
      ? heartbeatMs - startedMs : 0;
    const progressPct = Math.max(0, Math.min(100, Math.round(Number(row.progress) || 0)));
    const taskIds = parseTaskIds(row.task_ids);
    const baseTime = row.started_at || nowIso();
    const step2Time = row.finished_at || row.last_heartbeat || baseTime;

    return {
      id: runId,
      taskId: task.id,
      projectId: task.project_id,
      queueId: null,
      status,
      model: '',
      promptVersion: '',
      tokens: 0,
      cost: 0,
      executor: row.platform,
      startedAt: row.started_at,
      endedAt: row.finished_at,
      errorCode: '',
      legacySource: 'exec_session',
      legacyRef: row.id,
      createdAt: baseTime,
      updatedAt: nowIso(),
      steps: [
        {
          id: `${runId}:step-0`,
          seq: 0,
          type: 'observation',
          status: 'succeeded',
          input: safeJson({ platform: row.platform, sessionId: row.session_id, taskIds }),
          output: `外部执行平台 ${row.platform} 已建立会话`,
          durationMs: 0,
          cost: 0,
          riskLevel: 'R0',
          createdAt: baseTime,
          updatedAt: baseTime,
        },
        {
          id: `${runId}:step-1`,
          seq: 1,
          type: 'observation',
          status: stepStatus,
          input: safeJson({
            phase: row.phase || '',
            progress: progressPct,
            progressReported: row.progress_reported === 1,
            lastHeartbeat: row.last_heartbeat,
          }),
          output: [
            row.phase ? `阶段：${row.phase}` : '阶段：未上报',
            row.progress_reported === 1 ? `进度：${progressPct}%` : '进度：平台未上报',
          ].join('；'),
          durationMs: elapsedToHeartbeat,
          cost: 0,
          riskLevel: 'R0',
          createdAt: row.last_heartbeat || baseTime,
          updatedAt: row.last_heartbeat || baseTime,
        },
        {
          id: `${runId}:step-2`,
          seq: 2,
          type: 'decision',
          status: finalStatus,
          input: safeJson({ sessionStatus: row.status }),
          output: `会话状态：${execStatusText(row.status)}`,
          durationMs: durationBetween(row.started_at, row.finished_at),
          cost: 0,
          riskLevel: 'R0',
          createdAt: step2Time,
          updatedAt: step2Time,
        },
      ],
    };
  }

  private mapUsage(result: LegacyMapResult, limit: number, offset: number): void {
    if (!this.hasTable('ai_usage')) {
      this.recordSkip(result, { source: 'ai_usage', ref: '', runId: '', action: 'skipped' }, 'ai_usage_table_missing');
      return;
    }
    if (!this.hasTable('tasks') || !this.hasTable('projects')) {
      this.recordSkip(result, { source: 'ai_usage', ref: '', runId: '', action: 'skipped' }, 'tasks_table_missing');
      return;
    }

    const rows = this.db.prepare(`
      SELECT u.*,
             qj.queue_id AS queue_id,
             qt.id AS queue_task_id, qt.task_no AS queue_task_no, qt.title AS queue_task_title,
             qp.id AS queue_project_id, qp.name AS queue_project_name,
             rt.id AS direct_task_id, rt.task_no AS direct_task_no, rt.title AS direct_task_title,
             rp.id AS direct_project_id, rp.name AS direct_project_name
        FROM ai_usage u
        LEFT JOIN queue_jobs qj ON qj.id = u.job_id
        LEFT JOIN tasks qt ON qt.id = qj.task_id
        LEFT JOIN projects qp ON qp.id = qt.project_id
        LEFT JOIN tasks rt ON rt.id = u.job_id
        LEFT JOIN projects rp ON rp.id = rt.project_id
       ORDER BY u.created_at DESC, u.rowid DESC
       LIMIT ? OFFSET ?
    `).all(limit, offset) as UsageRow[];

    for (const row of rows) {
      result.scanned += 1;
      const task = this.resolveUsageTask(row);
      const stableId = legacyRunId('ai_usage', row.id);
      if (!task) {
        this.recordSkip(result, { source: 'ai_usage', ref: row.id, runId: stableId, action: 'skipped' }, 'no_task_attribution');
        continue;
      }
      const run = this.usageRunFromRow(row, task);
      this.persist(result, run, { source: 'ai_usage', ref: row.id, runId: run.id, taskId: run.taskId, projectId: run.projectId });
    }
  }

  private resolveUsageTask(row: UsageRow): { id: string; project_id: string; queue_id: string | null } | null {
    if (row.queue_task_id && row.queue_project_id) {
      return { id: row.queue_task_id, project_id: row.queue_project_id, queue_id: row.queue_id };
    }
    if (row.direct_task_id && row.direct_project_id) {
      return { id: row.direct_task_id, project_id: row.direct_project_id, queue_id: null };
    }
    return null;
  }

  private usageRunFromRow(row: UsageRow, task: { id: string; project_id: string; queue_id: string | null }): DesiredRun {
    const runId = legacyRunId('ai_usage', row.id);
    const durationMs = Math.max(0, Number(row.duration_ms) || 0);
    const endMs = Date.parse(row.created_at);
    const startedAt = Number.isFinite(endMs) ? new Date(endMs - durationMs).toISOString() : row.created_at;
    const ok = Number(row.ok) === 1;
    const status: DesiredRun['status'] = ok ? 'succeeded' : 'failed';
    const totalTokens = row.total_tokens === null ? Number.NaN : Number(row.total_tokens);
    const promptTokens = row.prompt_tokens === null ? Number.NaN : Number(row.prompt_tokens);
    const completionTokens = row.completion_tokens === null ? Number.NaN : Number(row.completion_tokens);
    const tokens = Number.isFinite(totalTokens)
      ? Math.max(0, totalTokens)
      : Math.max(0, (Number.isFinite(promptTokens) ? promptTokens : 0) + (Number.isFinite(completionTokens) ? completionTokens : 0));
    const executor = row.tool_name || row.tool_id || 'ai_usage';
    const errorText = row.error || '';

    return {
      id: runId,
      taskId: task.id,
      projectId: task.project_id,
      queueId: task.queue_id,
      status,
      model: row.model ?? '',
      promptVersion: '',
      tokens,
      cost: 0,
      executor,
      startedAt,
      endedAt: row.created_at,
      errorCode: ok ? '' : 'ai_usage_error',
      legacySource: 'ai_usage',
      legacyRef: row.id,
      createdAt: startedAt,
      updatedAt: nowIso(),
      steps: [
        {
          id: `${runId}:step-0`,
          seq: 0,
          type: 'observation',
          status: ok ? 'succeeded' : 'failed',
          input: safeJson({
            toolId: row.tool_id ?? '',
            toolName: row.tool_name,
            kind: row.kind,
            model: row.model ?? '',
            cardKey: row.card_key,
            stage: row.stage,
            jobId: row.job_id,
            contentChars: row.content_chars,
            promptTokens: row.prompt_tokens,
            completionTokens: row.completion_tokens,
          }),
          output: ok
            ? `模型调用成功：${Number(row.content_chars) || 0} 字符`
            : `模型调用失败：${errorText || '未记录错误'}`,
          durationMs,
          cost: 0,
          riskLevel: 'R0',
          createdAt: startedAt,
          updatedAt: row.created_at,
        },
      ],
    };
  }

  private persist(result: LegacyMapResult, run: DesiredRun, item: Omit<LegacyMapItem, 'action'>): void {
    try {
      const tx = this.db.transaction(() => {
        const existing = this.db.prepare(`
          SELECT id FROM agent_runs WHERE legacy_source = ? AND legacy_ref = ? LIMIT 1
        `).get(run.legacySource, run.legacyRef) as { id: string } | undefined;
        const runId = existing?.id ?? run.id;
        if (existing) {
          this.db.prepare(`
            UPDATE agent_runs
               SET task_id = ?, project_id = ?, queue_id = ?, status = ?, model = ?, prompt_version = ?,
                   tokens = ?, cost = ?, executor = ?, started_at = ?, ended_at = ?, error_code = ?, updated_at = ?
             WHERE id = ?
          `).run(
            run.taskId, run.projectId, run.queueId, run.status, run.model, run.promptVersion,
            run.tokens, run.cost, run.executor, run.startedAt, run.endedAt, run.errorCode, nowIso(), runId,
          );
        } else {
          this.db.prepare(`
            INSERT INTO agent_runs (
              id, task_id, project_id, queue_id, status, trigger_type, model, prompt_version,
              tokens, cost, executor, started_at, ended_at, error_code, legacy_source, legacy_ref,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'legacy', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            run.id, run.taskId, run.projectId, run.queueId, run.status, run.model, run.promptVersion,
            run.tokens, run.cost, run.executor, run.startedAt, run.endedAt, run.errorCode,
            run.legacySource, run.legacyRef, run.createdAt, run.updatedAt,
          );
        }

        this.db.prepare('DELETE FROM agent_run_steps WHERE run_id = ?').run(runId);
        const insertStep = this.db.prepare(`
          INSERT INTO agent_run_steps (
            id, run_id, seq, type, status, input, output, duration_ms, cost, risk_level, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const step of run.steps) {
          insertStep.run(
            step.id, runId, step.seq, step.type, step.status, step.input, step.output,
            step.durationMs, step.cost, step.riskLevel, step.createdAt, step.updatedAt,
          );
        }
        return { runId, action: existing ? 'existing' as const : 'inserted' as const };
      });
      const saved = tx();
      result[saved.action] += 1;
      if (result.items.length < 200) {
        result.items.push({ ...item, runId: saved.runId, action: saved.action });
      }
    } catch (e) {
      this.recordFailure(result, item, e instanceof Error ? e.message : String(e));
    }
  }
}
