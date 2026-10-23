import { useSyncExternalStore } from 'react';
import { loadRun, persistRun, clearRun, type RunStatus } from '../ui/runStatus';

/**
 * T02857（六期 S6，PRD-阶段性项目总结汇报PPT §3.1 FR-1.4 / §3.4）：阶段性总结汇报 PPT 的模块级运行态 store。
 *
 * 与 `kickoffPptStore` 同族同构：生成是分钟级长任务（采集 → 大纲确认 → 逐页装配 → 落盘），
 * 切页期间 SSE 回调仍需写入，返回本页/控制台要立即恢复进度，故不能放组件内 state。
 *
 * 字段口径以服务端为单源：
 *  - `outline` 镜像 `server/src/services/summaryPptOutline.ts` 的 `SummaryOutlineItem`（S3 契约）；
 *  - `result` 是 SSE `done` 负载 `{ token, fileName, pageCount, warnings, projects, degradedPages }`（S5 契约）。
 */

/** 大纲一页（服务端 `SummaryOutlineItem` 的前端镜像；section/layout/dataKeys 由服务端白名单校验） */
export interface SummaryOutlineItem {
  section: string;
  title: string;
  bullets: string[];
  dataKeys: string[];
  layout: string;
  /** 合并版分区键：每项目的 4 页必须带；单项目可省略 */
  projectId?: string;
}

/** 一页归属的项目（`done.projects`，与范围同序） */
export interface SummaryProjectPages {
  id: string;
  name: string;
  pages: number;
}

/** SSE `done` 负载：token 即下载令牌（服务端 saveReportBuffer 落盘的单源产物标识） */
export interface SummaryStreamResult {
  token: string;
  fileName: string;
  pageCount: number;
  warnings: string[];
  projects: SummaryProjectPages[];
  /** 被版式断言降级为安全版式的页码（1 基；空=全页原生版式） */
  degradedPages: number[];
}

export interface SummaryPptState {
  streaming: boolean;
  logs: string[];
  /** 大纲（AI 产出 + 用户就地编辑的当前态；面板与「开始生成」共用同一份） */
  outline: SummaryOutlineItem[];
  /** 大纲段的降级提示（页数截断、字段修正等，与服务端 warnings 同语义） */
  outlineWarnings: string[];
  result: SummaryStreamResult | null;
  startedAt?: number;
  finalElapsed?: number;
}

const initialState = (): SummaryPptState => ({
  streaming: false, logs: [], outline: [], outlineWarnings: [], result: null,
});

// 模块初始化时水合刷新前持久化的最终耗时（与 prdGenStore/tcGenStore/kickoffPptStore 同款）
let state: SummaryPptState = (() => {
  const base = initialState();
  const fe = loadRun('summaryppt')?.finalElapsed;
  if (fe != null) base.finalElapsed = fe;
  return base;
})();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

// 本次流的 AbortController——控制台「停止」按钮跨组件中止底层 SSE（沿用 kickoffPptStore 语义）
let abortCtrl: AbortController | null = null;

export const summaryPptStore = {
  get: (): SummaryPptState => state,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
  setAbortCtrl(c: AbortController | null) {
    abortCtrl = c;
    emit();
  },
  /** 中止当前生成并清空运行态（幂等，供控制台「停止」与卡片侧重置共用） */
  abort() {
    abortCtrl?.abort();
    abortCtrl = null;
    state = initialState();
    clearRun('summaryppt');
    emit();
  },
  reset() {
    summaryPptStore.abort();
  },
  begin() {
    const startedAt = Date.now();
    state = { ...state, streaming: true, logs: [], result: null, startedAt, finalElapsed: undefined };
    persistRun('summaryppt', { status: 'running' as RunStatus, startedAt });
    emit();
  },
  pushLog(msg: string) {
    state = { ...state, logs: [...state.logs, msg] };
    emit();
  },
  setOutline(outline: SummaryOutlineItem[], warnings: string[] = []) {
    state = { ...state, outline, outlineWarnings: warnings };
    emit();
  },
  setResult(result: SummaryStreamResult | null) {
    state = { ...state, result };
    emit();
  },
  finish(errorMsg?: string) {
    const finalElapsed = state.startedAt ? Date.now() - state.startedAt : state.finalElapsed;
    state = errorMsg
      ? { ...state, streaming: false, startedAt: undefined, finalElapsed, logs: [...state.logs, errorMsg] }
      : { ...state, streaming: false, startedAt: undefined, finalElapsed };
    persistRun('summaryppt', { status: (errorMsg ? 'error' : 'success') as RunStatus, finalElapsed });
    emit();
  },
};

export function useSummaryPpt(): SummaryPptState {
  return useSyncExternalStore(summaryPptStore.subscribe, summaryPptStore.get);
}
