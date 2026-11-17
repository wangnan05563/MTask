/**
 * T03172（PRD G-2 / AI-301 验收⑤）：AI 可用卡片月采用覆盖率统计。
 *
 * 口径（G-2）：当月至少成功生成一次的可用卡片数 ÷ 当月可用卡片总数；
 * - 分母来自注册表 available 卡（禁用/未发布不进分母）；
 * - 分子按 ai_usage.card_key 当月 ok=1 去重计数（unknown/未注册 key 不进分子）；
 * - 「当月可用卡片总数」当前按注册表现值计（发布节奏表未建成前的诚实近似）。
 *
 * T03191（G-2 基线）：「首个完整月重建基线」不靠人记日期——`baseline` 由数据推导：
 * 最早带真实 card_key 的用量日 → 其**次月**才是首个完整月；该月已结束才 `established`。
 * card_key 接入前/接入当月只作过程观察，不冒充基线（D-05：unknown 不回填）。
 */
import { getDb } from '../db/connection';
import { AI_CARDS, availableCards } from '../util/aiCards';

export interface CardCoverageRow { key: string; title: string; group: string; available: boolean; metered: boolean; okCount: number; failCount: number }

/** T03191：该月能否作为 G-2 基线（首个完整月且已结束）的判定结果 */
export interface CoverageBaseline {
  /** 最早带真实 card_key 的用量日期 YYYY-MM-DD（null=尚无样本，覆盖率暂不可比） */
  instrumentedFrom: string | null;
  /** 首个完整月＝instrumentedFrom 的次月（接入当月不完整） */
  firstCompleteMonth: string | null;
  /** 请求月是否「整月都在 card_key 接入之后」 */
  fullyInstrumented: boolean;
  /** 请求月是否已结束（UTC 月界） */
  ended: boolean;
  /** 请求月可作为基线（全月接入 + 已结束） */
  established: boolean;
  /** 分母口径：当前注册表 available 卡（卡片上下线历史未入库，历史月按现值近似） */
  denominatorBasis: 'current-registry';
  note: string;
}

export interface CardCoverage {
  month: string;
  totalAvailable: number;
  coveredCount: number;
  ratio: number;
  /** 当月无任何使用记录且写入点未接的卡——展示侧必须区分「没人用」与「没接埋点」 */
  unmeteredKeys: string[];
  cards: CardCoverageRow[];
  baseline: CoverageBaseline;
}

/** YYYY-MM（UTC，与 created_at 的 ISO 前缀同口径） */
export function currentMonthStr(d: Date = new Date()): string {
  return d.toISOString().slice(0, 7);
}

function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** T03191：以数据推导「首个完整月」，不手工记上线日；unknown（历史行）不算接入 */
function coverageBaseline(db: ReturnType<typeof getDb>, month: string, now: Date): CoverageBaseline {
  const row = db.prepare(
    "SELECT MIN(substr(created_at, 1, 10)) AS first_day FROM ai_usage WHERE card_key IS NOT NULL AND card_key <> '' AND card_key <> 'unknown'",
  ).get() as { first_day: string | null } | undefined;
  const instrumentedFrom = row?.first_day ?? null;
  const firstCompleteMonth = instrumentedFrom ? nextMonth(instrumentedFrom.slice(0, 7)) : null;
  const fullyInstrumented = firstCompleteMonth !== null && month >= firstCompleteMonth;
  const ended = month < currentMonthStr(now);
  const established = fullyInstrumented && ended;
  const denominatorBasis = 'current-registry' as const;
  let note: string;
  if (!instrumentedFrom) {
    note = '尚无带 card_key 的用量样本，覆盖率暂不可比（历史 card_key=unknown 不回填）；首个完整月待接入后自然产生';
  } else if (!fullyInstrumented) {
    note = `card_key 自 ${instrumentedFrom} 起记录，${month} 不是完整月（首个完整月为 ${firstCompleteMonth}）；当月读数只作过程观察，不作基线`;
  } else if (ended) {
    note = `${month} 可作为基线：分母按当前注册表可用卡计（卡片上下线历史未入库）`;
  } else {
    note = `${month} 尚未结束，月结束后才可作为基线（首个完整月 ${firstCompleteMonth}）`;
  }
  return { instrumentedFrom, firstCompleteMonth, fullyInstrumented, ended, established, denominatorBasis, note };
}

export function cardCoverage(month: string, now: Date = new Date()): CardCoverage {
  // 月份必须真实存在：2026-13 这类「格式对、月份不存在」的值若放行，会被当成未来月静默出 0
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`month 需为 YYYY-MM，收到：${month}`);
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
  return { month, totalAvailable: avail.length, coveredCount, ratio, unmeteredKeys, cards, baseline: coverageBaseline(db, month, now) };
}
