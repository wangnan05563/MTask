import { getDb } from '../db/connection';
import { normalizeProductKey } from './productKey';
import type { MemoryType } from './memoryTypes'; // T04140：四型分类单源，不再就地重复定义
export type { MemoryType } from './memoryTypes';

/**
 * T04137（PRD MEM-109 / MEM-209 / §5，v1.2·F1）：PII 敏感候选拦截与待确认队列。
 *
 * 命中「个人敏感」类（身份证/手机号/银行卡/住址）时：**不入库 memories、不静默丢弃**，
 * 而是写入 `memory_review_queue` 待人工确认；用户确认后转 ADD 入 memories 并删队列行，
 * 驳回则直接删队列行。C1 never-store 的完整黑名单属 T04144 范围，本模块只承担 PII 分流。
 */

export type PiiKind = 'id' | 'phone' | 'bank' | 'address';
export type MemorySourceKind = 'auto' | 'manual' | 'user_said' | 'tool_output' | 'inferred';

// 顺序敏感：18 位身份证须先于银行卡（16~19 位）判定，否则会被误归为 bank
const PII_RULES: { kind: PiiKind; re: RegExp }[] = [
  { kind: 'id', re: /(?<!\d)\d{17}[\dXx](?!\d)/ },
  { kind: 'phone', re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { kind: 'bank', re: /(?<!\d)[1-9]\d{15,18}(?!\d)/ },
  { kind: 'address', re: /(?:[\u4e00-\u9fa5]{2,}(?:省|市|区|县|镇|街道)){1,3}[^\s，。]{0,20}?(?:\d+\s*(?:号|栋|单元|室)|(?:路|街|巷)\s*\d+\s*号?)/ },
];

/** 返回命中的敏感类型；未命中返回 null（调用方按正常 ADD 流程处理）。 */
export function detectPiiKind(text: string): PiiKind | null {
  for (const rule of PII_RULES) if (rule.re.test(text)) return rule.kind;
  return null;
}

export interface PendingCandidate {
  id: string;
  productKey: string;
  projectId?: string | null;
  title: string;
  content: string;
  type: MemoryType;
  sourceTaskId?: string | null;
  sourceKind?: MemorySourceKind;
  confidence?: number | null;
}

export type GuardResult =
  | { action: 'store' }
  | { action: 'queue'; piiKind: PiiKind; pendingId: string };

/** 抽取/手动录入落库前的统一守卫：疑似敏感 → 入待确认队列，绝不写 memories。 */
export function guardMemoryCandidate(c: PendingCandidate): GuardResult {
  const piiKind = detectPiiKind(`${c.title}\n${c.content}`);
  if (!piiKind) return { action: 'store' };
  getDb().prepare(`INSERT INTO memory_review_queue
    (id,product_key,project_id,title,content,type,pii_kind,source_task_id,source_kind,confidence,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    c.id, normalizeProductKey(c.productKey), c.projectId ?? null, c.title, c.content,
    c.type, piiKind, c.sourceTaskId ?? null, c.sourceKind ?? 'auto', c.confidence ?? null,
    new Date().toISOString(),
  );
  return { action: 'queue', piiKind, pendingId: c.id };
}

/**
 * 人工确认/驳回。确认：转 ADD 入 memories 后删队列行；驳回：只删队列行。
 * 两步在同一事务内，避免「入库成功但队列残留」或「队列删了但记忆没进」的中间态。
 */
export function resolvePendingMemory(
  pendingId: string,
  action: 'confirm' | 'reject',
): { ok: boolean; reason?: string } {
  const db = getDb();
  const row = db.prepare('SELECT * FROM memory_review_queue WHERE id = ?').get(pendingId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return { ok: false, reason: '待确认项不存在' };
  const tx = db.transaction(() => {
    if (action === 'reject') {
      db.prepare('DELETE FROM memory_review_queue WHERE id = ?').run(pendingId);
      return;
    }
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO memories
      (id,product_key,project_id,type,title,content,source_task_id,source_kind,confidence,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.id, row.product_key, row.project_id ?? null, row.type, row.title, row.content,
      row.source_task_id ?? null, row.source_kind ?? 'auto', row.confidence ?? null, now, now,
    );
    db.prepare('DELETE FROM memory_review_queue WHERE id = ?').run(pendingId);
  });
  tx();
  return { ok: true };
}
