/**
 * T03229（PRD PM-202②）：阻塞徽标的桌面单源实现。
 *
 * 列表行与看板卡共用同一份文案、配色与 tooltip 口径——两处分写会把「阻塞 N」的含义
 * 漂移成两个数字（一处计在途、一处计历史）。取数来自列表 payload 的 `blocked_by`
 * （服务端 `TaskService.list` 在 decorateRows 里带出，已解除的关系不在内）。
 */
import type { Task } from '../api/client';

/** 徽标节点：无在途阻塞时返回 null（调用方不必再判空） */
export function blockBadgeNode(t: Task) {
  const list = t.blocked_by ?? [];
  if (list.length === 0) return null;
  const names = list.map((b) => `${b.task_no ? `${b.task_no} ` : ''}「${b.title}」`).join('、');
  return (
    <span data-t03229="block-badge" title={`被 ${list.length} 条任务阻塞：${names}`}
      aria-label={`被 ${list.length} 条任务阻塞：${names}`}
      style={{ fontSize: 'var(--fs-2xs)', color: 'var(--warn)', border: '1px solid var(--warn)', borderRadius: 4, padding: '0 4px', lineHeight: '16px', flexShrink: 0, whiteSpace: 'nowrap' }}>
      阻塞 {list.length}
    </span>
  );
}

/** 阻塞方点名串（看板卡 aria-label 等处复用，避免同一句文案在两个组件各拼一遍） */
export function blockBadgeNames(t: Task): string {
  return (t.blocked_by ?? []).map((b) => `${b.task_no ? `${b.task_no} ` : ''}「${b.title}」`).join('、');
}
