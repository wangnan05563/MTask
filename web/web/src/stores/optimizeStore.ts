import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * T03684：「提示词优化」（POST /ai/optimize）运行态的模块级 store。
 *
 * 症状（用户报「任务菜单，提示词优化等按钮功能，页面切换状态保持功能失效」的根因）：
 * App.tsx 切一级菜单是**卸载整页**（没有路由缓存/KeepAlive），而优化的进行中标志、取消控制器、
 * 结果回填目标草稿都挂在页面组件里，于是：
 *   ① 切走再切回，「正在生成优化文案…」呼吸态消失——用户以为请求没发出，往往再点一次；
 *   ② 「取消」入口随组件一起没了，在途请求无从中止；
 *   ③ 更糟的是结果：请求回来后 `setDescDrafts/setDrafts` 打在已卸载的组件上，React 直接丢弃，
 *      用户等了半天拿到的是「什么都没发生」。
 *
 * 解法沿用本仓已验证的两条通道，不新造机制：
 *   - 运行态与结果提升到模块级 store（T00396/T00393 对「AI 美化」的路径 2「状态提升」）：
 *     组件卸载后 async 回调照样写 store，回切页面即见最新运行指示与待落地结果；
 *   - 用户正在敲的草稿用会话级持久化（useSessionState，T00535/T00552 既有口径）。
 *
 * 键约定：`${页面}:${条目 id}`（如 `tasks:T01234`、`prompts:new`、`req:<uuid>`），
 * 页面只排own前缀的结果——多页共用一个模块 store，不能谁先挂载谁把别人的结果抢走。
 */

/** 三张页面的键域前缀（单源在此，避免各页自写字面量后互相抢结果） */
export const OPTIMIZE_SCOPE_TASKS = 'tasks:';
export const OPTIMIZE_SCOPE_PROMPTS = 'prompts:';
export const OPTIMIZE_SCOPE_REQ = 'req:';

/** 一次优化的结果：正文 + 输入来源（提示词页/任务页的完成 toast 要报「来源：描述/内容/标题」） */
export interface OptimizeResult {
  readonly text: string;
  readonly source: string;
  /** 落地时刻（ms）——同一 key 被后一次优化覆盖，页面据此判断结果是否比当前草稿新 */
  readonly at: number;
}

export interface OptimizeSnapshot {
  /** 进行中的优化：key -> true（支持多条并行，与任务页既有 optimizingMap 语义一致） */
  readonly busy: Record<string, boolean>;
  /** 已完成但尚未被页面取走的结果：key -> 结果（页面挂载期间即取即清，等价于「当场回填」） */
  readonly results: Record<string, OptimizeResult>;
}

let snapshot: OptimizeSnapshot = { busy: {}, results: {} };
const listeners = new Set<() => void>();
/** 中止控制器表（可变，不参与渲染；键与 busy 同域） */
const aborts: Record<string, AbortController> = {};

function emit(next: Partial<OptimizeSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((l) => l());
}

export const optimizeStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  getSnapshot(): OptimizeSnapshot {
    return snapshot;
  },
  aborts,
  /** 标记某条优化进入进行中（同时清掉该 key 的上一次未取走结果，避免旧结果串到新一次） */
  setBusy(key: string): void {
    const results = { ...snapshot.results };
    delete results[key];
    emit({ busy: { ...snapshot.busy, [key]: true }, results });
  },
  /** 收尾：完成/失败/取消统一调用 */
  clearBusy(key: string): void {
    const busy = { ...snapshot.busy };
    delete busy[key];
    emit({ busy });
  },
  /** 暂存结果（唯一写结果入口）：页面在不在都能收下，回来由 drain 落到草稿 */
  parkResult(key: string, text: string, source: string): void {
    emit({ results: { ...snapshot.results, [key]: { text, source, at: Date.now() } } });
  },
  /** 页面已把结果写进草稿后清掉，避免重复回填 */
  takeResult(key: string): void {
    if (!(key in snapshot.results)) return;
    const results = { ...snapshot.results };
    delete results[key];
    emit({ results });
  },
  /** 取消指定 key 的优化：中止在途请求 + 清运行态；返回是否确有在途请求被中止 */
  cancel(key: string): boolean {
    const had = Boolean(snapshot.busy[key]);
    aborts[key]?.abort();
    delete aborts[key];
    this.clearBusy(key);
    return had;
  },
  /** 页面卸载/会话清理时丢弃全部待落地结果（正常流程不需要，保留给「放弃优化」类动作） */
  dropAll(): void {
    Object.keys(aborts).forEach((k) => delete aborts[k]);
    emit({ busy: {}, results: {} });
  },
};

/** 把 store 的带前缀 busy 折成「本页条目 id -> true」视图，页面渲染处不必再拼前缀。 */
export function busyScope(snapshot: OptimizeSnapshot, prefix: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [key, on] of Object.entries(snapshot.busy)) {
    if (on && key.startsWith(prefix)) out[key.slice(prefix.length)] = true;
  }
  return out;
}

/**
 * 订阅 store 并把「本页面域内」的待落地结果排入页面草稿。
 * @param prefix 本页面键前缀（如 `tasks:`）——只处理自己域内的 key
 * @param apply  (id, result) => void；id 是去掉前缀后的条目 id，由调用方写进自己的草稿
 */
export function useOptimizeStore(prefix: string, apply?: (id: string, result: OptimizeResult) => void): OptimizeSnapshot {
  const snap = useSyncExternalStore(optimizeStore.subscribe, optimizeStore.getSnapshot);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const results = snap.results;
  useEffect(() => {
    const fn = applyRef.current;
    if (!fn) return;
    const keys = Object.keys(results).filter((k) => k.startsWith(prefix));
    if (keys.length === 0) return;
    for (const k of keys) fn(k.slice(prefix.length), results[k]);
    keys.forEach((k) => optimizeStore.takeResult(k));
  }, [prefix, results]);
  return snap;
}

/** 发起侧的公共封装：置 busy + 挂 AbortController，收尾统一清运行态与控制器。
 *  调用方保留自己的入参构造、结果剥离与 toast 文案（三页口径各不相同，不在 store 里混装）。 */
export async function runOptimize<T>(
  key: string,
  signalable: (signal: AbortSignal) => Promise<T>,
  onResult: (value: T) => { text: string; source: string } | null,
): Promise<{ ok: boolean; error?: string }> {
  if (optimizeStore.getSnapshot().busy[key]) return { ok: false, error: '该条优化已在进行中' };
  const ac = new AbortController();
  optimizeStore.aborts[key] = ac;
  optimizeStore.setBusy(key);
  try {
    const value = await signalable(ac.signal);
    const parsed = onResult(value);
    if (!parsed) return { ok: false, error: 'AI 未返回可用结果' };
    optimizeStore.parkResult(key, parsed.text, parsed.source);
    return { ok: true };
  } catch (e) {
    if ((e as Error).name === 'AbortError') return { ok: false, error: '已取消优化' };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    optimizeStore.clearBusy(key);
    delete optimizeStore.aborts[key];
  }
}
