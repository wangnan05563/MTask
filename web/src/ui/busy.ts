import { useSyncExternalStore } from 'react';

/** 全局进行中标志：组件卸载（切页）不重置，供"创建/提交类"操作防止重复提交。
 *  之所以不用 useState/useSessionState：useState 切页丢失会导致请求进行中时再次点击重复插入；
 *  sessionStorage 恢复的值不会随原请求完成实时更新，会出现"永远禁用"。故用模块级 store + 订阅。 */
const busyMap = new Map<string, boolean>();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

/** 查询指定操作是否进行中 */
export function isBusy(key: string): boolean {
  return busyMap.get(key) ?? false;
}

/** 设置指定操作进行中状态；值不变时不通知，避免无谓重渲染 */
export function setBusy(key: string, busy: boolean) {
  if (busyMap.get(key) === busy) return;
  if (busy) busyMap.set(key, true);
  else busyMap.delete(key);
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 订阅指定操作进行中状态；getSnapshot 返回基础类型，跨渲染稳定，兼容 StrictMode */
export function useBusy(key: string): boolean {
  return useSyncExternalStore(subscribe, () => isBusy(key));
}