import { useSyncExternalStore } from 'react';

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
}

const initialState = (): ReportStreamState => ({ streaming: false, logs: [], streamText: '', result: null });

let state: ReportStreamState = initialState();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const reportStream = {
  get: (): ReportStreamState => state,
  /** 供 useSyncExternalStore 订阅，返回退订函数 */
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  /** 新一轮生成：清空历史并置为运行中（避免残留上次日志） */
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
  setResult(result: { token: string; filename: string } | null) {
    state = { ...state, result };
    emit();
  },
  /** 失败或完成时结束运行态；失败信息单独记入日志以便控制台可见 */
  finish(errorMsg?: string) {
    state = errorMsg ? { ...state, streaming: false, logs: [...state.logs, errorMsg] } : { ...state, streaming: false };
    emit();
  },
};

/** 订阅钩子：组件用它实时读取 store，卸载后 store 仍在，其它订阅者照常收到更新 */
export function useReportStream(): ReportStreamState {
  return useSyncExternalStore(reportStream.subscribe, reportStream.get);
}