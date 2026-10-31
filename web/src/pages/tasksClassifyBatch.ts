/**
 * T02307：AI 批量分类的失败分类与熔断（与 React 解耦，供验收门直接驱动）。
 *
 * 缺陷背景：厂商账户级门禁（402 额度耗尽 / 429 免费限流）发生时，批量循环会把注定失败的
 * 请求一条不落地打完（生产实测 3 次/秒 × 69 次全失败），并把收尾文案说成「无合适分类」。
 * 这里把三态（命中 / 真·无匹配 / 厂商侧失败）与熔断判定收敛到一处：
 *  - 账户级门禁首次命中即停（MTask 路由把厂商 4xx 统一映射为 400，故只能读错误原文）；
 *  - 连续 K 次厂商失败同样停，避免非 402/429 的持续性故障继续白烧额度。
 */
export interface ClassifyTarget {
  id: string;
  title: string;
  priority: string;
}

export interface ClassifyCategory {
  id: string;
  name: string;
}

export interface ClassifyResponse {
  ok: boolean;
  categoryId?: string | null;
  priority?: string | null;
  error?: string;
}

/** T03297：批量接口的单条结果（与输入 id 对齐，数组与 items 等长同序） */
export interface ClassifyBatchItemResult extends ClassifyResponse {
  id: string;
}

export interface ClassifyBatchResponse extends ClassifyResponse {
  results?: ClassifyBatchItemResult[];
  /** 账户级门禁命中，服务端已停止后续批次 */
  gated?: boolean;
  calls?: number;
}

export interface ClassifyStoreState {
  busy: boolean;
  hit: number;
  total: number;
  done: boolean;
  none: number;
  fail: number;
  lastError: string;
  aborted: boolean;
  abortReason: string;
}

export const MAX_CONSECUTIVE_FAILURES = 3;

/** 账户级门禁特征：错误原文里出现额度/限流/402/429 即视为重试必然同样失败 */
export function isAccountGateError(message: string): boolean {
  return /(rate\s*limit|insufficient|quota|额度|限流|\b402\b|\b429\b)/i.test(message);
}

export function createClassifyStore(): ClassifyStoreState {
  return { busy: false, hit: 0, total: 0, done: false, none: 0, fail: 0, lastError: '', aborted: false, abortReason: '' };
}

export interface RunClassifyBatchOptions {
  target: ClassifyTarget[];
  toolId: string;
  categories: ClassifyCategory[];
  store: ClassifyStoreState;
  post: (path: string, body: unknown) => Promise<ClassifyResponse>;
  patch: (path: string, body: unknown) => Promise<unknown>;
  /** 外部复位（tasks.classifyBusy 取消）即中止；返回 false 时不再发新请求 */
  isActive: () => boolean;
  /** 负对照通道：false 时模拟「熔断被移除」，仅供门使用 */
  enableBreaker?: boolean;
  /** T03297：true 时走批量接口（服务端分批多次调用），默认沿用逐条通道 */
  batch?: boolean;
}

/** T03297：前端每次批量请求携带的条数上限（服务端再按批切分，二者互不耦合） */
export const BATCH_REQUEST_CHUNK = 200;

/** 批量分类的运行上下文（把 options 摊平，供下面各步共用；consecutiveFailures 为跨步累计的连续失败数） */
interface ClassifyRun {
  readonly toolId: string;
  readonly categories: ClassifyCategory[];
  readonly store: ClassifyStoreState;
  readonly post: (path: string, body: unknown) => Promise<ClassifyResponse>;
  readonly patch: (path: string, body: unknown) => Promise<unknown>;
  readonly isActive: () => boolean;
  readonly enableBreaker: boolean;
  consecutiveFailures: number;
}

/** 熔断判定：账户级门禁首次命中，或连续失败达到上限（负对照通道 enableBreaker=false 时永不熔断） */
function isTripped(run: ClassifyRun, failure: string): boolean {
  if (!run.enableBreaker) return false;
  if (isAccountGateError(failure)) return true;
  return run.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
}

/** 记一次厂商侧失败（count 条）：回填首个原因、累加连续计量，返回是否应熔断 */
function noteFailures(run: ClassifyRun, count: number, failure: string): boolean {
  run.store.fail += count;
  if (!run.store.lastError) run.store.lastError = failure;
  run.consecutiveFailures += 1;
  return isTripped(run, failure);
}

/** 标记中止并记下原因（熔断与厂商门禁共用） */
function abortRun(run: ClassifyRun, reason: string): void {
  run.store.aborted = true;
  run.store.abortReason = reason;
}

/** 命中落库：优先级只在「原优先级为普通」时跟随 AI 建议（与逐条通道同一口径），成功后计一条 */
async function applyHit(run: ClassifyRun, taskId: string, priority: string, r: ClassifyResponse): Promise<void> {
  if (!r.categoryId) return;
  const patchBody: { categoryId: string; priority?: string } = { categoryId: r.categoryId };
  if (priority === 'normal' && r.priority) patchBody.priority = r.priority;
  await run.patch(`/tasks/${taskId}`, patchBody);
  run.store.hit += 1;
}

/** 批量接口的单条结果落地；返回 false 表示已熔断，外层应停止 */
async function applyBatchItem(run: ClassifyRun, t: ClassifyTarget, r: ClassifyBatchItemResult | undefined): Promise<boolean> {
  if (!r?.ok) {
    const failure = r?.error || (r ? 'AI 调用失败' : '批量结果缺少该条');
    if (!noteFailures(run, 1, failure)) return true;
    abortRun(run, failure);
    return false;
  }
  run.consecutiveFailures = 0;
  if (!r.categoryId) { run.store.none += 1; return true; }
  await applyHit(run, t.id, t.priority, r);
  return true;
}

/** 一批内逐条落地；返回 false 表示已熔断/被外部取消，外层应停止 */
async function applyChunk(run: ClassifyRun, slice: ClassifyTarget[], resp: ClassifyBatchResponse): Promise<boolean> {
  const byId = new Map((resp.results ?? []).map((r) => [r.id, r]));
  for (const t of slice) {
    if (!run.isActive()) return false;
    if (!(await applyBatchItem(run, t, byId.get(t.id)))) return false;
  }
  return true;
}

/** 发一批请求；网络/接口异常收成失败原因（resp=null），不把异常抛到批量循环外 */
async function postChunk(run: ClassifyRun, slice: ClassifyTarget[]): Promise<{ resp: ClassifyBatchResponse | null; failure: string }> {
  try {
    const resp = await run.post('/tasks/classify-batch', {
      toolId: run.toolId, categories: run.categories, items: slice.map((t) => ({ id: t.id, title: t.title.trim() })),
    }) as ClassifyBatchResponse;
    return { resp, failure: '' };
  } catch (e) {
    return { resp: null, failure: e instanceof Error ? e.message : String(e) };
  }
}

/** T03297：批量通道——一批一次往返，服务端内部再分批调用模型 */
async function runBatchChannel(run: ClassifyRun, target: ClassifyTarget[]): Promise<void> {
  for (let start = 0; start < target.length; start += BATCH_REQUEST_CHUNK) {
    if (!run.isActive()) return;
    const slice = target.slice(start, start + BATCH_REQUEST_CHUNK);
    const { resp, failure: callFailure } = await postChunk(run, slice);
    if (!resp?.ok) {
      // 整批失败：逐条计失败（收尾口径不变），熔断只看本批一次
      const failure = callFailure || resp?.error || 'AI 调用失败';
      if (!noteFailures(run, slice.length, failure)) continue;
      abortRun(run, failure);
      return;
    }
    if (!(await applyChunk(run, slice, resp))) return;
    if (resp.gated) {
      abortRun(run, resp.error || run.store.lastError || '厂商额度/限流');
      return;
    }
    if (run.store.aborted) return;
  }
}

/** 逐条通道的单条处理；返回 false 表示应中止整个循环 */
async function classifyOne(run: ClassifyRun, t: ClassifyTarget): Promise<boolean> {
  let failure = '';
  try {
    const r = await run.post('/tasks/classify', { title: t.title.trim(), toolId: run.toolId, categories: run.categories });
    if (r.ok) {
      if (r.categoryId) {
        await applyHit(run, t.id, t.priority, r);
      } else {
        run.store.none += 1;
      }
      run.consecutiveFailures = 0;
      return true;
    }
    failure = r.error || 'AI 调用失败';
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  if (!noteFailures(run, 1, failure)) return true;
  abortRun(run, failure);
  return false;
}

export async function runClassifyBatch(opts: RunClassifyBatchOptions): Promise<void> {
  const { target, store, isActive } = opts;
  const run: ClassifyRun = {
    toolId: opts.toolId,
    categories: opts.categories,
    store,
    post: opts.post,
    patch: opts.patch,
    isActive,
    enableBreaker: opts.enableBreaker !== false,
    consecutiveFailures: 0,
  };
  store.hit = 0; store.total = target.length; store.done = false;
  store.none = 0; store.fail = 0; store.lastError = '';
  store.aborted = false; store.abortReason = '';
  try {
    if (opts.batch) {
      await runBatchChannel(run, target);
    } else {
      for (const t of target) {
        if (!isActive()) break;
        if (!(await classifyOne(run, t))) break;
      }
    }
  } finally {
    store.done = true;
  }
}

export function classifySummary(s: ClassifyStoreState, includeHit = true): string {
  const parts: string[] = [];
  if (includeHit && s.hit > 0) parts.push(`成功 ${s.hit} 条`);
  if (s.none > 0) parts.push(`${s.none} 条 AI 判定无合适分类`);
  const failErrorNote = s.lastError ? `（${s.lastError.slice(0, 120)}）` : '';
  if (s.fail > 0) parts.push(`${s.fail} 条调用失败${failErrorNote}`);
  return parts.join('，');
}

export function classifyResultMessage(s: ClassifyStoreState, candidateNames: string[] = []): string {
  const rest = classifySummary(s, false);
  if (s.aborted) {
    const why = (s.abortReason || s.lastError || '未知错误').slice(0, 120);
    return `批量分类中止：${s.fail} 条厂商调用失败（${why}），已停止后续请求；请确认该厂商账户额度/限流后重试`;
  }
  const restNote = rest ? `（其余：${rest}）` : '';
  if (s.hit > 0) return `批量分类完成 ${s.hit}/${s.total} 条${restNote}`;
  if (s.fail > 0) return `批量分类未完成：${rest}`;
  return `AI 判定 ${s.total} 条任务均无合适分类（候选：${candidateNames.slice(0, 6).join('、') || '无'}）`;
}
