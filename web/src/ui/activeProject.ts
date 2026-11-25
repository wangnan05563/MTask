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

/**
 * T06329 迁移兼容：旧实现用 usePersistentState 写入 JSON 字符串（例如 `"p1"` / `""`），
 * 新 store 直接写裸串。这里同时接受两种格式，并把旧哨兵 `__all__` 统一归一化为空串。
 */
export function normalizeActiveProject(raw: string | null): string {
  if (!raw) return '';
  let value = raw;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') value = parsed;
    else if (parsed === null) value = '';
  } catch {
    /* 新格式是裸串，JSON.parse 失败时按原值处理 */
  }
  return value === ALL_PROJECTS ? '' : value;
}

function readStored(): string {
  let storage: Storage | undefined;
  let raw: string | null = null;
  try {
    storage = globalThis.localStorage;
    raw = storage?.getItem(ACTIVE_PROJECT_KEY) ?? null;
  } catch {
    return '';
  }
  const value = normalizeActiveProject(raw);
  // 读到旧 JSON 值时顺手迁移成新格式，避免每次启动重复解析与再次被误判为项目 ID。
  if (storage && raw !== null && raw !== value) {
    try {
      storage.setItem(ACTIVE_PROJECT_KEY, value);
    } catch {
      /* 隐私模式/配额失败不影响本次内存值 */
    }
  }
  return value;
}

function emit(): void {
  for (const fn of listeners) fn();
}

export function getActiveProject(): string {
  if (snapshot === null) snapshot = readStored();
  return snapshot;
}

export function setActiveProject(projectId: string): void {
  const next = projectId === ALL_PROJECTS ? '' : (projectId || '');
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
