/**
 * T06309：全局错误兜底静态/服务端渲染门。
 *
 * 覆盖：兜底面板与提示条的可访问标注意义、错误文案归一、网络异常排除、
 * 入口接线、全局 error/unhandledrejection 监听、样式焦点环与语义 token。
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ErrorFallback,
  GlobalErrorToast,
  isNetworkError,
  isReportableGlobalError,
  toErrorMessage,
} from '../../web/src/ui/GlobalErrorBoundary.tsx';

const ROOT = process.cwd();
let pass = 0;
let fail = 0;
const check = (name, ok, extra) => {
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
  }
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 500)}`}`);
};

const fallback = renderToStaticMarkup(
  React.createElement(ErrorFallback, {
    error: new Error('T06309 render failure'),
    onRetry: () => {},
    onReload: () => {},
  }),
);
check('G-01 兜底面板含 data 标识', fallback.includes('data-t06309="error-boundary"'));
check('G-02 兜底面板 role=alert + assertive', fallback.includes('role="alert"') && fallback.includes('aria-live="assertive"'));
check('G-03 兜底面板标题与说明可关联', fallback.includes('id="mt-error-boundary-title"') && fallback.includes('id="mt-error-boundary-desc"') && fallback.includes('aria-labelledby="mt-error-boundary-title"'));
check('G-04 兜底面板提供重试与重载按钮', fallback.includes('重试当前页面') && fallback.includes('重新加载应用'));
check('G-05 兜底面板渲染错误文案', fallback.includes('T06309 render failure'));
check('G-06 兜底面板可键盘聚焦', fallback.includes('tabindex="-1"'));
check('G-07 错误详情使用原生 details', fallback.includes('<details') && fallback.includes('查看错误详情'));

const toast = renderToStaticMarkup(
  React.createElement(GlobalErrorToast, {
    message: 'T06309 async failure',
    onClose: () => {},
    onReload: () => {},
  }),
);
check('G-08 异步提示含 data 标识', toast.includes('data-t06309="global-error-toast"'));
check('G-09 异步提示 role=alert + assertive', toast.includes('role="alert"') && toast.includes('aria-live="assertive"'));
check('G-10 异步提示提供关闭与重载按钮', toast.includes('关闭') && toast.includes('重新加载'));
check('G-11 异步提示渲染错误文案', toast.includes('T06309 async failure'));

check('G-12 Error 文案归一', toErrorMessage(new Error('boom')) === 'boom');
check('G-13 字符串文案去空白', toErrorMessage('  multi\nline  ') === 'multi line');
check('G-14 非 Error 对象读取 message', toErrorMessage({ message: 'object message', code: 1 }) === 'object message');
check('G-15 长文案截断', toErrorMessage('x'.repeat(400), 240).length === 241 && toErrorMessage('x'.repeat(400), 240).endsWith('…'));
check('G-16 空值兜底', toErrorMessage(null) === '未知异常');

check('G-17 Failed to fetch 判为网络异常', isNetworkError(new TypeError('Failed to fetch')));
check('G-18 Load failed / NetworkError 判为网络异常', isNetworkError(new TypeError('Load failed')) && isNetworkError(new Error('NetworkError when attempting to fetch resource.')));
check('G-19 AbortError 判为网络异常', isNetworkError({ name: 'AbortError', message: 'The operation was aborted.' }));
check('G-20 普通运行时异常不误判', !isNetworkError(new Error('render failed')) && isReportableGlobalError(new Error('render failed')));
check('G-21 网络异常不进入全局提示', !isReportableGlobalError(new TypeError('Failed to fetch')));

const componentSource = readFileSync(join(ROOT, 'web', 'src', 'ui', 'GlobalErrorBoundary.tsx'), 'utf8');
check('G-22 边界实现 getDerivedStateFromError', componentSource.includes('getDerivedStateFromError'));
check('G-23 边界实现 componentDidCatch', componentSource.includes('componentDidCatch'));
check('G-24 监听 window error', componentSource.includes("window.addEventListener('error'"));
check('G-25 监听 unhandledrejection', componentSource.includes("window.addEventListener('unhandledrejection'"));
check('G-26 异步监听有清理', componentSource.includes("window.removeEventListener('error'") && componentSource.includes("window.removeEventListener('unhandledrejection'"));
check('G-27 网络异常在提示前被过滤', componentSource.includes('if (!isReportableGlobalError(value)) return;'));

const mainSource = readFileSync(join(ROOT, 'web', 'src', 'main.tsx'), 'utf8');
check('G-28 入口包裹 GlobalErrorBoundary', mainSource.includes('<GlobalErrorBoundary>') && mainSource.includes('</GlobalErrorBoundary>'));
check('G-29 入口包裹 GlobalErrorWatcher', mainSource.includes('<GlobalErrorWatcher>') && mainSource.includes('</GlobalErrorWatcher>'));
check('G-30 入口引入兜底样式', mainSource.includes("import './ui/globalError.css';"));

const css = readFileSync(join(ROOT, 'web', 'src', 'ui', 'globalError.css'), 'utf8');
check('G-31 样式定义兜底与提示条', css.includes('.mt-error-boundary {') && css.includes('.mt-global-error-toast {'));
check('G-32 按钮有 focus-visible 焦点环', css.includes('.mt-error-action:focus-visible'));
check('G-33 使用 semantic token', css.includes('--mt-semantic-status-danger-fg') && css.includes('--mt-semantic-bg-canvas'));
check('G-34 固定层不改变布局', css.includes('position: fixed') && css.includes('inset: 0'));

console.log(`\n[t06309-global-error] pass=${pass} fail=${fail}`);
if (fail > 0) process.exitCode = 1;
