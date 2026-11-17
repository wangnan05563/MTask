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

/** 数组缓存校验：结构类型必须同为数组，且空数组（无元素可参照）视为兼容 */
function isCompatibleArray(parsed: unknown, initial: unknown): boolean {
  if (!Array.isArray(initial)) return false;
  return initial.length === 0 || isCompatible((parsed as unknown[])[0], initial[0]);
}

/** 对象缓存校验：按初始值声明的每个键逐项递归校验（键缺失即不兼容） */
function isCompatibleObject(parsed: Record<string, unknown>, initial: Record<string, unknown>): boolean {
  for (const k of Object.keys(initial)) {
    if (!(k in parsed)) return false;
    if (!isCompatible(parsed[k], initial[k])) return false;
  }
  return true;
}

/** 递归校验缓存结构与类型是否可用，避免脏数据回填进表单 */
function isCompatible(parsed: unknown, initial: unknown): boolean {
  // 初始值为 null 表示「没有默认值」：任何已存值都按原样恢复（否则 false/0/'' 这类合法值会被判不兼容而丢失记忆）
  if (initial === null) return true;
  if (typeof parsed !== typeof initial) return false;
  if (parsed === null) return false;
  if (Array.isArray(parsed)) return isCompatibleArray(parsed, initial);
  if (Array.isArray(initial)) return false;
  if (typeof initial === 'object') {
    // typeof 守卫 + 前置 null 排除已将 initial 窄化为 object，无需再断言
    return isCompatibleObject(parsed as Record<string, unknown>, initial as Record<string, unknown>);
  }
  return true;
}