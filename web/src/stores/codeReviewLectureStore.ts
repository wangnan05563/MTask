import { useSyncExternalStore } from 'react';
import { clearRun, loadRun, persistRun, type RunStatus } from '../ui/runStatus';
import type { LectureAnchorRef, LectureDiffProject } from '../utils/lectureDiff';
import type { LectureMark } from '../utils/lectureMarkup';

/**
 * T02872（六期 3.1，PRD §6.1 三区布局）：代码评审会议讲稿面板的模块级运行态 store。
 *
 * 与 `summaryPptStore` / `kickoffPptStore` 同族：生成是分钟级长任务（采集 → 大纲 → 八段逐组流出），
 * SSE 回调在切页期间仍需写入，返回本页要立即恢复进度与已流出正文，故不放组件内 state。
 * 左栏 diff 视图同样存这里（体积大且重取要再跑一遍 git 采集，不适合 sessionStorage）。
 *
 * 字段口径以服务端为单源：`sections`/`anchors`/`stats` 镜像
 * `server/src/services/lectureStream.ts` 的 `LectureStreamResult`。
 * 标记态（采纳/会后跟进/忽略）本期不落库（E-4），随 `begin(keepMarks)` 决定是否跨续作保留。
 */

/** 服务端 `LectureOutline` 的前端镜像（大纲段的 key 固定八项，标题/要点可被用户改写） */
export interface LectureOutlineSection {
  key: string;
  title: string;
  bullets: string[];
  projectIds?: string[];
}
export interface LectureOutline {
  sections: LectureOutlineSection[];
  discussion_questions: string[];
}

/** SSE `done` 的单节结果（`segments` 为逐项目/逐模块分段明细） */
export interface LectureSegmentResult {
  projectId: string;
  projectName: string;
  module: string;
  heading?: string;
  ok: boolean;
  text: string;
  error?: string;
  anchors: number;
  anchorIssues: number;
}
export interface LectureSectionResult {
  key: string;
  label: string;
  ok: boolean;
  text: string;
  error?: string;
  segments: LectureSegmentResult[];
}

/** 锚点条目（服务端已校验落点，blobSha 仅 git 模式有） */
export interface LectureAnchorEntry {
  file: string;
  startLine: number;
  endLine: number;
  projectId: string;
  section: string;
  blobSha?: string;
  baseCommit?: string;
  [k: string]: unknown;
}

export interface LectureStats {
  projects: number;
  readyProjects: number;
  files: number;
  groups: number;
  chars: number;
  contextBudget: number;
  sections: number;
  segments: number;
  calls: number;
  anchors: number;
  anchorIssues: number;
}

/** SSE `done` 负载（导出令牌在 T02874 接入，这里不含 token） */
export interface LectureStreamResult {
  ok: boolean;
  aborted: boolean;
  title: string;
  markdown: string;
  outline?: LectureOutline;
  sections: LectureSectionResult[];
  warnings: string[];
  stats: LectureStats;
  anchors: LectureAnchorEntry[];
}

export interface CodeReviewLectureState {
  streaming: boolean;
  logs: string[];
  /** 最近一次阶段事件（底部状态条消费：阶段文案 + 进度） */
  stage: { phase: string; msg: string; progress: number } | null;
  /** 本次/上次生成的大纲（`outline_ready` 即写入：中止后「从第 n 节继续」要靠它补节标题） */
  outline: LectureOutline | null;
  /** 逐段流式中的实时正文（key=section key；`done` 后以服务端 sections 为准） */
  live: Record<string, string>;
  /** 各节完成态（`section_done` 事件；失败节是「从第 n 节继续 / 单节重试」的候选） */
  sectionOk: Record<string, boolean>;
  result: LectureStreamResult | null;
  /** 三态标记（E-4 不落库：只在本次会话内存里） */
  marks: Record<string, LectureMark>;
  /** 左栏 diff 视图（POST /plans/code-review-lecture/diff） */
  diff: LectureDiffProject[];
  diffLoading: boolean;
  diffError: string;
  startedAt?: number;
  finalElapsed?: number;
}

const initialState = (): CodeReviewLectureState => ({
  streaming: false,
  logs: [],
  stage: null,
  outline: null,
  live: {},
  sectionOk: {},
  result: null,
  marks: {},
  diff: [],
  diffLoading: false,
  diffError: '',
});

let state: CodeReviewLectureState = (() => {
  const base = initialState();
  const fe = loadRun('reviewlecture')?.finalElapsed;
  if (fe != null) base.finalElapsed = fe;
  return base;
})();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

// 本次流的 AbortController——底部状态条「停止」与卡片重置共用（沿用 summaryPptStore 语义）
let abortCtrl: AbortController | null = null;

export const codeReviewLectureStore = {
  get: (): CodeReviewLectureState => state,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
  setAbortCtrl(c: AbortController | null) {
    abortCtrl = c;
    emit();
  },
  /** 中止当前生成并清空运行态（幂等；diff 视图保留——停止后左栏仍应可看） */
  abort() {
    abortCtrl?.abort();
    abortCtrl = null;
    state = { ...initialState(), diff: state.diff };
    clearRun('reviewlecture');
    emit();
  },
  /**
   * 「停止」：只掐流，不清状态——已生成的节与大纲必须留着，才能「从第 n 节继续」（PRD §6.2）。
   * 清空走 `abort()`（卡片重置用）。
   */
  stop() {
    abortCtrl?.abort();
    abortCtrl = null;
    emit();
  },
  reset() {
    codeReviewLectureStore.abort();
  },
  begin(keepMarks = false) {
    const startedAt = Date.now();
    state = {
      ...state, streaming: true, logs: [], stage: null, live: {}, sectionOk: {}, result: null,
      marks: keepMarks ? state.marks : {}, startedAt, finalElapsed: undefined,
    };
    persistRun('reviewlecture', { status: 'running' as RunStatus, startedAt });
    emit();
  },
  pushLog(msg: string) {
    state = { ...state, logs: [...state.logs, msg] };
    emit();
  },
  setStage(stage: { phase: string; msg: string; progress: number } | null) {
    state = { ...state, stage, ...(stage ? { logs: [...state.logs, stage.msg] } : {}) };
    emit();
  },
  /** `chunk` 增量按节累积 */
  appendLive(section: string, text: string) {
    state = { ...state, live: { ...state.live, [section]: (state.live[section] ?? '') + text } };
    emit();
  },
  setOutline(outline: LectureOutline | null) {
    state = { ...state, outline };
    emit();
  },
  setSectionOk(section: string, ok: boolean) {
    state = { ...state, sectionOk: { ...state.sectionOk, [section]: ok } };
    emit();
  },
  setMark(key: string, mark: LectureMark) {
    const marks = { ...state.marks };
    if (mark === 'adopt') delete marks[key];
    else marks[key] = mark;
    state = { ...state, marks };
    emit();
  },
  resetMarks() {
    state = { ...state, marks: {} };
    emit();
  },
  setResult(result: LectureStreamResult | null) {
    state = { ...state, result, live: {} };
    emit();
  },
  setDiffLoading(loading: boolean) {
    state = { ...state, diffLoading: loading, ...(loading ? { diffError: '' } : {}) };
    emit();
  },
  setDiff(projects: LectureDiffProject[], error = '') {
    state = { ...state, diff: projects, diffLoading: false, diffError: error };
    emit();
  },
  finish(errorMsg?: string) {
    const finalElapsed = state.startedAt ? Date.now() - state.startedAt : state.finalElapsed;
    state = errorMsg
      ? { ...state, streaming: false, startedAt: undefined, finalElapsed, logs: [...state.logs, errorMsg] }
      : { ...state, streaming: false, startedAt: undefined, finalElapsed };
    persistRun('reviewlecture', { status: (errorMsg ? 'error' : 'success') as RunStatus, finalElapsed });
    emit();
  },
};

export function useCodeReviewLecture(): CodeReviewLectureState {
  return useSyncExternalStore(codeReviewLectureStore.subscribe, codeReviewLectureStore.get);
}

/** 锚点跳转的目标：由右栏点击解析出的 ref + 左栏应展开的文件路径 */
export interface LectureLocateTarget {
  projectId: string;
  anchor: LectureAnchorRef;
}
