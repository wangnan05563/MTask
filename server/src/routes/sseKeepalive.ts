import type { Response } from 'express';

/**
 * T03959：SSE 静默期保活帧。
 *
 * 为什么要它：长耗时模型调用期间，服务端可能连续几分钟一个字节都不写（stage 只在阶段边界发）。
 * 桌面壳内前端走 `api://` 自定义协议，由 Electron 主进程用 Node fetch 转发（electron/main.js setupApiProxy），
 * 而 undici 对响应体有 bodyTimeout——实测静默约 5 分钟后这条流被掐断：
 * 主进程侧 `TypeError: terminated`（cause BodyTimeoutError / UND_ERR_BODY_TIMEOUT），
 * 渲染端只拿到 `TypeError: network error`，面板就表现为「生成失败：network error」——
 * 用户看不出是链路被掐，服务端也把正在跑的轮次记成 aborted（已完成分段有台账，重试会续作）。
 *
 * 做法：按固定间隔写一条 SSE 注释帧（以 `:` 开头，规范里不是事件）。前端 sse.ts 的解析器只认
 * `data:` 行、无负载即跳过，因此保活帧不产生任何业务事件，只让链路始终有字节可收。
 */
export const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

/** 启动保活：返回停止函数（响应关闭时自动停止，调用方可忽略返回值） */
export function startSseKeepalive(res: Response, intervalMs = SSE_KEEPALIVE_INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    res.write(': keepalive\n\n');
  }, intervalMs);
  const stop = () => clearInterval(timer);
  res.on('close', stop);
  return stop;
}
