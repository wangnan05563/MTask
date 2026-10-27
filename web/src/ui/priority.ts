/**
 * PM-302 ③：优先级 → 颜色/文案的唯一映射源。
 *
 * 整改前它是四处各写一遍：看板卡片左边框（TasksPage 的 priorityBorderColor，其中
 * `var(--warning, #d97706)` 引用的 `--warning` 令牌根本不存在，于是暗色下也硬吃 #d97706，
 * 在深色底上只有 3.0:1）、移动端列表圆点（MobileHome PRIO_COLOR）、移动端详情徽标
 * （MobileTaskDetail PRIO_TONE）、矩阵视图 P 档换算（MatrixTable PRIO_P_LABEL，只有字没有色）。
 * 四处的高档色各不相同（#d97706 / var(--warn)），同一个任务在看板上和在手机上是两种颜色。
 *
 * 收编口径：颜色只有一个 `PRIORITY_COLOR`；文案按语域分四档（长/短/徽标/P 档），
 * 因为四处原本就是四种叫法，统一颜色不等于统一措辞。
 */
import { PRIORITY_TOKEN, type BadgeTone } from './primitives';

export type PriorityKey = 'urgent' | 'high' | 'normal' | 'low';

/** 优先级枚举的展示顺序（下拉/筛选项单源） */
export const PRIORITY_LEVELS: readonly PriorityKey[] = ['urgent', 'high', 'normal', 'low'];

/** 优先级 → 颜色（四处消费共用的唯一映射） */
export const PRIORITY_COLOR: Record<PriorityKey, string> = {
  urgent: PRIORITY_TOKEN.urgent,
  high: PRIORITY_TOKEN.high,
  normal: PRIORITY_TOKEN.normal,
  low: PRIORITY_TOKEN.low,
};

/** 未知/空值兜底走 --text-muted，不再各页自选一个灰 */
const FALLBACK_COLOR = 'var(--text-muted)';

const LABEL_ARIA: Record<PriorityKey, string> = { urgent: '极高优先级', high: '高优先级', normal: '普通优先级', low: '低优先级' };
const LABEL_SHORT: Record<PriorityKey, string> = { urgent: '紧急', high: '高', normal: '中', low: '低' };
const LABEL_BADGE: Record<PriorityKey, string> = { urgent: '紧急', high: '高', normal: '普通', low: '低' };
const LABEL_P: Record<PriorityKey, string> = { urgent: 'P0', high: 'P1', normal: 'P2', low: 'P3' };

/** 空串/null/undefined 归一 normal：存量任务 priority 允许为空（矩阵/导入路径实测存在）。 */
export function normalizePriority(priority: string | undefined | null): PriorityKey | '' {
  if (priority === undefined || priority === null || priority === '') return 'normal';
  return (PRIORITY_LEVELS as readonly string[]).includes(priority) ? (priority as PriorityKey) : '';
}

/** 优先级 → 颜色令牌串；非枚举值（脏数据）落灰色而不是抛错或留空 */
export function priorityColor(priority: string | undefined | null): string {
  const key = normalizePriority(priority);
  return key === '' ? FALLBACK_COLOR : PRIORITY_COLOR[key];
}

/** 优先级 → 徽标色调（原 MobileTaskDetail.PRIO_TONE）：与 PRIORITY_COLOR 同一色相阶梯，
 *  「高」走 warning 档而不是 accent——整改前它是 accent（蓝），而列表圆点与看板边框是琥珀，
 *  同一个「高」优先级在两块屏上是两种颜色，本次按 ③ 收敛为一致。 */
export const PRIORITY_TONE: Record<PriorityKey, BadgeTone> = {
  urgent: 'danger', high: 'warning', normal: 'accent', low: 'neutral',
};

export function priorityTone(priority: string | undefined | null): BadgeTone {
  const key = normalizePriority(priority);
  return key === '' ? 'neutral' : PRIORITY_TONE[key];
}

/** 悬浮提示/aria 用的全称（原 TasksPage.priorityLabel） */
export function priorityAriaLabel(priority: string | undefined | null): string {
  const key = normalizePriority(priority);
  return key === '' ? `${priority}优先级` : LABEL_ARIA[key];
}

/** 移动端列表圆点用的单字标签（原 MobileHome.PRIO_LABEL） */
export function priorityShort(priority: string | undefined | null): string {
  const key = normalizePriority(priority);
  return key === '' ? String(priority) : LABEL_SHORT[key];
}

/** 徽标文案（原 MobileTaskDetail.PRIO_LABEL） */
export function priorityBadgeLabel(priority: string | undefined | null): string {
  const key = normalizePriority(priority);
  return key === '' ? String(priority) : LABEL_BADGE[key];
}

/** 用例 P 档换算标注（原 MatrixTable.PRIO_P_LABEL）：`high（P1）` */
export function priorityWithP(priority: string | undefined | null): string {
  const key = normalizePriority(priority);
  return key === '' ? String(priority) : `${key}（${LABEL_P[key]}）`;
}

/** 下拉选项：值 + 显示文案的唯一来源，避免各页再手写一份四项清单 */
export const PRIORITY_OPTIONS: readonly { value: PriorityKey; label: string }[] = PRIORITY_LEVELS.map((k) => ({
  value: k,
  label: LABEL_ARIA[k],
}));
