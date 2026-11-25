/**
 * T06326：Design System Toast 原语。
 * Toast / ToastProvider / useToast：队列上限、自动消失、手动关闭，错误用 role=alert。
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface ToastAction {
  readonly label: ReactNode;
  readonly onClick: () => void;
}

export interface ToastOptions {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly tone?: ToastTone;
  readonly duration?: number;
  readonly action?: ToastAction;
}

export interface ToastItemData extends ToastOptions {
  readonly id: string;
}

export interface ToastProps extends ToastOptions {
  readonly onClose?: () => void;
  readonly className?: string;
}

export function Toast({
  title,
  description,
  tone = 'info',
  action,
  onClose,
  className,
}: ToastProps) {
  return (
    <div
      className={['mt-toast', className].filter(Boolean).join(' ')}
      data-tone={tone}
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      <span className="mt-toast__dot" aria-hidden="true" />
      <div className="mt-toast__content">
        <div className="mt-toast__title">{title}</div>
        {description && <div className="mt-toast__desc">{description}</div>}
        {action && (
          <button type="button" className="mt-toast__action" onClick={action.onClick}>
            {action.label}
          </button>
        )}
      </div>
      {onClose && (
        <button type="button" className="mt-toast__close" aria-label="关闭通知" onClick={onClose}>
          ×
        </button>
      )}
    </div>
  );
}

interface ToastContextValue {
  readonly toast: (options: ToastOptions) => string;
  readonly dismiss: (id: string) => void;
  readonly clear: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export interface ToastProviderProps {
  readonly children: ReactNode;
  readonly duration?: number;
  readonly max?: number;
}

export function ToastProvider({ children, duration = 4500, max = 4 }: ToastProviderProps) {
  const [items, setItems] = useState<ToastItemData[]>([]);
  const timers = useRef(new Map<string, number>());
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(id);
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback((options: ToastOptions) => {
    counter.current += 1;
    const id = `mt-toast-${counter.current}`;
    const limit = Math.max(1, Math.floor(max));
    setItems((current) => {
      const kept = limit <= 1 ? [] : current.slice(-(limit - 1));
      // 被队列上限淘汰的 toast 不会再显示，对应 timer 必须同步清理，避免到期空跑与泄漏。
      const keptIds = new Set(kept.map((item) => item.id));
      for (const [timerId, timer] of timers.current) {
        if (!keptIds.has(timerId)) {
          window.clearTimeout(timer);
          timers.current.delete(timerId);
        }
      }
      return [...kept, { ...options, id }];
    });
    const ttl = options.duration ?? duration;
    if (ttl > 0 && typeof window !== 'undefined') {
      const timer = window.setTimeout(() => dismiss(id), ttl);
      timers.current.set(id, timer);
    }
    return id;
  }, [duration, max, dismiss]);

  const clear = useCallback(() => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current.clear();
    setItems([]);
  }, []);

  useEffect(() => () => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current.clear();
  }, []);

  const viewport = typeof document !== 'undefined'
    ? createPortal(
      <div className="mt-toast-viewport" aria-live="polite" aria-atomic="false">
        {items.map((item) => (
          <Toast key={item.id} {...item} onClose={() => dismiss(item.id)} />
        ))}
      </div>,
      document.body,
    )
    : null;

  return (
    <ToastContext.Provider value={{ toast, dismiss, clear }}>
      {children}
      {viewport}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast 必须在 ToastProvider 内使用');
  return context;
}
