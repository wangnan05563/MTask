import type { Task } from '../api/client';

/**
 * T03215（PM-304）：列表派生计算从 TasksPage 渲染体内提到模块级纯函数。
 * 窗口化后滚动会驱动组件重渲染，原先每次渲染都重跑的 filter + sort + arrange（arrange 还是 O(n²)）
 * 会把主线程重新吃满，虚拟滚动就白做——所以这些计算必须既能 useMemo 缓存，又有稳定函数标识。
 */

/** 待办/已完成区块排序选择项：default 保持后端顺序，time* 按修改时间，p* 按优先级 */
export const sortOptions = [
  { value: 'default', label: '默认' },
  { value: 'timedesc', label: '修改时间（新→旧）' },
  { value: 'timeasc', label: '修改时间（旧→新）' },
  { value: 'pdesc', label: '优先级（高→低）' },
  { value: 'pasc', label: '优先级（低→高）' },
  { value: 'manual', label: '手动排序' },
] as const;

export type SortKey = (typeof sortOptions)[number]['value'] | 'manual';

/** 对待办/已完成列表应用排序（返回新数组，不改动原数组） */
export function sortTasks(list: Task[], sort: SortKey): Task[] {
  if (sort === 'default' || list.length < 2) return list;
  const arr = [...list];
  // 优先级数值化：缺省/未知值按最低档对待，保证比较不产生 NaN
  const pr = (k: string) => ({ low: 0, normal: 1, high: 2 })[k] ?? 0;
  const ts = (t: Task) => new Date(t.updated_at).getTime() || 0;
  if (sort === 'timedesc') return arr.sort((a, b) => ts(b) - ts(a));
  if (sort === 'timeasc') return arr.sort((a, b) => ts(a) - ts(b));
  if (sort === 'pdesc') return arr.sort((a, b) => pr(b.priority) - pr(a.priority));
  if (sort === 'pasc') return arr.sort((a, b) => pr(a.priority) - pr(b.priority));
  // T00446：手动排序——pinned 优先，user_sort 空值排最后（与后端 sort=manual 一致）
  if (sort === 'manual') {
    return arr.sort((a, b) => {
      const pd = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
      if (pd !== 0) return pd;
      const ua = a.user_sort ?? Number.MAX_SAFE_INTEGER;
      const ub = b.user_sort ?? Number.MAX_SAFE_INTEGER;
      return ua - ub || new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }
  return arr.sort((a, b) => pr(a.priority) - pr(b.priority)); // pasc 低→高
}

export type TaskMatcher = (t: Task) => boolean;

/** 关键词 + 分类过滤谓词（kw 需已小写trim；catFilter：'none'=未分类，空串=全部） */
export function makeTaskMatcher(kw: string, catFilter: string): TaskMatcher {
  return (t) => {
    // 分类筛选：'none' 表示未分类；指定分类则精确匹配；空串为全部
    if (catFilter === 'none') { if (t.category_id) return false; } else if (catFilter && t.category_id !== catFilter) return false;
    // T01568：编号同样参与本地检索——外部跳转以 task_no 作搜索词，只比标题/描述会把目标行筛没
    return !kw || t.title.toLowerCase().includes(kw) || (t.description ?? '').toLowerCase().includes(kw) || (t.task_no ?? '').toLowerCase().includes(kw);
  };
}

/** 已完成栏验证状态过滤：all=全部，verified=仅已验证，unverified=仅未验证 */
export function matchVerified(t: Task, doneFilter: 'all' | 'verified' | 'unverified'): boolean {
  if (doneFilter === 'verified') return !!t.verified;
  return doneFilter === 'unverified' ? !t.verified : true;
}

/**
 * T00450：父子层级——子任务紧随父任务之后（缩进渲染），其余排序规则不变。
 * 原实现用 `list.some(...)` 判父任务是否存在，是 O(n²)（5000 条时每次渲染上亿次比较）；
 * 这里改为一次遍历建 id 集合 + 子表，复杂度 O(n)，输出顺序与原实现一致（根按原序，各自子任务紧随）。
 */
export function arrangeTaskTree(list: Task[]): Task[] {
  const ids = new Set(list.map((t) => t.id));
  const kids = new Map<string, Task[]>();
  const roots: Task[] = [];
  for (const t of list) {
    if (t.parent_id && ids.has(t.parent_id)) {
      const arr = kids.get(t.parent_id) ?? [];
      arr.push(t);
      kids.set(t.parent_id, arr);
    } else {
      roots.push(t);
    }
  }
  const out: Task[] = [];
  for (const t of roots) {
    out.push(t);
    const k = kids.get(t.id);
    if (k) out.push(...k);
  }
  return out;
}
