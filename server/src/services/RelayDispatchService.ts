/**
 * T01283（PRD FR-3.6）：**推送式兜底派发**——给不支持 MCP 拉取的平台一条「主动推进去」的通道。
 *
 * 为什么需要兜底：FR-3.1/FR-3.3 的自动闭环建立在「平台是 MCP 客户端、会周期来拉就绪待办」这一前提上。
 * 若目标平台没有 MCP 客户端（黑盒 / 只有中继 endpoint），RESUME 只标 `monitor_ready=1` 等于把任务
 * 放进一个没人来取的池子——排水永久停滞且**静默**（面板上任务看着「就绪」，实际无人执行）。
 * 本模块用既有中继链路补齐这一环：复用 `QueueService` 的 submit/poll/ticket 状态机与
 * `WorkBuddyAdapter.submit`，**不新造派发协议**（方案设计 §5「推送式」一行）。
 *
 * 通道选择由配置显式声明，默认不启用 → 零回归（既有回环仍走拉取式）：
 * - `supervisor.relayPlatforms`：视为「不支持 MCP」的平台名清单（逗号分隔，如 `wb-relay,dingtalk`）；
 * - `supervisor.relayToolId`：承载派发的中继型 AI 工具 id（type=workbuddy，带 endpoint/model）。
 *
 * 派发后任务必须**退出就绪池**（`monitor_ready=0`）：否则同一任务既被推给中继、又留在池里等
 * MCP 平台拉取，形成双份执行——这与 `mtask_claim_task` 的「认领即出池」是同一防护语义。
 */
import { getDb } from '../db/connection';
import { getSetting } from './AppSettings';
import { normalizePlatform } from '../util/platform'; // T01288：平台标识归一化统一口径
import { QueueService } from './QueueService';
import { AIService } from './AIService';
import { logService } from './LogService';

/** 视为「不支持 MCP 拉取」的平台名清单 */
const RELAY_PLATFORMS_KEY = 'supervisor.relayPlatforms';
/** 承载推送派发的中继型 AI 工具 id */
const RELAY_TOOL_KEY = 'supervisor.relayToolId';

export interface RelayDispatchResult {
  ok: boolean;
  /**
   * 派发后任务归属：
   * - running：中继已受理（拿到 ticket），结果待 poller 收敛；
   * - done：中继同步返回结果（队列已按 sync 路径收口）；
   * - ready：推送未成（未配置工具 / 提交失败），任务退回就绪池等下一轮
   */
  state: 'running' | 'done' | 'ready';
  queueId?: string;
  jobId?: string;
  ticket?: string;
  detail: string;
}

/** 逗号分隔配置 → 归一化平台名列表（T01288：与请求侧同用 normalizePlatform，避免大小写口径分歧） */
function readList(key: string): string[] {
  const raw = getSetting(key) ?? '';
  return raw.split(',').map((s) => normalizePlatform(s)).filter(Boolean);
}

/** 该平台是否被声明为「不支持 MCP 拉取、需推送兜底」 */
export function isRelayPlatform(platform: string | undefined): boolean {
  const p = normalizePlatform(platform);
  if (!p) return false;
  return readList(RELAY_PLATFORMS_KEY).includes(p);
}

/** 任务归位：把派发结果写回任务行（monitor_ready 出/入池 + 重试计数自增，语义同 SupervisorExecutor） */
function armTask(taskId: string, platform: string, state: RelayDispatchResult['state']): void {
  const db = getDb();
  const ts = new Date().toISOString();
  // 就绪态退回 = RESUME 的「重新武装」（清 ai_state 让平台能再次认领）；running/done = 已出池
  const sql = state === 'ready'
    ? `UPDATE tasks SET ai_state = '', ai_state_at = '', exec_session_id = NULL, monitor_preferred_platform = ?,
              monitor_ready = 1, monitor_retry = monitor_retry + 1, updated_at = ? WHERE id = ?`
    : `UPDATE tasks SET ai_state = 'running', ai_state_at = ?, exec_session_id = NULL, monitor_preferred_platform = ?,
              monitor_ready = 0, monitor_retry = monitor_retry + 1, updated_at = ? WHERE id = ?`;
  const args = state === 'ready' ? [platform, ts, taskId] : [ts, platform, ts, taskId];
  db.prepare(sql).run(...args);
}

/**
 * 把单条任务经中继推送派发（FR-3.6）。
 * 调用方负责前置校验（任务存在/未归档/待办）——本函数只做派发与状态归位，避免第二套校验口径。
 */
export async function dispatchTask(taskId: string, platform: string): Promise<RelayDispatchResult> {
  const toolId = (getSetting(RELAY_TOOL_KEY) ?? '').trim();
  if (!toolId) {
    const detail = `平台「${platform}」不支持 MCP 拉取，但未配置中继派发工具（${RELAY_TOOL_KEY}），任务保持就绪`;
    logService.log('WARN', 'supervisor', detail);
    return { ok: false, state: 'ready', detail };
  }

  let queueId = '';
  let jobId = '';
  try {
    // 队列是既有派发引擎的载体：一个动作建一条队列（含单 job），复用 submit/poll/ticket 全流程
    const queue = QueueService.create(`监督派发（${platform}）`, new Date().toISOString().slice(0, 10));
    queueId = queue.id;
    const jobs = QueueService.addJobs(queueId, [{ taskId, toolId }]);
    jobId = jobs[0].id;
    await QueueService.submitAll(queueId, AIService.buildSubmitter());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (queueId) armTask(taskId, platform, 'ready');
    logService.log('ERROR', 'supervisor', `推送派发失败：task=${taskId.slice(0, 8)}，平台=${platform}，${msg}`);
    return { ok: false, state: 'ready', queueId: queueId || undefined, jobId: jobId || undefined, detail: `推送派发失败（${msg}），任务退回就绪池` };
  }

  const job = QueueService.getJob(jobId);
  if (!job) {
    armTask(taskId, platform, 'ready');
    return { ok: false, state: 'ready', queueId, jobId, detail: '派发任务行已不存在，任务退回就绪池' };
  }

  if (job.status === 'success') {
    // 同步完成：队列已按 sync 路径收口（`queue.autoCompleteTask` 默认开启时任务同时被置 done）
    armTask(taskId, platform, 'done');
    logService.log('INFO', 'supervisor', `推送派发同步完成：task=${taskId.slice(0, 8)}，平台=${platform}，job=${jobId.slice(0, 8)}`);
    return { ok: true, state: 'done', queueId, jobId, detail: `已推送至「${platform}」并同步返回结果` };
  }

  if (job.status === 'sending') {
    // 异步受理：ticket 已落库，由常驻 poller（index.ts 每 5s 的 pollPending）收敛；任务出就绪池防双跑
    armTask(taskId, platform, 'running');
    logService.log('INFO', 'supervisor', `推送派发已受理：task=${taskId.slice(0, 8)}，平台=${platform}，ticket=${job.ticket ?? '-'}`);
    return { ok: true, state: 'running', queueId, jobId, ticket: job.ticket ?? undefined, detail: `已推送至「${platform}」并拿到回执，等待轮询收敛` };
  }

  armTask(taskId, platform, 'ready');
  const reason = job.error ?? `job 状态=${job.status}`;
  logService.log('WARN', 'supervisor', `推送派发未成：task=${taskId.slice(0, 8)}，平台=${platform}，${reason}`);
  return { ok: false, state: 'ready', queueId, jobId, detail: `推送派发未成（${reason}），任务退回就绪池` };
}
