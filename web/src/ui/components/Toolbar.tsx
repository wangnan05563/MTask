/**
 * T06326：Design System Toolbar 原语。
 * 页面/面板工具条布局：start / center / end 三槽位，支持换行与粘性。
 */
import type { ReactNode } from 'react';

export type ToolbarVariant = 'default' | 'plain' | 'card';
export type ToolbarDensity = 'sm' | 'md';

export interface ToolbarProps {
  readonly start?: ReactNode;
  readonly center?: ReactNode;
  readonly end?: ReactNode;
  readonly children?: ReactNode;
  readonly ariaLabel?: string;
  readonly variant?: ToolbarVariant;
  readonly density?: ToolbarDensity;
  readonly wrap?: boolean;
  readonly sticky?: boolean;
  readonly className?: string;
}

export function Toolbar({
  start,
  center,
  end,
  children,
  ariaLabel = '工具栏',
  variant = 'default',
  density = 'md',
  wrap = false,
  sticky = false,
  className,
}: ToolbarProps) {
  return (
    <div
      className={['mt-toolbar', className].filter(Boolean).join(' ')}
      role="toolbar"
      aria-label={ariaLabel}
      data-variant={variant}
      data-density={density}
      data-wrap={wrap || undefined}
      data-sticky={sticky || undefined}
    >
      {start !== undefined && <div className="mt-toolbar__slot mt-toolbar__start">{start}</div>}
      {center !== undefined && <div className="mt-toolbar__slot mt-toolbar__center">{center}</div>}
      {end !== undefined && <div className="mt-toolbar__slot mt-toolbar__end">{end}</div>}
      {children !== undefined && <div className="mt-toolbar__slot mt-toolbar__main">{children}</div>}
    </div>
  );
}
