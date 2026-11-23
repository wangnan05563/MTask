/**
 * T06259/T06260/T06263/T06269（十期 · 派发入口与自动触发）：自动派发调度器。
 *
 * 独立于 SupervisorService：不调用 LLM、不读 supervisor.enabled；只按 dispatch.* 策略
 * 把「就绪且未被人工锁定」的任务串行交给 PushDispatcher。单飞锁保证一轮未结束时不会叠轮。
 * 进程重启后不重推 sending：候选查询会排除仍挂在 dispatch/relay 队列 sending 的任务，
 * 且 dispatch_last_at 持久化让冷却继续生效。
 */
import { getDb } from '../db/connection';
import { getSetting, setSetting } from './AppSettings';
import { TaskService } from './TaskService';
import { PushDispatcher, type DispatchActor, type DispatchResult } from './PushDispatcher';
import {
  readPolicy, readConfigView, isReadyMarkEnabled, type DispatchPolicy,
} from './DispatchPolicy';
import { listAttempts, cleanupAttempts, todayCounts } from './DispatchAttempts';

export interface DispatchCandidate {
  id: string;
  task_no: string | null;
  title: string;
  project_id: string;
  project_name: string;
  priority: string;
  created_at: string;
  dispatch_auto: number | null;
  dispatch_last_at: string | null;
  dispatch_last_state: string;
  monitor_preferred_platform: string | null;
  cooldown_remaining_ms: number;
  failed_attempts: number;
  eligible: boolean;
  skip_reason: string;
}

export interface AutoTickResult {
  ran: boolean;
  reason: 'ok' | 'disabled' | 'incomplete' | 'ready_mark_disabled' | 'busy' | 'no_candidates' | 'dry_run';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  candidateCount: number;
  dispatched: number;
  success: number;
  failed: number;
  skipped: number;
  candidates: DispatchCandidate[];
  results: Array<{ taskNo: string; ok: boolean; state: string; channel: string; detail: string; code?: string }>;
}

interface RuntimeState {
  running: boolean;
  lastRunAt: string | null;
  lastResult: AutoTickResult | null;
  lastCleanupAt: string | null;
}

const runtime: RuntimeState = {
  running: false,
  lastRunAt: null,
  lastResult: null,
  lastCleanupAt: null,
};

let timer: NodeJS.Timeout | null = null;
let timerIntervalMs = 0;

const PRIORITY_ORDER = "CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4 END";

function iso(msFromNow = 0): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

/** 候选查询（FR-2.3）。空范围=不启用，绝不退化成全量。 */
export function queryCandidates(opts: { projectId?: string; limit?: number; policy?: DispatchPolicy } = {}): DispatchCandidate[] {
  const policy = opts.policy ?? readPolicy();
  if (!policy.scopeProjectIds.length) return [];
  const limit = Math.max(1, Math.min(100, opts.limit ?? policy.maxPerTick));
  const cutoff = iso(-policy.cooldownMs);
  const projectIds = opts.projectId ? policy.scopeProjectIds.filter((id) => id === opts.projectId) : policy.scopeProjectIds;
  if (!projectIds.length) return [];
  const ph = projectIds.map(() => '?').join(',');
  const rows = getDb().prepare(`
    SELECT t.id, t.task_no, t.title, t.project_id, p.name AS project_name, t.priority,
           t.created_at, t.dispatch_auto, t.dispatch_last_at, t.dispatch_last_state,
           t.monitor_preferred_platform
      FROM tasks t JOIN projects p ON p.id = t.project_id
     WHERE t.status = 'todo'
       AND t.archived = 0
       AND COALESCE(t.shelved, 0) = 0
       AND COALESCE(t.ai_state, '') = ''
       AND t.monitor_ready = 1
       AND t.project_id IN (${ph})
       AND COALESCE(t.dispatch_auto, 1) = 1
       AND (t.monitor_preferred_platform IS NULL OR LOWER(TRIM(t.monitor_preferred_platform)) IN ('', 'codebuddy-gateway'))
       AND (COALESCE(t.dispatch_last_at, '') = '' OR t.dispatch_last_at < ?)
       AND NOT EXISTS (
         SELECT 1 FROM queue_jobs j JOIN queues q ON q.id = j.queue_id
          WHERE j.task_id = t.id AND j.status = 'sending' AND COALESCE(q.kind, 'manual') IN ('dispatch', 'relay')
       )
     ORDER BY ${PRIORITY_ORDER}, t.created_at ASC
     LIMIT ?
  `).all(...projectIds, cutoff, Math.max(limit, policy.maxPerTick * 3)) as Omit<DispatchCandidate, 'cooldown_remaining_ms' | 'failed_attempts' | 'eligible' | 'skip_reason'>[];

  return rows.map((row) => {
    const last = row.dispatch_last_at ? new Date(row.dispatch_last_at).getTime() : 0;
    const remaining = Math.max(0, last + policy.cooldownMs - Date.now());
    const failed = (getDb().prepare(
      `SELECT COUNT(*) AS n FROM dispatch_attempts a
        WHERE a.task_id = ? AND a.state = 'failed'
          AND a.created_at > COALESCE((
            SELECT MAX(b.created_at) FROM dispatch_attempts b
             WHERE b.task_id = ? AND b.state IN ('running','done','ready')
          ), '1970-01-01T00:00:00.000Z')`,
    ).get(row.id, row.id) as { n: number }).n;
    const overRetry = failed >= policy.maxAttempts;
    return {
      ...row,
      cooldown_remaining_ms: remaining,
      failed_attempts: failed,
      eligible: remaining === 0 && !overRetry,
      skip_reason: remaining > 0 ? `冷却中，剩余 ${Math.ceil(remaining / 1000)} 秒` : overRetry ? `连续失败 ${failed} 次，已达上限` : '',
    };
  });
}

async function runTick(opts: { force?: boolean; dryRun?: boolean; actor?: DispatchActor; projectId?: string } = {}): Promise<AutoTickResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const actor = opts.actor ?? 'auto';
  const empty = (reason: AutoTickResult['reason'], candidates: DispatchCandidate[] = []): AutoTickResult => ({
    ran: false, reason, startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0,
    candidateCount: candidates.length, dispatched: 0, success: 0, failed: 0, skipped: candidates.length,
    candidates, results: [],
  });

  if (runtime.running) return empty('busy');
  const policy = readPolicy();
  if (!policy.autoEnabled && !opts.force && !opts.dryRun) return empty('disabled');
  if (!policy.scopeProjectIds.length) return empty('incomplete');
  // 试运行只看候选与策略，不要求 B0 已配好；真实派发必须有可用网关
  if (!opts.dryRun && !readConfigView().b0.configured) return empty('incomplete');

  runtime.running = true;
  try {
    // 试运行只读：不能 markMonitorReady（那会改任务），只看当前就绪池
    if (!opts.dryRun && isReadyMarkEnabled()) {
      try { TaskService.markMonitorReady(); } catch { /* 单轮排水失败不阻断派发 */ }
    }
    if (!isReadyMarkEnabled()) return empty('ready_mark_disabled');

    const candidates = queryCandidates({ projectId: opts.projectId, limit: Math.max(policy.maxPerTick * 3, policy.maxPerTick), policy });
    const eligible = candidates.filter((c) => c.eligible).slice(0, policy.maxPerTick);
    if (opts.dryRun) {
      const result: AutoTickResult = {
        ...empty('dry_run', candidates),
        candidates: eligible,
        candidateCount: candidates.length,
        skipped: candidates.length - eligible.length,
      };
      runtime.lastResult = result;
      return result;
    }
    if (!eligible.length) {
      runtime.lastRunAt = new Date().toISOString();
      setSetting('dispatch.auto.lastRunAt', runtime.lastRunAt);
      const result = { ...empty('no_candidates', candidates), skipped: candidates.length };
      result.ran = true;
      runtime.lastResult = result;
      return result;
    }

    const results: AutoTickResult['results'] = [];
    let success = 0;
    let failed = 0;
    const skipped = candidates.length - eligible.length;
    for (const candidate of eligible) {
      const idempotencyKey = `${candidate.task_no ?? candidate.id}:auto:${Math.floor(Date.now() / (policy.cooldownMs || 300_000))}`;
      const r: DispatchResult = await PushDispatcher.dispatchAuto(candidate.id, policy, idempotencyKey, actor);
      const ok = r.ok && r.state !== 'failed';
      if (ok) success += 1; else failed += 1;
      results.push({ taskNo: candidate.task_no ?? candidate.id, ok: r.ok, state: r.state, channel: r.channel, detail: r.detail, code: r.code });
    }
    const finishedAt = new Date().toISOString();
    runtime.lastRunAt = finishedAt;
    setSetting('dispatch.auto.lastRunAt', finishedAt);
    const result: AutoTickResult = {
      ran: true,
      reason: 'ok',
      startedAt,
      finishedAt,
      durationMs: Date.now() - t0,
      candidateCount: candidates.length,
      dispatched: results.length,
      success,
      failed,
      skipped,
      candidates,
      results,
    };
    runtime.lastResult = result;
    maybeCleanup(policy.retentionDays);
    return result;
  } finally {
    runtime.running = false;
  }
}

function maybeCleanup(retentionDays: number): void {
  const today = new Date().toISOString().slice(0, 10);
  if (runtime.lastCleanupAt?.slice(0, 10) === today) return;
  try {
    cleanupAttempts(retentionDays);
    runtime.lastCleanupAt = new Date().toISOString();
  } catch { /* 清理失败不影响派发 */ }
}

function scheduleNext(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const policy = readPolicy();
  timerIntervalMs = policy.intervalMs;
  timer = setTimeout(() => {
    void runTick().catch((e) => {
      console.error('[dispatch] auto tick failed:', e);
    }).finally(() => scheduleNext());
  }, policy.intervalMs);
  // 后台定时器不应单独吊住进程退出（Electron 主进程关闭时随 app 退出）
  timer.unref?.();
}

export const DispatchScheduler = {
  startScheduler(): void {
    if (timer) clearTimeout(timer);
    runtime.lastCleanupAt = runtime.lastCleanupAt ?? null;
    scheduleNext();
  },

  /** 配置保存后热重载周期；正在跑的一轮不受影响，下一轮按新周期排。 */
  reload(): void {
    scheduleNext();
  },

  stopScheduler(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  },

  tick(opts: { force?: boolean; dryRun?: boolean; actor?: DispatchActor; projectId?: string } = {}): Promise<AutoTickResult> {
    return runTick(opts);
  },

  candidates(opts: { projectId?: string; limit?: number } = {}): DispatchCandidate[] {
    return queryCandidates(opts);
  },

  runtimeStatus() {
    const policy = readPolicy();
    const today = todayCounts();
    const candidates = policy.scopeProjectIds.length ? queryCandidates({ policy }) : [];
    const lastRunAt = runtime.lastRunAt ?? (getSetting('dispatch.auto.lastRunAt') || null);
    return {
      running: runtime.running,
      lastRunAt,
      nextRunAt: timer ? new Date(Date.now() + timerIntervalMs).toISOString() : null,
      intervalMs: policy.intervalMs,
      lastResult: runtime.lastResult,
      candidates: candidates.length,
      eligibleCandidates: candidates.filter((c) => c.eligible).length,
      today,
    };
  },

  recentAttempts(limit = 20) {
    return listAttempts({ limit });
  },
};

export function startDispatchScheduler(): void {
  DispatchScheduler.startScheduler();
}
