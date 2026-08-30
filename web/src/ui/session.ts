import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * 带任意 Storage 持久化的 useState：值变化时实时写入指定存储，加载/切回时自动恢复。
 * storage 由上层指定：sessionStorage 覆盖当前会话，localStorage 跨会话与标签页保留，因此缓存损坏或不可用时静默回退初始值，不中断流程。
 */
function useStorageState<T>(
  storage: Storage,
  key: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = storage.getItem(key);
      if (raw == null) return initial;
      const parsed = JSON.parse(raw);
      // 仅信任与初始值同类型的数据，结构不匹配时静默回退
      return isCompatible(parsed, initial) ? parsed : initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch {
      /* 超出配额等写入失败时静默忽略，不阻塞交互 */
    }
  }, [key, value, storage]);

  return [value, setValue];
}

/**
 * 会话级持久化（sessionStorage）：适用于"录入一半后切换页面"的续写场景，当前会话内保留（刷新、后退/前进），标签页关闭即失效。
 */
export function useSessionState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  return useStorageState(sessionStorage, key, initial);
}

/**
 * 持久化偏好（localStorage）：适用于项目、模型等"用户长期选择"，刷新、切页、跨标签页、关闭浏览器重开均保留。
 */
export function usePersistentState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  return useStorageState(localStorage, key, initial);
}

/** 清除指定键的会话缓存（通常在表单提交成功后调用） */
export function clearSessionState(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* 忽略 */
  }
}

/** 递归校验缓存结构与类型是否可用，避免脏数据回填进表单 */
function isCompatible(parsed: unknown, initial: unknown): boolean {
  if (typeof parsed !== typeof initial) return false;
  if (parsed === null || initial === null) return parsed === initial;
  if (Array.isArray(parsed)) {
    return Array.isArray(initial) ? initial.length === 0 || isCompatible(parsed[0], initial[0]) : false;
  }
  if (Array.isArray(initial)) return false;
  if (typeof initial === 'object') {
    for (const k of Object.keys(initial as object)) {
      if (!(k in (parsed as object))) return false;
      if (!isCompatible((parsed as Record<string, unknown>)[k], (initial as Record<string, unknown>)[k])) return false;
    }
    return true;
  }
  return true;
}