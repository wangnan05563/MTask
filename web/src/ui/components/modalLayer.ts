/**
 * T06326：Dialog / Drawer / Popover 共用的浮层行为。
 * 负责焦点回落、Esc 关闭、Tab 焦点环与遮罩点击，不承载展示样式。
 *
 * T06326 后续修正：Dialog/Drawer/Popover 按统一 Esc 栈管理，Esc 只关最上层；
 * body 滚动锁与背景 inert 使用引用计数，支持嵌套 Dialog/Drawer；
 * 焦点逃逸时由 document 级 Tab 处理拉回面板。
 */
import { useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const modalStack: symbol[] = [];
type EscapeLayer = { readonly id: symbol; readonly handle: () => void };
const escapeStack: EscapeLayer[] = [];
let escapeListenerBound = false;
let previousBodyOverflow = '';
let backgroundState: {
  readonly root: HTMLElement;
  readonly hadInert: boolean;
  readonly ariaHidden: string | null;
} | null = null;

function onDocumentEscape(event: globalThis.KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  const top = escapeStack[escapeStack.length - 1];
  if (!top) return;
  event.preventDefault();
  // 栈顶已消费 Esc：阻断继续冒泡到 More/Drawer 等页面级 keydown，
  // 否则同一次 Esc 会连带关闭背景面板或第二个确认框。
  // stopImmediatePropagation 还负责挡住同一 document 上的其他 bubble 监听。
  event.stopPropagation();
  event.stopImmediatePropagation();
  top.handle();
}

function ensureEscapeListener(): void {
  if (escapeListenerBound || typeof document === 'undefined') return;
  document.addEventListener('keydown', onDocumentEscape, true);
  escapeListenerBound = true;
}

// 模块加载即绑定，确保早于页面级 Escape 监听（如 ProjectSwitcher 的 document capture）
// 注册；有浮层时 stopImmediatePropagation 才能真正阻断它们，而不是被它们抢先响应。
if (typeof document !== 'undefined') ensureEscapeListener();

function pushEscapeLayer(id: symbol, handle: () => void): void {
  ensureEscapeListener();
  escapeStack.push({ id, handle });
}

function removeEscapeLayer(id: symbol): void {
  const index = escapeStack.findIndex((layer) => layer.id === id);
  if (index >= 0) escapeStack.splice(index, 1);
}

/**
 * 统一 Esc 栈：Dialog/Drawer 与 Popover 都登记到同一栈，Esc 只触发最上层。
 * 这样 Popover 打开时按 Esc 不会连带关闭背后的 Dialog；关掉 Popover 后下一次 Esc 才关模态。
 */
export function useEscapeLayer(open: boolean, enabled: boolean, onEscape: () => void) {
  const idRef = useRef(Symbol('mt-escape'));
  const onEscapeRef = useRef(onEscape);
  const enabledRef = useRef(enabled);

  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const id = idRef.current;
    pushEscapeLayer(id, () => {
      // 栈顶层即使设置 closeOnEsc=false 也要吞掉 Esc，避免关到背后的 Dialog。
      if (enabledRef.current) onEscapeRef.current();
    });
    return () => removeEscapeLayer(id);
  }, [open]);
}


function isVisibleFocusable(node: HTMLElement): boolean {
  if (node.matches(':disabled')) return false;
  if (node.closest('[inert]')) return false;
  if (node.closest('[aria-hidden="true"]')) return false;
  const style = window.getComputedStyle(node);
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  // display:none 的祖先不会把 display 继承给子节点，必须用盒模型存在性兜底；
  // 这同时排除 display:contents 等无可聚焦盒子的边界元素。
  return node.getClientRects().length > 0;
}

function focusableIn(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isVisibleFocusable);
}

function lockBackground(panel: HTMLElement | null): void {
  if (modalStack.length !== 1) return;
  const body = document.body;
  previousBodyOverflow = body.style.overflow;
  body.style.overflow = 'hidden';
  const root = document.getElementById('root');
  if (!root || root === panel || (panel && root.contains(panel))) return;
  backgroundState = {
    root,
    hadInert: root.hasAttribute('inert'),
    ariaHidden: root.getAttribute('aria-hidden'),
  };
  root.setAttribute('inert', '');
  root.setAttribute('aria-hidden', 'true');
}

function unlockBackground(): void {
  if (modalStack.length > 0) return;
  document.body.style.overflow = previousBodyOverflow;
  if (backgroundState) {
    const { root, hadInert, ariaHidden } = backgroundState;
    if (!hadInert) root.removeAttribute('inert');
    if (ariaHidden === null) root.removeAttribute('aria-hidden');
    else root.setAttribute('aria-hidden', ariaHidden);
    backgroundState = null;
  }
}

function trapTab(event: globalThis.KeyboardEvent, panel: HTMLElement): void {
  const nodes = focusableIn(panel);
  const active = document.activeElement as HTMLElement | null;
  if (nodes.length === 0) {
    event.preventDefault();
    panel.focus();
    return;
  }
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (!active || !panel.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

export interface ModalLayerOptions {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly closeOnEsc?: boolean;
}

export function useModalLayer({ open, onClose, closeOnEsc = true }: ModalLayerOptions) {
  const panelRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const modalIdRef = useRef(Symbol('mt-modal'));

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEscapeLayer(open, closeOnEsc, () => onCloseRef.current());

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const id = modalIdRef.current;
    const panel = panelRef.current;
    const previous = document.activeElement as HTMLElement | null;
    modalStack.push(id);
    lockBackground(panel);
    const timer = window.setTimeout(() => {
      const first = panel?.querySelector<HTMLElement>(`[data-autofocus], ${FOCUSABLE}`);
      (first ?? panel)?.focus();
    }, 0);

    const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      // 只有栈顶 Dialog/Drawer 响应 Tab；下层实例不因一次 Tab 抢焦点。
      if (modalStack[modalStack.length - 1] !== id) return;
      if (event.key === 'Tab' && panel) trapTab(event, panel);
    };
    document.addEventListener('keydown', onDocumentKeyDown, true);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onDocumentKeyDown, true);
      const index = modalStack.lastIndexOf(id);
      if (index >= 0) modalStack.splice(index, 1);
      unlockBackground();
      previous?.focus?.();
    };
  }, [open]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab' || !panelRef.current) return;
    const nodes = focusableIn(panelRef.current);
    if (nodes.length === 0) {
      event.preventDefault();
      panelRef.current.focus();
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onOverlayClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  return { panelRef, onKeyDown, onOverlayClick };
}
