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

export async function runClassifyBatch(opts: RunClassifyBatchOptions): Promise<void> {
  const { target, toolId, categories, store, post, patch, isActive } = opts;
  const enableBreaker = opts.enableBreaker !== false;
  store.hit = 0; store.total = target.length; store.done = false;
  store.none = 0; store.fail = 0; store.lastError = '';
  store.aborted = false; store.abortReason = '';
  let consecutiveFailures = 0;
  try {
    if (opts.batch) {
      // T03297：大批量走批量接口——一批一次往返，服务端内部再分批调用模型
      for (let start = 0; start < target.length; start += BATCH_REQUEST_CHUNK) {
        if (!isActive()) break;
        const slice = target.slice(start, start + BATCH_REQUEST_CHUNK);
        let resp: ClassifyBatchResponse | null = null;
        let batchFailure = '';
        try {
          resp = await post('/tasks/classify-batch', {
            toolId, categories, items: slice.map((t) => ({ id: t.id, title: t.title.trim() })),
          }) as ClassifyBatchResponse;
        } catch (e) {
          batchFailure = e instanceof Error ? e.message : String(e);
        }
        if (!resp || !resp.ok) {
          const failure = batchFailure || resp?.error || 'AI 调用失败';
          // 整批失败：逐条计失败（收尾口径不变），熔断只看本批一次
          store.fail += slice.length;
          if (!store.lastError) store.lastError = failure;
          consecutiveFailures += 1;
          if (enableBreaker && (isAccountGateError(failure) || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES)) {
            store.aborted = true;
            store.abortReason = failure;
            break;
          }
          continue;
        }
        const byId = new Map((resp.results ?? []).map((r) => [r.id, r]));
        for (const t of slice) {
          if (!isActive()) break;
          const r = byId.get(t.id);
          if (!r || !r.ok) {
            const failure = r?.error || (r ? 'AI 调用失败' : '批量结果缺少该条');
            store.fail += 1;
            if (!store.lastError) store.lastError = failure;
            consecutiveFailures += 1;
            if (enableBreaker && (isAccountGateError(failure) || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES)) {
              store.aborted = true;
              store.abortReason = failure;
              break;
            }
            continue;
          }
          consecutiveFailures = 0;
          if (!r.categoryId) { store.none += 1; continue; }
          const patchBody: { categoryId: string; priority?: string } = { categoryId: r.categoryId };
          if (t.priority === 'normal' && r.priority) patchBody.priority = r.priority;
          await patch(`/tasks/${t.id}`, patchBody);
          store.hit += 1;
        }
        if (resp.gated) {
          store.aborted = true;
          store.abortReason = resp.error || store.lastError || '厂商额度/限流';
          break;
        }
        if (store.aborted) break;
      }
      return;
    }
    for (const t of target) {
      if (!isActive()) break;
      let failure = '';
      try {
        const r = await post('/tasks/classify', { title: t.title.trim(), toolId, categories });
        if (!r.ok) {
          failure = r.error || 'AI 调用失败';
        } else if (!r.categoryId) {
          store.none += 1;
          consecutiveFailures = 0;
          continue;
        } else {
          const patchBody: { categoryId: string; priority?: string } = { categoryId: r.categoryId };
          if (t.priority === 'normal' && r.priority) patchBody.priority = r.priority;
          await patch(`/tasks/${t.id}`, patchBody);
          store.hit += 1;
          consecutiveFailures = 0;
          continue;
        }
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
      }
      store.fail += 1;
      if (!store.lastError) store.lastError = failure;
      consecutiveFailures += 1;
      if (enableBreaker && (isAccountGateError(failure) || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES)) {
        store.aborted = true;
        store.abortReason = failure;
        break;
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
  if (s.fail > 0) parts.push(`${s.fail} 条调用失败${s.lastError ? `（${s.lastError.slice(0, 120)}）` : ''}`);
  return parts.join('，');
}

export function classifyResultMessage(s: ClassifyStoreState, candidateNames: string[] = []): string {
  const rest = classifySummary(s, false);
  if (s.aborted) {
    const why = (s.abortReason || s.lastError || '未知错误').slice(0, 120);
    return `批量分类中止：${s.fail} 条厂商调用失败（${why}），已停止后续请求；请确认该厂商账户额度/限流后重试`;
  }
  if (s.hit > 0) return `批量分类完成 ${s.hit}/${s.total} 条${rest ? `（其余：${rest}）` : ''}`;
  if (s.fail > 0) return `批量分类未完成：${rest}`;
  return `AI 判定 ${s.total} 条任务均无合适分类（候选：${candidateNames.slice(0, 6).join('、') || '无'}）`;
}
