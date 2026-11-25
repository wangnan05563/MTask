/**
 * T06332（REQ-036 / PRD §B6）：Run 只读列表查询。
 *
 * 只读 `agent_runs` / `agent_run_steps`，支持按任务（内部 id 或 Txxxxx 编号）、
 * 项目、状态、legacy_source 过滤并分页；详情和步骤时间线复用 RunTraceService，
 * 避免列表/详情两套字段口径漂移。
 */
import type Database from 'better-sqlite3';
import type {
  AgentLegacyRunSource,
  AgentRunStatus,
  AgentRunTriggerType,
} from '../db/agentRunSchema';

export interface RunListOptions {
  taskId?: string;
  projectId?: string;
  status?: string;
  legacySource?: string;
  q?: string;
  from?: string;
  to?: string;
  limit?: unknown;
  offset?: unknown;
}

export interface RunListItem {
  id: string;
  taskId: string;
  taskNo: string | null;
  taskTitle: string | null;
  projectId: string;
  projectName: string | null;
  queueId: string | null;
  parentRunId: string | null;
  status: AgentRunStatus;
  triggerType: AgentRunTriggerType;
  model: string;
  promptVersion: string;
  tokens: number;
  cost: number;
  executor: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  errorCode: string;
  legacySource: AgentLegacyRunSource;
  legacyRef: string;
  legacy: boolean;
  stepCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RunListResult {
  items: RunListItem[];
  total: number;
  limit: number;
  offset: number;
  generatedAt: string;
}

interface RunListRow {
  id: string;
  task_id: string;
  project_id: string;
  queue_id: string | null;
  parent_run_id: string | null;
  status: string;
  trigger_type: string;
  model: string;
  prompt_version: string;
  tokens: number;
  cost: number;
  executor: string;
  started_at: string | null;
  ended_at: string | null;
  error_code: string;
  legacy_source: string;
  legacy_ref: string;
  created_at: string;
  updated_at: string;
  task_no: string | null;
  task_title: string | null;
  project_name: string | null;
  step_count: number;
}

const RUN_STATUSES: AgentRunStatus[] = ['queued', 'running', 'paused', 'awaiting_approval', 'succeeded', 'failed', 'cancelled'];
const LEGACY_SOURCES: AgentLegacyRunSource[] = ['', 'queue_job', 'exec_session', 'ai_usage'];
const TRIGGER_TYPES: AgentRunTriggerType[] = ['manual', 'queue', 'api', 'schedule', 'retry', 'legacy'];

export class RunQueryError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.code = code;
  }
}

function asRunStatus(value: string): AgentRunStatus {
  return RUN_STATUSES.includes(value as AgentRunStatus) ? value as AgentRunStatus : 'running';
}

function asTriggerType(value: string): AgentRunTriggerType {
  return TRIGGER_TYPES.includes(value as AgentRunTriggerType) ? value as AgentRunTriggerType : 'legacy';
}

function asLegacySource(value: string): AgentLegacyRunSource {
  return LEGACY_SOURCES.includes(value as AgentLegacyRunSource) ? value as AgentLegacyRunSource : '';
}

function durationMs(startedAt: string | null, endedAt: string | null): number | null {
  if (!startedAt || !endedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

interface ValidatedTime {
  readonly value: string;
  readonly exclusive: boolean;
}

function validateTime(name: 'from' | 'to', value: unknown): ValidatedTime | null {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const ts = Date.parse(dateOnly ? `${raw}T00:00:00.000Z` : raw);
  if (!Number.isFinite(ts)) throw new RunQueryError('invalid_time_range', `${name} 不是有效时间`);
  const date = new Date(ts);
  if (dateOnly && name === 'to') {
    // date-only 的 to 表示“包含当天”，SQL 使用次日 00:00 的 < 边界。
    date.setUTCDate(date.getUTCDate() + 1);
    return { value: date.toISOString(), exclusive: true };
  }
  return { value: date.toISOString(), exclusive: false };
}

export class RunQueryService {
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
    // list 同时依赖 agent_run_steps 的 step_count 与 tasks/projects 的 join；
    // 缺任一表都应显式返回 503 schema_missing，而不是让 SQL 在请求期抛 500。
    for (const table of ['agent_runs', 'agent_run_steps', 'tasks', 'projects']) {
      if (!this.hasTable(table)) throw new RunQueryError('schema_missing');
    }
  }

  private resolveTaskRef(raw: string | undefined): string | null {
    const ref = String(raw ?? '').trim();
    if (!ref) return null;
    if (!this.hasTable('tasks')) return ref;
    const row = this.db.prepare(`
      SELECT id FROM tasks WHERE id = ? OR task_no = ? ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1
    `).get(ref, ref, ref) as { id: string } | undefined;
    return row?.id ?? ref;
  }

  list(options: RunListOptions = {}): RunListResult {
    this.assertSchema();
    const limit = clampInt(options.limit, 50, 1, 200);
    const offset = clampInt(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const taskId = this.resolveTaskRef(options.taskId);
    const projectId = String(options.projectId ?? '').trim();
    const status = String(options.status ?? '').trim();
    if (status && !RUN_STATUSES.includes(status as AgentRunStatus)) throw new RunQueryError('invalid_status');
    const legacySource = String(options.legacySource ?? '').trim();
    if (legacySource && !LEGACY_SOURCES.includes(legacySource as AgentLegacyRunSource)) throw new RunQueryError('invalid_legacy_source');
    const q = String(options.q ?? '').trim().slice(0, 120);
    const from = validateTime('from', options.from);
    const to = validateTime('to', options.to);
    if (from && to) {
      const fromTs = Date.parse(from.value);
      const toTs = Date.parse(to.value);
      // date-only 的 to 已转成次日 00:00 的独占边界，from 与之相等也会得到空范围。
      if (to.exclusive ? fromTs >= toTs : fromTs > toTs) {
        throw new RunQueryError('invalid_time_range', 'from 不能晚于 to');
      }
    }

    const where: string[] = [];
    const params: unknown[] = [];
    if (taskId) {
      where.push('ar.task_id = ?');
      params.push(taskId);
    }
    if (projectId) {
      where.push('ar.project_id = ?');
      params.push(projectId);
    }
    if (status) {
      where.push('ar.status = ?');
      params.push(status);
    }
    if (legacySource) {
      where.push('ar.legacy_source = ?');
      params.push(legacySource);
    }
    if (from) {
      where.push("COALESCE(ar.started_at, ar.created_at) >= ?");
      params.push(from.value);
    }
    if (to) {
      where.push(`COALESCE(ar.started_at, ar.created_at) ${to.exclusive ? '<' : '<='} ?`);
      params.push(to.value);
    }
    if (q) {
      const like = `%${q}%`;
      where.push('(ar.id LIKE ? OR ar.model LIKE ? OR ar.executor LIKE ? OR ar.error_code LIKE ? OR t.task_no LIKE ? OR t.title LIKE ?)');
      params.push(like, like, like, like, like, like);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const baseFrom = `
      FROM agent_runs ar
      LEFT JOIN tasks t ON t.id = ar.task_id
      LEFT JOIN projects p ON p.id = ar.project_id
    `;

    const total = Number((this.db.prepare(`SELECT COUNT(*) AS c ${baseFrom} ${whereSql}`).get(...params) as { c: number }).c) || 0;
    const rows = this.db.prepare(`
      SELECT ar.*, t.task_no, t.title AS task_title, p.name AS project_name,
             (SELECT COUNT(*) FROM agent_run_steps s WHERE s.run_id = ar.id) AS step_count
      ${baseFrom}
      ${whereSql}
      ORDER BY COALESCE(ar.started_at, ar.created_at) DESC, ar.created_at DESC, ar.id ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as RunListRow[];

    return {
      items: rows.map((row) => ({
        id: row.id,
        taskId: row.task_id,
        taskNo: row.task_no ?? null,
        taskTitle: row.task_title ?? null,
        projectId: row.project_id,
        projectName: row.project_name ?? null,
        queueId: row.queue_id,
        parentRunId: row.parent_run_id,
        status: asRunStatus(row.status),
        triggerType: asTriggerType(row.trigger_type),
        model: row.model ?? '',
        promptVersion: row.prompt_version ?? '',
        tokens: Number.isFinite(row.tokens) ? Math.max(0, row.tokens) : 0,
        cost: Number.isFinite(row.cost) ? Math.max(0, row.cost) : 0,
        executor: row.executor ?? '',
        startedAt: row.started_at,
        endedAt: row.ended_at,
        durationMs: durationMs(row.started_at, row.ended_at),
        errorCode: row.error_code ?? '',
        legacySource: asLegacySource(row.legacy_source),
        legacyRef: row.legacy_ref ?? '',
        legacy: Boolean(row.legacy_source),
        stepCount: Number.isFinite(row.step_count) ? Math.max(0, row.step_count) : 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      total,
      limit,
      offset,
      generatedAt: new Date().toISOString(),
    };
  }
}
