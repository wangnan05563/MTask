/**
 * T01061 后续（FR-1.1 链路）：系统级告警落到任务通知中心。
 *
 * 背景：数据库每日备份失败此前只有「console.error + 设置页 lastError 文本」两个出口——
 * 设置页不是常开页面，真正的「数据保护降级」往往要等用户主动去看才发现。
 * FR-1.1 的通知中心（NotifyBell）已经是用户天天看得到的位置，故把这类**系统级告警**也写进
 * 它的数据源 `task_events`，复用同一条链路（轮询 /events/recent）。
 *
 * 为什么用 task_events 而不是新建告警表：通知中心的取数、未读口径（lastSeen）、
 * 时间展示都已围绕它建好；新建一张表等于把展示层再写一遍，且两个入口会各说各话。
 * 代价是这类行没有关联任务——故以 SYSTEM_TASK_ID 作为哨兵 task_id，
 * 前端据此不当作任务处理（不跳转、不显示任务编号）。
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection';
import { notifyChange } from './ChangeBus';

/** 哨兵 task_id：系统级事件不关联任何真实任务（前端据此禁用「点击前往任务」） */
export const SYSTEM_TASK_ID = 'system';
/** 事件 kind：与任务侧的 status/verified/ai_state/result 并列 */
export const SYSTEM_EVENT_KIND = 'system';
/** 同类告警的静默窗口（6h）：备份每小时检查一次，磁盘满会连续失败——不节流会把通知刷满屏 */
const DEDUPE_WINDOW_MS = 6 * 60 * 60_000;

/**
 * 写入一条系统级告警（进入通知中心）。
 *
 * 同 detail 在静默窗口内重复出现时直接跳过：连续失败的场景下，
 * 「每小时一条同样的告警」只会让用户把通知中心整体屏蔽掉，反而不如留一条最新的。
 *
 * @returns 是否真的写入（false = 被静默窗口抑制）
 */
export function logSystemEvent(detail: string): boolean {
  try {
    const db = getDb();
    const recent = db
      .prepare('SELECT detail, created_at FROM task_events WHERE task_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1')
      .get(SYSTEM_TASK_ID, SYSTEM_EVENT_KIND) as { detail: string; created_at: string } | undefined;
    // 可选链判等不参与 TS 收窄，补一句 recent 守卫供 created_at 取值
    if (recent?.detail === detail && recent && Date.now() - new Date(recent.created_at).getTime() < DEDUPE_WINDOW_MS) {
      return false;
    }
    db.prepare('INSERT INTO task_events (id, task_id, task_no, project_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), SYSTEM_TASK_ID, null, '', SYSTEM_EVENT_KIND, detail, new Date().toISOString());
    // 通知中心的数据源变了，推一把 SSE（NotifyBell 本身 30s 轮询，这里只为即时可见）
    notifyChange('tasks');
    return true;
  } catch (e) {
    // 告警写入失败绝不能反过来影响触发它的主流程（备份/恢复等）
    console.error('[system-event] 写入告警失败:', e);
    return false;
  }
}
