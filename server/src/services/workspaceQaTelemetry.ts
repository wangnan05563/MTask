/**
 * T03252（PRD 5.3）：工作空间问答埋点。
 *
 * 三类事件同表 `workspace_qa_events`（ask / citation_click / feedback），统计一律现算，
 * 不维护计数器——计数器与明细双写迟早不一致，而这张表的数据量（单项目问答）不值得做预聚合。
 *
 * 口径：
 *  - 提问数 asks = kind='ask' 的行数（只统计已绑定工作空间、真正进入检索的提问）；
 *  - 回答成功率 = 有可核验引用（ok=1 且 cited=1）的提问 / asks；
 *  - 引用点击率 = 至少点过一次引用的提问（citation_click 按 event_id 去重）/ 有引用的回答数；
 *  - 有用/无用 = feedback 行数，一个提问只保留最后一次反馈（同一 event_id 覆盖）。
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection';

export interface QaStats {
  asks: number;
  answered: number;
  successRate: number;
  citationClicks: number;
  citationRate: number;
  useful: number;
  useless: number;
}

interface AskEventInput {
  projectId: string;
  ok: boolean;
  cited: boolean;
  truncated: boolean;
  contextChars: number;
  questionLen: number;
}

const nowIso = () => new Date().toISOString();

export function recordAsk(input: AskEventInput): string {
  const id = randomUUID();
  try {
    getDb().prepare(
      `INSERT INTO workspace_qa_events (id, project_id, kind, ok, cited, truncated, context_chars, question_len, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(id, input.projectId, 'ask', input.ok ? 1 : 0, input.cited ? 1 : 0, input.truncated ? 1 : 0, input.contextChars, input.questionLen, nowIso());
  } catch { /* 埋点失败不能影响问答本身 */ }
  return id;
}

export function recordCitationClick(input: { projectId: string; eventId: string; path: string; line: number }): void {
  try {
    getDb().prepare(
      `INSERT INTO workspace_qa_events (id, project_id, kind, event_id, ok, cited, path, line, created_at)
       VALUES (?,?,?,?,0,0,?,?,?)`,
    ).run(randomUUID(), input.projectId, 'citation_click', input.eventId, input.path, input.line, nowIso());
  } catch { /* 同上 */ }
}

/** 返回 false 表示 eventId 不存在（不写孤儿反馈），路由据此回 404 */
export function recordFeedback(input: { projectId: string; eventId: string; useful: boolean }): boolean {
  const db = getDb();
  const ask = db.prepare(`SELECT id FROM workspace_qa_events WHERE id = ? AND project_id = ? AND kind = 'ask'`).get(input.eventId, input.projectId);
  if (!ask) return false;
  const useful = input.useful ? 1 : 0;
  const existing = db.prepare(`SELECT id FROM workspace_qa_events WHERE kind = 'feedback' AND event_id = ?`).get(input.eventId) as { id: string } | undefined;
  if (existing) {
    db.prepare(`UPDATE workspace_qa_events SET useful = ?, created_at = ? WHERE id = ?`).run(useful, nowIso(), existing.id);
  } else {
    db.prepare(
      `INSERT INTO workspace_qa_events (id, project_id, kind, event_id, ok, cited, useful, created_at)
       VALUES (?,?,?,?,0,0,?,?)`,
    ).run(randomUUID(), input.projectId, 'feedback', input.eventId, useful, nowIso());
  }
  return true;
}

export function qaStats(projectId: string): QaStats {
  const db = getDb();
  const asks = (db.prepare(`SELECT COUNT(*) AS n FROM workspace_qa_events WHERE project_id = ? AND kind = 'ask'`).get(projectId) as { n: number }).n;
  const answered = (db.prepare(`SELECT COUNT(*) AS n FROM workspace_qa_events WHERE project_id = ? AND kind = 'ask' AND ok = 1 AND cited = 1`).get(projectId) as { n: number }).n;
  const citationClicks = (db.prepare(`SELECT COUNT(DISTINCT event_id) AS n FROM workspace_qa_events WHERE project_id = ? AND kind = 'citation_click'`).get(projectId) as { n: number }).n;
  const fb = db.prepare(
    `SELECT SUM(CASE WHEN useful = 1 THEN 1 ELSE 0 END) AS useful,
            SUM(CASE WHEN useful = 0 THEN 1 ELSE 0 END) AS useless
     FROM workspace_qa_events WHERE project_id = ? AND kind = 'feedback'`,
  ).get(projectId) as { useful: number | null; useless: number | null };
  return {
    asks,
    answered,
    successRate: asks > 0 ? answered / asks : 0,
    citationClicks,
    citationRate: answered > 0 ? citationClicks / answered : 0,
    useful: fb.useful ?? 0,
    useless: fb.useless ?? 0,
  };
}
