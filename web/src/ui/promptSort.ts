/**
 * T03248（PRD AI-104④）：提示词列表排序（纯函数，供页面与门共用）。
 *
 * 口径：置顶项**永远**排在最前（与既有 updated_at/名称排序一致）；组内再按用户所选字段与方向排序。
 * 新增 `usage`：按模板累计成功发起次数排序（次数相同回落更新时间降序，避免列表抖动）。
 */
import type { Prompt } from '../api/client';

export type PromptSortKey = 'updated_at' | 'created_at' | 'title' | 'manual' | 'usage';

/** 手动排序权重比较（0/空=默认序排最后） */
function cmpSortWeight(wa: number, wb: number): number {
  if (wa === wb) return 0;
  if (wa === 0) return 1;
  if (wb === 0) return -1;
  return wa - wb;
}

/** 依据当前排序条件对两条提示词比较；置顶项始终排在最前 */
export function comparePrompts(a: Prompt, b: Prompt, sortKey: PromptSortKey, sortDir: 'asc' | 'desc'): number {
  const pa = Boolean(a.pinned);
  const pb = Boolean(b.pinned);
  if (pa !== pb) return pa ? -1 : 1;
  if (sortKey === 'manual') {
    const w = cmpSortWeight(a.sort_weight || 0, b.sort_weight || 0);
    if (w !== 0) return w;
    return (b.updated_at || '').localeCompare(a.updated_at || '');
  }
  if (sortKey === 'usage') {
    const ua = a.usage_count ?? 0;
    const ub = b.usage_count ?? 0;
    if (ua !== ub) return sortDir === 'asc' ? ua - ub : ub - ua;
    // 次数相同：更新时间降序兜底（与默认序一致，避免每次取数顺序漂移）
    return (b.updated_at || '').localeCompare(a.updated_at || '');
  }
  const cmp = sortKey === 'title'
    ? a.title.localeCompare(b.title, 'zh-Hans-CN', { numeric: true })
    : a[sortKey].localeCompare(b[sortKey]);
  return sortDir === 'asc' ? cmp : -cmp;
}
