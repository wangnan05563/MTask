import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
// T00840：挂载关闭前「运行中任务」查询桥到 window，供桌面壳主进程 executeJavaScript 调用
import './ui/runningTasks';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// 生产构建注册 Service Worker（移动端离线打开界面，§3.4 / §4.4）；dev 不注册，避免干扰 HMR
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* 注册失败静默忽略 */ });
  });
}
