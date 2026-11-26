/**
 * T06408：任务菜单的项目排序偏好提升到框架顶栏后，顶栏按钮与页面列表需要共享同一份状态。
 * 浏览器 storage 事件只负责跨标签页同步，组件间则通过同页自定义事件即时同步。
 */
import { useCallback, useEffect, useState } from 'react';
import { PROJ_SORT_OPTIONS, type ProjectSortMode } from './projectOrder';

export const TASKS_PROJECT_SORT_KEY = 'tasks.projectSort';
const TASKS_PROJECT_SORT_EVENT = 'mtask:tasks-project-sort';

function isProjectSortMode(value: unknown): value is ProjectSortMode {
  return PROJ_SORT_OPTIONS.some((option) => option.key === value);
}

function readTasksProjectSort(): ProjectSortMode {
  try {
    const raw = localStorage.getItem(TASKS_PROJECT_SORT_KEY);
    const parsed: unknown = raw == null ? 'default' : JSON.parse(raw);
    return isProjectSortMode(parsed) ? parsed : 'default';
  } catch {
    return 'default';
  }
}

function writeTasksProjectSort(mode: ProjectSortMode): void {
  try {
    localStorage.setItem(TASKS_PROJECT_SORT_KEY, JSON.stringify(mode));
  } catch {
    /* 隐私模式/配额异常时仅保留本次内存状态，不阻断交互 */
  }
}

/** 顶栏排序按钮与任务页共用：读写同一持久化键，并在同页组件间广播变更 */
export function useTasksProjectSort(): readonly [ProjectSortMode, (mode: ProjectSortMode) => void] {
  const [mode, setModeState] = useState<ProjectSortMode>(readTasksProjectSort);

  useEffect(() => {
    const onCustom = (event: Event) => {
      const next = (event as CustomEvent<unknown>).detail;
      if (isProjectSortMode(next)) setModeState(next);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === TASKS_PROJECT_SORT_KEY) setModeState(readTasksProjectSort());
    };
    window.addEventListener(TASKS_PROJECT_SORT_EVENT, onCustom);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(TASKS_PROJECT_SORT_EVENT, onCustom);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setMode = useCallback((next: ProjectSortMode) => {
    writeTasksProjectSort(next);
    setModeState(next);
    window.dispatchEvent(new CustomEvent(TASKS_PROJECT_SORT_EVENT, { detail: next }));
  }, []);

  return [mode, setMode] as const;
}
