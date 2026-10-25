/**
 * T03172（PRD G-2 / AI-301 验收⑤）：AI 可用卡片月采用覆盖率统计。
 *
 * 口径（G-2）：当月至少成功生成一次的可用卡片数 ÷ 当月可用卡片总数；
 * - 分母来自注册表 available 卡（禁用/未发布不进分母）；
 * - 分子按 ai_usage.card_key 当月 ok=1 去重计数（unknown/未注册 key 不进分子）；
 * - 「当月可用卡片总数」当前按注册表现值计（发布节奏表未建成前的诚实近似，
 *   历史月重建基线属 G-2 基线单，见 T03188/7.3）。
 */
import { getDb } from '../db/connection';
import { AI_CARDS, availableCards } from '../util/aiCards';

export interface CardCoverageRow { key: string; title: string; group: string; available: boolean; metered: boolean; okCount: number; failCount: number }
export interface CardCoverage {
  month: string;
  totalAvailable: number;
  coveredCount: number;
  ratio: number;
  /** 当月无任何使用记录且写入点未接的卡——展示侧必须区分「没人用」与「没接埋点」 */
  unmeteredKeys: string[];
  cards: CardCoverageRow[];
}

/** YYYY-MM（UTC，与 created_at 的 ISO 前缀同口径） */
export function currentMonthStr(d: Date = new Date()): string {
  return d.toISOString().slice(0, 7);
}

export function cardCoverage(month: string): CardCoverage {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`month 需为 YYYY-MM，收到：${month}`);
  const db = getDb();
  const rows = db.prepare(
    "SELECT card_key, ok, COUNT(*) AS n FROM ai_usage WHERE created_at LIKE ? GROUP BY card_key, ok",
  ).all(`${month}%`) as Array<{ card_key: string; ok: number; n: number }>;
  const okBy = new Map<string, number>();
  const failBy = new Map<string, number>();
  for (const r of rows) {
    const map = r.ok === 1 ? okBy : failBy;
    map.set(r.card_key, (map.get(r.card_key) ?? 0) + r.n);
  }
  const cards: CardCoverageRow[] = AI_CARDS.map((c) => ({
    key: c.key, title: c.title, group: c.group, available: c.available, metered: c.metered,
    okCount: okBy.get(c.key) ?? 0, failCount: failBy.get(c.key) ?? 0,
  }));
  const avail = availableCards();
  const coveredCount = avail.filter((c) => (okBy.get(c.key) ?? 0) > 0).length;
  const ratio = avail.length === 0 ? 0 : coveredCount / avail.length;
  const unmeteredKeys = avail.filter((c) => !c.metered && !okBy.has(c.key) && !failBy.has(c.key)).map((c) => c.key);
  return { month, totalAvailable: avail.length, coveredCount, ratio, unmeteredKeys, cards };
}
