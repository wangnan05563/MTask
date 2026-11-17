/**
 * T03262（PRD AI-101 ①③④）：AI 卡溯源与产物找回的通用件。
 *
 * 报表卡（`reportProvenance`）的溯源行是「按 ReportData 字段定死」的，其他卡没有 ReportData：
 * 它们的来源是 PRD 字数、需求条数、模块数、Git 提交数这种「调用方自己数出来的」量。
 * 这里只定**行结构与文案口径**（标签 + 值），行数由各卡自己给——
 * 面板、SSE done 负载、导出稿、`ai_artifacts.provenance` 都消费同一份 `rows`，逐字同源。
 *
 * 口径与报表卡一致：截断无 → 写「无」而不是省略（省略会让面板看起来「没有这一行」，
 * 与「有截断但为 0」难分）；模型未记录 → 写「未记录」，绝不填一个猜出来的模型名。
 */
import type { ProvenanceRow } from './reportProvenance';
import { getDb } from '../db/connection';
import { randomUUID } from 'node:crypto';

export interface CardProvenance {
  /** 卡片标识（aiCards.ts 单源），面板按卡记忆展开态、产物按卡找回 */
  cardKey: string;
  generatedAt: string;
  /** 有截断/降级说明为 true：面板据此给警示色，导出稿据此决定是否加醒目标记 */
  truncated: boolean;
  rows: ProvenanceRow[];
}

export interface CardProvenanceInput {
  cardKey: string;
  /** 数据来源（每个来源一条：如「PRD 原文：12,480 字」「需求：25 条」） */
  sources: ReadonlyArray<ProvenanceRow>;
  /** 时间窗/范围（可选；无跨度概念的卡不写「全部时间」这种假值） */
  window?: string;
  /** 截断与降级说明；空 = 无截断 */
  truncations?: readonly string[];
  model?: string | null;
  generatedAt?: string;
}

/** 千分位字符数：来源行统一用这个格式，避免各卡各写「1.2万/12000 字」两种读法 */
export function chars(n: number): string {
  return `${Math.max(0, Math.round(n)).toLocaleString('en-US')} 字`;
}

export function buildCardProvenance(input: CardProvenanceInput): CardProvenance {
  const truncations = (input.truncations ?? []).map((t) => t.trim()).filter(Boolean);
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const rows: ProvenanceRow[] = [
    ...input.sources.filter((s) => s.label && s.value !== ''),
    ...(input.window ? [{ label: '时间窗', value: input.window }] : []),
    { label: '截断', value: truncations.length > 0 ? truncations.join('；') : '无' },
    { label: '模型', value: input.model?.trim() || '未记录' },
    { label: '生成时间', value: generatedAt },
  ];
  return { cardKey: input.cardKey, generatedAt, truncated: truncations.length > 0, rows };
}

/** 导出稿尾段的纯文本行（`标签：值`）——与面板逐字同源 */
export function provenanceTextLines(p: CardProvenance): string[] {
  return p.rows.map((r) => `${r.label}：${r.value}`);
}

/** Markdown 导出稿的「溯源」段；有截断时在标题后加 ⚠（AI-101②：导出稿也要看得出被截过） */
export function provenanceMarkdown(p: CardProvenance): string {
  const head = p.truncated ? '## 溯源（⚠ 含截断/降级）' : '## 溯源';
  const bulletLines = provenanceTextLines(p).map((l) => `- ${l}`).join('\n');
  return `\n\n---\n\n${head}\n\n${bulletLines}\n`;
}

/** 每卡保留的溯源快照份数：只服务「重进页面看最近一次」，留多了是历史噪声 */
export const CARD_PROVENANCE_KEEP = 30;

/**
 * 落一份溯源快照。任何异常都吞掉——溯源是旁路信息，不能因为它写库失败把生成结果弄丢。
 * `projectId` 可空（讲稿/报表可跨项目），查询时按 cardKey + 项目过滤（null 项目只看 null 行）。
 */
export function recordCardProvenance(p: CardProvenance, projectId?: string | null): void {
  try {
    const db = getDb();
    const t = new Date().toISOString();
    db.prepare('INSERT INTO ai_card_provenance (id, card_key, project_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), p.cardKey, projectId ?? null, JSON.stringify(p), t);
    const extra = db.prepare(
      `SELECT id FROM ai_card_provenance WHERE card_key = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?`,
    ).all(p.cardKey, CARD_PROVENANCE_KEEP) as Array<{ id: string }>;
    for (const e of extra) db.prepare('DELETE FROM ai_card_provenance WHERE id = ?').run(e.id);
  } catch { /* 旁路信息，失败不影响主流程 */ }
}

/** 最近一次溯源快照；项目维度严格匹配（不给 A 项目的面板看 B 项目的来源） */
export function latestCardProvenance(cardKey: string, projectId?: string | null): CardProvenance | null {
  try {
    const row = getDb().prepare(
      `SELECT payload_json FROM ai_card_provenance
        WHERE card_key = ? AND (project_id IS ? OR ? IS NULL)
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(cardKey, projectId ?? null, projectId ?? null) as { payload_json: string } | undefined;
    if (!row) return null;
    const p = JSON.parse(row.payload_json) as CardProvenance;
    return Array.isArray(p?.rows) ? p : null;
  } catch { return null; }
}
