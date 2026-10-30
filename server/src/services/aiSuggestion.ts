/**
 * T03256（AI-203②③）：AI 建议台账——shown → accepted/dismissed/timeout 单向一次，
 * 采纳率分母固定为「已展示数」（不是 accepted+dismissed，否则超时未处理的建议会被悄悄剔出分母）。
 * 开关存 app_settings：关闭后新建议不再生成、也不再记 shown。
 */
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/connection';
import { getSetting, setSetting } from './AppSettings';

export type SuggestionEvent = 'accepted' | 'dismissed' | 'timeout';
export const SUGGESTION_ENABLED_KEY = 'ai.suggestions.enabled';

export interface SuggestionRow {
  suggestion_id: string;
  card_key: string;
  project_id: string | null;
  task_id: string | null;
  category_id: string | null;
  priority: string | null;
  reason: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface SuggestionStats {
  shown: number;
  accepted: number;
  dismissed: number;
  timeout: number;
  /** 采纳率 = accepted / shown（shown 为 0 时为 null，不臆造 0%） */
  adoptionRate: number | null;
}

const EVENTS: readonly SuggestionEvent[] = ['accepted', 'dismissed', 'timeout'];

export function suggestionsEnabled(): boolean {
  return getSetting(SUGGESTION_ENABLED_KEY) !== '0';
}

export function setSuggestionsEnabled(enabled: boolean): boolean {
  setSetting(SUGGESTION_ENABLED_KEY, enabled ? '1' : '0');
  return enabled;
}

/** 记录一条已展示建议；返回 suggestion_id（调用方原样回传给前端） */
export function recordShown(input: {
  cardKey: string;
  projectId?: string | null;
  taskId?: string | null;
  categoryId?: string | null;
  priority?: string | null;
  reason?: string | null;
}): string {
  const id = uuid();
  const t = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO ai_suggestions (suggestion_id, card_key, project_id, task_id, category_id, priority, reason, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,'shown',?,?)`,
  ).run(id, input.cardKey, input.projectId ?? null, input.taskId ?? null, input.categoryId ?? null, input.priority ?? null, input.reason ?? null, t, t);
  return id;
}

/**
 * 状态流转：只允许 shown → 终态一次。
 * 重复上报（网络重试/双击）返回当前终态而不是报错；已终态不会被后到的另一事件改写。
 */
export function markStatus(suggestionId: string, event: string): { ok: boolean; status?: string; error?: string } {
  if (!(EVENTS as readonly string[]).includes(event)) return { ok: false, error: `不支持的事件：${event}` };
  const db = getDb();
  const row = db.prepare('SELECT status FROM ai_suggestions WHERE suggestion_id = ?').get(suggestionId) as { status: string } | undefined;
  if (!row) return { ok: false, error: '建议不存在' };
  if (row.status !== 'shown') return { ok: true, status: row.status };
  db.prepare('UPDATE ai_suggestions SET status = ?, updated_at = ? WHERE suggestion_id = ? AND status = ?')
    .run(event, new Date().toISOString(), suggestionId, 'shown');
  const now = db.prepare('SELECT status FROM ai_suggestions WHERE suggestion_id = ?').get(suggestionId) as { status: string };
  return { ok: true, status: now.status };
}

export function suggestionStats(filter: { cardKey?: string | null; projectId?: string | null } = {}): SuggestionStats {
  const where: string[] = [];
  const values: string[] = [];
  if (filter.cardKey) { where.push('card_key = ?'); values.push(filter.cardKey); }
  if (filter.projectId) { where.push('project_id = ?'); values.push(filter.projectId); }
  const whereClause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const rows = getDb().prepare(
    `SELECT status, COUNT(*) AS n FROM ai_suggestions${whereClause} GROUP BY status`,
  ).all(...values) as Array<{ status: string; n: number }>;
  const count = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  const shown = count('shown') + count('accepted') + count('dismissed') + count('timeout');
  const accepted = count('accepted');
  return {
    shown,
    accepted,
    dismissed: count('dismissed'),
    timeout: count('timeout'),
    adoptionRate: shown > 0 ? Number((accepted / shown).toFixed(4)) : null,
  };
}
