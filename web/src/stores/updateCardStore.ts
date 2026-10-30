/**
 * T02977 复验补：版本更新卡片的「跨挂载现场」store。
 *
 * 此前检查结果、下载进度、取消半截包、安装失败回执全部躺在组件 useState 里：
 * 用户一点下载就切页（或从「关于」切到别的子页再切回来），组件卸载即现场归零，
 * 再回来连「正在下载」都看不见——正是复验里「点击下载按钮未提示下载进度」「关于页状态不保持」两条的成因。
 * 这里把在途操作与现场收进模块级状态（同 aiImportStore 的既有写法），组件只负责渲染；
 * 下载/安装的 Promise 也归 store 持有，切页不再打断链路。
 */
import { desktopApi, type UpdateDownloadResult } from '../ui/desktop';
import { fmtBytes, isInFlightStatus } from '../ui/updateProgress';

/** 版本更新接口返回结构（与后端 UpdateService.checkUpdate 对齐） */
export interface UpdateCheckInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseName: string;
  releaseUrl: string;
  publishedAt: string;
  downloadUrl: string;
  changelog: string;
  /** T02977：本次检查实际使用的地址与来源 */
  repo: string;
  source: 'manual' | 'builtin';
}

export interface UpdateProgress {
  received: number;
  total: number;
  status: string;
  message?: string;
}

export interface UpdateCardState {
  busy: 'save' | 'test' | 'check' | 'download' | 'install' | null;
  /** 最近一次检查结果：切页回来还要能看到「发现新版本 + 下载入口」 */
  result: UpdateCheckInfo | null;
  /** 本页发起的下载进度 */
  dl: UpdateProgress | null;
  /** 菜单通道（或切页前发起）的下载进度：没有它，用户只会撞「已有下载进行中」 */
  externalDl: UpdateProgress | null;
  /** 取消后保留的半截下载（bytes>0 → 按钮变「继续下载」） */
  cancelledPart: number | null;
  installError: { message: string; filePath: string; targetVersion: string } | null;
  notice: string;
}

const INITIAL: UpdateCardState = {
  busy: null, result: null, dl: null, externalDl: null, cancelledPart: null, installError: null, notice: '',
};

let state: UpdateCardState = INITIAL;
const listeners = new Set<() => void>();
const emit = () => { for (const fn of listeners) fn(); };

function patch(p: Partial<UpdateCardState>): void {
  state = { ...state, ...p };
  emit();
}

/** 当前该展示的进度：本页发起的优先，其次菜单/恢复来的 */
export function shownProgressOf(s: UpdateCardState): UpdateProgress | null {
  return s.busy === 'download' ? s.dl : s.externalDl;
}

/** 主进程进度只订一次：组件卸载/重挂载不应产生第二条监听，否则同一帧被应用多次 */
let attached = false;

export const updateCardStore = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  getSnapshot(): UpdateCardState {
    return state;
  },
  patch,
  flash(msg: string): void {
    patch({ notice: msg });
  },
  clearNotice(): void {
    if (state.notice) patch({ notice: '' });
  },
  setResult(result: UpdateCheckInfo | null): void {
    patch({ result });
  },
  setBusy(busy: UpdateCardState['busy']): void {
    patch({ busy });
  },

  /**
   * 进度事件入口：origin='settings' 且本次由本页发起 → dl；其余（菜单自驱、切页后恢复）→ externalDl。
   * 收口在 store 里，组件是否挂载都不影响现场——切页回来仍是同一份进度。
   */
  applyProgress(d: { status: string; received?: number; total?: number; origin?: string; message?: string }): void {
    const progress: UpdateProgress = {
      status: d.status,
      received: Math.max(0, d.received ?? 0),
      total: Math.max(0, d.total ?? 0),
      ...(d.message ? { message: d.message } : {}),
    };
    if (isInFlightStatus(d.status)) {
      // 起步帧（starting）要把 cancelledPart 让位：断点已被本次下载接管，不能再显示「继续下载」
      if (state.busy === 'download') patch({ dl: progress, cancelledPart: null });
      else patch({ externalDl: progress, cancelledPart: null });
      return;
    }
    if (d.status === 'failed' || d.status === 'cancelled') {
      patch({ dl: null, externalDl: null, busy: state.busy === 'download' ? null : state.busy });
      return;
    }
    // downloaded / 其它终态：交给发起方的 Promise 收口，这里只保证不再挂着「在途」样式
    patch({ dl: d.status === 'downloaded' ? null : state.dl, externalDl: d.status === 'downloaded' ? null : state.externalDl });
  },

  /** 订阅主进程进度（只订一次，模块级存活）+ 恢复正在进行的那条下载 */
  attach(): void {
    if (attached) return;
    const desk = desktopApi();
    if (!desk?.onUpdateProgress) return;
    attached = true;
    desk.onUpdateProgress((d) => updateCardStore.applyProgress(d));
    desk.getActiveUpdate?.().then((st) => {
      if (!st?.active) return;
      updateCardStore.applyProgress({ status: 'downloading', received: st.received, total: st.total, origin: st.origin });
    }).catch(() => { /* 主进程未就绪：事件到达时自然补上 */ });
  },

  /** 一键下载并安装：Promise 由 store 持有，切页不打断、回来仍可见进度 */
  async downloadAndInstall(result: UpdateCheckInfo): Promise<void> {
    const desk = desktopApi();
    if (!desk?.downloadUpdate || !desk.installUpdate) return;
    patch({ busy: 'download', dl: { status: 'starting', received: state.cancelledPart ?? 0, total: 0 }, externalDl: null, installError: null });
    try {
      const r: UpdateDownloadResult = await new Promise<UpdateDownloadResult>((resolve, reject) => {
        const off = desk.onUpdateProgress?.((d) => {
          if (d.status === 'downloaded') { off?.(); resolve({ status: 'downloaded', filePath: d.filePath }); return; }
          updateCardStore.applyProgress(d);
        });
        desk.downloadUpdate?.(result.downloadUrl).then((v) => { off?.(); resolve(v); }, (e) => { off?.(); reject(e); });
      });
      patch({ dl: null, externalDl: null });
      if (r.status === 'cancelled') {
        patch({ busy: null, cancelledPart: r.partialBytes ?? 0 });
        this.flash(`已取消下载（保留 ${fmtBytes(r.partialBytes ?? 0)}），可点「继续下载」从断点续传`);
        return;
      }
      patch({ cancelledPart: null });
      await this.install(r.filePath ?? '', result.latestVersion);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      patch({ busy: null, dl: null, externalDl: null });
      // 菜单通道已在下载：不是死胡同——切到那条下载的现场，进度与取消入口都还在
      if (/已有下载进行中/.test(msg)) {
        const st = await desk.getActiveUpdate?.();
        if (st?.active) this.applyProgress({ status: 'downloading', received: st.received, total: st.total, origin: st.origin });
        this.flash('已切换到正在进行的下载，可在此查看进度或取消');
        return;
      }
      this.flash(msg);
    }
  },

  /** T02071：安装独立成函数——首次安装与「重试」共用，重试直接复用已下载的安装包 */
  async install(filePath: string, targetVersion: string): Promise<void> {
    const desk = desktopApi();
    if (!desk?.installUpdate || !filePath) return;
    patch({ busy: 'install', installError: null });
    this.flash('正在静默安装，安装完成后自动退出并重启到新版本…');
    try {
      const r = await desk.installUpdate(filePath, targetVersion);
      if (r.status === 'pending') {
        patch({ busy: null });
        this.flash(r.message ?? '安装仍在进行，结果将在下次启动时确认');
        return;
      }
      if (r.status === 'installed') {
        patch({ busy: null, dl: null, cancelledPart: null });
        return; // 主进程随即退出，界面关闭即为回执
      }
      patch({ busy: null, installError: { message: r.message ?? '安装失败', filePath: r.filePath ?? filePath, targetVersion: r.targetVersion ?? targetVersion } });
    } catch (e) {
      patch({ busy: null, installError: { message: e instanceof Error ? e.message : String(e), filePath, targetVersion } });
    }
  },

  async cancelDownload(): Promise<void> {
    const desk = desktopApi();
    if (!desk?.cancelUpdateDownload) return;
    try {
      await desk.cancelUpdateDownload();
    } catch (e) {
      this.flash(e instanceof Error ? e.message : String(e));
    }
  },
};
