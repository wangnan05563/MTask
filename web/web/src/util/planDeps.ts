/**
 * plan_tasks.deps 的 web 侧统一解析（T01621：时间线/列表/甘特对「里程碑成员」共用同一判定，
 * 消灭 PlanPage.childMilestoneOf 与 PlanTimeline.phases 各写一份 JSON.parse 的双源漂移）。
 * deps 契约（T00499 扩展）：`[{ id: <plan_tasks.id>, type: 'serial' | 'parallel' | 'child' }]`，
 * 其中 `type: 'child'` 表示「本行是指定里程碑（或父任务）的子项」。
 * 服务端另有 server/src/util/planDeps.ts（排水判定用，type 归一 serial/parallel）——两侧契约一致、用途不同，不互相引用。
 */

export interface PlanDepRef {
  /** 目标计划行 id（plan_tasks.id） */
  id: string;
  /** 原始类型：serial / parallel / child（未知类型原样保留，由调用方判定） */
  type: string;
}

/** 解析 deps JSON：非数组/缺 id 的脏数据跳过，非法 JSON 返回空数组（解析保守，不抛错） */
export function parsePlanDepsRaw(raw: string | null | undefined): PlanDepRef[] {
  try {
    const v: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(v)) return [];
    return v
      .filter((d): d is PlanDepRef => !!d && typeof (d as { id?: unknown }).id === 'string')
      .map((d) => ({ id: d.id, type: typeof d.type === 'string' ? d.type : '' }));
  } catch {
    return [];
  }
}

/** 该行的显式挂接父项（deps 中第一个 type=child 的目标 id）；无则 null（T00508 口径） */
export function childParentIdOf(deps: string | null | undefined): string | null {
  return parsePlanDepsRaw(deps).find((d) => d.type === 'child')?.id ?? null;
}
