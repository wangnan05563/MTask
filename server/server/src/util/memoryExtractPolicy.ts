import { normalizeProductKey } from './productKey';

/**
 * T04146（PRD MEM-204 / MEM-205 / MEM-207）：抽取前置判定单源。
 *
 * 开关、产品绑定、幂等三类跳过原因原先散落在 MemoryService 的 if 分支里；
 * 收口成纯函数后，每类原因可被门脚本逐一断言，也不会在后续改造中被悄悄改掉。
 *
 * **MEM-205 归档解耦（关键口径）**：`archived` / `history_at` 由调用方带出但
 * **刻意不参与判定**——归档/沉淀项目的任务结论若被回传，仍可抽取记忆；
 * 记忆的可见性取决于 `product_key`，与项目当前是否处于现行态无关。
 * 后续维护者不得在此处加 `archived = 0` 之类的过滤。
 */

export interface ExtractProjectState {
  product_key: string | null;
  memory_auto_extract: number;
  /** 仅用于说明 MEM-205 解耦口径，判定逻辑不读这两个字段 */
  archived?: number | null;
  history_at?: string | null;
}

export type SkipReason = 'no_task' | 'no_project' | 'idempotent' | 'switch_off' | 'unbound_product';
export type ExtractDecision =
  | { kind: 'extract'; productKey: string }
  | { kind: 'skip'; reason: SkipReason };

export function decideExtraction(input: {
  taskExists: boolean;
  project?: ExtractProjectState | null;
  alreadyExtracted?: boolean;
}): ExtractDecision {
  if (!input.taskExists) return { kind: 'skip', reason: 'no_task' };
  if (!input.project) return { kind: 'skip', reason: 'no_project' };
  // MEM-207：同 source_task_id 已产生记忆则跳过重抽
  if (input.alreadyExtracted) return { kind: 'skip', reason: 'idempotent' };
  // MEM-204：项目级开关关闭、未绑产品均**计遥测不静默**（由调用方按 reason 落 ai_usage）
  if (!input.project.memory_auto_extract) return { kind: 'skip', reason: 'switch_off' };
  const productKey = normalizeProductKey(input.project.product_key ?? '');
  if (!productKey) return { kind: 'skip', reason: 'unbound_product' };
  // 归档字段不参与判定：此处无任何 archived / history_at 分支，保持 MEM-205 解耦
  return { kind: 'extract', productKey };
}
