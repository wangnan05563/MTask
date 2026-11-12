/**
 * T05687：分类下拉的「全部收藏」哨兵值。
 *
 * 两页（提示词菜单 / 通用需求菜单）共用同一字面量——各写一份 '__fav__' 迟早有一页写错，
 * 而后端只认「不传 categoryId + favorited=1」，哨兵值写错会静默退回「全部分类」视图。
 */
export const ALL_FAV = '__fav__';

/** 是否「全部收藏」视图（下拉值可能来自 sessionStorage，统一走这里判定） */
export function isAllFav(activeCat: string): boolean {
  return activeCat === ALL_FAV;
}
