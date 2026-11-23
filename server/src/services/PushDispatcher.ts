/**
 * T05747（A+B0+D 组合 · 总调度）：PushDispatcher——把一条 MTask 待办按「B0 主链路 → A 兜底 → D 应急」路由。
 *
 * T06246/T06247/T06255/T06264（十期）：在原路由上补三件事：
 * 1) 每次通道尝试写 dispatch_attempts（跨通道审计，不替代 queue_jobs）；
 * 2) 增加 options：actor / allowD / allowFallbackA / idempotencyKey，自动调度与 API 可禁 D；
 * 3) 返回稳定错误码与 attemptId，前端不再靠中文 detail 猜分支。
 *
 * 通道语义：
 * - B0：复用 RelayDispatchService.dispatchTask（Queue + submit/poll/ticket 状态机），
 *       platform 固定 `codebuddy-gateway`，工具 id 显式传入；
 * - A：把任务放回 MCP 就绪池（monitor_ready=1, ai_state=''），等外部 Agent 拉取；
 * - D：不自动开 GUI。仅标记 failed + monitor_preferred_platform='d-gui'，等人工确认。
 *
 * 审计：dispatch_attempts 是跨通道查询源；logService 仍保留结构化 JSON 供日志页检索。
 */
import { getDb } from '../db/connection';
import { getSetting } from './AppSettings';
import { TaskService, type TaskView } from './TaskService';
import { dispatchTask, armReady, type RelayDispatchResult } from './RelayDispatchService';
import { logService } from './LogService';
import { recordAttempt, findRecentIdempotency } from './DispatchAttempts';
import { readPolicy, resolveB0Tool, sanitizeEndpoint, type DispatchPolicy } from './DispatchPolicy';

const B0_PLATFORM = 'codebuddy-gateway';
const A_PLATFORM = 'mcp';
const D_PLATFORM = 'd-gui';

export type DispatchChannel = 'auto' | 'b0' | 'a' | 'd';
export type DispatchState = 'running' | 'done' | 'ready' | 'manual' | 'failed';
export type DispatchActor = 'manual' | 'auto' | 'api';

export interface DispatchAttempt {
  channel: 'B0' | 'A' | 'D';
  ok: boolean;
  state: DispatchState;
  detail: string;
  queueId?: string;
  jobId?: string;
  ticket?: string;
  /** 稳定错误码（成功时为空） */
  code?: string;
  /** 本次通道尝试的审计行 id */
  attemptId?: string;
}

export interface DispatchResult {
  ok: boolean;
  taskNo: string;
  state: DispatchState;
  /** 最终落点通道；auto 时取实际成功的那个 */
  channel: 'B0' | 'A' | 'D';
  attempts: DispatchAttempt[];
  /** B0 失败转 A 的原因（成功走 B0/A 且无降级时为空） */
  fallbackReason?: string;
  detail: string;
  code?: string;
  /** 最后一次通道尝试的审计行 id（兼容 P1 响应字段） */
  attemptId?: string;
}

export interface DispatchOptions {
  actor?: DispatchActor;
  /** 自动/API 必须 false；手动 D 仍由前端二次确认后调用 channel='d' */
  allowD?: boolean;
  /** B0 失败后是否允许归位 A；自动策略读 dispatch.allowFallbackA */
  allowFallbackA?: boolean;
  idempotencyKey?: string;
}

function audit(event: Record<string, unknown>): void {
  try {
    logService.log('INFO', 'dispatch', JSON.stringify(event));
  } catch { /* 审计日志失败不得阻断派发 */ }
}

/** 按 taskNo 或内部 id 查任务（路由/脚本两种引用方式都接受） */
function lookupTask(ref: string): TaskView | null {
  const key = (ref ?? '').trim();
  if (!key) return null;
  const byId = TaskService.getById(key);
  if (byId) return byId;
  const row = getDb().prepare('SELECT id FROM tasks WHERE task_no = ?').get(key) as { id: string } | undefined;
  return row ? TaskService.getById(row.id) : null;
}

/** task_no 在 TaskView 里可空（历史数据），审计/文案统一回退到内部 id */
function taskLabel(task: TaskView): string {
  return task.task_no ?? task.id;
}

/** 派发前置校验：只接 todo/未归档/非执行中；已 done 的任务需先重新打开 */
function ensureDispatchable(task: TaskView): { code: string; detail: string } | null {
  const no = task.task_no ?? task.id;
  if (task.archived) return { code: 'TASK_ARCHIVED', detail: `任务 ${no} 已归档，不能派发` };
  if (task.status !== 'todo') return { code: 'TASK_NOT_TODO', detail: `任务 ${no} 当前 status=${task.status}，仅 todo 可派发` };
  if (task.ai_state === 'running') return { code: 'TASK_RUNNING', detail: `任务 ${no} 正在执行中（ai_state=running），避免双跑已拒绝` };
  return null;
}

/** 失败文本 → 稳定错误码；不把原始响应体塞进 UI。 */
function classifyB0Error(detail: string): string {
  if (/未配置|未命中|不提供模型列表/i.test(detail)) return 'B0_NOT_CONFIGURED';
  if (/401|403|鉴权|Authentication|Unauthorized|口令/i.test(detail)) return 'B0_AUTH_FAILED';
  if (/超时|timeout|ETIMEDOUT/i.test(detail)) return 'B0_TIMEOUT';
  if (/结果流|SSE|已结束且未捕获/i.test(detail)) return 'B0_STREAM_LOST';
  return 'B0_UNREACHABLE';
}

/** A 兜底：把任务放回 MCP 就绪池；若 B0 失败时 RelayDispatch 已归位，则不重复自增 monitor_retry */
function tryA(task: TaskView, reason: string | undefined): DispatchAttempt {
  try {
    const current = TaskService.getById(task.id);
    if (!current) return { channel: 'A', ok: false, state: 'failed', detail: '任务已不存在，无法归位就绪池', code: 'TASK_NOT_FOUND' };
    const ready = getDb().prepare('SELECT monitor_ready FROM tasks WHERE id = ?').get(task.id) as { monitor_ready: number } | undefined;
    if (!ready || ready.monitor_ready !== 1) armReady(task.id, A_PLATFORM);
    audit({
      event: 'dispatch', taskNo: taskLabel(task), channel: 'A', attempt: 1, state: 'ready',
      fallbackReason: reason ?? '', detail: '任务已归位 MCP 就绪池，等待平台拉取',
    });
    return {
      channel: 'A',
      ok: true,
      state: 'ready',
      detail: `已退回 MCP 就绪池（monitor_ready=1），等待外部 Agent 拉取${reason ? `；B0 失败原因：${reason}` : ''}`,
    };
  } catch (e) {
    return {
      channel: 'A',
      ok: false,
      state: 'failed',
      detail: `归位 MCP 就绪池失败：${e instanceof Error ? e.message : String(e)}`,
      code: 'A_NOT_READY',
    };
  }
}

/** D 应急：不自动开 GUI，只置失败态等待人工确认；T05749 落地后由 GUI 直驱读取该标记 */
function escalateD(task: TaskView, reason: string): DispatchAttempt {
  try {
    const ts = new Date().toISOString();
    getDb().prepare(
      `UPDATE tasks SET ai_state = 'failed', ai_state_at = ?, exec_session_id = NULL,
              monitor_ready = 0, monitor_preferred_platform = ?, updated_at = ?
        WHERE id = ?`,
    ).run(ts, D_PLATFORM, ts, task.id);
    audit({
      event: 'dispatch', taskNo: taskLabel(task), channel: 'D', attempt: 1, state: 'manual',
      fallbackReason: reason, detail: 'B0/A 均不可用，已标记人工确认（GUI 直驱未自动执行）',
    });
    return {
      channel: 'D',
      ok: false,
      state: 'manual',
      detail: `B0/A 均不可用，已转 D 应急：任务标记 ai_state=failed、monitor_preferred_platform=${D_PLATFORM}，需人工确认后执行 GUI 直驱。原因：${reason}`,
      code: 'D_MANUAL_ONLY',
    };
  } catch (e) {
    return {
      channel: 'D',
      ok: false,
      state: 'failed',
      detail: `转 D 应急失败：${e instanceof Error ? e.message : String(e)}`,
      code: 'D_MANUAL_ONLY',
    };
  }
}

function toAttempt(r: RelayDispatchResult): DispatchAttempt {
  return {
    channel: 'B0',
    ok: r.ok,
    // 审计口径：失败统一落 failed，避免 dispatch_attempts 里出现「ready 但其实没派出去」导致重试上限失效
    state: r.ok ? r.state : 'failed',
    detail: r.detail,
    queueId: r.queueId,
    jobId: r.jobId,
    ticket: r.ticket,
    code: r.ok ? undefined : classifyB0Error(r.detail),
  };
}

/** 每条通道尝试落审计；attemptId 会回填到响应，供前端直接定位。 */
function persistAttempt(
  task: TaskView,
  attempt: DispatchAttempt,
  actor: DispatchActor,
  idempotencyKey: string | undefined,
  fallbackReason?: string,
): DispatchAttempt {
  try {
    const id = recordAttempt({
      taskId: task.id,
      taskNo: task.task_no,
      channel: attempt.channel,
      state: attempt.state,
      queueId: attempt.queueId,
      jobId: attempt.jobId,
      ticket: attempt.ticket,
      fallbackReason,
      detail: attempt.detail,
      actor,
      idempotencyKey,
    });
    attempt.attemptId = id;
  } catch (e) {
    // 审计失败不得阻断派发，但要在日志里可见，避免「UI 有结果、审计没记录」静默漂移
    audit({ event: 'dispatch_attempt_write_failed', taskNo: taskLabel(task), channel: attempt.channel, detail: String(e) });
  }
  return attempt;
}

/**
 * 派发入口。channel 默认 auto（B0→A→D）；显式指定时只走该通道（b0 失败不降级）。
 * options 让自动调度显式禁 D；手动入口沿用默认 allowD=true（D 仍需用户显式选 channel='d'）。
 */
export async function dispatch(
  taskRef: string,
  channel: DispatchChannel = 'auto',
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  const task = lookupTask(taskRef);
  if (!task) {
    return {
      ok: false, taskNo: taskRef, state: 'failed', channel: 'B0', attempts: [],
      detail: `任务不存在：${taskRef}`, code: 'TASK_NOT_FOUND',
    };
  }
  const invalid = ensureDispatchable(task);
  const idem = (options.idempotencyKey ?? '').trim();
  // 幂等优先于状态机：首次 B0 已把任务置 running 时，同一键重试应返回「已受理」而不是 TASK_RUNNING
  if (idem) {
    const recent = findRecentIdempotency(idem, new Date(Date.now() - 5 * 60_000).toISOString());
    if (recent) {
      return {
        ok: false,
        taskNo: taskLabel(task),
        state: recent.state as DispatchState,
        channel: recent.channel as 'B0' | 'A' | 'D',
        attempts: [{
          channel: recent.channel as 'B0' | 'A' | 'D',
          ok: recent.state === 'running' || recent.state === 'done' || recent.state === 'ready',
          state: recent.state as DispatchState,
          detail: recent.detail || '相同幂等键的首次派发记录',
          queueId: recent.queue_id ?? undefined,
          jobId: recent.job_id ?? undefined,
          ticket: recent.ticket ?? undefined,
          attemptId: recent.id,
        }],
        detail: '相同幂等键的派发请求已受理，请勿重复提交',
        code: 'DISPATCH_DUPLICATE',
        attemptId: recent.id,
      };
    }
  }
  if (invalid) {
    return {
      ok: false, taskNo: taskLabel(task), state: 'failed', channel: 'B0', attempts: [], detail: invalid.detail, code: invalid.code,
    };
  }

  const actor = options.actor ?? 'manual';
  const allowD = options.allowD ?? true;
  const allowFallbackA = options.allowFallbackA ?? true;

  const attempts: DispatchAttempt[] = [];
  let fallbackReason: string | undefined;
  let lastAttemptId: string | undefined;

  // 1) B0 主链路
  if (channel === 'auto' || channel === 'b0') {
    const { tool, reason } = resolveB0Tool();
    if (!tool) {
      fallbackReason = reason ?? 'B0 工具未配置';
      const a: DispatchAttempt = {
        channel: 'B0', ok: false, state: 'failed', detail: `B0 未派发：${fallbackReason}`, code: 'B0_NOT_CONFIGURED',
      };
      attempts.push(persistAttempt(task, a, actor, idem, fallbackReason));
      lastAttemptId = a.attemptId;
      audit({ event: 'dispatch', taskNo: taskLabel(task), channel: 'B0', attempt: 1, state: 'ready', fallbackReason, actor });
      if (channel === 'b0') {
        return { ok: false, taskNo: taskLabel(task), state: 'ready', channel: 'B0', attempts, fallbackReason, detail: a.detail, code: a.code, attemptId: lastAttemptId };
      }
    } else {
      let r: RelayDispatchResult;
      try {
        r = await dispatchTask(task.id, B0_PLATFORM, tool.id, 'dispatch');
      } catch (e) {
        r = {
          ok: false, state: 'ready', detail: `B0 派发异常：${e instanceof Error ? e.message : String(e)}`,
        };
      }
      const a = persistAttempt(task, toAttempt(r), actor, idem, fallbackReason);
      lastAttemptId = a.attemptId;
      attempts.push(a);
      audit({
        event: 'dispatch', taskNo: taskLabel(task), channel: 'B0', attempt: 1, state: r.state,
        detail: r.detail, queueId: r.queueId, jobId: r.jobId, ticket: r.ticket, actor,
      });
      if (a.ok) {
        return {
          ok: true, taskNo: taskLabel(task), state: a.state, channel: 'B0',
          attempts, detail: a.detail, attemptId: lastAttemptId,
        };
      }
      fallbackReason = r.detail;
      if (channel === 'b0') {
        return { ok: false, taskNo: taskLabel(task), state: a.state, channel: 'B0', attempts, fallbackReason, detail: a.detail, code: a.code, attemptId: lastAttemptId };
      }
    }
  }

  // 2) A 兜底（拉取式就绪池）
  if ((channel === 'auto' || channel === 'a') && allowFallbackA) {
    const a = persistAttempt(task, tryA(task, fallbackReason), actor, idem, fallbackReason);
    lastAttemptId = a.attemptId;
    attempts.push(a);
    if (a.ok) {
      return {
        ok: true, taskNo: taskLabel(task), state: 'ready', channel: 'A',
        attempts, fallbackReason, detail: a.detail, attemptId: lastAttemptId,
      };
    }
    fallbackReason = `${fallbackReason ? `${fallbackReason}；` : ''}${a.detail}`;
    if (channel === 'a') {
      return { ok: false, taskNo: taskLabel(task), state: a.state, channel: 'A', attempts, fallbackReason, detail: a.detail, code: a.code, attemptId: lastAttemptId };
    }
  }

  // 3) D 应急（仅人工/显式请求；自动与 API 一律不自动 D）
  if (!allowD) {
    return {
      ok: false, taskNo: taskLabel(task), state: 'failed', channel: 'A', attempts,
      fallbackReason, detail: '自动派发失败；D 通道仅人工确认，不自动执行。请检查 B0/A 或人工处理',
      code: 'D_MANUAL_ONLY', attemptId: lastAttemptId,
    };
  }
  const d = persistAttempt(task, escalateD(task, fallbackReason ?? '显式指定 D 应急'), actor, idem, fallbackReason);
  lastAttemptId = d.attemptId;
  attempts.push(d);
  return {
    ok: false, taskNo: taskLabel(task), state: d.state, channel: 'D',
    attempts, fallbackReason, detail: d.detail, code: d.code, attemptId: lastAttemptId,
  };
}

/** 自动调度专用入口：强制禁 D，可读策略决定是否允许 A 兜底。 */
export function dispatchAuto(
  taskRef: string,
  policy: DispatchPolicy,
  idempotencyKey?: string,
  actor: DispatchActor = 'auto',
): Promise<DispatchResult> {
  return dispatch(taskRef, policy.defaultChannel, {
    actor,
    allowD: false,
    allowFallbackA: policy.allowFallbackA,
    idempotencyKey,
  });
}

/** 只读状态：供设置页/脚本判断 B0 是否就绪、A 是否开启、D 是否待人工 */
export function status() {
  const policy = readPolicy();
  const b0 = resolveB0Tool(policy);
  const supervisorEnabled = getSetting('supervisor.enabled') === '1';
  const readyCount = getDb().prepare(
    'SELECT COUNT(*) AS n FROM tasks WHERE monitor_ready = 1 AND archived = 0 AND status = \'todo\'',
  ).get() as { n: number };
  const failedCount = getDb().prepare(
    'SELECT COUNT(*) AS n FROM tasks WHERE ai_state = \'failed\' AND monitor_preferred_platform = \'d-gui\' AND archived = 0',
  ).get() as { n: number };
  return {
    defaultChannel: policy.defaultChannel as DispatchChannel,
    order: ['B0', 'A', 'D'],
    b0: {
      configured: Boolean(b0.tool),
      toolId: b0.tool?.id ?? null,
      toolName: b0.tool?.name ?? null,
      endpoint: sanitizeEndpoint(b0.tool?.endpoint),
      reason: b0.reason ?? null,
    },
    a: {
      supervisorEnabled,
      readyTasks: readyCount.n,
      note: '手动指定 Txxxx 不依赖 monitor_ready；自动排水需 supervisor.enabled=true 或 T05741 的 readyMarkEnabled 解耦',
    },
    d: {
      manualOnly: true,
      failedTasks: failedCount.n,
      platform: D_PLATFORM,
    },
    auto: {
      enabled: policy.autoEnabled,
      runnable: policy.autoEnabled && policy.scopeProjectIds.length > 0 && Boolean(b0.tool),
      defaultChannel: policy.defaultChannel,
      b0ToolId: policy.b0ToolId,
      scopeProjectIds: policy.scopeProjectIds,
      trigger: policy.trigger,
      intervalMs: policy.intervalMs,
      cooldownMs: policy.cooldownMs,
      maxPerTick: policy.maxPerTick,
      maxAttempts: policy.maxAttempts,
      allowFallbackA: policy.allowFallbackA,
      allowAutoD: false,
      retentionDays: policy.retentionDays,
    },
  };
}

export const PushDispatcher = { dispatch, dispatchAuto, status };
