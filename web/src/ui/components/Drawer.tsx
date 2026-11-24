/**
 * T06326：Design System Drawer 原语。
 * 从左侧或右侧滑出的非全屏抽屉，复用 Dialog 的 Esc / 焦点环 / 焦点回落。
 */
import { createPortal } from 'react-dom';
import { useId } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { IconButton } from './IconButton';
import { useModalLayer } from './modalLayer';

export type DrawerSide = 'left' | 'right';

export interface DrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  readonly footer?: ReactNode;
  readonly side?: DrawerSide;
  readonly width?: number | string;
  readonly closeOnOverlay?: boolean;
  readonly closeOnEsc?: boolean;
  readonly className?: string;
  readonly showClose?: boolean;
  readonly ariaLabel?: string;
}

export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  side = 'right',
  width = 420,
  closeOnOverlay = true,
  closeOnEsc = true,
  className,
  showClose = true,
  ariaLabel,
}: DrawerProps) {
  const autoId = useId();
  const titleId = `mt-drawer-title-${autoId}`;
  const descriptionId = description ? `mt-drawer-desc-${autoId}` : undefined;
  const { panelRef, onKeyDown, onOverlayClick } = useModalLayer({ open, onClose, closeOnEsc });

  if (!open || typeof document === 'undefined') return null;

  const panelStyle: CSSProperties = {
    width: typeof width === 'number' ? `${width}px` : width,
  };

  return createPortal(
    <div
      className="mt-overlay"
      data-kind="drawer"
      onClick={closeOnOverlay ? onOverlayClick : undefined}
    >
      <aside
        ref={panelRef}
        className={['mt-drawer', className].filter(Boolean).join(' ')}
        data-side={side}
        style={panelStyle}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="mt-drawer__head">
          <div className="mt-dialog__heading">
            <h2 className="mt-dialog__title" id={titleId}>{title}</h2>
            {description && <p className="mt-dialog__desc" id={descriptionId}>{description}</p>}
          </div>
          {showClose && (
            <IconButton
              variant="ghost"
              size="sm"
              icon={<span aria-hidden="true">×</span>}
              label="关闭抽屉"
              onClick={onClose}
            />
          )}
        </header>
        <div className="mt-drawer__body">{children}</div>
        {footer !== undefined && <footer className="mt-drawer__foot">{footer}</footer>}
      </aside>
    </div>,
    document.body,
  );
}
