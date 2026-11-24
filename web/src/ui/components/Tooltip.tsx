/**
 * T06326：Design System Tooltip 原语。
 * 悬浮/聚焦延迟展示，Esc 关闭；内容只做说明，不承载交互。
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  readonly content: ReactNode;
  readonly children: ReactNode;
  readonly placement?: TooltipPlacement;
  readonly delay?: number;
  readonly open?: boolean;
  readonly className?: string;
  readonly maxWidth?: number;
}

export function Tooltip({
  content,
  children,
  placement = 'top',
  delay = 300,
  open,
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
      if (event.key === 'Escape') setInnerOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen]);

  useEffect(() => clearTimers, []);

  return (
    <span
      className={['mt-tooltip', className].filter(Boolean).join(' ')}
      data-placement={placement}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={show}
      onBlurCapture={hide}
    >
      <span className="mt-tooltip__trigger" aria-describedby={isOpen ? tooltipId : undefined}>{children}</span>
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
