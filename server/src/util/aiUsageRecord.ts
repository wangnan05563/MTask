/**
 * T03296（G-2 覆盖率）：ai_usage 写入单源。
 *
 * 从 AIService 抽出：直连适配器的卡（PRD 生成 / 测试用例生成）原先完全不留用量，
 * 而这两个服务刻意不依赖 AIService（各自独立实现 runtimeWithModel 以避免循环依赖），
 * 故把写入下沉到 util，供其显式记一笔 card_key 用量。
 */
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/connection';
import { KIND_TO_CARD } from './aiCards';

/** AI 工具名缓存查询（用量记录用） */
function toolNameOf(toolId: string): string {
  try {
    const r = getDb().prepare('SELECT name FROM ai_tools WHERE id = ?').get(toolId) as { name: string } | undefined;
    return r?.name ?? toolId;
  } catch { return toolId; }
}

/** AI 用量记录（T00448 / PRD AI-1）：每次模型调用落一行，供「模型」页用量面板聚合展示。
 *  T03172（G-2/AI-301）：card_key 随行走——显式传卡优先，否则按 kind→卡一对一映射，
 *  通用通道（ask/ask-json/stream）无卡可归时落 unknown（历史默认值同口径，不冒充卡片维度）。 */
export function recordUsage(
  kind: string,
  toolId: string,
  model: string | undefined,
  ok: boolean,
  startedAt: number,
  contentChars = 0,
  error?: string,
  cardKey?: string,
): void {
  const resolvedCard = cardKey ?? KIND_TO_CARD[kind] ?? 'unknown';
  try {
    getDb().prepare(
      `INSERT INTO ai_usage (id, tool_id, tool_name, model, kind, ok, duration_ms, content_chars, error, created_at, card_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(uuid(), toolId, toolNameOf(toolId), model ?? '', kind, ok ? 1 : 0, Date.now() - startedAt, contentChars, (error ?? '').slice(0, 300) || null, new Date().toISOString(), resolvedCard);
  } catch { /* 用量记录失败不影响主流程 */ }
}
