/**
 * T02090（里程碑收口残项）：里程碑**进度聚合**——口径 A（deps child 为唯一父子标记）。
 *
 * 背景（T02042 收口实测）：两本子计划早已 done/100%，里程碑仍是 todo/0%，只能人工 PATCH N 次；
 * 且人工提前把里程碑标完成会让后续进度失去意义（红线）。本模块把「子计划 done 数/总数」
 * 聚合为里程碑 progress，全部 done 才置 status=done。
 *
 * 聚合口径（写进代码即口径，改动需连带改门脚本 verify-t02042-milestone-deps.mts）：
 * - progress = round(done / total × 100)，clamp 0~100；
 * - 全部 done → status='done' + progress=100；
 * - 部分 done → status='doing'（progress 如实反映，红线：子项未动时恒 0，绝不 100%）；
 * - 全未 done → status='todo' + progress=0；
 * - 无子项（total=0）→ **不动**（无聚合依据，保留人工状态）；
 * - 聚合权威：人工 PATCH 里程碑 status/progress 后若仍有子项，以子项聚合值为准
 *   （T02042 红线「先把里程碑标完成会让后续进度失去意义」的守卫）。
 *
 * 联动顺序（T02090 第 3 件事，修 T00478 类误读面）：里程碑**因聚合翻为 done** 时，
 * 其关联待办（linked_task_id）置 status='done' + ai_state='unread'（待读）——
 * 而不是静默 done。保证「已完成」永远有结论档支撑，面板先出现未读圆点而非裸的已完成。
 *
 * 本模块只依赖 getDb（中性模块）：PlanService / TaskService / 启动对账 / 补边脚本共用，
 * 规避 PlanService↔TaskService 循环导入（T02087 的 reqStatusSync 同款决策）。
 */
import { getDb } from '../db/connection';
import { childParentIds } from '../util/milestoneChild';

export interface MilestoneRecalcResult {
  milestoneId: string;
  /** 是否有落库变化（progress/status 任一不同） */
  changed: boolean;
  progress: number;
  status: string;
  doneCount: number;
  total: number;
  /** 本次因聚合从非 done 翻为 done（触发关联待办 unread） */
  autoDone: boolean;
}

const NOOP = (milestoneId: string): MilestoneRecalcResult => ({
  milestoneId, changed: false, progress: 0, status: '', doneCount: 0, total: 0, autoDone: false,
});

interface MsRow { id: string; project_id: string; status: string; progress: number }

/** 取里程碑行（仅未归档）；不是里程碑/不存在 → null */
function loadMilestone(db: ReturnType<typeof getDb>, milestoneId: string): (MsRow & { kind: string }) | null {
  return (db.prepare('SELECT id, project_id, kind, status, progress FROM plan_tasks WHERE id = ? AND archived = 0')
    .get(milestoneId) as (MsRow & { kind: string }) | undefined) ?? null;
}

/** 某里程碑的全部子项状态（未归档、deps 含指向它的 child 边）。
 *  LIKE 预筛 + 精确解析两级：LIKE 只按 id 子串粗筛（deps 里只有 id/type 两字段，无误伤），
 *  精确判定仍走 childParentIds（serial 边引用同一 id 不会误入）。 */
function childStatuses(db: ReturnType<typeof getDb>, milestone: MsRow): string[] {
  const rows = db.prepare(
    `SELECT deps, status FROM plan_tasks
      WHERE project_id = ? AND archived = 0 AND deps LIKE '%"' || ? || '"%'`,
  ).all(milestone.project_id, milestone.id) as Array<{ deps: string | null; status: string }>;
  return rows.filter((r) => childParentIds(r.deps).includes(milestone.id)).map((r) => r.status);
}

/** 聚合权威写里程碑；翻为 done 时把关联待办置 done+unread（T02090 联动顺序）。 */
export function recalcMilestoneProgress(db: ReturnType<typeof getDb>, milestoneId: string): MilestoneRecalcResult {
  const m = loadMilestone(db, milestoneId);
  if (!m || m.kind !== 'milestone') return NOOP(milestoneId);
  const statuses = childStatuses(db, m);
  const total = statuses.length;
  if (total === 0) return { ...NOOP(milestoneId), progress: m.progress, status: m.status }; // 无子项：保留人工状态
  const doneCount = statuses.filter((s) => s === 'done').length;
  const progress = Math.min(100, Math.max(0, Math.round((doneCount / total) * 100)));
  const status = doneCount === total ? 'done' : progress > 0 ? 'doing' : 'todo';
  if (m.status === status && m.progress === progress) {
    return { milestoneId, changed: false, progress, status, doneCount, total, autoDone: false };
  }
  const wasDone = m.status === 'done';
  db.prepare('UPDATE plan_tasks SET progress = ?, status = ?, updated_at = ? WHERE id = ?')
    .run(progress, status, new Date().toISOString(), milestoneId);
  const autoDone = !wasDone && status === 'done';
  if (autoDone) markLinkedTaskDoneUnread(db, milestoneId);
  return { milestoneId, changed: true, progress, status, doneCount, total, autoDone };
}

/**
 * 里程碑因聚合自动 done → 关联待办 done + ai_state='unread'（待读）。
 * 直接写库（不经 TaskService.update）：避免「任务 done → 计划 done → 里程碑重算」的回环。
 * 仅翻 done 时调用一次；重复调用会把已读圆点重新点亮，故调用方负责只在 autoDone 时触发。
 */
function markLinkedTaskDoneUnread(db: ReturnType<typeof getDb>, milestoneId: string): void {
  const plan = db.prepare('SELECT linked_task_id FROM plan_tasks WHERE id = ?').get(milestoneId) as
    { linked_task_id: string | null } | undefined;
  if (!plan?.linked_task_id) return;
  const task = db.prepare('SELECT id FROM tasks WHERE id = ? AND archived = 0').get(plan.linked_task_id) as
    { id: string } | undefined;
  if (!task) return;
  const stamp = new Date().toISOString();
  db.prepare("UPDATE tasks SET status = 'done', ai_state = 'unread', ai_state_at = ?, updated_at = ? WHERE id = ?")
    .run(stamp, stamp, task.id);
}

/** 子行的父里程碑 id 列表（deps 中 child 边指向的行；不校验对方确是里程碑，由 recalc 自行 no-op）。
 *  **不按 archived 过滤**：archive 事务内先置 archived=1 再调本函数，过滤掉就读不到父边了
 *  （归档/恢复都要重算父里程碑——子项进出分母）。 */
export function parentMilestoneIdsOf(db: ReturnType<typeof getDb>, childPlanId: string): string[] {
  const row = db.prepare('SELECT deps FROM plan_tasks WHERE id = ?').get(childPlanId) as
    { deps: string | null } | undefined;
  return row ? childParentIds(row.deps) : [];
}

/** 子行状态/deps 变化后，重算其全部父里程碑（返回有变化的那些） */
export function recalcMilestonesOfChild(db: ReturnType<typeof getDb>, childPlanId: string): MilestoneRecalcResult[] {
  const out: MilestoneRecalcResult[] = [];
  for (const msId of parentMilestoneIdsOf(db, childPlanId)) {
    const r = recalcMilestoneProgress(db, msId);
    if (r.changed) out.push(r);
  }
  return out;
}

/** 某里程碑是否有子项——`reconcileLinkedPlanStatuses` 的排除判据（聚合作主，不被任务→计划单向对齐抢先） */
export function milestoneHasChildren(db: ReturnType<typeof getDb>, milestoneId: string): boolean {
  const m = loadMilestone(db, milestoneId);
  if (!m || m.kind !== 'milestone') return false;
  return childStatuses(db, m).length > 0;
}

/**
 * 启动对账（T00470 家族新成员）：全库重算所有带子项的里程碑。
 * AI/脚本可能直写 sqlite 绕过 PlanService.update 的聚合触发（如 T02042 当初人工 PATCH 后
 * 子项又变化），启动时按子项聚合值收敛。返回变化行数（启动日志观测）。
 */
export function reconcileMilestoneProgresses(): number {
  const db = getDb();
  const ms = db.prepare("SELECT id FROM plan_tasks WHERE archived = 0 AND kind = 'milestone'").all() as Array<{ id: string }>;
  let changed = 0;
  for (const m of ms) {
    if (recalcMilestoneProgress(db, m.id).changed) changed += 1;
  }
  return changed;
}
