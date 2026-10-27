import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * T02213：桌面端「非项目资源」取数的通用可见失败态层。
 *
 * 治的是 T02201 在项目列表上收敛过的那类静默失败在其余资源上的残留：
 * `api.get(...).then(setX).catch(() => undefined)` 把异常整体吞掉，
 * 「请求失败」与「本来就没数据」在 UI 上完全同形，工期换算、开关回显等
 * 甚至会把缺失当成 0/false 参与计算，产出看似正常的错误结果。
 *
 * 口径与 `ui/projectList.tsx`（T02201）保持一致，但不与之共用快照：
 * 那层是跨页面共享的单飞项目缓存，本层是**页面局部资源**（命令面板任务、
 * 节假日、AI 工具…），生命周期随宿主组件，不需要模块级单飞。
 * - 显式状态机 `loading | ready | error`，失败态必须给出原因与重试入口；
 * - **失败绝不覆盖旧数据**：保留上次成功结果并标记 `stale`，供 UI 注明可能过期；
 * - 迟到的上一轮响应不会覆盖新一轮（请求令牌）。
 */

export type ResourcePhase = 'loading' | 'ready' | 'error';

export interface ResourceView<T> {
  /** 最近一次成功的数据；从未成功时为 null */
  data: T | null;
  phase: ResourcePhase;
  error: string;
  /** 失败但手上仍有旧数据：可继续展示，但 UI 需注明可能过期 */
  stale: boolean;
  /** 重新发起请求（重试按钮 / 写操作后刷新） */
  reload: () => void;
  /** 本地写入（写操作成功后同步数据，省一次 GET）；写入即视为 ready */
  setData: (value: T) => void;
}

export function useResource<T>(
  loader: () => Promise<T>,
  opts: { readonly enabled?: boolean } = {},
): ResourceView<T> {
  const { enabled = true } = opts;
  const loadRef = useRef(loader);
  loadRef.current = loader;
  const roundRef = useRef(0);
  const [state, setState] = useState<{ data: T | null; phase: ResourcePhase; error: string }>({
    data: null, phase: 'loading', error: '',
  });

  const run = useCallback(() => {
    const round = ++roundRef.current;
    setState((s) => ({ data: s.data, phase: 'loading', error: '' }));
    void (async () => {
      try {
        const value = await loadRef.current();
        if (round !== roundRef.current) return; // 已有更新的一轮在跑，丢弃迟到结果
        setState({ data: value, phase: 'ready', error: '' });
      } catch (e) {
        if (round !== roundRef.current) return;
        // 失败：data 保持上次成功值（不冒充正常数据，phase 落 error 供 UI 显式呈现）
        setState((s) => ({ ...s, phase: 'error', error: e instanceof Error ? e.message : String(e) }));
      }
    })();
  }, []);

  useEffect(() => { if (enabled) run(); }, [enabled, run]);

  const setData = useCallback((value: T) => {
    roundRef.current++; // 作废在途请求，避免写后刷新被旧响应覆盖
    setState({ data: value, phase: 'ready', error: '' });
  }, []);

  return {
    data: state.data,
    phase: state.phase,
    error: state.error,
    stale: state.phase === 'error' && state.data !== null,
    reload: run,
    setData,
  };
}

export type ResourceHintView = Pick<ResourceView<unknown>, 'phase' | 'error' | 'stale' | 'reload'>;

/**
 * T03213 / UX-01 ④：交互元素嵌套约束的判据。
 * `ResourceHint` 失败态自带「重试」`<button>`，若被放进原生 `<button>` / `<a>` 内部，
 * 会产出非法 DOM（React `validateDOMNesting` 警告）并让点击语义串味
 * （点重试连带触发宿主，即 T02283→e75f5b3 修掉的那类回归）。
 */
const INTERACTIVE_ANCESTOR = 'button, a[href], [role="button"]';

/** 元素的祖先链（不含自身）上是否存在交互元素 */
export function hasInteractiveAncestor(el: Element | null): boolean {
  return el?.parentElement?.closest(INTERACTIVE_ANCESTOR) != null;
}

/**
 * 失败/加载中提示行（放在对应控件旁）：与 `ProjectListHint` 同一套文案与视觉语言。
 * 加载中默认不显示（多数场景有旧数据可用，不必打断操作），失败态始终给出原因与重试入口。
 * 宿主是交互元素时降级为无重试按钮的文本态（仍给出原因），不让「重试」嵌进按钮里。
 */
export function ResourceHint({ view, label, showLoading = false, style }: {
  readonly view: ResourceHintView;
  readonly label: string;
  readonly showLoading?: boolean;
  readonly style?: React.CSSProperties;
}) {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const [nested, setNested] = useState(false);
  useEffect(() => {
    if (!nested && hasInteractiveAncestor(hostRef.current)) {
      setNested(true);
      console.warn(`[ResourceHint] 「${label}」被渲染进交互元素内部，已降级为无重试按钮的文本态；请把提示移到该按钮的同级位置。`);
    }
  }, [nested, label]);

  if (view.phase === 'error') {
    return (
      <span
        ref={hostRef}
        role="status"
        data-t02213="resource-error"
        data-nested={nested ? 'true' : undefined}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-s)', color: 'var(--danger)', ...style }}
      >
        {label}加载失败 · {view.error}
        {view.stale && `（以下为上次成功的数据，可能过期）`}
        {!nested && (
          <button
            onClick={view.reload}
            title={`重新拉取${label}`}
            aria-label={`重试加载${label}`}
            style={{ fontSize: 'var(--fs-s)', padding: '2px 10px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, cursor: 'pointer' }}
          >
            重试
          </button>
        )}
      </span>
    );
  }
  if (view.phase === 'loading' && showLoading) {
    return (
      <span role="status" data-t02213="resource-loading" style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', ...style }}>
        {label}加载中…
      </span>
    );
  }
  return null;
}
