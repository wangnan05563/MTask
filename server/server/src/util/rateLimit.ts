/**
 * T03700：供应商限流（HTTP 429 / rate limit）识别与退避等待工具。
 * 供 AIService.askJson（限流退避重试）与 PlanService 分片解析（并发降档 + 片级退避）共用。
 */

/** 识别限流类错误——适配器把 HTTP 状态拼进 error 文本，按特征匹配（429 词边界 / rate limit / 限流） */
export function isRateLimitError(err: string | null | undefined): boolean {
  if (!err) return false;
  return /\b429\b|rate ?limit|too many requests|限流/i.test(err);
}

/** 可中断 sleep：signal 触发 abort（或总预算到点）时立即返回，退避等待不傻等 */
export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (timer != null) clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done);
  });
}

/**
 * T03700：限流退避等待时长——按轮次指数递增（20s → 40s → 60s …）；
 * 传入 deadlineAt 时钳制到「剩余预算 − 30s 收尾预留」，≤0 表示预算不足以再等一轮（调用方应放弃重试）。
 */
export function rateLimitBackoffMs(round: number, deadlineAt?: number): number {
  const base = 20_000 * Math.max(1, round);
  if (deadlineAt == null) return base;
  const remain = deadlineAt - Date.now() - 30_000;
  return Math.max(0, Math.min(base, remain));
}
