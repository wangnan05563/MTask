/**
 * T02284：HTTP 列表端点的分页参数口径（归档页切服务端分页时引入）。
 *
 * 之所以单独成文件而不是在各路由里各写一份：`/tasks`（M7-7.2）、`/plans/archived`、`/prompts`
 * 三个列表要用**同一套** limit/offset 钳制规则，前端三个列表区共用「每页条数」档位；
 * 任一处口径漂移都会让「同一数据集翻页结果不同」变成隐性缺陷。
 */

/** 硬钳上限（与 /tasks M7-7.2 一致） */
const LIMIT_MAX = 500;
/** 显式传入但非法（0/负数/非数字）时的回落值（与 /tasks 默认一致） */
const LIMIT_FALLBACK = 200;

/**
 * limit 解析：
 * - **缺省 = 全量返回**（`undefined`）——`/plans/archived`、`/prompts` 的既有消费方
 *   （CommandPalette 拉全部提示词、移动端提示词页、`scripts/verify-t01874.mjs` 等不带分页参数）
 *   依赖此语义，不能像 `/tasks` 那样默认截断；
 * - 显式合法值钳进 `[1,500]`；显式非法值回落 200。
 */
export function parseLimit(raw: unknown): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 1) return Math.min(LIMIT_MAX, Math.floor(n));
  return LIMIT_FALLBACK;
}

/** offset 解析：缺省/非法/负数一律 0（与 /tasks 的 `Math.max(0, …)` 同口径） */
export function parseOffset(raw: unknown): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** `total=1` 加性通道的开关值 */
export function wantsTotal(raw: unknown): boolean {
  return raw === '1' || raw === 'true';
}

/** 分页信封：仅当请求带 `total=1` 时替代裸数组返回（不带时响应体逐字不变） */
export interface Paged<T> {
  items: T[];
  total: number;
}
