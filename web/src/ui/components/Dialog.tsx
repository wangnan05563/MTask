/**
 * T06326：Design System Dialog 原语。
 * 模态对话框：遮罩、Esc 关闭、焦点回落、Tab 焦点环、标题/描述/页脚插槽。
 * SSR 环境不输出 portal，避免 document 未定义。
 */
import { createPortal } from 'react-dom';
import { useId } from 'react';
import type { ReactNode } from 'react';
import { IconButton } from './IconButton';
import { useModalLayer } from './modalLayer';

export type DialogSize = 'sm' | 'md' | 'lg';

export interface DialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  readonly footer?: ReactNode;
  readonly size?: DialogSize;
  readonly closeOnOverlay?: boolean;
  readonly closeOnEsc?: boolean;
  readonly className?: string;
  readonly showClose?: boolean;
  readonly ariaLabel?: string;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  closeOnOverlay = true,
  closeOnEsc = true,
  className,
  showClose = true,
  ariaLabel,
}: DialogProps) {
  const autoId = useId();
  const titleId = `mt-dialog-title-${autoId}`;
  const descriptionId = description ? `mt-dialog-desc-${autoId}` : undefined;
  const { panelRef, onKeyDown, onOverlayClick } = useModalLayer({ open, onClose, closeOnEsc });

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="mt-overlay"
      data-kind="dialog"
      onClick={closeOnOverlay ? onOverlayClick : undefined}
    >
      <section
        ref={panelRef}
        className={['mt-dialog', className].filter(Boolean).join(' ')}
        data-size={size}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="mt-dialog__head">
          <div className="mt-dialog__heading">
            <h2 className="mt-dialog__title" id={titleId}>{title}</h2>
            {description && <p className="mt-dialog__desc" id={descriptionId}>{description}</p>}
          </div>
          {showClose && (
            <IconButton
              variant="ghost"
              size="sm"
              icon={<span aria-hidden="true">×</span>}
              label="关闭对话框"
              onClick={onClose}
            />
          )}
        </header>
        {children !== undefined && <div className="mt-dialog__body">{children}</div>}
        {footer !== undefined && <footer className="mt-dialog__foot">{footer}</footer>}
      </section>
    </div>,
    document.body,
  );
}
