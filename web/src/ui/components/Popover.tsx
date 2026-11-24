/**
 * T06326：Design System Popover 原语。
 * 点击触发、点击外部/Esc 关闭，锚定在触发器上下左右四个方位。
 */
import { forwardRef, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';

export interface PopoverProps {
  readonly trigger: ReactNode;
  readonly triggerLabel: string;
  readonly children: ReactNode;
  readonly placement?: PopoverPlacement;
  readonly open?: boolean;
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly closeOnEsc?: boolean;
  readonly label?: string;
  readonly className?: string;
  readonly panelClassName?: string;
}

export const Popover = forwardRef<HTMLButtonElement, PopoverProps>(function Popover(
  {
    trigger,
    triggerLabel,
    children,
    placement = 'bottom-start',
    open,
    defaultOpen = false,
    onOpenChange,
    closeOnEsc = true,
    label,
    className,
    panelClassName,
  },
  ref,
) {
  const autoId = useId();
  const panelId = `mt-popover-${autoId}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const isOpen = open ?? innerOpen;

  const setOpen = (next: boolean) => {
    if (open === undefined) setInnerOpen(next);
    onOpenChange?.(next);
    if (next) {
      window.setTimeout(() => {
        const first = panelRef.current?.querySelector<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        first?.focus();
      }, 0);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && closeOnEsc) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [isOpen, closeOnEsc]);

  return (
    <div ref={rootRef} className={['mt-popover', className].filter(Boolean).join(' ')} data-placement={placement}>
      <button
        ref={ref}
        type="button"
        className="mt-popover__trigger"
        aria-label={triggerLabel}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? panelId : undefined}
        onClick={() => setOpen(!isOpen)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (!isOpen) setOpen(true);
          }
        }}
      >
        {trigger}
      </button>
      {isOpen && (
        <div
          ref={panelRef}
          id={panelId}
          className={['mt-popover__panel', panelClassName].filter(Boolean).join(' ')}
          role="dialog"
          aria-label={label ?? triggerLabel}
        >
          {children}
        </div>
      )}
    </div>
  );
});

Popover.displayName = 'Popover';
