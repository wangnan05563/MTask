import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
// T06309：全局异常兜底（渲染异常 + 未处理异步异常）
import { GlobalErrorBoundary, GlobalErrorWatcher } from './ui/GlobalErrorBoundary';
// T06287：接入设计 Token 与 Design System 原语样式；原语未被业务页引用时零视觉变化
import './theme/tokens.css';
import './ui/components.css';
import './ui/globalError.css';
// T06288：统一页面壳与筛选条布局
import './ui/layout/pageShell.css';
// T06289：左侧 5 项一级导航与顶栏子页签切换器
import './ui/nav/primaryNav.css';
// T00840：挂载关闭前「运行中任务」查询桥到 window，供桌面壳主进程 executeJavaScript 调用
import './ui/runningTasks';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GlobalErrorBoundary>
      <GlobalErrorWatcher>
        <App />
      </GlobalErrorWatcher>
    </GlobalErrorBoundary>
  </React.StrictMode>,
);

// 生产构建注册 Service Worker（移动端离线打开界面，§3.4 / §4.4）；dev 不注册，避免干扰 HMR
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* 注册失败静默忽略 */ });
  });
}
