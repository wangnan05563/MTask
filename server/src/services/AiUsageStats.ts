/**
 * T04085（T04003 派生）：ai_usage 的 job / 段维度回看。
 *
 * T04003 起用量行带 `job_id`（AiGenJournal 的 job 标识）与 `stage`（= 台账 segmentKey）。
 * 这里只做聚合与联查：段的人读标签一律取 `ai_gen_segments.label`（AiGenJournal 写入的单源），
 * 不在 SQL 里再造一套中文标签。
 *
 * 口径：
 *  - jobs / segments 只统计 job_id 与 stage 都非空的行——两者齐全才算有段归属；
 *  - 缺失归属的行（历史数据为两个空串）单独汇总为 `unassigned`，不混入段维度统计，
 *    由面板显式标注「无段归属（历史数据）」。
 */
import { getDb } from '../db/connection';

export interface UsageJobSegmentRow {
  stage: string;
  /** ai_gen_segments.label；台账无该段时为空串，面板回落显示 stage */
  label: string;
  calls: number;
  okCalls: number;
  failCalls: number;
  avgMs: number;
  totalMs: number;
  contentChars: number;
  lastError: string | null;
  lastAt: string;
}

export interface UsageJobRow {
  jobId: string;
  cardKey: string | null;
  calls: number;
  okCalls: number;
  failCalls: number;
  avgMs: number;
  totalMs: number;
  contentChars: number;
  firstAt: string;
  lastAt: string;
  segments: UsageJobSegmentRow[];
}

export interface UsageUnassignedRow {
  calls: number;
  okCalls: number;
  failCalls: number;
  contentChars: number;
  lastAt: string | null;
}

export const USAGE_JOB_MAX = 100;
const DEFAULT_JOB_LIMIT = 30;

/** 与路由同样的容错：非数/0/负值按默认 30，上限 100 */
export function clampJobLimit(raw: unknown): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(USAGE_JOB_MAX, n) : DEFAULT_JOB_LIMIT;
}

export function usageJobBreakdown(args: { since: string; cardKey?: string; jobLimit?: unknown }): {
  jobs: UsageJobRow[];
  unassigned: UsageUnassignedRow;
  jobLimit: number;
} {
  const db = getDb();
  const cardKey = (args.cardKey ?? '').trim();
  const cardWhere = cardKey ? ' AND card_key = ?' : '';
  const cardArgs = cardKey ? [cardKey] : [];
  const jobLimit = clampJobLimit(args.jobLimit);

  const jobRows = db.prepare(
    `SELECT job_id AS jobId, MAX(card_key) AS cardKey,
            COUNT(*) AS calls, COALESCE(SUM(ok), 0) AS okCalls, COALESCE(SUM(1 - ok), 0) AS failCalls,
            CAST(AVG(duration_ms) AS INTEGER) AS avgMs, COALESCE(SUM(duration_ms), 0) AS totalMs,
            COALESCE(SUM(content_chars), 0) AS contentChars,
            MIN(created_at) AS firstAt, MAX(created_at) AS lastAt
       FROM ai_usage
      WHERE created_at >= ? AND job_id <> '' AND stage <> ''${cardWhere}
      GROUP BY job_id
      ORDER BY lastAt DESC
      LIMIT ?`,
  ).all(args.since, ...cardArgs, jobLimit) as Array<Omit<UsageJobRow, 'segments'>>;

  const ids = jobRows.map((r) => r.jobId);
  let segmentRows: Array<Omit<UsageJobSegmentRow, 'label'> & { jobId: string; label: string }> = [];
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    segmentRows = db.prepare(
      `SELECT u.job_id AS jobId, u.stage AS stage,
              COUNT(*) AS calls, COALESCE(SUM(u.ok), 0) AS okCalls, COALESCE(SUM(1 - u.ok), 0) AS failCalls,
              CAST(AVG(u.duration_ms) AS INTEGER) AS avgMs, COALESCE(SUM(u.duration_ms), 0) AS totalMs,
              COALESCE(SUM(u.content_chars), 0) AS contentChars,
              MAX(u.created_at) AS lastAt,
              (SELECT u2.error FROM ai_usage u2
                WHERE u2.job_id = u.job_id AND u2.stage = u.stage AND u2.error IS NOT NULL
                ORDER BY u2.created_at DESC LIMIT 1) AS lastError,
              COALESCE(MAX(s.label), '') AS label
         FROM ai_usage u
         LEFT JOIN (
           SELECT job_id, segment_key, MAX(label) AS label
             FROM ai_gen_segments GROUP BY job_id, segment_key
         ) s ON s.job_id = u.job_id AND s.segment_key = u.stage
        WHERE u.job_id IN (${placeholders}) AND u.stage <> ''
        GROUP BY u.job_id, u.stage
        ORDER BY u.job_id, lastAt`,
    ).all(...ids) as Array<Omit<UsageJobSegmentRow, 'label'> & { jobId: string; label: string }>;
  }

  const byJob = new Map<string, UsageJobSegmentRow[]>();
  for (const { jobId, ...seg } of segmentRows) {
    const list = byJob.get(jobId);
    if (list) list.push(seg);
    else byJob.set(jobId, [seg]);
  }

  const unassigned = db.prepare(
    `SELECT COUNT(*) AS calls, COALESCE(SUM(ok), 0) AS okCalls, COALESCE(SUM(1 - ok), 0) AS failCalls,
            COALESCE(SUM(content_chars), 0) AS contentChars, MAX(created_at) AS lastAt
       FROM ai_usage
      WHERE created_at >= ? AND (job_id = '' OR stage = '')${cardWhere}`,
  ).get(args.since, ...cardArgs) as UsageUnassignedRow;

  return {
    jobs: jobRows.map((r) => ({ ...r, segments: byJob.get(r.jobId) ?? [] })),
    unassigned,
    jobLimit,
  };
}
