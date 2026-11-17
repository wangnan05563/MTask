/**
 * T04913：Git 记录标题「单行省略 + 悬浮全量显示」的纯函数层。
 *
 * 原生 title 兜底有 ~1s 延迟、样式由浏览器决定、长文本在窄屏会被裁；这里把「是否截断」与
 * 「浮层放哪」抽成可单测的纯函数，组件只负责把结果渲染成 portal 浮层。
 * 不依赖 DOM，node 门可直接断言窄屏/靠右/靠底等边界。
 */

/** 浮层最大宽度（宽屏）；窄屏按视口减去安全边距自动收缩，不强设下限以免溢出屏幕 */
export const SUBJECT_TOOLTIP_MAX_WIDTH = 560;
/** 与标题行的间距、屏幕安全边距、估算高度（用于判断下方放不放得下） */
export const SUBJECT_TOOLTIP_GAP = 6;
export const SUBJECT_TOOLTIP_EDGE = 12;
export const SUBJECT_TOOLTIP_EST_HEIGHT = 120;

export interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly bottom: number;
  readonly right: number;
}
export interface ViewportLike {
  readonly width: number;
  readonly height: number;
}
export interface TooltipBox {
  readonly left: number;
  readonly top: number;
  readonly maxWidth: number;
}

/**
 * 只在真正被 CSS 截断时才弹浮层。
 * +1 容差：亚像素渲染常出现 1px 误差，否则短标题会莫名其妙弹一个「全文」浮层。
 */
export function shouldShowSubjectTooltip(scrollWidth: number, clientWidth: number): boolean {
  return scrollWidth > clientWidth + 1;
}

/**
 * 固定定位的浮层坐标：
 * - 宽度随视口收缩，保证左右各留 EDGE 安全边距（不同分辨率不会溢出屏幕）；
 * - 靠右时向左钳制，靠底时翻到标题上方，上下都放不下则钳到顶部安全边距；
 * - 用 position:fixed + body portal，绕开列表容器的 overflow:auto 裁剪。
 */
export function subjectTooltipBox(rect: RectLike, viewport: ViewportLike): TooltipBox {
  const usable = Math.max(1, viewport.width - SUBJECT_TOOLTIP_EDGE * 2);
  const maxWidth = Math.min(SUBJECT_TOOLTIP_MAX_WIDTH, usable);
  const rightEdge = Math.max(SUBJECT_TOOLTIP_EDGE, viewport.width - maxWidth - SUBJECT_TOOLTIP_EDGE);
  const left = Math.min(Math.max(SUBJECT_TOOLTIP_EDGE, rect.left), rightEdge);
  const below = rect.bottom + SUBJECT_TOOLTIP_GAP;
  const top = below + SUBJECT_TOOLTIP_EST_HEIGHT <= viewport.height
    ? below
    : Math.max(SUBJECT_TOOLTIP_EDGE, rect.top - SUBJECT_TOOLTIP_GAP - SUBJECT_TOOLTIP_EST_HEIGHT);
  return { left, top, maxWidth };
}
