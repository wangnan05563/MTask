/**
 * 导出类端点并发闸（T00789；排队改造见「排队」一节）。
 *
 * 背景：/plans/export、/settings/export、/dbadmin/*\/export、/report/generate 均为
 * **同步主线程**重活（实测 plans/export ≈283ms/次、report/generate 165~2162ms/次），
 * 且彼此无并发上限。多用户同时导出会串行排队叠加阻塞，把单个请求的耗时放大成
 * 「N × 单次耗时」，并挤占事件循环拖慢无关端点。
 *
 * 策略：内存信号量——按「闸名」维护进行中计数，同时执行数达到上限即拒绝（429 + 中文提示）。
 * 默认**不排队**（拒绝让调用方最快得到反馈并可重试）；需要缓冲的闸在挂载处显式开
 * **有界排队**（排队预算 + 队列容量，任一越界仍回 429 并附 `Retry-After`）。
 *
 * 设计要点：
 * - **中间件级**实现，逐端点重复零成本，新增导出端点只需在挂载处包一层。
 * - 计数在 `res` 的 `finish`/`close` 事件上归还——**包括异常与客户端提前断开**，
 *   避免计数泄漏导致闸门永久锁死。
 * - 单进程内存态即可：本服务为单进程部署（UVICORN_WORKERS=1 同类约束），
 *   无需跨进程协调；进程重启计数归零，符合「瞬时过载保护」语义。
 */
import type { Request, Response, NextFunction } from 'express';
import { getSetting } from '../services/AppSettings';

/** 闸门默认上限：同时 2 个导出在跑，第 3 个起拒绝（app_settings 未配置时的回退值） */
export const EXPORT_GATE_LIMIT = 2;

/**
 * 周报四格式导出与启动会稿**共用**的闸名（PRD-项目启动会PPT生成 FR-5：
 * 「启动会稿与周报共用同一闸，避免 worker 池被并发大稿打满」）。
 * 命名成常量而非两处字面量，是因为「共用」本身是需求而不是巧合——写成两遍迟早被后来者拆回两个闸。
 */
export const REPORT_GATE = 'report-generate';

/**
 * 排队预算默认值（毫秒）：0 = 不排队（T00789 原始语义）。
 * 要排队的闸在挂载处显式传 `queueMs`，**不要改这个默认值**——「超限不排队」是周报闸
 * （T02105/T02142/T03608）、Git 提取闸（T03367）、Sonar 扫描闸（T03376）三条他单判据钉死的行为，
 * 默认值一改会连带打红它们；本项目按闸逐个放行，不批量改语义。
 */
export const EXPORT_QUEUE_WAIT_MS = 0;

/**
 * 纯导出端点开排队时统一用的预算（毫秒）。取值依据：2026-11-01 压测 `heavy_c4` 阶段实测
 * 17 次 429 全落在这些端点（`h_plans_export` 6、`h_reqmatrix_export` 6、`h_est_export_xlsx` 5），
 * 单次耗时在 200~1000ms 量级，3s 足够吸收常见突发，又不至于让调用方无限挂住。
 */
export const EXPORT_QUEUE_WAIT_EXPORTED = 3000;

/**
 * 「整库级」慢导出的排队预算（毫秒）：`settings/export` 与 `dbadmin/*\/export`。
 * 取值依据是 2026-11-03 的隔离实测阶梯（`perf/m2b/http.mjs` 的 H-03b，175MB 生产日备份副本，10 路并发）：
 *   settings-export 单发 3.0~4.3s → 预算 0/3000/8000ms 分别放行 2/4/6 路；
 *   dbadmin-export 单发 4.3~12.4s → 预算 0/8000/16000ms 分别放行 3/5/7 路。
 * 也就是**预算短于单次耗时＝被拒者白等一趟**：3s 预算对这两类端点只是把「即时拒」推后 3s，
 * 交付数不动。取 8s 而不是 16s：16s 档虽然再多放 2 路，但尾延迟冲到 32s，
 * 交互式点「导出」等半分钟不可接受（宁让它 429 + Retry-After 让客户自己重试）。
 */
export const EXPORT_QUEUE_WAIT_SLOW_EXPORT = 8000;

/** 队列容量默认值（仅在闸已开排队时生效）：排到第 N 位以后直接拒，避免无界排队吃掉连接 */
export const EXPORT_QUEUE_CAPACITY = 6;

/** `Retry-After` 的钳制区间（秒）：下界 1s，上界 60s，防止估算把客户端支到数分钟外 */
const RETRY_AFTER_MIN_SECONDS = 1;
const RETRY_AFTER_MAX_SECONDS = 60;

/** 排队中的请求：到预算即出队报 429；被前序释放顶上时，也只在闸位真空出来才进 */
type Queued = {
  req: Request;
  res: Response;
  next: NextFunction;
  enqueuedAt: number;
  /** 已定局（放行 / 超时拒 / 断连）——定局后不得再被 promote 或 timer 二次处理 */
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

/** 闸内状态：进行中计数 + 等待队列 + 单次耗时 EWMA + 在跑请求的起始时刻 */
type GateState = { inflight: number; queue: Queued[]; ewmaMs: number; active: number[] };

/** 闸名 → 状态；闸位归零且队列空时整条删除，既避免闸名增长，也让 `gateSnapshot()` 回到 `{}` */
const gates = new Map<string, GateState>();

/**
 * 耗时样本的「跨空档留存」：闸位全空时上面那份状态会被回收（快照要归 `{}`），
 * 若 EWMA 跟着一起消失，下一轮爆发的第一个被拒者就只能拿到下界 1s——
 * 而实测 `dbadmin/tables/workspace_symbols/export` 单次要 13.8s，报 1s 等于把人支走再撞一次。
 * 所以把样本单独留下（闸名是代码里的常量，数量有限，不设淘汰）。
 */
const ewmaStore = new Map<string, number>();

function stateOf(name: string): GateState {
  let st = gates.get(name);
  if (!st) {
    st = { inflight: 0, queue: [], ewmaMs: ewmaStore.get(name) ?? 0, active: [] };
    gates.set(name, st);
  }
  return st;
}

/** 从队列里摘除一个等待项并撤掉它的预算计时（超时 / 放行 / 断连三条路都走这里） */
function dequeue(st: GateState, item: Queued): void {
  const i = st.queue.indexOf(item);
  if (i >= 0) st.queue.splice(i, 1);
  if (item.timer) clearTimeout(item.timer);
  item.timer = undefined;
}

/**
 * 各闸可调上限（T00789 建议①）：优先读 app_settings 的 `exportGateLimit.<name>`，
 * 未配置或值非法时回退到 {@link EXPORT_GATE_LIMIT}。
 * 每次请求读取一次——导出是低频重活，一次 SELECT 开销可忽略，换来配置即时生效、无需改代码调优。
 */
function resolveGateLimit(name: string, fallback: number): number {
  const raw = getSetting(`exportGateLimit.${name}`);
  if (raw !== null) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1) return n;
  }
  return fallback;
}

/** 排队预算（毫秒）：设置项 `exportGateQueueMs.<name>` 优先，非法/缺失回退挂载实参；0 = 不排队 */
function resolveQueueMs(name: string, fallback: number): number {
  const raw = getSetting(`exportGateQueueMs.${name}`);
  if (raw !== null) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return fallback;
}

/** 队列容量：设置项 `exportGateQueueCapacity.<name>` 优先；配 0 等于「不许排队」 */
function resolveCapacity(name: string, fallback: number): number {
  const raw = getSetting(`exportGateQueueCapacity.${name}`);
  if (raw !== null) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return fallback;
}

/**
 * `Retry-After` 估算：剩余排队位 × 每闸位耗时估计，钳到 1~60s。
 * 每闸位耗时取「EWMA 样本」与「当前在跑请求已耗时」的较大者——后者是下界：一个已经跑了
 * 5s 还没完的导出，绝不会因为「历史上平均只跑 0.3s」而在 1s 后排空。
 * 二者皆无（首轮爆发的第 0 毫秒）才落到下界 1s。
 */
function retryAfterSeconds(st: GateState, position: number): number {
  const now = performance.now();
  let activeElapsed = 0;
  for (const startedAt of st.active) activeElapsed = Math.max(activeElapsed, now - startedAt);
  const perSlot = Math.max(st.ewmaMs, activeElapsed);
  const est = Math.ceil(((position + 1) * perSlot) / 1000);
  return Math.min(RETRY_AFTER_MAX_SECONDS, Math.max(RETRY_AFTER_MIN_SECONDS, est));
}

/**
 * 拒绝态：429 + JSON。响应体保持 T02105 锚定的那句字面量**逐字不变**
 * （门里既有源码字面锚 `res.status(429).json({ error: '导出任务过多，请稍后再试' })`，
 * 也有前端 `GATE_BUSY_MSG='导出任务过多'` 的包含判定），排队信息只走 `Retry-After` 头。
 * 头是新增项、不影响既有断言：族内门核的是 statusCode 与 JSON 体，没有「响应头集合相等」这类判据。
 */
function rejectOverLimit(res: Response, retryAfterSec: number): void {
  res.setHeader('Retry-After', String(retryAfterSec));
  res.status(429).json({ error: '导出任务过多，请稍后再试' });
}

/** 暴露给测试/诊断：当前各闸进行中计数快照 */
export function gateSnapshot(): Record<string, number> {
  return Object.fromEntries([...gates].map(([name, st]) => [name, st.inflight]));
}

/** 暴露给测试/诊断：各闸排队深度与耗时样本（`Retry-After` 的可核依据） */
export function gateQueueSnapshot(): Record<string, { queued: number; ewmaMs: number }> {
  return Object.fromEntries(
    [...gates].map(([name, st]) => [name, { queued: st.queue.length, ewmaMs: Math.round(st.ewmaMs) }]),
  );
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
 * 排队（`queueMs > 0`）与 `defer` 相互作用：预算计时只在事件循环有空隙时才走表，同步重活把循环
 * 占死的期间，队列里的人既拿不到闸位也判不出超时——这是 T00789 那条「同步端点必须 defer」教训
 * 的另一种表现。所以开排队的同步端点必须同时带 `defer: true`。
 *
 * @param name 闸名（同一名共享计数；不同导出端点建议各用其名，避免互相顶掉）
 * @param limit 并发上限，默认 {@link EXPORT_GATE_LIMIT}
 * @param opts.defer 处理器为同步重活时置 true，令 next() 让出一次事件循环（见上）
 * @param opts.queueMs 排队预算（毫秒），默认 {@link EXPORT_QUEUE_WAIT_MS}=0 即不排队；
 *        >0 时超限请求先进本闸队列等闸位，超预算才 429（附 `Retry-After`）
 * @param opts.capacity 队列容量，默认 {@link EXPORT_QUEUE_CAPACITY}；排满即拒，不无界增长
 */
export function exportGate(
  name: string,
  limit: number = EXPORT_GATE_LIMIT,
  opts?: { defer?: boolean; queueMs?: number; capacity?: number },
) {
  const defer = opts?.defer === true;
  const queueMsFallback = opts?.queueMs ?? EXPORT_QUEUE_WAIT_MS;
  const capacityFallback = opts?.capacity ?? EXPORT_QUEUE_CAPACITY;
  return function exportGateMiddleware(req: Request, res: Response, next: NextFunction): void {
    const effective = resolveGateLimit(name, limit);
    const queueMs = resolveQueueMs(name, queueMsFallback);
    const capacity = resolveCapacity(name, capacityFallback);
    const st = stateOf(name);

    /** 空闸时回收状态：既无在跑也无等待，且 map 里挂的就是这一份，才允许摘掉 */
    const gcIfIdle = () => {
      if (st.inflight === 0 && st.queue.length === 0 && gates.get(name) === st) gates.delete(name);
    };

    /** 拿到闸位：计数 +1，响应结束归还并立刻尝试放行队列头部 */
    const admit = (item?: Queued) => {
      const callNext = item ? item.next : next;
      const resRef = item ? item.res : res;
      const admittedAt = performance.now();
      st.inflight += 1;
      st.active.push(admittedAt);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        st.inflight -= 1;
        const i = st.active.indexOf(admittedAt);
        if (i >= 0) st.active.splice(i, 1);
        const dur = performance.now() - admittedAt;
        st.ewmaMs = st.ewmaMs === 0 ? dur : st.ewmaMs * 0.7 + dur * 0.3;
        ewmaStore.set(name, st.ewmaMs);
        promote();
        gcIfIdle();
      };
      // finish=正常响应完成；close=客户端提前断开（含 res 未发完就断）。二者可能都触发，用 once 去重。
      resRef.once('finish', release);
      resRef.once('close', release);
      if (defer) setImmediate(callNext);
      else callNext();
    };

    /** 队列头部能否进闸：只在真空出闸位时逐位放行，并跳过已定局（超时/断连）的项 */
    const promote = () => {
      while (st.inflight < effective && st.queue.length > 0) {
        const head = st.queue[0];
        if (head.settled) {
          dequeue(st, head);
          continue;
        }
        dequeue(st, head);
        head.settled = true;
        admit(head);
      }
    };

    if (st.inflight < effective) {
      admit();
      return;
    }
    if (queueMs <= 0 || capacity < 1) {
      // 未开排队的闸：维持 T00789 原始语义——即时拒绝
      rejectOverLimit(res, retryAfterSeconds(st, st.queue.length));
      return;
    }
    if (st.queue.length >= capacity) {
      // 队列已满：继续排队等于把拒绝推迟并多占连接，直接拒，把预算留给已在队里的人
      rejectOverLimit(res, retryAfterSeconds(st, capacity));
      return;
    }
    const item: Queued = { req, res, next, enqueuedAt: performance.now(), settled: false };
    st.queue.push(item);
    // 预算计时须 unref：否则 CLI/探针里一个未完成的排队请求会把进程多拖几秒，退出码读数被搅乱
    item.timer = setTimeout(() => {
      if (item.settled) return;
      item.settled = true;
      dequeue(st, item);
      rejectOverLimit(res, retryAfterSeconds(st, st.queue.length));
      gcIfIdle();
    }, queueMs);
    item.timer.unref?.();
    // 客户端在排队期间关窗/abort：出队即可，不得再被 promote 唤起 next（否则白占闸位）
    res.once('close', () => {
      if (item.settled) return;
      item.settled = true;
      dequeue(st, item);
      gcIfIdle();
    });
  };
}
