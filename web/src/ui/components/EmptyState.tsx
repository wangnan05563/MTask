/**
 * T06287：EmptyState 原语。
 * 只提供空态骨架与一个可选主行动；不内置任何业务入口或文案。
 */
import type { ReactNode } from 'react';
import { Button, type ButtonVariant } from './Button';

export interface EmptyStateAction {
  readonly label: ReactNode;
  readonly onClick: () => void;
  readonly variant?: ButtonVariant;
  readonly loading?: boolean;
}

export interface EmptyStateProps {
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  readonly hint?: ReactNode;
  readonly action?: EmptyStateAction;
}

export function EmptyState({ icon, title, hint, action }: EmptyStateProps) {
  return (
    <div className="mt-empty">
      {icon && <div className="mt-empty__icon" aria-hidden="true">{icon}</div>}
      <div className="mt-empty__title">{title}</div>
      {hint && <div className="mt-empty__hint">{hint}</div>}
      {action && (
        <Button
          className="mt-empty__action"
          variant={action.variant ?? 'primary'}
          loading={action.loading}
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}
