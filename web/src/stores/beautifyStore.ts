/**
 * AI 美化全局状态 store（模块级单例，脱离组件生命周期存活）。
 *
 * 背景（T00396 / T00393）：美化运行状态原存于 TasksPage 组件级 state，切页卸载后
 * 状态销毁、请求回调静默失效、草稿丢失。路径 2「状态提升」：把运行态与标题草稿
 * 提升到模块级 store，切页往返后运行指示与「美化完成待确认」草稿均保留。
 *
 * 设计：
 * - snapshot 不可变对象，经 useSyncExternalStore 订阅渲染（busy/batchBusy/drafts 参与渲染）。
 * - aborts 为模块级可变表（AbortController 不参与渲染），单条 key=taskId，批量 key='__batch__'。
 * - 组件卸载后 async 回调仍可写 store（setter 只操作模块级对象），回切页面即见最新状态。
 */

export type BeautifySnapshot = {
  /** 单条美化进行中集合：taskId -> true */
  busy: Record<string, boolean>;
  /** 批量美化独占标志 */
  batchBusy: boolean;
  /** 标题编辑/美化草稿：taskId -> 草稿文本（非 undefined 即视为该任务标题编辑中） */
  drafts: Record<string, string>;
};

let snapshot: BeautifySnapshot = { busy: {}, batchBusy: false, drafts: {} };

const listeners = new Set<() => void>();

function emit(next: Partial<BeautifySnapshot>): void {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((l) => l());
}

/** 进行中美化的中止控制器表；键约定：单条=taskId，批量='__batch__'（与 TasksPage 既有约定一致） */
const aborts: Record<string, AbortController> = {};

export const beautifyStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  getSnapshot(): BeautifySnapshot {
    return snapshot;
  },
  /** 中止控制器表（可变，直接读写；不触发渲染） */
  aborts,
  /** 记录某任务进入单条美化中 */
  setBusy(id: string): void {
    emit({ busy: { ...snapshot.busy, [id]: true } });
  },
  /** 某任务单条美化收尾（完成/失败/取消统一调用） */
  clearBusy(id: string): void {
    const busy = { ...snapshot.busy };
    delete busy[id];
    emit({ busy });
  },
  setBatchBusy(v: boolean): void {
    emit({ batchBusy: v });
  },
  /** 写入/更新单条标题草稿（value 传 undefined 表示删除该草稿=退出编辑态） */
  setDraft(id: string, value: string | undefined): void {
    const drafts = { ...snapshot.drafts };
    if (value === undefined) delete drafts[id];
    else drafts[id] = value;
    emit({ drafts });
  },
  /** 批量合并美化结果草稿 */
  mergeDrafts(partial: Record<string, string>): void {
    emit({ drafts: { ...snapshot.drafts, ...partial } });
  },
  /** 取消全部美化（单条+批量）：abort 所有 in-flight 并清运行态；已编辑草稿保留（与既有取消语义一致） */
  cancelAll(): void {
    Object.values(aborts).forEach((ac) => ac.abort());
    // 清空 aborts 表
    for (const k of Object.keys(aborts)) delete aborts[k];
    if (snapshot.batchBusy || Object.keys(snapshot.busy).length > 0) {
      emit({ busy: {}, batchBusy: false });
    }
  },
};
