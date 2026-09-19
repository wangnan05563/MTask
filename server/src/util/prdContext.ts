/**
 * T00763：PRD 上下文解析（独立 util，避免 AIService ↔ PlanService 循环依赖）。
 * 按任务/计划/需求 id 反查关联的 PRD 原文：req_ids → prd_requirements.prd_id → prd_docs。
 */
import { getDb } from '../db/connection';

export interface PrdContext { prdId: string; filename: string; content: string }

/**
 * 解析目标对象关联的 PRD 原文；未关联返回 null。
 * 命中多篇取最新一篇；上下文超长时截断（保头保尾），避免撑爆提示词。
 */
export function resolvePrdContext(target: { taskId?: string; planId?: string; requirementId?: string }): PrdContext | null {
  const PRD_CONTEXT_LIMIT = 6000;
  const db = getDb();
  let prdId: string | undefined;
  if (target.requirementId) {
    const r = db.prepare('SELECT prd_id FROM prd_requirements WHERE id = ?').get(target.requirementId) as { prd_id: string | null } | undefined;
    prdId = r?.prd_id ?? undefined;
  } else {
    const table = target.taskId ? 'tasks' : 'plan_tasks';
    const id = target.taskId ?? target.planId;
    if (!id) return null;
    const row = db.prepare(`SELECT req_ids FROM ${table} WHERE id = ?`).get(id) as { req_ids: string | null } | undefined;
    const ids: string[] = (() => {
      try { const a = JSON.parse(row?.req_ids ?? 'null') as unknown; return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
    })();
    if (ids.length === 0) return null;
    const ph = ids.map(() => '?').join(',');
    const r = db.prepare(
      `SELECT DISTINCT prd_id FROM prd_requirements WHERE id IN (${ph}) AND prd_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1`,
    ).get(...ids) as { prd_id: string } | undefined;
    prdId = r?.prd_id;
  }
  if (!prdId) return null;
  const doc = db.prepare('SELECT id, filename, content_md FROM prd_docs WHERE id = ?').get(prdId) as { id: string; filename: string; content_md: string } | undefined;
  if (!doc) return null;
  let content = doc.content_md;
  if (content.length > PRD_CONTEXT_LIMIT) {
    const half = Math.floor(PRD_CONTEXT_LIMIT / 2);
    content = `${content.slice(0, half)}\n\n……（中段略去 ${content.length - PRD_CONTEXT_LIMIT} 字符，全文见 PRD 文档 ${doc.id}）……\n\n${content.slice(-half)}`;
  }
  return { prdId: doc.id, filename: doc.filename, content };
}
