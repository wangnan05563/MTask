import { getDb } from '../db/connection';
import { normalizeProductKey } from '../util/productKey';

/**
 * T04139（PRD MEM-107 / MEM-108，v1.2·F10）：产品标签维护单源。
 *
 * `product_key` 同时存在于 projects / memories / memory_review_queue，且全表无外键，
 * 因此重命名必须在**同一事务**内三表齐改，否则旧 key 的记忆会悬空、永远召回不到。
 */

export interface RenameTagResult {
  ok: boolean;
  error?: string;
  projectsUpdated: number;
  memoriesUpdated: number;
  pendingUpdated: number;
  /** new key 已存在于其它项目时为 true（merge 语义），供调用方记遥测/提示用户 */
  mergedIntoExisting: boolean;
}

/**
 * MEM-107：重命名/合并产品标签。
 * 冲突处理（F10①）：new key 已存在于其它项目时**允许合并**（两个产品的项目与记忆归到同一标签），
 * 不阻断、不产生第二行，通过 `mergedIntoExisting` 显式回报，由调用方决定是否提示/记遥测。
 */
export function renameProductTag(oldRaw: string, newRaw: string): RenameTagResult {
  const oldKey = normalizeProductKey(oldRaw);
  const newKey = normalizeProductKey(newRaw);
  const zero = { projectsUpdated: 0, memoriesUpdated: 0, pendingUpdated: 0, mergedIntoExisting: false };
  if (!oldKey) return { ok: false, error: '原标签不能为空', ...zero };
  // 清空绑定走项目编辑接口；重命名到空串会让记忆失去隔离边界，直接拒绝
  if (!newKey) return { ok: false, error: '新标签不能为空（清空绑定请走项目编辑）', ...zero };
  if (oldKey === newKey) return { ok: true, ...zero };

  const db = getDb();
  const existing = (db.prepare('SELECT COUNT(*) AS c FROM projects WHERE product_key = ?').get(newKey) as { c: number }).c;
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const p = db.prepare('UPDATE projects SET product_key = ?, updated_at = ? WHERE product_key = ?').run(newKey, now, oldKey);
    const m = db.prepare('UPDATE memories SET product_key = ?, updated_at = ? WHERE product_key = ?').run(newKey, now, oldKey);
    const q = db.prepare('UPDATE memory_review_queue SET product_key = ? WHERE product_key = ?').run(newKey, oldKey);
    return { projectsUpdated: p.changes, memoriesUpdated: m.changes, pendingUpdated: q.changes };
  });
  const changed = tx();
  return { ok: true, ...changed, mergedIntoExisting: existing > 0 };
}

export interface OrphanTag {
  productKey: string;
  memoryCount: number;
}

/**
 * MEM-108：列出「已无项目引用但仍有记忆」的产品标签。
 * 与 MEM-105 的联合场景（F10②）：删项目后其记忆已降级为 product_id=NULL，
 * 只要该 product_key 再无其它项目，本查询立即可见，管理页即可提供清理/挂回入口。
 */
export function listOrphanProductTags(): OrphanTag[] {
  return getDb().prepare(`
    SELECT m.product_key AS productKey, COUNT(*) AS memoryCount
    FROM memories m
    WHERE m.product_key <> ''
      AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.product_key = m.product_key)
    GROUP BY m.product_key
    ORDER BY m.product_key
  `).all() as OrphanTag[];
}

/** 删除孤立标签下的全部记忆（含待确认队列候选）。**仅对确为孤立的标签放行**，防误删在用产品数据。 */
export function deleteOrphanTagMemories(productRaw: string): { ok: boolean; deleted: number; error?: string } {
  const key = normalizeProductKey(productRaw);
  const db = getDb();
  if (!key) return { ok: false, deleted: 0, error: '标签不能为空' };
  if (db.prepare('SELECT 1 FROM projects WHERE product_key = ? LIMIT 1').get(key)) {
    return { ok: false, deleted: 0, error: '该标签仍被项目引用，拒绝删除' };
  }
  const tx = db.transaction(() => {
    const r = db.prepare('DELETE FROM memories WHERE product_key = ?').run(key);
    db.prepare('DELETE FROM memory_review_queue WHERE product_key = ?').run(key);
    return r.changes;
  });
  return { ok: true, deleted: tx() };
}

/**
 * 把孤立标签挂回某项目：项目绑定该标签，记忆保持产品级共享（project_id 不变），
 * 挂回后该标签不再是孤儿。目标项目已绑其它标签时拒绝，避免一次操作把两个产品合并。
 */
export function reattachOrphanTag(
  productRaw: string,
  projectId: string,
): { ok: boolean; error?: string } {
  const key = normalizeProductKey(productRaw);
  const db = getDb();
  if (!key || !projectId) return { ok: false, error: '标签与项目 id 均不能为空' };
  const proj = db.prepare('SELECT product_key FROM projects WHERE id = ?').get(projectId) as
    | { product_key: string | null }
    | undefined;
  if (!proj) return { ok: false, error: `项目 id 不存在：${projectId}` };
  if (proj.product_key && proj.product_key !== key) {
    return { ok: false, error: '目标项目已绑定其它产品标签，拒绝挂回' };
  }
  db.prepare('UPDATE projects SET product_key = ?, updated_at = ? WHERE id = ?')
    .run(key, new Date().toISOString(), projectId);
  return { ok: true };
}
