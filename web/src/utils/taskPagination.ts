/**
 * T03214 / UX-02 ①：任务列表分页页脚的状态判定。
 *
 * 此前「还有没有下一页」只由「本页是否满页」派生：200 条正好一页时按钮仍在，
 * 点一次拿到空页才消失；而到底后页脚整块收起，用户无法区分「全部加载完」与「就这么多」。
 * 服务端 `total` 通道（T02291）可用时以它为准；不可用时不猜数（保持满页判据）。
 */

export interface PaginationView {
  /** 未加载条数；旧后端无 total 通道时为 null（不猜） */
  remaining: number | null;
  /** 是否还该给出「加载更多」入口 */
  canLoadMore: boolean;
  /** 服务端总数已全部取回：页脚显示「已加载全部」 */
  allLoaded: boolean;
}

export function paginationStatus(total: number | null, loaded: number, pageFull: boolean): PaginationView {
  const remaining = total === null ? null : Math.max(0, total - loaded);
  const canLoadMore = pageFull && (remaining === null || remaining > 0);
  return { remaining, canLoadMore, allLoaded: remaining === 0 && !canLoadMore };
}
