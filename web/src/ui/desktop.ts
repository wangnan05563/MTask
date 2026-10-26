/**
 * 桌面壳能力探测（T00771）。
 *
 * 只有运行在 Electron 壳内、且 preload 成功注入时 window.mtaskDesktop 才存在；
 * 纯浏览器（含 Vite dev 直连）下为 undefined，调用方据此降级到 <input type="file">。
 * 用可选探测而非 declare global：避免给浏览器环境伪造一个永不存在的全局类型。
 */
/**
 * T02071：一键更新的下载/安装回执契约（与 electron/main.js 的 IPC 返回值对齐）。
 * downloaded 表示安装包已落地；cancelled 表示用户中途取消——主进程保留 .part，
 * 再次 downloadUpdate 会自动带 Range 续传，前端据此把按钮换成「继续下载」。
 */
export interface UpdateDownloadResult {
  status: 'downloaded' | 'cancelled';
  filePath?: string;
  /** 本次续传的起点字节数（0=从 0 重下） */
  resumedFrom?: number;
  totalBytes?: number;
  /** 取消时已落地的字节数与 .part 路径 */
  partialBytes?: number;
  partPath?: string;
}

/** 安装回执：installed 成功（应用随后退出）；failed 当场可重试；pending 等待超时，下次启动对账 */
export interface UpdateInstallResult {
  ok: boolean;
  status: 'installed' | 'failed' | 'pending';
  message?: string;
  code?: number | null;
  filePath?: string;
  targetVersion?: string;
}

/** 上次静默安装的启动对账结果 */
export interface UpdatePendingResult {
  status: 'installed' | 'failed';
  reason?: string;
  message?: string;
  filePath?: string;
  targetVersion?: string;
  code?: number | null;
}

export interface DesktopApi {
  /** 唤起系统「选择文件夹」对话框，返回绝对路径；用户取消返回 null */
  openDirectory: () => Promise<string | null>;
  /** 应用内下载更新安装包（T00878）；T02071 起返回结果对象并支持取消后续传 */
  downloadUpdate?: (url: string) => Promise<UpdateDownloadResult>;
  /** T02071：终止进行中的下载但保留 .part（断点续传用） */
  cancelUpdateDownload?: () => Promise<{ status: string; partialBytes?: number }>;
  /** T02976 补：查询进行中的下载（无则 active=false），用于设置页重挂载与菜单通道的状态恢复 */
  getActiveUpdate?: () => Promise<{ active: boolean; received?: number; total?: number; origin?: string }>;
  /** 静默安装已下载的安装包（T00878）；T02071 起回收退出码返回回执，targetVersion 用于下次启动对账 */
  installUpdate?: (filePath: string, targetVersion?: string) => Promise<UpdateInstallResult>;
  /** T02071：取回上一次静默安装的对账回执（无待回执时 null，一次消费即清） */
  getUpdatePendingResult?: () => Promise<UpdatePendingResult | null>;
  /** 订阅下载进度（T00878）；返回取消订阅函数。
   *  T02976：origin 区分下载入口（menu=「帮助→检查在线更新」自驱，settings=设置页卡片），
   *  主界面全局进度条只消费 menu 通道，避免与设置页卡片内进度重复显示。 */
  onUpdateProgress?: (cb: (data: { status: string; received?: number; total?: number; filePath?: string; origin?: string; message?: string }) => void) => () => void;
  /** T02976：菜单通道下载失败后的「重试」——重走整条在线更新流程（检查→确认→下载） */
  retryOnlineUpdate?: () => Promise<void>;
}

/** 取桌面壳 API；非 Electron 环境返回 null（调用方需自行降级） */
export function desktopApi(): DesktopApi | null {
  const w = globalThis as unknown as { mtaskDesktop?: Partial<DesktopApi> };
  const api = w.mtaskDesktop;
  return typeof api?.openDirectory === 'function' ? (api as DesktopApi) : null;
}
