/**
 * 导出类端点并发闸（T00789）。
 *
 * 背景：/plans/export、/settings/export、/dbadmin/*\/export、/report/generate 均为
 * **同步主线程**重活（实测 plans/export ≈283ms/次、report/generate 165~2162ms/次），
 * 且彼此无并发上限。多用户同时导出会串行排队叠加阻塞，把单个请求的耗时放大成
 * 「N × 单次耗时」，并挤占事件循环拖慢无关端点。
 *
 * 策略：内存信号量——按「闸名」维护进行中计数，同时执行数达到上限即拒绝（429 + 中文提示），
 * 不做排队等待（排队会继续占住连接与内存，拒绝让调用方更快得到反馈并可重试）。
 *
 * 设计要点：
 * - **中间件级**实现，逐端点重复零成本，新增导出端点只需在挂载处包一层。
 * - 计数在 `res` 的 `finish`/`close` 事件上归还——**包括异常与客户端提前断开**，
 *   避免计数泄漏导致闸门永久锁死。
 * - 单进程内存态即可：本服务为单进程部署（UVICORN_WORKERS=1 同类约束），
 *   无需跨进程协调；进程重启计数归零，符合「瞬时过载保护」语义。
 */
import type { Request, Response, NextFunction } from 'express';

/** 闸门默认上限：同时 2 个导出在跑，第 3 个起拒绝 */
export const EXPORT_GATE_LIMIT = 2;

/** 进行中计数：闸名 → 当前执行数 */
const inflight = new Map<string, number>();

/** 暴露给测试/诊断：当前各闸进行中计数快照 */
export function gateSnapshot(): Record<string, number> {
  return Object.fromEntries(inflight);
}

/**
 * 创建导出并发闸中间件。
 *
 * ⚠️ `defer` 参数的必要性（T00789 实测教训）：
 * 若被保护的处理器体是**完全同步**的（如 `settings/export` 的 `exportBundle()`、
 * `dbadmin/*\/export` 的 `exportRows()`——内部只有 `db.prepare().all()` 与 `map` 循环，无 await），
 * Node 单线程在同步执行期间**无法接受并解析下一个 HTTP 请求**，于是下一个请求的闸门检查
 * 根本不会在计数已达上限时被求值——计数永远停在 1，闸门形同虚设（实测 10 路并发 0×429，
 * 且响应耗时线性叠加至 946ms）。
 *
 * 对照：`plans/export` 的处理器是 async（`.then(...)`），执行中会让出事件循环，
 * 后续请求得以抵达闸门，10 路并发正确产生 6×429。
 *
 * 修法：对同步处理器置 `defer: true`，把 `next()` 推迟到 `setImmediate`——让事件循环先
 * 处理已排队的请求（各自完成闸门检查与计数），再开始同步重活。这样计数才真正反映并发。
 *
 * @param name 闸名（同一名共享计数；不同导出端点建议各用其名，避免互相顶掉）
 * @param limit 并发上限，默认 {@link EXPORT_GATE_LIMIT}
 * @param opts.defer 处理器为同步重活时置 true，令 next() 让出一次事件循环（见上）
 */
export function exportGate(name: string, limit: number = EXPORT_GATE_LIMIT, opts?: { defer?: boolean }) {
  const defer = opts?.defer === true;
  return function exportGateMiddleware(_req: Request, res: Response, next: NextFunction): void {
    const cur = inflight.get(name) ?? 0;
    if (cur >= limit) {
      res.status(429).json({ error: '导出任务过多，请稍后再试' });
      return;
    }
    inflight.set(name, cur + 1);
    // finish=正常响应完成；close=客户端提前断开（含 res 未发完就断）。二者可能都触发，用 once 去重。
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const n = (inflight.get(name) ?? 1) - 1;
      if (n <= 0) inflight.delete(name);
      else inflight.set(name, n);
    };
    res.once('finish', release);
    res.once('close', release);
    if (defer) setImmediate(next);
    else next();
  };
}
