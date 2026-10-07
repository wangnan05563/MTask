/**
 * T01059 后续：甘特条拖动的排期推导（纯逻辑，与 React 解耦，便于单测）。
 *
 * 背景：甘特图此前是纯只读可视化（连线/关键路径/底纹），排期只能在列表视图改日期或工期。
 * 本模块负责「横向拖过 N 个日列 → 新的开始日/结束日/工期」，前端据此画实时预览，
 * 松手后走既有 updatePlan → PATCH /plans/:id，由服务端按工作日历重算 end_date 并沿显式 deps 传播。
 */

import { addDays, calcEndDate, countWorkdays, snapWorkdayBack, snapWorkdayForward, type WorkdayCtx } from './workday';

/** move=整条平移；resize-l/resize-r=左右边缘伸缩工期 */
export type GanttDragMode = 'move' | 'resize-l' | 'resize-r';

export interface GanttDragState {
  mode: GanttDragMode;
  id: string;
  /** 按下时的鼠标 X（px），用于算位移 */
  startX: number;
  origStart: string;
  origEnd: string;
  origDur: number;
  nextStart: string;
  nextEnd: string;
  nextDur: number;
  /** 是否真的位移过（避免「点一下」也发一次 PATCH） */
  moved: boolean;
}

export interface GanttDragResult {
  start: string;
  end: string;
  dur: number;
}

/** 构造一次拖动的初始状态（拖动原点） */
export function newGanttDrag(
  id: string,
  mode: GanttDragMode,
  startX: number,
  start: string,
  end: string,
  dur: number,
): GanttDragState {
  const d = Math.max(1, Math.floor(dur) || 1);
  return {
    mode, id, startX,
    origStart: start, origEnd: end, origDur: d,
    nextStart: start, nextEnd: end, nextDur: d,
    moved: false,
  };
}

/** 鼠标位移（px）→ 位移了几个日列 */
export function deltaDaysFromPx(dx: number, dayWidth: number): number {
  return Math.round(dx / dayWidth);
}

/**
 * 由「拖过多少个日历列」推导新的开始/结束/工期。
 *
 * 语义（与服务端工作日历一致，保证松手后服务端重算的 end_date 与预览一致）：
 * - move：开始日平移、工期不变；
 * - resize-l：开始日平移、结束日不变 → 工期按工作日重算；不允许拖过结束日；
 * - resize-r：结束日平移、开始日不变 → 工期按工作日重算；不允许拖到开始日之前。
 *
 * 日期为 `YYYY-MM-DD`，字典序即时间序，可直接比较。
 */
export function ganttDragResult(
  mode: GanttDragMode,
  origStart: string,
  origEnd: string,
  origDur: number,
  deltaDays: number,
  ctx: WorkdayCtx,
): GanttDragResult {
  if (mode === 'move') {
    const start = snapWorkdayForward(addDays(origStart, deltaDays), ctx);
    return { start, end: calcEndDate(start, origDur, ctx), dur: origDur };
  }
  if (mode === 'resize-l') {
    let start = snapWorkdayForward(addDays(origStart, deltaDays), ctx);
    if (start > origEnd) start = origEnd;
    return { start, end: origEnd, dur: Math.max(1, countWorkdays(start, origEnd, ctx)) };
  }
  let end = snapWorkdayBack(addDays(origEnd, deltaDays), ctx);
  if (end < origStart) end = origStart;
  return { start: origStart, end, dur: Math.max(1, countWorkdays(origStart, end, ctx)) };
}
