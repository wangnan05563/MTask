import { useSyncExternalStore } from 'react';
import { loadRun, persistRun, clearRun, type RunStatus } from '../ui/runStatus';

/**
 * T02109（PRD-项目启动会PPT生成 §3.1 FR-1.4 · 技术方案 §6）：「项目启动会 PPT 生成」的模块级运行态 store。
 *
 * 为什么提到模块作用域：启动会稿是分钟级长任务（采集 → 措辞 → 逐页装配 → 落盘），
 * 切页期间 SSE 回调仍需写入，返回本页/控制台要立即恢复进度——与 `prdGenStore`/`testCaseGenStore` 同族同构。
 *
 * 字段口径以服务端为单源，前端不二次运算：
 *  - `outline` 镜像 `server/src/services/kickoffService.ts` 的 `KickoffOutlineItem`（T02096 §2.2）；
 *  - `result` 是 SSE `done` 事件负载 `{ token, fileName, pageCount, warnings }`（T02103 §2.3）。
 */

/** 大纲一页（服务端 `KickoffOutlineItem` 的前端镜像；dataKeys/layout 由服务端白名单校验） */
export interface KickoffOutlineItem {
  section: string;
  title: string;
  bullets: string[];
  dataKeys: string[];
  layout: string;
}

/** SSE `done` 负载：token 即下载令牌（服务端 saveReportBuffer 落盘的单源产物标识） */
export interface KickoffStreamResult {
  token: string;
  fileName: string;
  pageCount: number;
  warnings: string[];
}

export interface KickoffPptState {
  streaming: boolean;
  logs: string[];
  /** 大纲（AI 产出 + 用户就地编辑的当前态；面板与「开始生成」共用同一份） */
  outline: KickoffOutlineItem[];
  /** 大纲段的降级提示（页数截断、字段修正等，与服务端 warnings 同语义） */
  outlineWarnings: string[];
  result: KickoffStreamResult | null;
  startedAt?: number;
  finalElapsed?: number;
}

const initialState = (): KickoffPptState => ({
  streaming: false, logs: [], outline: [], outlineWarnings: [], result: null,
});

// 模块初始化时水合刷新前持久化的最终耗时（与 prdGenStore/tcGenStore 同款）
let state: KickoffPptState = (() => {
  const base = initialState();
  const fe = loadRun('kickoffppt')?.finalElapsed;
  if (fe != null) base.finalElapsed = fe;
  return base;
})();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

// 本次流的 AbortController——控制台「停止」按钮跨组件中止底层 SSE（沿用 tcGenStore 语义）
let abortCtrl: AbortController | null = null;

export const kickoffPptStore = {
  get: (): KickoffPptState => state,
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
    clearRun('kickoffppt');
    emit();
  },
  reset() {
    kickoffPptStore.abort();
  },
  begin() {
    const startedAt = Date.now();
    state = { ...state, streaming: true, logs: [], result: null, startedAt, finalElapsed: undefined };
    persistRun('kickoffppt', { status: 'running' as RunStatus, startedAt });
    emit();
  },
  pushLog(msg: string) {
    state = { ...state, logs: [...state.logs, msg] };
    emit();
  },
  setOutline(outline: KickoffOutlineItem[], warnings: string[] = []) {
    state = { ...state, outline, outlineWarnings: warnings };
    emit();
  },
  setResult(result: KickoffStreamResult | null) {
    state = { ...state, result };
    emit();
  },
  finish(errorMsg?: string) {
    const finalElapsed = state.startedAt ? Date.now() - state.startedAt : state.finalElapsed;
    state = errorMsg
      ? { ...state, streaming: false, startedAt: undefined, finalElapsed, logs: [...state.logs, errorMsg] }
      : { ...state, streaming: false, startedAt: undefined, finalElapsed };
    persistRun('kickoffppt', { status: (errorMsg ? 'error' : 'success') as RunStatus, finalElapsed });
    emit();
  },
};

export function useKickoffPpt(): KickoffPptState {
  return useSyncExternalStore(kickoffPptStore.subscribe, kickoffPptStore.get);
}
