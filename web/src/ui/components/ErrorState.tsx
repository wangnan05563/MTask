/**
 * T06326：Design System ErrorState 原语。
 * 错误空态：标题、说明、可选详情与重试；role=alert 便于读屏立即播报。
 */
import type { ReactNode } from 'react';
import { Button } from './Button';

export interface ErrorRetry {
  readonly label?: ReactNode;
  readonly onClick: () => void;
  readonly loading?: boolean;
}

export interface ErrorStateProps {
  readonly title?: ReactNode;
  readonly message?: ReactNode;
  readonly details?: ReactNode;
  readonly icon?: ReactNode;
  readonly retry?: ErrorRetry;
  readonly compact?: boolean;
  readonly className?: string;
}

export function ErrorState({
  title = '加载失败',
  message,
  details,
  icon,
  retry,
  compact = false,
  className,
}: ErrorStateProps) {
  return (
    <div
      className={['mt-error-state', className].filter(Boolean).join(' ')}
      data-compact={compact || undefined}
      role="alert"
    >
      <span className="mt-error-state__icon" aria-hidden="true">{icon ?? '!'}</span>
      <div className="mt-error-state__title">{title}</div>
      {message && <div className="mt-error-state__message">{message}</div>}
      {details && <div className="mt-error-state__details">{details}</div>}
      {retry && (
        <div className="mt-error-state__action">
          <Button variant="secondary" loading={retry.loading} onClick={retry.onClick}>
            {retry.label ?? '重试'}
          </Button>
        </div>
      )}
    </div>
  );
}
