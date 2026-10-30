/**
 * 八期 Q14（REQ-071）富悬浮 HoverCard：把「悬停看详情」从原生多行 `title` 升级成可承载结构的浮层。
 *
 * 为什么自己做而不是用 `title`：原生提示不能放按钮/外链、超过两三行就截断、深浅主题下不可控，
 * 而 §3.1.2 的悬浮四要素（作者·时间 / 主题 / 来源 / 完整 SHA）本来就要带「打开任务 Git 页」和「远端外链」。
 *
 * 三条不可让的边界（WCAG 1.4.13「悬停或焦点显示的内容」）：
 *  - **可关闭**：Esc 立即收起（Esc 的 keydown 会从卡片冒泡回触发元素，见下方注释），收起后焦点回到触发控件，
 *    且这一下「还给焦点」不能把卡片再打开（真机实测过：不加抑制，焦点原本在卡片里时按 Esc 等于没关）；
 *  - **可悬停**：指针从触发元素移到卡片上不消失（靠移出触发元素后的 close 延时缓冲，卡片自己会取消这个定时器）；
 *  - **不闪现**：没有任何「定时自动隐藏」，只在指针真正离开两者、失焦、Esc 或滚动时收起。
 *
 * 两个必须记住的宿主约束（都是这个仓踩过的坑，别改回去）：
 *  1. **卡片走 Portal 挂 `document.body`**：任务行带 `.cv-auto`（`content-visibility: auto`，settings.tsx:194），
 *     它会让该行成为 fixed 后代的包含块并按行裁剪（等价 `contain: paint`）。T01299 就是被这个坑过一次：
 *     验证面板不挂 Portal 时「整体被裁掉不可见，展开详情后才露出」。
 *     代价是卡片在 Tab 序里排到 body 末尾——所以卡片的动作**不承诺键盘可达**，键盘等价走
 *     触发元素自身（有外链时它就是那个 `<a>`）与「行 Enter 进抽屉 Git 页」，卡片内容同时以 `aria-describedby`
 *     挂给读屏；这一段是取舍，不是遗漏。
 *  2. **滚动即收**：定位是打开瞬间按触发元素矩形算的一次性视口坐标，列表滚动后卡片会脱离触发元素；
 *     窗口化列表还会回收行（`taskListWindow.ts`），回收即卸载。故开启期挂 `scroll`（capture，容器内滚动也收）
 *     与 `resize`，收到就关。唯一豁免是开启后 `HOVER_SCROLL_SETTLE_MS` 内的滚动 —— 那通常是 `focus()`
 *     自己引起的 scroll-into-view，此时按当前矩形重定位而不是关闭，详见该常量注释。
 *
 * 定位是纯函数 `hoverCardPos`（门可直接调用，不依赖 DOM）：卡片尺寸用调用方给的估算值，
 * 是为了在「尚未渲染」时就能算出位置，避免先渲染到 (0,0) 再跳一次。
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** 悬停开启延时：§3.1.4 定的就是「悬浮 300ms 出摘要浮层」，同时也是「路过即弹」的下限 */
export const HOVER_OPEN_DELAY = 300;
/**
 * 移出后关闭延时：指针要从触发元素平滑移进卡片（可悬停），也要给「扫过一排徽标」留缓冲。
 * 必须 ≥ 触发元素与卡片之间缝隙的通过时间，故取 140ms（实测指针穿过 6px 缝隙约 30~60ms）。
 */
export const HOVER_CLOSE_DELAY = 140;
/** 触发元素与卡片之间的缝隙（px），同时也是卡片离视口边缘的最小距离 */
export const HOVER_GAP = 6;
/** 卡片层级：高于行内浮层（`GitLinksPopover` 1200），低于模态抽屉 */
export const HOVER_Z = 1240;
/**
 * 「滚动即收」的豁免窗口：开启后这段时间内的滚动不当作用户滚动。
 * 真机实测（file:// 探针 + CDP 真实指针/焦点事件）：`focus()` 会让 Chrome 把不可见的触发元素滚进视口，
 * 这一下滚动发生在卡片 effect 挂上监听之后，于是「键盘聚焦打开浮层」被自己的滚动判据当场关掉——
 * 键盘等价路径（AC-4/G9）直接失效。窗口取 120ms：这一下滚动在开启后几十毫秒内到达，而用户真滚动的
 * 相邻两帧通常间隔 ≥16ms 且持续更久，120ms 内的滚动按「重定位」处理代价最小（卡片跟着走，不会脱位），
 * 超过窗口才认定是用户滚动，收起。
 */
export const HOVER_SCROLL_SETTLE_MS = 120;

/** 单调时钟：`performance.now()` 在浏览器与 Node（门里 SSR）都可用，取不到才退回 `Date.now()` */
const now = (): number => globalThis.performance?.now?.() ?? Date.now();

export interface AnchorBox {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
}
export interface HoverPlacement {
  readonly top: number;
  readonly left: number;
  readonly placement: 'bottom' | 'top';
}

/**
 * 纯定位：优先贴在触发元素下方，放不下就翻到上方；上下都放不下时留在视口内；左右按卡片宽度钳进视口。
 */
export function hoverCardPos(
  anchor: AnchorBox,
  card: { readonly w: number; readonly h: number },
  vp: { readonly w: number; readonly h: number },
  gap = HOVER_GAP,
): HoverPlacement {
  const belowTop = anchor.bottom + gap;
  const fitsBelow = belowTop + card.h <= vp.h;
  const aboveTop = anchor.top - gap - card.h;
  const raw = fitsBelow ? belowTop : aboveTop;
  const maxTop = Math.max(gap, vp.h - gap - card.h);
  const top = Math.max(gap, Math.min(raw, maxTop));
  const left = Math.min(Math.max(gap, anchor.left), Math.max(gap, vp.w - gap - card.w));
  return { top, left, placement: fitsBelow ? 'bottom' : 'top' };
}

export interface HoverCardProps {
  readonly children: ReactNode;
  /** 卡片内容；传 null 等于禁用浮层（徽标降级/无摘要时没有可展示的细节） */
  readonly card: ReactNode | null;
  /** 卡片估算宽度（左右钳制用）与高度（上下翻转判定用） */
  readonly cardW?: number;
  readonly cardH?: number;
  readonly openDelay?: number;
  readonly closeDelay?: number;
  /** 读屏用：卡片 `role="dialog"` 的名称，同时也是「这是什么」的兜底说明 */
  readonly ariaLabel: string;
  readonly testId?: string;
}

export function HoverCard({
  children, card, cardW = 340, cardH = 132,
  openDelay = HOVER_OPEN_DELAY, closeDelay = HOVER_CLOSE_DELAY, ariaLabel, testId,
}: HoverCardProps) {
  const [pos, setPos] = useState<HoverPlacement | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLSpanElement>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const descId = useId();
  const isOpen = pos !== null;

  const clearTimers = useCallback(() => {
    if (openTimer.current != null) window.clearTimeout(openTimer.current);
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  /** 上一次「从关闭态变开启态」的时刻（ms）；`close()` 后重新计时 */
  const openedAtRef = useRef(0);
  const wasOpenRef = useRef(false);
  /**
   * Esc 收起时要把焦点还给触发控件，而那一下 `focus()` 会同步触发 `onFocus` → 又立刻把卡片打开，
   * 结果是「按 Esc 关不掉」（焦点已在触发控件上时不重发 focus 事件，所以这条只在焦点原本在卡片里时暴露——
   * 真机探针实测：Esc 后 `aria-expanded` 回到 true）。这里给这一跳 focus 一个「不要因此重开」的口令。
   */
  const suppressFocusOpenRef = useRef(false);

  const close = useCallback(() => {
    wasOpenRef.current = false;
    clearTimers();
    setPos(null);
  }, [clearTimers]);

  /** 焦点是否落在「触发元素子树 或 卡片」内——卡片经 Portal 挂在 body，DOM 上不是触发元素的子孙，两个都要查 */
  const isInside = useCallback((target: EventTarget | null): boolean => {
    if (!(target instanceof Node)) return false;
    return (triggerRef.current?.contains(target) ?? false) || (cardRef.current?.contains(target) ?? false);
  }, []);

  const open = useCallback(() => {
    const el = triggerRef.current;
    if (!el || card == null) return;
    if (!wasOpenRef.current) {
      wasOpenRef.current = true;
      openedAtRef.current = now();
    }
    const r = el.getBoundingClientRect();
    setPos(hoverCardPos(
      { top: r.top, left: r.left, bottom: r.bottom },
      { w: cardW, h: cardH },
      { w: globalThis.innerWidth || 1280, h: globalThis.innerHeight || 800 },
    ));
  }, [card, cardW, cardH]);

  /*
   * 约束 2：滚动/改窗即收（capture 才能收到列表容器的滚动）。
   * 但开启后 `HOVER_SCROLL_SETTLE_MS` 内的滚动**不关，只重新按触发元素矩形定位**——
   * 键盘 `focus()` 会触发 Chrome 把不可见的触发元素滚进视口，那一滚发生在监听挂上之后，
   * 若按用户滚动处理，「键盘聚焦打开浮层」会被自己的判据当场关掉（真机实测复现，见 result 文档）。
   */
  useEffect(() => {
    if (!isOpen) return;
    const onScroll = () => {
      if (now() - openedAtRef.current < HOVER_SCROLL_SETTLE_MS) open();
      else close();
    };
    const dismiss = () => close();
    globalThis.addEventListener('scroll', onScroll, true);
    globalThis.addEventListener('resize', dismiss);
    return () => {
      globalThis.removeEventListener('scroll', onScroll, true);
      globalThis.removeEventListener('resize', dismiss);
    };
  }, [isOpen, close, open]);

  // 内容变空（降级）或卸载时，收起并清掉挂起的定时器，否则留下对已卸载状态的写入
  useEffect(() => {
    if (card == null && pos != null) setPos(null);
  }, [card, pos]);
  useEffect(() => clearTimers, [clearTimers]);

  /** Esc：收起，并把焦点还给触发控件（只有焦点原本就在这两处内才搬，纯鼠标悬停不凭空造焦点） */
  const dismissWithFocusRestore = useCallback(() => {
    const restore = isInside(globalThis.document?.activeElement ?? null);
    close();
    if (restore) {
      const inner = triggerRef.current?.querySelector('a, button') as HTMLElement | null;
      suppressFocusOpenRef.current = true;
      try {
        (inner ?? triggerRef.current)?.focus?.();
      } finally {
        // `focus()` 派发 focusin 是同步的，React 的 onFocus 已在这一步里读过口令；
        // 元素本来就有焦点时不会重发事件，口令留到 finally 一律作废，不会吞掉用户下一次真聚焦
        suppressFocusOpenRef.current = false;
      }
    }
  }, [close, isInside]);

  return (
    <span
      ref={triggerRef}
      data-t03394="hover-trigger"
      style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0 }}
      aria-haspopup={card == null ? undefined : 'dialog'}
      aria-expanded={isOpen}
      aria-describedby={isOpen ? descId : undefined}
      onMouseEnter={() => {
        if (card == null) return;
        if (closeTimer.current != null) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
        if (openTimer.current == null) openTimer.current = window.setTimeout(open, openDelay);
      }}
      onMouseLeave={() => {
        if (openTimer.current != null) { window.clearTimeout(openTimer.current); openTimer.current = null; }
        // 还没弹出的时候不需要缓冲：开定时器会盖掉下一次悬停的判定
        if (pos != null) closeTimer.current = window.setTimeout(close, closeDelay);
      }}
      onFocus={() => {
        if (suppressFocusOpenRef.current) return;
        if (card != null) open();
      }}
      onBlur={(e) => { if (!isInside(e.relatedTarget)) close(); }}
      // 卡片是 Portal，但 React 事件沿组件树冒泡，所以 Esc 落在卡片里也会走到这里
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); dismissWithFocusRestore(); } }}
    >
      {children}
      {pos && createPortal(
        <span
          ref={cardRef}
          id={descId}
          role="dialog"
          aria-label={ariaLabel}
          data-t03394={testId ?? 'hover-card'}
          onMouseEnter={() => { if (closeTimer.current != null) { window.clearTimeout(closeTimer.current); closeTimer.current = null; } }}
          onMouseLeave={() => { closeTimer.current = window.setTimeout(close, closeDelay); }}
          onBlur={(e) => { if (!isInside(e.relatedTarget)) close(); }}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed', top: pos.top, left: pos.left, zIndex: HOVER_Z,
            width: cardW, boxSizing: 'border-box',
            background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 6,
            padding: '8px 10px', boxShadow: '0 8px 24px var(--overlay)',
            fontSize: 'var(--fs-xs)', color: 'var(--text)', textAlign: 'left',
          }}
        >
          {card}
        </span>,
        globalThis.document.body,
      )}
    </span>
  );
}
