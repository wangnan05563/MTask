/**
 * T06326：Dialog / Drawer 共用的模态层行为。
 * 负责焦点回落、Esc 关闭、Tab 焦点环与遮罩点击，不承载展示样式。
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

export interface ModalLayerOptions {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly closeOnEsc?: boolean;
}

export function useModalLayer({ open, onClose, closeOnEsc = true }: ModalLayerOptions) {
  const panelRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const timer = window.setTimeout(() => {
      const first = panel?.querySelector<HTMLElement>('[data-autofocus], ' + FOCUSABLE);
      (first ?? panel)?.focus();
    }, 0);

    const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && closeOnEsc) {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onDocumentKeyDown, true);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onDocumentKeyDown, true);
      previous?.focus?.();
    };
  }, [open, closeOnEsc]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab' || !panelRef.current) return;
    const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((node) => !node.hasAttribute('disabled') && node.getAttribute('aria-hidden') !== 'true');
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
