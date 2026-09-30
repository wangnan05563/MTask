import { useSyncExternalStore } from 'react';
import { loadRun, persistRun, clearRun, type RunStatus } from './ui/runStatus';

/**
 * AI 周报流式状态的模块级单例 store。
 * 设计原因：AI 周报生成是长任务，用户可能中途反复切换页面（ReportPage 会被卸载）。
 * 若状态只挂在组件 useState 上，卸载期间 SSE 回调写入会失效、重挂载后进度与生成中标记一并丢失，
 * 导致"切页即中断、返回无进度"。故把运行状态提升到模块作用域并用 useSyncExternalStore 订阅，
 * 让 store 生命周期独立于组件：切页期间生成照常写入 store，返回后本页与右侧控制台立即恢复最新进度。
 */
export interface ReportStreamState {
  streaming: boolean;
  logs: string[];
  streamText: string;
  result: { token: string; filename: string } | null;
  /** T00839：本次生成开始时间戳（ms），供控制台 tab 展示实时耗时与悬停进度 */
  startedAt?: number;
  /** T01038：结束后保留的最终耗时（ms）——任务结束后停止计时，但保留最终耗时供展示 */
  finalElapsed?: number;
}

const initialState = (): ReportStreamState => ({ streaming: false, logs: [], streamText: '', result: null });

// T01038：模块初始化时水合刷新前持久化的最终耗时（仅 finalElapsed，避免刷新后伪造运行中态）
let state: ReportStreamState = (() => {
  const base = initialState();
  const h = loadRun('report');
  if (h?.finalElapsed != null) base.finalElapsed = h.finalElapsed;
  return base;
})();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

// T00838：当前周报生成流的 AbortController 引用——供「停止」按钮跨组件中止底层 SSE
let abortCtrl: AbortController | null = null;

export const reportStream = {
  get: (): ReportStreamState => state,
  /** 供 useSyncExternalStore 订阅，返回退订函数 */
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  /** T00838：登记当前生成的 AbortController（由 ReportPage 生成时写入） */
  setAbortCtrl(c: AbortController | null) {
    abortCtrl = c;
  },
  /** T00838：中止当前生成并把状态清空（供控制台「停止」按钮调用，幂等） */
  abort() {
    abortCtrl?.abort();
    abortCtrl = null;
    state = initialState();
    clearRun('report');
    emit();
  },
  reset() {
    abortCtrl = null;
    state = initialState();
    clearRun('report');
    emit();
  },
  /** 新一轮生成：清空历史并置为运行中（避免残留上次日志） */
  begin() {
    const startedAt = Date.now();
    state = { streaming: true, logs: [], streamText: '', result: null, startedAt, finalElapsed: undefined };
    persistRun('report', { status: 'running' as RunStatus, startedAt });
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
  setResult(result: { token: string; filename: string } | null) {
    state = { ...state, result };
    emit();
  },
  /** 失败或完成时结束运行态；失败信息单独记入日志以便控制台可见 */
  finish(errorMsg?: string) {
    // T01038：结束运行态同时由 startedAt 算最终耗时并保留（不再因清 startedAt 丢失「最终耗时」）
    const finalElapsed = state.startedAt ? Date.now() - state.startedAt : state.finalElapsed;
    state = errorMsg
      ? { ...state, streaming: false, startedAt: undefined, finalElapsed, logs: [...state.logs, errorMsg] }
      : { ...state, streaming: false, startedAt: undefined, finalElapsed };
    persistRun('report', { status: (errorMsg ? 'error' : 'success') as RunStatus, finalElapsed });
    emit();
  },
};

/** 订阅钩子：组件用它实时读取 store，卸载后 store 仍在，其它订阅者照常收到更新 */
export function useReportStream(): ReportStreamState {
  return useSyncExternalStore(reportStream.subscribe, reportStream.get);
}