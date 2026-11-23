/**
 * T06287：Badge 原语。
 * 只做状态/分类标记，不承担计数或业务判定；最多允许一个可选圆点强化状态。
 */
import type { HTMLAttributes, ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
export type BadgeSize = 'sm' | 'md';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly tone?: BadgeTone;
  readonly size?: BadgeSize;
  readonly dot?: boolean;
}

export function Badge({
  tone = 'neutral',
  size = 'sm',
  dot = false,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      {...rest}
      className={['mt-badge', className].filter(Boolean).join(' ')}
      data-tone={tone}
      data-size={size}
    >
      {dot && <span className="mt-badge__dot" aria-hidden="true" />}
      {children && <span className="mt-badge__label">{children as ReactNode}</span>}
    </span>
  );
}
