import type { ExtractView } from '../pages/GitExtractPanel';

/**
 * T05696：Git 增量资产提取卡的模块级运行态。
 *
 * 根因（同 T05683 两 PPT 卡）：`running/aborted/jobId/stageIdx/runError/result` 是面板组件内
 * useState，卡片条件渲染卸载即归零——而提取是 SSE 长任务，切走再切回时请求仍在飞，
 * 按钮却恢复可点，用户重复触发 = 重复烧盘/并发闸误伤。
 *
 * 提升到 store 后：组件卸载期间 SSE 回调照常写 store，收口正常落库；切回时从快照恢复
 * 「运行中 + 阶段进度 + 已有结果/错误」，按钮态与真实任务一致。
 *
 * AbortController 沿用 codeReviewLectureStore 先例：模块级变量不进 state，
 * 「停止」按钮与流收口共用（组件卸载重挂后仍能拿到同一个 controller 中止真实任务）。
 */

export interface GitExtractRunState {
  /** SSE 提取进行中（按钮禁用依据） */
  running: boolean;
  /** 已收到/已确认中止 */
  aborted: boolean;
  /** 当前 job（服务端受理标识） */
  jobId: string;
  /** 阶段进度索引（-1 = 未开始） */
  stageIdx: number;
  /** 本次运行的错误（并发闸拒绝有专门文案） */
  runError: string;
  /** done 帧的提取结果（切走再切回不丢「提取完成」展示） */
  result: ExtractView | null;
}

const initialState = (): GitExtractRunState => ({
  running: false,
  aborted: false,
  jobId: '',
  stageIdx: -1,
  runError: '',
  result: null,
});

let state: GitExtractRunState = initialState();
let abortCtrl: AbortController | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const gitExtractStore = {
  get: (): GitExtractRunState => state,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
  /** 开始一次提取：清场置运行中（start 入口单点调用） */
  startRun(ctrl: AbortController) {
    abortCtrl = ctrl;
    state = { ...initialState(), running: true };
    emit();
  },
  /** mode 切换等主动清场（不动 running——此时不可能在跑） */
  resetRun() {
    state = { ...initialState() };
    emit();
  },
  patch(p: Partial<GitExtractRunState>) {
    state = { ...state, ...p };
    emit();
  },
  /** 流收口（成功/失败/中止统一走）：归位运行态 */
  finishRun() {
    abortCtrl = null;
    state = { ...state, running: false };
    emit();
  },
  /** 中止：置 aborted 并归位（abort 前先 finishRun 由调用方编排也可，这里一步到位） */
  markAborted() {
    state = { ...state, running: false, aborted: true };
    emit();
  },
  getAbortCtrl: (): AbortController | null => abortCtrl,
};
