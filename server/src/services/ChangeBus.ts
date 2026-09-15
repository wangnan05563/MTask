/**
 * 数据变更通知总线（T00444）：各 Service 写库后 notifyChange，SSE 端点 /api/events
 * 订阅并推送给前端，实现「MCP 回传 / 队列执行 / 多窗口」等外部变更的准实时刷新。
 * 轻量 EventEmitter 即可（单进程单用户），无需引入消息队列。
 */
import { EventEmitter } from 'node:events';

export const changeBus = new EventEmitter();
changeBus.setMaxListeners(50);

/** 变更类型：tasks=任务增改 | plans=项目计划增改 | queue=队列收敛 */
export type ChangeKind = 'tasks' | 'plans' | 'queue' | 'projects'; // T00589 二轮：项目级变更（沉淀/恢复/归档）通知

export function notifyChange(kind: ChangeKind): void {
  changeBus.emit('change', kind);
}
