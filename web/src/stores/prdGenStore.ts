import { useSyncExternalStore } from 'react';

/**
 * T00769：原始需求生成 PRD 的流式状态单例 store（仿 reportStream）。
 * 生成是长任务，切页期间 SSE 回调仍需写入，故状态提升到模块作用域，
 * 返回本页与右侧控制台立即恢复最新进度。
 */
export interface PrdGenIssue { level: string; question: string; context: string }

export interface PrdGenState {
  streaming: boolean;
  logs: string[];
  streamText: string;
  result: { prdMd: string; issues: PrdGenIssue[] } | null;
}

const initialState = (): PrdGenState => ({ streaming: false, logs: [], streamText: '', result: null });

let state: PrdGenState = initialState();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const prdGenStore = {
  get: (): PrdGenState => state,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
  begin() {
    state = { streaming: true, logs: [], streamText: '', result: null };
    emit();
  },
  pushLog(msg: string) {
    state = { ...state, logs: [...state.logs, msg] };
    emit();
  },
  appendText(text: string) {
    state = { ...state, streamText: state.streamText + text };
    emit();
  },
  setResult(result: { prdMd: string; issues: PrdGenIssue[] } | null) {
    state = { ...state, result };
    emit();
  },
  finish(errorMsg?: string) {
    state = errorMsg ? { ...state, streaming: false, logs: [...state.logs, errorMsg] } : { ...state, streaming: false };
    emit();
  },
};

export function usePrdGen(): PrdGenState {
  return useSyncExternalStore(prdGenStore.subscribe, prdGenStore.get);
}
