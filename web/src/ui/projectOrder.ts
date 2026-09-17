import { api } from '../api/client';

/**
 * 项目排序与置顶的**共享模块**（T00663：任务菜单与项目管理菜单复用同一套逻辑）。
 *
 * 约定：
 * - 服务端按 `ORDER BY sort_weight ASC, created_at` 排列 → **置顶写负权重**（排最前）；
 * - 置顶态按精确值判定，避免把系统项目（收件箱 -1000）误判为用户置顶；
 * - 排序方式为**前端本地偏好**（调用方用 useSessionState 持久化），默认序沿用后端顺序；
 * - 拖拽自定义顺序经 `POST /projects/reorder` 落库（置顶项不参与重排，保持置顶）。
 */

/** 置顶权重（小于收件箱 -1000，确保置顶项目排最前） */
export const PROJ_PIN_WEIGHT = -9999;

/** 是否处于置顶态（精确匹配，避免误判系统项目的既有权重） */
export const isProjectPinned = (pj: { sort_weight?: number }): boolean => (pj.sort_weight ?? 0) === PROJ_PIN_WEIGHT;

export type ProjectSortMode = 'default' | 'alpha-asc' | 'alpha-desc' | 'created-desc' | 'created-asc' | 'todo-desc' | 'todo-asc';

export const PROJ_SORT_OPTIONS: Array<{ key: ProjectSortMode; label: string; hint: string }> = [
  { key: 'default', label: '默认（置顶优先）', hint: '按置顶权重与创建顺序排列（不改变原有排序规则）' },
  { key: 'alpha-asc', label: '名称 A → Z', hint: '按项目名称升序' },
  { key: 'alpha-desc', label: '名称 Z → A', hint: '按项目名称降序' },
  { key: 'created-desc', label: '创建时间：最新在前', hint: '新建的项目排在最前' },
  { key: 'created-asc', label: '创建时间：最早在前', hint: '最早创建的项目排在最前' },
  { key: 'todo-desc', label: '待办数量：多 → 少', hint: '待办越多的项目越靠前' },
  { key: 'todo-asc', label: '待办数量：少 → 多', hint: '待办越少的项目越靠前' },
];

export const PROJ_SORT_LABEL = (mode: ProjectSortMode): string =>
  PROJ_SORT_OPTIONS.find((o) => o.key === mode)?.label ?? '默认（置顶优先）';

/** 按所选方式排序（默认序保持原顺序=后端排序，置顶权重优先生效） */
export function sortProjects<T extends { name: string; created_at?: string; todo_count?: number }>(list: readonly T[], mode: ProjectSortMode): T[] {
  const arr = [...list];
  switch (mode) {
    case 'alpha-asc': return arr.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    case 'alpha-desc': return arr.sort((a, b) => b.name.localeCompare(a.name, 'zh-Hans-CN'));
    case 'created-desc': return arr.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
    case 'created-asc': return arr.sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
    case 'todo-desc': return arr.sort((a, b) => (b.todo_count ?? 0) - (a.todo_count ?? 0));
    case 'todo-asc': return arr.sort((a, b) => (a.todo_count ?? 0) - (b.todo_count ?? 0));
    default: return arr;
  }
}

/** 切换置顶（返回是否已置顶的新状态）；调用方负责刷新项目列表与提示。
 *  参数放宽为最小形状（sort_weight 可选），便于不同页面的项目视图类型复用。 */
export async function toggleProjectPin(pj: { id: string; name: string; sort_weight?: number }): Promise<boolean> {
  const pinned = isProjectPinned(pj);
  await api.patch(`/projects/${pj.id}`, { sortWeight: pinned ? 0 : PROJ_PIN_WEIGHT });
  return !pinned;
}

/** 拖拽后保存自定义顺序（置顶项由服务端自动跳过，保持置顶） */
export async function reorderProjects(ids: string[]): Promise<void> {
  await api.post('/projects/reorder', { ids });
}
