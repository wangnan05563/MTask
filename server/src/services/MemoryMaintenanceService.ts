import { getDb } from '../db/connection';
import { recordUsage } from '../util/aiUsageRecord';
import { normalizeProductKey } from '../util/productKey';

/**
 * T04150（PRD MEM-306 / MEM-307，v1.2·F9）：记忆容量淘汰与月度整理。
 *
 * 两条都必须「软失效」而非物理删除：失效行带 `invalidated_at`，查询默认不召回，
 * 但审计链与人工复核入口都还在（规范 §7.3 / §4）。
 * 执行机制复用现有调度点（server/index.ts:283 启动 tick + 每小时 setInterval），不新建调度器；
 * 月度整理用 ai_usage 的 `memory_organize` 记录做节流判据，重启后仍能判断上次执行时间。
 */

/** MEM-306：单产品有效记忆上限（容量按 product_key 计，不含已失效行） */
export const MEMORY_CAPACITY_LIMIT = 200;
/** MEM-307：月度整理节流窗口（天） */
export const MEMORY_ORGANIZE_INTERVAL_DAYS = 30;
/** MEM-307：长期无人访问/已完结任务记忆的保留期（天），与 project 型 180 天口径一致 */
export const MEMORY_STALE_RETENTION_DAYS = 180;

const ORGANIZE_KIND = 'memory_organize';

/**
 * MEM-306：容量评估（写后/查询前调用）。超限按 access_count 最低、updated_at 最旧淘汰；
 * 只失效超出上限的部分，保证有效行恰好不超过 200。幂等：未超限返回 0。
 */
export function enforceCapacity(productKey: string, now = new Date().toISOString()): number {
  const db = getDb();
  const pk = normalizeProductKey(productKey);
  if (!pk) return 0;
  const total = (db.prepare('SELECT COUNT(*) AS c FROM memories WHERE product_key = ? AND invalidated_at IS NULL')
    .get(pk) as { c: number }).c;
  const overflow = total - MEMORY_CAPACITY_LIMIT;
  if (overflow <= 0) return 0;
  // 淘汰目标是 access_count 最低/updated_at 最旧的 overflow 条——ORDER BY 必须是 ASC + LIMIT overflow；
  // 反向写成「跳过前 200 条」会把访问最多的行淘汰掉（实测踩坑，门脚本已锁定）。
  const extra = db.prepare(`SELECT id FROM memories
    WHERE product_key = ? AND invalidated_at IS NULL
    ORDER BY access_count ASC, updated_at ASC
    LIMIT ?`).all(pk, overflow) as { id: string }[];
  if (!extra.length) return 0;
  const invalidate = db.prepare(
    'UPDATE memories SET invalidated_at = ?, superseded_by = ? WHERE id = ? AND invalidated_at IS NULL',
  );
  const tx = db.transaction(() => {
    for (const row of extra) invalidate.run(now, 'capacity-overflow', row.id);
  });
  tx();
  return extra.length;
}

export interface OrganizeResult {
  /** 近重复合并失效数 */
  deduped: number;
  /** 长期无人访问失效数 */
  stale: number;
  /** 已完结任务导出的到期记忆失效数 */
  archived: number;
}

/** 批量软失效（事务内），统一写审计原因；已失效行由 WHERE 兜住，天然幂等 */
function invalidateMany(rows: { id: string }[], reason: string, now: string): number {
  if (!rows.length) return 0;
  const db = getDb();
  const stmt = db.prepare(
    'UPDATE memories SET invalidated_at = ?, superseded_by = ? WHERE id = ? AND invalidated_at IS NULL',
  );
  const tx = db.transaction(() => {
    for (const r of rows) stmt.run(now, reason, r.id);
  });
  tx();
  return rows.length;
}

interface MemoryLite {
  id: string;
  product_key: string;
  type: string;
  title: string;
  access_count: number;
  updated_at: string;
}

/**
 * MEM-307：月度整理。三条规则全部 UPDATE/INVALIDATE，可重复执行（已失效行被 WHERE 排除）。
 * ① 近重复：同产品 + 同 type + 标题归一后完全相同 → 保留访问最多/最新的一条，其余失效并指向保留项；
 * ② 无人遵守：从未被召回（access_count=0）且超 180 天未更新；
 * ③ 已完结任务：来源任务已 done 且记忆超 180 天未更新（任务已收口，历史结论降为审计留存）。
 */
export function organizeMemories(now = new Date().toISOString()): OrganizeResult {
  const db = getDb();
  const cutoff = new Date(new Date(now).getTime() - MEMORY_STALE_RETENTION_DAYS * 86400000).toISOString();

  // ① 近重复（单产品上限 200，全量读取成本可控；按分组只保留一条）
  const active = db.prepare(`SELECT id, product_key, type, title, access_count, updated_at
    FROM memories WHERE invalidated_at IS NULL`).all() as MemoryLite[];
  const groups = new Map<string, MemoryLite[]>();
  for (const row of active) {
    const key = [row.product_key, row.type, row.title.trim().toLowerCase()].join('\u0000');
    const list = groups.get(key);
    if (list) list.push(row); else groups.set(key, [row]);
  }
  const losers: { id: string; keep: string }[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) =>
      b.access_count - a.access_count
      || b.updated_at.localeCompare(a.updated_at)
      || a.id.localeCompare(b.id));
    const keep = sorted[0].id;
    for (const row of sorted.slice(1)) losers.push({ id: row.id, keep });
  }
  let deduped = 0;
  if (losers.length) {
    const stmt = db.prepare(
      'UPDATE memories SET invalidated_at = ?, superseded_by = ? WHERE id = ? AND invalidated_at IS NULL',
    );
    const tx = db.transaction(() => {
      for (const r of losers) deduped += stmt.run(now, r.keep, r.id).changes;
    });
    tx();
  }

  const stale = invalidateMany(
    db.prepare('SELECT id FROM memories WHERE invalidated_at IS NULL AND access_count = 0 AND updated_at < ?')
      .all(cutoff) as { id: string }[], 'organize:stale', now,
  );
  const archived = invalidateMany(
    db.prepare(`SELECT m.id FROM memories m
      JOIN tasks t ON t.id = m.source_task_id
      WHERE m.invalidated_at IS NULL AND t.status = 'done' AND m.updated_at < ?`)
      .all(cutoff) as { id: string }[], 'organize:task-archived', now,
  );
  return { deduped, stale, archived };
}

/** 上次整理时间：取 memory_organize 遥测的最新一条（放在 ai_usage 里，重启后仍可判） */
function lastOrganizeAt(): string | null {
  const row = getDb().prepare(
    'SELECT created_at FROM ai_usage WHERE kind = ? ORDER BY created_at DESC LIMIT 1',
  ).get(ORGANIZE_KIND) as { created_at: string } | undefined;
  return row?.created_at ?? null;
}

/**
 * MEM-307 调度入口：由 index.ts 的启动 tick + 每小时 tick 调用。
 * 距上次整理不足 30 天直接跳过（无 DB 写入）；到期才执行并记一条遥测。
 */
export function maybeOrganizeMemories(now = new Date().toISOString()): { ran: boolean; result?: OrganizeResult } {
  const last = lastOrganizeAt();
  if (last && new Date(now).getTime() - new Date(last).getTime() < MEMORY_ORGANIZE_INTERVAL_DAYS * 86400000) {
    return { ran: false };
  }
  const result = organizeMemories(now);
  try {
    recordUsage({
      kind: ORGANIZE_KIND, toolId: '', ok: true, startedAt: Date.now(),
      cardKey: ORGANIZE_KIND, stage: `deduped=${result.deduped},stale=${result.stale},archived=${result.archived}`,
    });
  } catch { /* 遥测失败不影响整理结果 */ }
  return { ran: true, result };
}
