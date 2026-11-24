import type { SavedViewConfig, SavedViewType } from '../api/client';

/** T06303（REQ-009 / PRD §B1）：任务视图状态与 URL query 的双向映射。
 * 只映射影响呈现的筛选项，不把项目 id/任务 id 塞进 query，避免刷新后跨项目串台。 */
const VIEW_TYPES: ReadonlySet<string> = new Set(['list', 'board', 'table', 'calendar']);
const KEY = {
  view: 'view', search: 'q', cat: 'cat', priority: 'priority', field: 'field', op: 'op',
  value: 'fvalue', sort: 'fsort', density: 'density', boardHide: 'boardHide',
} as const;

const KNOWN_KEYS = Object.values(KEY);

export type TaskViewUrlState = Pick<SavedViewConfig,
  'viewMode' | 'search' | 'catFilter' | 'priorityFilter' | 'fieldFilterField' |
  'fieldFilterOp' | 'fieldFilterValue' | 'fieldSort' | 'density' | 'boardHideEmpty'>;

/** 解析 URL 中与视图相关的键；未出现的键保持缺省（不覆盖调用方默认）。 */
export function parseTaskViewUrl(search: string): TaskViewUrlState {
  const params = new URLSearchParams(search);
  const result: TaskViewUrlState = {};
  const view = params.get(KEY.view);
  if (view && VIEW_TYPES.has(view)) result.viewMode = view as SavedViewType;
  const text = (key: string): string | undefined => {
    const value = params.get(key);
    return value === null ? undefined : value;
  };
  const q = text(KEY.search); if (q !== undefined) result.search = q;
  const cat = text(KEY.cat); if (cat !== undefined) result.catFilter = cat;
  const priority = text(KEY.priority); if (priority !== undefined) result.priorityFilter = priority;
  const field = text(KEY.field); if (field !== undefined) result.fieldFilterField = field;
  const op = text(KEY.op); if (op !== undefined) result.fieldFilterOp = op;
  const value = text(KEY.value); if (value !== undefined) result.fieldFilterValue = value;
  const sort = text(KEY.sort); if (sort !== undefined) result.fieldSort = sort;
  const density = text(KEY.density); if (density !== undefined) result.density = density;
  const boardHide = params.get(KEY.boardHide);
  if (boardHide === '1' || boardHide === '0') result.boardHideEmpty = boardHide === '1';
  return result;
}

/** 把视图状态写回 query，保留无关参数（如页面路由/外部跳转参数）；空值不写入。 */
export function writeTaskViewUrl(currentSearch: string, state: TaskViewUrlState): string {
  const params = new URLSearchParams(currentSearch);
  for (const key of KNOWN_KEYS) params.delete(key);
  if (state.viewMode) params.set(KEY.view, state.viewMode);
  if (state.search) params.set(KEY.search, state.search);
  if (state.catFilter) params.set(KEY.cat, state.catFilter);
  if (state.priorityFilter) params.set(KEY.priority, state.priorityFilter);
  if (state.fieldFilterField) params.set(KEY.field, state.fieldFilterField);
  if (state.fieldFilterOp) params.set(KEY.op, state.fieldFilterOp);
  if (state.fieldFilterValue) params.set(KEY.value, state.fieldFilterValue);
  if (state.fieldSort) params.set(KEY.sort, state.fieldSort);
  if (state.density) params.set(KEY.density, state.density);
  if (state.boardHideEmpty !== undefined) params.set(KEY.boardHide, state.boardHideEmpty ? '1' : '0');
  return params.toString();
}

/** 当前视图状态 → 保存视图 config；只收白名单字段，防止把临时 UI 状态写进库。 */
export function taskViewConfig(state: TaskViewUrlState, type: SavedViewType): SavedViewConfig {
  return {
    viewMode: state.viewMode ?? type,
    search: state.search ?? '',
    catFilter: state.catFilter ?? '',
    priorityFilter: state.priorityFilter ?? '',
    fieldFilterField: state.fieldFilterField ?? '',
    fieldFilterOp: state.fieldFilterOp ?? '',
    fieldFilterValue: state.fieldFilterValue ?? '',
    fieldSort: state.fieldSort ?? '',
    density: state.density ?? 'compact',
    boardHideEmpty: state.boardHideEmpty ?? false,
  };
}
