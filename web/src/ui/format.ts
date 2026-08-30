/** 时间显示公共工具：统一相对时间格式化，供各管理页列表使用（与任务页时间展示风格一致） */

const p2 = (n: number) => String(n).padStart(2, '0');

/**
 * 相对时间：1 分钟内「刚刚」；1 小时内「x 分钟前」；1 天内「x 小时前」；
 * 7 天内「x 天前」；更早回退到绝对时间 "YYYY-MM-DD HH:mm"。非法/空值返回 '-'
 * （统一走本地时区，避免跨时区显示偏差）。
 */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** 绝对时间 "YYYY-MM-DD HH:mm"，供需要完整时间的悬浮提示使用 */
export function fullTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}