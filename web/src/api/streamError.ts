/**
 * T03959：流式生成失败文案的归因。
 *
 * 背景：长耗时模型调用期间 SSE 链路静默，桌面壳的 api:// 代理（Electron 主进程 Node fetch）会按
 * undici 的 bodyTimeout 掐断这条流——实测静默约 5 分钟后主进程报 `TypeError: terminated`
 * （cause UND_ERR_BODY_TIMEOUT），渲染端只拿到 `TypeError: network error`。
 * 面板原先原样透出这句裸文案，用户读成「模型报错」，于是反复重跑、白等一轮。
 *
 * 这里只判定**传输层**特征串：命中就补一句可操作说明（链路中断、已完成分段有台账、重试即续作），
 * 其余（厂商 API 错误、限流、内容为空等）保持原文不改写——不替服务端下结论。
 */

/** 传输层断连的特征串（Chromium/Electron/undici 三侧实测出现过的形态） */
const TRANSPORT_MARKERS = [
  'network error',
  'failed to fetch',
  'load failed',
  'terminated',
  'body timeout',
  'api proxy error',
  'econnreset',
  'socket hang up',
];

export function isTransportBreak(msg: string): boolean {
  const t = msg.trim().toLowerCase();
  return TRANSPORT_MARKERS.some((m) => t.includes(m));
}

/** 失败文案收口：传输层断连补可操作说明，其它原因原样返回 */
export function describeStreamFailure(raw: string): string {
  if (!raw || !isTransportBreak(raw)) return raw;
  return `${raw} —— 连接中断（不是模型报错）：本轮在长耗时调用期间链路静默被掐。`
    + '已完成的分段有台账，直接对同一文档重试即从断点续作，不会重复调用模型';
}
