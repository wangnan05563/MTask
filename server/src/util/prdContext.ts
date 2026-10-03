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

/** 反查结果：命中的 PRD id 与命中路径 */
interface PrdHit {
  prdId: string;
  hitBy: PrdHitBy;
}

/** PRD 上下文截断长度；超长时保头保尾，避免撑爆提示词 */
const PRD_CONTEXT_LIMIT = 6000;

/** 解析 req_ids：脏数据/非数组一律视为无关联 */
function parseReqIds(raw: string | null | undefined): string[] {
  try {
    const a = JSON.parse(raw ?? 'null') as unknown;
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 路径一：requirementId 直挂——从其所属需求反查 prd_id */
function hitByRequirement(db: ReturnType<typeof getDb>, requirementId: string): PrdHit | null {
  const r = db.prepare('SELECT prd_id FROM prd_requirements WHERE id = ?').get(requirementId) as { prd_id: string | null } | undefined;
  return r?.prd_id ? { prdId: r.prd_id, hitBy: 'requirement' } : null;
}

/** 路径二：通过任务/计划的 req_ids 反查命中需求所属的最新一篇 PRD */
function hitByReqIds(db: ReturnType<typeof getDb>, ids: string[]): PrdHit | null {
  if (ids.length === 0) return null;
  const ph = ids.map(() => '?').join(',');
  const r = db.prepare(
    `SELECT DISTINCT prd_id FROM prd_requirements WHERE id IN (${ph}) AND prd_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1`,
  ).get(...ids) as { prd_id: string } | undefined;
  return r?.prd_id ? { prdId: r.prd_id, hitBy: 'req_ids' } : null;
}

/**
 * 路径三（T00978-P0 兜底）：显式关联缺失时按标题反查——匹配 PRD 文件名/正文含目标标题的最新一篇，
 * 避免「已导入 PRD 却反查不到」。ESCAPE 守卫标题中 % _ \ 通配符。
 */
function hitByTitle(db: ReturnType<typeof getDb>, title: string | null | undefined): PrdHit | null {
  const t = title?.trim();
  if (!t) return null;
  const like = `%${t.replaceAll(/[\\%_]/g, (c) => '\\' + c)}%`;
  const d = db.prepare(
    String.raw`SELECT id FROM prd_docs WHERE filename LIKE ? ESCAPE '\' OR content_md LIKE ? ESCAPE '\' ORDER BY updated_at DESC LIMIT 1`,
  ).get(like, like) as { id: string } | undefined;
  return d ? { prdId: d.id, hitBy: 'title' } : null;
}

/** 命中任务/计划时的行读取 + 三条命中路径按优先级串联 */
function hitByTargetRow(db: ReturnType<typeof getDb>, taskId?: string, planId?: string): PrdHit | null {
  const table = taskId ? 'tasks' : 'plan_tasks';
  // T00978-P0：一并读 title，供 req_ids 缺失时按标题兜底反查
  const row = db.prepare(`SELECT title, req_ids FROM ${table} WHERE id = ?`).get(taskId ?? planId) as { title: string | null; req_ids: string | null } | undefined;
  return hitByReqIds(db, parseReqIds(row?.req_ids)) ?? hitByTitle(db, row?.title);
}

/** 取 PRD 正文并按上限截断（保头保尾，中段标注略去字数与文档 id） */
function trimPrdContent(content: string, docId: string): string {
  if (content.length <= PRD_CONTEXT_LIMIT) return content;
  const half = Math.floor(PRD_CONTEXT_LIMIT / 2);
  return `${content.slice(0, half)}\n\n……（中段略去 ${content.length - PRD_CONTEXT_LIMIT} 字符，全文见 PRD 文档 ${docId}）……\n\n${content.slice(-half)}`;
}

/**
 * 解析目标对象关联的 PRD 原文；未关联返回 null。
 * 命中多篇取最新一篇；上下文超长时截断（保头保尾），避免撑爆提示词。
 */
export function resolvePrdContext(target: { taskId?: string; planId?: string; requirementId?: string }): PrdContext | null {
  const db = getDb();
  // M6-6.4：三级命中判定展开为显式分支（原为嵌套三元，S3358）
  let hit: PrdHit | null = null;
  if (target.requirementId) hit = hitByRequirement(db, target.requirementId);
  else if (target.taskId || target.planId) hit = hitByTargetRow(db, target.taskId, target.planId);
  if (!hit) return null;
  const doc = db.prepare('SELECT id, filename, content_md FROM prd_docs WHERE id = ?').get(hit.prdId) as { id: string; filename: string; content_md: string } | undefined;
  if (!doc) return null;
  return { prdId: doc.id, filename: doc.filename, content: trimPrdContent(doc.content_md, doc.id), hitBy: hit.hitBy };
}
