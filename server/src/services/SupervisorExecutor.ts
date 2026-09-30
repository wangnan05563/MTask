/**
 * T01282（PRD FR-3.3 / FR-3.4 / FR-3.5）：监督决策动作的**落地执行层**——
 * 护栏放行的动作在这里真正改变数据。编排顺序为 tick：观测 → 决策 → 护栏 → 落地。
 *
 * 为何独立成模块（与 SupervisorGuard 同构）：护栏「只裁决不执行」、执行层「只执行不裁决」，
 * 两者可各自单测——本模块测试直接喂动作、断言数据变化，无需构造 LLM、快照与熔断配置；
 * 同时执行层只依赖 TaskService（业务写入），不与 SupervisorService 互引，避免循环依赖。
 *
 * 落地语义（对齐 PRD §8 状态机与方案设计 §5「动作落地矩阵」）：
 * - **RESUME**：把任务「重新武装」——清 `ai_state`/`exec_session_id`（否则 `mtask_claim_task` 的
 *   `ai_state=''` 前置不满足，平台根本拉不走）、置 `monitor_ready=1` 直接入池（本轮 markMonitorReady
 *   已在 tick 早期跑完，不直接置位就要白等一个周期）、`monitor_retry+1`（护栏 FR-4.2 的重试上限
 *   数据源，动作落地是**唯一**自增点）；
 * - **REDISPATCH**：在 RESUME 的重新武装之上，额外写 `monitor_preferred_platform=toPlatform`，
 *   平台拉取时偏好该平台（FR-3.4，由 listMonitorReady 的平台过滤消费）；
 * - **SPLIT**：为父任务建子任务挂 `parent_id` 并直接置就绪（FR-3.5），父任务本身退出就绪池——
 *   否则「拆分后父任务又被拉去执行一遍」，拆分就失去意义；
 * - **CONTINUE / ESCALATE**：**无数据落地**（前者等待心跳、后者等人工），如实记 `skipped`，
 *   让审计能看到「LLM 建议了但本层没动」，而不是假装执行过（NFR-3 不静默）。
 *
 * T01283（FR-3.6）：RESUME/REDISPATCH 的**通道**不再是唯一——目标平台若被声明为「不支持 MCP 拉取」
 * （`supervisor.relayPlatforms`），则改由 `RelayDispatchService` 走中继推送，否则任务只会躺在
 * 「就绪」上等一个永不到来的拉取（排水静默停滞）。通道判定与推送实现都在 RelayDispatchService，
 * 本层只负责「选通道 + 记录结论」。
 *
 * 每个动作独立事务：单个动作失败只记 failed，不回滚其他动作、不中断本轮——
 * 一个脏 taskId 不该拖垮整轮排水。
 */
import { getDb } from '../db/connection';
import { TaskService } from './TaskService';
import { type GuardAction } from './SupervisorGuard';
import { normalizePlatform } from '../util/platform'; // T01288：写入 monitor_preferred_platform 前归一化（拉取侧同口径）
import { isRelayPlatform, dispatchTask } from './RelayDispatchService'; // T01283：不支持 MCP 的平台走推送兜底（FR-3.6）

/** 单条动作的落地结果（供 T01285 写 monitor_runs 审计、T01286 前端展示） */
export interface ApplyOutcome {
  type: string;
  taskId?: string;
  status: 'applied' | 'skipped' | 'failed';
  /** 结果说明（成功写「做了什么」，跳过写「为何没做」，失败写错误信息） */
  detail: string;
  /** SPLIT 新建的子任务编号，便于审计与前端直接跳转 */
  createdTaskNo?: string;
}

/** 落地涉及的任务行（只取判定与复刻所需的列） */
interface ExecTaskRow {
  id: string;
  task_no: string | null;
  title: string;
  project_id: string;
  priority: string;
  status: string;
  archived: number;
  /** T01283：REDISPATCH 写过的偏好平台（FR-3.4），RESUME 判定推送通道时作为 LLM 未给 platform 的兜底来源 */
  monitor_preferred_platform: string | null;
}

const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);

function loadTask(id: string): ExecTaskRow | undefined {
  return getDb()
    .prepare('SELECT id, task_no, title, project_id, priority, status, archived, monitor_preferred_platform FROM tasks WHERE id = ?')
    .get(id) as ExecTaskRow | undefined;
}

/**
 * 共用前置校验：任务存在、未归档、且仍是待办。
 * 非待办（已 done）说明不该再被自动触发，跳过而不是强行改回 todo——改状态是人工该做的决定。
 */
function validateTarget(type: string, taskId: string | undefined): { ok: true; task: ExecTaskRow } | { ok: false; outcome: ApplyOutcome } {
  if (!taskId) return { ok: false, outcome: { type, status: 'skipped', detail: '动作缺少 taskId，无法定位对象' } };
  const task = loadTask(taskId);
  if (!task) return { ok: false, outcome: { type, taskId, status: 'skipped', detail: '任务不存在（可能已被删除），忽略' } };
  if (task.archived) return { ok: false, outcome: { type, taskId, status: 'skipped', detail: '任务已归档，不再参与自动执行' } };
  if (task.status !== 'todo') return { ok: false, outcome: { type, taskId, status: 'skipped', detail: `任务非待办（status=${task.status}），无需触发` } };
  return { ok: true, task };
}

/**
 * RESUME（FR-3.3）：重新入池等待平台再次拉取。
 * T01283：目标平台声明为「不支持 MCP 拉取」时改走**推送兜底**——只标 monitor_ready 会放进一个
 * 没人来取的池子（排水静默停滞），故经中继 submit/poll 主动推进去（FR-3.6）。
 */
async function resume(a: GuardAction): Promise<ApplyOutcome> {
  const v = validateTarget(a.type, a.taskId);
  if (!v.ok) return v.outcome;
  const platform = normalizePlatform(a.platform ?? v.task.monitor_preferred_platform);
  if (isRelayPlatform(platform)) return pushOrApply(a, v.task.id, platform);
  const db = getDb();
  const ts = new Date().toISOString();
  // ai_state_at 一并清空：它不是时间戳留痕，而是「是否被 AI 处理过」的判据（见 TaskService.retryTask），
  // 续跑后应回到「全新待办」的形态，否则后续「读取即开始处理」类判定会误认为它已被处理过。
  db.transaction(() => {
    db.prepare(
      `UPDATE tasks
          SET ai_state = '', ai_state_at = '', exec_session_id = NULL,
              monitor_ready = 1, monitor_retry = monitor_retry + 1, updated_at = ?
        WHERE id = ?`,
    ).run(ts, v.task.id);
  })();
  return { type: a.type, taskId: v.task.id, status: 'applied', detail: '已重新入池（monitor_ready=1）并累加重试计数，等待外部平台再次拉取' };
}

/** REDISPATCH（FR-3.4）：换台——改偏好平台后同样重新入池（不支持 MCP 的目标平台则走推送兜底） */
async function redispatch(a: GuardAction): Promise<ApplyOutcome> {
  const v = validateTarget(a.type, a.taskId);
  if (!v.ok) return v.outcome;
  // T01288：归一化后再落库——拉取侧按同一口径匹配，否则平台自称大小写不同就永远拉不到（静默停滞）
  const target = normalizePlatform(a.toPlatform);
  if (!target) return { type: a.type, taskId: v.task.id, status: 'skipped', detail: '缺少 toPlatform，无法确定换到哪个平台' };
  if (isRelayPlatform(target)) return pushOrApply(a, v.task.id, target);
  const db = getDb();
  const ts = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `UPDATE tasks
          SET monitor_preferred_platform = ?, ai_state = '', ai_state_at = '', exec_session_id = NULL,
              monitor_ready = 1, monitor_retry = monitor_retry + 1, updated_at = ?
        WHERE id = ?`,
    ).run(target, ts, v.task.id);
  })();
  return { type: a.type, taskId: v.task.id, status: 'applied', detail: `偏好平台已改为「${target}」并重新入池，等待该平台拉取` };
}

/**
 * 推送兜底（FR-3.6）：把结果状态映射为落地结论。
 * 未配置中继工具（queueId 缺省）判 skipped 而非 failed——那是**配置缺失**、不是链路故障，
 * 混为一谈会让审计把「还没配」误读成「派发坏了」。
 */
async function pushOrApply(a: GuardAction, taskId: string, platform: string): Promise<ApplyOutcome> {
  const r = await dispatchTask(taskId, platform);
  let status: ApplyOutcome['status'];
  if (r.ok) {
    status = 'applied';
  } else if (r.queueId) {
    status = 'failed';
  } else {
    status = 'skipped';
  }
  return {
    type: a.type,
    taskId,
    status,
    detail: r.detail,
  };
}

/** SPLIT（FR-3.5）：拆出子任务回灌待办池，父任务退出就绪池 */
function split(a: GuardAction): ApplyOutcome {
  const v = validateTarget(a.type, a.taskId);
  if (!v.ok) return v.outcome;
  const parent = v.task;
  const db = getDb();
  const ts = new Date().toISOString();
  // 复用 TaskService.create 而非裸 INSERT：任务编号分配、查重、父子校验、事件埋点都在服务层，避免第二套建单实现
  const child = TaskService.create({
    projectId: parent.project_id,
    title: `${parent.title}（拆分）`,
    description: `由监督器 SPLIT 动作从 ${parent.task_no ?? parent.id} 拆出。\n拆分依据：${a.reason}`,
    priority: PRIORITIES.has(parent.priority) ? (parent.priority as 'low' | 'normal' | 'high' | 'urgent') : undefined,
    parentId: parent.id,
  });
  db.transaction(() => {
    // 子任务无计划行 → 无前置依赖，直接入池（不必等下一轮 markMonitorReady 的周期）
    db.prepare('UPDATE tasks SET monitor_ready = 1 WHERE id = ?').run(child.id);
    // 父任务退出就绪池并计数：拆分的目的就是不再整体执行它
    db.prepare('UPDATE tasks SET monitor_ready = 0, monitor_retry = monitor_retry + 1, updated_at = ? WHERE id = ?').run(ts, parent.id);
  })();
  return { type: a.type, taskId: parent.id, status: 'applied', detail: `已拆出子任务 ${child.task_no ?? child.id} 并置为就绪，父任务退出就绪池`, createdTaskNo: child.task_no ?? undefined };
}

/** 主入口：按动作类型分派；未知/无需落地的类型如实记 skipped。
 *  T01283 起为 async：推送兜底要走 `QueueService.submitAll`（网络提交），无法在同步函数内完成。 */
export async function applyActions(actions: GuardAction[]): Promise<ApplyOutcome[]> {
  const out: ApplyOutcome[] = [];
  for (const a of actions) {
    try {
      if (a.type === 'RESUME') out.push(await resume(a));
      else if (a.type === 'REDISPATCH') out.push(await redispatch(a));
      else if (a.type === 'SPLIT') out.push(split(a));
      else out.push({
        type: a.type,
        taskId: a.taskId,
        status: 'skipped',
        detail: a.type === 'CONTINUE' ? '会话健康，仅等待下一次心跳' : '转人工处理，本层不自动改数据',
      });
    } catch (e) {
      out.push({ type: a.type, taskId: a.taskId, status: 'failed', detail: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
