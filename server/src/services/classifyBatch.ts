/**
 * T03297：批量分类的分批调用与结果合并（纯逻辑，模型调用由调用方注入）。
 *
 * 逐条调用在任务量大时会打满厂商限流，且每条都要一次网络往返；这里按批切分、每批一次模型调用，
 * 再按输入序号合并回原顺序。约束：
 *  - 批次之间不重叠、不遗漏（切分按连续下标，合并按原 index 落位）；
 *  - 分类口径与单条 `AIService.classifyCategory` 完全一致：精确名优先，其次最长名称包含；
 *  - 单批失败重试一次，仍失败且批内多于一条时对半拆分递归（直到单条），单条失败如实回 ok:false；
 *  - 账户级门禁（额度/限流/402/429）不拆不重试——重试必然同样失败，直接标记 gated 让上层熔断；
 *  - 并发上限默认 2（可调 1~4），避免多批同时压厂商。
 */

export interface BatchItem {
  id: string;
  title: string;
}

export interface BatchCategory {
  id: string;
  name: string;
}

export type BatchPriority = 'urgent' | 'high' | 'normal' | 'low';

export interface BatchOutcome {
  id: string;
  ok: boolean;
  categoryId: string | null;
  priority: BatchPriority | null;
  error?: string;
}

export interface BatchChatResult {
  ok: boolean;
  content?: string;
  error?: string;
}

export type BatchChat = (system: string, user: string) => Promise<BatchChatResult>;

export const BATCH_DEFAULT_SIZE = 20;
export const BATCH_MAX_SIZE = 50;
export const BATCH_DEFAULT_CONCURRENCY = 2;

const GATE_RE = /(rate\s*limit|insufficient|quota|额度|限流|\b402\b|\b429\b)/i;
const PRIORITY_MAP: Record<string, BatchPriority> = { U: 'urgent', H: 'high', N: 'normal', L: 'low' };

export function isAccountGateMessage(message: string): boolean {
  return GATE_RE.test(message);
}

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** 连续下标切分：不重叠、不遗漏，顺序保持 */
export function chunkItems<T>(items: readonly T[], size: number): T[][] {
  const step = clampInt(size, 1, BATCH_MAX_SIZE, BATCH_DEFAULT_SIZE);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

/** 与单条分类同一匹配口径：精确优先，其次最长名称包含（避免「开发/开发优化」误配到较短分类） */
export function matchCategory(nameOut: string, categories: readonly BatchCategory[]): BatchCategory | undefined {
  const name = nameOut.trim();
  if (!name || name.toUpperCase() === 'NONE') return undefined;
  return categories.find((c) => c.name.trim() === name)
    ?? [...categories].sort((a, b) => b.name.length - a.name.length).find((c) => name.includes(c.name));
}

const SYSTEM = '你是任务智能分类助手。给定一批带序号的任务标题和候选分类名，为每条任务选出最贴切的一个分类，并按紧急重要程度标注优先级（U=极高、H=高、N=普通、L=低）。每条任务只输出一行：序号|分类名|优先级字母；序号与输入序号一致，不加任何解释；分类都不合适时分类名写 NONE。';

function buildUser(items: readonly BatchItem[], categories: readonly BatchCategory[]): string {
  return [
    `候选分类：${categories.length ? categories.map((c) => c.name).join('、') : '（无，分类写 NONE）'}`,
    '任务：',
    ...items.map((t, i) => `${i + 1}. ${t.title}`),
  ].join('\n');
}

/**
 * 解析一批回复。优先按行首序号落位（模型漏行/调序也不会错配），
 * 没有序号时仅在行数与批大小一致时按顺序落位；其余情况该位为 null（交由重试/拆分）。
 */
export function parseBatchReply(
  raw: string,
  count: number,
  categories: readonly BatchCategory[],
): Array<{ categoryId: string | null; priority: BatchPriority | null } | null> {
  const out: Array<{ categoryId: string | null; priority: BatchPriority | null } | null> = new Array(count).fill(null);
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const numbered = lines
    .map((line) => /^(\d+)\s*[.、:：|｜]\s*(.+)$/.exec(line))
    .filter((m): m is RegExpExecArray => !!m);

  const fill = (index: number, payload: string) => {
    const parts = payload.split(/[|｜]/).map((p) => p.trim());
    const nameOut = parts[0] ?? '';
    const letter = (parts[1] ?? '').replaceAll(/[^A-Za-z]/g, '').toUpperCase();
    const priority = PRIORITY_MAP[letter] ?? null;
    const hit = matchCategory(nameOut, categories);
    // 模型明确写 NONE → 无匹配（priority 照单保留）；名字对不上任何候选也按无匹配，绝不猜
    out[index] = { categoryId: hit?.id ?? null, priority };
  };

  if (numbered.length > 0) {
    for (const m of numbered) {
      const index = Number(m[1]) - 1;
      if (index >= 0 && index < count) fill(index, m[2]);
    }
  } else if (lines.length === count) {
    lines.forEach((line, i) => fill(i, line));
  }
  return out;
}

export interface ClassifyItemsInput {
  items: readonly BatchItem[];
  categories: readonly BatchCategory[];
  chat: BatchChat;
  batchSize?: unknown;
  concurrency?: unknown;
}

export interface ClassifyItemsResult {
  ok: true;
  results: BatchOutcome[];
  calls: number;
  batches: number;
  /** 账户级门禁命中并中止后续批次（上层应熔断） */
  gated: boolean;
  error?: string;
}

export async function classifyItems(input: ClassifyItemsInput): Promise<ClassifyItemsResult> {
  const items = input.items.map((it, index) => ({ id: String(it.id), title: String(it.title ?? '').trim(), index }));
  const results: BatchOutcome[] = items.map((it) => ({ id: it.id, ok: false, categoryId: null, priority: null }));
  const size = clampInt(input.batchSize, 1, BATCH_MAX_SIZE, BATCH_DEFAULT_SIZE);
  const concurrency = clampInt(input.concurrency, 1, 4, BATCH_DEFAULT_CONCURRENCY);
  const chunks = chunkItems(items, size);
  let calls = 0;
  let batches = 0;
  let gated = false;
  let gateError = '';

  const runChunk = async (chunk: typeof items): Promise<void> => {
    let pending = chunk;
    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (gated || pending.length === 0) return;
      const r = await input.chat(SYSTEM, buildUser(pending, input.categories));
      calls += 1;
      if (!r.ok) {
        lastError = r.error || 'AI 调用失败';
        if (isAccountGateMessage(lastError)) {
          gated = true;
          gateError = lastError;
          break;
        }
        continue;
      }
      const parsed = parseBatchReply(r.content ?? '', pending.length, input.categories);
      const unresolved: typeof items = [];
      parsed.forEach((p, i) => {
        const item = pending[i];
        if (!p) { unresolved.push(item); return; }
        results[item.index] = { id: item.id, ok: true, categoryId: p.categoryId, priority: p.priority };
      });
      if (unresolved.length === 0) return;
      pending = unresolved;
      lastError = `${unresolved.length} 条未解析出分类`;
    }
    if (gated) {
      for (const item of pending) results[item.index] = { id: item.id, ok: false, categoryId: null, priority: null, error: gateError };
      return;
    }
    if (pending.length > 1) {
      const mid = Math.ceil(pending.length / 2);
      await runChunk(pending.slice(0, mid));
      await runChunk(pending.slice(mid));
      return;
    }
    for (const item of pending) results[item.index] = { id: item.id, ok: false, categoryId: null, priority: null, error: lastError || 'AI 调用失败' };
  };

  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, chunks.length) }, async () => {
    while (!gated) {
      const index = next;
      next += 1;
      if (index >= chunks.length) return;
      batches += 1;
      await runChunk(chunks[index]);
    }
  });
  await Promise.all(workers);

  if (gated) {
    // 门禁发生在中途时，尚未派发的批次与未落位的条目都要带上同一原因，不能冒充「无匹配」
    for (const item of results) if (!item.ok && !item.error) item.error = gateError;
  }
  return { ok: true, results, calls, batches, gated, ...(gated ? { error: gateError } : {}) };
}
