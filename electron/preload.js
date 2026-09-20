/**
 * 桌面壳预加载脚本（Electron）。
 *
 * 存在的唯一理由：主进程的原生能力（如系统目录选择对话框）无法被渲染进程直接调用，
 * 而开启 nodeIntegration 会把整个 Node 运行时暴露给页面，风险过大。
 * 这里用 contextBridge 只暴露一个最小白名单 API（mtaskDesktop.openDirectory），
 * 渲染进程（web/src/ui/desktop.ts）按是否存在该对象决定走原生对话框还是降级方案。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mtaskDesktop', {
  /** 唤起系统「选择文件夹」对话框；取消返回 null */
  openDirectory: () => ipcRenderer.invoke('dialog:open-directory'),
});
