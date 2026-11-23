/**
 * T06287：Skeleton 原语。
 * 只负责占位动画与尺寸；不决定何时加载，也不内嵌业务文案。
 */
import type { CSSProperties } from 'react';

export interface SkeletonProps {
  readonly width?: CSSProperties['width'];
  readonly height?: CSSProperties['height'];
  readonly rounded?: boolean;
  readonly className?: string;
}

export function Skeleton({ width = '100%', height = 8, rounded = false, className }: SkeletonProps) {
  return (
    <span
      className={['mt-skeleton', className].filter(Boolean).join(' ')}
      style={{ width, height }}
      data-rounded={rounded || undefined}
      aria-hidden="true"
    />
  );
}
