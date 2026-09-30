/**
 * T00763：PRD 上下文解析（独立 util，避免 AIService ↔ PlanService 循环依赖）。
 * 按任务/计划/需求 id 反查关联的 PRD 原文：req_ids → prd_requirements.prd_id → prd_docs。
 */
import { getDb } from '../db/connection';

export type PrdHitBy = 'requirement' | 'req_ids' | 'title';

export interface PrdContext {
  prdId: string;
  filename: string;
  content: string;
  /** T00978-P1：本次反查命中的路径（requirement=reqId 直挂；req_ids=任务/计划显式关联；title=标题兜底）。
   *  供审计 / MCP 排查「为何命中这篇 PRD」，避免标题兜底误命中难追溯。 */
  hitBy: PrdHitBy;
}

/**
 * 解析目标对象关联的 PRD 原文；未关联返回 null。
 * 命中多篇取最新一篇；上下文超长时截断（保头保尾），避免撑爆提示词。
 */
export function resolvePrdContext(target: { taskId?: string; planId?: string; requirementId?: string }): PrdContext | null {
  const PRD_CONTEXT_LIMIT = 6000;
  const db = getDb();
  let prdId: string | undefined;
  let hitBy: PrdHitBy | undefined;
  if (target.requirementId) {
    const r = db.prepare('SELECT prd_id FROM prd_requirements WHERE id = ?').get(target.requirementId) as { prd_id: string | null } | undefined;
    if (r?.prd_id) { prdId = r.prd_id; hitBy = 'requirement'; }
  } else if (target.taskId || target.planId) {
    const table = target.taskId ? 'tasks' : 'plan_tasks';
    const id = target.taskId ?? target.planId;
    // T00978-P0：一并读 title，供 req_ids 缺失时按标题兜底反查
    const row = db.prepare(`SELECT title, req_ids FROM ${table} WHERE id = ?`).get(id) as { title: string | null; req_ids: string | null } | undefined;
    const ids: string[] = (() => {
      try { const a = JSON.parse(row?.req_ids ?? 'null') as unknown; return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
    })();
    if (ids.length > 0) {
      const ph = ids.map(() => '?').join(',');
      const r = db.prepare(
        `SELECT DISTINCT prd_id FROM prd_requirements WHERE id IN (${ph}) AND prd_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1`,
      ).get(...ids) as { prd_id: string } | undefined;
      if (r?.prd_id) { prdId = r.prd_id; hitBy = 'req_ids'; }
    }
    // T00978-P0：显式关联缺失（无 req_ids 或关联需求未挂 PRD）时回落到标题兜底，
    // 匹配 PRD 文件名/正文含目标任务标题的最新一篇，避免「已导入 PRD 却反查不到」。
    // 命中路径以 hitBy='title' 标注，便于审计误命中；ESCAPE 守卫标题中 % _ \ 通配符。
    if (!prdId && row?.title?.trim()) {
      const esc = (s: string) => s.replaceAll(/[\\%_]/g, (c) => '\\' + c);
      const like = `%${esc(row.title.trim())}%`;
      const d = db.prepare(
        String.raw`SELECT id FROM prd_docs WHERE filename LIKE ? ESCAPE '\' OR content_md LIKE ? ESCAPE '\' ORDER BY updated_at DESC LIMIT 1`,
      ).get(like, like) as { id: string } | undefined;
      if (d) { prdId = d.id; hitBy = 'title'; }
    }
  }
  if (!prdId || !hitBy) return null;
  const doc = db.prepare('SELECT id, filename, content_md FROM prd_docs WHERE id = ?').get(prdId) as { id: string; filename: string; content_md: string } | undefined;
  if (!doc) return null;
  let content = doc.content_md;
  if (content.length > PRD_CONTEXT_LIMIT) {
    const half = Math.floor(PRD_CONTEXT_LIMIT / 2);
    content = `${content.slice(0, half)}\n\n……（中段略去 ${content.length - PRD_CONTEXT_LIMIT} 字符，全文见 PRD 文档 ${doc.id}）……\n\n${content.slice(-half)}`;
  }
  return { prdId: doc.id, filename: doc.filename, content, hitBy };
}
