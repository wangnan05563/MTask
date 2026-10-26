/**
 * T02977 复验补：更新下载的进度文案单源。
 *
 * 存在理由：菜单通道的全局进度条（App.tsx）与设置页「关于 → 版本更新」卡片此前各写一套文案，
 * 「没有 content-length」「刚点下还没收到首帧」这两种形态在卡片侧直接不渲染任何进度
 * ——用户看到的就只剩「点了下载按钮什么也没发生」。文案收在一处，两条通道才不会漏态。
 */

export type UpdatePhase =
  | 'starting' | 'resuming' | 'downloading' | 'retrying' | 'downloaded' | 'failed' | 'cancelled';

export interface UpdateProgressInput {
  status: string;
  received?: number;
  total?: number;
  message?: string;
}

export interface UpdateProgressView {
  /** 一行可见文案：任何在途状态都保证非空 */
  text: string;
  /** 0-100；总量未知时为 null（此时只靠文案给进度，不画假百分比） */
  pct: number | null;
  showBar: boolean;
  /** 下载在途（含起步与续传等待）时必须有取消入口，否则用户只能干等整包 */
  showCancel: boolean;
  tone: 'info' | 'success' | 'error';
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const IN_FLIGHT = new Set(['starting', 'resuming', 'downloading', 'retrying']);

export function updateProgressView(input: UpdateProgressInput): UpdateProgressView {
  const received = Math.max(0, Math.round(input.received ?? 0));
  const total = Math.max(0, Math.round(input.total ?? 0));
  const status = input.status ?? 'downloading';
  const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;
  // 文案里的 MB 取整：进度每 200ms 一跳，小数位会糊成一片
  const mb = (n: number) => `${Math.max(1, Math.round(n / 1024 / 1024))} MB`;
  switch (status) {
    case 'starting':
      // 点击后到首帧字节之间的那段（DNS/TLS/慢源）此前是纯空白，正是「没提示」的主因
      return { text: received > 0 ? `正在连接下载源，将从 ${mb(received)} 处续传…` : '正在连接下载源…', pct, showBar: total > 0, showCancel: true, tone: 'info' };
    case 'resuming':
      return { text: `续传中：已确认 ${fmtBytes(received)}`, pct, showBar: total > 0, showCancel: true, tone: 'info' };
    case 'retrying':
      return { text: input.message ?? '网络中断，正在自动续传重试', pct, showBar: total > 0, showCancel: true, tone: 'info' };
    case 'downloaded':
      return { text: `下载完成（${fmtBytes(received)}），等待安装确认`, pct: 100, showBar: true, showCancel: false, tone: 'success' };
    case 'failed':
      return { text: `下载失败：${input.message ?? '未知原因'}`, pct: null, showBar: false, showCancel: false, tone: 'error' };
    case 'cancelled':
      return { text: `已取消下载（保留 ${fmtBytes(received)}），可稍后从断点继续`, pct, showBar: false, showCancel: false, tone: 'info' };
    default:
      return {
        text: total > 0
          ? `正在下载新版本 ${pct}%（${fmtBytes(received)} / ${fmtBytes(total)}）`
          : // 源不给 content-length 时也要有进度：只报已下载量，不编造百分比
            `正在下载新版本：已下载 ${mb(received)}（总量未知）`,
        pct,
        showBar: total > 0,
        showCancel: true,
        tone: 'info',
      };
  }
}

/** 是否「下载在途」：驱动按钮禁用/取消入口/状态保持判定，与上面文案同源 */
export function isInFlightStatus(status: string): boolean {
  return IN_FLIGHT.has(status);
}
