/**
 * T06246/T06248（十期 · 派发入口与自动触发）：跨通道派发审计。
 *
 * queue_jobs 仍是执行状态的唯一权威；本表只回答「谁在什么时候、因为什么、
 * 把哪条任务交给了哪个通道」。表内不存任务正文、不存 token / 口令。
 */
import { getDb } from '../db/connection';
import { v4 as uuid } from 'uuid';
import type { DispatchChannelCode } from './DispatchChannels';

export interface DispatchAttemptRow {
  id: string;
  task_id: string;
  task_no: string | null;
  channel: string;
  state: string;
  queue_id: string | null;
  job_id: string | null;
  ticket: string | null;
  fallback_reason: string;
  detail: string;
  actor: string;
  idempotency_key: string;
  created_at: string;
}

export interface DispatchAttemptInput {
  taskId: string;
  taskNo: string | null;
  channel: DispatchChannelCode;
  state: string;
  queueId?: string;
  jobId?: string;
  ticket?: string;
  fallbackReason?: string;
  detail?: string;
  actor: 'manual' | 'auto' | 'api';
  idempotencyKey?: string;
}

/** 审计字段脱敏：只处理常见凭据形态，不尝试理解业务正文。 */
function redact(value: string | undefined): string {
  return (value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|password|passwd|token|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)([^/\s@]+)@/gi, '$1[REDACTED]@');
}

export function recordAttempt(input: DispatchAttemptInput): string {
  const id = uuid();
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO dispatch_attempts
       (id, task_id, task_no, channel, state, queue_id, job_id, ticket,
        fallback_reason, detail, actor, idempotency_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.taskId,
    input.taskNo,
    input.channel,
    input.state,
    input.queueId ?? null,
    input.jobId ?? null,
    input.ticket ?? null,
    redact(input.fallbackReason),
    redact(input.detail),
    input.actor,
    input.idempotencyKey ?? '',
    now,
  );
  // 任务级回显与冷却共用同一时刻；手动派发也走这条，自动调度会尊重它。
  getDb().prepare(
    'UPDATE tasks SET dispatch_last_at = ?, dispatch_last_state = ?, updated_at = ? WHERE id = ?',
  ).run(now, input.state, now, input.taskId);
  return id;
}

export function listAttempts(opts: { taskId?: string; taskNo?: string; limit?: number } = {}): DispatchAttemptRow[] {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 10));
  if (opts.taskId) {
    return getDb().prepare(
      'SELECT * FROM dispatch_attempts WHERE task_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(opts.taskId, limit) as DispatchAttemptRow[];
  }
  if (opts.taskNo) {
    return getDb().prepare(
      'SELECT * FROM dispatch_attempts WHERE task_no = ? ORDER BY created_at DESC LIMIT ?',
    ).all(opts.taskNo, limit) as DispatchAttemptRow[];
  }
  return getDb().prepare('SELECT * FROM dispatch_attempts ORDER BY created_at DESC LIMIT ?').all(limit) as DispatchAttemptRow[];
}

/** 幂等命中：同一 key 在时间窗内已落过审计即拒绝重复提交。 */
export function findRecentIdempotency(key: string, sinceIso: string): DispatchAttemptRow | null {
  const trimmed = (key ?? '').trim();
  if (!trimmed) return null;
  const row = getDb().prepare(
    `SELECT * FROM dispatch_attempts
      WHERE idempotency_key = ? AND created_at >= ?
      ORDER BY created_at DESC LIMIT 1`,
  ).get(trimmed, sinceIso) as DispatchAttemptRow | undefined;
  return row ?? null;
}

/** 本日（本地时区）成功/失败/跳过计数：running/done/ready 视为成功受理；manual 视为跳过自动链路。 */
export function todayCounts(): { success: number; failed: number; skipped: number } {
  const localMidnight = new Date();
  localMidnight.setHours(0, 0, 0, 0);
  const rows = getDb().prepare(
    `SELECT state, COUNT(*) AS n FROM dispatch_attempts
      WHERE created_at >= ? GROUP BY state`,
  ).all(localMidnight.toISOString()) as Array<{ state: string; n: number }>;
  let success = 0;
  let failed = 0;
  let skipped = 0;
  for (const row of rows) {
    if (row.state === 'running' || row.state === 'done' || row.state === 'ready') success += row.n;
    else if (row.state === 'failed') failed += row.n;
    else skipped += row.n;
  }
  return { success, failed, skipped };
}

/** 每天一次清理；保留天数 0 表示不清理。 */
export function cleanupAttempts(retentionDays: number): number {
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const c = getDb().prepare('DELETE FROM dispatch_attempts WHERE created_at < ?').run(cutoff);
  return Number(c.changes ?? 0);
}
