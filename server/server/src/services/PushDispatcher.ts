/**
 * T05747（A+B0+D 组合 · 总调度）：PushDispatcher——把一条 MTask 待办按「B0 主链路 → A 兜底 → D 应急」路由。
 *
 * 为什么需要独立调度层：B0（CodeBuddy 本地网关直推）是推送，A（MCP 就绪池）是拉取，
 * 两者失败语义完全不同；D 是人工确认的 GUI 直驱，绝不能自动执行。把路由、降级原因、
 * 尝试记录集中在一处，避免 RelayDispatchService / SupervisorExecutor / 路由层各写一套。
 *
 * 通道语义：
 * - B0：复用 RelayDispatchService.dispatchTask（Queue + submit/poll/ticket 状态机），
 *       platform 固定 `codebuddy-gateway`，工具 id 显式传入；
 * - A：把任务放回 MCP 就绪池（monitor_ready=1, ai_state=''），等外部 Agent 拉取；
 *       手动指定 Txxxx 本来就零代码可用（claimTask 不要求 monitor_ready），A 是自动排水的兜底；
 * - D：不自动开 GUI。仅把任务标 failed + monitor_preferred_platform='d-gui'，等人工确认后
 *       由 T05749 的 GUI 直驱能力执行；三通道都不可用时才走到这里。
 *
 * 审计：每次尝试写一条 `dispatch` 日志（taskNo/channel/attempt/state/queueId/jobId/ticket/
 * fallbackReason），runId 同时落在 queue_jobs.ticket，可由队列视图回溯；不新增表。
 */
import { getDb } from '../db/connection';
import { getSetting } from './AppSettings';
import { ConfigService } from './ConfigService';
import { TaskService, type TaskView } from './TaskService';
import { dispatchTask, armReady, type RelayDispatchResult } from './RelayDispatchService';
import { logService } from './LogService';

const B0_PLATFORM = 'codebuddy-gateway';
const A_PLATFORM = 'mcp';
const D_PLATFORM = 'd-gui';
const B0_TOOL_KEY = 'dispatch.b0ToolId';

export type DispatchChannel = 'auto' | 'b0' | 'a' | 'd';
export type DispatchState = 'running' | 'done' | 'ready' | 'manual' | 'failed';

export interface DispatchAttempt {
  channel: 'B0' | 'A' | 'D';
  ok: boolean;
  state: DispatchState;
  detail: string;
  queueId?: string;
  jobId?: string;
  ticket?: string;
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
}

interface AIToolLite {
  id: string;
  name: string;
  type: string;
  endpoint?: string;
  enabled?: boolean;
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
function ensureDispatchable(task: TaskView): string | null {
  const no = task.task_no ?? task.id;
  if (task.archived) return `任务 ${no} 已归档，不能派发`;
  if (task.status !== 'todo') return `任务 ${no} 当前 status=${task.status}，仅 todo 可派发`;
  if (task.ai_state === 'running') return `任务 ${no} 正在执行中（ai_state=running），避免双跑已拒绝`;
  return null;
}

/** 找 B0 工具：显式配置优先；否则取第一条 enabled 的 codebuddy-gateway 工具 */
function resolveB0Tool(): { tool: AIToolLite | null; reason?: string } {
  const tools = ConfigService.list() as unknown as AIToolLite[];
  const candidates = tools.filter((t) => t.type === B0_PLATFORM && t.enabled !== false);
  const preferredId = (getSetting(B0_TOOL_KEY) ?? '').trim();
  if (preferredId) {
    const hit = candidates.find((t) => t.id === preferredId);
    if (!hit) return { tool: null, reason: `配置 ${B0_TOOL_KEY}=${preferredId} 未命中 enabled 的 ${B0_PLATFORM} 工具` };
    return { tool: hit };
  }
  if (!candidates.length) return { tool: null, reason: `未配置 ${B0_PLATFORM} 类型的 AI 工具` };
  return { tool: candidates[0] };
}

/** A 兜底：把任务放回 MCP 就绪池；若 B0 失败时 RelayDispatch 已归位，则不重复自增 monitor_retry */
function tryA(task: TaskView, reason: string | undefined): DispatchAttempt {
  try {
    const current = TaskService.getById(task.id);
    if (!current) return { channel: 'A', ok: false, state: 'failed', detail: '任务已不存在，无法归位就绪池' };
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
    };
  } catch (e) {
    return {
      channel: 'D',
      ok: false,
      state: 'failed',
      detail: `转 D 应急失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

function toAttempt(r: RelayDispatchResult): DispatchAttempt {
  return {
    channel: 'B0',
    ok: r.state === 'running' || r.state === 'done',
    state: r.state,
    detail: r.detail,
    queueId: r.queueId,
    jobId: r.jobId,
    ticket: r.ticket,
  };
}

/**
 * 派发入口。channel 默认 auto（B0→A→D）；显式指定时只走该通道（b0 失败不降级）。
 * 调用方可以是 REST 路由、脚本或后续 supervisor 扩展。
 */
export async function dispatch(taskRef: string, channel: DispatchChannel = 'auto'): Promise<DispatchResult> {
  const task = lookupTask(taskRef);
  if (!task) {
    return {
      ok: false, taskNo: taskRef, state: 'failed', channel: 'B0', attempts: [],
      detail: `任务不存在：${taskRef}`,
    };
  }
  const invalid = ensureDispatchable(task);
  if (invalid) {
    return {
      ok: false, taskNo: taskLabel(task), state: 'failed', channel: 'B0', attempts: [], detail: invalid,
    };
  }

  const attempts: DispatchAttempt[] = [];
  let fallbackReason: string | undefined;

  // 1) B0 主链路
  if (channel === 'auto' || channel === 'b0') {
    const { tool, reason } = resolveB0Tool();
    if (!tool) {
      fallbackReason = reason ?? 'B0 工具未配置';
      const a: DispatchAttempt = {
        channel: 'B0', ok: false, state: 'ready', detail: `B0 未派发：${fallbackReason}`,
      };
      attempts.push(a);
      audit({ event: 'dispatch', taskNo: taskLabel(task), channel: 'B0', attempt: 1, state: 'ready', fallbackReason });
      if (channel === 'b0') {
        return { ok: false, taskNo: taskLabel(task), state: 'ready', channel: 'B0', attempts, fallbackReason, detail: a.detail };
      }
    } else {
      let r: RelayDispatchResult;
      try {
        r = await dispatchTask(task.id, B0_PLATFORM, tool.id);
      } catch (e) {
        r = {
          ok: false, state: 'ready', detail: `B0 派发异常：${e instanceof Error ? e.message : String(e)}`,
        };
      }
      const a = toAttempt(r);
      attempts.push(a);
      audit({
        event: 'dispatch', taskNo: taskLabel(task), channel: 'B0', attempt: 1, state: r.state,
        detail: r.detail, queueId: r.queueId, jobId: r.jobId, ticket: r.ticket,
      });
      if (a.ok) {
        return {
          ok: true, taskNo: taskLabel(task), state: a.state, channel: 'B0',
          attempts, detail: a.detail,
        };
      }
      fallbackReason = r.detail;
      if (channel === 'b0') {
        return { ok: false, taskNo: taskLabel(task), state: a.state, channel: 'B0', attempts, fallbackReason, detail: a.detail };
      }
    }
  }

  // 2) A 兜底（拉取式就绪池）
  if (channel === 'auto' || channel === 'a') {
    const a = tryA(task, fallbackReason);
    attempts.push(a);
    if (a.ok) {
      return {
        ok: true, taskNo: taskLabel(task), state: 'ready', channel: 'A',
        attempts, fallbackReason, detail: a.detail,
      };
    }
    fallbackReason = `${fallbackReason ? `${fallbackReason}；` : ''}${a.detail}`;
    if (channel === 'a') {
      return { ok: false, taskNo: taskLabel(task), state: a.state, channel: 'A', attempts, fallbackReason, detail: a.detail };
    }
  }

  // 3) D 应急（人工确认）
  const d = escalateD(task, fallbackReason ?? '显式指定 D 应急');
  attempts.push(d);
  return {
    ok: false, taskNo: taskLabel(task), state: d.state, channel: 'D',
    attempts, fallbackReason, detail: d.detail,
  };
}

/** 只读状态：供设置页/脚本判断 B0 是否就绪、A 是否开启、D 是否待人工 */
export function status() {
  const b0 = resolveB0Tool();
  const supervisorEnabled = getSetting('supervisor.enabled') === '1';
  const readyCount = getDb().prepare(
    'SELECT COUNT(*) AS n FROM tasks WHERE monitor_ready = 1 AND archived = 0 AND status = \'todo\'',
  ).get() as { n: number };
  const failedCount = getDb().prepare(
    'SELECT COUNT(*) AS n FROM tasks WHERE ai_state = \'failed\' AND monitor_preferred_platform = \'d-gui\' AND archived = 0',
  ).get() as { n: number };
  return {
    defaultChannel: 'auto' as DispatchChannel,
    order: ['B0', 'A', 'D'],
    b0: {
      configured: Boolean(b0.tool),
      toolId: b0.tool?.id ?? null,
      toolName: b0.tool?.name ?? null,
      endpoint: b0.tool?.endpoint ?? null,
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
  };
}

export const PushDispatcher = { dispatch, status };
