/**
 * 数据变更通知总线（T00444）：各 Service 写库后 notifyChange，SSE 端点 /api/events
 * 订阅并推送给前端，实现「MCP 回传 / 队列执行 / 多窗口」等外部变更的准实时刷新。
 * 轻量 EventEmitter 即可（单进程单用户），无需引入消息队列。
 */
import { EventEmitter } from 'node:events';
import { cacheClear } from '../util/ttl-cache';

export const changeBus = new EventEmitter();
changeBus.setMaxListeners(50);

/** 变更类型：tasks=任务增改 | plans=项目计划增改 | queue=队列收敛 */
export type ChangeKind = 'tasks' | 'plans' | 'queue' | 'projects' | 'memories';
// T00589 二轮：projects=项目级变更（沉淀/恢复/归档）通知
// T04171（PRD v1.2·F11 / MEM-502）：memories=长期记忆增删改——管理页订阅后实时刷新，
// 否则 MCP/Agent 写入的记忆要等用户切产品才可见。

export function notifyChange(kind: ChangeKind): void {
  // T00657：任务/计划变更会改变项目下拉的计数（待办/未验证/计划完成等），
  // 联动失效项目列表 TTL 缓存——否则下拉徽标最长 5s 内显示旧计数（"不实时"）
  if (kind === 'tasks' || kind === 'plans') cacheClear('projects');
  changeBus.emit('change', kind);
}
