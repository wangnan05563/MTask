/**
 * T05747：任务归位「武装」的单源实现。
 *
 * 为什么独立成模块：RelayDispatchService 依赖 AIService.buildSubmitter，而 AIService 的
 * B0 失败回退又需要把任务归位就绪池——直接互相 import 会形成运行时循环依赖。
 * 把纯 SQL 的归位动作下沉到这里，两边都只依赖本模块，避免循环、也避免两套 monitor_ready 口径。
 */
import { getDb } from '../db/connection';

/** 归位就绪池：清 ai_state 让平台可再次认领，monitor_ready=1，重试计数 +1 */
export function armTaskReady(taskId: string, platform: string): void {
  const ts = new Date().toISOString();
  getDb().prepare(
    `UPDATE tasks SET ai_state = '', ai_state_at = '', exec_session_id = NULL, monitor_preferred_platform = ?,
            monitor_ready = 1, monitor_retry = monitor_retry + 1, updated_at = ? WHERE id = ?`,
  ).run(platform, ts, taskId);
}

/** 出池执行中：monitor_ready=0，防止同一任务既在池里又被推送执行（双跑） */
export function armTaskRunning(taskId: string, platform: string): void {
  const ts = new Date().toISOString();
  getDb().prepare(
    `UPDATE tasks SET ai_state = 'running', ai_state_at = ?, exec_session_id = NULL, monitor_preferred_platform = ?,
            monitor_ready = 0, monitor_retry = monitor_retry + 1, updated_at = ? WHERE id = ?`,
  ).run(ts, platform, ts, taskId);
}
