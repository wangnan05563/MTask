/**
 * T06329 全局项目/工作区上下文。
 *
 * 存储键沿用 `tasks.activeProject`，避免升级后丢失用户原有选择：
 * - 空串 = 全部项目（显式视图，不再偷偷回退到首个项目）
 * - 项目 id = 单项目作用域
 *
 * 顶层顶栏切换器与任务、计划、通用需求、队列等页面共用同一份值。
 */
import { useCallback, useSyncExternalStore } from 'react';

export const ACTIVE_PROJECT_KEY = 'tasks.activeProject';
/** 任务页沿用的全部项目哨兵；全局 store 对外仍用空串表示全部，入页时再映射。 */
export const ALL_PROJECTS = '__all__';

const listeners = new Set<() => void>();
let snapshot: string | null = null;

function readStored(): string {
  try {
    return globalThis.localStorage?.getItem(ACTIVE_PROJECT_KEY) ?? '';
  } catch {
    return '';
  }
}

function emit(): void {
  for (const fn of listeners) fn();
}

export function getActiveProject(): string {
  if (snapshot === null) snapshot = readStored();
  return snapshot;
}

export function setActiveProject(projectId: string): void {
  const next = projectId || '';
  if (next === getActiveProject()) return;
  snapshot = next;
  try {
    globalThis.localStorage?.setItem(ACTIVE_PROJECT_KEY, next);
  } catch {
    /* 隐私模式/存储禁用：仍在本会话内生效 */
  }
  emit();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('storage', (event: StorageEvent) => {
    if (event.key !== ACTIVE_PROJECT_KEY) return;
    snapshot = readStored();
    emit();
  });
}

export function useActiveProject(): readonly [string, (projectId: string) => void] {
  const value = useSyncExternalStore(subscribe, getActiveProject, getActiveProject);
  const update = useCallback((projectId: string) => setActiveProject(projectId), []);
  return [value, update] as const;
}

/** 顶栏展示名：空串统一为「全部项目」；项目已删/未加载时给出明确的未知态，而不是冒充全部。 */
export function activeProjectLabel(projectId: string, projects: readonly { id: string; name: string }[]): string {
  if (!projectId) return '全部项目';
  return projects.find((p) => p.id === projectId)?.name ?? '项目已删除';
}
