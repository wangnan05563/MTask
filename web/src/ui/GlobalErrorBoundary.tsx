import React, { Component, useEffect, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode, Ref } from 'react';

/**
 * T06309：全局异常兜底。
 *
 * 边界：本期只处理前端运行时异常（组件渲染、事件回调、未处理的 Promise）；
 * 网络请求失败（Failed to fetch / NetworkError / AbortError 等）按任务要求不接管，
 * 仍由各业务调用点显示原有错误提示，避免把“网络不可用”误报成“页面崩溃”。
 */

const NETWORK_ERROR_RE = /(failed to fetch|networkerror|network error|load failed|network request failed|err_network|econnrefused|econnreset|enotfound|etimedout|fetch failed|socket hang up)/i;

/** 把任意抛出值收敛成单行、可读、限长的文案，避免长堆栈把提示条撑爆。 */
export function toErrorMessage(value: unknown, maxLength = 240): string {
  let text = '';
  if (value instanceof Error) {
    text = value.message || value.name;
  } else if (typeof value === 'string') {
    text = value;
  } else if (value === null || value === undefined) {
    text = '未知异常';
  } else if (typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string') {
    text = String((value as { message: string }).message);
  } else {
    try {
      text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    } catch {
      text = String(value);
    }
  }
  text = text.replace(/\s+/g, ' ').trim() || '未知异常';
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/** 网络异常不进入全局兜底，避免重复提示与误报。 */
export function isNetworkError(value: unknown): boolean {
  const name = value instanceof Error
    ? value.name
    : (typeof value === 'object' && value !== null && 'name' in value ? String((value as { name?: unknown }).name ?? '') : '');
  if (name === 'AbortError') return true;
  const text = value instanceof Error ? `${name} ${value.message}` : toErrorMessage(value, 400);
  return NETWORK_ERROR_RE.test(text);
}

export function isReportableGlobalError(value: unknown): boolean {
  return !isNetworkError(value);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(toErrorMessage(value));
}

interface ErrorBoundaryProps {
  readonly children: ReactNode;
  readonly onError?: (error: Error, info: ErrorInfo) => void;
  readonly onReload?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** 可复用的错误兜底面板；单独导出便于静态渲染与无障碍检查。 */
export function ErrorFallback({
  error,
  onRetry,
  onReload,
}: {
  readonly error: Error;
  readonly onRetry: () => void;
  readonly onReload: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  return (
    <div
      ref={rootRef}
      className="mt-error-boundary"
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      aria-labelledby="mt-error-boundary-title"
      aria-describedby="mt-error-boundary-desc"
      tabIndex={-1}
      data-t06309="error-boundary"
    >
      <section className="mt-error-boundary-card">
        <p className="mt-error-boundary-kicker">MTask 异常保护</p>
        <h1 id="mt-error-boundary-title" className="mt-error-boundary-title">页面遇到异常</h1>
        <p id="mt-error-boundary-desc" className="mt-error-boundary-desc">
          当前页面渲染失败，错误已被拦截，不会影响已保存的任务数据。可以先重试当前页面；若仍无法恢复，请重新加载应用。
        </p>
        <code className="mt-error-boundary-message">{toErrorMessage(error, 320)}</code>
        <details className="mt-error-boundary-detail">
          <summary>查看错误详情</summary>
          <pre>{String(error.stack || error.message || '未知异常').slice(0, 4000)}</pre>
        </details>
        <div className="mt-error-boundary-actions">
          <button type="button" className="mt-error-action is-primary" onClick={onRetry}>重试当前页面</button>
          <button type="button" className="mt-error-action is-secondary" onClick={onReload}>重新加载应用</button>
        </div>
        <p className="mt-error-boundary-hint">错误信息已写入开发者控制台，可复制给维护人员排查。</p>
      </section>
    </div>
  );
}

/** React 渲染/生命周期异常的兜底边界。 */
export class GlobalErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: toError(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[MTask global error] 渲染异常已被兜底', error, info.componentStack);
    this.props.onError?.(error, info);
  }

  private readonly retry = (): void => {
    this.setState({ error: null });
  };

  private readonly reload = (): void => {
    if (this.props.onReload) this.props.onReload();
    else globalThis.location?.reload();
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <ErrorFallback
          error={this.state.error}
          onRetry={this.retry}
          onReload={this.reload}
        />
      );
    }
    return this.props.children;
  }
}

interface GlobalErrorNotice {
  readonly message: string;
  readonly source: 'error' | 'promise';
}

/** 全局异步异常提示条；与页面内 NoticeToast 分离，避免各页面重复接线。 */
export function GlobalErrorToast({
  message,
  onClose,
  onReload,
  rootRef,
}: {
  readonly message: string;
  readonly onClose: () => void;
  readonly onReload: () => void;
  readonly rootRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={rootRef}
      className="mt-global-error-toast"
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      aria-labelledby="mt-global-error-toast-title"
      aria-describedby="mt-global-error-toast-desc"
      tabIndex={-1}
      data-t06309="global-error-toast"
    >
      <div className="mt-global-error-toast-main">
        <span className="mt-global-error-toast-mark" aria-hidden="true">!</span>
        <div className="mt-global-error-toast-copy">
          <strong id="mt-global-error-toast-title">页面发生异常</strong>
          <p id="mt-global-error-toast-desc">{message}</p>
        </div>
      </div>
      <div className="mt-global-error-toast-actions">
        <button type="button" className="mt-error-action is-primary is-compact" onClick={onReload}>重新加载</button>
        <button type="button" className="mt-error-action is-secondary is-compact" onClick={onClose}>关闭</button>
      </div>
    </div>
  );
}

/**
 * 监听 window 的 error / unhandledrejection。React 边界之外的异步异常
 * 不会进入 componentDidCatch，这里负责把用户可见提示补齐。
 */
export function GlobalErrorWatcher({ children }: { readonly children: ReactNode }) {
  const [notice, setNotice] = useState<GlobalErrorNotice | null>(null);
  const toastRef = useRef<HTMLDivElement>(null);
  const lastRef = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const report = (value: unknown, source: GlobalErrorNotice['source']) => {
      if (!isReportableGlobalError(value)) return;
      const message = toErrorMessage(value);
      const key = `${source}:${message}`;
      const now = Date.now();
      if (lastRef.current && lastRef.current.key === key && now - lastRef.current.at < 5000) return;
      lastRef.current = { key, at: now };
      console.error('[MTask global error] 异步异常已被兜底', value);
      setNotice({ message, source });
    };

    const onError = (event: ErrorEvent) => {
      const target = event.target as { tagName?: string } | null;
      if (target?.tagName) return; // 图片/脚本等资源加载失败，不是业务异常
      report(event.error ?? event.message, 'error');
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      report(event.reason, 'promise');
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  useEffect(() => {
    if (notice) toastRef.current?.focus();
  }, [notice]);

  const reload = () => {
    globalThis.location?.reload();
  };

  return (
    <>
      {children}
      {notice && (
        <GlobalErrorToast
          message={notice.message}
          onClose={() => setNotice(null)}
          onReload={reload}
          rootRef={toastRef}
        />
      )}
    </>
  );
}
