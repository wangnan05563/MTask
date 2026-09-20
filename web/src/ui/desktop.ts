/**
 * 桌面壳能力探测（T00771）。
 *
 * 只有运行在 Electron 壳内、且 preload 成功注入时 window.mtaskDesktop 才存在；
 * 纯浏览器（含 Vite dev 直连）下为 undefined，调用方据此降级到 <input type="file">。
 * 用可选探测而非 declare global：避免给浏览器环境伪造一个永不存在的全局类型。
 */
export interface DesktopApi {
  /** 唤起系统「选择文件夹」对话框，返回绝对路径；用户取消返回 null */
  openDirectory: () => Promise<string | null>;
}

/** 取桌面壳 API；非 Electron 环境返回 null（调用方需自行降级） */
export function desktopApi(): DesktopApi | null {
  const w = window as unknown as { mtaskDesktop?: Partial<DesktopApi> };
  const api = w.mtaskDesktop;
  return typeof api?.openDirectory === 'function' ? (api as DesktopApi) : null;
}
