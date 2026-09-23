import { useSyncExternalStore } from 'react';

/**
 * T00769：原始需求生成 PRD 的流式状态单例 store（仿 reportStream）。
 * 生成是长任务，切页期间 SSE 回调仍需写入，故状态提升到模块作用域，
 * 返回本页与右侧控制台立即恢复最新进度。
 */
export interface PrdGenIssue { level: string; question: string; context: string; suggestion: string }

/** T00933：批次中已完成的单份结果——多选生成时逐份留存，避免前序文档结果被下一份覆盖后"凭空消失" */
export interface PrdBatchItem {
  id: string;
  filename: string;
  prdMd: string;
  issues: PrdGenIssue[];
  failed?: boolean;
}

export interface PrdGenState {
  streaming: boolean;
  logs: string[];
  streamText: string;
  result: { prdMd: string; issues: PrdGenIssue[] } | null;
  /** T00839：本次生成开始时间戳（ms），供控制台 tab 展示实时耗时与悬停进度 */
  startedAt?: number;
  /** T00933：多选批次已完成的各份结果（顺序 = 生成顺序） */
  batch: PrdBatchItem[];
  /** T00933：批次总数与当前序号（1-based），用于控制台与面板展示进度 */
  batchTotal: number;
  batchIndex: number;
}

const initialState = (): PrdGenState => ({
  streaming: false, logs: [], streamText: '', result: null, batch: [], batchTotal: 0, batchIndex: 0,
});

let state: PrdGenState = initialState();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

// T00838：当前 PRD 生成流的 AbortController 引用——供「停止」按钮跨组件中止底层 SSE
let abortCtrl: AbortController | null = null;

export const prdGenStore = {
  get: (): PrdGenState => state,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
  /** T00838：登记当前生成的 AbortController（由 PrdGenPanel 生成时写入） */
  setAbortCtrl(c: AbortController | null) {
    abortCtrl = c;
  },
  /** T00838：中止当前生成并把状态清空（供控制台「停止」按钮调用，幂等） */
  abort() {
    abortCtrl?.abort();
    abortCtrl = null;
    state = initialState();
    emit();
  },
  reset() {
    abortCtrl = null;
    state = initialState();
    emit();
  },
  begin() {
    state = { streaming: true, logs: [], streamText: '', result: null, startedAt: Date.now(), batch: [], batchTotal: 0, batchIndex: 0 }; // T00839：记录生成起始
    emit();
  },
  /**
   * T00933：批次开始——只清一次日志/结果，后续每份由 beginFile 追加分隔日志，
   * 不再让第 2 份起把前一份的结果与日志整批清掉（原缺陷：多选只有最后一份留痕）。
   */
  beginBatch(total: number) {
    state = { streaming: true, logs: [], streamText: '', result: null, startedAt: Date.now(), batch: [], batchTotal: total, batchIndex: 0 };
    emit();
  },
  /** T00933：批次内第 index 份开始（1-based）——重置流式正文/结果，日志只追加分隔行 */
  beginFile(index: number, filename: string) {
    state = { ...state, streaming: true, streamText: '', result: null, batchIndex: index, startedAt: Date.now() };
    emit();
    this.pushLog(`──── 第 ${index}/${state.batchTotal} 份：${filename} ────`);
  },
  /** T00933：一份生成完成（成功/失败都入册，失败项在面板上标红可重试查看） */
  pushBatchItem(item: PrdBatchItem) {
    state = { ...state, batch: [...state.batch, item] };
    emit();
  },
  /** T00933：批次收尾——统一给出成功/失败统计（控制台与面板据此提示） */
  finishBatch(okCount: number) {
    const total = state.batchTotal;
    state = {
      ...state,
      streaming: false,
      startedAt: undefined,
      logs: [...state.logs, `批次生成完成：成功 ${okCount}/${total} 份${okCount > 0 ? '，请在下方「批次结果」中逐份确认并录入' : ''}`],
    };
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
    // T00839：结束运行态同时清掉起始时间，避免已完成 tab 残留“已运行”时长
    state = errorMsg ? { ...state, streaming: false, startedAt: undefined, logs: [...state.logs, errorMsg] } : { ...state, streaming: false, startedAt: undefined };
    emit();
  },
};

export function usePrdGen(): PrdGenState {
  return useSyncExternalStore(prdGenStore.subscribe, prdGenStore.get);
}
