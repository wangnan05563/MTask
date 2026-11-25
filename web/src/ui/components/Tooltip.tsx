/**
 * T06326：Design System Tooltip 原语。
 * 悬浮/聚焦延迟展示，Esc 关闭；内容只做说明，不承载交互。
 */
import { cloneElement, isValidElement, useEffect, useId, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  readonly content: ReactNode;
  readonly children: ReactNode;
  readonly placement?: TooltipPlacement;
  readonly delay?: number;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly className?: string;
  readonly maxWidth?: number;
}

export function Tooltip({
  content,
  children,
  placement = 'top',
  delay = 300,
  open,
  onOpenChange,
  className,
  maxWidth = 280,
}: TooltipProps) {
  const autoId = useId();
  const tooltipId = `mt-tooltip-${autoId}`;
  const showTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const [innerOpen, setInnerOpen] = useState(false);
  const isOpen = open ?? innerOpen;

  const clearTimers = () => {
    if (showTimer.current !== null) window.clearTimeout(showTimer.current);
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    showTimer.current = null;
    hideTimer.current = null;
  };

  const show = () => {
    clearTimers();
    showTimer.current = window.setTimeout(() => setInnerOpen(true), delay);
  };
  const hide = () => {
    clearTimers();
    hideTimer.current = window.setTimeout(() => setInnerOpen(false), 80);
  };

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // controlled 模式不能只改内部 state，否则 isOpen = open ?? innerOpen 仍为 true。
      if (open === undefined) setInnerOpen(false);
      onOpenChange?.(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, open, onOpenChange]);

  useEffect(() => clearTimers, []);

  // aria-describedby 必须落到真正可聚焦的子元素上；wrapper span 通常不可聚焦，挂在这里读屏无效。
  const describedBy = isOpen ? tooltipId : undefined;
  let triggerNode = children;
  if (isValidElement(children)) {
    const child = children as ReactElement<{ 'aria-describedby'?: string }>;
    const existing = child.props['aria-describedby'];
    triggerNode = cloneElement(child, {
      'aria-describedby': [existing, describedBy].filter(Boolean).join(' ') || undefined,
    });
  }

  return (
    <span
      className={['mt-tooltip', className].filter(Boolean).join(' ')}
      data-placement={placement}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={show}
      onBlurCapture={hide}
    >
      <span className="mt-tooltip__trigger">{triggerNode}</span>
      {isOpen && (
        <span
          className="mt-tooltip__bubble"
          id={tooltipId}
          role="tooltip"
          style={{ maxWidth }}
        >
          {content}
        </span>
      )}
    </span>
  );
}
