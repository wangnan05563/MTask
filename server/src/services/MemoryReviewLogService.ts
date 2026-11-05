import { v4 as uuid } from 'uuid';
import { getDb } from '../db/connection';

/**
 * T04158（PRD MEM-604 / F8）：记忆抽样评审记录。
 *
 * 规范 §10.2 要求每批随机抽 20 条人工评审，判定「不值得记」时必须记命中判据编号
 * （Q1–Q7 / W1–W8 / 禁记项），样本与标注留档作回归基线；连续两批同一判据拒杀率 >40% → 重写规则。
 * 本模块只承载「记录 + 统计」，评审流程本身是人工动作（T04164）。
 */

/** 每批抽样条数（规范 §10.2 固定 20） */
export const REVIEW_BATCH_SIZE = 20;

export interface ReviewLogInput {
  batchId: string;
  memoryId: string;
  verdict: 'keep' | 'reject';
  /** 判定「不值得记」时必填：命中判据编号（Q1–Q7 / W1–W8 / 禁记项） */
  hitRule?: string;
  reviewer?: string;
}

export type ReviewLogResult = { ok: true; id: string } | { ok: false; error: string };

export function appendReviewLog(input: ReviewLogInput): ReviewLogResult {
  const batchId = (input.batchId ?? '').trim();
  const memoryId = (input.memoryId ?? '').trim();
  if (!batchId || !memoryId) return { ok: false, error: 'batchId/memoryId 必填' };
  if (input.verdict !== 'keep' && input.verdict !== 'reject') return { ok: false, error: 'verdict 只能是 keep/reject' };
  // 判据编号是拒杀率统计的唯一维度：拒杀不填判据会让这条样本无法进入回归基线
  if (input.verdict === 'reject' && !String(input.hitRule ?? '').trim()) {
    return { ok: false, error: 'verdict=reject 时必须填 hitRule（命中判据编号）' };
  }
  const id = `rv-${uuid()}`;
  getDb().prepare(`INSERT INTO memory_review_log
    (id,batch_id,memory_id,verdict,hit_rule,reviewer,created_at) VALUES (?,?,?,?,?,?,?)`).run(
    id, batchId, memoryId, input.verdict, String(input.hitRule ?? '').trim() || null,
    String(input.reviewer ?? '').trim() || null, new Date().toISOString(),
  );
  return { ok: true, id };
}

export interface ReviewLogRow {
  id: string;
  batch_id: string;
  memory_id: string;
  verdict: 'keep' | 'reject';
  hit_rule: string | null;
  reviewer: string | null;
  created_at: string;
}

export function listReviewLog(opts: { batchId?: string; limit?: number } = {}): ReviewLogRow[] {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 100)), 500);
  const db = getDb();
  const batchId = (opts.batchId ?? '').trim();
  if (batchId) {
    return db.prepare('SELECT * FROM memory_review_log WHERE batch_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(batchId, limit) as ReviewLogRow[];
  }
  return db.prepare('SELECT * FROM memory_review_log ORDER BY created_at DESC LIMIT ?').all(limit) as ReviewLogRow[];
}

export interface RuleRejectStat {
  hitRule: string;
  total: number;
  rejected: number;
  /** 拒杀率（0~1），超 0.4 即触发「重写规则」的告警线（规范 §10.2） */
  rejectRate: number;
}

export interface ReviewSample {
  batchId: string;
  memories: { id: string; type: string; title: string; content: string; source_kind: string; updated_at: string }[];
}

/**
 * T04164（MEM-604 / 规范 §10.2）：开一批抽样评审。
 * 必须**随机**抽取（ORDER BY RANDOM），不能取 TOP——只看"看起来好的"测不出精度；
 * 抽样只读不写，判定由评审人逐条通过 appendReviewLog 落库（reject 必须带判据编号）。
 * 单批固定 20 条，硬上限 50（防止一次拉全量失去抽样意义）。
 */
export function sampleMemoriesForReview(productKey: string, batchSize = REVIEW_BATCH_SIZE): ReviewSample {
  const size = Math.min(Math.max(1, Math.floor(batchSize)), 50);
  const pk = (productKey ?? '').trim().toLowerCase();
  const batchId = `rev-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`;
  const rows = getDb().prepare(`SELECT id, type, title, content, source_kind, updated_at
    FROM memories WHERE product_key = ? AND invalidated_at IS NULL
    ORDER BY RANDOM() LIMIT ?`).all(pk, size) as ReviewSample['memories'];
  return { batchId, memories: rows };
}

/** 按判据编号汇总拒杀率——连续两批同判据 >40% 时应重写规则（统计供人判断，不自动改规则） */
export function ruleRejectStats(): RuleRejectStat[] {
  const rows = getDb().prepare(`SELECT COALESCE(NULLIF(hit_rule,''),'(未标注)') AS rule,
      COUNT(*) AS total, SUM(CASE WHEN verdict = 'reject' THEN 1 ELSE 0 END) AS rejected
    FROM memory_review_log GROUP BY rule ORDER BY total DESC`).all() as
    { rule: string; total: number; rejected: number }[];
  return rows.map((r) => ({
    hitRule: r.rule,
    total: r.total,
    rejected: r.rejected,
    rejectRate: r.total ? Number((r.rejected / r.total).toFixed(3)) : 0,
  }));
}
