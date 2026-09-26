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
  /** 应用内一键下载更新安装包（T00878）：主进程下载到系统下载目录并返回安装包绝对路径 */
  downloadUpdate: (url) => ipcRenderer.invoke('update:download', url),
  /** 对已下载的安装包执行静默安装并退出当前应用（T00878） */
  installUpdate: (filePath) => ipcRenderer.invoke('update:install', filePath),
  /** 订阅下载进度；返回取消订阅函数，避免重复监听 */
  onUpdateProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('update:progress', listener);
    return () => ipcRenderer.removeListener('update:progress', listener);
  },
  /** T01057-FR1.1：任务通知开关（持久化在主进程 userData/notify-prefs.json） */
  getNotifyEnabled: () => ipcRenderer.invoke('notify:get-enabled'),
  setNotifyEnabled: (enabled) => ipcRenderer.invoke('notify:set-enabled', enabled),
  /** 订阅「通知点击 → 定位任务」事件（载荷为 task_no）；返回取消订阅函数 */
  onNavigateTask: (cb) => {
    const listener = (_e, taskNo) => cb(taskNo);
    ipcRenderer.on('notify:navigate', listener);
    return () => ipcRenderer.removeListener('notify:navigate', listener);
  },
});
