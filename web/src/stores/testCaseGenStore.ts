import { useSyncExternalStore } from 'react';
import { loadRun, persistRun, clearRun, type RunStatus } from '../ui/runStatus';

/**
 * T01491（PRD-测试用例管理 §8.6）：从 PRD 生成测试用例的流式状态单例 store（仿 `prdGenStore.ts`）。
 *
 * 生成是长任务（后端 pipeline 分块 + 补生成，动辄数分钟），切页期间 SSE 回调仍需写入，
 * 故状态提升到模块作用域——返回本页与右侧控制台立即恢复最新进度（与 PRD 生成链路体验一致）。
 *
 * 结果类型是后端 `TcGenDraft` 的前端镜像（SSE `done` 事件负载）；字段口径以
 * `server/src/services/testCaseGenParse.ts` 的 `Draft*` 为单源，此处仅声明消费所需形状，不做二次运算。
 */

/** 草稿需求条目（镜像后端 DraftRequirement） */
export interface DraftRequirement {
  reqNo: string;
  title: string;
  content: string;
  sourceRef: string;
  priority: string;
  /** true = 本次新拆分；false = 复用已有 */
  isNew: boolean;
}

export interface DraftStep {
  action: string;
  expected: string;
}

/** 草稿用例条目（镜像后端 DraftCase） */
export interface DraftCase {
  reqNo: string;
  module: string;
  title: string;
  preconditions: string;
  expected: string;
  testData: string;
  postconditions: string;
  priority: string;
  type: string;
  method: string;
  tags: string;
  steps: DraftStep[];
  sourceKey: string;
  sourceHash: string;
  include: boolean;
  alreadyImported: boolean;
}

export interface DraftCoverage {
  total: number;
  covered: number;
  uncovered: number;
  rate: number;
  byReq: Array<{ reqNo: string; title: string; caseCount: number; isNew: boolean }>;
}

/** SSE `done` 事件负载 = 后端 TcGenDraft */
export interface TestCaseGenResult {
  requirements: DraftRequirement[];
  cases: DraftCase[];
  coverage: DraftCoverage;
  notes: string[];
  truncated: boolean;
}

export interface TestCaseGenState {
  streaming: boolean;
  logs: string[];
  streamText: string;
  result: TestCaseGenResult | null;
  /** 本次生成开始时间戳（ms），供控制台 tab 展示实时耗时 */
  startedAt?: number;
  /** 结束后保留的最终耗时（ms） */
  finalElapsed?: number;
}

const initialState = (): TestCaseGenState => ({
  streaming: false, logs: [], streamText: '', result: null,
});

// 模块初始化时水合刷新前持久化的最终耗时（与 prdGenStore 同款）
let state: TestCaseGenState = (() => {
  const base = initialState();
  const h = loadRun('tcgen');
  const fe = h?.finalElapsed;
  if (fe != null) base.finalElapsed = fe;
  return base;
})();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

// 当前生成流的 AbortController 引用——供控制台「停止」按钮跨组件中止底层 SSE（沿用 prdGenStore 语义）
let abortCtrl: AbortController | null = null;

export const testCaseGenStore = {
  get: (): TestCaseGenState => state,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
  /** 登记本次生成的 AbortController（由生成卡片面板发起时写入） */
  setAbortCtrl(c: AbortController | null) {
    abortCtrl = c;
  },
  /** 中止当前生成并把状态清空（供控制台「停止」按钮调用，幂等） */
  abort() {
    abortCtrl?.abort();
    abortCtrl = null;
    state = initialState();
    clearRun('tcgen');
    emit();
  },
  reset() {
    abortCtrl = null;
    state = initialState();
    clearRun('tcgen');
    emit();
  },
  begin() {
    const startedAt = Date.now();
    state = { streaming: true, logs: [], streamText: '', result: null, startedAt, finalElapsed: undefined };
    persistRun('tcgen', { status: 'running' as RunStatus, startedAt });
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
  setResult(result: TestCaseGenResult | null) {
    state = { ...state, result };
    emit();
  },
  finish(errorMsg?: string) {
    // 结束运行态同时由 startedAt 算最终耗时并保留
    const finalElapsed = state.startedAt ? Date.now() - state.startedAt : state.finalElapsed;
    state = errorMsg
      ? { ...state, streaming: false, startedAt: undefined, finalElapsed, logs: [...state.logs, errorMsg] }
      : { ...state, streaming: false, startedAt: undefined, finalElapsed };
    persistRun('tcgen', { status: (errorMsg ? 'error' : 'success') as RunStatus, finalElapsed });
    emit();
  },
};

export function useTestCaseGen(): TestCaseGenState {
  return useSyncExternalStore(testCaseGenStore.subscribe, testCaseGenStore.get);
}
